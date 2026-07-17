// Money/inventory-path guard for the SOLD feed parser (Increment 1). The three
// things that must never silently break:
//   1. MONTH-BOUNDARY SPLIT — the "June 28" calendar week straddles P06/P07; a
//      Wednesday (July 1) sale must land in P07-W1, not the week-start's P06 week.
//      This is the whole reason we read weekday rows instead of the per-week Total.
//   2. SATELLITE LUMPING — AY→AZ, N→S, R→Q are a business rule; a satellite's units
//      must SUM with the parent café for the same (item, period), not land separately.
//   3. CONSERVATION — Σ(weekday cells) == Σ(Total cells) == Σ(written qtySold); no
//      unit invented or dropped.
import { describe, it, expect } from 'vitest'
import { parseCafeProductMix, resolveCafe, itemSlug, weekdayDate, ACCOUNT_TO_CAFE } from '@/lib/parseCafeProductMix'
import { dateToKey } from '@/store/PeriodContext'

// Real header shape: Site | Account Internal Name | Restaurant | Item Name | Weekday | <weeks>
const HEADER = ['Site', 'Account Internal Name', 'Restaurant', 'Item Name', 'Weekday of Event Date',
  'June 21, 2026', 'June 28, 2026']   // two week columns; June 28 straddles the P06/P07 boundary

// Helper: build a data row (nulls = fill-down blanks)
const row = (site, acct, rest, item, wd, w1, w2) => [site, acct, rest, item, wd, w1, w2]

describe('parseCafeProductMix — resolver + slug', () => {
  it('maps all 9 accounts; satellites share the parent locId', () => {
    expect(resolveCafe('Qualcomm - Boulder')).toBe('CR_QualcommBoulder')
    expect(resolveCafe('Qualcomm Santa Clara')).toBe('CR_QualcommSantaClara')
    expect(resolveCafe('Qualcomm - San Diego AZ')).toBe('Cafe_AZ')
    expect(resolveCafe('Qualcomm San Diego - AY')).toBe('Cafe_AZ')   // AY → AZ
    expect(resolveCafe('Qualcomm - San Diego - N')).toBe('Cafe_S')   // N → S
    expect(resolveCafe('Qualcomm San Diego - R')).toBe('Cafe_Q')     // R → Q
    expect(Object.keys(ACCOUNT_TO_CAFE)).toHaveLength(9)
  })
  it('unmapped account → null (surfaced, not silently bucketed)', () => {
    expect(resolveCafe('Qualcomm - Phoenix')).toBeNull()
    expect(resolveCafe('')).toBeNull()
  })
  it('itemSlug is doc-id-safe and stable', () => {
    expect(itemSlug('Monster, Energy Drink, Original, 16 fl oz')).toBe('monster-energy-drink-original-16-fl-oz')
    expect(itemSlug('  Awake — Dark Chocolate  ')).toBe('awake-dark-chocolate')
  })
  it('weekdayDate: week-start Sunday + weekday → correct real date', () => {
    // June 28, 2026 is a Sunday; Wednesday of that week = July 1, 2026.
    const d = weekdayDate('June 28, 2026', 'Wednesday')
    expect([d.getFullYear(), d.getMonth() + 1, d.getDate()]).toEqual([2026, 7, 1])
  })
})

describe('parseCafeProductMix — month-boundary split (fiscal-safe)', () => {
  // One item at Cafe Q, week-of June 28: Mon(Jun29)=P06, Tue(Jun30)=P06, Wed(Jul1)=P07, Thu(Jul2)=P07.
  const rows = [
    ['', '', '', '', 'Week of Event Date', '', ''],
    HEADER,
    row('CR_QualcommSanDiego', 'Qualcomm - San Diego - Q', '11 Dining LLC - Cafeteria', 'Test Bar', 'Total', null, 10),
    row(null, null, null, null, 'Monday',    null, 2),   // Jun 29 → P06
    row(null, null, null, null, 'Tuesday',   null, 3),   // Jun 30 → P06
    row(null, null, null, null, 'Wednesday', null, 4),   // Jul 1  → P07
    row(null, null, null, null, 'Thursday',  null, 1),   // Jul 2  → P07
  ]
  const { items, checksumTotal, weekdaySum } = parseCafeProductMix(rows, { dateToKey })

  it('splits the straddling week into two fiscal periodKeys', () => {
    const p06 = items.find((r) => r.periodKey.startsWith('2026-P06'))
    const p07 = items.find((r) => r.periodKey.startsWith('2026-P07'))
    expect(p06).toBeTruthy(); expect(p07).toBeTruthy()
    expect(p06.qtySold).toBe(5)   // Mon+Tue = Jun 29+30
    expect(p07.qtySold).toBe(5)   // Wed+Thu = Jul 1+2
    expect(p06.locId).toBe('Cafe_Q'); expect(p07.locId).toBe('Cafe_Q')
  })
  it('conserves units: weekdaySum == Total checksum == Σ written', () => {
    expect(weekdaySum).toBe(10)
    expect(checksumTotal).toBe(10)
    expect(items.reduce((s, r) => s + r.qtySold, 0)).toBe(10)
  })
})

describe('parseCafeProductMix — satellite lumping (AY → AZ)', () => {
  // Same item, same week, AZ and its AY satellite → must sum into ONE Cafe_AZ record.
  const rows = [
    ['', '', '', '', 'Week of Event Date', '', ''],
    HEADER,
    row('CR_QualcommSanDiego', 'Qualcomm - San Diego AZ', '11 Dining LLC - Cafeteria', 'Shared Item', 'Total', 6, null),
    row(null, null, null, null, 'Monday', 6, null),        // Jun 22 → P06 (AZ)
    row('CR_QualcommSanDiego', 'Qualcomm San Diego - AY', '11 Dining LLC - Cafeteria', 'Shared Item', 'Total', 4, null),
    row(null, null, null, null, 'Monday', 4, null),        // Jun 22 → P06 (AY, lumps into AZ)
  ]
  const { items } = parseCafeProductMix(rows, { dateToKey })

  it('AY units sum with AZ into a single Cafe_AZ record', () => {
    const az = items.filter((r) => r.locId === 'Cafe_AZ')
    expect(az).toHaveLength(1)              // not two separate docs
    expect(az[0].qtySold).toBe(10)          // 6 (AZ) + 4 (AY)
    expect(az[0].itemSlug).toBe('shared-item')
  })
})

describe('parseCafeProductMix — unmapped account surfaced', () => {
  const rows = [
    ['', '', '', '', 'Week of Event Date', '', ''],
    HEADER,
    row('CR_QualcommMars', 'Qualcomm - Mars Base', '11 Dining LLC - Cafeteria', 'Space Bar', 'Total', 9, null),
    row(null, null, null, null, 'Monday', 9, null),
  ]
  const { items, unmappedAccounts } = parseCafeProductMix(rows, { dateToKey })
  it('routes an unknown account to unmappedAccounts, not into items', () => {
    expect(items).toHaveLength(0)
    expect(unmappedAccounts).toEqual([{ account: 'Qualcomm - Mars Base', qty: 9 }])
  })
})
