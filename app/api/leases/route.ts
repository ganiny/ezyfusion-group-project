import { requireActor } from '@/lib/auth'
import { json, readJson, route } from '@/lib/http'
import { createLease } from '@/lib/services/leases'

export const POST = route(async (req) => {
  const actor = await requireActor(req)
  return json(await createLease(actor, await readJson(req)), 201)
})
