/**
 * COUNT READERS + EXPORT — Stage 1 prerequisites for multi-category.
 *
 * A zoned item's top-level qty is null by construction (its total lives in
 * eaches, derived from zones), so every reader that used item.qty — variance,
 * Prior, days-on-hand, par, the Why panel, the export — saw it as 0. These
 * tests pin the replacements AND that legacy items read exactly as before.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import {
  itemTotalEaches, itemCountQty, storedCountQty, storedRecordValue,
} from '../src/lib/zones'
import { qtyOf, calcParStatus, getTopVarianceIssues } from '../src/lib/variance'
import { itemValue, pathBCount } from '../src/hooks/useInventory'
import { inventoryExportRow } from '../src/lib/inventoryExport'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const code = p => readFileSync(resolve(ROOT, p), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

const ZONES = [{ key: 'cooler' }, { key: 'storage' }]
// 12 per pack, $24 pack → $2 each. Cooler 2 packs + 3 = 27; storage 1 pack + 1 = 13 → 40 eaches.
const zoned = { id: 'z', name: 'Oat milk', qtyPerPack: 12, packPrice: 24, qty: null, eaches: 0,
  zones: { cooler: { qty: 2, eaches: 3 }, storage: { qty: 1, eaches: 1 } } }
const partial = { ...zoned, zones: { cooler: { qty: 2, eaches: 3 } } }
const legacy = { id: 'l', name: 'Gum', qtyPerPack: 10, unitCost: 0.5, qty: 3, eaches: 4 }   // packPrice $5

describe('itemTotalEaches / itemCountQty — zoned items are no longer 0', () => {
  it('complete zoned item: total in eaches, and the same in packs', () => {
    expect(itemTotalEaches(zoned, ZONES, [])).toBe(40)
    expect(itemCountQty(zoned, ZONES, [])).toBe(3.33)          // 40 / 12, 2 dp
  })
  it('incomplete zoned item: null (the honesty rule), never the partial', () => {
    expect(itemTotalEaches(partial, ZONES, [])).toBeNull()
    expect(itemCountQty(partial, ZONES, [])).toBeNull()
    expect(itemCountQty(partial, ZONES, ['storage'])).toBe(2.25) // swept → complete: 27 / 12
  })
  it('LEGACY reads exactly as before: item.qty, null preserved', () => {
    expect(itemCountQty(legacy, ZONES, [])).toBe(3)
    expect(itemCountQty({ ...legacy, qty: null }, ZONES, [])).toBeNull()
    expect(itemTotalEaches(legacy, ZONES, [])).toBe(34)
    expect(itemTotalEaches({ id: 'u', qty: null, eaches: 0 }, ZONES, [])).toBeNull()   // uncounted
  })
})

describe('storedCountQty / storedRecordValue — prior periods and snapshot rows', () => {
  it('a stored zoned record: its stored eaches IS the total', () => {
    expect(storedCountQty({ qtyPerPack: 12, qty: null, eaches: 40, zones: { cooler: {} } })).toBe(3.33)
    expect(storedCountQty({ qtyPerPack: 12, qty: null, eaches: null, zones: { cooler: {} } })).toBeNull()
  })
  it('a stored legacy record: rec.qty, unchanged', () => {
    expect(storedCountQty({ qty: 4, eaches: 9 })).toBe(4)
    expect(storedCountQty(undefined)).toBeNull()
  })
  it('storedRecordValue == itemValue for legacy AND zoned records', () => {
    expect(storedRecordValue(legacy)).toBe(itemValue(legacy, ZONES, []))      // 3×$5 + 4×$0.50 = $17
    expect(storedRecordValue({ ...zoned, eaches: 40 })).toBe(itemValue(zoned, ZONES, []))   // $80
  })
  it('the Why panel values rows with it (not qty × unitCost)', () => {
    const W = code('src/lib/whyRules.js')
    expect(W).toMatch(/const curValue = storedRecordValue\(i\)/)
    expect(W).toMatch(/const priorValue = pr \? storedRecordValue\(pr\) : 0/)
    expect(W).not.toMatch(/\(i\.qty \|\| 0\) \* \(i\.unitCost \|\| 0\)/)
  })
})

describe('variance / par readers', () => {
  const enriched = { ...zoned, _countQty: 3.33, _priorQty: 1, unitCost: 2, parLevel: 5, reorderPoint: 4 }
  it('qtyOf prefers the enriched count, falls back to item.qty', () => {
    expect(qtyOf(enriched)).toBe(3.33)
    expect(qtyOf({ ...enriched, _countQty: null })).toBeNull()
    expect(qtyOf(legacy)).toBe(3)
  })
  it('par status reads the zoned count (was 0 → "critical")', () => {
    expect(calcParStatus(enriched).qty).toBe(3.33)
    expect(calcParStatus(enriched).status).toBe('critical')     // 3.33 < reorder 4: real, not phantom
    expect(calcParStatus({ ...enriched, _countQty: 4.5 }).status).toBe('low')
  })
  it('top-variance uses the zoned count as "actual"', () => {
    const [top] = getTopVarianceIssues([{ ...enriched, _countQty: 9 }], 1)
    expect(top.actual).toBe(9)
  })
  it('no direct item.qty reads remain in variance.js', () => {
    expect(code('src/lib/variance.js')).not.toMatch(/\b(item|a|b)\.qty\b/)
  })
})

describe('itemsWithMeta enrichment routes through the helpers', () => {
  const SRC = code('src/hooks/useInventory.js')
  const block = SRC.slice(SRC.indexOf('const prior = priorItems.find'), SRC.indexOf('_totalEaches: itemTotalEaches'))
  it('variance, days-on-hand, par and reorder read the zone-aware count', () => {
    expect(block).toMatch(/const countQty = itemCountQty\(item, zones, zonesSwept\)/)
    expect(block).toMatch(/const priorQty = storedCountQty\(prior\) \|\| 0/)
    expect(block).not.toMatch(/item\.qty/)
    expect(block).not.toMatch(/prior\?\.qty/)
  })
  it('a zoned prior never double-shows its total as loose eaches', () => {
    expect(block).toMatch(/const priorEaches = hasZoneData\(prior\) \? 0 : \(prior\?\.eaches \|\| 0\)/)
  })
  it('exposes _countQty and _totalEaches', () => {
    expect(SRC).toMatch(/_countQty: countQty,/)
    expect(SRC).toMatch(/_totalEaches: itemTotalEaches\(item, zones, zonesSwept\),/)
  })
})

describe('Path B snapshot rows', () => {
  it('legacy row unchanged; zoned row carries the derived total, not the in-memory top-level', () => {
    expect(pathBCount(legacy, ZONES, [])).toEqual({ qty: 3, eaches: 4 })
    expect(pathBCount({ ...zoned, eaches: 999 }, ZONES, [])).toEqual({ qty: null, eaches: 40 })
    expect(pathBCount(partial, ZONES, [])).toEqual({ qty: null, eaches: 0 })   // incomplete → $0, like closing
  })
  it('both Path B writes use it', () => {
    const SRC = code('src/hooks/useInventory.js')
    expect((SRC.match(/\.\.\.pathBCount\(i, zonesRef\.current, zonesCompletedRef\.current\),/g) || []).length).toBe(2)
  })
})

describe('Excel export — closing value matches the app', () => {
  it('Closing Value is the item\'s _value (itemValue), not qty × unitCost', () => {
    const l = { ...legacy, _value: itemValue(legacy, ZONES, []), _countQty: 3 }
    expect(inventoryExportRow(l)['Closing Value']).toBe('17.00')              // was 3 × 0.50 = 1.50
    const z = { ...zoned, _value: itemValue(zoned, ZONES, []), _countQty: 3.33 }
    expect(inventoryExportRow(z)['Closing Value']).toBe('80.00')              // was $0
    expect(inventoryExportRow(z)['Closing']).toBe(3.33)
  })
  it('legacy Closing quantity is item.qty, exactly as before', () => {
    expect(inventoryExportRow({ ...legacy, _countQty: 3 })['Closing']).toBe(3)
    expect(inventoryExportRow({ ...legacy })['Closing']).toBe(3)             // un-enriched fallback
  })
  it('one row per item, built by the shared function; "Items Counted" uses the count-cell rule', () => {
    const INV = code('src/routes/Inventory.jsx')
    expect(INV).toMatch(/const toRow = inventoryExportRow/)
    expect(INV).toMatch(/const rows = displayGroups\.flatMap\(g => g\.items\.map\(toRow\)\)/)
    expect(INV).toMatch(/filter\(i => !countDisplay\(i, zones, zonesCompleted\)\.incomplete\)\.length/)
  })
})

describe('Inventory.jsx display readers', () => {
  const INV = code('src/routes/Inventory.jsx')
  it('confidence, low-stock, par card and the Why panel read qtyOf', () => {
    expect(INV).toMatch(/const q = qtyOf\(item\)\n\s*if \(q == null \|\| q === 0\) return null/)
    expect(INV).toMatch(/const qty = qtyOf\(item\) \|\| 0\n\s*const minStock/)
    expect(INV).toMatch(/<span className=\{styles\.parQty\}>\{qtyOf\(item\) \|\| 0\}<\/span>/)
    expect(INV).toMatch(/const cur = qtyOf\(item\)/)
  })
})
