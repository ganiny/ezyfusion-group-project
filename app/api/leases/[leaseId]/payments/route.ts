import { requireActor } from '@/lib/auth'
import { json, readJson, route } from '@/lib/http'
import { recordPayment } from '@/lib/services/payments'

export const POST = route(async (req, { params }: { params: Promise<{ leaseId: string }> }) => {
  const actor = await requireActor(req)
  const { leaseId } = await params
  return json(await recordPayment(actor, leaseId, await readJson(req)), 201)
})
