// Guards the invoice period anchor: an invoice belongs to the fiscal week of its
// POSTING DATE. dateToKey() maps any date → its Sun–Sat fiscal-week periodKey; a
// wrong mapping mis-anchors real COGS to the wrong week (the bug this fixed).
import { describe, it, expect } from 'vitest'
import { dateToKey, isShortWeek, getPeriodWeeks } from '@/store/PeriodContext'

describe('dateToKey — date → fiscal-week periodKey', () => {
  it('maps the real mis-anchored cases to their correct July weeks', () => {
    expect(dateToKey('2026-07-07')).toBe('2026-P07-W2')   // was mis-stamped P06-W5
    expect(dateToKey('2026-07-08')).toBe('2026-P07-W2')
    expect(dateToKey('2026-07-15')).toBe('2026-P07-W3')
    expect(dateToKey('2026-07-02')).toBe('2026-P07-W1')
  })

  it('a June-30 invoice belongs to June, never July (week never crosses a month)', () => {
    expect(dateToKey('2026-06-30')).toBe('2026-P06-W5')
    expect(dateToKey('2026-06-01')).toBe('2026-P06-W1')
  })

  it('accepts a Date object, not just a string', () => {
    expect(dateToKey(new Date(2026, 6, 7))).toBe('2026-P07-W2')  // month is 0-based → July
  })

  it('returns null for missing/unparseable dates (caller falls back + flags)', () => {
    expect(dateToKey('')).toBeNull()
    expect(dateToKey(null)).toBeNull()
    expect(dateToKey(undefined)).toBeNull()
    expect(dateToKey('not-a-date')).toBeNull()
  })

  it('first and last day of a month resolve within that month', () => {
    expect(dateToKey('2026-06-01')).toMatch(/^2026-P06-W\d+$/)
    expect(dateToKey('2026-06-30')).toMatch(/^2026-P06-W\d+$/)
    expect(dateToKey('2026-07-01')).toMatch(/^2026-P07-W\d+$/)
    expect(dateToKey('2026-07-31')).toMatch(/^2026-P07-W\d+$/)
  })
})

// isShortWeek — gates the inventory "Roll over inventory" button (only shows on a stub
// week). Same <7-day threshold getWeekLabel already uses for its "(Nd)" suffix.
describe('isShortWeek — short/stub week predicate', () => {
  it('a 7-day (full Sun–Sat) week is NOT short', () => {
    const week = { start: new Date(2026, 6, 5), end: new Date(2026, 6, 11) }  // Jul 5–11, 7 days
    expect(isShortWeek(week, 2)).toBe(false)
  })

  it('a 1-day stub week IS short', () => {
    const week = { start: new Date(2026, 6, 1), end: new Date(2026, 6, 1) }  // 1 day
    expect(isShortWeek(week, 1)).toBe(true)
  })

  it('week === 0 (the MONTHLY aggregate view) is never short, regardless of span', () => {
    const week = { start: new Date(2026, 6, 1), end: new Date(2026, 6, 1) }  // would be short if a real week
    expect(isShortWeek(week, 0)).toBe(false)
  })

  it('missing/undefined week object is never short (fails closed — no button on bad data)', () => {
    expect(isShortWeek(undefined, 1)).toBe(false)
    expect(isShortWeek({}, 1)).toBe(false)
  })

  it('against the real July 2026 calendar (5 weeks, per CLAUDE.md): W1 (4d) and W5 (6d) are short, W2–W4 (7d) are not', () => {
    const weeks = getPeriodWeeks(2026, 7)
    expect(weeks.length).toBe(5)
    expect(isShortWeek(weeks[0], 1)).toBe(true)    // Jul 1–4 (Wed–Sat)
    expect(isShortWeek(weeks[1], 2)).toBe(false)   // Jul 5–11, full week
    expect(isShortWeek(weeks[3], 4)).toBe(false)   // Jul 19–25, full week
    expect(isShortWeek(weeks[4], 5)).toBe(true)    // Jul 26–31 (Sun–Fri), 6 days
  })
})
