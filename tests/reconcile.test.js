// Safety net for the reconciliation layer: the official-line rollup + the map
// invariants the Reconciliation view relies on (every line has an ordered section;
// no-source lines roll up to null so they render "no source"/"NetSuite-only", not
// a false $0 variance).
import { describe, it, expect } from 'vitest'
import { RECON_MAP, SECTION_ORDER, STATUS, rollupToOfficialLines } from '@/lib/reconMap'

describe('rollupToOfficialLines — atoms → official-line grain', () => {
  it('sums the Aurelia atom fields for a line that has sources', () => {
    // Marketing = exp_mktg_cashier + coupons + marketing + other
    const out = rollupToOfficialLines({ exp_mktg_cashier: 10, exp_mktg_coupons: 5, exp_mktg_marketing: 20, exp_mktg_other: 1 })
    expect(out['Marketing']).toBe(36)
  })
  it('returns null for a line with NO Aurelia source (official-only / EXTERNAL)', () => {
    const out = rollupToOfficialLines({})
    for (const [line, def] of Object.entries(RECON_MAP)) {
      if (def.aurelia.length === 0) expect(out[line]).toBeNull()      // → view shows "no source"/"NetSuite-only", never a phantom 0 variance
    }
  })
  it('a sourced line with no data rolls up to 0 (present but empty), not null', () => {
    const out = rollupToOfficialLines({})
    expect(out['Onsite Equipment']).toBe(0)   // cogs_equipment sourced, just unwritten this month
  })
})

describe('RECON_MAP invariants the view depends on', () => {
  it('every line belongs to a section in SECTION_ORDER', () => {
    for (const [line, def] of Object.entries(RECON_MAP)) {
      expect(SECTION_ORDER, `${line} section "${def.section}"`).toContain(def.section)
    }
  })
  it('every line has a known status', () => {
    const valid = new Set(Object.values(STATUS))
    for (const [line, def] of Object.entries(RECON_MAP)) expect(valid.has(def.status), line).toBe(true)
  })
})

describe('variance semantics (Official − Running), as the view computes them', () => {
  const reconcile = (officialActual, running, status) =>
    (status === STATUS.MAPPED && officialActual != null && running != null) ? officialActual - running : null

  it('MAPPED with both sides → Official minus Running', () => {
    expect(reconcile(1000, 940, STATUS.MAPPED)).toBe(60)   // official over running by 60
    expect(reconcile(900, 1000, STATUS.MAPPED)).toBe(-100) // running over official
  })
  it('EXTERNAL or missing side → no variance (null, not 0)', () => {
    expect(reconcile(1000, null, STATUS.EXTERNAL)).toBeNull()
    expect(reconcile(null, 500, STATUS.MAPPED)).toBeNull()
    expect(reconcile(1000, 900, STATUS.COMING)).toBeNull()  // COMING is not flagged as a discrepancy
  })
})
