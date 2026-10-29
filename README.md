# Rent Collection: EzyFusion technical assessment

Next.js 16 (App Router) · TypeScript (strict) · Supabase (Postgres, Auth, Storage, RLS) · Prisma 7 · shadcn/ui · Tailwind.
The brief is in [`docs/REQUIREMENTS.md`](docs/REQUIREMENTS.md), the build plan in [`docs/PLAN.md`](docs/PLAN.md), the code review in [`REVIEW.md`](REVIEW.md), and the design answers in [`DECISIONS.md`](DECISIONS.md).

## Run it

```bash
npx supabase start
npx supabase db reset          # applies supabase/migrations/ (tables, RLS, grants, triggers, storage bucket + policies)
npm install                    # postinstall runs `prisma generate` (works without any env file)
cp .env.example .env.local     # local Supabase defaults; compare with `npx supabase status`
npm run seed                   # brief's seed data, created through the app's own services
npm run build && npm start
npm test                       # lib/billing.ts tests under TZ=UTC, Asia/Kuala_Lumpur, America/New_York
```

**Seeded accounts:** all share the password **`RentDemo#2026`**, e.g. `manager@northwind.test`.

## Architecture

| Concern | Where |
|---|---|
| Billing rules (pure, TZ-independent) | `lib/billing.ts`, tests in `lib/billing.test.ts` |
| Schema, constraints, RLS, grants, triggers, storage | `supabase/migrations/*_init.sql` (single source of truth; Prisma Migrate is not used) |
| Typed DB access | `prisma/schema.prisma` mirrors the migration; `lib/prisma.ts` (pg driver adapter) |
| Authentication → actor (role/org from `memberships` / `tenants.user_id`) | `lib/auth.ts` (Bearer token or cookie, verified with `getUser`) |
| Scoping (404) and role checks (403) | `lib/access.ts` |
| Per-lease serialization (`SELECT … FOR UPDATE`) | `lib/db.ts` |
| Leases, payments, allocation, gateway, reports | `lib/services/*` (shared by API routes and the seed) |
| HTTP API | `app/api/**/route.ts` (thin wrappers) |

Key guarantees:
- **Money** is `bigint` sen in the database and integer sen everywhere else; there is no float arithmetic on money.
- **Overlapping leases** are refused by a per-unit row lock plus an `EXCLUDE USING gist` constraint, which also holds under concurrency (409).
- **Cap, approve, void and webhook** all lock the lease row first and re-read state inside the transaction (409/422 are decided under the lock).
- **Webhook:** HMAC checked with `timingSafeEqual`; 404 for an unknown bill; 422 when the amount differs. The bill row is locked and its status re-checked, and `payments.gateway_bill_id` is UNIQUE, so a bill creates at most one payment. Only the bill id and outcome are logged.
- **Data API** is read-only for `authenticated` (RLS on every table, nothing for `anon`), except a column-level `UPDATE (phone)` on the tenant's own row. Helper functions live in the unexposed `app` schema, so there are no `/rpc` endpoints. `audit_log` and `payments` have triggers forbidding UPDATE/DELETE (audit) and DELETE (payments), and these apply to the owner and service role too.
- **Storage:** private `payment-slips` bucket (5 MB; JPEG/PNG/PDF). Insert/select/delete are limited to staff and managers whose org id is the first path segment. A slip from a failed recording is deleted server-side.

## Status, known issues, and what I skipped

- **Verified:** `lib/billing.ts` (62 tests × 3 timezones), typecheck, lint.
- **Not fully verified end to end:** Docker Desktop on my machine repeatedly hung during the test (`supabase db reset`/`stop` could not kill the DB container), so I could not run the seed, the API, and the concurrency checks against a live database before time ran out. The migration and services are written to the brief, but treat them as unexercised.
- **UI (section 9):** not built beyond the scaffold; I prioritized billing, access control, payments and the webhook as the brief instructs. The API covers every flow.
- **Bonus items:** only unit tests for billing and allocation planning (`planAllocation`).

## What I would do next

1. Run the full grader sequence from a fresh clone, then the concurrency scripts (parallel payments over the cap, double approve, 5× duplicate webhook, overlapping leases) and a Data API/Storage probe as anon and as each role.
2. Build the UI: staff dashboard, lease page with record/approve/reject/void dialogs, and the tenant portal with Pay now, `/payments/return` and phone editing via supabase-js.
3. An explicit "apply unapplied credit" manager action (see DECISIONS.md §5).
