/**
 * Printable count sheets — the pure row builder + the wiring that keeps a
 * sheet honest: same order as the screen, no biasing numbers, nothing dropped.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import {
  buildCountSheets, paginateSheets, sheetCategoryKeys, packLabel, byShelf, SHEET_COLUMNS,
  UNCATEGORIZED_SHEET_KEY, ROWS_PER_PAGE,
} from '../src/lib/countSheets'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const code = p => readFileSync(resolve(ROOT, p), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

const CATS = [
  { key: 'bar', label: 'Coffee Bar' },
  { key: 'snacks', label: 'Snacks' },
  { key: 'empty', label: 'Empty Cat' },
]
// Priced and counted on purpose — none of it may reach a sheet.
const it_ = (id, name, cat, extra = {}) => ({
  id, name, _cat: cat, qty: 7, eaches: 3, packPrice: 24, unitCost: 2, _value: 99, _priorQty: 5,
  ...extra,
})
const ITEMS = [
  it_('1', 'Zebra Cakes', 'snacks'),
  it_('2', 'oat milk', 'bar', { catShelfOrder: 2 }),
  it_('3', 'Espresso beans', 'bar', { catShelfOrder: 1 }),
  it_('4', 'Almond milk', 'bar'),                        // unplaced → bottom, A-Z
  it_('5', 'Chai', 'bar'),
  it_('6', 'Mystery item', 'retired_cat'),               // category not in the list
]
const names = s => s.rows.map(r => r.name)

describe('order matches the grouped screen', () => {
  it('shelf-placed items first by position, then unplaced A-Z (case-insensitive)', () => {
    const [bar] = buildCountSheets(ITEMS, CATS, { only: 'bar' })
    expect(names(bar)).toEqual(['Espresso beans', 'oat milk', 'Almond milk', 'Chai'])
  })

  it('unplaced items sort alphabetically regardless of capitalisation (not by character code)', () => {
    const mixed = [it_('a', 'banana chips', 'snacks'), it_('b', 'Zebra Cakes', 'snacks'), it_('c', 'Apple slices', 'snacks')]
    expect(names(buildCountSheets(mixed, CATS, { only: 'snacks' })[0])).toEqual(['Apple slices', 'banana chips', 'Zebra Cakes'])
  })

  it('all-sheets follows category order and skips empty categories', () => {
    const sheets = buildCountSheets(ITEMS, CATS)
    expect(sheets.map(s => s.key)).toEqual(['bar', 'snacks', UNCATEGORIZED_SHEET_KEY])
  })

  it('the screen sorts with the SAME comparator (imported, not a local copy)', () => {
    const INV = code('src/routes/Inventory.jsx')
    expect(INV).toMatch(/import \{ byShelf \} from '@\/lib\/countSheets'/)
    expect(INV).not.toMatch(/const byShelf\s*=/)
    expect(INV).not.toMatch(/const byName\s*=/)
    expect(INV).toMatch(/\.sort\(byShelf\('catShelfOrder'\)\)/)
  })

  it('a sheet equals the screen\'s grouped order for that category', () => {
    // The screen: displayItems.filter(i => i._cat === key).sort(byShelf('catShelfOrder'))
    const screen = ITEMS.filter(i => i._cat === 'bar').sort(byShelf('catShelfOrder')).map(i => i.name)
    expect(names(buildCountSheets(ITEMS, CATS, { only: 'bar' })[0])).toEqual(screen)
  })
})

describe('no numbers that bias a count', () => {
  it('a row carries only id, name and pack — no price, count, prior or value', () => {
    for (const s of buildCountSheets(ITEMS, CATS)) {
      for (const r of s.rows) expect(Object.keys(r).sort()).toEqual(['id', 'name', 'pack'])
    }
  })

  it('the printed component renders no price/count/prior fields', () => {
    const M = code('src/components/inventory/CountSheetPrintModal.jsx')
    expect(M).not.toMatch(/packPrice|unitCost|_value|_prior|\.qty\b|\.eaches\b|fmt\$/)
  })
})

describe('columns — Packs + Eaches, matching how the app takes a count', () => {
  const CSS = readFileSync(resolve(ROOT, 'src/components/inventory/countSheetPrint.css'), 'utf8')
  const M = code('src/components/inventory/CountSheetPrintModal.jsx')

  it('prints Item, Pack / unit, Packs, Eaches, Notes — in that order', () => {
    expect(SHEET_COLUMNS.map(c => c.label)).toEqual(['Item', 'Pack / unit', 'Packs', 'Eaches', 'Notes'])
  })

  it('Packs and Eaches are the two blank write-in boxes; nothing else is', () => {
    expect(SHEET_COLUMNS.filter(c => c.box).map(c => c.key)).toEqual(['packs', 'eaches'])
    for (const c of SHEET_COLUMNS.filter(c => c.box)) expect(c.field).toBeUndefined()
  })

  it('data columns only read fields a row actually carries (name, pack)', () => {
    const rowKeys = Object.keys(buildCountSheets(ITEMS, CATS)[0].rows[0])
    for (const c of SHEET_COLUMNS.filter(c => c.field)) expect(rowKeys).toContain(c.field)
  })

  it('the sheet renders its header and cells from SHEET_COLUMNS, not a hand-written copy', () => {
    expect(M).toMatch(/SHEET_COLUMNS\.map\(c => <th/)
    expect(M).toMatch(/SHEET_COLUMNS\.map\(c => \(\s*<td/)
    expect(M).toMatch(/c\.box \? <span className="cs-box" \/>/)
  })

  it('every column has a print width, and the widths fill the page exactly', () => {
    const widthOf = key => {
      const m = CSS.match(new RegExp(`[^}]*\\.cs-col-${key}\\b[^{]*\\{[^}]*width: (\\d+)%`))
      return m ? Number(m[1]) : NaN
    }
    const widths = SHEET_COLUMNS.map(c => widthOf(c.key))
    expect(widths.every(Number.isFinite)).toBe(true)
    expect(widths.reduce((a, b) => a + b, 0)).toBe(100)
  })
})

describe('nothing silently dropped', () => {
  it('an item whose category is not in the list gets the "Not in any category" sheet', () => {
    const last = buildCountSheets(ITEMS, CATS).at(-1)
    expect(last.key).toBe(UNCATEGORIZED_SHEET_KEY)
    expect(names(last)).toEqual(['Mystery item'])
  })

  it('every item lands on at least one sheet', () => {
    const printed = new Set(buildCountSheets(ITEMS, CATS).flatMap(s => s.rows.map(r => r.id)))
    expect([...printed].sort()).toEqual(ITEMS.map(i => i.id).sort())
  })

  it('no orphan sheet when every item is categorized', () => {
    const sheets = buildCountSheets(ITEMS.filter(i => i.id !== '6'), CATS)
    expect(sheets.some(s => s.key === UNCATEGORIZED_SHEET_KEY)).toBe(false)
  })
})

describe('single-category print', () => {
  it('returns just that sheet, even when empty', () => {
    expect(buildCountSheets(ITEMS, CATS, { only: 'empty' })).toEqual([{ key: 'empty', label: 'Empty Cat', rows: [] }])
  })
  it('unknown key → nothing', () => {
    expect(buildCountSheets(ITEMS, CATS, { only: 'nope' })).toEqual([])
  })
})

describe('multi-category, later — membership is one rule', () => {
  it('today: the home category only', () => {
    expect(sheetCategoryKeys({ _cat: 'bar' })).toEqual(['bar'])
  })
  it('with countCategories: home first, de-duplicated', () => {
    expect(sheetCategoryKeys({ _cat: 'bar', countCategories: ['snacks', 'bar', '', null] })).toEqual(['bar', 'snacks'])
  })
  it('a split item appears on each of its sheets, once per sheet', () => {
    const split = it_('9', 'Oat milk 1L', 'bar', { countCategories: ['bar', 'snacks'] })
    const sheets = buildCountSheets([split], CATS)
    expect(sheets.map(s => s.key)).toEqual(['bar', 'snacks'])
    for (const s of sheets) expect(names(s)).toEqual(['Oat milk 1L'])
  })
})

describe('pack label', () => {
  it('pack size + per-pack quantity', () => {
    expect(packLabel({ packSize: 'case', qtyPerPack: 24 })).toBe('case · 24 per pack')
  })
  it('a single-unit pack omits the quantity', () => {
    expect(packLabel({ packSize: '1 gal', qtyPerPack: 1 })).toBe('1 gal')
  })
  it('falls back to unit, then "each"', () => {
    expect(packLabel({ unit: 'lb' })).toBe('lb')
    expect(packLabel({})).toBe('each')
  })
})

describe('page splits', () => {
  const many = Array.from({ length: 45 }, (_, k) => it_(`m${k}`, `Item ${String(k).padStart(2, '0')}`, 'bar'))

  it('splits a long sheet into pages with "page N of M", preserving order', () => {
    const pages = paginateSheets(buildCountSheets(many, CATS), 20)
    expect(pages.map(p => [p.pageNo, p.pageCount, p.rows.length])).toEqual([[1, 3, 20], [2, 3, 20], [3, 3, 5]])
    expect(pages.flatMap(p => p.rows.map(r => r.name))).toEqual(many.map(i => i.name))
  })

  it('every sheet starts its own page', () => {
    const pages = paginateSheets(buildCountSheets(ITEMS, CATS), 2)
    expect(pages.map(p => `${p.sheetKey}:${p.pageNo}/${p.pageCount}`))
      .toEqual(['bar:1/2', 'bar:2/2', 'snacks:1/1', `${UNCATEGORIZED_SHEET_KEY}:1/1`])
  })

  it('an empty sheet still yields one (blank) page', () => {
    expect(paginateSheets([{ key: 'e', label: 'E', rows: [] }])).toEqual([{ sheetKey: 'e', label: 'E', pageNo: 1, pageCount: 1, rows: [] }])
  })

  it('defaults to ROWS_PER_PAGE and tolerates a junk page size', () => {
    expect(paginateSheets(buildCountSheets(many, CATS))[0].rows.length).toBe(ROWS_PER_PAGE)
    expect(paginateSheets(buildCountSheets(many, CATS), 0)[0].rows.length).toBe(ROWS_PER_PAGE)
  })
})

describe('print wiring', () => {
  const CSS = readFileSync(resolve(ROOT, 'src/components/inventory/countSheetPrint.css'), 'utf8')
  const M = code('src/components/inventory/CountSheetPrintModal.jsx')

  it('print CSS hides the app and shows only the sheets, one page break per sheet page', () => {
    const print = CSS.slice(CSS.indexOf('@media print'))
    expect(print).toMatch(/body > \*:not\(#count-sheet-print-root\)\s*\{\s*display: none !important;/)
    expect(print).toMatch(/\.cs-page \{[^}]*break-after: page/)
    expect(CSS).toMatch(/#count-sheet-print-root \{ display: none; \}/)   // off-screen otherwise
  })

  it('a row cannot wrap and push a page past one sheet of paper', () => {
    expect(CSS).toMatch(/\.cs-table td \{[^}]*white-space: nowrap/)
  })

  it('the dialog prints the same pages it previews, from the pure builder', () => {
    expect(M).toMatch(/buildCountSheets\(items, categories/)
    expect(M).toMatch(/paginateSheets\(sheets\)/)
    expect(M).toMatch(/createPortal\(\s*<div id="count-sheet-print-root"><CountSheetPages \{\.\.\.sheetProps\} \/>/)
    expect(M).toMatch(/<CountSheetPages \{\.\.\.sheetProps\} \/>[\s\S]*<CountSheetPages \{\.\.\.sheetProps\} \/>/)
  })

  it('the header carries location, period, category, counter, date and sign-off', () => {
    for (const s of ['{p.label}', '{locationLabel}', 'Period {periodKey}', 'Counted by', 'Date', 'Sign-off']) {
      expect(M).toContain(s)
    }
  })
})
