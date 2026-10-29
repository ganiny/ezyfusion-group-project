import { requireActor } from '@/lib/auth'
import { json, route } from '@/lib/http'
import { approvePayment } from '@/lib/services/payments'

export const POST = route(async (req, { params }: { params: Promise<{ paymentId: string }> }) => {
  const actor = await requireActor(req)
  const { paymentId } = await params
  return json(await approvePayment(actor, paymentId))
})
