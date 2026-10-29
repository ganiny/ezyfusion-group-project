import { json, route } from '@/lib/http'
import { handleGatewayWebhook } from '@/lib/services/gateway'

// Called by the payment gateway (no user session). Authenticity comes from the
// HMAC signature over the form fields; see lib/services/gateway.ts.
export const POST = route(async (req) => {
  const outcome = await handleGatewayWebhook(await req.text())
  return json(outcome.body, outcome.status)
})
