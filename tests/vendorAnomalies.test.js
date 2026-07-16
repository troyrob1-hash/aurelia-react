// Guards the Purchasing Summary vendor-anomaly detector: the confidence guard (never a
// confident flag on no history), the baseline (median over PRIOR periods, excl. current),
// and dedupe-awareness (a duplicate invoice doc counts once). A false alarm trains users
// to ignore flags; a silent miss on real history is the whole point of the feature.
import { describe, it, expect } from 'vitest'
import { computeVendorAnomalies } from '@/routes/Purchasing'

// Build a multi-period invoice set: 3 prior periods (W1–W3) + the current period (W4).
function buildInvoices() {
  const inv = []
  const mk = (periodKey, vendor, invoiceNum, amount = 100) =>
    ({ periodKey, vendor, invoiceNum, amount, status: 'Pending', createdAt: { seconds: 1 } })
  for (const pk of ['2026-P01-W1', '2026-P01-W2', '2026-P01-W3']) {
    for (let n = 0; n < 14; n++) inv.push(mk(pk, 'Sysco', `SY-${pk}-${n}`))   // ~14/period
    for (let n = 0; n < 3; n++)  inv.push(mk(pk, 'Amazon', `AZ-${pk}-${n}`))   // ~3/period
    inv.push(mk(pk, 'Vistar', `VI-${pk}`))                                     // ~1/period
  }
  inv.push(mk('2026-P01-W3', 'SoftCo', 'SC-1'))                                // only 1 prior period
  // current period W4
  for (let n = 0; n < 4; n++) inv.push(mk('2026-P01-W4', 'Sysco', `SY-W4-${n}`))   // 4 vs ~14
  for (let n = 0; n < 3; n++) inv.push(mk('2026-P01-W4', 'Amazon', `AZ-W4-${n}`))  // 3 vs ~3
  inv.push(mk('2026-P01-W4', 'NewCo', 'NC-1'))                                     // 0 history
  for (const n of ['2', '3', '4']) inv.push(mk('2026-P01-W4', 'SoftCo', `SC-${n}`)) // 3 vs 1
  inv.push(mk('2026-P01-W4', 'Sysco', 'SY-W4-0'))   // DUPLICATE of SY-W4-0 → dedupe
  // Vistar is ABSENT in W4
  return inv
}

describe('computeVendorAnomalies', () => {
  const anoms = computeVendorAnomalies(buildInvoices(), '2026-P01-W4')
  const v = (name) => anoms.find(a => a.vendor === name)

  it('Sysco: 4 vs baseline 14, history 3 → real · below (missing-invoice flag fires)', () => {
    expect(v('Sysco').currentCount).toBe(4)
    expect(v('Sysco').baselineCount).toBe(14)
    expect(v('Sysco').historyDepth).toBe(3)
    expect(v('Sysco').tier).toBe('real')
    expect(v('Sysco').kind).toBe('below')
  })

  it('a duplicate Sysco invoice is deduped → count 4, not 5', () => {
    expect(v('Sysco').currentCount).toBe(4)   // SY-W4-0 appears twice, counted once
  })

  it('Amazon: 3 vs 3, history 3 → real · normal (no false flag)', () => {
    expect(v('Amazon').tier).toBe('real')
    expect(v('Amazon').kind).toBeNull()
  })

  it('NewCo: history 0 → new · building baseline, NO confident flag', () => {
    expect(v('NewCo').historyDepth).toBe(0)
    expect(v('NewCo').tier).toBe('new')
    expect(v('NewCo').kind).toBe('building')   // never a real anomaly on no history
  })

  it('SoftCo: history 1 → soft (tentative)', () => {
    expect(v('SoftCo').historyDepth).toBe(1)
    expect(v('SoftCo').tier).toBe('soft')
  })

  it('Vistar: 0 this period, appeared before, history 3 → real · absent', () => {
    expect(v('Vistar').currentCount).toBe(0)
    expect(v('Vistar').historyDepth).toBe(3)
    expect(v('Vistar').tier).toBe('real')
    expect(v('Vistar').kind).toBe('absent')
  })

  it('baseline EXCLUDES the current period (Sysco base = 14 from prior only, not diluted by this period’s 4)', () => {
    expect(v('Sysco').baselineCount).toBe(14)   // if current leaked in, the median would drop
  })
})
