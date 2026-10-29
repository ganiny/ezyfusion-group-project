import 'server-only'

import type { Prisma } from '@/lib/generated/prisma/client'
import { prisma } from '@/lib/prisma'

export type Tx = Prisma.TransactionClient

/**
 * Every money mutation runs in one transaction that first locks the lease row.
 * That serializes, per lease: cap checks, approvals, voids, webhook settlement
 * and bill creation. Lock order is always lease -> (bill | payment) to avoid
 * deadlocks. Generous timeouts because concurrent callers queue on the lock.
 */
export function withLeaseLock<T>(leaseId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return prisma.$transaction(
    async (tx) => {
      await lockLease(tx, leaseId)
      return fn(tx)
    },
    { maxWait: 10_000, timeout: 20_000 },
  )
}

export async function lockLease(tx: Tx, leaseId: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM public.leases WHERE id = ${leaseId}::uuid FOR UPDATE`
}

/** Finds a Postgres SQLSTATE (e.g. 23P01, 23505) anywhere in a Prisma/driver error. */
export function hasPgCode(error: unknown, code: string, depth = 0): boolean {
  if (depth > 5 || error === null || typeof error !== 'object') return false
  const record = error as Record<string, unknown>
  for (const key of ['code', 'originalCode']) {
    if (record[key] === code) return true
  }
  if (record.code === 'P2002' && code === '23505') return true
  return ['cause', 'meta', 'driverAdapterError'].some((key) => hasPgCode(record[key], code, depth + 1))
}
