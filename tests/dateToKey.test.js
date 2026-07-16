// Guards the invoice period anchor: an invoice belongs to the fiscal week of its
// POSTING DATE. dateToKey() maps any date → its Sun–Sat fiscal-week periodKey; a
// wrong mapping mis-anchors real COGS to the wrong week (the bug this fixed).
import { describe, it, expect } from 'vitest'
import { dateToKey } from '@/store/PeriodContext'

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
