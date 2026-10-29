// Pure billing rules (brief section 3). No I/O, no framework imports, and no
// dependence on the host timezone: calendar dates are {y, m, d} integers
// converted to day numbers with a closed-form civil-calendar formula, and
// "today in Malaysia" is derived from the epoch milliseconds of `now` alone.

export type InvoiceKind = 'deposit' | 'rent'

export interface ScheduledInvoice {
  kind: InvoiceKind
  periodIndex: number | null // 0, 1, 2... for rent; null for the deposit
  periodStart: string | null // 'YYYY-MM-DD'; null for the deposit
  periodEnd: string | null // 'YYYY-MM-DD', inclusive; null for the deposit
  dueDate: string // 'YYYY-MM-DD'
  amountSen: number // integer
}

export type InvoiceStatus = 'paid' | 'partially_paid' | 'unpaid' | 'overdue'

const DAY_MS = 86_400_000
// Asia/Kuala_Lumpur is UTC+8 with no daylight saving, so a fixed offset is exact.
const MYT_OFFSET_MS = 8 * 60 * 60 * 1000

interface Ymd {
  y: number
  m: number // 1-12
  d: number
}

// ---------------------------------------------------------------------------
// Calendar helpers
// ---------------------------------------------------------------------------

function isLeapYear(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0
}

function daysInMonth(y: number, m: number): number {
  if (m === 2) return isLeapYear(y) ? 29 : 28
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31
}

const YMD_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/

function parseYmd(value: string): Ymd {
  const match = typeof value === 'string' ? YMD_PATTERN.exec(value) : null
  if (!match) throw new Error(`Invalid date "${String(value)}": expected YYYY-MM-DD`)
  const y = Number(match[1])
  const m = Number(match[2])
  const d = Number(match[3])
  if (y < 1 || m < 1 || m > 12 || d < 1 || d > daysInMonth(y, m)) {
    throw new Error(`Invalid date "${value}": not a real calendar date`)
  }
  return { y, m, d }
}

/** True if `value` is a real calendar date written as YYYY-MM-DD. */
export function isValidYmd(value: string): boolean {
  try {
    parseYmd(value)
    return true
  } catch {
    return false
  }
}

// Days since 1970-01-01 for a proleptic Gregorian date (H. Hinnant's
// days_from_civil). Pure integer arithmetic: no Date, no timezone.
function toDayNumber({ y, m, d }: Ymd): number {
  const yy = m <= 2 ? y - 1 : y
  const era = Math.floor(yy / 400)
  const yoe = yy - era * 400
  const mp = (m + 9) % 12
  const doy = Math.floor((153 * mp + 2) / 5) + d - 1
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy
  return era * 146097 + doe - 719468
}

function fromDayNumber(dayNumber: number): Ymd {
  const z = dayNumber + 719468
  const era = Math.floor(z / 146097)
  const doe = z - era * 146097
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365)
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100))
  const mp = Math.floor((5 * doy + 2) / 153)
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1
  const m = mp < 10 ? mp + 3 : mp - 9
  return { y: m <= 2 ? yoe + era * 400 + 1 : yoe + era * 400, m, d }
}

function formatYmd({ y, m, d }: Ymd): string {
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

function formatDayNumber(dayNumber: number): string {
  return formatYmd(fromDayNumber(dayNumber))
}

// Start date plus k calendar months, always counted from the start date and
// clamped to the target month's last day (Jan 31 + 1 month = Feb 28/29).
function addMonthsClamped(start: Ymd, k: number): Ymd {
  const monthIndex = start.m - 1 + k
  const y = start.y + Math.floor(monthIndex / 12)
  const m = (((monthIndex % 12) + 12) % 12) + 1
  return { y, m, d: Math.min(start.d, daysInMonth(y, m)) }
}

/** Malaysia calendar day number (days since 1970-01-01) of an instant. */
function mytDayNumber(now: Date): number {
  const ms = now instanceof Date ? now.getTime() : Number.NaN
  if (!Number.isFinite(ms)) throw new Error('Invalid instant')
  return Math.floor((ms + MYT_OFFSET_MS) / DAY_MS)
}

/** Today's date in Malaysia (YYYY-MM-DD) at instant `now`, whatever the host TZ. */
export function mytToday(now: Date): string {
  return formatDayNumber(mytDayNumber(now))
}

/** Malaysia calendar month (YYYY-MM) containing instant `at`. */
export function mytMonth(at: Date): string {
  return mytToday(at).slice(0, 7)
}

// ---------------------------------------------------------------------------
// Schedule
// ---------------------------------------------------------------------------

// monthlyRent x used / full, rounded half up. BigInt keeps the product exact;
// all operands are positive, so floor((2n + d) / 2d) is round-half-up.
function prorate(monthlyRentSen: number, usedDays: number, fullDays: number): number {
  const numerator = BigInt(monthlyRentSen) * BigInt(usedDays)
  const denominator = BigInt(fullDays)
  return Number((2n * numerator + denominator) / (2n * denominator))
}

export function generateSchedule(lease: {
  startDate: string
  endDate: string
  monthlyRentSen: number
  depositSen: number
}): ScheduledInvoice[] {
  const start = parseYmd(lease.startDate)
  const end = parseYmd(lease.endDate)
  const startDay = toDayNumber(start)
  const endDay = toDayNumber(end)
  if (endDay < startDay) throw new Error('endDate is before startDate')
  if (!Number.isSafeInteger(lease.monthlyRentSen) || lease.monthlyRentSen <= 0) {
    throw new Error('monthlyRentSen must be a positive integer')
  }
  if (!Number.isSafeInteger(lease.depositSen) || lease.depositSen < 0) {
    throw new Error('depositSen must be a non-negative integer')
  }

  const schedule: ScheduledInvoice[] = []
  if (lease.depositSen > 0) {
    schedule.push({
      kind: 'deposit',
      periodIndex: null,
      periodStart: null,
      periodEnd: null,
      dueDate: formatYmd(start),
      amountSen: lease.depositSen,
    })
  }

  for (let k = 0; ; k++) {
    const anchorDay = toDayNumber(addMonthsClamped(start, k))
    if (anchorDay > endDay) break
    const fullEndDay = toDayNumber(addMonthsClamped(start, k + 1)) - 1
    const periodEndDay = Math.min(fullEndDay, endDay)
    const amountSen =
      periodEndDay === fullEndDay
        ? lease.monthlyRentSen
        : prorate(lease.monthlyRentSen, periodEndDay - anchorDay + 1, fullEndDay - anchorDay + 1)
    schedule.push({
      kind: 'rent',
      periodIndex: k,
      periodStart: formatDayNumber(anchorDay),
      periodEnd: formatDayNumber(periodEndDay),
      dueDate: formatDayNumber(anchorDay),
      amountSen,
    })
  }
  return schedule
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

export function invoiceStatus(
  invoice: { dueDate: string; amountSen: number; paidSen: number },
  now: Date,
): InvoiceStatus {
  if (invoice.paidSen >= invoice.amountSen) return 'paid'
  // Overdue from 00:00 Malaysia time on the day after the due date.
  if (mytDayNumber(now) > toDayNumber(parseYmd(invoice.dueDate))) return 'overdue'
  if (invoice.paidSen > 0) return 'partially_paid'
  return 'unpaid'
}

// ---------------------------------------------------------------------------
// Money input
// ---------------------------------------------------------------------------

// Whole part: either comma-grouped (1-3 digits, then groups of exactly 3) or
// plain digits. Optional 1-2 decimal digits. Nothing else (no sign, no exponent).
const RINGGIT_PATTERN = /^(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?$/

export function parseRinggitToSen(input: string): number {
  const match = typeof input === 'string' ? RINGGIT_PATTERN.exec(input.trim()) : null
  if (!match) throw new Error(`Invalid ringgit amount "${String(input)}"`)
  const whole = BigInt(match[1].replaceAll(',', ''))
  const fraction = BigInt((match[2] ?? '').padEnd(2, '0'))
  const sen = whole * 100n + fraction
  if (sen > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Amount is too large')
  return Number(sen)
}

// ---------------------------------------------------------------------------
// Allocation (brief section 4): pure planning, applied by lib/services.
// ---------------------------------------------------------------------------

export interface AllocatableInvoice {
  id: string
  kind: InvoiceKind
  periodIndex: number | null
  dueDate: string
  amountSen: number
  paidSen: number
}

/** Allocation order: due date, then deposit before rent, then period index. */
export function compareAllocationOrder(
  a: Pick<AllocatableInvoice, 'kind' | 'periodIndex' | 'dueDate'>,
  b: Pick<AllocatableInvoice, 'kind' | 'periodIndex' | 'dueDate'>,
): number {
  if (a.dueDate !== b.dueDate) return a.dueDate < b.dueDate ? -1 : 1
  if (a.kind !== b.kind) return a.kind === 'deposit' ? -1 : 1
  return (a.periodIndex ?? -1) - (b.periodIndex ?? -1)
}

/** Fills invoices in allocation order up to their unpaid amount; the rest is unapplied. */
export function planAllocation(
  invoices: AllocatableInvoice[],
  amountSen: number,
): { allocations: { invoiceId: string; amountSen: number }[]; unappliedSen: number } {
  let remaining = amountSen
  const allocations: { invoiceId: string; amountSen: number }[] = []
  for (const invoice of [...invoices].sort(compareAllocationOrder)) {
    if (remaining <= 0) break
    const unpaid = invoice.amountSen - invoice.paidSen
    if (unpaid <= 0) continue
    const take = Math.min(unpaid, remaining)
    allocations.push({ invoiceId: invoice.id, amountSen: take })
    remaining -= take
  }
  return { allocations, unappliedSen: remaining }
}
