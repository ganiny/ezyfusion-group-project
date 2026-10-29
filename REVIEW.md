# Code review — late fees, gateway webhook, collections action

Line numbers count from the first line of each file in the PR (the `// app/...` path comment is line 1).
Files: **LF** = `app/api/leases/[leaseId]/late-fees/route.ts`, **WH** = `app/api/webhooks/gateway/route.ts`, **CA** = `app/(staff)/dashboard/actions.ts`.

Ordered from most to least severe.

## 1. CA L2, L6–L10 — Unauthenticated cross-organization data leak — **Critical**
`getCollections` is an exported Server Action, i.e. a public POST endpoint. It authenticates nobody and takes `orgId` from the caller. Prisma connects as the owner, so RLS does not apply. Anyone, even a signed-out visitor or a Beta Realty tenant, can call it with Northwind's `orgId` and read Northwind's revenue.
**Fix:** drop the `orgId` parameter. Authenticate with `getUser()`, load the caller's membership, and use *its* `org_id`. Require role manager or staff.

## 2. LF L13 (+ L18–L19) — Authorization from `user_metadata`, and no organization scoping — **Critical**
`user_metadata` is editable by the user (`supabase.auth.updateUser({ data: { role: 'manager' } })`), so any tenant can make themselves a "manager". `findUnique({ where: { id: leaseId } })` is also not scoped to the caller's organization. A Beta manager (or the forged "manager" above) can therefore add fees to any Northwind lease, and the 404/non-404 answer reveals which lease ids exist.
**Fix:** take role and org from `memberships`. Query `findFirst({ where: { id: leaseId, orgId: membership.orgId } })` and return 404 otherwise. Also, a missing user should get **401**, not 403 (L13 treats `user === null` as forbidden).

## 3. WH L21–L26 — Check-then-act race creates duplicate payments — **Critical**
The `bill.status === 'paid'` check (L23) runs outside the transaction, and the update at L26 is unconditional. Two deliveries of the same callback 5 ms apart both read `pending` and both create an approved payment. The second one is allocated again, or lands entirely as `unapplied_sen`, and the tenant is credited twice.
**Fix:** inside the transaction, lock and re-check: `SELECT … FROM gateway_bills WHERE id = $1 FOR UPDATE`, or `updateMany({ where: { id, status: { not: 'paid' } }, … })` and proceed only if `count === 1`. Back it with a `UNIQUE (gateway_bill_id)` constraint on `payments`.

## 4. WH L16 — Logs the whole callback and the expected signature — **High**
The brief forbids logging whole payloads. Worse, `expected` is the valid HMAC for the received fields. Anyone who can read the logs can send a forged body (e.g. `paid=true` for a pending bill), wait for the 401, and copy the correct signature from the log. Log access then equals the ability to settle bills. The log also leaks tenant and transaction data.
**Fix:** log at most the bill id and the outcome. Never log `fields`, `expected`, or the key.

## 5. WH L33 — `paid_amount` is never compared with the bill — **High**
Any `paid=true` callback settles the bill for whatever amount it states. A partial payment (e.g. RM 1.00 against a RM 2,100.50 bill) marks the bill `paid`, so it can never be paid again. The brief requires a **422** with no effect. `BigInt('abc')` also throws, which becomes a 500.
**Fix:** require `/^\d+$/` and `BigInt(paid_amount) === bill.amountSen`; otherwise 422. Create the payment for `bill.amountSen`.

## 6. CA L8, L11 — Months are computed in UTC, not Malaysia time — **High**
`date_trunc('month', received_at)` and `${from}::date` use the session `TimeZone`, which is UTC on the server. The seeded transfer received 2026-03-01 00:30 MYT (= 2026-02-28 16:30 UTC) is reported in **February**, and every month boundary is 8 hours off.
**Fix:** group by `to_char(received_at AT TIME ZONE 'Asia/Kuala_Lumpur', 'YYYY-MM')`. Bound the range with Malaysia midnights: `received_at >= (from_month::timestamp AT TIME ZONE 'Asia/Kuala_Lumpur')`.

## 7. LF L28–L46 — Not idempotent: fees are added again on every call — **High**
Nothing records that an invoice has already been charged. A retry, a double click, or two managers clicking at once each add another 2% fee for the same invoices.
**Fix:** store the source invoice on the fee (`late_fee_for_invoice_id`) with a UNIQUE constraint. Create the fees in one transaction that locks the lease, and skip invoices already charged.

## 8. WH L19 — `paid=false` returns before the bill lookup — **Medium**
A `paid=false` callback for an unknown bill gets 200 instead of **404**. A pending bill is never moved to `failed`, so the "paid=false, bill pending → failed" rule is not implemented.
**Fix:** look the bill up first (404). Then, under the same lock, set `failed` only when it is still `pending`; never touch a `paid` bill.

## 9. LF L31 — Float threshold treats underpaid invoices as paid — **Medium**
`paid / amount >= 0.995` skips invoices with up to 0.5% outstanding (RM 7.50 on RM 1,500). It contradicts the rule that an invoice is paid only when `paidSen >= amountSen`, and uses floating point on money. A zero-amount invoice gives `0/0 = NaN` and gets a 0-sen fee.
**Fix:** use `if (paid >= invoice.amountSen) continue` with bigint arithmetic (or `invoiceStatus`).

## 10. LF L38, L41, L50–L53 — Invalid invoice rows and a broken reference generator — **Medium**
- `kind: 'late_fee'` is not an `InvoiceKind` and violates the `kind IN ('deposit','rent')` check, so the insert fails (500). If it were allowed, rows with null periods would also break the allocation order and the GET response contract. `reference` is not a column either.
- `nextReference` is read-max-then-increment with no lock, so concurrent requests collide. Within one request it is worse: `prisma.invoice.create(...)` returns a *lazy* PrismaPromise that does not run until `Promise.all` (L46). Every `nextReference` call therefore reads the same "last" invoice, and all fees get the **same** number. `parseInt(last.reference.slice(4))` on a schedule invoice without a reference throws, or yields `INV-NaN`.

**Fix:** model fees explicitly (an allowed kind, or a separate `late_fees` table). Take references from a DB sequence, or a per-org counter row updated under lock.

## 11. WH L34 — `received_at` is the processing time, not `paid_at` — **Medium**
The brief says `received_at = paid_at`. A gateway retry hours later, or a payment at 23:59 MYT on 31 March processed after midnight, is dated wrongly and lands in the wrong collections month.
**Fix:** parse `paid_at` (`YYYY-MM-DD HH:MM:SS +0800`) and store that instant; reject it if it is invalid.

## 12. LF L28–L46 — No transaction and no audit row — **Low**
If one `create` fails, the others still commit (partial fees), and the action leaves no audit trail.
**Fix:** wrap the loop in `prisma.$transaction` and write an `audit_log` row.

## 13. WH L15 — Non-constant-time signature comparison — **Low**
`!==` on hex strings can leak timing information. It is also an unhandled 500 if `GATEWAY_X_SIGNATURE_KEY` is unset.
**Fix:** `timingSafeEqual` on equal-length buffers, after checking the format `/^[0-9a-f]{64}$/`.

## 14. CA L12–L14 — Months with no payments are missing — **Low**
`GROUP BY` returns only months that have payments. The brief requires one entry per month, including zeros (e.g. February 2026 → 0).
**Fix:** `generate_series` over the months, `LEFT JOIN` the payments, then `COALESCE(SUM(...), 0)`.

## Looks suspicious, but is correct
- **LF L24–L25, L29:** `todayMyt` (now + 8 h, take the UTC date) is the correct Malaysia date. `Date.parse('YYYY-MM-DD')` is UTC midnight, matching Prisma's `@db.Date` values. `dueDate >= cutoff` compares Dates numerically through `valueOf`, so "skip unless due more than 7 days ago" is right.
- **LF L39:** `new Date(todayMyt)` is UTC midnight of the Malaysia date, which is exactly how a `date` column round-trips.
- **LF L32:** `Math.round` on a positive integer-valued product rounds half up, and the values are far below 2^53.
- **CA L7, L14:** `SUM(bigint)` actually returns `numeric` (a Prisma `Decimal`, not `bigint` as the type claims), but `Number(decimal)` converts it correctly.
