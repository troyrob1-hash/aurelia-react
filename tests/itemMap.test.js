// Guard for the item-mapping pure logic (Increment 2): the fuzzy matcher, the
// variant-risk guard (never auto-merge Chobani peach vs strawberry), the confidence
// classification, and the volume-ranked coverage math (the "map 100, covered 54%"
// refinement). Firestore writers are thin and excluded; this locks the decisions.
import { describe, it, expect } from 'vitest'
import {
  normalizeItemName, canonicalIdFor, itemTokens, isVariantRisk, fuzzyBest,
  classifyMatch, rankUnmappedByVolume, coverageStats, purchaseKeyId, planAutoMap,
  buildPurchaseLookup, resolvePurchaseLineLive, dedupePurchaseKeys,
  dedupeCountAliases, countNameKeysFor, planCountAliasSeed, planCountAliasAutoSeed, newMappingDoc,
  normalizeSoldName, brandOf, expandAbbrev, fuzzyTokenMatch, bTierSafe,
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
  it('scores on matchName when provided, but keeps the ORIGINAL name as the row identity', () => {
    const cands = [{ name: 'Pepsi', _tokens: itemTokens('Pepsi'), _brand: 'pepsi' }]
    const p = planAutoMap([{ name: 'Pepsi Soda Original 20 fl oz', matchName: 'Pepsi Original' }], cands)
    expect(p.auto).toHaveLength(1)
    expect(p.auto[0].name).toBe('Pepsi Soda Original 20 fl oz')   // soldAlias identity = original
    expect(p.auto[0].match.name).toBe('Pepsi')
  })
})

describe('normalizeSoldName — Product-Mix noise stripping (category tokens, formats, distributor)', () => {
  it('strips category words / size (space-format) → recovers product', () => {
    expect(normalizeSoldName('Pepsi Soda Original 20 fl oz')).toBe('Pepsi Original')   // "soda" + size gone; brand kept
    expect(normalizeSoldName('20oz Starry')).toBe('Starry')
  })
  it('comma-format "Brand, Category, Product, Size": drops category + leading DISTRIBUTOR', () => {
    expect(normalizeSoldName('Pepsi, Soda, Diet Pepsi, 20 fl oz')).toBe('Diet Pepsi')  // reseller "Pepsi" dropped → brand "diet"
    expect(normalizeSoldName('Pepsi, Soda, Mountain Dew, 20 fl oz')).toBe('Mountain Dew')
  })
  it('underscore-format "Size Brand_Product_Category" → product (distributor Pepsi dropped)', () => {
    expect(normalizeSoldName('20 oz Pepsi_Mug Root Beer_Soda')).toBe('Mug Root Beer')  // matches catalog "Mug Root Beer"
  })
  it('drops a pure-category FIELD but keeps "water" inside a product name', () => {
    expect(normalizeSoldName('Life Water, Water, Still, 20 fl oz')).toBe('Life Water')  // "Water"/"Still" fields dropped, "Life Water" kept
  })
  it('NEVER drops distinguishing tokens (diet / zero / cherry / flavor) — variant safety', () => {
    expect(normalizeSoldName('Pepsi, Soda, Pepsi Zero, 20 fl oz')).toMatch(/zero/i)
    expect(normalizeSoldName('Pepsi, Soda, Pepsi Cherry, 20 fl oz')).toMatch(/cherry/i)
    expect(normalizeSoldName('Pepsi, Soda, Diet Pepsi, 20 fl oz')).toMatch(/diet/i)
  })
  it('a non-distributor brand (Alani Nu) is NOT dropped', () => {
    expect(normalizeSoldName('Alani Nu, Energy Drink, Dream Float, 12 fl oz')).toBe('Alani Nu Dream Float')
  })
  it('never returns empty (all-category name → original)', () => {
    expect(normalizeSoldName('Soda')).toBe('Soda')
  })
})

describe('normalizeSoldName + planAutoMap — Pepsi variants map to their OWN item (NO collision)', () => {
  // The critical guarantee: stripping "soda" must NOT collapse Diet/Zero/Cherry into plain Pepsi.
  const cands = [
    { id: 'pepsi', name: 'Pepsi' },
    { id: 'diet_pepsi', name: 'Diet Pepsi' },
    { id: 'pepsi_zero_sugar', name: 'Pepsi Zero Sugar' },
    { id: 'pepsi_wild_cherry', name: 'Pepsi Wild Cherry' },
  ].map((c) => ({ ...c, _tokens: itemTokens(c.name), _brand: brandOf(c.name) }))
  const raw = [
    'Pepsi Soda Original 20 fl oz',
    'Pepsi, Soda, Diet Pepsi, 20 fl oz',
    'Pepsi, Soda, Pepsi Zero, 20 fl oz',
    'Pepsi, Soda, Pepsi Cherry, 20 fl oz',
  ]
  const plan = planAutoMap(raw.map((name) => ({ name, matchName: normalizeSoldName(name) })), cands)
  const byName = Object.fromEntries(plan.auto.map((r) => [r.name, r.match.id]))

  it('plain Pepsi → Pepsi', () => expect(byName['Pepsi Soda Original 20 fl oz']).toBe('pepsi'))
  it('Diet Pepsi → Diet Pepsi (NOT plain Pepsi)', () => {
    expect(byName['Pepsi, Soda, Diet Pepsi, 20 fl oz']).toBe('diet_pepsi')
    expect(byName['Pepsi, Soda, Diet Pepsi, 20 fl oz']).not.toBe('pepsi')
  })
  it('Pepsi Zero → Pepsi Zero Sugar (NOT plain Pepsi)', () => {
    expect(byName['Pepsi, Soda, Pepsi Zero, 20 fl oz']).toBe('pepsi_zero_sugar')
  })
  it('Pepsi Cherry → Pepsi Wild Cherry (NOT plain Pepsi)', () => {
    expect(byName['Pepsi, Soda, Pepsi Cherry, 20 fl oz']).toBe('pepsi_wild_cherry')
  })
  it('all four land on DISTINCT items (no two collide)', () => {
    const ids = Object.values(byName)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids.length).toBe(4)
  })
})

describe('abbreviation expansion (mt/mtn → mountain) + diet-class variant guard', () => {
  it('expandAbbrev maps the proven abbreviations only', () => {
    expect(expandAbbrev('mt. dew')).toBe('mountain. dew')
    expect(expandAbbrev('mtn dew zero')).toBe('mountain dew zero')
    expect(expandAbbrev('empty')).toBe('empty')            // "mt" inside a word is NOT touched (\b)
  })
  it('applied BEFORE the ≤2-char filter: "Mt. Dew" and "Mountain Dew" share the "mountain" token', () => {
    expect(itemTokens('Mt. Dew').has('mountain')).toBe(true)   // "mt" would be dropped without expansion
    expect(itemTokens('Mountain Dew').has('mountain')).toBe(true)
  })

  const cands = [
    { id: 'mt_dew', name: 'Mt. Dew' },
    { id: 'diet_mt_dew', name: 'Diet Mt. Dew' },
    { id: 'pepsi', name: 'Pepsi' }, { id: 'diet_pepsi', name: 'Diet Pepsi' },
    { id: 'pepsi_zero_sugar', name: 'Pepsi Zero Sugar' }, { id: 'pepsi_wild_cherry', name: 'Pepsi Wild Cherry' },
  ].map((c) => ({ ...c, _tokens: itemTokens(c.name), _brand: brandOf(c.name) }))
  const plan = (name) => planAutoMap([{ name, matchName: normalizeSoldName(name) }], cands)

  it('Mountain Dew → mt_dew (abbreviation closes the gap)', () => {
    const p = plan('Pepsi, Soda, Mountain Dew, 20 fl oz')
    expect(p.auto[0]?.match.id).toBe('mt_dew')
  })
  it('Diet Mountain Dew → diet_mt_dew (its OWN diet variant)', () => {
    const p = plan('Pepsi, Soda, Diet Mountain Dew, 20oz')
    expect(p.auto[0]?.match.id).toBe('diet_mt_dew')
  })
  it('Mtn Dew Zero → NOT auto to plain mt_dew (diet-class guard → manual), no zero variant exists', () => {
    const p = plan('Pepsi, Soda, Mtn Dew Zero, 20 fl oz')
    expect(p.auto).toHaveLength(0)                          // does NOT collapse into regular Mt. Dew
    expect(p.proposals.map((r) => r.match.id)).toContain('mt_dew')  // surfaced for a human, flagged variant
  })
  it('no regression: Pepsi variants still map to their own items', () => {
    expect(plan('Pepsi Soda Original 20 fl oz').auto[0]?.match.id).toBe('pepsi')
    expect(plan('Pepsi, Soda, Diet Pepsi, 20 fl oz').auto[0]?.match.id).toBe('diet_pepsi')
    expect(plan('Pepsi, Soda, Pepsi Zero, 20 fl oz').auto[0]?.match.id).toBe('pepsi_zero_sugar')
    expect(plan('Pepsi, Soda, Pepsi Cherry, 20 fl oz').auto[0]?.match.id).toBe('pepsi_wild_cherry')
  })

  it('isVariantRisk: one-sided diet/zero → risk; both-diet → NOT risk; flavor guard intact', () => {
    expect(isVariantRisk(itemTokens('Mountain Dew Zero'), itemTokens('Mt. Dew'))).toBe(true)       // zero vs regular
    expect(isVariantRisk(itemTokens('Diet Mt. Dew'), itemTokens('Diet Mountain Dew'))).toBe(false) // both diet
    expect(isVariantRisk(itemTokens('Pepsi Zero'), itemTokens('Pepsi Zero Sugar'))).toBe(false)    // both zero
    expect(isVariantRisk(itemTokens('Mountain Dew'), itemTokens('Mt. Dew'))).toBe(false)           // neither diet/zero
  })
})

describe('dedupePurchaseKeys — mapping the same code twice yields one entry', () => {
  it('collapses the exact-same tuple (the Celsius double-append)', () => {
    const keys = [
      { itemCode: '7228765', vendor: 'sysco', upc: null },
      { upc: null, vendor: 'sysco', itemCode: '7228765' },   // same tuple, different key order
    ]
    const out = dedupePurchaseKeys(keys)
    expect(out).toHaveLength(1)
    expect(out[0]).toEqual({ vendor: 'sysco', itemCode: '7228765', upc: null })
  })
  it('keeps genuinely distinct codes / vendors / upcs', () => {
    const out = dedupePurchaseKeys([
      { vendor: 'sysco', itemCode: '7228765', upc: null },
      { vendor: 'sysco', itemCode: '111', upc: null },           // different code
      { vendor: 'reyes_coca_cola', itemCode: '7228765', upc: null }, // same code, diff vendor
      { vendor: 'sysco', itemCode: null, upc: '049000047790' },  // upc-only
    ])
    expect(out).toHaveLength(4)
  })
  it('drops entries with neither itemCode nor upc, and normalizes blank → null', () => {
    const out = dedupePurchaseKeys([
      { vendor: 'sysco', itemCode: '', upc: '' },   // no stable key → dropped
      { vendor: 'sysco', itemCode: '  7228765  ', upc: '' },
    ])
    expect(out).toEqual([{ vendor: 'sysco', itemCode: '7228765', upc: null }])
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

describe('countAliases — the count-side bridge (count docs carry no catalogItemId)', () => {
  it('newMappingDoc includes an empty countAliases[] by default', () => {
    const d = newMappingDoc({ canonicalName: 'Kit Kat 1.5oz', createdBy: 'me' })
    expect(d.countAliases).toEqual([])
    expect(d.canonicalId).toBe('kit-kat-1-5oz')
  })

  it('dedupeCountAliases collapses by name-key, keeps first spelling, drops blanks', () => {
    expect(dedupeCountAliases(['Gatorade Lemon Lime', 'gatorade  lemon  lime', '', null, 'Gatorade Lemon-Lime']))
      .toEqual(['Gatorade Lemon Lime'])   // all slug to 'gatorade-lemon-lime'
    expect(dedupeCountAliases(['Coke', 'Sprite'])).toEqual(['Coke', 'Sprite'])
  })

  it('countNameKeysFor = canonical name-key + every alias key (the join set)', () => {
    const m = { canonicalName: 'gatorade 20 oz lemon lime', countAliases: ['Gatorade Lemon Lime', 'Gatorade LL'] }
    const keys = countNameKeysFor(m)
    expect(keys.has('gatorade-20-oz-lemon-lime')).toBe(true)   // baseline (its own name)
    expect(keys.has('gatorade-lemon-lime')).toBe(true)         // alias 1
    expect(keys.has('gatorade-ll')).toBe(true)                 // alias 2
  })

  it('planCountAliasSeed seeds ONLY exact-name matches, skips already-aliased + non-matches', () => {
    const mappings = [
      { canonicalId: 'gatorade-20-oz-lemon-lime', canonicalName: 'gatorade 20 oz lemon lime', countAliases: [] }, // name differs from count → NOT seeded
      { canonicalId: 'starbucks-frappuccino-mocha', canonicalName: 'Starbucks Frappuccino Mocha', countAliases: [] }, // exact → seed
      { canonicalId: 'celsius-cosmic-vibe', canonicalName: 'Celsius Cosmic Vibe', countAliases: ['Celsius Cosmic Vibe'] }, // already aliased → skip
    ]
    const countNames = ['Starbucks Frappuccino Mocha', 'Gatorade Lemon Lime', 'Celsius Cosmic Vibe', 'Unmapped Snack']
    const seed = planCountAliasSeed(mappings, countNames)
    expect(seed).toEqual([{ canonicalId: 'starbucks-frappuccino-mocha', canonicalName: 'Starbucks Frappuccino Mocha', countName: 'Starbucks Frappuccino Mocha' }])
  })

  it('planCountAliasSeed is idempotent — re-running after the alias exists returns []', () => {
    const mappings = [{ canonicalId: 'sb', canonicalName: 'Starbucks Frappuccino Mocha', countAliases: ['Starbucks Frappuccino Mocha'] }]
    expect(planCountAliasSeed(mappings, ['Starbucks Frappuccino Mocha'])).toEqual([])
  })
})

describe('planCountAliasAutoSeed — fuzzy tier (auto the safe, manual the ambiguous)', () => {
  it('high-confidence non-variant, single canonical → AUTO (count name ≠ canonical name)', () => {
    // Size token (20 oz) is normalized away → "Gatorade Lemon Lime" scores ~1.0 against the
    // ONE gatorade-lemon-lime canonical → safe silent attach. NOT an exact name-key match.
    const mappings = [{ canonicalId: 'g20', canonicalName: 'gatorade 20 oz lemon lime', soldAliases: [], countAliases: [] }]
    const { auto, proposals, unmapped } = planCountAliasAutoSeed(mappings, ['Gatorade Lemon Lime'])
    expect(auto).toHaveLength(1)
    expect(auto[0].canonicalId).toBe('g20')
    expect(auto[0].countName).toBe('Gatorade Lemon Lime')
    expect(proposals).toHaveLength(0)
    expect(unmapped).toHaveLength(0)
  })

  it('AMBIGUOUS (two sizes tie after size-strip) → proposal, NEVER auto', () => {
    const mappings = [
      { canonicalId: 'g20', canonicalName: 'gatorade 20 oz lemon lime', soldAliases: [], countAliases: [] },
      { canonicalId: 'g28', canonicalName: 'gatorade 28 oz lemon lime', soldAliases: [], countAliases: [] },
    ]
    const { auto, proposals } = planCountAliasAutoSeed(mappings, ['Gatorade Lemon Lime'])
    expect(auto).toHaveLength(0)                       // can't safely pick 20 vs 28 → manual
    expect(proposals).toHaveLength(1)
    expect(proposals[0].ambiguous).toBe(true)
  })

  it('VARIANT-RISK (same brand, distinct flavor) → proposal, NEVER auto', () => {
    // count "Chobani Strawberry" vs the only Chobani canonical "Chobani Peach" — distinct
    // flavor token each side → isVariantRisk → manual, not a silent wrong attach.
    const mappings = [{ canonicalId: 'cp', canonicalName: 'Chobani Peach', soldAliases: [], countAliases: [] }]
    const { auto, proposals } = planCountAliasAutoSeed(mappings, ['Chobani Strawberry'])
    expect(auto).toHaveLength(0)
    expect(proposals.some((p) => p.variantRisk)).toBe(true)
  })

  it('matches against soldAliases too, not just the canonical name', () => {
    const mappings = [{ canonicalId: 'mn', canonicalName: 'Monster Original', soldAliases: ['Monster Energy Drink Original 16oz'], countAliases: [] }]
    const { auto } = planCountAliasAutoSeed(mappings, ['Monster Energy Original'])
    expect(auto).toHaveLength(1)
    expect(auto[0].canonicalId).toBe('mn')
  })

  it('genuinely different name → unmapped (no suggestion, stays in the plain list)', () => {
    const mappings = [{ canonicalId: 'g20', canonicalName: 'gatorade 20 oz lemon lime', soldAliases: [], countAliases: [] }]
    const { auto, proposals, unmapped } = planCountAliasAutoSeed(mappings, ['Random Mystery Snack'])
    expect(auto).toHaveLength(0)
    expect(proposals).toHaveLength(0)
    expect(unmapped).toContain('Random Mystery Snack')
  })

  it('skips a count name already attached (exact tier ran first) — no double-attach', () => {
    const mappings = [{ canonicalId: 'g20', canonicalName: 'gatorade 20 oz lemon lime', soldAliases: [], countAliases: ['Gatorade Lemon Lime'] }]
    const { auto, proposals } = planCountAliasAutoSeed(mappings, ['Gatorade Lemon Lime'])
    expect(auto).toHaveLength(0)
    expect(proposals).toHaveLength(0)
  })

  it('the REAL Wesley case: count "Tropicana Apple Juice" auto-attaches to "tropicana apple juice 10 oz"', () => {
    // The exact Bug-2 scenario: canonical carries a "10 oz" suffix the count line lacks →
    // no exact/name-key match, but the size token is normalized away → unambiguous 1.0 fuzzy.
    // A sibling orange-juice canonical is present to prove it does NOT collide (different flavor).
    const mappings = [
      { canonicalId: 'trop-apple', canonicalName: 'tropicana apple juice 10 oz', soldAliases: [], countAliases: [] },
      { canonicalId: 'trop-orange', canonicalName: 'tropicana orange juice 10 oz', soldAliases: [], countAliases: [] },
    ]
    const { auto, proposals } = planCountAliasAutoSeed(mappings, ['Tropicana Apple Juice'])
    expect(auto).toHaveLength(1)
    expect(auto[0].canonicalId).toBe('trop-apple')       // apple → apple, NOT the orange sibling
    expect(auto[0].countName).toBe('Tropicana Apple Juice')
    expect(proposals).toHaveLength(0)                    // unambiguous → no manual step
  })

  it('already-working items stay working — an aliased canonical is untouched while a new one auto-attaches', () => {
    // Mirrors Wesley: some items already have a countAlias (working), a new mapped item needs one.
    const mappings = [
      { canonicalId: 'sb-van', canonicalName: 'Starbucks frappuccino vanilla', soldAliases: [], countAliases: ['Starbucks Frappuccino Vanilla'] }, // already linked
      { canonicalId: 'trop-apple', canonicalName: 'tropicana apple juice 10 oz', soldAliases: [], countAliases: [] },                                // newly mapped
    ]
    const { auto } = planCountAliasAutoSeed(mappings, ['Starbucks Frappuccino Vanilla', 'Tropicana Apple Juice'])
    // the already-linked Vanilla is NOT re-emitted (skipped); only the new Tropicana attaches
    expect(auto.map((a) => a.canonicalId)).toEqual(['trop-apple'])
    expect(auto.find((a) => a.canonicalId === 'sb-van')).toBeUndefined()
  })
})

describe('C tier — spelling (edit-distance ≤1) + de-space, guarded by one-sided flavor', () => {
  it('fuzzyTokenMatch: ≥5-char one-edit pairs match; short/too-far do not', () => {
    expect(fuzzyTokenMatch('frappucino', 'frappuccino')).toBe(true)
    expect(fuzzyTokenMatch('sherbet', 'sherbert')).toBe(true)
    expect(fuzzyTokenMatch('mightly', 'mighty')).toBe(true)
    expect(fuzzyTokenMatch('diet', 'debt')).toBe(false)        // <5 chars → no fuzzy
    expect(fuzzyTokenMatch('mocha', 'vanilla')).toBe(false)    // too far
  })
  it('one-sided flavor guard: a flavor on one side the other lacks → variant', () => {
    expect(isVariantRisk(itemTokens('Frappuccino Caramel'), itemTokens('Frappuccino Coffee'))).toBe(true)  // caramel unmatched
    expect(isVariantRisk(itemTokens('Frappuccino Mocha'), itemTokens('Frappuccino Mocha'))).toBe(false)
    expect(isVariantRisk(itemTokens('Pepsi Cherry'), itemTokens('Pepsi Wild Cherry'))).toBe(false)         // cherry both sides
  })
  const cands = [
    { id: '19', name: 'Starbucks frappuccino mocha' },
    { id: '20', name: 'Starbucks frappuccino Coffee' },
    { id: 'alani_nu_watermelon_wave', name: 'Alani Nu Watermelon Wave' },
  ].map((c) => ({ ...c, _tokens: itemTokens(c.name), _brand: brandOf(c.name) }))
  const plan = (n) => planAutoMap([{ name: n, matchName: normalizeSoldName(n) }], cands)

  it('spelling win auto-maps: Frappucino Mocha → mocha', () => {
    expect(plan('Starbucks, Coffee, Frappucino Mocha, 13.7 fl oz').auto[0]?.match.id).toBe('19')
  })
  it('de-space win auto-maps: AlaniNu Watermelon Wave → Alani Nu Watermelon Wave', () => {
    expect(plan('AlaniNu Watermelon Wave').auto[0]?.match.id).toBe('alani_nu_watermelon_wave')
  })
  it('Frappucino CARAMEL does NOT auto (flavor guard) → proposal, not auto', () => {
    const p = plan('Starbucks, Coffee, Frappucino Caramel, 9.5 fl oz')
    expect(p.auto).toHaveLength(0)
    expect(p.proposals.length).toBeGreaterThan(0)
  })
})

describe('B tier — brand-anchor relaxation, positional bTierSafe gate', () => {
  it('bTierSafe: leading vendor prefix → safe; mid discriminator / sold-extra → NOT safe', () => {
    expect(bTierSafe('Chicken Salad Sandwich Heartland Harvest', { name: 'Heartland Harvest - Chicken Salad Sandwich' })).toBe(true)   // exact tokens, order/vendor-position
    expect(bTierSafe('OS Cran Grape', { name: 'Oceanspray Cran Grape' })).toBe(true)                                                   // leading vendor "oceanspray"
    expect(bTierSafe('Chicken Salad and Crackers Heartland Harvest', { name: 'Heartland Harvest - Spicy - Chicken Salad with Crackers' })).toBe(false) // mid "spicy"
    expect(bTierSafe('Schweppes Ginger Ale', { name: 'Ginger Ale' })).toBe(false)                                                       // sold-side extra "schweppes"
  })
  const cands = [
    { id: 'hh_css', name: 'Heartland Harvest - Chicken Salad Sandwich' },
    { id: 'hh_spicy', name: 'Heartland Harvest - Spicy - Chicken Salad with Crackers' },
    { id: 'ginger_ale', name: 'Ginger Ale' },
    { id: 'life_water', name: 'Life Water 20oz' },
  ].map((c) => ({ ...c, _tokens: itemTokens(c.name), _brand: brandOf(c.name) }))
  const plan = (n) => planAutoMap([{ name: n, matchName: normalizeSoldName(n) }], cands)

  it('deli line auto-maps across brand position: Chicken Salad Sandwich → HH Chicken Salad Sandwich', () => {
    expect(plan('Chicken Salad Sandwich-Heartland Harvest').auto[0]?.match.id).toBe('hh_css')
  })
  it('word-order auto-maps: Water Life → Life Water', () => {
    expect(plan('1 L Water Life WTR_Still_Water').auto[0]?.match.id).toBe('life_water')
  })
  it('Spicy variant → PROPOSAL, not auto (mid-name discriminator)', () => {
    const p = plan('Chicken Salad and Crackers- Heartland Harvest')
    expect(p.auto).toHaveLength(0)
    expect(p.proposals.map((r) => r.match.id)).toContain('hh_spicy')
  })
  it('Schweppes Ginger Ale → PROPOSAL, not auto (sold-side brand extra)', () => {
    const p = plan('Pepsi, Soda, Schweppes Ginger Ale, 20 fl oz')
    expect(p.auto).toHaveLength(0)
    expect(p.proposals.map((r) => r.match.id)).toContain('ginger_ale')
  })
})
