import { requireActor } from '@/lib/auth'
import { json, route } from '@/lib/http'
import { createGatewayBill } from '@/lib/services/gateway'

export const POST = route(async (req, { params }: { params: Promise<{ leaseId: string }> }) => {
  const actor = await requireActor(req)
  const { leaseId } = await params
  return json(await createGatewayBill(actor, leaseId), 201)
})
