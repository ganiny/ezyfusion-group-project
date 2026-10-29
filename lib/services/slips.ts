import 'server-only'

import { prisma } from '@/lib/prisma'
import { createAdminClient } from '@/lib/supabase/admin'

export const SLIP_BUCKET = 'payment-slips'

/** Whether an object exists in the slip bucket (read via Postgres as the owner). */
export async function slipExists(path: string): Promise<boolean> {
  const rows = await prisma.$queryRaw<{ exists: boolean }[]>`
    SELECT EXISTS (SELECT 1 FROM storage.objects WHERE bucket_id = ${SLIP_BUCKET} AND name = ${path}) AS "exists"`
  return rows[0]?.exists === true
}

/**
 * Removes a slip uploaded for a recording that failed, unless some payment
 * already references it (a caller could re-send another payment's slipPath).
 * Callers have already checked the path is inside the actor's org folder.
 */
export async function deleteSlipIfOrphaned(path: string): Promise<void> {
  try {
    const referenced = await prisma.payment.findFirst({ where: { slipPath: path }, select: { id: true } })
    if (referenced) return
    await createAdminClient().storage.from(SLIP_BUCKET).remove([path])
  } catch {
    console.error('Failed to clean up an orphaned slip')
  }
}

/** Short-lived signed URL for a slip; callers authorize the request first. */
export async function signedSlipUrl(path: string, expiresInSeconds = 60): Promise<string | null> {
  const { data, error } = await createAdminClient().storage.from(SLIP_BUCKET).createSignedUrl(path, expiresInSeconds)
  return error ? null : data.signedUrl
}
