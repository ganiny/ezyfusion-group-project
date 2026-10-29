import 'server-only'

import { z } from 'zod'

import { isUuid, leaseScope, notFound, requireRole } from '@/lib/access'
import type { Actor } from '@/lib/auth'
import { withLeaseLock } from '@/lib/db'
import { HttpError } from '@/lib/http'
import { formatSen } from '@/lib/money'
import { prisma } from '@/lib/prisma'
import { allocatePayment, leaseBalances } from '@/lib/services/ledger'
import { deleteSlipIfOrphaned, slipExists } from '@/lib/services/slips'
import { parseInstant } from '@/lib/time'

type PaymentStatus = 'pending_verification' | 'approved' | 'rejected' | 'voided'

// Clock skew allowance for "received in the future" checks.
const FUTURE_TOLERANCE_MS = 5 * 60 * 1000

const recordPaymentSchema = z.object({
  amountSen: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  method: z.enum(['cash', 'bank_transfer']),
  receivedAt: z.string(),
  slipPath: z.string().min(1).max(512).optional(),
})

const reasonSchema = z.object({
  reason: z
    .string({ error: 'A reason is required' })
    .trim()
    .min(5, { error: 'The reason must be at least 5 characters' })
    .max(1000),
})

/** POST /api/leases/:leaseId/payments: staff and managers record cash or bank transfer. */
export async function recordPayment(actor: Actor, leaseId: string, input: unknown): Promise<{ id: string; status: PaymentStatus }> {
  if (!isUuid(leaseId)) throw notFound('Lease not found')
  const lease = await prisma.lease.findFirst({ where: { id: leaseId, ...leaseScope(actor) }, select: { id: true, orgId: true } })
  if (!lease) throw notFound('Lease not found')
  requireRole(actor, 'manager', 'staff')

  // A slip uploaded for this request must not survive a failed recording.
  const uploadedSlip =
    input && typeof input === 'object' && 'slipPath' in input && typeof input.slipPath === 'string' ? input.slipPath : null
  try {
    const body = recordPaymentSchema.parse(input)
    const receivedAt = parseInstant(body.receivedAt)
    if (!receivedAt) throw new HttpError(400, 'receivedAt must be an ISO 8601 instant with an offset, e.g. 2026-03-01T00:30:00+08:00')
    if (receivedAt.getTime() > Date.now() + FUTURE_TOLERANCE_MS) throw new HttpError(400, 'receivedAt cannot be in the future')

    if (body.method === 'bank_transfer') {
      if (!body.slipPath) throw new HttpError(400, 'A bank transfer needs a slip (slipPath)')
      if (!body.slipPath.startsWith(`${lease.orgId}/`) || body.slipPath.includes('..')) {
        throw new HttpError(400, "slipPath must be a file in your organization's folder")
      }
      if (!(await slipExists(body.slipPath))) throw new HttpError(400, 'The slip file does not exist; upload it first')
    } else if (body.slipPath) {
      throw new HttpError(400, 'Only bank transfers take a slip')
    }

    const status: PaymentStatus = actor.role === 'manager' ? 'approved' : 'pending_verification'
    return await withLeaseLock(lease.id, async (tx) => {
      // Cap: remaining balance (invoices - allocations) minus pending payments.
      const balances = await leaseBalances(tx, lease.id)
      const capSen = balances.invoicedSen - balances.allocatedSen - balances.pendingSen
      if (body.amountSen > capSen) {
        throw new HttpError(422, `Amount exceeds what can be paid on this lease (at most ${formatSen(Math.max(capSen, 0))})`)
      }
      const payment = await tx.payment.create({
        data: {
          orgId: lease.orgId,
          leaseId: lease.id,
          amountSen: BigInt(body.amountSen),
          method: body.method,
          status,
          receivedAt,
          slipPath: body.method === 'bank_transfer' ? body.slipPath : null,
          recordedBy: actor.userId,
          ...(status === 'approved' ? { decidedBy: actor.userId, decidedAt: new Date() } : {}),
        },
      })
      if (status === 'approved') {
        const plan = await allocatePayment(tx, payment)
        await tx.auditLog.create({
          data: {
            orgId: lease.orgId,
            actorId: actor.userId,
            action: 'payment.approved',
            entityId: payment.id,
            details: { leaseId: lease.id, amountSen: body.amountSen, method: body.method, recordedByManager: true, unappliedSen: plan.unappliedSen },
          },
        })
      }
      return { id: payment.id, status }
    })
  } catch (error) {
    if (uploadedSlip && uploadedSlip.startsWith(`${lease.orgId}/`)) await deleteSlipIfOrphaned(uploadedSlip)
    throw error
  }
}

/** Loads a payment the actor can see (404 otherwise), then checks the role (403). */
async function visiblePaymentForManager(actor: Actor, paymentId: string) {
  if (!isUuid(paymentId)) throw notFound('Payment not found')
  const payment = await prisma.payment.findFirst({
    where: { id: paymentId, orgId: actor.orgId, lease: leaseScope(actor) },
    select: { id: true, leaseId: true },
  })
  if (!payment) throw notFound('Payment not found')
  requireRole(actor, 'manager')
  return payment
}

/** POST /api/payments/:paymentId/approve */
export async function approvePayment(actor: Actor, paymentId: string): Promise<{ status: PaymentStatus }> {
  const { leaseId } = await visiblePaymentForManager(actor, paymentId)
  return withLeaseLock(leaseId, async (tx) => {
    // Re-read under the lease lock: a concurrent approval has either committed
    // (status is no longer pending -> 409) or not started.
    const payment = await tx.payment.findUniqueOrThrow({ where: { id: paymentId } })
    if (payment.status !== 'pending_verification') throw new HttpError(409, `Payment is ${payment.status}, not pending verification`)
    const balances = await leaseBalances(tx, leaseId)
    const remainingSen = balances.invoicedSen - balances.allocatedSen
    if (Number(payment.amountSen) > remainingSen) {
      throw new HttpError(422, `Payment exceeds the lease's remaining balance (${formatSen(Math.max(remainingSen, 0))}); it stays pending`)
    }
    await tx.payment.update({
      where: { id: paymentId },
      data: { status: 'approved', decidedBy: actor.userId, decidedAt: new Date() },
    })
    const plan = await allocatePayment(tx, payment)
    await tx.auditLog.create({
      data: {
        orgId: payment.orgId,
        actorId: actor.userId,
        action: 'payment.approved',
        entityId: paymentId,
        details: { leaseId, amountSen: Number(payment.amountSen), unappliedSen: plan.unappliedSen },
      },
    })
    return { status: 'approved' as const }
  })
}

/** POST /api/payments/:paymentId/reject */
export async function rejectPayment(actor: Actor, paymentId: string, input: unknown): Promise<{ status: PaymentStatus }> {
  const { leaseId } = await visiblePaymentForManager(actor, paymentId)
  const { reason } = reasonSchema.parse(input ?? {})
  return withLeaseLock(leaseId, async (tx) => {
    const payment = await tx.payment.findUniqueOrThrow({ where: { id: paymentId } })
    if (payment.status !== 'pending_verification') throw new HttpError(409, `Payment is ${payment.status}, not pending verification`)
    await tx.payment.update({
      where: { id: paymentId },
      data: { status: 'rejected', decidedBy: actor.userId, decidedAt: new Date(), decisionReason: reason },
    })
    await tx.auditLog.create({
      data: { orgId: payment.orgId, actorId: actor.userId, action: 'payment.rejected', entityId: paymentId, details: { leaseId, reason } },
    })
    return { status: 'rejected' as const }
  })
}

/** POST /api/payments/:paymentId/void: removes only this payment's allocations. */
export async function voidPayment(actor: Actor, paymentId: string, input: unknown): Promise<{ status: PaymentStatus }> {
  const { leaseId } = await visiblePaymentForManager(actor, paymentId)
  const { reason } = reasonSchema.parse(input ?? {})
  return withLeaseLock(leaseId, async (tx) => {
    const payment = await tx.payment.findUniqueOrThrow({ where: { id: paymentId } })
    if (payment.status !== 'approved') throw new HttpError(409, `Payment is ${payment.status}, not approved`)
    const removed = await tx.paymentAllocation.deleteMany({ where: { paymentId } })
    await tx.payment.update({
      where: { id: paymentId },
      data: { status: 'voided', decidedBy: actor.userId, decidedAt: new Date(), decisionReason: reason },
    })
    await tx.auditLog.create({
      data: {
        orgId: payment.orgId,
        actorId: actor.userId,
        action: 'payment.voided',
        entityId: paymentId,
        details: { leaseId, reason, amountSen: Number(payment.amountSen), allocationsRemoved: removed.count },
      },
    })
    return { status: 'voided' as const }
  })
}
