import 'server-only'

import { createClient as createSupabaseClient } from '@supabase/supabase-js'

import { HttpError } from '@/lib/http'
import { prisma } from '@/lib/prisma'
import { createClient as createCookieClient } from '@/lib/supabase/server'

export type StaffRole = 'manager' | 'staff'
export type Role = StaffRole | 'tenant'

export type Actor =
  | { userId: string; role: StaffRole; orgId: string }
  | { userId: string; role: 'tenant'; orgId: string; tenantId: string }

/**
 * The authenticated user id, verified by Supabase Auth (getUser validates the
 * token with the Auth server; getSession would trust the cookie blindly).
 * Accepts `Authorization: Bearer <access token>` (API clients, our tests) or
 * the normal session cookie (the web app).
 */
async function authenticatedUserId(req?: Request): Promise<string | null> {
  const header = req?.headers.get('authorization')
  if (header) {
    const match = /^Bearer\s+(\S+)$/i.exec(header)
    if (!match) return null
    const supabase = createSupabaseClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
      { auth: { persistSession: false, autoRefreshToken: false } },
    )
    const { data, error } = await supabase.auth.getUser(match[1])
    return error || !data.user ? null : data.user.id
  }
  const supabase = await createCookieClient()
  const { data, error } = await supabase.auth.getUser()
  return error || !data.user ? null : data.user.id
}

/**
 * Role and organization come only from our own tables (memberships, and
 * tenants.user_id for tenants), never from user-editable metadata.
 */
export async function resolveActor(userId: string): Promise<Actor | null> {
  const membership = await prisma.membership.findUnique({ where: { userId } })
  if (membership && (membership.role === 'manager' || membership.role === 'staff')) {
    return { userId, role: membership.role, orgId: membership.orgId }
  }
  const tenant = await prisma.tenant.findUnique({ where: { userId } })
  if (tenant) return { userId, role: 'tenant', orgId: tenant.orgId, tenantId: tenant.id }
  return null
}

/** 401 without a valid login; 403 for a valid login with no organization access. */
export async function requireActor(req?: Request): Promise<Actor> {
  const userId = await authenticatedUserId(req)
  if (!userId) throw new HttpError(401, 'Authentication required')
  const actor = await resolveActor(userId)
  if (!actor) throw new HttpError(403, 'Your account has no access to any organization')
  return actor
}

/** For server components: the actor, or null when signed out / no access. */
export async function getActorOrNull(): Promise<Actor | null> {
  const userId = await authenticatedUserId()
  return userId ? resolveActor(userId) : null
}
