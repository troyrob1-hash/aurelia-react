/**
 * Multi-zone inventory WRITE PATH (Phase 2).
 *
 * Three guarantees, in order of how expensive they'd be to get wrong:
 *
 *  1. HONESTY SURVIVES THE WRITE. The derived top-level is written only when
 *     the item is complete; an item with an unswept, unentered zone writes a
 *     NULL total, never the sum of the zones counted so far. Phase 1 refuses to
 *     compute the partial; Phase 2 must not reintroduce one on the way out.
 *
 *  2. NO CROSS-DEVICE ZONE CLOBBER. A zoned write merges, so zones.cooler and
 *     zones.storage written by two devices both survive. The pre-zones write is
 *     a whole-record set() whose own comment calls it "clean last-write-wins
 *     per item" — correct when an item was one value, destructive once an item
 *     is several. A source-level guard pins this, because the failure is
 *     invisible at runtime: the write succeeds, the other zone is just gone.
 *
 *  3. LEGACY IS BYTE-IDENTICAL. An item with no zones map writes exactly what
 *     it wrote before — same fields, same whole-record set, no merge.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { zonedTopLevel, itemValue, hasCount, touchedIdsToClear, zonesWrite } from '../src/hooks/useInventory'
import { derivedTotalEaches, rollupBuckets, bucketTotals } from '../src/lib/buckets'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const code = p => readFileSync(resolve(ROOT, p), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')
const SRC = code('src/hooks/useInventory.js')

const ZONES = [{ key: 'cooler', label: 'FOH cooler' }, { key: 'storage', label: 'BOH storage' }]
const zoned = (cooler, storage) => ({
  id: 'i1', name: 'Coke 20oz', qtyPerPack: 12, packPrice: 24,
  zones: { ...(cooler ? { cooler } : {}), ...(storage ? { storage } : {}) },
})

describe('1. the derived top-level never carries a partial', () => {
  it('incomplete item writes a NULL total, not the counted-zone sum', () => {
    const item = zoned({ qty: 2, eaches: 3 }, null)      // storage unswept, unentered
    const top = zonedTopLevel(item, ZONES, [])
    expect(top.eaches).toBeNull()
    expect(top.eaches).not.toBe(27)                      // the specific wrong answer
    expect(top.qty).toBeNull()
  })

  it('complete item writes the full rollup, in eaches, with qty null', () => {
    const item = zoned({ qty: 2, eaches: 3 }, { qty: 1, eaches: 5 })
    expect(zonedTopLevel(item, ZONES, [])).toEqual({ qty: null, eaches: 44 })
    expect(zonedTopLevel(item, ZONES, []).eaches).toBe(rollupBuckets(bucketTotals(item)))
  })

  it('a swept-but-empty zone completes the item and writes a real total', () => {
    const item = zoned({ qty: 2, eaches: 3 }, null)
    expect(zonedTopLevel(item, ZONES, ['storage'])).toEqual({ qty: null, eaches: 27 })
  })

  it('delegates to Phase 1 rather than restating the rule', () => {
    const item = zoned({ qty: 2, eaches: 3 }, null)
    expect(zonedTopLevel(item, ZONES, []).eaches)
      .toBe(derivedTotalEaches(item, ZONES, []))
  })
})

describe('2. zoned writes merge; legacy writes do not', () => {
  it('persistCountItems chooses merge per item via hasBucketData', () => {
    expect(SRC).toMatch(/merge:\s*hasBucketData\(c\)/)
  })

  it('the merge flag actually reaches batch.set as { merge: true }', () => {
    expect(SRC).toMatch(/if \(op\.merge\) batch\.set\(ref, op\.data, \{ merge: true \}\)/)
  })

  it('the legacy branch is still a whole-record set with NO merge', () => {
    expect(SRC).toMatch(/else batch\.set\(ref, op\.data\)/)
  })

  it('there is no unconditional whole-record set left for zoned items', () => {
    // Guards the regression: someone "simplifying" back to a single
    // batch.set(ref, op.data) would silently destroy concurrent zone writes.
    // Scoped to the COUNT writer (other batch.set calls write item definitions).
    const persist = SRC.slice(SRC.indexOf('export async function persistCountItems'), SRC.indexOf('export function touchedIdsToClear'))
    const sets = persist.match(/batch\.set\([^)]*\)/g) || []
    expect(sets).toHaveLength(2)                     // exactly the merge + legacy branch
    expect(sets.some(x => x.includes('merge: true'))).toBe(true)
  })

  it('clearing a zone uses deleteField, not a stored null', () => {
    // merge:true cannot remove by omission, and {qty:null} is NOT the same
    // state: an absent key means "not counted here" (completeness then depends
    // on the sweep), a stored null would read as an entry.
    expect(SRC).toMatch(/bucketHasEntry\(entry\)[\s\S]{0,120}deleteField\(\)/)
    expect(SRC).toMatch(/import \{[^}]*deleteField[^}]*\} from 'firebase\/firestore'/)
  })

  it('zones are only attached to the payload for zoned items', () => {
    // Behavioural (was a source match): persistCountItems spreads zonesWrite(c).
    expect(SRC).toMatch(/\.\.\.zonesWrite\(c\),/)
    expect(zonesWrite({ id: 'x', qty: 2, eaches: 0 })).toEqual({})
    expect(Object.keys(zonesWrite(zoned({ qty: 1, eaches: 0 }, null)))).toEqual(['zones'])
  })
})

describe('3. legacy write path is unchanged', () => {
  it('a flat record produces the same top-level it always did', () => {
    expect(zonedTopLevel({ qty: 2, eaches: 3 }, ZONES, [])).toEqual({ qty: 2, eaches: 3 })
    expect(zonedTopLevel({ qty: null, eaches: 5 }, ZONES, [])).toEqual({ qty: null, eaches: 5 })
    expect(zonedTopLevel({ qty: 0, eaches: 0 }, ZONES, [])).toEqual({ qty: 0, eaches: 0 })
  })

  it('coerces non-finite eaches to 0, as the original num() did', () => {
    expect(zonedTopLevel({ qty: null, eaches: 'x' }, ZONES, [])).toEqual({ qty: null, eaches: 0 })
    expect(zonedTopLevel({ qty: null, eaches: undefined }, ZONES, [])).toEqual({ qty: null, eaches: 0 })
  })

  it('is unaffected by zone config or sweeps', () => {
    const flat = { qty: 2, eaches: 3 }
    expect(zonedTopLevel(flat, ZONES, ['cooler', 'storage'])).toEqual({ qty: 2, eaches: 3 })
    expect(zonedTopLevel(flat, null, [])).toEqual({ qty: 2, eaches: 3 })
  })
})

describe('hasCount is zone-aware (filters newCounts AND deletions)', () => {
  it('a zoned item totalling 0 is still COUNTED — it must not be deleted', () => {
    // The trap: the derived total is 0, the old `eaches > 0` rule would call it
    // uncounted, it would be filtered out of newCounts and swept into
    // deletions — destroying real zone data for a genuine counted-zero.
    const item = zoned({ qty: 0, eaches: 0 }, { qty: 0, eaches: 0 })
    expect(derivedTotalEaches(item, ZONES, [])).toBe(0)
    expect(hasCount(item)).toBe(true)
  })

  it('an INCOMPLETE zoned item is counted, so its zones still persist', () => {
    const item = zoned({ qty: 2, eaches: 3 }, null)
    expect(zonedTopLevel(item, ZONES, []).eaches).toBeNull()
    expect(hasCount(item)).toBe(true)
  })

  it('a zoned item with no entries at all is NOT counted', () => {
    expect(hasCount({ id: 'i', zones: { cooler: { qty: null, eaches: null } } })).toBe(false)
  })

  it('legacy semantics unchanged', () => {
    expect(hasCount({ qty: 1 })).toBe(true)
    expect(hasCount({ qty: null, eaches: 3 })).toBe(true)
    expect(hasCount({ qty: null, eaches: 0 })).toBe(false)
    expect(hasCount({ qty: null, eaches: null })).toBe(false)
    expect(hasCount(null)).toBe(false)
  })
})

describe('touchedIdsToClear is zone-aware', () => {
  const persisted = [{ id: 'i1', qty: null, eaches: 27, zones: { cooler: { qty: 2, eaches: 3 } } }]

  it('clears when the zones are unchanged', () => {
    const latest = [{ id: 'i1', qty: null, eaches: 27, zones: { cooler: { qty: 2, eaches: 3 } } }]
    expect(touchedIdsToClear(new Set(['i1']), persisted, latest).has('i1')).toBe(true)
  })

  it('KEEPS the id when a zone was edited mid-await, even though the total matches', () => {
    // 3 cooler + 0 storage and 0 cooler + 3 storage share a total. Comparing
    // only qty/eaches would call this unchanged, clear the id, and the zone
    // edit would never be persisted.
    const latest = [{ id: 'i1', qty: null, eaches: 27, zones: { cooler: { qty: 2, eaches: 3 }, storage: { qty: 0, eaches: 0 } } }]
    expect(touchedIdsToClear(new Set(['i1']), persisted, latest).has('i1')).toBe(false)
  })

  it('KEEPS the id when a zone value changed under an identical NULL total', () => {
    // Both sides incomplete → both totals null → indistinguishable without
    // looking at the zones.
    const p = [{ id: 'i1', qty: null, eaches: null, zones: { cooler: { qty: 1, eaches: 0 } } }]
    const l = [{ id: 'i1', qty: null, eaches: null, zones: { cooler: { qty: 9, eaches: 0 } } }]
    expect(touchedIdsToClear(new Set(['i1']), p, l).has('i1')).toBe(false)
  })

  it('legacy (no zones either side) behaves exactly as before', () => {
    const p = [{ id: 'i1', qty: 2, eaches: 3 }]
    expect(touchedIdsToClear(new Set(['i1']), p, [{ id: 'i1', qty: 2, eaches: 3 }]).has('i1')).toBe(true)
    expect(touchedIdsToClear(new Set(['i1']), p, [{ id: 'i1', qty: 9, eaches: 3 }]).has('i1')).toBe(false)
  })

  it('gaining or losing zone data mid-await keeps the id', () => {
    const p = [{ id: 'i1', qty: 2, eaches: 3 }]
    const l = [{ id: 'i1', qty: null, eaches: 27, zones: { cooler: { qty: 2, eaches: 3 } } }]
    expect(touchedIdsToClear(new Set(['i1']), p, l).has('i1')).toBe(false)
  })
})

describe('itemValue — one shared construction, zone-aware', () => {
  it('values a complete zoned item at eachPrice × total', () => {
    const item = zoned({ qty: 2, eaches: 3 }, { qty: 1, eaches: 5 })   // 44 eaches, $2/each
    expect(itemValue(item, ZONES, [])).toBe(88)
  })

  it('is identical to the equivalent flat record — zoning changes no money', () => {
    const z = zoned({ qty: 2, eaches: 3 }, { qty: 1, eaches: 5 })
    const flat = { qtyPerPack: 12, packPrice: 24, qty: 3, eaches: 8 }   // also 44 eaches
    expect(itemValue(z, ZONES, [])).toBe(itemValue(flat, ZONES, []))
  })

  it('an incomplete zoned item contributes 0 — same as an uncounted item today', () => {
    const item = zoned({ qty: 2, eaches: 3 }, null)
    expect(itemValue(item, ZONES, [])).toBe(0)
    expect(itemValue({ qtyPerPack: 12, packPrice: 24, qty: null, eaches: 0 }, ZONES, [])).toBe(0)
  })

  it('legacy valuation is unchanged', () => {
    expect(itemValue({ qtyPerPack: 12, packPrice: 24, qty: 2, eaches: 3 }, ZONES, [])).toBe(54)
  })

  it('all three value sites share it — no copies left to drift', () => {
    expect(SRC).not.toMatch(/const packVal = /)
    expect((SRC.match(/itemValue\(/g) || []).length).toBeGreaterThanOrEqual(4)   // def + 3 sites
  })
})

describe('round-trip: stored zones hydrate back onto the item', () => {
  it('load attaches zones only when the stored doc carries them', () => {
    // Conditional attach (plus the stored total, used to detect a stale total on save).
    expect(SRC).toMatch(/\.\.\.\(c\.zones && Object\.keys\(c\.zones\)\.length \? \{ zones: c\.zones, _storedTotal: c\.eaches \?\? null \} : \{\}\)/)
  })
})
