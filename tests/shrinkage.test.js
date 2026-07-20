// Guard for the shrinkage variance calc (Increment 4). The formula
//   shrinkage = opening + purchased − sold − closing ;  $lost = shrinkage × unitCost
// and the HONESTY rule (missing feed → null cell + incomplete flag, never a fake zero).
import { describe, it, expect } from 'vitest'
import { computeShrinkageRow, computeShrinkageRows, shrinkageKpis, countEaches, isCounted } from '@/lib/shrinkage'

// A fully-fed canonical: Kit Kat, catalogItemId 'kk'. Opening 40, bought 24, sold 50,
// closing 10 → shrinkage = 40 + 24 − 50 − 10 = 4 units × $1.33 = $5.32.
const KITKAT = { canonicalId: 'kit-kat', canonicalName: 'Kit Kat 1.5oz', catalogItemId: 'kk', soldAliases: ['Mars, Candy, Kit Kat, 1.5 oz'] }
const fullFeeds = {
  hasSoldFeed: true,
  openingByCat: { kk: 40 }, closingByCat: { kk: 10 },   // kk PRESENT in both counts → real numbers
  purchasedByCanonical: { 'kit-kat': 24 }, soldByCanonical: { 'kit-kat': 50 },
  unitCostByCat: { kk: 1.33 },
}

describe('countEaches — inventory count → total eaches (qty×qtyPerPack + eaches)', () => {
  it('eaches-only (retail): 0 packs × 50 + 24 eaches = 24', () => {
    expect(countEaches({ qty: 0, eaches: 24, qtyPerPack: 50 })).toBe(24)
  })
  it('pack-only: 6 packs × 12 + 0 = 72', () => {
    expect(countEaches({ qty: 6, eaches: 0, qtyPerPack: 12 })).toBe(72)
  })
  it('mixed packs + loose eaches: 6 × 12 + 10 = 82', () => {
    expect(countEaches({ qty: 6, eaches: 10, qtyPerPack: 12 })).toBe(82)
  })
  it('missing qtyPerPack defaults to 1 (single-unit item)', () => {
    expect(countEaches({ qty: 3, eaches: 2 })).toBe(5)          // 3×1 + 2
    expect(countEaches({ qty: 11, eaches: 0, qtyPerPack: 1 })).toBe(11)
  })
  it('null qty with eaches (the exact bug) counts the eaches, not 0', () => {
    expect(countEaches({ qty: null, eaches: 66, qtyPerPack: 36 })).toBe(66)
  })
})

describe('isCounted — blank-count guard (present ≠ counted)', () => {
  it('qty or eaches an entered number (incl. 0) → counted', () => {
    expect(isCounted({ qty: 0, eaches: null })).toBe(true)      // counted 0 packs
    expect(isCounted({ qty: null, eaches: 0 })).toBe(true)      // counted 0 eaches
    expect(isCounted({ qty: 6, eaches: 10 })).toBe(true)
  })
  it('BOTH blank (null/undefined/empty) → NOT counted (present but blank)', () => {
    expect(isCounted({ qty: null, eaches: null })).toBe(false)
    expect(isCounted({ qty: undefined, eaches: undefined })).toBe(false)
    expect(isCounted({ qty: '', eaches: '' })).toBe(false)
    expect(isCounted({ qtyPerPack: 20 })).toBe(false)           // qtyPerPack present but no count
  })
})

describe('countEaches + isCounted → feeds (the ShrinkageTable read, honesty preserved)', () => {
  // Simulate building openingByCat/closingByCat the way ShrinkageTable does.
  const buildMap = (items) => {
    const m = {}
    items.forEach((i) => { if (i.id != null && isCounted(i)) m[i.id] = countEaches(i) })
    return m
  }
  it('blank line is omitted (→ null/incomplete); real lines land in eaches', () => {
    const m = buildMap([
      { id: 'a', qty: 0, eaches: 24, qtyPerPack: 50 },   // 24
      { id: 'b', qty: null, eaches: null },              // blank → omitted
      { id: 'c', qty: 0, eaches: 0, qtyPerPack: 24 },    // counted 0 → real 0 key
    ])
    expect(m).toEqual({ a: 24, c: 0 })
    expect('b' in m).toBe(false)                         // not counted → absent → row incomplete
    expect('c' in m).toBe(true)                          // counted-0 present → real 0
  })
})

describe('computeShrinkageRow — the real formula', () => {
  it('computes a full row: opening + purchased − sold − closing', () => {
    const r = computeShrinkageRow(KITKAT, fullFeeds)
    expect(r.opening).toBe(40)
    expect(r.purchased).toBe(24)
    expect(r.sold).toBe(50)
    expect(r.closing).toBe(10)
    expect(r.expected).toBe(14)          // 40 + 24 − 50 (what should be on the shelf)
    expect(r.shrinkage).toBe(4)          // expected − closing
    expect(r.shrinkageValue).toBeCloseTo(5.32, 2)
    expect(r.complete).toBe(true)
    expect(r.missing).toEqual([])
  })

  it('negative shrinkage (overage / miscount) computes too, not clamped', () => {
    const r = computeShrinkageRow(KITKAT, { ...fullFeeds, closingByCat: { kk: 20 } })
    expect(r.shrinkage).toBe(-6)         // 40 + 24 − 50 − 20
  })
})

describe('HONESTY — missing feed → null cell + incomplete, never a fake zero', () => {
  it('EMPTY closing count (item absent from the count map) → closing null, incomplete — NOT a fake 0', () => {
    // The correctness fix: an empty/absent count must read "not counted", not "closing 0".
    const r = computeShrinkageRow(KITKAT, { ...fullFeeds, closingByCat: {} })
    expect(r.closing).toBeNull()
    expect(r.shrinkage).toBeNull()          // would fake +54 "lost" if it read closing 0
    expect(r.shrinkageValue).toBeNull()
    expect(r.complete).toBe(false)
    expect(r.missing).toContain('closing')
  })
  it('item absent from a NON-empty count → still null (other items counted, this one wasn\'t)', () => {
    const r = computeShrinkageRow(KITKAT, { ...fullFeeds, closingByCat: { somethingElse: 5 } })
    expect(r.closing).toBeNull()
    expect(r.missing).toContain('closing')
  })
  it('a counted 0 is a REAL zero (key present at 0) → complete, computes', () => {
    const r = computeShrinkageRow(KITKAT, { ...fullFeeds, closingByCat: { kk: 0 } })
    expect(r.closing).toBe(0)
    expect(r.complete).toBe(true)
    expect(r.shrinkage).toBe(14)            // 40 + 24 − 50 − 0
  })
  it('empty/absent OPENING count → opening null, incomplete (same rule)', () => {
    const r = computeShrinkageRow(KITKAT, { ...fullFeeds, openingByCat: {} })
    expect(r.opening).toBeNull()
    expect(r.missing).toContain('opening')
    expect(r.complete).toBe(false)
  })
  it('no sold feed for the period → sold null (not 0), incomplete', () => {
    const r = computeShrinkageRow(KITKAT, { ...fullFeeds, hasSoldFeed: false })
    expect(r.sold).toBeNull()
    expect(r.missing).toContain('sold')
    expect(r.complete).toBe(false)
  })
  it('sold feed present but this item had none → sold 0 is REAL, row complete', () => {
    const r = computeShrinkageRow(KITKAT, { ...fullFeeds, soldByCanonical: {} })
    expect(r.sold).toBe(0)
    expect(r.complete).toBe(true)
    expect(r.shrinkage).toBe(54)          // 40 + 24 − 0 − 10
  })
  it('purchased defaults to 0 (real — AP is the record), does not block completeness', () => {
    const r = computeShrinkageRow(KITKAT, { ...fullFeeds, purchasedByCanonical: {} })
    expect(r.purchased).toBe(0)
    expect(r.complete).toBe(true)
    expect(r.shrinkage).toBe(-20)         // 40 + 0 − 50 − 10
  })
})

describe('computeShrinkageRows — only shrinkage-tracked canonicals', () => {
  const canonicals = [
    KITKAT,
    { canonicalId: 'napkins', canonicalName: 'Tork Napkins', catalogItemId: 'np', soldAliases: [], status: 'cafe_use' }, // café-use → excluded
    { canonicalId: 'soy', canonicalName: 'Kikkoman Soy', catalogItemId: 'sy', soldAliases: [] },                          // purchase-only, no sold → excluded
  ]
  it('excludes café-use and non-sold items — only real retail rows', () => {
    const rows = computeShrinkageRows(canonicals, fullFeeds)
    expect(rows).toHaveLength(1)
    expect(rows[0].canonicalId).toBe('kit-kat')
  })
})

describe('shrinkageKpis — totals over COMPLETE rows only', () => {
  const rows = computeShrinkageRows([KITKAT], fullFeeds)
  it('rolls up loss / units / items, and counts incompletes separately', () => {
    const k = shrinkageKpis(rows)
    expect(k.totalLoss).toBeCloseTo(5.32, 2)
    expect(k.unitsLost).toBe(4)
    expect(k.itemsAffected).toBe(1)
    expect(k.completeCount).toBe(1)
    expect(k.incompleteCount).toBe(0)
  })
})
