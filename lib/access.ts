import 'server-only'

import type { Actor, Role } from '@/lib/auth'
import type { Prisma } from '@/lib/generated/prisma/client'
import { HttpError } from '@/lib/http'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value)
}

export function notFound(what = 'Not found'): HttpError {
  return new HttpError(404, what)
}

/**
 * Leases the actor may see: their org's leases, or for a tenant only their own.
 * Anything outside this scope is answered with 404 so its existence is not revealed.
 */
export function leaseScope(actor: Actor): Prisma.LeaseWhereInput {
  return actor.role === 'tenant' ? { orgId: actor.orgId, tenantId: actor.tenantId } : { orgId: actor.orgId }
}

/** 403: the caller can see the record but their role may not perform the action. */
export function requireRole(actor: Actor, ...roles: Role[]): void {
  if (!roles.includes(actor.role)) throw new HttpError(403, 'Your role does not allow this action')
}
