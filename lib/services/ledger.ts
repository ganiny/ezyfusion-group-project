import 'server-only'

import { planAllocation, type AllocatableInvoice, type InvoiceKind } from '@/lib/billing'
import type { Tx } from '@/lib/db'
import { toSen } from '@/lib/money'
import { dateToYmd } from '@/lib/time'

// Balance and allocation primitives. Callers must hold the lease lock (lib/db.ts).

export interface LeaseBalances {
  invoicedSen: number
  allocatedSen: number
  pendingSen: number
}

export async function leaseBalances(tx: Tx, leaseId: string): Promise<LeaseBalances> {
  const [invoiced, allocated, pending] = await Promise.all([
    tx.invoice.aggregate({ where: { leaseId }, _sum: { amountSen: true } }),
    tx.paymentAllocation.aggregate({ where: { invoice: { leaseId } }, _sum: { amountSen: true } }),
    tx.payment.aggregate({ where: { leaseId, status: 'pending_verification' }, _sum: { amountSen: true } }),
  ])
  return {
    invoicedSen: toSen(invoiced._sum.amountSen),
    allocatedSen: toSen(allocated._sum.amountSen),
    pendingSen: toSen(pending._sum.amountSen),
  }
}

export async function allocatableInvoices(tx: Tx, leaseId: string): Promise<AllocatableInvoice[]> {
  const invoices = await tx.invoice.findMany({
    where: { leaseId },
    include: { allocations: { select: { amountSen: true } } },
  })
  return invoices.map((invoice) => ({
    id: invoice.id,
    kind: invoice.kind as InvoiceKind,
    periodIndex: invoice.periodIndex,
    dueDate: dateToYmd(invoice.dueDate),
    amountSen: toSen(invoice.amountSen),
    paidSen: invoice.allocations.reduce((sum, a) => sum + toSen(a.amountSen), 0),
  }))
}

/**
 * Allocates an approved payment to the lease's unpaid invoices (due date,
 * deposit before rent, period index), storing any remainder as unapplied_sen.
 */
export async function allocatePayment(tx: Tx, payment: { id: string; orgId: string; leaseId: string; amountSen: bigint }) {
  const plan = planAllocation(await allocatableInvoices(tx, payment.leaseId), toSen(payment.amountSen))
  if (plan.allocations.length > 0) {
    await tx.paymentAllocation.createMany({
      data: plan.allocations.map((a) => ({
        orgId: payment.orgId,
        paymentId: payment.id,
        invoiceId: a.invoiceId,
        amountSen: BigInt(a.amountSen),
      })),
    })
  }
  await tx.payment.update({ where: { id: payment.id }, data: { unappliedSen: BigInt(plan.unappliedSen) } })
  return plan
}
