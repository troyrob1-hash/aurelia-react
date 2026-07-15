// Unified JE amortization engine: N calendar months from the entry period's week,
// daily-prorated, conserves to the penny, falls to 0 after the window ends.
import { describe, it, expect } from 'vitest'
import { jeContribution, weekRangeOf } from '@/lib/ledgerContributions'

function allWeekKeys(fromYear, toYear) {
  const keys = []
  for (let y = fromYear; y <= toYear; y++)
    for (let p = 1; p <= 12; p++)
      for (let w = 1; w <= 6; w++) {
        const key = `${y}-P${String(p).padStart(2, '0')}-W${w}`
        if (weekRangeOf(key)) keys.push(key)
      }
  return keys
}

function sweep(je, fromYear, toYear) {
  const rows = []
  let sum = 0, firstNZ = null, lastNZ = null
  for (const key of allWeekKeys(fromYear, toYear)) {
    const wr = weekRangeOf(key)
    const c = jeContribution(je, wr.start, wr.end)
    rows.push({ key, c })
    if (Math.abs(c) > 1e-9) { sum += c; if (!firstNZ) firstNZ = key; lastNZ = key }
  }
  return { sum, firstNZ, lastNZ, rows }
}

describe('unified JE amortization (entryPeriod + amortizeMonths)', () => {
  it('36-month equipment ($18k) conserves to the penny, then 0', () => {
    const je = { totalAmount: 18000, entryPeriod: '2026-P07-W3', amortizeMonths: 36, glCode: 'cogs_equipment', status: 'posted' }
    const { sum, firstNZ, lastNZ, rows } = sweep(je, 2025, 2030)
    expect(sum).toBeCloseTo(18000, 2)                 // conserves
    expect(firstNZ).toBe('2026-P07-W3')               // starts where posted
    // one week past the last contribution is 0 (clean cutoff, no indefinite posting)
    const idx = rows.findIndex(r => r.key === lastNZ)
    expect(rows[idx + 1].c).toBe(0)
    // nothing posts before the entry week
    expect(rows.filter(r => r.key < '2026-P07-W3' && r.c !== 0)).toHaveLength(0)
  })

  it('12-month salary ($120k) conserves to the penny', () => {
    const je = { totalAmount: 120000, entryPeriod: '2026-P07-W3', amortizeMonths: 12, glCode: 'cogs_labor_salaries', status: 'posted' }
    const { sum, firstNZ } = sweep(je, 2025, 2029)
    expect(sum).toBeCloseTo(120000, 2)
    expect(firstNZ).toBe('2026-P07-W3')
  })

  it('blank/0 months = one-time: full amount in the entry week only', () => {
    const je = { totalAmount: 5000, entryPeriod: '2026-P07-W3', amortizeMonths: 0, glCode: 'cogs_3rd_party', status: 'posted' }
    const { sum, firstNZ, lastNZ, rows } = sweep(je, 2025, 2027)
    expect(sum).toBeCloseTo(5000, 2)
    expect(firstNZ).toBe('2026-P07-W3')
    expect(lastNZ).toBe('2026-P07-W3')               // exactly one week
    expect(rows.filter(r => r.c !== 0)).toHaveLength(1)
  })

  it('boundary week is a partial split, not a full or dropped week', () => {
    const je = { totalAmount: 12000, entryPeriod: '2026-P07-W3', amortizeMonths: 12, glCode: 'cogs_labor_salaries', status: 'posted' }
    const { rows, lastNZ } = sweep(je, 2025, 2029)
    const nz = rows.filter(r => Math.abs(r.c) > 1e-9)
    const full = nz[Math.floor(nz.length / 2)].c       // a mid-window (full) week
    const last = rows.find(r => r.key === lastNZ).c     // the closing boundary week
    expect(last).toBeLessThan(full)                     // partial
    expect(last).toBeGreaterThan(0)
  })
})
