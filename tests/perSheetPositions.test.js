/**
 * Per-sheet positions. An item counted on several category sheets (a split
 * item) has its own place on each: sheetShelfOrder[sheet], falling back to the
 * shared catShelfOrder — so existing data reads exactly as before with no
 * migration. A move on one sheet (drag, typed position, hand-add seeding)
 * writes only that sheet's entry; the home sheet too, so catShelfOrder stays
 * the fallback. Joining a sheet lands the item at that sheet's end.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { sheetPosition, byShelfOn, buildCountSheets } from '../src/lib/countSheets'
import {
  sheetShelfWrite, sheetReorderChanges, nextShelfPosition, planJoinedSheets,
  shelfMap, mergeShelfData, shelfWriteChunks, seedPatches, planMoveTo,
} from '../src/lib/shelfOrder'
import { applyItemPatches } from '../src/hooks/useInventory'
import { catalogLossSummary } from '../src/lib/catalogImport'
import { sheetCategoryKeys } from '../src/lib/buckets'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const code = p => readFileSync(resolve(ROOT, p), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

// Watermelon Fizz: home Beverages, also counted in the Coke closet.
const W = { id: 'w', name: 'Watermelon Fizz', _cat: 'bev', countCategories: ['bev', 'closet'], catShelfOrder: 2 }
const ITEMS = [
  { id: 'a', name: 'Apple Fizz', _cat: 'bev', catShelfOrder: 1 }, W, { id: 'c', name: 'Cola', _cat: 'bev', catShelfOrder: 3 },
  { id: 'q', name: 'Quince Soda', _cat: 'closet', catShelfOrder: 1 }, { id: 'r', name: 'Root Beer', _cat: 'closet', catShelfOrder: 3 },
]
const order = (items, key) => items.filter(i => sheetCategoryKeys(i).includes(key)).sort(byShelfOn(key)).map(i => i.id)
const apply = (items, changes) => applyItemPatches(items, Object.fromEntries(changes.map(c => [c.id, c.data])))

describe('sheetPosition — own entry, else the shared catShelfOrder', () => {
  it('no entry yet → catShelfOrder on every sheet (existing data unchanged, no migration)', () => {
    expect(sheetPosition(W, 'bev')).toBe(2)
    expect(sheetPosition(W, 'closet')).toBe(2)
  })
  it('an entry for this sheet wins, on that sheet only', () => {
    const w = { ...W, sheetShelfOrder: { closet: 7 } }
    expect(sheetPosition(w, 'closet')).toBe(7)
    expect(sheetPosition(w, 'bev')).toBe(2)
  })
  it('the home sheet can have its own entry too', () => {
    expect(sheetPosition({ ...W, sheetShelfOrder: { bev: 9 } }, 'bev')).toBe(9)
  })
  it('a one-sheet item ignores any (stale) entry — catShelfOrder is its position', () => {
    expect(sheetPosition({ id: 'x', _cat: 'bev', catShelfOrder: 4, sheetShelfOrder: { bev: 1 } }, 'bev')).toBe(4)
  })
  it('a non-numeric entry is ignored; nothing at all → null (bottom A-Z)', () => {
    expect(sheetPosition({ ...W, sheetShelfOrder: { bev: 'x' } }, 'bev')).toBe(2)
    expect(sheetPosition({ ...W, catShelfOrder: null }, 'closet')).toBeNull()
  })
})

describe('byShelfOn — the same item sits at different places on its two sheets', () => {
  it('orders each sheet by that sheet\'s positions, unpositioned last A-Z', () => {
    const w = { ...W, sheetShelfOrder: { closet: 0.5 } }
    const items = [...ITEMS.filter(i => i.id !== 'w'), w, { id: 'z', name: 'Aardvark', _cat: 'closet' }]
    expect(order(items, 'bev')).toEqual(['a', 'w', 'c'])
    expect(order(items, 'closet')).toEqual(['w', 'q', 'r', 'z'])
  })
})

describe('writes — split items get their sheet\'s entry, everyone else catShelfOrder', () => {
  it('sheetShelfWrite', () => {
    expect(sheetShelfWrite(W, 'closet', 4)).toEqual({ sheetShelfOrder: { closet: 4 } })
    expect(sheetShelfWrite(W, 'bev', 1)).toEqual({ sheetShelfOrder: { bev: 1 } })
    expect(sheetShelfWrite(ITEMS[0], 'bev', 3)).toEqual({ catShelfOrder: 3 })
  })

  it('drag / typed move on the home sheet: home entry written, catShelfOrder untouched, other sheet unchanged', () => {
    const changes = sheetReorderChanges(ITEMS, 'bev', planMoveTo(order(ITEMS, 'bev'), 'w', 1))
    expect(changes).toEqual([
      { id: 'w', pos: 1, data: { sheetShelfOrder: { bev: 1 } } },
      { id: 'a', pos: 2, data: { catShelfOrder: 2 } },
    ])
    const after = apply(ITEMS, changes)
    expect(order(after, 'bev')).toEqual(['w', 'a', 'c'])
    expect(order(after, 'closet')).toEqual(['q', 'w', 'r'])
    expect(after.find(i => i.id === 'w').catShelfOrder).toBe(2)
  })

  it('a move on the second sheet keeps the first sheet\'s entry (key-by-key merge, like merge:true)', () => {
    let items = apply(ITEMS, sheetReorderChanges(ITEMS, 'bev', planMoveTo(order(ITEMS, 'bev'), 'w', 1)))
    items = apply(items, sheetReorderChanges(items, 'closet', planMoveTo(order(items, 'closet'), 'w', 3)))
    expect(items.find(i => i.id === 'w').sheetShelfOrder).toEqual({ bev: 1, closet: 3 })
    expect(order(items, 'bev')).toEqual(['w', 'a', 'c'])
    expect(order(items, 'closet')).toEqual(['q', 'r', 'w'])
  })

  it('an unchanged sheet writes nothing (positions compared ON THIS SHEET, not catShelfOrder)', () => {
    const w = { ...W, catShelfOrder: 9, sheetShelfOrder: { closet: 2 } }
    const items = ITEMS.map(i => (i.id === 'w' ? w : i)).map(i => (i.id === 'r' ? { ...i, catShelfOrder: 3 } : i))
    expect(order(items, 'closet')).toEqual(['q', 'w', 'r'])
    expect(sheetReorderChanges(items, 'closet', ['q', 'w', 'r'])).toEqual([])
  })
})

describe('joining a sheet lands the item at that sheet\'s end', () => {
  it('a one-sheet item gaining a second sheet: end of the new sheet; its home keeps catShelfOrder', () => {
    const cola = ITEMS.find(i => i.id === 'c')
    const r = planJoinedSheets(ITEMS, cola, ['bev', 'closet'])
    expect(r.joined).toEqual(['closet'])
    // closet already holds q(1), w(2 via fallback), r(3) → Cola goes 4th.
    expect(r.itemMap).toEqual({ closet: 4 })
    expect(r.seedSets.flatMap(s => s.seeds)).toEqual([])
    const after = applyItemPatches(ITEMS, { c: { countCategories: ['bev', 'closet'], sheetShelfOrder: r.itemMap } })
    expect(order(after, 'closet')).toEqual(['q', 'w', 'r', 'c'])
    expect(order(after, 'bev')).toEqual(['a', 'w', 'c'])
  })
  it('unpositioned items on the joined sheet are numbered first, so "end" really is the end', () => {
    const items = [...ITEMS, { id: 'n', name: 'Nectar', _cat: 'closet' }]
    const r = planJoinedSheets(items, items.find(i => i.id === 'a'), ['bev', 'closet'])
    expect(r.seedSets.flatMap(s => s.seeds)).toEqual([{ id: 'n', pos: 4, data: { catShelfOrder: 4 } }])
    expect(r.itemMap).toEqual({ closet: 5 })
  })
  it('a split item gaining a third sheet: only the new sheet is planned', () => {
    const items = [...ITEMS, { id: 'm', name: 'Mint', _cat: 'fridge', catShelfOrder: 1 }]
    const r = planJoinedSheets(items, W, ['bev', 'closet', 'fridge'])
    expect(r.joined).toEqual(['fridge'])
    expect(r.itemMap).toEqual({ fridge: 2 })
  })
  it('leaving a sheet, or no change, plans nothing', () => {
    expect(planJoinedSheets(ITEMS, W, ['bev']).joined).toEqual([])
    expect(planJoinedSheets(ITEMS, W, ['bev', 'closet']).joined).toEqual([])
  })
  it('the edit-panel write stores membership AND the joined positions in one write, then patches local state', () => {
    const SRC = code('src/hooks/useInventory.js')
    const body = SRC.slice(SRC.indexOf('const setItemCountCategories = useCallback('), SRC.indexOf('const removeCategoriesFromItems'))
    expect(body).toMatch(/planJoinedSheets\(pool, \{ \.\.\.item, _cat: homeKey \}, stored\)/)
    expect(body).toMatch(/const payload = \{ countCategories: stored, \.\.\.\(joined\.length \? \{ sheetShelfOrder: itemMap \} : \{\}\) \}/)
    expect(body).toMatch(/shelfWriteChunks\(seedSets, \{ id: String\(itemId\), data: payload \}\)/)
    expect(body).toMatch(/applyItemPatches\(prev, \{ \.\.\.seedPatches\(seedSets\), \[itemId\]: \{ sheetShelfOrder: itemMap \} \}\)/)
  })
})

describe('hand-add / category-pick seeding is per-sheet too', () => {
  it('an unpositioned split item on the sheet is seeded into its entry for that sheet', () => {
    const w = { ...W, catShelfOrder: null }
    const r = nextShelfPosition([...ITEMS.filter(i => i.id !== 'w'), w], 'closet')
    expect(r.seeds).toEqual([{ id: 'w', pos: 4, data: { sheetShelfOrder: { closet: 4 } } }])
    expect(r.position).toBe(5)
  })
  it('seed writes and local patches carry the per-sheet entry and merge with flat seeds', () => {
    const sets = [
      { field: 'catShelfOrder', seeds: [{ id: 'w', pos: 4, data: { sheetShelfOrder: { closet: 4 } } }] },
      { field: 'flatShelfOrder', seeds: [{ id: 'w', pos: 9 }] },
    ]
    expect(shelfWriteChunks(sets, null)).toEqual([[{ id: 'w', data: { sheetShelfOrder: { closet: 4 }, flatShelfOrder: 9 } }]])
    expect(seedPatches(sets)).toEqual({ w: { sheetShelfOrder: { closet: 4 }, flatShelfOrder: 9 } })
  })
})

describe('helpers, load, upload, screen + print', () => {
  it('shelfMap keeps numeric entries only', () => {
    expect(shelfMap({ bev: 2, closet: '3', bad: 'x', nil: null })).toEqual({ bev: 2, closet: 3 })
    expect(shelfMap(null)).toEqual({})
    expect(shelfMap([1, 2])).toEqual({})
  })
  it('mergeShelfData merges sheetShelfOrder key by key and leaves other fields shallow', () => {
    expect(mergeShelfData({ sheetShelfOrder: { bev: 1 }, x: 1 }, { sheetShelfOrder: { closet: 2 }, x: 2 }))
      .toEqual({ sheetShelfOrder: { bev: 1, closet: 2 }, x: 2 })
  })
  it('applyItemPatches keeps other sheets\' entries and leaves untouched items as-is', () => {
    const items = [{ id: 'w', sheetShelfOrder: { bev: 1 } }, { id: 'o' }]
    const out = applyItemPatches(items, { w: { sheetShelfOrder: { closet: 5 } } })
    expect(out[0].sheetShelfOrder).toEqual({ bev: 1, closet: 5 })
    expect(out[1]).toBe(items[1])
  })
  it('every load path carries sheetShelfOrder (override wins on the master path)', () => {
    const SRC = code('src/hooks/useInventory.js')
    expect(SRC).toMatch(/sheetShelfOrder: shelfMap\(item\.sheetShelfOrder\),/)
    expect(SRC).toMatch(/sheetShelfOrder: shelfMap\(override\.sheetShelfOrder \?\? item\.sheetShelfOrder\),/)
    expect(SRC).toMatch(/sheetShelfOrder: shelfMap\(data\.sheetShelfOrder\),/)
  })
  it('the full-replace warning counts an item whose only position is per-sheet', () => {
    const doc = (id, data) => ({ id, data })
    expect(catalogLossSummary([doc('w', { sheetShelfOrder: { closet: 2 } })]).withPosition).toBe(1)
    expect(catalogLossSummary([doc('x', { sheetShelfOrder: {} })]).withPosition).toBe(0)
  })
  it('printed count sheets use each sheet\'s own order', () => {
    const w = { ...W, sheetShelfOrder: { closet: 0.5 } }
    const items = ITEMS.map(i => (i.id === 'w' ? w : i))
    const cats = [{ key: 'bev', label: 'Beverages' }, { key: 'closet', label: 'Coke Storage Closet' }]
    const sheets = buildCountSheets(items, cats)
    expect(sheets.find(s => s.key === 'bev').rows.map(r => r.name)).toEqual(['Apple Fizz', 'Watermelon Fizz', 'Cola'])
    expect(sheets.find(s => s.key === 'closet').rows.map(r => r.name)).toEqual(['Watermelon Fizz', 'Quince Soda', 'Root Beer'])
  })
})
