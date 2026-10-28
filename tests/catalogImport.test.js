/**
 * "Item list" (catalog) upload — file order + the file's own category.
 *
 * Before: every uploaded item had no shelf position, so byShelf put them all in
 * its "unplaced → A–Z" bucket — uploads always came out alphabetical — and any
 * category named in the file was ignored in favour of 5 inferred built-ins.
 * These tests drive buildCatalogImport (the code uploadCatalog runs) and then
 * the REAL display path (assignCategory → byShelf / buildCountSheets) to show
 * what the counter sees.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import {
  buildCatalogImport, resolveFileCategory, findCategoryHeader, catalogItemId, inferImportCategory,
} from '../src/lib/catalogImport'
import { assignCategory, getDefaultCategories } from '../src/hooks/useInventory'
import { buildCountSheets, byShelf } from '../src/lib/countSheets'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const code = p => readFileSync(resolve(ROOT, p), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

const CATS = getDefaultCategories()
const row = (name, extra = {}) => ({ Description: name, 'Pack Price': '$12.00', Vendor: 'sysco', ...extra })
const H = rows => Object.keys(rows[0])
// What load() + itemsWithMeta give the screen: data + a resolved category key.
const onScreen = (items, cats) => items.map(({ id, data }) => ({ id, ...data, _cat: assignCategory(data, cats) }))

describe('1. file order is preserved', () => {
  const rows = [row('Zebra Cakes'), row('Apple Slices'), row('Mango Chunks'), row('Banana Chips')]

  it('items are written in file order, stamped 1..N on both shelf fields', () => {
    const { items } = buildCatalogImport(rows, H(rows), CATS)
    expect(items.map(i => i.data.name)).toEqual(['Zebra Cakes', 'Apple Slices', 'Mango Chunks', 'Banana Chips'])
    expect(items.map(i => [i.data.catShelfOrder, i.data.flatShelfOrder])).toEqual([[1, 1], [2, 2], [3, 3], [4, 4]])
  })

  it('on screen and on the printed sheet they come out in FILE order, not A–Z', () => {
    const shown = onScreen(buildCatalogImport(rows, H(rows), CATS).items, CATS)
    expect([...shown].sort(byShelf('flatShelfOrder')).map(i => i.name))
      .toEqual(['Zebra Cakes', 'Apple Slices', 'Mango Chunks', 'Banana Chips'])
    // Each printed sheet lists its members in FILE order (they may be inferred
    // into different categories — order is kept within every one of them).
    const fileOrder = ['Zebra Cakes', 'Apple Slices', 'Mango Chunks', 'Banana Chips']
    const sheets = buildCountSheets(shown, CATS)
    expect(sheets.flatMap(s => s.rows).length).toBe(4)
    for (const sh of sheets) {
      const names = sh.rows.map(r => r.name)
      expect(names).toEqual(fileOrder.filter(n => names.includes(n)))
    }
  })

  it('skipped rows (section headers, instructions, totals) leave no gaps', () => {
    const mixed = [
      row('Beverages', { 'Pack Price': '' }),            // section header — no price
      row('Zebra Cakes'),
      row('Step 1: count everything'),                   // instruction row
      row('Apple Slices'),
      row('Grand Total'),
    ]
    const { items } = buildCatalogImport(mixed, H(mixed), CATS)
    expect(items.map(i => [i.data.name, i.data.catShelfOrder])).toEqual([['Zebra Cakes', 1], ['Apple Slices', 2]])
  })

  it('within each category, items keep file order', () => {
    const r = [
      row('Zed Soda', { Category: 'Coke Storage Closet' }),
      row('Ace Chips', { Category: 'Front Shelf' }),
      row('Bay Water', { Category: 'Coke Storage Closet' }),
      row('Ant Bar', { Category: 'Front Shelf' }),
    ]
    const imp = buildCatalogImport(r, H(r), CATS)
    const cats = [...CATS, ...imp.newCategories]
    const sheets = buildCountSheets(onScreen(imp.items, cats), cats)
    expect(sheets.find(s => s.label === 'Coke Storage Closet').rows.map(x => x.name)).toEqual(['Zed Soda', 'Bay Water'])
    expect(sheets.find(s => s.label === 'Front Shelf').rows.map(x => x.name)).toEqual(['Ace Chips', 'Ant Bar'])
  })
})

describe('2. the file\'s category is honored', () => {
  it('a new name creates the category and assigns items to it', () => {
    const r = [row('Coke 20oz', { Category: 'Coke Storage Closet' }), row('Diet Coke', { Category: 'Coke Storage Closet' })]
    const { items, newCategories } = buildCatalogImport(r, H(r), CATS)
    expect(newCategories).toHaveLength(1)                                    // created once, not per row
    expect(newCategories[0]).toMatchObject({ key: 'coke_storage_closet', label: 'Coke Storage Closet', keywords: [] })
    expect(newCategories[0].color).toMatch(/^#/)
    for (const i of items) expect(i.data).toMatchObject({ category: 'Coke Storage Closet', categoryExplicit: true })
    const cats = [...CATS, ...newCategories]
    expect(onScreen(items, cats).map(i => i._cat)).toEqual(['coke_storage_closet', 'coke_storage_closet'])
  })

  it('an existing name is REUSED — any capitalization, by key, or a built-in spelling', () => {
    expect(resolveFileCategory('beverages', CATS)).toEqual({ label: 'Beverages', key: 'beverages', isNew: false })
    expect(resolveFileCategory('  FROZEN ', CATS)).toEqual({ label: 'Frozen', key: 'frozen', isNew: false })
    expect(resolveFileCategory('bar_items', CATS).key).toBe('bar_items')
    // A label that doesn't slug to its key: only the case-insensitive LABEL match finds it.
    expect(resolveFileCategory('pantry / snacks', CATS)).toEqual({ label: 'Pantry / Snacks', key: 'pantry', isNew: false })
    expect(resolveFileCategory('Beverage', CATS).key).toBe('beverages')     // template singular
    expect(resolveFileCategory('Barista', CATS).key).toBe('bar_items')
    expect(resolveFileCategory('Snacks', CATS).key).toBe('pantry')
    const r = [row('Coke', { Category: 'beverages' })]
    expect(buildCatalogImport(r, H(r), CATS).newCategories).toEqual([])
  })

  it('a later row naming the just-created category in other case reuses it', () => {
    const r = [row('A', { Category: 'Coke Storage Closet' }), row('B', { Category: 'coke storage closet' })]
    const { items, newCategories } = buildCatalogImport(r, H(r), CATS)
    expect(newCategories).toHaveLength(1)
    expect(items.map(i => i.data.category)).toEqual(['Coke Storage Closet', 'Coke Storage Closet'])
  })

  it('"Dept", "Department" and "Item Type" headers work; "Category" wins; "Subcategory" is not a category', () => {
    expect(findCategoryHeader(['Description', 'Dept'])).toBe('Dept')
    expect(findCategoryHeader(['Description', 'Department'])).toBe('Department')
    expect(findCategoryHeader(['Description', 'Item Type'])).toBe('Item Type')
    expect(findCategoryHeader(['Item Type', 'Category'])).toBe('Category')
    expect(findCategoryHeader(['Description', 'Subcategory', 'Type'])).toBeNull()
  })

  it('FALLBACK: no category column → inferred, not explicit (exactly as before)', () => {
    const r = [row('Starbucks Pike Place'), row('Sriracha Packet')]
    const { items, newCategories, categoryHeader } = buildCatalogImport(r, H(r), CATS)
    expect(categoryHeader).toBeNull()
    expect(newCategories).toEqual([])
    expect(items.map(i => i.data.category)).toEqual([inferImportCategory('', '', 'Starbucks Pike Place'), inferImportCategory('', '', 'Sriracha Packet')])
    for (const i of items) expect(i.data).not.toHaveProperty('categoryExplicit')
  })

  it('FALLBACK: a blank value on one row infers that row only', () => {
    const r = [row('Coke', { Category: 'Coke Storage Closet' }), row('Sriracha Packet', { Category: '' })]
    const { items } = buildCatalogImport(r, H(r), CATS)
    expect(items.map(i => [i.data.category, !!i.data.categoryExplicit])).toEqual([['Coke Storage Closet', true], ['Condiments', false]])
  })
})

describe('3. duplicate ids — the first row wins', () => {
  it('a later row with the same id is skipped and reported; positions stay contiguous', () => {
    const r = [row('Coke 20oz', { 'Pack Price': '$10.00' }), row('Water'), row('Coke 20oz', { 'Pack Price': '$99.00' }), row('Tea')]
    const { items, duplicates } = buildCatalogImport(r, H(r), CATS)
    expect(items.map(i => [i.data.name, i.data.catShelfOrder])).toEqual([['Coke 20oz', 1], ['Water', 2], ['Tea', 3]])
    expect(items[0].data.packPrice).toBe(10)                                  // first row's data
    expect(duplicates).toEqual([{ id: 'coke_20oz', name: 'Coke 20oz' }])
  })

  it('names that slug to one id collide (the separate catalog-dedupe issue) — first still wins', () => {
    expect(catalogItemId('2 % milk gallon')).toBe(catalogItemId('2% Milk Gallon'))
    const r = [row('2 % milk gallon'), row('2% Milk Gallon')]
    expect(buildCatalogImport(r, H(r), CATS).items.map(i => i.data.name)).toEqual(['2 % milk gallon'])
  })
})

describe('wiring — replaceCatalog still uses buildCatalogImport and deletes-and-rebuilds', () => {
  // RAW source: the Step markers are comments, which code() strips.
  const INV = readFileSync(resolve(ROOT, 'src/routes/Inventory.jsx'), 'utf8')
  // uploadCatalog is now the MERGE path (see tests/catalogMerge.test.js) —
  // the old delete-and-rebuild behavior moved, unchanged, to replaceCatalog.
  const fn = INV.slice(INV.indexOf('async function replaceCatalog'), INV.indexOf("console.error('Catalog replace error:'"))

  it('maps rows with buildCatalogImport and writes each record in order', () => {
    expect(fn).toMatch(/buildCatalogImport\(rows, headers, categories/)
    expect(fn).toMatch(/for \(const \{ id, data \} of toWrite\)/)
  })

  it('creates new categories BEFORE the delete/rebuild and the item writes', () => {
    const create = fn.indexOf("'settings', 'categories'")
    expect(create).toBeGreaterThan(-1)
    expect(create).toBeLessThan(fn.indexOf('if (existingDocs.length) {'))
    expect(fn).toMatch(/setCategoriesLocal\(nextCats\)/)
  })

  it('still deletes every existing item then rewrites from the file (out of scope to change)', () => {
    expect(fn).toMatch(/delBatch\.delete\(fbDoc\(db, 'tenants', orgId, 'inventory', locKey, 'items', d\.id\)\)/)
  })
})
