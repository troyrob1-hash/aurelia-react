// Guard for the item-mapping pure logic (Increment 2): the fuzzy matcher, the
// variant-risk guard (never auto-merge Chobani peach vs strawberry), the confidence
// classification, and the volume-ranked coverage math (the "map 100, covered 54%"
// refinement). Firestore writers are thin and excluded; this locks the decisions.
import { describe, it, expect } from 'vitest'
import {
  normalizeItemName, canonicalIdFor, itemTokens, isVariantRisk, fuzzyBest,
  classifyMatch, rankUnmappedByVolume, coverageStats, purchaseKeyId, planAutoMap,
  buildPurchaseLookup, resolvePurchaseLineLive,
} from '@/lib/itemMap'

describe('normalization + slug', () => {
  it('strips sizes/units/numbers and token-sorts', () => {
    expect(normalizeItemName('Mars, Candy, Kit Kat, 1.5 oz')).toBe('candy kat kit mars')
    expect(normalizeItemName('LAYS CHIP POTATO SRCRM & O 00028400443616')).toContain('lays')
  })
  it('canonicalId is doc-id-safe', () => {
    expect(canonicalIdFor('Lays Sour Cream & Onion 1.5oz')).toBe('lays-sour-cream-onion-1-5oz')
  })
  it('purchaseKeyId composes vendor + code', () => {
    expect(purchaseKeyId('sysco', '6799157')).toBe('sysco__6799157')
  })
})

describe('variant-risk guard (never auto-merge distinct flavors)', () => {
  it('same brand, different flavor each side → risk', () => {
    const a = itemTokens('Chobani Yogurt Peach Greek')
    const b = itemTokens('Chobani Yogurt Strawberry Greek')
    expect(isVariantRisk(a, b)).toBe(true)
  })
  it('same product, same flavor → no risk', () => {
    const a = itemTokens('Chobani Yogurt Peach Greek Nonfat')
    const b = itemTokens('Chobani Peach Greek')
    expect(isVariantRisk(a, b)).toBe(false)
  })
})

describe('fuzzy match is brand-anchored', () => {
  const cands = [
    { name: 'Rockstar Energy Drink Original', _tokens: itemTokens('Rockstar Energy Drink Original'), _brand: 'rockstar' },
    { name: 'Monster Energy Original 16oz', _tokens: itemTokens('Monster Energy Original 16oz'), _brand: 'monster' },
  ]
  it('matches the same brand, not a different one with shared descriptors', () => {
    const r = fuzzyBest('Monster, Energy Drink, Original, 16 fl oz', cands)
    expect(r.match.name).toContain('Monster')   // NOT Rockstar despite shared "energy/original"
  })
})

describe('classifyMatch — auto / proposal / none', () => {
  it('high score + no risk → auto', () => {
    expect(classifyMatch({ score: 0.8, variantRisk: false })).toBe('auto')
  })
  it('high score BUT variant-risk → proposal (never silent)', () => {
    expect(classifyMatch({ score: 0.8, variantRisk: true })).toBe('proposal')
  })
  it('mid score → proposal, low → none', () => {
    expect(classifyMatch({ score: 0.45, variantRisk: false })).toBe('proposal')
    expect(classifyMatch({ score: 0.2, variantRisk: false })).toBe('none')
  })
})

describe('planAutoMap — auto / proposal / unmapped split', () => {
  const candidates = [
    { name: 'Kit Kat 1.5oz', _tokens: itemTokens('Kit Kat 1.5oz'), _brand: 'kit' },
    { name: 'Chobani Peach Greek', _tokens: itemTokens('Chobani Peach Greek'), _brand: 'chobani' },
  ]
  const items = [
    { name: 'Kit Kat', qtySold: 100 },                       // strong → auto
    { name: 'Chobani Strawberry Greek', qtySold: 50 },        // variant-risk vs peach → proposal
    { name: 'Acqua Panna Spring Water', qtySold: 10 },        // no brand match → unmapped
  ]
  const plan = planAutoMap(items, candidates)
  it('auto-maps only the high-confidence non-variant item', () => {
    expect(plan.auto.map((r) => r.name)).toEqual(['Kit Kat'])
  })
  it('variant-risk → proposal (shown, not auto), no-match → unmapped', () => {
    expect(plan.proposals.map((r) => r.name)).toContain('Chobani Strawberry Greek')
    expect(plan.proposals.find((r) => r.name === 'Chobani Strawberry Greek').variantRisk).toBe(true)
    expect(plan.unmapped.map((r) => r.name)).toEqual(['Acqua Panna Spring Water'])
  })
  it('skips already-mapped names', () => {
    const p = planAutoMap(items, candidates, { alreadyMapped: new Set(['Kit Kat']) })
    expect(p.auto).toHaveLength(0)
  })
})

describe('read-time purchase resolution (self-heals, ignores stored canonicalId)', () => {
  // The Celsius case: mapping exists (sysco 7228765 → canonical), but the invoice line
  // was parsed BEFORE the mapping and stored canonicalId:null.
  const mappings = [
    { canonicalId: 'celsius-kiwi-guava-12-oz', canonicalName: 'celsius kiwi guava 12 oz',
      purchaseKeys: [{ vendor: 'sysco', itemCode: '7228765', upc: null }] },
    { canonicalId: 'coke-mex', canonicalName: 'Coke Mexican',
      purchaseKeys: [{ vendor: 'reyes_coca_cola', itemCode: '126689', upc: '049000047790' }] },
  ]
  const lookup = buildPurchaseLookup(mappings)

  it('a line with stored canonicalId:null resolves LIVE via the index → contributes', () => {
    const line = { itemCode: '7228765', upc: '', eachesTotal: 12, canonicalId: null }  // stored null
    expect(resolvePurchaseLineLive(lookup, 'sysco', line)).toBe('celsius-kiwi-guava-12-oz')
  })
  it('a line whose code has no mapping stays unmapped (null)', () => {
    const line = { itemCode: '9999999', upc: '', eachesTotal: 5 }
    expect(resolvePurchaseLineLive(lookup, 'sysco', line)).toBeNull()
  })
  it('UPC is preferred over (vendor,itemCode) when both could resolve', () => {
    // upc maps to coke-mex; itemCode belongs to a different (hypothetical) vendor scope.
    const line = { itemCode: '126689', upc: '049000047790' }
    expect(resolvePurchaseLineLive(lookup, 'reyes_coca_cola', line)).toBe('coke-mex')
  })
  it('vendor scoping: same itemCode under a different vendorKey does not match', () => {
    const line = { itemCode: '7228765', upc: '' }
    expect(resolvePurchaseLineLive(lookup, 'some_other_vendor', line)).toBeNull()
  })
  it('remapping a code changes attribution with NO change to invoice docs', () => {
    // Same line object; only the mappings changed → the lookup resolves it differently.
    const line = { itemCode: '7228765', upc: '', canonicalId: null }
    const remapped = buildPurchaseLookup([
      { canonicalId: 'celsius-other', canonicalName: 'Celsius Other', purchaseKeys: [{ vendor: 'sysco', itemCode: '7228765' }] },
    ])
    expect(resolvePurchaseLineLive(remapped, 'sysco', line)).toBe('celsius-other')
  })
})

describe('volume-ranked coverage (the sizing refinement)', () => {
  // Synthetic distribution: a few heavy hitters + a long light tail.
  const items = [
    { name: 'A', qtySold: 400 }, { name: 'B', qtySold: 300 }, { name: 'C', qtySold: 200 },
    { name: 'D', qtySold: 60 }, { name: 'E', qtySold: 30 }, { name: 'F', qtySold: 5 },
    { name: 'G', qtySold: 3 }, { name: 'H', qtySold: 2 },
  ] // total 1000
  it('ranks by qtySold desc with cumulative %', () => {
    const r = rankUnmappedByVolume(items)
    expect(r[0].name).toBe('A')
    expect(r[0].cumPct).toBeCloseTo(40, 1)
    expect(r[2].cumPct).toBeCloseTo(90, 1)   // A+B+C = 900/1000
  })
  it('coverage reflects mapped names + counts the ≤5 tail as optional', () => {
    const stats = coverageStats(rankUnmappedByVolume(items), new Set(['A', 'B']))
    expect(stats.coveredPct).toBeCloseTo(70, 1)          // 700/1000
    expect(stats.unmappedTailCount).toBe(3)              // F,G,H (≤5) — optional
  })
  it('milestone: how many more items to reach the next coverage %', () => {
    const stats = coverageStats(rankUnmappedByVolume(items), new Set())   // nothing mapped
    const m85 = stats.milestones.find((m) => m.pct === 85)
    // A(400)+B(300)=700=70%, +C(200)=900=90% ≥85% → need 3 items
    expect(m85.itemsNeeded).toBe(3)
    expect(m85.reachable).toBe(true)
  })
})
