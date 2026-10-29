# Decisions

## 1. The same `paid=true` callback twice, 5 ms apart

Both requests verify the HMAC (`lib/services/gateway.ts:45-58`), find the bill and check `paid_amount` (L84-96). Each then opens a transaction through `withLeaseLock` (L101). The first to arrive locks the lease row (`lib/db.ts:25`), then the bill row (`gateway.ts:103`, `FOR UPDATE`). The second blocks on the same lease lock. The first sees `pending`, marks the bill paid, creates one approved online payment with `received_at = paid_at`, allocates it and commits. The second then acquires the lock, re-reads the status *inside* its transaction, sees `paid` (L105) and returns 200 with no effect. The guarantee is the lock plus the in-transaction re-check. The backstop is `payments.gateway_bill_id UNIQUE` (`supabase/migrations/…_init.sql:135`): if anything slipped through, the insert fails with 23505, which is treated as a duplicate (`gateway.ts:141`).

## 2. RM 800 and RM 700 recorded at the same moment, RM 1,000 remaining

`recordPayment` (`lib/services/payments.ts:62-67`) runs inside `withLeaseLock`. Both requests try `SELECT … FROM leases WHERE id = … FOR UPDATE` (`lib/db.ts:25`), so one waits. The first computes cap = invoices − allocations − pending = 1,000, inserts its payment (pending for staff) and commits. The second then reads the balances again *after* acquiring the lock. Pending now includes the first payment, so the cap is 1,000 − 800 = 200 (or 300), and it gets **422**. Only one is accepted. Approval re-checks the remaining balance under the same lock (`payments.ts:117-127`), so two approvals cannot over-allocate either.

## 3. Every "today" and date↔instant conversion

- `lib/billing.ts:108-116` `mytDayNumber`/`mytToday`: `floor((epochMs + 8h) / day)`. Malaysia has no DST, so a fixed +8 h is exact and the host TZ is never consulted. Used by `invoiceStatus` and the amount due now (`gateway.ts:16, 29`).
- `lib/time.ts` `ymdToDate`/`dateToYmd`: calendar dates ↔ UTC-midnight `Date`, which is how Prisma represents a `date` column. They use UTC fields only, so the result is the same in any TZ.
- `lib/time.ts` `parseInstant`: API instants must carry an offset; the UI form appends `+08:00` (`mytLocalInputToIso`).
- `lib/time.ts` `toMytIso`/`formatMyt*`: output in MYT with an explicit `+08:00`, formatted by hand (identical on server and browser, so no hydration mismatch).
- `lib/services/reports.ts:45-46`: month bounds are `timestamp AT TIME ZONE 'Asia/Kuala_Lumpur'`, i.e. Malaysia midnights.
- `gateway.ts:60-63`: `paid_at` `+0800` is converted to an instant.

## 4. Queries not subject to RLS

- **All Prisma queries** connect as the owner. Authorization: `requireActor` (`lib/auth.ts:32-36` uses `getUser`, then `resolveActor` L44 reads `memberships`/`tenants`). Every query is scoped by `leaseScope(actor)` (`lib/access.ts`) or `orgId: actor.orgId`, giving 404 outside scope, then `requireRole` (403). Composite FKs `(x_id, org_id)` in the migration make cross-org rows impossible even if code were wrong.
- **Service role** (`lib/supabase/admin.ts`, `server-only`) is used for slip cleanup (`slips.ts:24`, only paths already checked to be in the actor's org and not referenced by a payment) and signed URLs (`slips.ts:31`, only after the lease page's own access check). The seed script also uses it to create users.
- **SECURITY DEFINER** helpers (`app.*`, migration L215+) only return the *caller's own* org/tenant ids from `auth.uid()`. They live in the unexposed schema `app` and are executable by `authenticated` only.

## 5. A void reopens invoices while the lease still has `unapplied_sen` from an online payment

The void removes only the voided payment's allocations (`payments.ts:170`). The online payment keeps its `unapplied_sen` untouched, and the reopened invoices show as unpaid/overdue again. I chose not to re-apply the credit automatically. The brief says other payments' allocations must not change on a void, and silently creating new allocations on another payment is a money movement with no explicit decision and no audit row. The credit stays visible on the lease. The next step would be an explicit manager action "apply unapplied credit", running under the lease lock and writing an `audit_log` row.

## 6. Things the AI assistant got wrong

1. **Prisma env loading.** It first configured `prisma7.config.ts` with `env("DATABASE_URL")` loaded from `.env`, the default setup. The graders only create `.env.local`, and `npm install` runs `prisma generate` (postinstall) *before* any env file exists, where `env()` throws. This was caught by checking the plan against the brief's exact grader commands; the config now loads `.env.local` and tolerates a missing URL (see the "Step 0" section in `ai-logs/`).
2. **Request validation order.** The route handlers first parsed the JSON body strictly, so a malformed body on another org's payment returned 400 instead of 404. This was caught reviewing the handlers against section 6; `readJson` became lenient so access checks run first (`lib/http.ts`; see "readJson" in `ai-logs/`).
3. **BigInt literals** failed the typecheck under the scaffold's ES2017 target. This was caught by `tsc`; the target was raised to ES2022.
