// @vitest-environment jsdom

// The export is built from items AS THE APP LOADS THEM (useInventory.load),
// not from raw Firestore docs — so every field the item list needs must
// survive load. Found in the browser round trip: load dropped glCodeFull, so
// an exported file uploaded back onto the same site "updated" every item.
// This drives the REAL hook against an in-memory Firestore.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor, cleanup } from '@testing-library/react'
import * as XLSX from 'xlsx'

vi.mock('firebase/firestore', () => import('./helpers/fakeFirestore.js'))
vi.mock('@/lib/firebase', () => ({ db: {}, auth: {} }))
vi.mock('@/store/authStore', () => ({ useAuthStore: { getState: () => ({ user: { tenantId: 'fooda' } }) } }))
vi.mock('@/lib/pnl', async (importOriginal) => ({ ...(await importOriginal()), isPeriodLocked: async () => false }))
vi.mock('@/hooks/useCountsListener', () => ({ useCountsListener: () => {} }))
vi.mock('@/components/ui/Toast', () => { const t = { success() {}, error() {}, info() {}, warning() {} }; return { useToast: () => t } })

import { store, reset } from './helpers/fakeFirestore.js'
import { CATS, DOCS } from './helpers/catalogFixture.js'
import { useInventory } from '../src/hooks/useInventory'
import { inventoryExportRow, exportItemsInSheetOrder, buildExportWorkbook, buildExportCsv } from '../src/lib/inventoryExport'
import { readCatalogWorkbook } from '../src/lib/catalogFile'
import { buildCatalogMerge, sameDefinition } from '../src/lib/catalogImport'

const T = 'tenants/fooda/inventory/Source_Site'

beforeEach(() => {
  reset()
  for (const d of DOCS) store.set(`${T}/items/${d.id}`, d.data)
  store.set(`${T}/settings/categories`, { categories: CATS })
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  return () => { cleanup(); vi.restoreAllMocks() }
})

async function loadedItems() {
  const { result } = renderHook(() => useInventory('fooda', 'Source Site', '2026-P11-W3', { email: 't@x' }))
  await waitFor(() => expect(result.current.loading).toBe(false))
  await waitFor(() => expect(result.current.items.length).toBeGreaterThan(0))
  return { items: result.current.items, categories: result.current.categories }
}
const files = ({ items, categories }) => {
  const rows = exportItemsInSheetOrder(items, categories).map(i => inventoryExportRow(i, null, categories))
  const args = { locationLabel: 'Source', periodKey: '2026-P11-W3', exportedAt: 'x', totals: { totalItems: rows.length, itemsCounted: 0, totalClosingValue: 0, needsReorder: 0 }, rows, categories }
  return {
    rows,
    xlsx: XLSX.read(XLSX.write(buildExportWorkbook(XLSX, args), { type: 'array', bookType: 'xlsx' })),
    csv: XLSX.read(buildExportCsv(args), { type: 'string', raw: true }),
  }
}

describe('export built from loaded items', () => {
  it('every definition field survives load: each exported row matches its stored doc', async () => {
    const f = files(await loadedItems())
    const p = readCatalogWorkbook(f.xlsx)
    const merge = buildCatalogMerge(p.rows, p.headers, DOCS, CATS, {}, {})
    // Rows the merge would update show which stored field didn't survive.
    expect(merge.toUpdate.map(u => u.id)).toEqual([])
    expect(merge.toAdd).toEqual([])
    expect(f.rows.find(r => r['Item ID'] === '500ml_mexican_coke')).toMatchObject({
      'GL Code': '12000 - Inventory - Cafeteria', 'COGS %': 30, 'Selling Price': 33.17, 'Unit Cost': 1.3821, 'SKU': '0126689',
    })
  })

  it.each(['xlsx', 'csv'])('%s from the loaded site, uploaded onto it with "Add and update": nothing to write', async (kind) => {
    const p = readCatalogWorkbook(files(await loadedItems())[kind])
    const m = buildCatalogMerge(p.rows, p.headers, DOCS, CATS, {}, {})
    expect([m.toAdd.length, m.toUpdate.length, m.toHide.length, m.newCategories.length]).toEqual([0, 0, 0, 0])
    expect(m.unchanged).toHaveLength(DOCS.filter(d => !d.data.removed).length)
  })

  it('sameDefinition is what merge uses to decide "unchanged"', () => {
    const d = DOCS[0].data
    expect(sameDefinition(d, { name: d.name, sku: d.sku, packSize: d.packSize, qtyPerPack: d.qtyPerPack, packPrice: d.packPrice, unitCost: d.unitCost, vendor: d.vendor, glCode: d.glCode, glCodeFull: d.glCodeFull, sellingPrice: d.sellingPrice, cogsRatio: d.cogsRatio, itemType: d.itemType })).toBe(true)
    expect(sameDefinition(d, { name: d.name, sku: d.sku, packSize: d.packSize, qtyPerPack: d.qtyPerPack, packPrice: d.packPrice, unitCost: d.unitCost, vendor: d.vendor, glCode: d.glCode, glCodeFull: d.glCode, sellingPrice: d.sellingPrice, cogsRatio: d.cogsRatio, itemType: d.itemType })).toBe(false)
  })
})

describe('each load path carries the item-list fields', () => {
  const FIELDS = { glCodeFull: '65080 - Onsite Paper', cogsRatio: 0.25, sellingPrice: 9.5, itemType: 'Paper' }
  it('own catalog, custom item, and master catalog + override', async () => {
    reset()
    // A location using the shared master catalog (no own catalog docs), with
    // an override on one item, plus a custom item.
    store.set('tenants/fooda/inventoryCatalog/cups', { id: 'cups', name: 'Cups', category: 'General', glCode: '65080', unitCost: 1, packPrice: 10, qtyPerPack: 10, ...FIELDS })
    store.set('tenants/fooda/inventoryCatalog/lids', { id: 'lids', name: 'Lids', category: 'General', glCode: '65080', unitCost: 1, packPrice: 10, qtyPerPack: 10, ...FIELDS })
    store.set(`${T}/items/lids`, { glCodeFull: '65081 - Override', cogsRatio: 0.4, flatShelfOrder: 1 })
    store.set(`${T}/items/custom_1`, { name: 'Stir Sticks', custom: true, category: 'General', glCode: '50431', unitCost: 0, packPrice: 41.51, ...FIELDS })
    const { items } = await loadedItems()
    const by = Object.fromEntries(items.map(i => [i.id, i]))
    expect(by.cups).toMatchObject(FIELDS)
    expect(by.lids).toMatchObject({ glCodeFull: '65081 - Override', cogsRatio: 0.4 })
    expect(by.custom_1).toMatchObject(FIELDS)
  })
})

