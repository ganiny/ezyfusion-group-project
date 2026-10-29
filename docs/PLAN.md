# Plan — EzyFusion Rent Collection Assessment

## Context
Timed (4h) assessment: build part of a rent-collection module (leases, invoices, cash/bank-transfer/online
payments, RBAC for manager/staff/tenant) on Next.js 16 + local Supabase + Prisma 7 + shadcn/Tailwind.
Graded by hidden tests (billing fns under 3 TZs, HTTP API as each seeded user incl. cross-org + concurrency,
Data API/Storage direct calls, webhook forged/dup/concurrent/out-of-order), then a code walkthrough.
Names in the brief are a contract. Priority if time runs short: billing → access control → payments → webhook → UI.
Stack is already verified working (commit `29cded4` on `chore/stack-setup`).

## Step 0 — Housekeeping (~10 min)
- Save the brief verbatim to `docs/REQUIREMENTS.md` (the reference during the build).
- Fast-forward `main` to `chore/stack-setup` and work on `main` (submission = public GitHub repo; user adds the remote).
- **Fix grader-path env loading** (graders run `cp .env.example .env.local`, never create `.env`):
  - `prisma7.config.ts`: `dotenv.config({ path: ['.env.local', '.env'], quiet: true })` and
    `url: process.env.DATABASE_URL ?? ''` — `env()` throws when unset, which would break `postinstall: prisma generate`
    during `npm install` (runs before the env file is copied).
  - `.env.example`: add `DIRECT_URL` (same as DATABASE_URL) and `GATEWAY_X_SIGNATURE_KEY=test_x_signature_key`, a "where it comes from" comment on each.
- Move Supabase clients into `lib/supabase/{client,server,middleware,admin}.ts`. `admin.ts` = service-role client with `import 'server-only'`.
- Add `proxy.ts` (Next 16 replacement for middleware) → `updateSession`, matcher **excluding `/api`** (APIs must return 401 JSON, not redirects). Redirect target `/login`.
- Dev deps: `vitest`, `tsx`, `zod`. shadcn components: card, table, badge, dialog, alert-dialog, input, label, select, textarea, sonner, skeleton, form bits.

## Step 1 — `lib/billing.ts` + tests (~30 min, 15 pts)
Pure: no imports, no `Date` locals. Dates as `{y,m,d}` ints; day counts via `Date.UTC` differences only.
- `parseYmd` (strict `^\d{4}-\d{2}-\d{2}$`, month 1–12, day ≤ daysInMonth, leap years), `formatYmd`, `addMonthsClamped(start, k)` (always from start date; clamp day to month end), `addDays`, `daysBetweenInclusive`.
- `generateSchedule`: validate (real dates, end ≥ start, rent positive safe int, deposit non-negative safe int) → deposit first (if > 0, due startDate, period fields null) → for k = 0.. while anchor(k) ≤ endDate: periodEnd = min(anchor(k+1) − 1, endDate); if cut short, amount = round-half-up(rent·used/full) with BigInt: `(2·rent·used + full) / (2·full)`.
- `invoiceStatus`: paid if paid ≥ amount → overdue if `mytToday(now) > dueDate` (string compare; `mytToday` = `new Date(now.getTime()+8h).toISOString().slice(0,10)`) → partially_paid if paid > 0 → unpaid.
- `parseRinggitToSen`: trim, then `^(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?$`; integer math from strings; throw if over MAX_SAFE_INTEGER.
- Also export helpers used by app: `mytToday(now)`, `mytMonth(instant)`.
- `lib/billing.test.ts` (vitest): Aisyah worked example, Ben (Apr 1–15 → 50014.5 → **50015**, half-up), Jan 31 anchors incl. leap Feb 29, one-day lease, end on anchor−1 (full price), invalid dates (2026-02-30, 2026-2-01), overdue boundary 2026-03-01T15:59:59.999Z vs 16:00Z, all parse examples.
  Scripts: `test` runs vitest 3× with `TZ=UTC`, `TZ=Asia/Kuala_Lumpur`, `TZ=America/New_York` (via `cross-env`).

## Step 2 — Database migration (~40 min)
`npx supabase migration new init` → one SQL file (split later only if useful). Supabase migrations are the source of truth; **no Prisma migrations**. After `db reset`, run `prisma db pull` then tidy names (`@@map`/`@map`, camelCase) so `prisma/schema.prisma` matches the DB.

**Tables** (uuid PK `gen_random_uuid()`, money `bigint` sen, dates `date`, instants `timestamptz`):
- `organizations(id, name)`
- `memberships(user_id PK → auth.users, org_id, role check in (manager,staff))`: PK on user_id = exactly one org.
- `units(id, org_id, name, unique(org_id,name), unique(id,org_id))`
- `tenants(id, org_id, user_id unique → auth.users, full_name, email, phone, unique(id,org_id))`
- `leases(id, org_id, unit_id, tenant_id, start_date, end_date, monthly_rent_sen >0, deposit_sen ≥0, created_by, created_at)`, with composite FKs `(unit_id,org_id)→units(id,org_id)` and `(tenant_id,org_id)→tenants` (no cross-org even if code fails), check end ≥ start, **`EXCLUDE USING gist (unit_id WITH =, daterange(start_date,end_date,'[]') WITH &&)`** (`btree_gist`).
- `invoices(id, org_id, lease_id, kind check (deposit,rent), period_index, period_start, period_end, due_date, amount_sen >0)`, with a check that deposit ⇔ period fields null, and `unique(lease_id, period_index)`.
- `payments(id, org_id, lease_id, amount_sen >0, unapplied_sen ≥0 default 0, method check, status check, received_at, slip_path, gateway_bill_id UNIQUE → gateway_bills, recorded_by, decided_by, decided_at, reason, created_at)`, with checks: bank_transfer ⇒ slip_path not null; online ⇔ gateway_bill_id not null. Trigger: no DELETE.
- `payment_allocations(id, org_id, payment_id, invoice_id, amount_sen >0, unique(payment_id, invoice_id))`
- `gateway_bills(id text PK = 'bill_' + 32 random bytes base64url, org_id, lease_id, amount_sen >0, status check (pending,paid,failed), transaction_id, paid_at, created_by, created_at)`
- `audit_log(id bigint identity, org_id, actor_id null (null = gateway/system), action, entity_id text, details jsonb, created_at default now())`, with triggers `BEFORE UPDATE OR DELETE` (row) and `BEFORE TRUNCATE` (statement) that raise. Fires for owner and service_role too.
- Indexes on every FK / org_id / (lease_id, due_date).

**Privileges / RLS**
- `revoke all on all tables, sequences, functions in schema public from anon, authenticated, service_role`, and `alter default privileges … revoke` the same, so no new object leaks.
- Grant `select` on the listed tables to `authenticated` only; `grant update (phone) on tenants to authenticated`. Nothing for anon. No insert/delete grants anywhere.
- RLS enabled on **every** table. Helpers live in a non-exposed schema `app` (so no `/rpc`): `app.staff_org_id()`, `app.staff_role()`, `app.tenant_ids()`, `app.tenant_org_id()`. These are `security definer stable`, `set search_path = ''`, execute granted to authenticated only, to avoid recursion on memberships/tenants.
- Policies (`to authenticated`, wrapped `(select app.fn())`), following the brief's matrix: org/staff rows by `org_id = staff_org_id()`; tenant rows by `lease_id in (leases of tenant_ids())`; units via tenant's leases; tenants self `user_id = auth.uid()` + update policy USING/WITH CHECK self; audit_log select only when `staff_role() = 'manager'`; memberships staff/manager only.
- **Storage**: insert bucket `payment-slips` (private, `file_size_limit` 5 MB, `allowed_mime_types` jpeg/png/pdf). Policies on `storage.objects` for select/insert/delete (no update) when `bucket_id='payment-slips' and (storage.foldername(name))[1] = app.staff_org_id()::text`. Tenants/anon have no policy, so they're denied.
- Run `npx supabase db advisors` and fix.

## Step 3 — Server core (~25 min)
- `lib/http.ts`: `HttpError(status,msg)`, `route(handler)` wrapper → maps HttpError / ZodError→400 / unknown→500 `{error}` (no internals leaked); `json()` serializer (bigint→number, dates→`YYYY-MM-DD`, instants→ISO `+08:00`).
- `lib/auth.ts` `getActor(req)`: `Authorization: Bearer` → `supabase.auth.getUser(token)`; else cookie client `getUser()`. No user → 401. Role from Prisma: `memberships` (manager/staff + orgId) else `tenants.user_id` (tenant + orgId + tenantId). Neither → 403. Never user_metadata/getSession.
- `lib/access.ts`: `loadLeaseFor(actor, leaseId, tx?)` scopes by org (+ tenant_id for tenants) → 404 if invalid uuid or not visible; `requireRole(actor, ...roles)` → 403. **Order: 401 → 404 → 403 → 400 → 409/422.**
- `lib/time.ts`: `parseInstant` (ISO 8601 **with offset** required), `formatMyt` (Intl, `timeZone: 'Asia/Kuala_Lumpur'`), `ymdToDate`/`dateToYmd` (UTC-midnight ↔ string). Verify Prisma `@db.Date` round-trip under `TZ=America/New_York` early.
- Concurrency rule: every money mutation runs in `prisma.$transaction(fn, {timeout: 15000, maxWait: 10000})` and first does `SELECT … FROM leases WHERE id=$1 FOR UPDATE` (always lease first, then bill/payment, so no deadlocks). This serializes cap checks, approvals, voids, webhook settlement and bill creation per lease.

## Step 4 — Services, shared by API + seed (~45 min) — `lib/services/*.ts`
- `createLease(actor, input)`: manager; unit & tenant must be in actor org (else 404); `SELECT unit FOR UPDATE` → overlap query → 409; insert lease + `generateSchedule` invoices in one tx (validation errors → 400); exclusion-constraint `23P01` → 409 as a backstop; audit `lease.created`.
- `recordPayment(actor, leaseId, body)`: staff/manager; zod body; amount positive safe int; receivedAt with offset, not in the future; bank_transfer requires slipPath that starts with `${orgId}/` **and exists** (query `storage.objects` via Prisma); lock lease → cap = Σinvoices − Σallocations − Σpending → 422. Manager → approved + allocate (audit `payment.approved`); staff → pending_verification. **On any failure with slipPath, delete the object** (admin client) so no orphan.
- `allocate(tx, paymentId)`: invoices of lease with unpaid > 0 ordered `due_date, (kind='rent'), period_index`; fill each; remainder → `unapplied_sen`.
- `approvePayment` / `rejectPayment(reason ≥5 trimmed)` / `voidPayment(reason ≥5)`: manager; lock lease, re-read payment **inside the lock** → state check 409; approve re-checks amount ≤ Σinvoices − Σallocations → 422 (stays pending); void deletes its allocations only; audit each.
- `createGatewayBill(actor, leaseId)`: tenant of that lease only (staff/manager → 403); lock lease; due-now = Σ unpaid of invoices with `due_date ≤ mytToday(now)`; 0 → 422; id = `bill_` + `randomBytes(32).toString('base64url')`.
- `settleWebhook(fields)` (`app/api/webhooks/gateway/route.ts`): parse urlencoded; signature over all fields except x_signature, sorted by char code, `k+v` joined `|`, HMAC-SHA256 hex, `timingSafeEqual` → 401; unknown bill → 404; paid=true and paid_amount ≠ bill amount (strict integer string) → 422; then lock lease → lock bill → re-read status: paid → 200 no-op; pending/failed + paid=true → bill paid, payment(online, approved, received_at = parsed `paid_at`), allocate; paid=false + pending → failed; else no-op. `unique(gateway_bill_id)` is the last-resort guarantee. Log only bill id/outcome — never the key or payload.
- `collectionsReport(actor, from, to)`: staff/manager; validate `YYYY-MM`, from ≤ to, ≤ 120 months → 400; SQL `generate_series` months LEFT JOIN approved payments on `to_char(received_at AT TIME ZONE 'Asia/Kuala_Lumpur','YYYY-MM')`.

## Step 5 — HTTP routes (~15 min) — thin wrappers over services
`app/api/leases/route.ts` (POST), `app/api/leases/[leaseId]/route.ts` (GET: lease + invoices in allocation order with paidSen/status via `invoiceStatus` + payments), `…/[leaseId]/payments/route.ts`, `…/[leaseId]/gateway-bills/route.ts`, `app/api/payments/[paymentId]/{approve,reject,void}/route.ts`, `app/api/reports/collections/route.ts`, `app/api/webhooks/gateway/route.ts`. Next 16: `params` is a Promise (check `node_modules/next/dist/docs` for route handler conventions first).

## Step 6 — Seed (~15 min) — `scripts/seed.ts`, `npm run seed` = `tsx --conditions=react-server scripts/seed.ts` (loads `.env.local`)
Abort if data exists. Create the 7 auth users via admin API (shared password `RentDemo#2026`, email_confirm) → orgs, memberships, units (incl. D-03-2), tenants → leases via `createLease(managerActor)` → Aisyah: cash 300000 at `2026-01-31T10:00+08:00` by manager; staff signs in, uploads a tiny PNG to `<northwindOrg>/…` with their own token, `recordPayment` bank_transfer 200000 at `2026-03-01T00:30+08:00`, then `approvePayment(manager)`.

## Step 7 — UI (~45 min) — shadcn + sonner toasts, Skeletons, empty states
- `/login` (supabase-js password sign-in) → redirect by role.
- Staff/manager: `/dashboard` (overdue count + last-6-months collections), `/leases` (list), `/leases/[id]` (invoices table, payments with signed-URL slip link (60 s), Record Payment dialog: ringgit text → `parseRinggitToSen`, `datetime-local` treated as MYT → `+08:00`, slip upload direct to Storage then POST, delete the file if the POST fails; manager approve / reject / void with AlertDialog + reason).
- Tenant: `/portal` (lease, invoices + statuses, payments, amount due now, Pay now → shows bill id + amount, phone edit via supabase-js `update({phone})`), `/payments/return` (read-only status from DB, scoped to the caller).
- All formatting via `formatMyt` / YMD strings computed on the server, so server and client agree and there are no hydration warnings. Client components call our own API routes (single source of logic).
- Bonus if time remains: `/leases/new` with a live `generateSchedule` preview.

## Step 8 — Write-ups (~30 min, keep a hard stop)
- `REVIEW.md` (Part B), ranked. Pre-identified: **late-fees**: role from `user_metadata` + no org scoping (critical); 0.995 float threshold; non-idempotent/concurrent duplicate fees; `kind:'late_fee'` violates the check; `nextReference` race + lazy PrismaPromises → duplicate refs / NaN; no tx/audit; (todayMyt, cutoff and Date `>=` compares are suspicious but correct). **webhook**: logs payload + expected signature; non-constant-time compare; paid≠true returns before the 404/failed transition; no paid_amount check; check-then-update race → double payment; `receivedAt = new Date()` instead of paid_at. **collections**: server action trusts client `orgId` with no auth; `date_trunc` in UTC session TZ; missing zero months.
- `DECISIONS.md` (6 answers ≤150 words, with file:line refs). Q5 decision: void does **not** auto-apply other payments' unapplied credit (brief: other payments' allocations do not change); it stays as visible credit.
- `README.md` (run steps = grader commands, password, env, known issues, skipped, next steps). `ai-logs/` via `/export` (user).

## Critical files
`docs/REQUIREMENTS.md`, `prisma7.config.ts`, `.env.example`, `proxy.ts`, `lib/billing.ts`, `lib/billing.test.ts`, `supabase/migrations/*_init.sql`, `prisma/schema.prisma`, `lib/{http,auth,access,time,prisma}.ts`, `lib/supabase/*`, `lib/services/*`, `app/api/**/route.ts`, `scripts/seed.ts`, `app/(staff)/…`, `app/portal/…`, `app/payments/return/page.tsx`, `REVIEW.md`, `DECISIONS.md`, `README.md`.

## Verification
1. `npm test` (billing under 3 TZs) green.
2. `npx supabase db reset && npm run seed`, then curl as each seeded user (Bearer token from `/auth/v1/token`): cross-org → 404, wrong role → 403, no token → 401; GET Aisyah's lease matches the worked example; `GET /api/reports/collections?from=2026-01&to=2026-03` → `[300000, 0, 200000]`.
3. `scripts/check-access.ts`: supabase-js as anon / each user against every table (read + insert/update/delete), tenant phone update ok / full_name update fails, storage upload/list/read per role, `audit_log` update/delete fails even as postgres (psql).
4. `scripts/concurrency.ts`: 2 parallel payments over the cap (one 422), double approve (one 409, allocated once), 5 parallel identical webhooks (one payment), forged sig 401, out-of-order paid=false after paid (no change), parallel overlapping leases (one 409). Plus `gateway-sim.mjs` and the test-vector signature.
5. `npm run typecheck && npm run lint && npm run build`.
6. **Fresh-clone rehearsal**: `git clone` to scratch and run the exact grader command list (`db reset`, `npm install` with no env file, `cp .env.example .env.local`, `seed`, `build && start`). Browser check with a different OS/browser timezone: no hydration warnings.
