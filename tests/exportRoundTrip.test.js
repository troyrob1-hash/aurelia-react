// Aurelia's own export → Upload item list round trip.
//
// Export a site (the real buildExportWorkbook / buildExportCsv), read the file
// back exactly as the upload does (readCatalogWorkbook), then:
//   - Replace onto an empty site → the same sheets (order, keys, colors), the
//     same items on each sheet in the same order, the same two-sheet
//     membership, the same definition fields;
//   - "Add and update" onto the SAME site → nothing to write.
// Plus the existing guarantees: merge never writes membership/positions onto
// an existing item; the zero-item guard; Replace's backup + named confirm.

import { describe, it, expect, vi } from 'vitest'
import * as XLSX from 'xlsx'

vi.mock('firebase/firestore', () => import('./helpers/fakeFirestore.js'))
vi.mock('@/lib/firebase', () => ({ db: {}, auth: {} }))
vi.mock('@/store/authStore', () => ({ useAuthStore: { getState: () => ({ user: { tenantId: 'fooda' } }) } }))

import { assignCategory, getDefaultCategories } from '../src/hooks/useInventory'
import { sheetCategoryKeys } from '../src/lib/buckets'
import { byShelf, byShelfOn } from '../src/lib/countSheets'
import { inventoryExportRow, exportItemsInSheetOrder, buildExportCsv, buildExportWorkbook } from '../src/lib/inventoryExport'
import { readCatalogWorkbook } from '../src/lib/catalogFile'
import { runCatalogReplace, buildCatalogMerge, catalogFileError, parseAlsoOn, formatAlsoOn } from '../src/lib/catalogImport'

const CATS = [
  { key: 'beverages', label: 'Coffee Bar', color: '#1e40af', bg: '#dbeafe', keywords: [] },
  { key: 'dairy', label: 'Coke Cooler 1', color: '#0369a1', bg: '#e0f2fe', keywords: ['coke'] },
  { key: 'coke_closet', label: 'Coke Closet', color: '#374151', bg: '#f3f4f6', keywords: [] },
  { key: 'chips_cubby', label: 'Chips, Cubby', color: '#92400e', bg: '#fef3c7', keywords: ['chip', 'lays'] },
  { key: 'empty_sheet', label: 'Empty Sheet', color: '#64748b', bg: '#f1f5f9', keywords: [] },
  // Its label is a built-in alias (snacks → pantry): only an EXPLICIT category keeps an item here.
  { key: 'snack_shelf', label: 'Snacks', color: '#15803d', bg: '#dcfce7', keywords: [] },
]
const base = { isCatalogItem: true, active: true, qty: null, packSize: 'case', qtyPerPack: 24, packPrice: 24, unitCost: 1, vendor: 'Coca-Cola', glCode: '12000', glCodeFull: '12000 - Inventory - Cafeteria', sellingPrice: 0, cogsRatio: 0, itemType: '', sku: '' }
const DOCS = [
  // Two sheets, with a position on the second; key item, par level.
  { id: '500ml_mexican_coke', data: { ...base, name: '500mL Mexican Coke', category: 'Coke Cooler 1', categoryExplicit: true, countCategories: ['dairy', 'coke_closet'], sheetShelfOrder: { coke_closet: 13 }, catShelfOrder: 4, flatShelfOrder: 38, packSize: 'EACH', packPrice: 33.17, unitCost: 1.3821, sku: '0126689', sellingPrice: 33.17, cogsRatio: 0.3, isKey: true, parLevel: 6 } },
  // Home by alias ("Beverages" → the beverages key, labelled Coffee Bar); no positions (A–Z).
  { id: 'sprite_20oz', data: { ...base, name: 'Sprite 20oz', category: 'Beverages' } },
  { id: 'apple_juice', data: { ...base, name: 'Apple Juice', category: 'Coffee Bar', categoryExplicit: true, catShelfOrder: 1, flatShelfOrder: 2 } },
  // Counted on two sheets but NOT on its own home sheet.
  { id: 'coke_zero', data: { ...base, name: 'Coke Zero', category: 'Coke Cooler 1', categoryExplicit: true, countCategories: ['coke_closet', 'chips_cubby'], sheetShelfOrder: { coke_closet: 2 }, catShelfOrder: 1, flatShelfOrder: 5 } },
  { id: 'coke_classic', data: { ...base, name: 'Coke Classic', category: 'Coke Cooler 1', categoryExplicit: true, catShelfOrder: 2, flatShelfOrder: 4 } },
  // Same name, two items; a label with a comma; a zero-cost item.
  { id: 'lays_classic', data: { ...base, name: 'Lays Classic', category: 'Chips, Cubby', categoryExplicit: true, catShelfOrder: 2, flatShelfOrder: 3, vendor: 'Frito-Lay', glCode: '12000' } },
  { id: 'lays_classic_2', data: { ...base, name: 'Lays Classic', category: 'Chips, Cubby', categoryExplicit: true, catShelfOrder: 1, flatShelfOrder: 1, vendor: 'Frito-Lay, Inc.', itemType: 'Snack' } },
  { id: 'napkins', data: { ...base, name: 'Napkins', category: 'Chips, Cubby', categoryExplicit: true, packPrice: 0, unitCost: 0, catShelfOrder: 3 } },
  // A custom item on two sheets (no position on the second → falls back to its own).
  { id: 'custom_1791376417432_h9shw', data: { name: 'Stir Sticks', custom: true, category: 'Coffee Bar', countCategories: ['beverages', 'coke_closet'], catShelfOrder: 7, flatShelfOrder: 9, packSize: 'CS', qtyPerPack: 5000, packPrice: 41.51, unitCost: 0, vendor: 'Sysco', glCode: '50431' } },
  { id: 'trail_mix', data: { ...base, name: 'Trail Mix', category: 'Snacks', categoryExplicit: true, catShelfOrder: 1, flatShelfOrder: 6 } },
  // Hidden: not on any sheet, not exported.
  { id: 'old_hidden', data: { ...base, name: 'Old Hidden', category: 'Coffee Bar', removed: true } },
]

// What the app works with: active items, each with its home sheet (_cat).
const withHome = (docs, cats) => docs.filter(d => !d.data.removed).map(d => ({ id: d.id, ...d.data, _cat: assignCategory(d.data, cats) }))
// What the app SHOWS: each sheet's items in order, and the flat (A–Z view) order.
const view = (items, cats) => ({
  sheets: cats.map(c => ({ sheet: c.label, items: items.filter(i => sheetCategoryKeys(i).includes(c.key)).sort(byShelfOn(c.key)).map(i => i.id) })),
  flat: [...items].sort(byShelf('flatShelfOrder')).map(i => i.id),
})
const DEF = ['name', 'sku', 'packSize', 'qtyPerPack', 'packPrice', 'unitCost', 'vendor', 'glCode', 'glCodeFull', 'sellingPrice', 'cogsRatio', 'itemType']
// glCodeFull falls back to glCode wherever the app reads it (and in merge's sameDefinition).
const definition = (d) => Object.fromEntries(DEF.map(f => [f, f === 'glCodeFull' ? (d.glCodeFull ?? d.glCode ?? '')
  : d[f] ?? (['packPrice', 'unitCost', 'sellingPrice', 'cogsRatio'].includes(f) ? 0 : '')]))

function exportFiles(docs = DOCS, cats = CATS) {
  const items = withHome(docs, cats)
  const rows = exportItemsInSheetOrder(items, cats).map(i => inventoryExportRow(i, null, cats))
  const args = { locationLabel: 'Source Site', periodKey: '2026-P11-W3', exportedAt: 'x', totals: { totalItems: rows.length, itemsCounted: 0, totalClosingValue: 0, needsReorder: 0 }, rows, categories: cats }
  const xlsx = XLSX.read(XLSX.write(buildExportWorkbook(XLSX, { ...args, catRows: [{ Category: 'TOTAL' }] }), { type: 'array', bookType: 'xlsx' }))
  const csv = XLSX.read(buildExportCsv(args), { type: 'string', raw: true })
  return { items, rows, xlsx, csv }
}

async function replaceOntoEmpty(file) {
  const parsed = readCatalogWorkbook(file)
  const written = { items: [], categories: null, deleted: null, backup: null, confirmed: null }
  const result = await runCatalogReplace(
    { rows: parsed.rows, headers: parsed.headers, existingDocs: [], categories: getDefaultCategories(), sheetList: parsed.sheetList, meta: { importedAt: 't', importedBy: 'test' } },
    {
      confirm: async (summary, n) => { written.confirmed = { summary, n }; return true },
      backup: async (docs) => { written.backup = docs },
      saveCategories: async (c) => { written.categories = c },
      deleteItems: async (docs) => { written.deleted = docs },
      writeItems: async (items) => { written.items = items },
    })
  return { parsed, result, written }
}

describe.each([['xlsx', 'xlsx'], ['csv', 'csv']])('export (%s) → Replace onto an empty site', (_label, kind) => {
  it('reads the item list (not Summary, not the report lines) and its sheet list', () => {
    const f = exportFiles()[kind]
    const p = readCatalogWorkbook(f)
    expect(p.error).toBeNull()
    expect(p.bestSheet).toBe(kind === 'xlsx' ? 'Inventory Count' : f.SheetNames[0])
    expect(p.headers.slice(0, 2)).toEqual(['Item', 'Category'])
    expect(p.rows.filter(r => String(r.Item || '').trim())).toHaveLength(10)   // the CSV's totals line has no item
    expect(p.sheetList).toEqual(CATS)
    expect(p.countCol).toBeNull()   // no "looks like counts" prompt
  })

  it('the result matches the source: sheets, order on every sheet, A–Z order, two-sheet membership, definitions, ids', async () => {
    const { items: srcItems } = exportFiles()
    const { result, written } = await replaceOntoEmpty(exportFiles()[kind])
    expect(result.status).toBe('done')
    expect(written.categories).toEqual(CATS)
    const tgtItems = withHome(written.items, written.categories)
    expect(view(tgtItems, written.categories)).toEqual(view(srcItems, CATS))
    expect(tgtItems.map(i => i.id).sort()).toEqual(srcItems.map(i => i.id).sort())
    for (const s of srcItems) {
      const t = tgtItems.find(i => i.id === s.id)
      expect(definition(t), s.id).toEqual(definition(s))
      expect(sheetCategoryKeys(t), s.id).toEqual(sheetCategoryKeys(s))
    }
    // The view really exercises the hard cases.
    const v = view(srcItems, CATS)
    expect(v.sheets.find(x => x.sheet === 'Coke Closet').items).toEqual(['coke_zero', 'custom_1791376417432_h9shw', '500ml_mexican_coke'])
    expect(v.sheets.find(x => x.sheet === 'Coke Cooler 1').items).not.toContain('coke_zero')
    expect(v.sheets.find(x => x.sheet === 'Coffee Bar').items).toContain('sprite_20oz')
    expect(v.sheets.find(x => x.sheet === 'Snacks').items).toEqual(['trail_mix'])
  })
})

describe('export onto the SAME site with "Add and update"', () => {
  it.each(['xlsx', 'csv'])('%s: nothing to write — no adds, no updates, no hides, no new sheets', (kind) => {
    const p = readCatalogWorkbook(exportFiles()[kind])
    const m = buildCatalogMerge(p.rows, p.headers, DOCS, CATS, {}, { importedAt: 't', importedBy: 'test' })
    expect(m.toAdd).toEqual([])
    expect(m.toUpdate).toEqual([])
    expect(m.toHide).toEqual([])
    expect(m.newCategories).toEqual([])
    expect(m.unchanged.map(u => u.id).sort()).toEqual(DOCS.filter(d => !d.data.removed).map(d => d.id).sort())
  })
})

describe('existing upload guarantees still hold for an export file', () => {
  const p = readCatalogWorkbook(exportFiles().xlsx)

  it('merge never writes sheet membership or positions onto an item that already exists', () => {
    const changed = DOCS.map(d => d.id === '500ml_mexican_coke'
      ? { id: d.id, data: { ...d.data, packPrice: 30, countCategories: ['dairy'], sheetShelfOrder: {}, catShelfOrder: 99 } } : d)
    const m = buildCatalogMerge(p.rows, p.headers, changed, CATS, {}, {})
    expect(m.toUpdate).toHaveLength(1)
    const u = m.toUpdate[0]
    expect(u.id).toBe('500ml_mexican_coke')
    expect(u.data.packPrice).toBe(33.17)
    for (const f of ['countCategories', 'sheetShelfOrder', 'catShelfOrder', 'flatShelfOrder', 'isKey', 'removed', 'custom', 'category']) expect(u.data).not.toHaveProperty(f)
  })

  it('a NEW item from an export (merge) brings its sheets; positions still go after everything arranged', () => {
    const m = buildCatalogMerge(p.rows, p.headers, DOCS.filter(d => d.id !== 'coke_zero'), CATS, {}, {})
    expect(m.toAdd.map(a => a.id)).toEqual(['coke_zero'])
    expect(m.toAdd[0].data.countCategories).toEqual(['coke_closet', 'chips_cubby'])
    expect(m.toAdd[0].data.catShelfOrder).toBeGreaterThan(7)
  })

  it('a custom item in the export is matched by its Item ID and never re-added or updated', () => {
    const m = buildCatalogMerge(p.rows, p.headers, DOCS, CATS, {}, {})
    expect(m.toAdd.find(a => a.data.name === 'Stir Sticks')).toBeUndefined()
    expect(m.unchanged.map(u => u.id)).toContain('custom_1791376417432_h9shw')
  })

  it('...even when the custom item differs from the file, it is not updated', () => {
    const edited = DOCS.map(d => d.id === 'custom_1791376417432_h9shw' ? { id: d.id, data: { ...d.data, packPrice: 99 } } : d)
    const m = buildCatalogMerge(p.rows, p.headers, edited, CATS, {}, {})
    expect(m.toUpdate.map(u => u.id)).not.toContain('custom_1791376417432_h9shw')
    expect(m.toAdd.find(a => a.data.name === 'Stir Sticks')).toBeUndefined()
  })

  it('zero-item guard: an export with no item rows aborts with the message', () => {
    expect(catalogFileError([], p.headers)).toMatch(/0 items/)
    // ...and an export's zero-cost item is still an item (not a "section header").
    expect(catalogFileError(p.rows.filter(r => r.Item === 'Napkins'), p.headers)).toBeNull()
  })

  it('Replace still runs the named confirm and the backup, before deleting anything', async () => {
    const order = []
    const r = await runCatalogReplace(
      { rows: p.rows, headers: p.headers, existingDocs: DOCS, categories: CATS, sheetList: p.sheetList, meta: {} },
      {
        confirm: async (summary) => { order.push(['confirm', summary.total, summary.withSplit, summary.withKey]); return true },
        backup: async (docs) => { order.push(['backup', docs.length]) },
        saveCategories: async () => { order.push(['categories']) },
        deleteItems: async () => { order.push(['delete']) },
        writeItems: async () => { order.push(['write']) },
      })
    expect(r.status).toBe('done')
    expect(order).toEqual([['confirm', 10, 3, 1], ['backup', 11], ['categories'], ['delete'], ['write']])
  })

  it('a non-export file keeps the old behaviour: categories appended, row-order positions', async () => {
    const rows = [{ Description: 'Widget', Vendor: 'Acme', 'Pack Price': 5, Category: 'Gadgets' }]
    const saved = []
    const r = await runCatalogReplace({ rows, headers: Object.keys(rows[0]), existingDocs: [], categories: CATS, sheetList: CATS, meta: {} },
      { confirm: async () => true, backup: async () => {}, saveCategories: async (c) => saved.push(c), deleteItems: async () => {}, writeItems: async () => {} })
    expect(saved[0].map(c => c.label)).toEqual([...CATS.map(c => c.label), 'Gadgets'])
    expect(r.items[0].data).toMatchObject({ catShelfOrder: 1, flatShelfOrder: 1 })
  })
})

describe('"Also counted on" format', () => {
  it('round-trips sheets, positions and the "only:" marker', () => {
    const v = { only: true, sheets: [{ label: 'Coke Closet', pos: 13 }, { label: 'Chips, Cubby', pos: null }] }
    expect(formatAlsoOn(v)).toBe('only: Coke Closet @13; Chips, Cubby')
    expect(parseAlsoOn(formatAlsoOn(v))).toEqual(v)
    expect(parseAlsoOn('')).toEqual({ only: false, sheets: [] })
  })
})

describe('export file layout', () => {
  it('each item appears once, under its HOME sheet, sheets in order, each in its on-screen order', () => {
    const { rows } = exportFiles()
    expect(rows.map(r => [r.Category, r['Item ID']])).toEqual([
      ['Coffee Bar', 'apple_juice'], ['Coffee Bar', 'custom_1791376417432_h9shw'], ['Coffee Bar', 'sprite_20oz'],
      ['Coke Cooler 1', 'coke_zero'], ['Coke Cooler 1', 'coke_classic'], ['Coke Cooler 1', '500ml_mexican_coke'],
      ['Chips, Cubby', 'lays_classic_2'], ['Chips, Cubby', 'lays_classic'], ['Chips, Cubby', 'napkins'],
      ['Snacks', 'trail_mix'],
    ])
    expect(rows.find(r => r['Item ID'] === 'coke_zero')['Also counted on']).toBe('only: Coke Closet @2; Chips, Cubby')
    expect(rows.find(r => r['Item ID'] === '500ml_mexican_coke')['Also counted on']).toBe('Coke Closet @13')
  })

  it('a CSV export with many sheets (header row far down) is still read', () => {
    const many = Array.from({ length: 25 }, (_, i) => ({ key: 'k' + i, label: 'Sheet ' + i, keywords: [] }))
    const docs = [{ id: 'a', data: { ...base, name: 'A', category: 'Sheet 3', categoryExplicit: true } }]
    const { csv } = exportFiles(docs, many)
    const p = readCatalogWorkbook(csv)
    expect(p.error).toBeNull()
    expect(p.sheetList).toHaveLength(25)
    expect(p.rows.filter(r => r.Item).map(r => r['Item ID'])).toEqual(['a'])
  })
})

