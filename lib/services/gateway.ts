import 'server-only'

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

import { isUuid, leaseScope, notFound, requireRole } from '@/lib/access'
import type { Actor } from '@/lib/auth'
import { mytToday } from '@/lib/billing'
import { hasPgCode, lockLease, withLeaseLock } from '@/lib/db'
import { HttpError } from '@/lib/http'
import { prisma } from '@/lib/prisma'
import { allocatableInvoices, allocatePayment } from '@/lib/services/ledger'
import { parseInstant } from '@/lib/time'

/** Amount due now: unpaid amounts of invoices due on or before today's Malaysia date. */
export async function amountDueNowSen(leaseId: string, now = new Date()): Promise<number> {
  const today = mytToday(now)
  const invoices = await allocatableInvoices(prisma, leaseId)
  return invoices.filter((i) => i.dueDate <= today).reduce((sum, i) => sum + Math.max(i.amountSen - i.paidSen, 0), 0)
}

/** POST /api/leases/:leaseId/gateway-bills: only the lease's own tenant. */
export async function createGatewayBill(actor: Actor, leaseId: string, now = new Date()): Promise<{ billId: string; amountSen: number }> {
  if (!isUuid(leaseId)) throw notFound('Lease not found')
  const lease = await prisma.lease.findFirst({ where: { id: leaseId, ...leaseScope(actor) }, select: { id: true, orgId: true } })
  if (!lease) throw notFound('Lease not found')
  requireRole(actor, 'tenant')

  return withLeaseLock(lease.id, async (tx) => {
    const today = mytToday(now)
    const dueSen = (await allocatableInvoices(tx, lease.id))
      .filter((i) => i.dueDate <= today)
      .reduce((sum, i) => sum + Math.max(i.amountSen - i.paidSen, 0), 0)
    if (dueSen <= 0) throw new HttpError(422, 'Nothing is due on this lease right now')
    // 256 random bits: bill ids cannot be guessed or enumerated.
    const billId = `bill_${randomBytes(32).toString('base64url')}`
    await tx.gatewayBill.create({
      data: { id: billId, orgId: lease.orgId, leaseId: lease.id, amountSen: BigInt(dueSen), createdBy: actor.userId },
    })
    return { billId, amountSen: dueSen }
  })
}

// --- Webhook ----------------------------------------------------------------

export function gatewaySignature(fields: Record<string, string>, key: string): string {
  const source = Object.keys(fields)
    .filter((k) => k !== 'x_signature')
    .sort()
    .map((k) => `${k}${fields[k]}`)
    .join('|')
  return createHmac('sha256', key).update(source, 'utf8').digest('hex')
}

function signatureMatches(fields: Record<string, string>, key: string): boolean {
  const given = fields.x_signature
  if (typeof given !== 'string' || !/^[0-9a-f]{64}$/.test(given)) return false
  return timingSafeEqual(Buffer.from(gatewaySignature(fields, key), 'hex'), Buffer.from(given, 'hex'))
}

// "2026-04-01 00:30:12 +0800" -> instant
function parseGatewayTime(value: string | undefined): Date | null {
  const match = value ? /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) ([+-]\d{2})(\d{2})$/.exec(value) : null
  return match ? parseInstant(`${match[1]}T${match[2]}${match[3]}:${match[4]}`) : null
}

export type WebhookOutcome = { status: number; body: Record<string, unknown> }

/**
 * POST /api/webhooks/gateway. Only this settles a bill. Idempotent and safe
 * under concurrent duplicate deliveries: the bill row is locked and its status
 * re-read inside the transaction, and payments.gateway_bill_id is UNIQUE.
 */
export async function handleGatewayWebhook(rawBody: string): Promise<WebhookOutcome> {
  const key = process.env.GATEWAY_X_SIGNATURE_KEY
  if (!key) throw new Error('GATEWAY_X_SIGNATURE_KEY is not configured')

  const params = new URLSearchParams(rawBody)
  const fields: Record<string, string> = {}
  for (const [name, value] of params) {
    // A repeated field makes the signed string ambiguous: treat as unverifiable.
    if (Object.hasOwn(fields, name)) return { status: 401, body: { error: 'Invalid signature' } }
    fields[name] = value
  }
  if (!signatureMatches(fields, key)) return { status: 401, body: { error: 'Invalid signature' } }

  const bill = fields.id ? await prisma.gatewayBill.findUnique({ where: { id: fields.id } }) : null
  if (!bill) return { status: 404, body: { error: 'Unknown bill' } }

  if (fields.paid !== 'true' && fields.paid !== 'false') return { status: 400, body: { error: 'paid must be true or false' } }
  const paid = fields.paid === 'true'
  let paidAt: Date | null = null
  if (paid) {
    if (!/^\d+$/.test(fields.paid_amount ?? '') || BigInt(fields.paid_amount) !== bill.amountSen) {
      return { status: 422, body: { error: 'paid_amount does not match the bill amount' } }
    }
    paidAt = parseGatewayTime(fields.paid_at)
    if (!paidAt) return { status: 400, body: { error: 'paid_at is not a valid timestamp' } }
  }

  try {
    const outcome = await withLeaseLock(bill.leaseId, async (tx) => {
      const [current] = await tx.$queryRaw<{ status: string }[]>`
        SELECT status FROM public.gateway_bills WHERE id = ${bill.id} FOR UPDATE`
      if (paid) {
        if (current.status === 'paid') return 'duplicate'
        await tx.gatewayBill.update({
          where: { id: bill.id },
          data: { status: 'paid', paidAt, transactionId: fields.transaction_id ?? null, updatedAt: new Date() },
        })
        const payment = await tx.payment.create({
          data: {
            orgId: bill.orgId,
            leaseId: bill.leaseId,
            amountSen: bill.amountSen,
            method: 'online',
            status: 'approved',
            receivedAt: paidAt!,
            gatewayBillId: bill.id,
            decidedAt: new Date(),
          },
        })
        const plan = await allocatePayment(tx, payment)
        await tx.auditLog.create({
          data: {
            orgId: bill.orgId,
            actorId: null,
            action: 'payment.online_settled',
            entityId: payment.id,
            details: { billId: bill.id, leaseId: bill.leaseId, amountSen: Number(bill.amountSen), unappliedSen: plan.unappliedSen },
          },
        })
        return 'paid'
      }
      if (current.status !== 'pending') return current.status === 'failed' ? 'duplicate' : 'ignored_paid'
      await tx.gatewayBill.update({ where: { id: bill.id }, data: { status: 'failed', updatedAt: new Date() } })
      return 'failed'
    })
    console.info('gateway webhook processed', { billId: bill.id, outcome })
  } catch (error) {
    // Backstop: the UNIQUE(gateway_bill_id) index already holds a payment.
    if (!hasPgCode(error, '23505')) throw error
    console.info('gateway webhook processed', { billId: bill.id, outcome: 'duplicate' })
  }
  return { status: 200, body: { ok: true } }
}

/** Lock helper re-export for tests/scripts that need the same ordering. */
export { lockLease }
