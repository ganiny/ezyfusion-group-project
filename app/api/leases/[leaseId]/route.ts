import { requireActor } from '@/lib/auth'
import { json, route } from '@/lib/http'
import { getLeaseDetail } from '@/lib/services/leases'

export const GET = route(async (req, { params }: { params: Promise<{ leaseId: string }> }) => {
  const actor = await requireActor(req)
  const { leaseId } = await params
  return json(await getLeaseDetail(actor, leaseId))
})
