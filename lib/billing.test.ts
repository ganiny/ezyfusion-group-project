import { describe, expect, it } from 'vitest'

import {
  generateSchedule,
  invoiceStatus,
  mytMonth,
  mytToday,
  parseRinggitToSen,
  planAllocation,
  type AllocatableInvoice,
} from './billing'

const rent = (s: ReturnType<typeof generateSchedule>) => s.filter((i) => i.kind === 'rent')

describe(`generateSchedule (TZ=${process.env.TZ ?? 'unset'})`, () => {
  it("matches the brief's worked example (Aisyah)", () => {
    const schedule = generateSchedule({
      startDate: '2026-01-31',
      endDate: '2026-07-15',
      monthlyRentSen: 150000,
      depositSen: 300000,
    })
    expect(schedule).toEqual([
      { kind: 'deposit', periodIndex: null, periodStart: null, periodEnd: null, dueDate: '2026-01-31', amountSen: 300000 },
      { kind: 'rent', periodIndex: 0, periodStart: '2026-01-31', periodEnd: '2026-02-27', dueDate: '2026-01-31', amountSen: 150000 },
      { kind: 'rent', periodIndex: 1, periodStart: '2026-02-28', periodEnd: '2026-03-30', dueDate: '2026-02-28', amountSen: 150000 },
      { kind: 'rent', periodIndex: 2, periodStart: '2026-03-31', periodEnd: '2026-04-29', dueDate: '2026-03-31', amountSen: 150000 },
      { kind: 'rent', periodIndex: 3, periodStart: '2026-04-30', periodEnd: '2026-05-30', dueDate: '2026-04-30', amountSen: 150000 },
      { kind: 'rent', periodIndex: 4, periodStart: '2026-05-31', periodEnd: '2026-06-29', dueDate: '2026-05-31', amountSen: 150000 },
      { kind: 'rent', periodIndex: 5, periodStart: '2026-06-30', periodEnd: '2026-07-15', dueDate: '2026-06-30', amountSen: 77419 },
    ])
  })

  it('rounds half up on the last period (Ben: 100029 x 15/30 = 50014.5)', () => {
    const schedule = generateSchedule({ startDate: '2026-01-01', endDate: '2026-04-15', monthlyRentSen: 100029, depositSen: 0 })
    expect(schedule.map((i) => i.kind)).toEqual(['rent', 'rent', 'rent', 'rent'])
    expect(schedule.map((i) => i.amountSen)).toEqual([100029, 100029, 100029, 50015])
    expect(schedule[3]).toMatchObject({ periodStart: '2026-04-01', periodEnd: '2026-04-15', dueDate: '2026-04-01' })
  })

  it('charges a full month when the lease ends the day before an anchor', () => {
    const probe = generateSchedule({ startDate: '2026-02-28', endDate: '2027-02-27', monthlyRentSen: 200000, depositSen: 400000 })
    expect(rent(probe)).toHaveLength(12)
    expect(rent(probe).every((i) => i.amountSen === 200000)).toBe(true)
    expect(probe.at(-1)).toMatchObject({ periodStart: '2027-01-28', periodEnd: '2027-02-27' })

    const chen = generateSchedule({ startDate: '2026-03-15', endDate: '2027-03-14', monthlyRentSen: 220000, depositSen: 440000 })
    expect(rent(chen)).toHaveLength(12)
    expect(chen.at(-1)).toMatchObject({ periodStart: '2027-02-15', periodEnd: '2027-03-14', amountSen: 220000 })
  })

  it('anchors from the start date, clamping to month end, including leap years', () => {
    const anchors = (startDate: string, endDate: string) =>
      rent(generateSchedule({ startDate, endDate, monthlyRentSen: 1000, depositSen: 0 })).map((i) => i.dueDate)
    expect(anchors('2026-01-31', '2026-05-31')).toEqual(['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30', '2026-05-31'])
    expect(anchors('2028-01-31', '2028-03-31')).toEqual(['2028-01-31', '2028-02-29', '2028-03-31'])
    expect(anchors('2028-02-29', '2029-03-01')).toContain('2029-02-28')
    expect(anchors('2026-11-30', '2027-03-01')).toEqual(['2026-11-30', '2026-12-30', '2027-01-30', '2027-02-28'])
  })

  it('creates a period for an anchor equal to the end date (one-day last period)', () => {
    const schedule = generateSchedule({ startDate: '2026-01-01', endDate: '2026-02-01', monthlyRentSen: 28000, depositSen: 0 })
    expect(schedule).toHaveLength(2)
    expect(schedule[1]).toMatchObject({ periodStart: '2026-02-01', periodEnd: '2026-02-01', amountSen: 1000 })
  })

  it('handles a one-day lease and tiny prorations', () => {
    expect(generateSchedule({ startDate: '2026-03-10', endDate: '2026-03-10', monthlyRentSen: 31000, depositSen: 0 })).toEqual([
      { kind: 'rent', periodIndex: 0, periodStart: '2026-03-10', periodEnd: '2026-03-10', dueDate: '2026-03-10', amountSen: 1000 },
    ])
    // 1 sen x 1/31 = 0.03 -> 0 sen
    expect(generateSchedule({ startDate: '2026-03-10', endDate: '2026-03-10', monthlyRentSen: 1, depositSen: 0 })[0].amountSen).toBe(0)
    // 1 sen x 16/31 = 0.516 -> 1 sen
    expect(generateSchedule({ startDate: '2026-06-30', endDate: '2026-07-15', monthlyRentSen: 1, depositSen: 0 })[0].amountSen).toBe(1)
  })

  it('omits the deposit when it is zero and puts it first otherwise', () => {
    expect(generateSchedule({ startDate: '2026-01-01', endDate: '2026-01-31', monthlyRentSen: 100, depositSen: 0 })).toHaveLength(1)
    const withDeposit = generateSchedule({ startDate: '2026-01-15', endDate: '2026-02-14', monthlyRentSen: 100, depositSen: 5 })
    expect(withDeposit[0]).toEqual({ kind: 'deposit', periodIndex: null, periodStart: null, periodEnd: null, dueDate: '2026-01-15', amountSen: 5 })
  })

  it.each([
    ['2026-02-30', '2026-03-30'],
    ['2026-02-29', '2026-03-30'],
    ['2100-02-29', '2100-03-30'],
    ['2026-2-01', '2026-03-30'],
    ['2026-13-01', '2027-03-30'],
    ['2026-00-10', '2026-03-30'],
    ['20260101', '2026-03-30'],
    [' 2026-01-01', '2026-03-30'],
    ['2026-01-01T00:00:00Z', '2026-03-30'],
    ['0000-01-01', '2026-03-30'],
    ['2026-01-01', ''],
  ])('rejects invalid dates %s / %s', (startDate, endDate) => {
    expect(() => generateSchedule({ startDate, endDate, monthlyRentSen: 100, depositSen: 0 })).toThrow()
  })

  it('accepts real leap days', () => {
    expect(() => generateSchedule({ startDate: '2000-02-29', endDate: '2000-03-01', monthlyRentSen: 100, depositSen: 0 })).not.toThrow()
    expect(() => generateSchedule({ startDate: '2028-02-29', endDate: '2028-03-01', monthlyRentSen: 100, depositSen: 0 })).not.toThrow()
  })

  it('rejects endDate before startDate', () => {
    expect(() => generateSchedule({ startDate: '2026-03-02', endDate: '2026-03-01', monthlyRentSen: 100, depositSen: 0 })).toThrow()
  })

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53])('rejects monthlyRentSen %s', (monthlyRentSen) => {
    expect(() => generateSchedule({ startDate: '2026-01-01', endDate: '2026-02-01', monthlyRentSen, depositSen: 0 })).toThrow()
  })

  it.each([-1, 0.5, Number.NaN])('rejects depositSen %s', (depositSen) => {
    expect(() => generateSchedule({ startDate: '2026-01-01', endDate: '2026-02-01', monthlyRentSen: 100, depositSen })).toThrow()
  })
})

describe(`invoiceStatus (TZ=${process.env.TZ ?? 'unset'})`, () => {
  const due = { dueDate: '2026-03-01', amountSen: 1000 }

  it('becomes overdue exactly at 00:00 Malaysia time the day after the due date', () => {
    expect(invoiceStatus({ ...due, paidSen: 0 }, new Date('2026-03-01T15:59:59.999Z'))).toBe('unpaid')
    expect(invoiceStatus({ ...due, paidSen: 0 }, new Date('2026-03-01T16:00:00.000Z'))).toBe('overdue')
    expect(invoiceStatus({ ...due, paidSen: 0 }, new Date('2026-02-28T16:00:00.000Z'))).toBe('unpaid') // 03-01 00:00 MYT
  })

  it('applies the rules in order', () => {
    const late = new Date('2026-04-01T00:00:00Z')
    expect(invoiceStatus({ ...due, paidSen: 1000 }, late)).toBe('paid')
    expect(invoiceStatus({ ...due, paidSen: 1500 }, late)).toBe('paid')
    expect(invoiceStatus({ ...due, paidSen: 999 }, late)).toBe('overdue')
    const early = new Date('2026-02-01T00:00:00Z')
    expect(invoiceStatus({ ...due, paidSen: 1 }, early)).toBe('partially_paid')
    expect(invoiceStatus({ ...due, paidSen: 0 }, early)).toBe('unpaid')
    expect(invoiceStatus({ dueDate: '2026-03-01', amountSen: 0, paidSen: 0 }, late)).toBe('paid')
  })

  it('derives Malaysia dates and months from the instant only', () => {
    expect(mytToday(new Date('2026-03-01T15:59:59Z'))).toBe('2026-03-01')
    expect(mytToday(new Date('2026-03-01T16:00:00Z'))).toBe('2026-03-02')
    expect(mytMonth(new Date('2026-02-28T16:30:00Z'))).toBe('2026-03') // 2026-03-01 00:30 MYT
  })
})

describe('parseRinggitToSen', () => {
  it.each([
    ['1,500.50', 150050],
    ['1.15', 115],
    ['7', 700],
    ['  7  ', 700],
    ['1.5', 150],
    ['0.01', 1],
    ['1,000,000', 100000000],
    ['1500', 150000],
    ['0', 0],
    ['1,500', 150000],
  ])('parses %j as %i sen', (input, sen) => {
    expect(parseRinggitToSen(input)).toBe(sen)
  })

  it.each(['', '   ', '-5', '1.234', '1e3', 'RM 10', '1,23', '1,2345', ',500', '1.', '.5', '+5', '1 000', '1,000.5.0', '١٢', '12,34,567', 'NaN', '99999999999999999999'])(
    'rejects %j',
    (input) => {
      expect(() => parseRinggitToSen(input)).toThrow()
    },
  )
})

describe('planAllocation', () => {
  const inv = (id: string, kind: 'deposit' | 'rent', periodIndex: number | null, dueDate: string, amountSen: number, paidSen = 0): AllocatableInvoice => ({
    id,
    kind,
    periodIndex,
    dueDate,
    amountSen,
    paidSen,
  })

  it('fills by due date, deposit before rent, then period index; leftovers are unapplied', () => {
    const invoices = [inv('r1', 'rent', 1, '2026-02-28', 1500), inv('r0', 'rent', 0, '2026-01-31', 1500), inv('dep', 'deposit', null, '2026-01-31', 3000)]
    expect(planAllocation(invoices, 5000)).toEqual({
      allocations: [
        { invoiceId: 'dep', amountSen: 3000 },
        { invoiceId: 'r0', amountSen: 1500 },
        { invoiceId: 'r1', amountSen: 500 },
      ],
      unappliedSen: 0,
    })
    expect(planAllocation(invoices, 7000).unappliedSen).toBe(1000)
  })

  it('skips invoices that are already fully paid and tops up partial ones', () => {
    const invoices = [inv('a', 'rent', 0, '2026-01-01', 1000, 1000), inv('b', 'rent', 1, '2026-02-01', 1000, 400)]
    expect(planAllocation(invoices, 800)).toEqual({ allocations: [{ invoiceId: 'b', amountSen: 600 }], unappliedSen: 200 })
  })
})
