/**
 * Multi-zone inventory UI LAYER (Phases 3 + 4) — the extractable logic.
 *
 * The one that matters most is countDisplay. A zoned item's in-memory
 * top-level is NOT its derived total: load() hydrates `eaches: c.eaches ?? 0`,
 * so an INCOMPLETE item — deliberately stored with a null total — comes back
 * as 0. Rendering item.eaches would print a confident "0" for an item whose
 * real on-hand is unknown, reintroducing the false-low at the very last step
 * after Phase 1 and Phase 2 both refused to produce one.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { hasCount } from '../src/hooks/useInventory'
import { isCounted } from '../src/lib/shrinkage'
import {
  countDisplay,
  flatHasCount,
  pendingZonesLabel,
  zoneProgress,
  derivedTotalEaches,
} from '../src/lib/zones'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const code = p => readFileSync(resolve(ROOT, p), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

const ZONES = [{ key: 'cooler', label: 'FOH cooler' }, { key: 'storage', label: 'BOH storage' }]
const zoned = (cooler, storage) => ({
  id: 'i1', name: 'Coke 20oz', qtyPerPack: 12,
  zones: { ...(cooler ? { cooler } : {}), ...(storage ? { storage } : {}) },
})

describe('countDisplay — the hydration trap', () => {
  it('an INCOMPLETE zoned item reports incomplete even though item.eaches is 0', () => {
    // Exactly what load() produces: stored null total → hydrated as 0.
    const hydrated = { ...zoned({ qty: 2, eaches: 3 }, null), qty: null, eaches: 0 }
    const d = countDisplay(hydrated, ZONES, [])
    expect(d.incomplete).toBe(true)
    expect(d.total).toBeNull()
    // The bug: trusting the hydrated field would render a confident 0.
    expect(hydrated.eaches).toBe(0)
    expect(d.total).not.toBe(0)
    expect(d.total).not.toBe(hydrated.eaches)
  })

  it('never reports a partial sum as the total', () => {
    const d = countDisplay(zoned({ qty: 2, eaches: 3 }, null), ZONES, [])
    expect(d.total).toBeNull()
    expect(d.total).not.toBe(27)
  })

  it('a COMPLETE zoned item reports its rollup and is not incomplete', () => {
    const d = countDisplay(zoned({ qty: 2, eaches: 3 }, { qty: 1, eaches: 5 }), ZONES, [])
    expect(d).toMatchObject({ zoned: true, incomplete: false, total: 44, pending: [] })
  })

  it('a swept-but-empty zone completes the item', () => {
    const d = countDisplay(zoned({ qty: 2, eaches: 3 }, null), ZONES, ['storage'])
    expect(d.incomplete).toBe(false)
    expect(d.total).toBe(27)
  })

  it('names the pending zones so the dash can explain itself', () => {
    const d = countDisplay(zoned({ qty: 2, eaches: 3 }, null), ZONES, [])
    expect(d.pending).toEqual(['storage'])
  })

  it('delegates to derivedTotalEaches rather than restating the rule', () => {
    const item = zoned({ qty: 2, eaches: 3 }, null)
    expect(countDisplay(item, ZONES, []).total).toBe(derivedTotalEaches(item, ZONES, []))
  })
})

describe('countDisplay — legacy records unchanged', () => {
  it('a counted flat record shows its value', () => {
    const d = countDisplay({ qty: 2, eaches: 3, qtyPerPack: 12 }, ZONES, [])
    expect(d).toMatchObject({ zoned: false, incomplete: false, total: 27, pending: [] })
  })

  it('an uncounted flat record is incomplete with no pending zones to blame', () => {
    const d = countDisplay({ qty: null, eaches: 0, qtyPerPack: 12 }, ZONES, [])
    expect(d).toMatchObject({ zoned: false, incomplete: true, total: null })
  })

  it('a counted-zero flat record (qty entered as 0) is a real 0, not incomplete', () => {
    const d = countDisplay({ qty: 0, eaches: 0, qtyPerPack: 12 }, ZONES, [])
    expect(d.incomplete).toBe(false)
    expect(d.total).toBe(0)
  })

  it('REGRESSION: an untouched item (eaches 0-defaulted by load) shows "—", not 0', () => {
    // load() hydrates `eaches: c.eaches ?? 0` and base rows start at 0, so
    // EVERY uncounted item carries eaches === 0. Resolving counted-ness with
    // isCounted (which treats an entered 0 as real) would print a confident
    // "0" on every untouched line in the table.
    const untouched = { qty: null, eaches: 0, qtyPerPack: 12 }
    expect(isCounted(untouched)).toBe(true)        // shrinkage's rule says counted…
    expect(flatHasCount(untouched)).toBe(false)    // …the display rule says no
    expect(countDisplay(untouched, ZONES, []).total).toBeNull()
  })

  it('flatHasCount matches useInventory.hasCount for flat records', () => {
    for (const it of [
      { qty: 1, eaches: 0 }, { qty: 0, eaches: 0 }, { qty: null, eaches: 3 },
      { qty: null, eaches: 0 }, { qty: null, eaches: null }, {},
    ]) {
      expect(flatHasCount(it), JSON.stringify(it)).toBe(hasCount(it))
    }
  })
})

describe('pendingZonesLabel — labels, not slugs', () => {
  it('names zones by label', () => {
    expect(pendingZonesLabel(['storage'], ZONES)).toBe('Not counted yet in: BOH storage')
  })
  it('joins several', () => {
    expect(pendingZonesLabel(['cooler', 'storage'], ZONES)).toBe('Not counted yet in: FOH cooler, BOH storage')
  })
  it('falls back to the key if a zone was deleted from config', () => {
    expect(pendingZonesLabel(['ghost'], ZONES)).toBe('Not counted yet in: ghost')
  })
  it('empty when nothing pending', () => {
    expect(pendingZonesLabel([], ZONES)).toBe('')
    expect(pendingZonesLabel(null, ZONES)).toBe('')
  })
})

describe('zoneProgress — the session header counter', () => {
  it('counts swept vs configured', () => {
    expect(zoneProgress(ZONES, [])).toEqual({ swept: 0, total: 2 })
    expect(zoneProgress(ZONES, ['cooler'])).toEqual({ swept: 1, total: 2 })
    expect(zoneProgress(ZONES, ['cooler', 'storage'])).toEqual({ swept: 2, total: 2 })
  })

  it('ignores swept keys that are no longer configured', () => {
    expect(zoneProgress(ZONES, ['cooler', 'ghost'])).toEqual({ swept: 1, total: 2 })
  })

  it('an unconfigured location reports the single implicit zone', () => {
    expect(zoneProgress(null, [])).toEqual({ swept: 0, total: 1 })
  })

  it('tolerates a junk swept list', () => {
    expect(zoneProgress(ZONES, null)).toEqual({ swept: 0, total: 2 })
    expect(zoneProgress(ZONES, 'nope')).toEqual({ swept: 0, total: 2 })
  })
})

describe('Phase 3 — markZoneSwept wiring', () => {
  const SRC = code('src/hooks/useInventory.js')

  it('writes zonesCompleted to the session doc with merge', () => {
    expect(SRC).toMatch(/zonesCompleted: next/)
    expect(SRC).toMatch(/markZoneSwept = useCallback/)
    const fn = SRC.slice(SRC.indexOf('const markZoneSwept'), SRC.indexOf('const setZoneValue'))
    expect(fn).toMatch(/inventorySessions/)
    expect(fn).toMatch(/\{ merge: true \}/)
  })

  it('supports UN-sweeping, so a withdrawn assertion returns items to incomplete', () => {
    const fn = SRC.slice(SRC.indexOf('const markZoneSwept'), SRC.indexOf('const setZoneValue'))
    expect(fn).toMatch(/current\.filter\(k => k !== zoneKey\)/)
  })

  it('is exported from the hook', () => {
    expect(SRC).toMatch(/^\s*markZoneSwept,/m)
    expect(SRC).toMatch(/^\s*setZoneValue,/m)
  })
})

describe('Phase 4 — per-zone entry never writes the derived top-level', () => {
  const SRC = code('src/hooks/useInventory.js')
  const fn = SRC.slice(SRC.indexOf('const setZoneValue'), SRC.indexOf('setDirty(true)', SRC.indexOf('const setZoneValue')))

  it('writes into item.zones[zoneKey], not item.qty/item.eaches', () => {
    expect(fn).toMatch(/zones: \{ \.\.\.\(item\.zones \|\| \{\}\), \[zoneKey\]:/)
    // must not assign the top-level fields
    expect(fn).not.toMatch(/^\s*qty,$/m)
    expect(fn).not.toMatch(/^\s*eaches,$/m)
  })

  it('preserves the raw typed string per zone (the 100x eaches guard)', () => {
    expect(fn).toMatch(/_\$\{field\}Raw`\]: value/)
  })

  it('only accepts qty or eaches', () => {
    expect(fn).toMatch(/field !== 'qty' && field !== 'eaches'/)
  })
})
