/**
 * Hand-placed items get an END position, not A-Z.
 *
 * Before: only the Item list upload and Arrange mode wrote catShelfOrder /
 * flatShelfOrder. A hand-added item, or one moved to a category in the edit
 * panel, had no position, and byShelf sorts position-less items to the bottom
 * A-Z — so HDK's hand-built "BiBs" sheet (Oct 2026) always read alphabetically.
 * The upload-order test (PR #6) never caught it: it only exercised the upload.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { planShelfAppend, nextShelfPosition, nextFlatPosition, shelfWriteChunks, seedPatches } from '../src/lib/shelfOrder'
import { byShelf } from '../src/lib/countSheets'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const code = p => readFileSync(resolve(ROOT, p), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

// An item on a sheet as the screen sees it: _cat = resolved home key.
const it_ = (id, name, cat = 'bibs', extra = {}) => ({ id, name, _cat: cat, catShelfOrder: null, flatShelfOrder: null, ...extra })

// Apply a plan + the placed item, then sort the sheet exactly as the screen does.
function placeAndSort(items, placed, sheetKey) {
  const { seeds, position } = nextShelfPosition(items, sheetKey)
  const seeded = items.map(i => {
    const s = seeds.find(x => x.id === i.id)
    return s ? { ...i, catShelfOrder: s.pos } : i
  })
  const all = [...seeded, { ...placed, _cat: sheetKey, catShelfOrder: position }]
  return all.filter(i => i._cat === sheetKey || (i.countCategories || []).includes(sheetKey)).sort(byShelf('catShelfOrder')).map(i => i.name)
}

describe('THE CASE THE UPLOAD TEST MISSED — a hand-added/assigned item gets an end position, not A-Z', () => {
  it('on a never-arranged sheet (all null — HDK BiBs), the new item lands LAST even though it sorts first A-Z', () => {
    const sheet = [it_('a', 'BIB Coke 5 gal'), it_('b', 'BIB Sprite'), it_('c', 'BIB Brisk Iced Tea')]
    const order = placeAndSort(sheet, it_('new', 'AAA First Alphabetically'), 'bibs')
    expect(order.at(-1)).toBe('AAA First Alphabetically')
    // and the existing items keep exactly the order they already showed (A-Z)
    expect(order.slice(0, 3)).toEqual(['BIB Brisk Iced Tea', 'BIB Coke 5 gal', 'BIB Sprite'])
  })

  it('on an arranged sheet, the new item lands after the highest position', () => {
    const sheet = [it_('a', 'Zed', 'bibs', { catShelfOrder: 1 }), it_('b', 'Alpha', 'bibs', { catShelfOrder: 2 })]
    expect(placeAndSort(sheet, it_('new', 'Aardvark'), 'bibs')).toEqual(['Zed', 'Alpha', 'Aardvark'])
  })

  it('three items added one after another keep ADD order, not A-Z', () => {
    let sheet = [it_('a', 'Mango', 'bibs', { catShelfOrder: 1 })]
    for (const [id, name] of [['x', 'Zebra'], ['y', 'Apple'], ['z', 'Kiwi']]) {
      const { position } = nextShelfPosition(sheet, 'bibs')
      sheet = [...sheet, it_(id, name, 'bibs', { catShelfOrder: position })]
    }
    expect([...sheet].sort(byShelf('catShelfOrder')).map(i => i.name)).toEqual(['Mango', 'Zebra', 'Apple', 'Kiwi'])
  })

  it('contrast — the OLD behavior (no position) would have sorted it A-Z, first', () => {
    const sheet = [it_('a', 'BIB Coke', 'bibs', { catShelfOrder: 1 }), it_('new', 'AAA', 'bibs')]
    expect([...sheet].sort(byShelf('catShelfOrder')).map(i => i.name)).toEqual(['BIB Coke', 'AAA'])
    const allNull = [it_('a', 'BIB Coke'), it_('new', 'AAA')]
    expect([...allNull].sort(byShelf('catShelfOrder'))[0].name).toBe('AAA')   // the bug: first, A-Z
  })
})

describe('planShelfAppend — never disturbs arranged items', () => {
  it('positioned members are NEVER in the seed list', () => {
    const { seeds } = planShelfAppend([
      { id: 'p1', name: 'Z', catShelfOrder: 4 }, { id: 'n1', name: 'B', catShelfOrder: null },
      { id: 'p2', name: 'A', catShelfOrder: 9 }, { id: 'n2', name: 'A', catShelfOrder: null },
    ], 'catShelfOrder')
    expect(seeds.map(s => s.id).sort()).toEqual(['n1', 'n2'])
  })

  it('unpositioned members are numbered after the max, in their current display order (A-Z)', () => {
    const r = planShelfAppend([
      { id: 'p', name: 'Mid', catShelfOrder: 5 },
      { id: 'c', name: 'Cherry', catShelfOrder: null }, { id: 'a', name: 'apple', catShelfOrder: null },
    ], 'catShelfOrder')
    expect(r.seeds).toEqual([{ id: 'a', pos: 6 }, { id: 'c', pos: 7 }])
    expect(r.position).toBe(8)
  })

  it('a fully arranged sheet needs no seeds — just max+1', () => {
    expect(planShelfAppend([{ id: 'a', name: 'a', catShelfOrder: 3 }, { id: 'b', name: 'b', catShelfOrder: 7 }], 'catShelfOrder'))
      .toEqual({ seeds: [], position: 8 })
  })

  it('an empty sheet starts at 1', () => {
    expect(planShelfAppend([], 'catShelfOrder')).toEqual({ seeds: [], position: 1 })
  })

  it('split members count toward the max but are never seeded (shared position across sheets)', () => {
    const r = planShelfAppend([
      { id: 's', name: 'Split', catShelfOrder: 12, _split: true },
      { id: 'sn', name: 'Split Null', catShelfOrder: null, _split: true },
      { id: 'n', name: 'Plain Null', catShelfOrder: null },
    ], 'catShelfOrder')
    expect(r.seeds).toEqual([{ id: 'n', pos: 13 }])
    expect(r.position).toBe(14)
  })
})

describe('nextShelfPosition — sheet membership is the screen\'s rule', () => {
  it('items on OTHER sheets neither raise the max nor get seeded', () => {
    const items = [it_('o', 'Other', 'coffee', { catShelfOrder: 99 }), it_('o2', 'Other Null', 'coffee'), it_('b', 'Mine', 'bibs', { catShelfOrder: 2 })]
    expect(nextShelfPosition(items, 'bibs')).toEqual({ seeds: [], position: 3 })
  })

  it('a split item counted on this sheet raises the max (lands after it) but is not seeded', () => {
    const split = it_('s', 'Split', 'coffee', { catShelfOrder: 40, countCategories: ['coffee', 'bibs'] })
    const r = nextShelfPosition([split, it_('b', 'Mine', 'bibs')], 'bibs')
    expect(r.seeds).toEqual([{ id: 'b', pos: 41 }])
    expect(r.position).toBe(42)
  })

  it('excludeId: the item being moved is not counted as already on the sheet', () => {
    const items = [it_('m', 'Mover', 'bibs', { catShelfOrder: 50 }), it_('b', 'Mine', 'bibs', { catShelfOrder: 1 })]
    expect(nextShelfPosition(items, 'bibs', { excludeId: 'm' }).position).toBe(2)
  })

  it('removed items are ignored', () => {
    expect(nextShelfPosition([it_('r', 'Gone', 'bibs', { catShelfOrder: 80, removed: true })], 'bibs').position).toBe(1)
  })
})

describe('nextFlatPosition — the flat list, same rule', () => {
  it('appends after the flat max, numbering unpositioned items first in A-Z', () => {
    const r = nextFlatPosition([
      { id: 'a', name: 'Beta', flatShelfOrder: 2 }, { id: 'b', name: 'zulu', flatShelfOrder: null }, { id: 'c', name: 'Alpha', flatShelfOrder: null },
    ])
    expect(r).toEqual({ seeds: [{ id: 'c', pos: 3 }, { id: 'b', pos: 4 }], position: 5 })
  })
})

describe('shelfWriteChunks / seedPatches', () => {
  it('merges cat+flat seeds for the same item into ONE write, placed item LAST', () => {
    const chunks = shelfWriteChunks([
      { field: 'catShelfOrder', seeds: [{ id: 'a', pos: 3 }] },
      { field: 'flatShelfOrder', seeds: [{ id: 'a', pos: 9 }, { id: 'b', pos: 10 }] },
    ], { id: 'new', data: { name: 'New' } })
    expect(chunks).toEqual([[
      { id: 'a', data: { catShelfOrder: 3, flatShelfOrder: 9 } },
      { id: 'b', data: { flatShelfOrder: 10 } },
      { id: 'new', data: { name: 'New' } },
    ]])
  })

  it('chunks at the batch limit with the placed item in the final chunk', () => {
    const seeds = Array.from({ length: 5 }, (_, i) => ({ id: `s${i}`, pos: i + 1 }))
    const chunks = shelfWriteChunks([{ field: 'flatShelfOrder', seeds }], { id: 'new', data: {} }, 2)
    expect(chunks.map(c => c.length)).toEqual([2, 2, 2])
    expect(chunks.at(-1).at(-1).id).toBe('new')
  })

  it('seedPatches mirrors the writes for local state', () => {
    expect(seedPatches([{ field: 'catShelfOrder', seeds: [{ id: 'a', pos: 3 }] }, { field: 'flatShelfOrder', seeds: [{ id: 'a', pos: 9 }] }]))
      .toEqual({ a: { catShelfOrder: 3, flatShelfOrder: 9 } })
  })
})

describe('wiring', () => {
  it('addCustomItem gives the new item an end position on its sheet AND in the flat list, in the same write', () => {
    const SRC = code('src/hooks/useInventory.js')
    const fn = SRC.slice(SRC.indexOf('const addCustomItem = useCallback'), SRC.indexOf('const [removedItems, setRemovedItems]'))
    expect(fn).toMatch(/nextShelfPosition\(pool, assignCategory\(newItem, categories\)\)/)
    expect(fn).toMatch(/nextFlatPosition\(pool\)/)
    expect(fn).toMatch(/newItem\.catShelfOrder = catPlan\.position/)
    expect(fn).toMatch(/newItem\.flatShelfOrder = flatPlan\.position/)
    expect(fn).toMatch(/shelfWriteChunks\(seedSets, \{ id: customId, data: newItem \}\)/)
    // pool carries _cat, or sheet membership resolves to nothing
    expect(fn).toMatch(/_cat: assignCategory\(i, categories\)/)
  })

  it('edit-panel pick: a real change on a non-split item goes through assignCategoryAtEnd; otherwise the old write', () => {
    const SRC = code('src/routes/Inventory.jsx')
    expect(SRC).toMatch(/if \(catKey !== item\._cat && !isSplitItem\(item\)\) \{\s*await assignCategoryAtEnd\(item\.id, catKey, catLabel\)\s*\} else \{\s*await saveEditField\(item\.id, 'category', catLabel, \{ categoryExplicit: true \}\)/)
  })

  it('assignCategoryAtEnd writes category AND position in ONE payload on the item doc', () => {
    const SRC = code('src/routes/Inventory.jsx')
    const fn = SRC.slice(SRC.indexOf('const assignCategoryAtEnd = useCallback'), SRC.indexOf('const assignCategoryAtEnd = useCallback') + 1600)
    expect(fn).toMatch(/const payload = \{ category: catLabel, categoryExplicit: true, catShelfOrder: position \}/)
    expect(fn).toMatch(/shelfWriteChunks\(seedSets, \{ id: String\(itemId\), data: payload \}\)/)
    expect(fn).toMatch(/nextShelfPosition\(items, catKey, \{ excludeId: itemId \}\)/)
  })
})
