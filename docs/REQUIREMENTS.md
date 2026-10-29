# Test Requirements — Technical Assessment: Rent Collection

> Verbatim copy of the assessment brief, kept as the build reference.

**Stack:** Next.js 16 (App Router) · TypeScript · Supabase (Postgres, Auth, Storage) · Prisma · shadcn/ui · Tailwind CSS

**Time:** the timer above is what counts, normally 4 hours (about 30 min reading · 3 h building · 30 min write-ups and submission)

## Read This First

AI assistants (Claude Code, Cursor, Copilot...) are allowed and expected. We assess whether you understand and control what gets built. Code you cannot explain counts as not done.

**Hidden tests.** We run automated tests against every rule in this brief, including edge cases that are not in the examples:

- your billing functions, about 50 hidden cases, run under `TZ=UTC`, `TZ=Asia/Kuala_Lumpur` and `TZ=America/New_York`
- your HTTP API, called as each seeded account, including requests about other organizations' records and concurrent requests
- your Supabase Data API and Storage bucket, called directly with your publishable key and each user's token
- your payment webhook, with valid, forged, duplicated, concurrent and out-of-order callbacks

**AI logs.** Export the transcript of every AI session you use (in Claude Code: `/export`) into an `ai-logs/` folder in your repo. We do not count how much you used AI. We look at how you directed it, what you checked and what you corrected.

**Walkthrough.** If your submission passes, the interview starts with a 30-minute walkthrough of your code: we pick parts of it, ask "what happens if...", and ask you to make a small change live.

**Priorities.** A correct and secure subset beats a complete but sloppy app. If time runs short, work in this order: billing functions (section 3), access control (6), payments (4), webhook (5), UI (9). Say in your README what you skipped.

**Names are a contract.** Table names, column names, endpoint paths, file paths and response shapes in this brief are what our tests use. You may add more of your own.

## 1. The Business

You are building part of the rent collection module of a property management platform used by Malaysian property management companies.

- Each organization (a property management company) rents units to tenants under leases.
- A lease produces invoices: an optional deposit, plus one rent invoice per monthly period.
- Tenants pay by cash, by bank transfer (with an uploaded slip), or online through a payment gateway. Payments are allocated to invoices.
- Business timezone: Asia/Kuala_Lumpur (UTC+8, no daylight saving). Currency: MYR (RM). 1 ringgit = 100 sen.
- Your server runs in UTC and our assessors work from several timezones. Every date and time the app shows or accepts is Malaysia time, whatever the timezone of the server or of the viewer's device.

### Roles

| Role | Who | Can |
|---|---|---|
| manager | Organization admin | Everything in their organization: create leases, record payments (approved immediately), approve, reject and void payments, read the audit log |
| staff | Front desk | Read their organization's leases, invoices and payments; record payments (these wait for a manager's approval) |
| tenant | Renter | Read their own profile, leases, invoices and payments; update their own phone number; pay online |

A staff member or manager belongs to exactly one organization. Nobody ever sees another organization's data.

## 2. Local Setup and Seed Data

Develop against a local Supabase stack (Docker and the Supabase CLI), not a cloud project. See Supabase local development. We grade by running your project on our machine from a fresh clone, with exactly these commands:

```bash
npx supabase start            # starts the stack from your supabase/config.toml
npx supabase db reset         # rebuilds the database from supabase/migrations/
npm install
cp .env.example .env.local    # we replace keys with the values from `npx supabase status` if they differ
npm run seed
npm run build && npm start
```

Commit `supabase/config.toml`, `supabase/migrations/`, and an `.env.example` that lists every variable your app needs, with local values and a comment saying where each one comes from.

`npm run seed` creates exactly the data below on a freshly reset database, through your normal code paths (your lease creation and payment logic), so the invoices and allocations it produces are the ones your app would produce.

All seeded accounts share one password of your choice, which you submit with your work.

### Organizations and accounts

| Organization | Account | Role | Notes |
|---|---|---|---|
| Northwind Properties | manager@northwind.test | manager | |
| Northwind Properties | staff@northwind.test | staff | |
| Northwind Properties | aisyah@northwind.test | tenant | Tenant "Aisyah Rahman" |
| Northwind Properties | ben@northwind.test | tenant | Tenant "Ben Lim" |
| Northwind Properties | probe@northwind.test | tenant | Tenant "Probe Tenant" (our tests create payments and leases for this tenant) |
| Beta Realty | manager@beta.test | manager | |
| Beta Realty | chen@beta.test | tenant | Tenant "Chen Wei" |

### Units and leases

| Organization | Unit | Tenant | Start | End | Monthly rent | Deposit |
|---|---|---|---|---|---|---|
| Northwind | A-12-3 | Aisyah Rahman | 2026-01-31 | 2026-07-15 | RM 1,500.00 | RM 3,000.00 |
| Northwind | B-05-1 | Ben Lim | 2026-01-01 | 2026-04-15 | RM 1,000.29 | none |
| Northwind | C-01-7 | Probe Tenant | 2026-02-28 | 2027-02-27 | RM 2,000.00 | RM 4,000.00 |
| Northwind | D-03-2 | (no lease) | | | | |
| Beta | KL-1 | Chen Wei | 2026-03-15 | 2027-03-14 | RM 2,200.00 | RM 4,400.00 |

### Payments on Aisyah's lease

- Cash, RM 3,000.00, received 2026-01-31 10:00 Malaysia time, recorded by the manager.
- Bank transfer, RM 2,000.00, received 2026-03-01 00:30 Malaysia time, recorded by staff with a slip file, then approved by the manager.

## 3. Billing Rules — `lib/billing.ts`

Create `lib/billing.ts` (or `src/lib/billing.ts`). It must be pure: no I/O, no imports from Next.js, React, Supabase or Prisma, and no dependence on the timezone of the machine it runs on. Your app must use it, and we test it directly.

```ts
export type InvoiceKind = 'deposit' | 'rent'

export interface ScheduledInvoice {
  kind: InvoiceKind
  periodIndex: number | null  // 0, 1, 2... for rent; null for the deposit
  periodStart: string | null  // 'YYYY-MM-DD'; null for the deposit
  periodEnd: string | null    // 'YYYY-MM-DD', inclusive; null for the deposit
  dueDate: string             // 'YYYY-MM-DD'
  amountSen: number           // integer
}

export function generateSchedule(lease: {
  startDate: string           // 'YYYY-MM-DD'
  endDate: string             // 'YYYY-MM-DD', inclusive (the tenant's last day)
  monthlyRentSen: number
  depositSen: number
}): ScheduledInvoice[]

export type InvoiceStatus = 'paid' | 'partially_paid' | 'unpaid' | 'overdue'

export function invoiceStatus(
  invoice: { dueDate: string; amountSen: number; paidSen: number },
  now: Date,
): InvoiceStatus

export function parseRinggitToSen(input: string): number
```

### generateSchedule

- **Validation.** Throw an Error if a date is not a real calendar date written as YYYY-MM-DD, if endDate is before startDate, if monthlyRentSen is not a positive integer, or if depositSen is not a non-negative integer.
- **Deposit.** If depositSen > 0, the first invoice is the deposit: `kind: 'deposit'`, due on startDate, period fields null.
- **Anchors.** Rent periods are anchored on the start date. The anchor of period k is the start date plus k calendar months, always counted from the start date (never from the previous anchor). If that month has fewer days than the start day, use the month's last day. A lease starting on Jan 31 has anchors Jan 31, Feb 28 (Feb 29 in leap years), Mar 31, Apr 30, and so on.
- **Periods.** Period k runs from anchor k to the day before anchor k+1, and is due on anchor k. There is a period for every anchor on or before endDate.
- **Last period.** It is cut at endDate. If it is shorter than its full length, it costs monthlyRentSen × days used / days in the full period, rounded half up to the nearest sen. Every other period costs monthlyRentSen.
- **Order.** The deposit first, then rent by period index.

Worked example (Aisyah's lease):

| Period | Kind | Dates | Due | Amount |
|---|---|---|---|---|
| | deposit | | 2026-01-31 | RM 3,000.00 |
| 0 | rent | 2026-01-31 to 2026-02-27 | 2026-01-31 | RM 1,500.00 |
| 1 | rent | 2026-02-28 to 2026-03-30 | 2026-02-28 | RM 1,500.00 |
| 2 | rent | 2026-03-31 to 2026-04-29 | 2026-03-31 | RM 1,500.00 |
| 3 | rent | 2026-04-30 to 2026-05-30 | 2026-04-30 | RM 1,500.00 |
| 4 | rent | 2026-05-31 to 2026-06-29 | 2026-05-31 | RM 1,500.00 |
| 5 | rent | 2026-06-30 to 2026-07-15 | 2026-06-30 | RM 774.19 |

Period 5 uses 16 of the 31 days from 2026-06-30 to 2026-07-30: 150000 × 16 / 31 = 77419.35, so 77419 sen.

### invoiceStatus

Apply these rules in order:

1. `paid` if paidSen >= amountSen.
2. `overdue` if today's Malaysia date is after dueDate. An invoice due 2026-03-01 becomes overdue at 2026-03-02 00:00 Malaysia time (2026-03-01T16:00:00Z), not a moment earlier.
3. `partially_paid` if paidSen > 0.
4. Otherwise `unpaid`.

### parseRinggitToSen

Turns what a user types into sen. It accepts digits with optional comma thousands separators (groups of exactly three digits) and an optional decimal part of one or two digits, ignoring whitespace around the value: `"1,500.50"` gives 150050, `"1.15"` gives 115, `"7"` gives 700. Anything else throws an Error, for example `""`, `"-5"`, `"1.234"`, `"1e3"`, `"RM 10"`, `"1,23"`.

## 4. Payments

### Recording a payment

- Staff and managers record cash or bank transfer payments on a lease: the amount, the method, and the date and time the money was received (entered and shown in Malaysia time).
- A bank transfer needs a slip: a JPEG, PNG or PDF of at most 5 MB, stored in Supabase Storage (section 6). If recording fails after the upload, the file must not be left behind.
- A payment recorded by a manager is approved immediately. A payment recorded by staff is `pending_verification` until a manager approves or rejects it.
- **Cap.** A new payment may not be more than the lease's remaining balance (the total of all its invoices minus everything allocated to them) minus the total of the lease's payments still `pending_verification`. Paying future periods in advance is allowed within the cap.

### Approving, rejecting and voiding (managers only)

- **Approve** a `pending_verification` payment. At that moment, check again that it is not more than the lease's remaining balance. If it is, refuse and leave it pending.
- **Reject** a `pending_verification` payment, with a reason of at least 5 characters.
- **Void** an approved payment, with a reason of at least 5 characters. Voiding removes that payment's allocations. Other payments' allocations do not change.
- Payments are never deleted. Every approval, rejection, void and lease creation writes a row to `audit_log` (who, what, when, details).

### Allocation

When a payment becomes approved, its amount is allocated to the lease's invoices that still have something unpaid, in this order: due date, then deposit before rent, then period index. Each invoice is filled up to its unpaid amount before the next one, including invoices that are not due yet. Whatever is left once every invoice is fully paid is stored on the payment as `unapplied_sen`. Only online payments can end up with an unapplied amount, because manual payments are capped.

The paid amount of an invoice is the sum of its allocations. Statuses are computed with `invoiceStatus`, never stored.

All of this must stay correct when requests arrive at the same time. For example, two staff members recording payments on the same lease at once must not exceed the cap together, and a payment approved twice at once is allocated once.

### Collections report

The total of approved payments for each calendar month of `received_at` in Malaysia time, over a range of months, including months with nothing collected. With the seed data, Northwind's report for 2026-01 to 2026-03 is `[{ month: '2026-01', collectedSen: 300000 }, { month: '2026-02', collectedSen: 0 }, { month: '2026-03', collectedSen: 200000 }]`.

## 5. Online Payments

A tenant pays online like this:

1. The tenant clicks **Pay now** on their lease. Your API creates a gateway bill for the amount due now: the unpaid amounts of the lease's invoices due on or before today's Malaysia date. If nothing is due, refuse. Bill ids must be impossible to guess.
2. In production the tenant would now be redirected to the gateway. In this test, show the bill id and amount: we play the gateway using the simulator below.
3. The gateway calls your webhook, `POST /api/webhooks/gateway`. Only the webhook can settle a bill. The gateway also sends the tenant back to `/payments/return?bill_id=...&paid=true`. That page only shows the bill's real status from your database and changes nothing.

### Webhook

The request body is `application/x-www-form-urlencoded`, with these fields. The gateway may add more fields in future.

| Field | Example | Notes |
|---|---|---|
| id | bill_8f3a2c | Your bill id (this short example is guessable; yours must not be) |
| paid | true | true or false |
| paid_amount | 210050 | Amount in sen; 0 when not paid |
| paid_at | 2026-04-01 00:30:12 +0800 | When it was paid |
| transaction_id | TX-000123 | Gateway transaction id |
| transaction_status | completed | completed, failed or pending |
| x_signature | 06994f... | See below |

**Signature.** Take every field in the request except `x_signature`, sort them by key (ascending by character code), write each one as the key immediately followed by the value, join them with `|`, and compute the HMAC-SHA256 of the resulting string with your secret key `GATEWAY_X_SIGNATURE_KEY`, as lowercase hex. Test vector, with the key `test_x_signature_key` and the six example values above:

```
source:    idbill_8f3a2c|paidtrue|paid_amount210050|paid_at2026-04-01 00:30:12 +0800|transaction_idTX-000123|transaction_statuscompleted
signature: 06994fab2d674e7829144eaa2204631716d3c099b503d38945e92b6296531641
```

Required behavior:

| Situation | Response | Effect |
|---|---|---|
| Signature missing or wrong | 401 | None |
| Unknown bill id | 404 | None |
| paid=true and paid_amount is not the bill's amount | 422 | None |
| paid=true, bill pending or failed | 200 | Bill becomes paid, and one approved online payment is created with received_at = paid_at, then allocated |
| paid=true, bill already paid (a repeat delivery) | 200 | None |
| paid=false, bill pending | 200 | Bill becomes failed |
| paid=false, bill already failed (a repeat delivery) | 200 | None |
| paid=false, bill already paid (late or out of order) | 200 | None: a paid bill never goes back |

The gateway retries, so it may deliver the same callback several times, including at the same moment. A bill creates at most one payment, ever. Never log the secret key or whole callback payloads.

### Simulator

Save this as `gateway-sim.mjs` and run `node gateway-sim.mjs <bill_id> <amount_sen> [true|false]` with `GATEWAY_X_SIGNATURE_KEY` set.

```js
import { createHmac } from 'node:crypto'

const [billId, amountSen, paid = 'true'] = process.argv.slice(2)
const url = process.env.WEBHOOK_URL ?? 'http://localhost:3000/api/webhooks/gateway'
const key = process.env.GATEWAY_X_SIGNATURE_KEY

const myt = new Date(Date.now() + 8 * 3600 * 1000).toISOString()
const fields = {
  id: billId,
  paid,
  paid_amount: paid === 'true' ? amountSen : '0',
  paid_at: `${myt.slice(0, 10)} ${myt.slice(11, 19)} +0800`,
  transaction_id: `TX-${Date.now()}`,
  transaction_status: paid === 'true' ? 'completed' : 'failed',
}
const source = Object.keys(fields).sort().map(k => `${k}${fields[k]}`).join('|')
fields.x_signature = createHmac('sha256', key).update(source).digest('hex')

const res = await fetch(url, {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(fields),
})
console.log(res.status, await res.text())
```

## 6. Access Control

Access is enforced in two places, and we test both:

1. Your server code: route handlers, Server Actions and server components. Every endpoint must authenticate the caller and check their organization and role itself. A protected page or a hidden button is not a check.
2. The Supabase Data API and Storage, which anyone holding your publishable key can call directly with their own access token.

### Server code

- Roles come from your `memberships` table, and from `tenants.user_id` for tenants. Never take a role or an organization from anything the user can edit, such as `user_metadata`.
- On the server, authenticate with `supabase.auth.getUser()` or `getClaims()`, not `getSession()`.
- A request about a record in another organization, or another tenant's record, gets **404**: do not reveal that it exists. A request about a record the caller can see, for an action their role does not allow, gets **403**. A request without a valid login gets **401**.
- IDs in request bodies are untrusted too. For example, a manager must not be able to create a lease on another organization's unit or tenant.
- Our tests call your API with `Authorization: Bearer <access token>`, where the token is a Supabase access token for one of the seeded users. Accept that header as well as the normal session cookie.
- The service role (secret) key must never reach the browser.

### Data API

This table is the most access allowed through the Supabase Data API, which is PostgREST called with a user's token. Granting less is fine where your app does not need it, with one exception: the tenant portal reads the tenant's own data, and updates their phone number, directly from the browser with supabase-js.

| Table | anon | tenant | staff | manager |
|---|---|---|---|---|
| organizations | none | read own organization | read own organization | read own organization |
| memberships | none | none | read own organization | read own organization |
| units | none | read the units of own leases | read own organization | read own organization |
| tenants | none | read own row, update only phone | read own organization | read own organization |
| leases, invoices, payments, payment_allocations, gateway_bills | none | read the rows of own leases | read own organization | read own organization |
| audit_log | none | none | none | read own organization |

Every other insert, update or delete through the Data API must fail for everyone. This covers every table, view and function (`/rest/v1/rpc/...`) you create, not just the ones above. `audit_log` is append-only for every role, including the service role and the database owner.

### Storage

Bank transfer slips go in a private bucket named `payment-slips`, under `<org_id>/...`. Only staff and managers of that organization can upload there, and they read slips through short-lived signed URLs. Tenants, other organizations and anonymous users cannot read, list or upload slips. A payment's `slip_path` must point to an existing file in its own organization's folder.

## 7. HTTP API

Request and response bodies are JSON, except for the webhook. Amounts are integers in sen. Dates are YYYY-MM-DD, and instants are ISO 8601 with an offset. Errors return `{ "error": "message" }`.

| Method and path | Who | Success | Other responses |
|---|---|---|---|
| POST /api/leases | manager | 201 `{ id }` | 400 invalid input, 409 overlaps another lease on the unit |
| GET /api/leases/:leaseId | staff, manager, the lease's tenant | 200, shape below | |
| POST /api/leases/:leaseId/payments | staff, manager | 201 `{ id, status }` | 400 invalid input, 422 over the cap |
| POST /api/payments/:paymentId/approve | manager | 200 `{ status }` | 409 not pending, 422 over the remaining balance |
| POST /api/payments/:paymentId/reject | manager | 200 `{ status }` | 400 missing reason, 409 not pending |
| POST /api/payments/:paymentId/void | manager | 200 `{ status }` | 400 missing reason, 409 not approved |
| POST /api/leases/:leaseId/gateway-bills | the lease's tenant | 201 `{ billId, amountSen }` | 422 nothing due |
| GET /api/reports/collections?from=YYYY-MM&to=YYYY-MM | staff, manager | 200 `[{ month: 'YYYY-MM', collectedSen }]`, one entry per month in order | 400 invalid range |
| POST /api/webhooks/gateway | the gateway | see section 5 | |

Every endpoint also returns 401, 403 and 404 as described in section 6. Request bodies:

```ts
// POST /api/leases
{ unitId: string; tenantId: string; startDate: string; endDate: string; monthlyRentSen: number; depositSen: number }

// POST /api/leases/:leaseId/payments
{ amountSen: number; method: 'cash' | 'bank_transfer'; receivedAt: string; slipPath?: string }

// POST /api/payments/:paymentId/reject and POST /api/payments/:paymentId/void
{ reason: string }
```

`GET /api/leases/:leaseId` returns the invoices in allocation order:

```ts
{
  lease: { id: string; unitId: string; tenantId: string; startDate: string; endDate: string; monthlyRentSen: number; depositSen: number }
  invoices: {
    id: string; kind: 'deposit' | 'rent'; periodIndex: number | null; periodStart: string | null; periodEnd: string | null
    dueDate: string; amountSen: number; paidSen: number; status: InvoiceStatus
  }[]
  payments: {
    id: string; amountSen: number; unappliedSen: number; method: 'cash' | 'bank_transfer' | 'online'
    status: 'pending_verification' | 'approved' | 'rejected' | 'voided'; receivedAt: string
  }[]
}
```

Creating a lease stores the lease and exactly the invoices `generateSchedule` returns, all or nothing. Leases on the same unit never overlap (both dates are inclusive), even when two requests arrive at the same moment.

## 8. Database

- Keep every database object in SQL migrations under `supabase/migrations/`: tables, constraints, RLS policies, grants, functions, triggers, and the storage bucket and its policies. `npx supabase db reset` must rebuild all of it; nothing may depend on changes made by hand in Supabase Studio. Use Prisma for server-side data access, with `prisma/schema.prisma` matching the database.
- Store money as integer sen (`bigint`), never as a floating-point type. Calendar dates are `date`, and instants are `timestamptz`.
- Required tables and columns (add whatever else you need):

| Table | Required columns |
|---|---|
| organizations | id, name |
| memberships | user_id, org_id, role (manager or staff) |
| units | id, org_id, name |
| tenants | id, org_id, user_id, full_name, email, phone |
| leases | id, org_id, unit_id, tenant_id, start_date, end_date, monthly_rent_sen, deposit_sen |
| invoices | id, org_id, lease_id, kind, period_index, period_start, period_end, due_date, amount_sen |
| payments | id, org_id, lease_id, amount_sen, unapplied_sen, method, status, received_at, slip_path, gateway_bill_id |
| payment_allocations | id, org_id, payment_id, invoice_id, amount_sen |
| gateway_bills | id, org_id, lease_id, amount_sen, status (pending, paid or failed) |
| audit_log | id, org_id, actor_id, action, entity_id, details, created_at |

## 9. UI

Use shadcn/ui and Tailwind CSS throughout, with toasts for every action (success and error), loading states instead of blank screens, and helpful messages for empty and invalid input. TypeScript in strict mode, without `any`.

**Staff and managers:**

- A dashboard with the number of overdue invoices and the collections report for the last 6 months.
- A list of leases, and a lease page with its invoices (period, due date, amount, paid, status) and payments (with a link to the slip for bank transfers).
- Recording a payment: the amount typed in ringgit and parsed with `parseRinggitToSen`, the date and time received in Malaysia time, and a slip upload for bank transfers.
- Managers approve or reject pending payments, and void approved ones (with a confirmation step and a reason).

**Tenants:**

- Their lease, invoices with statuses, payments, and the amount due now.
- Pay now, which shows the new gateway bill, and the `/payments/return` page.
- Editing their phone number.

Every date and time is shown in Malaysia time, whatever the viewer's timezone (we check with a different browser timezone), without hydration warnings.

## Part B — Code Review (REVIEW.md)

A teammate opened the pull request below. Review it in `REVIEW.md`. For each problem, give the line number(s), what goes wrong (a concrete scenario), how severe it is, and the fix, ordered from most to least severe. Report only real problems: every false positive costs points. If something looks suspicious but is correct, you may say so and explain why.

The rules of this brief apply. `prisma` connects to Postgres as the database owner. `createClient()` returns a Supabase server client for the current request. Assume `allocate(tx, paymentId)` is correct.

```ts
// app/api/leases/[leaseId]/late-fees/route.ts
import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { createClient } from '@/lib/supabase/server'

const GRACE_DAYS = 7
const DAY_MS = 86_400_000

// Managers only. Adds a 2% late fee for each rent invoice still unpaid more than 7 days after its due date.
export async function POST(_req: Request, { params }: { params: Promise<{ leaseId: string }> }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (user?.user_metadata.role !== 'manager') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const { leaseId } = await params
  const lease = await prisma.lease.findUnique({
    where: { id: leaseId },
    include: { invoices: { include: { allocations: true } } },
  })
  if (!lease) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const todayMyt = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10)
  const cutoff = new Date(Date.parse(todayMyt) - GRACE_DAYS * DAY_MS)

  const fees = []
  for (const invoice of lease.invoices) {
    if (invoice.kind !== 'rent' || invoice.dueDate >= cutoff) continue
    const paid = invoice.allocations.reduce((sum, a) => sum + a.amountSen, 0n)
    if (Number(paid) / Number(invoice.amountSen) >= 0.995) continue
    const fee = Math.round((Number(invoice.amountSen - paid) * 2) / 100)
    fees.push(
      prisma.invoice.create({
        data: {
          orgId: lease.orgId,
          leaseId,
          kind: 'late_fee',
          dueDate: new Date(todayMyt),
          amountSen: BigInt(fee),
          reference: await nextReference(lease.orgId),
        },
      }),
    )
  }
  await Promise.all(fees)
  return NextResponse.json({ created: fees.length })
}

async function nextReference(orgId: string) {
  const last = await prisma.invoice.findFirst({ where: { orgId }, orderBy: { createdAt: 'desc' } })
  return `INV-${(last ? parseInt(last.reference.slice(4), 10) : 0) + 1}`
}

// app/api/webhooks/gateway/route.ts
import { createHmac } from 'node:crypto'
import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { allocate } from '@/lib/allocation'

export async function POST(req: Request) {
  const fields = Object.fromEntries(await req.formData()) as Record<string, string>
  const source = Object.keys(fields)
    .filter(k => k !== 'x_signature')
    .sort()
    .map(k => `${k}${fields[k]}`)
    .join('|')
  const expected = createHmac('sha256', process.env.GATEWAY_X_SIGNATURE_KEY!).update(source).digest('hex')
  if (expected !== fields.x_signature) {
    console.error('Invalid signature', { fields, expected })
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
  }
  if (fields.paid !== 'true') return NextResponse.json({ ok: true })

  const bill = await prisma.gatewayBill.findUnique({ where: { id: fields.id } })
  if (!bill) return NextResponse.json({ error: 'Unknown bill' }, { status: 404 })
  if (bill.status === 'paid') return NextResponse.json({ ok: true })

  await prisma.$transaction(async (tx) => {
    await tx.gatewayBill.update({ where: { id: bill.id }, data: { status: 'paid' } })
    const payment = await tx.payment.create({
      data: {
        orgId: bill.orgId,
        leaseId: bill.leaseId,
        method: 'online',
        status: 'approved',
        amountSen: BigInt(fields.paid_amount),
        receivedAt: new Date(),
        gatewayBillId: bill.id,
      },
    })
    await allocate(tx, payment.id)
  })
  return NextResponse.json({ ok: true })
}

// app/(staff)/dashboard/actions.ts
'use server'
import { prisma } from '@/lib/prisma'

// from and to are the first days of months, e.g. '2026-01-01'
export async function getCollections(orgId: string, from: string, to: string) {
  const rows = await prisma.$queryRaw<{ month: string; total: bigint }[]>`
    SELECT to_char(date_trunc('month', received_at), 'YYYY-MM') AS month, SUM(amount_sen) AS total
    FROM payments
    WHERE org_id = ${orgId}::uuid AND status = 'approved'
      AND received_at >= ${from}::date AND received_at < ${to}::date + interval '1 month'
    GROUP BY 1
    ORDER BY 1`
  return rows.map(r => ({ month: r.month, collectedSen: Number(r.total) }))
}
```

## Part C — Decisions (DECISIONS.md)

Answer each question in at most 150 words, pointing to files and line numbers in your repo:

1. The gateway delivers the same `paid=true` callback twice, 5 ms apart. Walk through what your code does with each one, and point to the line(s) that guarantee a single payment.
2. Two staff members record RM 800 and RM 700 at the same moment on a lease with RM 1,000 remaining. What happens, and what stops both from being accepted?
3. List every place where your code works out "today", or converts between a calendar date and an instant. For each one, which timezone does it use, and why is that right?
4. Which of your queries are not subject to RLS (Prisma, the service role, SECURITY DEFINER functions)? For each one, what enforces authorization instead?
5. A void reopens invoices while the lease still has `unapplied_sen` from an online payment. What does your system do, and why did you choose that?
6. Name two things your AI assistant got wrong during this test and how you noticed. Point to the places in your AI logs.

## Bonus (optional, only if done well)

- A create-lease form for managers with a live preview of the schedule.
- Realtime updates on the tenant portal when a payment is settled.
- Unit tests for `lib/billing.ts` and for allocation.
- Server-side search and pagination for the leases list, synced with the URL.

## Submission

- **GitHub URL:** a public repo with your source, `supabase/config.toml`, `supabase/migrations/`, `prisma/schema.prisma`, the seed script, `.env.example`, `REVIEW.md`, `DECISIONS.md`, `ai-logs/`, and a `README.md` (how to run it, known issues, what you would do next). Do not commit real .env files.
- **Environment variables:** the values from your local env file (`.env.local`), including `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY`, `DATABASE_URL`, `DIRECT_URL` and `GATEWAY_X_SIGNATURE_KEY` (the Supabase values are your local stack's).
- **Test account:** manager@northwind.test, and the password all seeded accounts share.
- **Summary:** what works, what does not, and what you skipped.

## How We Assess

| Area | Points |
|---|---|
| Billing functions (hidden tests) | 15 |
| Access control: server code, Data API, Storage | 25 |
| Payments: allocation, cap, approval, void, concurrency | 15 |
| Webhook: signature, idempotency, concurrency | 15 |
| Timezones: overdue, collections, input and display | 10 |
| Code review (Part B) | 5 |
| Decisions (Part C) | 5 |
| UI and code quality | 10 |

**Instant fail:**

- The service role (secret) key reaches the browser.
- Any table that anonymous users can read or write through the Data API.
- Money stored as a floating-point type.
- A bill or invoice settled by the return page instead of the webhook.

The walkthrough decides whether the score stands: work you cannot explain is treated as not done.

## Rules

- You may use AI tools. Export their logs to `ai-logs/`.
- You may use any documentation and npm packages.
- You may not get help from another person, or use a template that already implements these features.
- The timer started when you confirmed at your first sign in and cannot be paused. Late submissions are not accepted.
