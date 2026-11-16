/**
 * Sheet button — the fold of the chip bar + Quick / Section / Zone / Full.
 *
 * The fold is only safe because count mode was purely a display filter: the
 * Sheet value must round-trip to the exact (countMode, activeCat, activeZone)
 * the old controls produced, and "Mark sheet done" must not depend on it.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { sheetState, sheetValue, sheetOptions, sheetButtonLabel } from '../src/lib/sheetPicker'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const code = p => readFileSync(resolve(ROOT, p), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

const hasCount = i => i.qty != null
const CATS = [{ key: 'bev', label: 'Beverages', color: '#f00' }, { key: 'snk', label: 'Snacks', color: '#0f0' }]
const ITEMS = [
  { id: 1, isKey: true, qty: 2 }, { id: 2, isKey: true, qty: null }, { id: 3, qty: 1 },
]

describe('sheet value ↔ count-mode state', () => {
  it('maps each choice to the state the old mode selector + chip produced', () => {
    expect(sheetState('all')).toEqual({ countMode: 'full', activeCat: 'all', activeZone: 'all' })
    expect(sheetState('key')).toEqual({ countMode: 'quick', activeCat: 'all', activeZone: 'all' })
    expect(sheetState('cat:bev')).toEqual({ countMode: 'section', activeCat: 'bev', activeZone: 'all' })
    expect(sheetState('zone:walkin')).toEqual({ countMode: 'zone', activeCat: 'all', activeZone: 'walkin' })
  })
  it('round-trips', () => {
    for (const v of ['all', 'key', 'cat:bev', 'zone:walkin']) expect(sheetValue(sheetState(v))).toBe(v)
  })
  it('old combinations still show a sensible current sheet (Full + a chip = that category)', () => {
    expect(sheetValue({ countMode: 'full', activeCat: 'snk', activeZone: 'all' })).toBe('cat:snk')
    expect(sheetValue({ countMode: 'zone', activeCat: 'all', activeZone: 'all' })).toBe('all')
  })
  it('a category key containing ":" survives', () => {
    expect(sheetState('cat:a:b').activeCat).toBe('a:b')
  })
})

describe('options + label', () => {
  const base = { items: ITEMS, categories: CATS, catStats: { bev: { counted: 31, total: 142 }, snk: { counted: 4, total: 4 } }, totals: { counted: 35, total: 146 }, hasCount }

  it('All items, Key items, then each category with counted/total and a check when complete', () => {
    const o = sheetOptions(base)
    expect(o.map(x => x.value)).toEqual(['all', 'key', 'cat:bev', 'cat:snk'])
    expect(o[1]).toMatchObject({ label: 'Key items', counted: 1, total: 2, complete: false })
    expect(o[3]).toMatchObject({ counted: 4, total: 4, complete: true })
    expect(o[2].complete).toBe(false)
  })
  it('an empty sheet is never "complete"', () => {
    expect(sheetOptions({ ...base, catStats: {} })[2].complete).toBe(false)
  })
  it('zones appear as a second group only when the location has 2+ zones', () => {
    const zones = [{ key: 'walkin', label: 'Walk-in' }, { key: 'dry', label: 'Dry' }]
    expect(sheetOptions({ ...base, zones, zonesOn: false }).some(x => x.group === 'zones')).toBe(false)
    const o = sheetOptions({ ...base, zones, zonesOn: true, zonesCompleted: ['dry'] }).filter(x => x.group === 'zones')
    expect(o.map(x => [x.value, x.complete])).toEqual([['zone:walkin', false], ['zone:dry', true]])
  })
  it('button reads "Beverages · 31 of 142"', () => {
    expect(sheetButtonLabel(sheetOptions(base)[2])).toBe('Beverages · 31 of 142')
    expect(sheetButtonLabel({ group: 'zones', label: 'Dry', complete: true })).toBe('Dry · swept')
  })
})

describe('the fold is clean — sheet-done does not read count mode', () => {
  it('Mark sheet done is gated on split items + session, never on countMode', () => {
    const INV = code('src/routes/Inventory.jsx')
    const at = INV.indexOf('markSectionComplete(cat.key, !isDone)')
    const block = INV.slice(INV.lastIndexOf('cat.items.some(isSplitItem)', at), at)
    expect(block).not.toMatch(/countMode/)
    expect(code('src/hooks/useInventory.js')).not.toMatch(/countMode/)
  })
  it('the old mode selector and chip bar are gone; the picker drives the same three states', () => {
    const INV = code('src/routes/Inventory.jsx')
    expect(INV).not.toMatch(/styles\.chipBar/)
    expect(INV).not.toMatch(/key: 'quick',\s+label: 'Quick'/)
    expect(INV).toMatch(/const next = sheetState\(value\)\s*setCountMode\(next\.countMode\)\s*setActiveCat\(next\.activeCat\)\s*setActiveZone\(next\.activeZone\)/)
  })
})
