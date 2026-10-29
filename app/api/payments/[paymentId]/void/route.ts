import { requireActor } from '@/lib/auth'
import { json, readJson, route } from '@/lib/http'
import { voidPayment } from '@/lib/services/payments'

export const POST = route(async (req, { params }: { params: Promise<{ paymentId: string }> }) => {
  const actor = await requireActor(req)
  const { paymentId } = await params
  return json(await voidPayment(actor, paymentId, await readJson(req)))
})
