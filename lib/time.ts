// Date/instant conversions and Malaysia-time display. Usable on server and
// client. Formatting is done by hand (not Intl) so the server and the browser
// produce byte-identical strings: no hydration mismatches, whatever the
// viewer's timezone or ICU version.

import { isValidYmd } from '@/lib/billing'

export const MYT_OFFSET_MS = 8 * 60 * 60 * 1000

/**
 * Prisma maps a Postgres `date` to a JS Date at 00:00 UTC of that calendar day,
 * so the UTC fields are the calendar date (independent of the host TZ).
 */
export function dateToYmd(date: Date): string {
  return date.toISOString().slice(0, 10)
}

export function ymdToDate(ymd: string): Date {
  return new Date(`${ymd}T00:00:00.000Z`)
}

const INSTANT_PATTERN = /^(\d{4}-\d{2}-\d{2})T([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d)(?:\.\d{1,9})?)?(Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/

/** Parses an ISO 8601 instant that carries an explicit offset (Z or ±HH:MM). */
export function parseInstant(value: unknown): Date | null {
  if (typeof value !== 'string') return null
  const match = INSTANT_PATTERN.exec(value)
  if (!match || !isValidYmd(match[1])) return null
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? date : null
}

/** ISO 8601 in Malaysia time with an explicit offset, e.g. 2026-01-31T10:00:00.000+08:00 */
export function toMytIso(instant: Date): string {
  return new Date(instant.getTime() + MYT_OFFSET_MS).toISOString().replace('Z', '+08:00')
}

/** The `datetime-local` value (YYYY-MM-DDTHH:MM) for an instant, in Malaysia time. */
export function toMytLocalInput(instant: Date): string {
  return toMytIso(instant).slice(0, 16)
}

/** Interprets a `datetime-local` value (YYYY-MM-DDTHH:MM[:SS]) as Malaysia time. */
export function mytLocalInputToIso(value: string): string {
  return `${value.length === 16 ? `${value}:00` : value}+08:00`
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** '2026-01-31' -> '31 Jan 2026' (no timezone involved: it is a calendar date). */
export function formatYmd(ymd: string): string {
  const [y, m, d] = ymd.split('-')
  return `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`
}

/** '2026-03' -> 'Mar 2026' */
export function formatMonth(month: string): string {
  const [y, m] = month.split('-')
  return `${MONTHS[Number(m) - 1]} ${y}`
}

/** An instant shown in Malaysia time: '31 Jan 2026, 10:00 MYT'. */
export function formatMytDateTime(instant: Date | string): string {
  const iso = toMytIso(typeof instant === 'string' ? new Date(instant) : instant)
  return `${formatYmd(iso.slice(0, 10))}, ${iso.slice(11, 16)} MYT`
}
