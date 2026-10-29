import 'server-only'

import { createClient } from '@supabase/supabase-js'

// Service-role client. Bypasses RLS and Storage policies, so it is only used
// for operations the server has already authorized (slip cleanup, signed URLs).
// `server-only` makes any client-side import a build error.
export function createAdminClient() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SECRET_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
}
