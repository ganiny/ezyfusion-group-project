-- Rent collection schema: tables, constraints, privileges, RLS, storage.
--
-- Access model:
--   * The app server talks to Postgres through Prisma as the database owner
--     (bypasses RLS); it authorizes every request itself (lib/auth.ts, lib/access.ts).
--   * The Supabase Data API (PostgREST, anon/authenticated) is READ-ONLY, scoped
--     by RLS, except tenants.phone which a tenant may update on their own row.
--   * Money is integer sen (bigint). Calendar dates are `date`, instants `timestamptz`.

create extension if not exists btree_gist with schema extensions;

-- Private schema for RLS helpers and triggers. Not exposed by PostgREST
-- (config.toml api.schemas), so nothing here is reachable at /rest/v1/rpc.
create schema app;
grant usage on schema app to authenticated;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table public.organizations (
  id         uuid primary key default gen_random_uuid(),
  name       text not null check (length(btrim(name)) > 0),
  created_at timestamptz not null default now()
);

-- Primary key on user_id: a staff member or manager belongs to exactly one org.
create table public.memberships (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  org_id     uuid not null references public.organizations (id),
  role       text not null check (role in ('manager', 'staff')),
  created_at timestamptz not null default now()
);
create index memberships_org_id_idx on public.memberships (org_id);

create table public.units (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references public.organizations (id),
  name       text not null check (length(btrim(name)) > 0),
  created_at timestamptz not null default now(),
  unique (org_id, name),
  unique (id, org_id) -- target of composite FKs that pin children to the same org
);

create table public.tenants (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references public.organizations (id),
  user_id    uuid unique references auth.users (id) on delete set null,
  full_name  text not null check (length(btrim(full_name)) > 0),
  email      text not null,
  phone      text check (phone is null or phone ~ '^\+?[0-9][0-9 ()-]{5,29}$'),
  created_at timestamptz not null default now(),
  unique (id, org_id)
);
create index tenants_org_id_idx on public.tenants (org_id);

create table public.leases (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references public.organizations (id),
  unit_id          uuid not null,
  tenant_id        uuid not null,
  start_date       date not null,
  end_date         date not null,
  monthly_rent_sen bigint not null check (monthly_rent_sen > 0),
  deposit_sen      bigint not null check (deposit_sen >= 0),
  created_by       uuid references auth.users (id) on delete set null,
  created_at       timestamptz not null default now(),
  check (end_date >= start_date),
  unique (id, org_id),
  -- Composite FKs: a lease can only reference a unit/tenant of its own org,
  -- even if application code were wrong.
  foreign key (unit_id, org_id) references public.units (id, org_id),
  foreign key (tenant_id, org_id) references public.tenants (id, org_id),
  -- Leases on one unit never overlap (both ends inclusive). Enforced by the
  -- database, so two concurrent inserts cannot both succeed (SQLSTATE 23P01).
  constraint leases_no_overlap
    exclude using gist (unit_id with =, daterange(start_date, end_date, '[]') with &&)
);
create index leases_org_id_idx on public.leases (org_id);
create index leases_tenant_id_idx on public.leases (tenant_id);

create table public.invoices (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null,
  lease_id     uuid not null,
  kind         text not null check (kind in ('deposit', 'rent')),
  period_index integer,
  period_start date,
  period_end   date,
  due_date     date not null,
  -- >= 0: proration of a tiny rent can legitimately round to 0 sen.
  amount_sen   bigint not null check (amount_sen >= 0),
  created_at   timestamptz not null default now(),
  foreign key (lease_id, org_id) references public.leases (id, org_id),
  unique (id, org_id),
  unique (lease_id, period_index),
  check (
    (kind = 'deposit' and period_index is null and period_start is null and period_end is null)
    or (kind = 'rent' and period_index >= 0 and period_start is not null and period_end >= period_start)
  )
);
create unique index invoices_one_deposit_per_lease on public.invoices (lease_id) where kind = 'deposit';
create index invoices_lease_due_idx on public.invoices (lease_id, due_date);
create index invoices_org_id_idx on public.invoices (org_id);

create table public.gateway_bills (
  id             text primary key check (id ~ '^bill_[A-Za-z0-9_-]{32,}$'),
  org_id         uuid not null,
  lease_id       uuid not null,
  amount_sen     bigint not null check (amount_sen > 0),
  status         text not null default 'pending' check (status in ('pending', 'paid', 'failed')),
  transaction_id text,
  paid_at        timestamptz,
  created_by     uuid references auth.users (id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  foreign key (lease_id, org_id) references public.leases (id, org_id),
  unique (id, org_id)
);
create index gateway_bills_lease_id_idx on public.gateway_bills (lease_id);
create index gateway_bills_org_id_idx on public.gateway_bills (org_id);

create table public.payments (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null,
  lease_id        uuid not null,
  amount_sen      bigint not null check (amount_sen > 0),
  unapplied_sen   bigint not null default 0 check (unapplied_sen >= 0 and unapplied_sen <= amount_sen),
  method          text not null check (method in ('cash', 'bank_transfer', 'online')),
  status          text not null check (status in ('pending_verification', 'approved', 'rejected', 'voided')),
  received_at     timestamptz not null,
  slip_path       text,
  -- UNIQUE: a gateway bill can create at most one payment, ever (last line of
  -- defence behind the row lock in the webhook handler).
  gateway_bill_id text unique,
  recorded_by     uuid references auth.users (id) on delete set null,
  decided_by      uuid references auth.users (id) on delete set null,
  decided_at      timestamptz,
  decision_reason text,
  created_at      timestamptz not null default now(),
  foreign key (lease_id, org_id) references public.leases (id, org_id),
  foreign key (gateway_bill_id, org_id) references public.gateway_bills (id, org_id),
  unique (id, org_id),
  check ((method = 'bank_transfer') = (slip_path is not null)),
  check ((method = 'online') = (gateway_bill_id is not null)),
  -- A slip must live in its own organization's folder.
  check (slip_path is null or starts_with(slip_path, org_id::text || '/'))
);
create index payments_lease_id_idx on public.payments (lease_id);
create index payments_org_status_received_idx on public.payments (org_id, status, received_at);

create table public.payment_allocations (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null,
  payment_id uuid not null,
  invoice_id uuid not null,
  amount_sen bigint not null check (amount_sen > 0),
  created_at timestamptz not null default now(),
  foreign key (payment_id, org_id) references public.payments (id, org_id),
  foreign key (invoice_id, org_id) references public.invoices (id, org_id),
  unique (payment_id, invoice_id)
);
create index payment_allocations_invoice_id_idx on public.payment_allocations (invoice_id);
create index payment_allocations_org_id_idx on public.payment_allocations (org_id);

-- actor_id has no FK on purpose: an FK action (on delete set null) would be an
-- UPDATE, which the append-only trigger forbids. NULL actor = the gateway.
create table public.audit_log (
  id         bigint generated always as identity primary key,
  org_id     uuid not null references public.organizations (id),
  actor_id   uuid,
  action     text not null,
  entity_id  text not null,
  details    jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index audit_log_org_created_idx on public.audit_log (org_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Integrity triggers
-- ---------------------------------------------------------------------------

-- audit_log is append-only for every role, including service_role and the
-- table owner (triggers fire for them too; only a superuser could disable it).
create function app.forbid_audit_log_change() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception 'audit_log is append-only' using errcode = '42501';
end;
$$;

create trigger audit_log_no_update_delete
  before update or delete on public.audit_log
  for each row execute function app.forbid_audit_log_change();
create trigger audit_log_no_truncate
  before truncate on public.audit_log
  for each statement execute function app.forbid_audit_log_change();

-- Payments are never deleted (they are rejected or voided instead).
create function app.forbid_payment_delete() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception 'payments are never deleted' using errcode = '42501';
end;
$$;

create trigger payments_no_delete
  before delete on public.payments
  for each row execute function app.forbid_payment_delete();
create trigger payments_no_truncate
  before truncate on public.payments
  for each statement execute function app.forbid_payment_delete();

-- ---------------------------------------------------------------------------
-- RLS helpers (security definer so policies don't recurse through RLS on
-- memberships/tenants/leases; search_path pinned; schema not exposed).
-- ---------------------------------------------------------------------------

create function app.staff_org_id() returns uuid
language sql stable security definer set search_path = '' as $$
  select m.org_id from public.memberships m where m.user_id = (select auth.uid())
$$;

create function app.staff_role() returns text
language sql stable security definer set search_path = '' as $$
  select m.role from public.memberships m where m.user_id = (select auth.uid())
$$;

create function app.tenant_org_id() returns uuid
language sql stable security definer set search_path = '' as $$
  select t.org_id from public.tenants t where t.user_id = (select auth.uid())
$$;

create function app.tenant_lease_ids() returns setof uuid
language sql stable security definer set search_path = '' as $$
  select l.id
  from public.leases l
  join public.tenants t on t.id = l.tenant_id
  where t.user_id = (select auth.uid())
$$;

create function app.tenant_unit_ids() returns setof uuid
language sql stable security definer set search_path = '' as $$
  select l.unit_id
  from public.leases l
  join public.tenants t on t.id = l.tenant_id
  where t.user_id = (select auth.uid())
$$;

create function app.tenant_invoice_ids() returns setof uuid
language sql stable security definer set search_path = '' as $$
  select i.id
  from public.invoices i
  join public.leases l on l.id = i.lease_id
  join public.tenants t on t.id = l.tenant_id
  where t.user_id = (select auth.uid())
$$;

revoke all on all functions in schema app from public, anon, authenticated, service_role;
grant execute on function
  app.staff_org_id(), app.staff_role(), app.tenant_org_id(),
  app.tenant_lease_ids(), app.tenant_unit_ids(), app.tenant_invoice_ids()
  to authenticated;

-- ---------------------------------------------------------------------------
-- Privileges: start from nothing, then grant only what the Data API needs.
-- ---------------------------------------------------------------------------

revoke all on all tables in schema public from public, anon, authenticated, service_role;
revoke all on all sequences in schema public from public, anon, authenticated, service_role;
revoke all on all functions in schema public from public, anon, authenticated, service_role;
alter default privileges in schema public revoke all on tables from public, anon, authenticated, service_role;
alter default privileges in schema public revoke all on sequences from public, anon, authenticated, service_role;
alter default privileges in schema public revoke all on functions from public, anon, authenticated, service_role;

grant select on
  public.organizations, public.memberships, public.units, public.tenants, public.leases,
  public.invoices, public.payments, public.payment_allocations, public.gateway_bills, public.audit_log
  to authenticated;
-- Column-level grant: a tenant can change their phone and nothing else.
grant update (phone) on public.tenants to authenticated;

-- ---------------------------------------------------------------------------
-- Row Level Security (enabled on every table; no policy = no access)
-- ---------------------------------------------------------------------------

alter table public.organizations       enable row level security;
alter table public.memberships         enable row level security;
alter table public.units               enable row level security;
alter table public.tenants             enable row level security;
alter table public.leases              enable row level security;
alter table public.invoices            enable row level security;
alter table public.payments            enable row level security;
alter table public.payment_allocations enable row level security;
alter table public.gateway_bills       enable row level security;
alter table public.audit_log           enable row level security;

create policy organizations_select on public.organizations for select to authenticated
  using (id = (select app.staff_org_id()) or id = (select app.tenant_org_id()));

create policy memberships_select on public.memberships for select to authenticated
  using (org_id = (select app.staff_org_id()));

create policy units_select on public.units for select to authenticated
  using (org_id = (select app.staff_org_id()) or id in (select app.tenant_unit_ids()));

create policy tenants_select on public.tenants for select to authenticated
  using (org_id = (select app.staff_org_id()) or user_id = (select auth.uid()));

-- Only the tenant's own row; the column grant above limits it to `phone`.
create policy tenants_update_own_phone on public.tenants for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

create policy leases_select on public.leases for select to authenticated
  using (org_id = (select app.staff_org_id()) or id in (select app.tenant_lease_ids()));

create policy invoices_select on public.invoices for select to authenticated
  using (org_id = (select app.staff_org_id()) or lease_id in (select app.tenant_lease_ids()));

create policy payments_select on public.payments for select to authenticated
  using (org_id = (select app.staff_org_id()) or lease_id in (select app.tenant_lease_ids()));

create policy payment_allocations_select on public.payment_allocations for select to authenticated
  using (org_id = (select app.staff_org_id()) or invoice_id in (select app.tenant_invoice_ids()));

create policy gateway_bills_select on public.gateway_bills for select to authenticated
  using (org_id = (select app.staff_org_id()) or lease_id in (select app.tenant_lease_ids()));

create policy audit_log_select on public.audit_log for select to authenticated
  using (org_id = (select app.staff_org_id()) and (select app.staff_role()) = 'manager');

-- ---------------------------------------------------------------------------
-- Storage: private bucket for bank-transfer slips, <org_id>/<file>
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('payment-slips', 'payment-slips', false, 5242880, array['image/jpeg', 'image/png', 'application/pdf'])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- Staff and managers of the org can upload into, read (to sign URLs), and
-- delete (cleanup after a failed recording) their own org's folder only.
-- No UPDATE policy: slips are never overwritten. Tenants/anon: no policy.
create policy payment_slips_select on storage.objects for select to authenticated
  using (bucket_id = 'payment-slips' and (storage.foldername(name))[1] = (select app.staff_org_id())::text);

create policy payment_slips_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'payment-slips' and (storage.foldername(name))[1] = (select app.staff_org_id())::text);

create policy payment_slips_delete on storage.objects for delete to authenticated
  using (bucket_id = 'payment-slips' and (storage.foldername(name))[1] = (select app.staff_org_id())::text);
