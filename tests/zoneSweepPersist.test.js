/**
 * Zone sweep PERSISTENCE + the Save & Close guard.
 *
 * THE BUG (shipped in 92bd286): markZoneSwept updated the session's swept list
 * and nothing else. A sweep changes an item's completeness — and so its derived
 * total — without anyone touching the item, so the stored count doc kept the
 * total it was last saved with. For an item saved while a zone was unswept that
 * is null, and the server-side valuation (functions/index.js) reads ONLY the
 * stored top-level qty/eaches, so it priced the item at $0. On a CF-authoritative
 * location that is a false-low closing → phantom shrinkage, with the screen
 * showing the right number the whole time.
 *
 * The headline test below runs the real sweepTotalUpdates + persistDerivedTotals
 * against a fake count store and values it with the CF's own expression (pinned
 * to functions/index.js so the emulation can't drift).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

vi.mock('firebase/firestore', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    doc: vi.fn((col, id) => ({ col, id })),
    updateDoc: vi.fn(async () => {}),
    serverTimestamp: () => 'SERVER_TS',
  }
})

import { updateDoc } from 'firebase/firestore'
import {
  sweepTotalUpdates, persistDerivedTotals, zonedTopLevel, itemValue, countDocId,
} from '../src/hooks/useInventory'
import { closeOutIssues, closeOutWarningText } from '../src/lib/buckets'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const code = p => readFileSync(resolve(ROOT, p), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

const ZONES = [{ key: 'cooler', label: 'FOH cooler' }, { key: 'storage', label: 'BOH storage' }]
const item = (id, name, zones) => ({ id, name, qtyPerPack: 12, packPrice: 24, zones })  // eachPrice $2

// Coke: cooler counted (2 packs + 3 = 27 eaches = $54), storage blank.
// Chips: counted in both zones — the sweep can't change it.
// Water: storage counted, cooler blank — sweeping STORAGE can't complete it.
const ITEMS = [
  item('coke', 'Coke 20oz', { cooler: { qty: 2, eaches: 3 } }),
  item('chips', 'Chips', { cooler: { qty: 1, eaches: 0 }, storage: { qty: 0, eaches: 4 } }),
  item('water', 'Water', { storage: { qty: 1, eaches: 0 } }),
]

// The CF's valuation, verbatim from functions/index.js (pinned below).
function cfClosing(store) {
  let closingValue = 0
  for (const c of Object.values(store)) {
    const qty = Number(c.qty) || 0
    const eaches = Number(c.eaches) || 0
    const qpp = Number(c.qtyPerPack) || 1
    const uc = Number(c.unitCost) || 0
    const pp = Number(c.packPrice) || (qpp * uc)
    const eachPrice = qpp > 0 ? pp / qpp : uc
    closingValue += qty * pp + eaches * eachPrice
  }
  return closingValue
}

// Count docs as saveCounts wrote them while nothing was swept.
function storeSavedWith(items, swept) {
  const store = {}
  for (const i of items) {
    store[countDocId(i.id)] = { ...zonedTopLevel(i, ZONES, swept), qtyPerPack: i.qtyPerPack, packPrice: i.packPrice, zones: i.zones }
  }
  return store
}

// Apply captured updateDoc calls to the fake store (updateDoc = field merge).
function applyUpdates(store) {
  for (const [ref, data] of updateDoc.mock.calls) Object.assign(store[ref.id], data)
}

const clientClosing = (items, swept) => items.reduce((s, i) => s + itemValue(i, ZONES, swept), 0)

beforeEach(() => updateDoc.mockClear())

describe('HEADLINE — a sweep reaches the server-side valuation', () => {
  it('sweep: the CF closing goes from the pre-sweep false-low to the client closing', async () => {
    const store = storeSavedWith(ITEMS, [])
    // Pre-sweep: Coke and Water are incomplete → null totals → CF prices them at $0.
    expect(cfClosing(store)).toBe(clientClosing(ITEMS, []))

    const next = ['storage']
    // The bug, made concrete: without re-persisting, the CF stays where it was
    // while the screen moves to include Coke's $54.
    expect(clientClosing(ITEMS, next) - cfClosing(store)).toBe(54)

    await persistDerivedTotals({}, sweepTotalUpdates(ITEMS, 'storage', ZONES, next), 'me')
    applyUpdates(store)
    expect(cfClosing(store)).toBe(clientClosing(ITEMS, next))
    expect(store[countDocId('coke')].eaches).toBe(27)
  })

  it('un-sweep: the CF closing goes back down, and the item is incomplete again', async () => {
    const store = storeSavedWith(ITEMS, ['storage'])
    expect(cfClosing(store)).toBe(clientClosing(ITEMS, ['storage']))

    await persistDerivedTotals({}, sweepTotalUpdates(ITEMS, 'storage', ZONES, []), 'me')
    applyUpdates(store)
    expect(store[countDocId('coke')].eaches).toBeNull()
    expect(cfClosing(store)).toBe(clientClosing(ITEMS, []))
  })

  it('the emulated valuation is the one functions/index.js actually runs', () => {
    const CF = readFileSync(resolve(ROOT, 'functions/index.js'), 'utf8')
    expect(CF).toContain('const qty = Number(c.qty) || 0;')
    expect(CF).toContain('const eaches = Number(c.eaches) || 0;')
    expect(CF).toContain('const pp = Number(c.packPrice) || (qpp * uc);')
    expect(CF).toContain('const eachPrice = qpp > 0 ? pp / qpp : uc;')
    expect(CF).toContain('closingValue += qty * pp + eaches * eachPrice;')
  })
})

describe('sweepTotalUpdates — only the totals the sweep can change', () => {
  it('returns items with a count elsewhere and no entry in the swept zone', () => {
    const ups = sweepTotalUpdates(ITEMS, 'storage', ZONES, ['storage'])
    expect(ups.map(u => u.id)).toEqual(['coke'])
    expect(ups[0]).toEqual({ id: 'coke', qty: null, eaches: 27 })
  })

  it('sweeping the other zone completes the mirror-image item', () => {
    expect(sweepTotalUpdates(ITEMS, 'cooler', ZONES, ['cooler'])).toEqual([{ id: 'water', qty: null, eaches: 12 }])
  })

  it('an affected item whose total stays null (a third zone still open) writes null, never a partial', () => {
    const Z3 = [...ZONES, { key: 'freezer', label: 'Freezer' }]
    const ups = sweepTotalUpdates([ITEMS[0]], 'storage', Z3, ['storage'])
    expect(ups).toEqual([{ id: 'coke', qty: null, eaches: null }])
    expect(ups[0].eaches).not.toBe(27)
  })

  it('skips legacy flat records and zoned items with no entries', () => {
    const flat = { id: 'f', qty: 3, eaches: 0, qtyPerPack: 1, packPrice: 1 }
    const empty = item('e', 'Empty', { cooler: { qty: null, eaches: null } })
    expect(sweepTotalUpdates([flat, empty], 'storage', ZONES, ['storage'])).toEqual([])
  })

  it('carries no zones map — it must never rewrite zone entries', () => {
    for (const u of sweepTotalUpdates(ITEMS, 'storage', ZONES, ['storage'])) {
      expect(Object.keys(u).sort()).toEqual(['eaches', 'id', 'qty'])
    }
  })
})

describe('persistDerivedTotals — top-level only, tolerant of unsaved items', () => {
  it('writes exactly qty/eaches + attribution via updateDoc, keyed by countDocId', async () => {
    await persistDerivedTotals({}, [{ id: 'a/b', qty: null, eaches: 5 }], 'me@x')
    expect(updateDoc).toHaveBeenCalledTimes(1)
    const [ref, data] = updateDoc.mock.calls[0]
    expect(ref.id).toBe(countDocId('a/b'))
    expect(data).toEqual({ qty: null, eaches: 5, updatedAt: 'SERVER_TS', updatedBy: 'me@x' })
  })

  it('a not-found doc (typed, not yet autosaved) is not reported as a failure', async () => {
    updateDoc
      .mockRejectedValueOnce(Object.assign(new Error('x'), { code: 'not-found' }))
      .mockRejectedValueOnce(Object.assign(new Error('y'), { code: 'permission-denied' }))
    const r = await persistDerivedTotals({}, [{ id: 1, eaches: 1 }, { id: 2, eaches: 2 }, { id: 3, eaches: 3 }], 'me')
    expect(r).toEqual({ written: 1, failed: 1, writtenIds: ['3'] })
  })
})

describe('markZoneSwept / markSectionComplete wiring (shared markBucketDone)', () => {
  const SRC = code('src/hooks/useInventory.js')
  const fn = SRC.slice(SRC.indexOf('const markBucketDone'), SRC.indexOf('const markSectionComplete'))

  it('re-persists totals computed with the POST-toggle swept list', () => {
    expect(fn).toMatch(/sweepTotalUpdates\(itemsRef\.current, bucketKey, zonesRef\.current, nextDone\)/)
    expect(fn).toMatch(/persistDerivedTotals\(/)
  })

  it('updates the done list synchronously, before any await', () => {
    const sync = fn.indexOf('bucketsDoneRef.current = nextDone')
    expect(sync).toBeGreaterThan(-1)
    expect(sync).toBeLessThan(fn.indexOf('await'))
  })

  it('persists totals only AFTER the session write succeeds, and rolls back on failure', () => {
    expect(fn.indexOf('persistDerivedTotals(')).toBeGreaterThan(fn.indexOf('inventorySessions'))
    expect(fn).toMatch(/catch[\s\S]*setSession\(prevSession\)[\s\S]*bucketsDoneRef\.current = prevDone[\s\S]*return/)
  })

  it('marks dirty so autosave refreshes the client closing, and respects the period lock', () => {
    expect(fn).toMatch(/setDirty\(true\)/)
    expect(fn).toMatch(/if \(blockedByLock\(\)\) return/)
  })
})

describe('closeOutIssues — what Save & Close would lock in as incomplete', () => {
  it('splits partly-counted, not-counted, and unswept zones', () => {
    const items = [...ITEMS, { id: 'flat', name: 'Gum', qty: null, eaches: 0 }]
    const r = closeOutIssues(items, ZONES, [])
    expect(r.partial).toEqual([
      { name: 'Coke 20oz', pending: ['storage'] },
      { name: 'Water', pending: ['cooler'] },
    ])
    expect(r.notCounted).toEqual(['Gum'])
    expect(r.unsweptZones).toEqual(['cooler', 'storage'])
    expect(r.any).toBe(true)
  })

  it('agrees with the sweep: a swept zone stops blocking', () => {
    const r = closeOutIssues(ITEMS, ZONES, ['storage'])
    expect(r.partial.map(p => p.name)).toEqual(['Water'])
    expect(r.unsweptZones).toEqual(['cooler'])
  })

  it('a single-zone location never mentions zones (no sweep UI there)', () => {
    const r = closeOutIssues([{ id: 1, name: 'Gum', qty: null, eaches: 0 }], null, [])
    expect(r.unsweptZones).toEqual([])
    expect(r.notCounted).toEqual(['Gum'])
  })

  it('nothing to warn about when everything is counted and swept', () => {
    const r = closeOutIssues([ITEMS[1]], ZONES, ['cooler', 'storage'])
    expect(r.any).toBe(false)
    expect(closeOutWarningText(r, ZONES)).toBe('')
  })
})

describe('closeOutWarningText — names things, by label, readably', () => {
  it('names zones by label and partial items with their pending zone', () => {
    const t = closeOutWarningText(closeOutIssues(ITEMS, ZONES, []), ZONES)
    expect(t).toContain('2 zones not swept: FOH cooler, BOH storage')
    expect(t).toContain('Coke 20oz (not counted in BOH storage)')
    expect(t).toContain('$0')
  })

  it('caps long lists with "and N more"', () => {
    const many = Array.from({ length: 12 }, (_, k) => ({ id: k, name: `Item ${k}`, qty: null, eaches: 0 }))
    const t = closeOutWarningText(closeOutIssues(many, null, []), null)
    expect(t).toContain('12 items have no count')
    expect(t).toContain('Item 7 and 4 more')
    expect(t).not.toContain('Item 8')
  })
})

describe('Save & Close guard wiring + dead code removed', () => {
  const INV = code('src/routes/Inventory.jsx')
  const fn = INV.slice(INV.indexOf('const handleSaveAndClose'), INV.indexOf('const handleApplyUpload'))

  it('builds the warning before saving or locking, and puts it in the confirm', () => {
    const warn = fn.indexOf('closeOutWarningText(closeOutIssues(items, zones, bucketsDone), zones, 8, categories)')
    expect(warn).toBeGreaterThan(-1)
    expect(warn).toBeLessThan(fn.indexOf('window.confirm('))
    expect(fn.indexOf('window.confirm(')).toBeLessThan(fn.indexOf('await save()'))
    expect(fn).toMatch(/warning\s*\?\s*`\$\{warning\}/)
  })

  it('closeInventoryCount and handleCloseTab are gone', () => {
    expect(INV).not.toMatch(/closeInventoryCount/)
    expect(INV).not.toMatch(/handleCloseTab/)
    expect(INV).not.toMatch(/tabClosed/)
  })
})
