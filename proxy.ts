import type { NextRequest } from 'next/server'

import { updateSession } from '@/lib/supabase/middleware'

export async function proxy(request: NextRequest) {
  return updateSession(request)
}

export const config = {
  // /api is excluded on purpose: API routes authenticate themselves and must
  // answer 401 JSON (or accept a Bearer token), never a login redirect.
  matcher: ['/((?!api|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)'],
}
