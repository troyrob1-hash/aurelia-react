/**
 * Multi-zone inventory MODEL LAYER (Phase 1).
 *
 * The headline guarantee, and the reason this file exists: a partially-counted
 * item resolves to INCOMPLETE (null), never to the sum of only the zones
 * counted so far. Shrinkage is `expected − closing`, so an understated closing
 * is reported as physical loss — a false-low total would invent shrinkage on
 * real money with nothing on screen to show the number was partial. "Honest
 * incomplete over confident wrong", the same rule isCounted already enforces
 * for empty counts (see the W1 $61K-reappear bug).
 *
 * Pure-function style matching tests/itemCategory.test.js and
 * tests/zoneHelpers.test.js: import and call, no Firestore, no React.
 */

import { describe, it, expect } from 'vitest'
import {
  UNBUCKETED_KEY,
  hasBucketData,
  bucketHasEntry,
  bucketTotals,
  rollupBuckets,
  isBucketComplete,
  derivedTotalEaches,
  pendingBuckets,
} from '../src/lib/buckets'
import { countEaches, isCounted, buildCountMap, itemNameKey } from '../src/lib/shrinkage'

// A two-zone location, the shape resolveZones returns.
const ZONES = [
  { key: 'cooler', label: 'FOH cooler' },
  { key: 'storage', label: 'BOH storage' },
]

// 12-per-case product counted in both zones.
const zoned = (cooler, storage, qtyPerPack = 12) => ({
  id: 'i1', name: 'Coke 20oz', qtyPerPack,
  zones: {
    ...(cooler ? { cooler } : {}),
    ...(storage ? { storage } : {}),
  },
})

describe('THE HONESTY RULE — a partial count is incomplete, never a low total', () => {
  it('unswept zone with NO entry → incomplete, and NOT the partial sum', () => {
    // Cooler counted (2 cases + 3 singles = 27). Storage never touched and
    // never swept — its contents are UNKNOWN, not zero.
    const item = zoned({ qty: 2, eaches: 3 }, null)

    expect(isBucketComplete(item, ZONES, [])).toBe(false)
    expect(derivedTotalEaches(item, ZONES, [])).toBeNull()

    // The specific wrong answer this guards against: 27, the cooler alone.
    expect(derivedTotalEaches(item, ZONES, [])).not.toBe(27)
    // ...and it must not be ANY number.
    expect(typeof derivedTotalEaches(item, ZONES, [])).not.toBe('number')
  })

  it('names the blocking zone so the "—" can explain itself', () => {
    const item = zoned({ qty: 2, eaches: 3 }, null)
    expect(pendingBuckets(item, ZONES, [])).toEqual(['storage'])
  })

  it('stays incomplete when the OTHER zone is the pending one', () => {
    const item = zoned(null, { qty: 1, eaches: 0 })
    expect(isBucketComplete(item, ZONES, [])).toBe(false)
    expect(derivedTotalEaches(item, ZONES, [])).toBeNull()
    expect(derivedTotalEaches(item, ZONES, [])).not.toBe(12)
  })

  it('sweeping only the zone that already had an entry does NOT complete the item', () => {
    // Counter swept the cooler (where they entered a value) but never storage.
    const item = zoned({ qty: 2, eaches: 3 }, null)
    expect(isBucketComplete(item, ZONES, ['cooler'])).toBe(false)
    expect(derivedTotalEaches(item, ZONES, ['cooler'])).toBeNull()
  })

  it('three zones, two resolved, one pending → still incomplete', () => {
    const THREE = [...ZONES, { key: 'line', label: 'Line' }]
    const item = { id: 'i1', name: 'X', qtyPerPack: 6, zones: { cooler: { qty: 1 }, storage: { qty: 2 } } }
    expect(isBucketComplete(item, THREE, [])).toBe(false)
    expect(derivedTotalEaches(item, THREE, [])).toBeNull()
    expect(pendingBuckets(item, THREE, [])).toEqual(['line'])
  })
})

describe('swept + no entry → a REAL zero', () => {
  it('a swept empty zone contributes 0 and completes the item', () => {
    // Counter walked storage and the item genuinely was not there.
    const item = zoned({ qty: 2, eaches: 3 }, null)
    expect(isBucketComplete(item, ZONES, ['storage'])).toBe(true)
    expect(derivedTotalEaches(item, ZONES, ['storage'])).toBe(27)  // 2×12 + 3
    expect(pendingBuckets(item, ZONES, ['storage'])).toEqual([])
  })

  it('both zones swept with no entries at all → a real total of 0, not null', () => {
    const item = { id: 'i1', name: 'X', qtyPerPack: 12, zones: { cooler: { qty: null, eaches: null } } }
    expect(isBucketComplete(item, ZONES, ['cooler', 'storage'])).toBe(true)
    expect(derivedTotalEaches(item, ZONES, ['cooler', 'storage'])).toBe(0)
  })

  it('an entered 0 is a real count, not an absence — no sweep needed', () => {
    const item = zoned({ qty: 0, eaches: 0 }, { qty: 0, eaches: 0 })
    expect(bucketHasEntry(item.zones.cooler)).toBe(true)
    expect(isBucketComplete(item, ZONES, [])).toBe(true)
    expect(derivedTotalEaches(item, ZONES, [])).toBe(0)
  })
})

describe('bucketTotals / rollupBuckets arithmetic', () => {
  it('each zone = qty × qtyPerPack + eaches, using the ITEM pack size', () => {
    const item = zoned({ qty: 2, eaches: 3 }, { qty: 1, eaches: 5 }, 12)
    expect(bucketTotals(item)).toEqual({ cooler: 27, storage: 17 })
    expect(rollupBuckets(bucketTotals(item))).toBe(44)
  })

  it('defaults qtyPerPack to 1 when absent (matching countEaches)', () => {
    const item = { id: 'i', name: 'n', zones: { cooler: { qty: 4, eaches: 2 } } }
    expect(bucketTotals(item)).toEqual({ cooler: 6 })
  })

  it('a deleted zone still on the item is NOT silently dropped from the total', () => {
    // 'line' was removed from the location config but holds a real count.
    const item = { id: 'i', name: 'n', qtyPerPack: 10,
      zones: { cooler: { qty: 1 }, line: { qty: 2 } } }
    expect(rollupBuckets(bucketTotals(item))).toBe(30)
  })

  it('rollupBuckets is defensive about junk input', () => {
    expect(rollupBuckets(null)).toBe(0)
    expect(rollupBuckets(undefined)).toBe(0)
    expect(rollupBuckets({})).toBe(0)
    expect(rollupBuckets({ a: 'x', b: 2 })).toBe(2)
  })
})

describe('NO DOUBLE-COUNTING — top-level is an output once zones exist', () => {
  it('a zoned item with a denormalised top-level total sums its ZONES only', () => {
    // This is exactly what Phase 2 writes: zones + the derived total on top.
    // Reading both would report 88 instead of 44.
    const item = {
      id: 'i1', name: 'Coke 20oz', qtyPerPack: 12,
      qty: 3, eaches: 8,                                   // derived denormalisation (=44)
      zones: { cooler: { qty: 2, eaches: 3 }, storage: { qty: 1, eaches: 5 } },
    }
    expect(rollupBuckets(bucketTotals(item))).toBe(44)
    expect(derivedTotalEaches(item, ZONES, [])).toBe(44)
    expect(derivedTotalEaches(item, ZONES, [])).not.toBe(88)
  })

  it('bucketTotals never emits __unzoned for a zoned item', () => {
    const item = zoned({ qty: 1 }, { qty: 1 })
    expect(Object.keys(bucketTotals(item))).not.toContain(UNBUCKETED_KEY)
  })
})

describe('BACK-COMPAT — a legacy flat record is byte-identical to today', () => {
  const legacy = { id: 'i1', name: 'Coke 20oz', qty: 2, eaches: 3, qtyPerPack: 12 }

  it('has no zone data and is treated as the pre-zones record it is', () => {
    expect(hasBucketData(legacy)).toBe(false)
    expect(bucketTotals(legacy)).toEqual({ [UNBUCKETED_KEY]: 27 })
  })

  it('its rollup equals countEaches exactly', () => {
    expect(rollupBuckets(bucketTotals(legacy))).toBe(countEaches(legacy))
  })

  it('is complete iff isCounted says so — unchanged semantics', () => {
    expect(isBucketComplete(legacy, ZONES, [])).toBe(isCounted(legacy))
    expect(derivedTotalEaches(legacy, ZONES, [])).toBe(countEaches(legacy))
  })

  it('an UNCOUNTED legacy record is incomplete → null, exactly as today', () => {
    const blank = { id: 'i1', name: 'Coke 20oz', qty: null, eaches: null, qtyPerPack: 12 }
    expect(isCounted(blank)).toBe(false)
    expect(isBucketComplete(blank, ZONES, [])).toBe(false)
    expect(derivedTotalEaches(blank, ZONES, [])).toBeNull()
  })

  it('adding zones to the LOCATION does not retroactively break historical records', () => {
    // The regression that would otherwise mass-dash every past count the moment
    // a manager configures a second zone.
    expect(derivedTotalEaches(legacy, ZONES, [])).toBe(27)
    expect(derivedTotalEaches(legacy, [...ZONES, { key: 'line' }], [])).toBe(27)
  })

  it('flows through buildCountMap identically to a pre-zones world', () => {
    const viaShrinkage = buildCountMap([legacy])
    expect(viaShrinkage).toEqual({ [itemNameKey('Coke 20oz')]: 27 })
    expect(viaShrinkage[itemNameKey('Coke 20oz')]).toBe(rollupBuckets(bucketTotals(legacy)))
  })

  it('an empty zones map is treated as legacy, not as zero zones', () => {
    const emptyMap = { ...legacy, zones: {} }
    expect(hasBucketData(emptyMap)).toBe(false)
    expect(derivedTotalEaches(emptyMap, ZONES, [])).toBe(27)
  })
})

describe('derived total: equals the rollup when complete, null when not', () => {
  it('complete → exactly rollupBuckets(bucketTotals(item))', () => {
    const item = zoned({ qty: 2, eaches: 3 }, { qty: 1, eaches: 5 })
    expect(derivedTotalEaches(item, ZONES, [])).toBe(rollupBuckets(bucketTotals(item)))
  })

  it('incomplete → null even though a rollup is computable', () => {
    const item = zoned({ qty: 2, eaches: 3 }, null)
    expect(rollupBuckets(bucketTotals(item))).toBe(27)      // arithmetic exists…
    expect(derivedTotalEaches(item, ZONES, [])).toBeNull()  // …and is deliberately withheld
  })
})

describe('single-zone location behaves exactly like today', () => {
  const ONE = [{ key: 'default', label: 'Main' }]

  it('a zoned item in a one-zone location completes on its own entry', () => {
    const item = { id: 'i', name: 'n', qtyPerPack: 12, zones: { default: { qty: 2, eaches: 3 } } }
    expect(isBucketComplete(item, ONE, [])).toBe(true)
    expect(derivedTotalEaches(item, ONE, [])).toBe(27)
  })

  it('with no entry and no sweep it is incomplete — the same "—" as an uncounted item today', () => {
    const item = { id: 'i', name: 'n', qtyPerPack: 12, zones: { default: { qty: null, eaches: null } } }
    expect(derivedTotalEaches(item, ONE, [])).toBeNull()
  })

  it('an absent zones list resolves to the single default zone', () => {
    const item = { id: 'i', name: 'n', qtyPerPack: 12, zones: { default: { qty: 1 } } }
    expect(isBucketComplete(item, null, [])).toBe(true)
    expect(derivedTotalEaches(item, null, [])).toBe(12)
  })
})

describe('defensive inputs', () => {
  it('zonesCompleted may be null/undefined/garbage without throwing', () => {
    const item = zoned({ qty: 1 }, { qty: 1 })
    expect(() => isBucketComplete(item, ZONES, null)).not.toThrow()
    expect(() => isBucketComplete(item, ZONES, undefined)).not.toThrow()
    expect(() => isBucketComplete(item, ZONES, 'nope')).not.toThrow()
    expect(isBucketComplete(item, ZONES, null)).toBe(true)
  })

  it('hasBucketData rejects arrays and non-objects', () => {
    expect(hasBucketData({ zones: [] })).toBe(false)
    expect(hasBucketData({ zones: 'x' })).toBe(false)
    expect(hasBucketData({ zones: null })).toBe(false)
    expect(hasBucketData(null)).toBe(false)
  })

  it('a configured zone with no key is skipped rather than blocking forever', () => {
    const item = zoned({ qty: 1 }, { qty: 1 })
    expect(isBucketComplete(item, [...ZONES, {}], [])).toBe(true)
  })
})
