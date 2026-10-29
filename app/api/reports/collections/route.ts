import { requireActor } from '@/lib/auth'
import { json, route } from '@/lib/http'
import { collectionsReport } from '@/lib/services/reports'

export const GET = route(async (req) => {
  const actor = await requireActor(req)
  const url = new URL(req.url)
  return json(await collectionsReport(actor, url.searchParams.get('from'), url.searchParams.get('to')))
})
