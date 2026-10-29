import 'server-only'

import { z } from 'zod'

import { leaseScope, isUuid, notFound, requireRole } from '@/lib/access'
import type { Actor } from '@/lib/auth'
import { compareAllocationOrder, generateSchedule, invoiceStatus, type InvoiceKind, type InvoiceStatus } from '@/lib/billing'
import { hasPgCode } from '@/lib/db'
import { HttpError } from '@/lib/http'
import { toSen } from '@/lib/money'
import { prisma } from '@/lib/prisma'
import { dateToYmd, toMytIso, ymdToDate } from '@/lib/time'

const createLeaseSchema = z.object({
  unitId: z.string(),
  tenantId: z.string(),
  startDate: z.string(),
  endDate: z.string(),
  monthlyRentSen: z.number(),
  depositSen: z.number(),
})

/** POST /api/leases: the lease and exactly generateSchedule's invoices, all or nothing. */
export async function createLease(actor: Actor, input: unknown): Promise<{ id: string }> {
  requireRole(actor, 'manager')
  const body = createLeaseSchema.parse(input)
  let schedule
  try {
    // Validates dates, end >= start, positive integer rent, non-negative integer deposit.
    schedule = generateSchedule(body)
  } catch (error) {
    throw new HttpError(400, error instanceof Error ? error.message : 'Invalid lease')
  }
  // IDs in the body are untrusted: they must belong to the caller's org (else 404).
  if (!isUuid(body.unitId)) throw notFound('Unit not found')
  if (!isUuid(body.tenantId)) throw notFound('Tenant not found')

  try {
    return await prisma.$transaction(
      async (tx) => {
        const unit = await tx.unit.findFirst({ where: { id: body.unitId, orgId: actor.orgId } })
        if (!unit) throw notFound('Unit not found')
        const tenant = await tx.tenant.findFirst({ where: { id: body.tenantId, orgId: actor.orgId } })
        if (!tenant) throw notFound('Tenant not found')

        // Serialize lease creation per unit so the overlap check is reliable;
        // the EXCLUDE constraint (leases_no_overlap) is the backstop.
        await tx.$queryRaw`SELECT id FROM public.units WHERE id = ${unit.id}::uuid FOR UPDATE`
        const overlapping = await tx.lease.findFirst({
          where: { unitId: unit.id, startDate: { lte: ymdToDate(body.endDate) }, endDate: { gte: ymdToDate(body.startDate) } },
          select: { id: true },
        })
        if (overlapping) throw new HttpError(409, 'The unit already has a lease overlapping these dates')

        const lease = await tx.lease.create({
          data: {
            orgId: actor.orgId,
            unitId: unit.id,
            tenantId: tenant.id,
            startDate: ymdToDate(body.startDate),
            endDate: ymdToDate(body.endDate),
            monthlyRentSen: BigInt(body.monthlyRentSen),
            depositSen: BigInt(body.depositSen),
            createdBy: actor.userId,
          },
        })
        await tx.invoice.createMany({
          data: schedule.map((invoice) => ({
            orgId: actor.orgId,
            leaseId: lease.id,
            kind: invoice.kind,
            periodIndex: invoice.periodIndex,
            periodStart: invoice.periodStart ? ymdToDate(invoice.periodStart) : null,
            periodEnd: invoice.periodEnd ? ymdToDate(invoice.periodEnd) : null,
            dueDate: ymdToDate(invoice.dueDate),
            amountSen: BigInt(invoice.amountSen),
          })),
        })
        await tx.auditLog.create({
          data: {
            orgId: actor.orgId,
            actorId: actor.userId,
            action: 'lease.created',
            entityId: lease.id,
            details: { unitId: unit.id, tenantId: tenant.id, startDate: body.startDate, endDate: body.endDate, invoices: schedule.length },
          },
        })
        return { id: lease.id }
      },
      { maxWait: 10_000, timeout: 20_000 },
    )
  } catch (error) {
    if (hasPgCode(error, '23P01')) throw new HttpError(409, 'The unit already has a lease overlapping these dates')
    throw error
  }
}

export interface LeaseDetail {
  lease: { id: string; unitId: string; tenantId: string; startDate: string; endDate: string; monthlyRentSen: number; depositSen: number }
  invoices: {
    id: string
    kind: InvoiceKind
    periodIndex: number | null
    periodStart: string | null
    periodEnd: string | null
    dueDate: string
    amountSen: number
    paidSen: number
    status: InvoiceStatus
  }[]
  payments: {
    id: string
    amountSen: number
    unappliedSen: number
    method: 'cash' | 'bank_transfer' | 'online'
    status: 'pending_verification' | 'approved' | 'rejected' | 'voided'
    receivedAt: string
  }[]
}

/** GET /api/leases/:leaseId: staff/manager of the org, or the lease's own tenant. */
export async function getLeaseDetail(actor: Actor, leaseId: string, now = new Date()): Promise<LeaseDetail> {
  if (!isUuid(leaseId)) throw notFound('Lease not found')
  const lease = await prisma.lease.findFirst({
    where: { id: leaseId, ...leaseScope(actor) },
    include: {
      invoices: { include: { allocations: { select: { amountSen: true } } } },
      payments: { orderBy: [{ receivedAt: 'asc' }, { createdAt: 'asc' }] },
    },
  })
  if (!lease) throw notFound('Lease not found')

  const invoices = lease.invoices
    .map((invoice) => {
      const amountSen = toSen(invoice.amountSen)
      const paidSen = invoice.allocations.reduce((sum, a) => sum + toSen(a.amountSen), 0)
      const dueDate = dateToYmd(invoice.dueDate)
      return {
        id: invoice.id,
        kind: invoice.kind as InvoiceKind,
        periodIndex: invoice.periodIndex,
        periodStart: invoice.periodStart ? dateToYmd(invoice.periodStart) : null,
        periodEnd: invoice.periodEnd ? dateToYmd(invoice.periodEnd) : null,
        dueDate,
        amountSen,
        paidSen,
        status: invoiceStatus({ dueDate, amountSen, paidSen }, now),
      }
    })
    .sort(compareAllocationOrder)

  return {
    lease: {
      id: lease.id,
      unitId: lease.unitId,
      tenantId: lease.tenantId,
      startDate: dateToYmd(lease.startDate),
      endDate: dateToYmd(lease.endDate),
      monthlyRentSen: toSen(lease.monthlyRentSen),
      depositSen: toSen(lease.depositSen),
    },
    invoices,
    payments: lease.payments.map((p) => ({
      id: p.id,
      amountSen: toSen(p.amountSen),
      unappliedSen: toSen(p.unappliedSen),
      method: p.method as LeaseDetail['payments'][number]['method'],
      status: p.status as LeaseDetail['payments'][number]['status'],
      receivedAt: toMytIso(p.receivedAt),
    })),
  }
}
