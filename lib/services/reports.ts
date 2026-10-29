import 'server-only'

import { requireRole } from '@/lib/access'
import type { Actor } from '@/lib/auth'
import { invoiceStatus } from '@/lib/billing'
import { HttpError } from '@/lib/http'
import { toSen } from '@/lib/money'
import { prisma } from '@/lib/prisma'
import { dateToYmd } from '@/lib/time'

const MONTH_PATTERN = /^(\d{4})-(0[1-9]|1[0-2])$/
const MAX_MONTHS = 120

function monthNumber(value: string | null): number | null {
  const match = value ? MONTH_PATTERN.exec(value) : null
  return match ? Number(match[1]) * 12 + Number(match[2]) - 1 : null
}

/**
 * Approved payments per calendar month of received_at in Malaysia time,
 * one entry per month (zero-filled), in order.
 */
export async function collectionsReport(actor: Actor, from: string | null, to: string | null) {
  requireRole(actor, 'manager', 'staff')
  const start = monthNumber(from)
  const end = monthNumber(to)
  if (start === null || end === null) throw new HttpError(400, 'from and to must be months written as YYYY-MM')
  if (end < start) throw new HttpError(400, 'from must not be after to')
  if (end - start + 1 > MAX_MONTHS) throw new HttpError(400, `The range is limited to ${MAX_MONTHS} months`)

  // Month boundaries are Malaysia wall-clock midnights converted to instants
  // (`timestamp AT TIME ZONE 'Asia/Kuala_Lumpur'`), so a payment at
  // 2026-03-01 00:30 MYT (= 2026-02-28 16:30 UTC) counts in March.
  const rows = await prisma.$queryRaw<{ month: string; collected: bigint }[]>`
    WITH months AS (
      SELECT m::timestamp AS month_start
      FROM generate_series(${`${from}-01`}::date, ${`${to}-01`}::date, interval '1 month') AS m
    )
    SELECT to_char(months.month_start, 'YYYY-MM') AS month,
           COALESCE(SUM(p.amount_sen), 0)::bigint AS collected
    FROM months
    LEFT JOIN public.payments p
      ON p.org_id = ${actor.orgId}::uuid
     AND p.status = 'approved'
     AND p.received_at >= (months.month_start AT TIME ZONE 'Asia/Kuala_Lumpur')
     AND p.received_at < ((months.month_start + interval '1 month') AT TIME ZONE 'Asia/Kuala_Lumpur')
    GROUP BY months.month_start
    ORDER BY months.month_start`
  return rows.map((r) => ({ month: r.month, collectedSen: toSen(r.collected) }))
}

/** Number of overdue invoices in the actor's org (status computed, never stored). */
export async function overdueInvoiceCount(actor: Actor, now = new Date()): Promise<number> {
  requireRole(actor, 'manager', 'staff')
  const invoices = await prisma.invoice.findMany({
    where: { orgId: actor.orgId },
    select: { dueDate: true, amountSen: true, allocations: { select: { amountSen: true } } },
  })
  return invoices.filter(
    (i) =>
      invoiceStatus(
        { dueDate: dateToYmd(i.dueDate), amountSen: toSen(i.amountSen), paidSen: i.allocations.reduce((s, a) => s + toSen(a.amountSen), 0) },
        now,
      ) === 'overdue',
  ).length
}
