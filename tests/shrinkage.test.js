// Guard for the shrinkage variance calc (Increment 4). The formula
//   shrinkage = opening + purchased − sold − closing ;  $lost = shrinkage × unitCost
// and the HONESTY rule (missing feed → null cell + incomplete flag, never a fake zero).
import { describe, it, expect } from 'vitest'
import { computeShrinkageRow, computeShrinkageRows, shrinkageKpis, countEaches, isCounted, itemNameKey } from '@/lib/shrinkage'

// A fully-fed canonical: Kit Kat. Opening/Closing join on the NAME key (count docs don't
// carry catalogItemId) — itemNameKey('Kit Kat 1.5oz') = 'kit-kat-1-5oz'. Opening 40, bought
// 24, sold 50, closing 10 → shrinkage = 40 + 24 − 50 − 10 = 4 units × $1.33 = $5.32.
const KITKAT = { canonicalId: 'kit-kat', canonicalName: 'Kit Kat 1.5oz', catalogItemId: 'kk', soldAliases: ['Mars, Candy, Kit Kat, 1.5 oz'] }
const NK = itemNameKey('Kit Kat 1.5oz')   // 'kit-kat-1-5oz' — the count-name join key
const fullFeeds = {
  hasSoldFeed: true,
  openingByName: { [NK]: 40 }, closingByName: { [NK]: 10 },   // count line whose NAME slugs to NK
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

describe('countEaches + isCounted → feeds (the ShrinkageTable read, name-keyed, honesty preserved)', () => {
  // Simulate building openingByName/closingByName the way ShrinkageTable does now: keyed by
  // itemNameKey(count.name), only ACTUALLY-counted lines.
  const buildMap = (items) => {
    const m = {}
    items.forEach((i) => { if (i.name && isCounted(i)) m[itemNameKey(i.name)] = countEaches(i) })
    return m
  }
  it('blank line is omitted (→ null/incomplete); real lines land in eaches, keyed by name', () => {
    const m = buildMap([
      { name: 'Celsius Cosmic Vibe', qty: 0, eaches: 24, qtyPerPack: 50 },   // 24
      { name: 'Blank Item', qty: null, eaches: null },                        // blank → omitted
      { name: '2% Milk', qty: 0, eaches: 0, qtyPerPack: 24 },                 // counted 0 → real 0 key
    ])
    expect(m).toEqual({ 'celsius-cosmic-vibe': 24, '2-milk': 0 })
    expect('blank-item' in m).toBe(false)                // not counted → absent → row incomplete
    expect('2-milk' in m).toBe(true)                     // counted-0 present → real 0
  })
})

describe('name-join — the Wesley fix (count docs use name-slug ids, not catalogItemId)', () => {
  // Real case: canonical "Starbucks frappuccino mocha" maps to a count line "Starbucks
  // Frappuccino Mocha" — different id spaces, same name → joins via itemNameKey.
  const SB = { canonicalId: 'starbucks-frappuccino-mocha', canonicalName: 'Starbucks frappuccino mocha', catalogItemId: '19', soldAliases: ['x'] }
  const feeds = (over) => ({ hasSoldFeed: true, purchasedByCanonical: {}, soldByCanonical: { 'starbucks-frappuccino-mocha': 8 }, unitCostByCat: { '19': 2.5 }, ...over })

  it('mapped item WITH a matching count line (by name) → Opening/Closing populate', () => {
    const key = itemNameKey('Starbucks Frappuccino Mocha')   // == itemNameKey(canonicalName)
    const r = computeShrinkageRow(SB, feeds({ openingByName: { [key]: 12 }, closingByName: { [key]: 3 } }))
    expect(r.opening).toBe(12)
    expect(r.closing).toBe(3)
    expect(r.shrinkage).toBe(1)               // 12 + 0 − 8 − 3
    expect(r.complete).toBe(true)
  })
  it('mapped item with NO matching count line → Opening/Closing stay "—" (honesty preserved)', () => {
    // Count has other items but not this one (e.g. Tropical Vibe mapped, only Cosmic counted).
    const r = computeShrinkageRow(SB, feeds({ openingByName: { 'celsius-cosmic-vibe': 5 }, closingByName: { 'celsius-cosmic-vibe': 2 } }))
    expect(r.opening).toBeNull()
    expect(r.closing).toBeNull()
    expect(r.complete).toBe(false)
    expect(r.missing).toEqual(expect.arrayContaining(['opening', 'closing']))
  })
  it('the OLD numeric-catalogItemId key no longer drives the join (would have found nothing anyway)', () => {
    // Even if a caller passed a legacy openingByCat, it is ignored — the join is name-based.
    const r = computeShrinkageRow(SB, feeds({ openingByCat: { '19': 99 }, closingByCat: { '19': 99 } }))
    expect(r.opening).toBeNull()              // openingByCat is not read
    expect(r.closing).toBeNull()
  })
})

describe('countAliases — the durable bridge (attach a count line whose NAME differs from the canonical)', () => {
  // The Gatorade case: canonical "gatorade 20 oz lemon lime", count line "Gatorade Lemon
  // Lime". Names differ → the baseline name-key match misses it. An explicit countAlias
  // recording the count name attaches it anyway. Same id spaces never meet — only the alias does.
  const GAT = {
    canonicalId: 'gatorade-20-oz-lemon-lime', canonicalName: 'gatorade 20 oz lemon lime',
    catalogItemId: '77', soldAliases: ['x'], countAliases: ['Gatorade Lemon Lime'],
  }
  const feeds = (over) => ({ hasSoldFeed: true, purchasedByCanonical: {}, soldByCanonical: { 'gatorade-20-oz-lemon-lime': 5 }, unitCostByCat: { '77': 1.5 }, ...over })
  const COUNT_KEY = itemNameKey('Gatorade Lemon Lime')   // 'gatorade-lemon-lime' — differs from canonical key
  const CANON_KEY = itemNameKey('gatorade 20 oz lemon lime')

  it('count name in countAliases attaches Opening/Closing even though it ≠ the canonical name', () => {
    expect(COUNT_KEY).not.toBe(CANON_KEY)                 // the whole point: the names differ
    const r = computeShrinkageRow(GAT, feeds({ openingByName: { [COUNT_KEY]: 10 }, closingByName: { [COUNT_KEY]: 4 } }))
    expect(r.opening).toBe(10)
    expect(r.closing).toBe(4)
    expect(r.shrinkage).toBe(1)                            // 10 + 0 − 5 − 4
    expect(r.complete).toBe(true)
  })

  it('baseline still works: a count line matching the CANONICAL name attaches with no alias', () => {
    const noAlias = { ...GAT, countAliases: [] }
    const r = computeShrinkageRow(noAlias, feeds({ openingByName: { [CANON_KEY]: 7 }, closingByName: { [CANON_KEY]: 2 } }))
    expect(r.opening).toBe(7)                              // canonicalName key is the first key tried
    expect(r.closing).toBe(2)
    expect(r.complete).toBe(true)
  })

  it('countAliases EXTEND the name match — canonical-name line still attaches when aliases exist', () => {
    // A count named like the canonical joins even while the alias covers a different spelling.
    const r = computeShrinkageRow(GAT, feeds({ openingByName: { [CANON_KEY]: 9 }, closingByName: { [CANON_KEY]: 1 } }))
    expect(r.opening).toBe(9)
    expect(r.closing).toBe(1)
  })

  it('no alias + no name match → "—"/incomplete (nothing fabricated)', () => {
    const noAlias = { ...GAT, countAliases: [] }
    const r = computeShrinkageRow(noAlias, feeds({ openingByName: { [COUNT_KEY]: 10 }, closingByName: { [COUNT_KEY]: 4 } }))
    expect(r.opening).toBeNull()                           // alias removed → the differing count name no longer attaches
    expect(r.closing).toBeNull()
    expect(r.complete).toBe(false)
    expect(r.missing).toEqual(expect.arrayContaining(['opening', 'closing']))
  })

  it('counted-0 through an alias is a REAL zero (present key at 0), row complete', () => {
    const r = computeShrinkageRow(GAT, feeds({ openingByName: { [COUNT_KEY]: 6 }, closingByName: { [COUNT_KEY]: 0 } }))
    expect(r.closing).toBe(0)                              // aliased key present at 0 → real, not "—"
    expect(r.complete).toBe(true)
    expect(r.shrinkage).toBe(1)                            // 6 + 0 − 5 − 0
  })

  it('missing countAliases field behaves like the baseline (undefined → canonical-name only)', () => {
    const legacy = { canonicalId: 'c', canonicalName: 'Kit Kat 1.5oz', catalogItemId: 'kk', soldAliases: ['x'] }
    const r = computeShrinkageRow(legacy, { ...fullFeeds, soldByCanonical: { c: 50 }, purchasedByCanonical: { c: 24 } })
    expect(r.opening).toBe(40)                             // NK == itemNameKey(canonicalName) still matches
    expect(r.closing).toBe(10)
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
    const r = computeShrinkageRow(KITKAT, { ...fullFeeds, closingByName: { [NK]: 20 } })
    expect(r.shrinkage).toBe(-6)         // 40 + 24 − 50 − 20
  })
})

describe('HONESTY — missing feed → null cell + incomplete, never a fake zero', () => {
  it('EMPTY closing count (item absent from the count map) → closing null, incomplete — NOT a fake 0', () => {
    // The correctness fix: an empty/absent count must read "not counted", not "closing 0".
    const r = computeShrinkageRow(KITKAT, { ...fullFeeds, closingByName: {} })
    expect(r.closing).toBeNull()
    expect(r.shrinkage).toBeNull()          // would fake +54 "lost" if it read closing 0
    expect(r.shrinkageValue).toBeNull()
    expect(r.complete).toBe(false)
    expect(r.missing).toContain('closing')
  })
  it('item absent from a NON-empty count → still null (other items counted, this one wasn\'t)', () => {
    const r = computeShrinkageRow(KITKAT, { ...fullFeeds, closingByName: { 'something-else': 5 } })
    expect(r.closing).toBeNull()
    expect(r.missing).toContain('closing')
  })
  it('a counted 0 is a REAL zero (key present at 0) → complete, computes', () => {
    const r = computeShrinkageRow(KITKAT, { ...fullFeeds, closingByName: { [NK]: 0 } })
    expect(r.closing).toBe(0)
    expect(r.complete).toBe(true)
    expect(r.shrinkage).toBe(14)            // 40 + 24 − 50 − 0
  })
  it('empty/absent OPENING count → opening null, incomplete (same rule)', () => {
    const r = computeShrinkageRow(KITKAT, { ...fullFeeds, openingByName: {} })
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
  it('pack-UNRESOLVED purchase line → row incomplete, not a confident variance (known sum shown)', () => {
    // One resolved line contributed eaches 24 (purchasedByCanonical), but another line for
    // the same canonical has eachesTotal:null (pack unresolved) → purchased is a lower bound.
    const r = computeShrinkageRow(KITKAT, {
      ...fullFeeds,
      purchasedByCanonical: { 'kit-kat': 24 },
      purchasedUnresolvedByCanonical: { 'kit-kat': true },
    })
    expect(r.purchased).toBe(24)               // the KNOWN sum is still shown
    expect(r.purchasedUnresolved).toBe(true)
    expect(r.missing).toContain('purchased')
    expect(r.complete).toBe(false)             // excluded from KPI totals
    expect(r.shrinkage).toBeNull()             // no confident variance (would've been 40+24−50−10=4)
    expect(r.expected).toBeNull()
  })
})

describe('pack-unresolved excluded from KPI totals', () => {
  const canon = { canonicalId: 'kit-kat', canonicalName: 'Kit Kat 1.5oz', catalogItemId: 'kk', soldAliases: ['x'] }
  it('an incomplete (pack-unresolved) row does not inflate/deflate the honest total', () => {
    const rows = computeShrinkageRows([canon], {
      ...fullFeeds,
      purchasedByCanonical: { 'kit-kat': 24 },
      purchasedUnresolvedByCanonical: { 'kit-kat': true },
    })
    const k = shrinkageKpis(rows)
    expect(k.completeCount).toBe(0)
    expect(k.incompleteCount).toBe(1)
    expect(k.totalLoss).toBe(0)                // the honest total ignores the uncertain row
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
