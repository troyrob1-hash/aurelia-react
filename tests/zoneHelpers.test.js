/**
 * Unit tests for the per-location inventory ZONE config layer (Phase 0).
 *
 * The one guarantee these pin is BACKWARD COMPATIBILITY: a location with no
 * zones doc must resolve to exactly ONE zone and look identical to today. Zones
 * only "turn on" once a manager adds a SECOND zone. If resolveZones /
 * isSingleDefaultZone ever stop treating an absent doc as a single zone, every
 * existing location sprouts zone UI it never asked for — the exact regression
 * this guards.
 *
 * Pure-function style, mirroring tests/itemCategory.test.js: import and call,
 * no Firestore, no React. Mutation-verified where a shared default could leak.
 */

import { describe, it, expect } from 'vitest'
import {
  PALETTE,
  slugify,
  uniqueKey,
  slugifyZone,
  getDefaultZones,
  resolveZones,
  isSingleDefaultZone,
  hasMultipleZones,
  DEFAULT_ZONE_KEY,
  DEFAULT_ZONE_LABEL,
} from '../src/lib/zoneHelpers'
import {
  PALETTE as CAT_PALETTE,
  slugify as catSlugify,
  uniqueKey as catUniqueKey,
} from '../src/lib/categoryHelpers'

describe('default zone set is a single implicit bucket', () => {
  it('getDefaultZones returns exactly one zone', () => {
    const zs = getDefaultZones()
    expect(Array.isArray(zs)).toBe(true)
    expect(zs).toHaveLength(1)
  })

  it('the single default zone carries the canonical key/label and a color pair', () => {
    const [z] = getDefaultZones()
    expect(z.key).toBe(DEFAULT_ZONE_KEY)
    expect(z.label).toBe(DEFAULT_ZONE_LABEL)
    expect(typeof z.color).toBe('string')
    expect(typeof z.bg).toBe('string')
  })

  it('returns a FRESH array each call — a caller mutating the result cannot poison the next default', () => {
    const a = getDefaultZones()
    a.push({ key: 'junk', label: 'Junk' })
    a[0].label = 'Mutated'
    const b = getDefaultZones()
    expect(b).toHaveLength(1)
    expect(b[0].label).toBe(DEFAULT_ZONE_LABEL)
  })
})

describe('resolveZones is the absent-doc backward-compat gate', () => {
  it('absent doc (null) resolves to the single default zone', () => {
    expect(resolveZones(null)).toHaveLength(1)
    expect(resolveZones(null)[0].key).toBe(DEFAULT_ZONE_KEY)
  })

  it('undefined (never read) resolves to the single default zone', () => {
    expect(resolveZones(undefined)).toHaveLength(1)
  })

  it('an empty array (malformed/cleared doc) resolves to the single default zone, never zero zones', () => {
    expect(resolveZones([])).toHaveLength(1)
  })

  it('a non-array (corrupt doc) resolves to the single default zone', () => {
    expect(resolveZones('garbage')).toHaveLength(1)
    expect(resolveZones(42)).toHaveLength(1)
    expect(resolveZones({})).toHaveLength(1)
  })

  it('a configured single zone is returned verbatim (manager set one custom zone)', () => {
    const custom = [{ key: 'walk_in', label: 'Walk-in', color: '#1e40af', bg: '#dbeafe' }]
    expect(resolveZones(custom)).toEqual(custom)
  })

  it('a configured multi-zone list is returned verbatim, in order', () => {
    const custom = [
      { key: 'front', label: 'Front of House', color: '#1e40af', bg: '#dbeafe' },
      { key: 'back', label: 'Back of House', color: '#b91c1c', bg: '#fee2e2' },
    ]
    expect(resolveZones(custom)).toEqual(custom)
  })

  it('does not mutate the stored array it is handed', () => {
    const custom = [{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }]
    const frozen = Object.freeze(custom.map(z => Object.freeze({ ...z })))
    expect(() => resolveZones(frozen)).not.toThrow()
    expect(resolveZones(frozen)).toHaveLength(2)
  })
})

describe('isSingleDefaultZone / hasMultipleZones — the UI gate', () => {
  it('absent doc is single-zone (no zone UI shows)', () => {
    expect(isSingleDefaultZone(null)).toBe(true)
    expect(isSingleDefaultZone(undefined)).toBe(true)
    expect(isSingleDefaultZone([])).toBe(true)
  })

  it('one configured zone is still single-zone', () => {
    expect(isSingleDefaultZone([{ key: 'main', label: 'Main' }])).toBe(true)
  })

  it('two or more zones flips the gate on', () => {
    const two = [{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }]
    expect(isSingleDefaultZone(two)).toBe(false)
    expect(hasMultipleZones(two)).toBe(true)
  })

  it('hasMultipleZones is the strict inverse of isSingleDefaultZone', () => {
    for (const z of [null, undefined, [], [{ key: 'a' }], [{ key: 'a' }, { key: 'b' }], [{ key: 'a' }, { key: 'b' }, { key: 'c' }]]) {
      expect(hasMultipleZones(z)).toBe(!isSingleDefaultZone(z))
    }
  })
})

describe('shared primitives are REUSED from categoryHelpers, not reimplemented', () => {
  it('re-exports the exact same PALETTE reference', () => {
    expect(PALETTE).toBe(CAT_PALETTE)
  })

  it('re-exports the exact same slugify + uniqueKey functions', () => {
    expect(slugify).toBe(catSlugify)
    expect(uniqueKey).toBe(catUniqueKey)
  })
})

describe('slugifyZone — zone-flavored keys off the shared slugifier', () => {
  it('slugifies a normal label the same way categories do', () => {
    expect(slugifyZone('Walk-in Cooler')).toBe('walk_in_cooler')
    expect(slugifyZone('Front of House')).toBe('front_of_house')
  })

  it('falls back to "zone" (not "category") when a label slugifies to empty', () => {
    expect(slugifyZone('!!!')).toBe('zone')
    expect(slugifyZone('')).toBe('zone')
  })

  it('pairs with uniqueKey to de-dupe against existing keys', () => {
    const existing = ['walk_in', 'walk_in_2']
    expect(uniqueKey(slugifyZone('Walk-in'), existing)).toBe('walk_in_3')
  })
})
