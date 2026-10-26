/**
 * MULTI-CATEGORY COUNTING — Stage 2.
 *
 * One item can be counted on several category sheets ("split"); each sheet
 * holds its own count; the sheets roll up to one total. The non-negotiable:
 *
 *     category totals == closingValue
 *
 * A split item contributes its value ONCE, divided across its sheets — never
 * once per sheet. That holds on screen (categoryTotals), in the export's
 * By Category sheet (byCategoryRows, exact to the cent), and in the export's
 * Total Closing Value (uniqueItems — one detail row per item).
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import {
  isSplitItem, countCategoryKeys, sheetCategoryKeys, bucketsFor, catBucketKey, completedBuckets,
  derivedTotalEaches, countDisplay, itemTotalEaches, portionValue, allocateItemValue, categoryTotals,
  rebucketForMembership, closeOutIssues, closeOutWarningText, pendingBucketsLabel,
} from '../src/lib/buckets'
import { itemValue, uploadRejectReason, sweepTotalUpdates } from '../src/hooks/useInventory'
import { inventoryExportRow, uniqueItems, byCategoryRows } from '../src/lib/inventoryExport'
import { buildCountSheets } from '../src/lib/countSheets'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const code = p => readFileSync(resolve(ROOT, p), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

const CATS = [
  { key: 'bar', label: 'Coffee Bar' },
  { key: 'snacks', label: 'Snacks' },
  { key: 'boh', label: 'BOH' },
]
const ZONES = null   // single-zone location
const B = catBucketKey

// $2 per each (12-pack at $24).
const split = (id, cats, zones, extra = {}) => ({
  id, name: id, _cat: cats[0], qtyPerPack: 12, packPrice: 24, qty: null, eaches: 0,
  countCategories: cats, ...(zones ? { zones } : {}), ...extra,
})
const flat = (id, cat, qty, eaches = 0, extra = {}) => ({
  id, name: id, _cat: cat, qtyPerPack: 12, packPrice: 24, qty, eaches, countCategories: [], ...extra,
})
// Enrich like itemsWithMeta: the fields every total reads.
const enrich = (items, done = []) => items.map(i => ({
  ...i, _value: itemValue(i, ZONES, done), _totalEaches: itemTotalEaches(i, ZONES, done),
}))
const closingOf = items => items.reduce((s, i) => s + i._value, 0)

describe('back-compat — 0 or 1 category behaves exactly as today', () => {
  const plain = flat('gum', 'snacks', 3, 4)
  const one = { ...plain, countCategories: ['snacks'] }

  it('neither is split; it sits on its home sheet only; buckets are the zones', () => {
    for (const i of [plain, one]) {
      expect(isSplitItem(i)).toBe(false)
      expect(sheetCategoryKeys(i)).toEqual(['snacks'])
      expect(bucketsFor(i, ZONES).map(b => b.key)).toEqual(['default'])
    }
  })

  it('total, display and value are the legacy numbers', () => {
    for (const i of [plain, one]) {
      expect(derivedTotalEaches(i, ZONES, [])).toBe(40)                    // 3 packs + 4
      expect(countDisplay(i, ZONES, []).zoned).toBe(false)
      expect(itemValue(i, ZONES, [])).toBe(3 * 24 + 4 * 2)
    }
  })

  it('a single-category item takes its WHOLE value to its home category', () => {
    const [it] = enrich([plain])
    expect(allocateItemValue(it, ['bar', 'snacks'])).toEqual([{ catKey: 'snacks', value: 80 }])
  })
})

describe('a split item renders on each of its sheets', () => {
  const milk = split('oat milk', ['bar', 'boh'])

  it('screen grouping and printed sheets both list it on every sheet, home first', () => {
    expect(sheetCategoryKeys(milk)).toEqual(['bar', 'boh'])
    const sheets = buildCountSheets([milk], CATS)
    expect(sheets.map(s => s.key)).toEqual(['bar', 'boh'])
    for (const s of sheets) expect(s.rows.map(r => r.name)).toEqual(['oat milk'])
  })

  it('the screen groups by membership, and split rows get the per-sheet cell', () => {
    const INV = code('src/routes/Inventory.jsx')
    expect(INV).toMatch(/\.filter\(i => sheetCategoryKeys\(i\)\.includes\(cat\.key\)\)/)
    expect(INV).toMatch(/activeCat === 'all' \|\| sheetCategoryKeys\(i\)\.includes\(activeCat\)/)
    expect(INV).toMatch(/\{isSplitItem\(item\) \? \(\s*<SplitCountCell/)
    expect(INV).toMatch(/sheetKeys=\{cat\.isFlat \? countCategoryKeys\(item\) : \[cat\.key\]\}/)
    expect(INV).toMatch(/onChange=\{setZoneValue\}/)
  })

  it('a past period uses the membership stored with its counts', () => {
    expect(countCategoryKeys({ ...milk, _bucketCats: ['bar'] })).toEqual(['bar'])
    expect(isSplitItem({ ...milk, _bucketCats: [] })).toBe(false)
  })
})

describe('completeness — each sheet must be counted (or marked done)', () => {
  const half = split('milk', ['bar', 'boh'], { [B('bar')]: { qty: 2, eaches: 0 } })

  it('one sheet counted → incomplete (null), never the partial', () => {
    expect(derivedTotalEaches(half, ZONES, [])).toBeNull()
    expect(countDisplay(half, ZONES, []).pending).toEqual([B('boh')])
    expect(pendingBucketsLabel([B('boh')], ZONES, CATS)).toBe('Not counted yet in: BOH sheet')
  })

  it('both sheets counted → the sum; a done sheet counts its blank as 0; undo reverts', () => {
    const both = { ...half, zones: { ...half.zones, [B('boh')]: { qty: 1, eaches: 6 } } }
    expect(derivedTotalEaches(both, ZONES, [])).toBe(24 + 18)
    const done = completedBuckets({ sectionsCompleted: ['boh'] })
    expect(done).toEqual([B('boh')])
    expect(derivedTotalEaches(half, ZONES, done)).toBe(24)
    expect(derivedTotalEaches(half, ZONES, completedBuckets({ sectionsCompleted: [] }))).toBeNull()
  })

  it('every sheet done, nothing entered → a real 0, never the in-memory top-level', () => {
    const none = { ...split('x', ['bar', 'boh']), qty: 9, eaches: 9 }   // load()-coerced junk
    const allDone = completedBuckets({ sectionsCompleted: ['bar', 'boh'] })
    expect(derivedTotalEaches(none, ZONES, allDone)).toBe(0)
    expect(itemValue(none, ZONES, allDone)).toBe(0)
  })

  it('a split item with nothing entered is uncounted, not "0"', () => {
    const none = split('x', ['bar', 'boh'])
    expect(derivedTotalEaches(none, ZONES, [])).toBeNull()
    expect(itemValue({ ...none, qty: 9, eaches: 9 }, ZONES, [])).toBe(0)   // in-memory junk ignored
  })

  it('marking a sheet done re-persists totals only for items ON that sheet; a zone sweep never touches split items', () => {
    const onBoh = split('a', ['bar', 'boh'], { [B('bar')]: { qty: 1, eaches: 0 } })
    const offBoh = split('b', ['bar', 'snacks'], { [B('bar')]: { qty: 1, eaches: 0 } })
    expect(sweepTotalUpdates([onBoh, offBoh], B('boh'), ZONES, [B('boh')]).map(u => u.id)).toEqual(['a'])
    expect(sweepTotalUpdates([onBoh], 'cooler', [{ key: 'cooler' }, { key: 'storage' }], ['cooler'])).toEqual([])
  })

  it('"Mark sheet done" goes through the shared sweep path, keyed to the category bucket', () => {
    const SRC = code('src/hooks/useInventory.js')
    expect(SRC).toMatch(/markBucketDone\(\{ field: 'sectionsCompleted', key: sectionKey, bucketKey: catBucketKey\(sectionKey\), done \}\)/)
    const INV = code('src/routes/Inventory.jsx')
    expect(INV).toMatch(/markSectionComplete\(cat\.key, !isDone\)/)
    expect(INV).toMatch(/cat\.items\.some\(isSplitItem\)/)
  })
})

describe('INVARIANT — category totals == closingValue (no double count)', () => {
  // A deliberately mixed location.
  const items = enrich([
    flat('gum', 'snacks', 2, 3),                                                   // plain, home snacks
    flat('cups', 'boh', 1),                                                        // plain, home boh
    flat('orphan', 'retired_cat', 1, 1),                                           // home not in the list
    split('milk', ['bar', 'boh'], { [B('bar')]: { qty: 2, eaches: 0 }, [B('boh')]: { qty: 1, eaches: 6 } }),  // complete split
    split('syrup', ['bar', 'snacks', 'boh'], { [B('bar')]: { qty: 0, eaches: 5 }, [B('snacks')]: { qty: 1, eaches: 1 }, [B('boh')]: { qty: 0, eaches: 2 } }),
    split('beans', ['bar', 'boh'], { [B('bar')]: { qty: 3, eaches: 0 } }),          // incomplete → $0
    split('lids', ['bar', 'gone'], { [B('bar')]: { qty: 1, eaches: 0 }, [B('gone')]: { qty: 1, eaches: 0 } }),   // a deleted category
  ])
  const closing = closingOf(items)

  it('category totals == closingValue', () => {
    const t = categoryTotals(items, CATS, ZONES, [])
    const sum = Object.values(t.byCat).reduce((s, c) => s + c.value, 0) + t.uncategorized.value
    expect(sum).toBeCloseTo(closing, 9)
    expect(t.total).toBeCloseTo(closing, 9)
    expect(closing).toBeGreaterThan(0)
  })

  it('a split item counts ONCE — its portions sum to its value, not value × sheets', () => {
    const milk = items.find(i => i.id === 'milk')
    expect(milk._value).toBe(84)                                                   // 42 eaches × $2
    expect(portionValue(milk, 'bar')).toBeCloseTo(48, 9)                          // 24 eaches
    expect(portionValue(milk, 'boh')).toBeCloseTo(36, 9)                          // 18 eaches
    const only = categoryTotals([milk], CATS, ZONES, [])
    expect(only.byCat.bar.value + only.byCat.boh.value).toBeCloseTo(84, 9)        // not 168
  })

  it('an incomplete split item contributes 0 to every sheet (as it does to closing)', () => {
    const beans = items.find(i => i.id === 'beans')
    expect(beans._value).toBe(0)
    expect(allocateItemValue(beans, ['bar', 'boh']).every(a => a.value === 0)).toBe(true)
  })

  it('value on a deleted category / an unknown home lands in uncategorized — never dropped', () => {
    const t = categoryTotals(items, CATS, ZONES, [])
    const orphan = items.find(i => i.id === 'orphan')._value
    const lids = items.find(i => i.id === 'lids')
    expect(t.uncategorized.value).toBeCloseTo(orphan + portionValue(lids, 'gone'), 9)
  })

  it('EXPORT: one detail row per item even though split items appear on several sheets', () => {
    const groups = CATS.map(c => ({ key: c.key, items: items.filter(i => sheetCategoryKeys(i).includes(c.key)) }))
    const naive = groups.flatMap(g => g.items)
    expect(naive.length).toBeGreaterThan(items.filter(i => sheetCategoryKeys(i).length).length)   // duplicates exist
    const unique = uniqueItems(groups)
    expect(new Set(unique.map(i => i.id)).size).toBe(unique.length)
    const exportTotal = unique.reduce((s, i) => s + parseFloat(inventoryExportRow(i)['Closing Value']), 0)
    const onSheets = items.filter(i => sheetCategoryKeys(i).some(k => CATS.some(c => c.key === k)))
    expect(exportTotal).toBeCloseTo(closingOf(onSheets), 2)
  })

  it('EXPORT: By Category total == detail Total Closing Value, exact to the cent', () => {
    const { rows, totalCents } = byCategoryRows(items, CATS)
    const detailCents = items.reduce((s, i) => s + Math.round(parseFloat(inventoryExportRow(i)['Closing Value']) * 100), 0)
    expect(totalCents).toBe(detailCents)
    const lineCents = rows.filter(r => r.Item).reduce((s, r) => s + Math.round(parseFloat(r['Closing Value']) * 100), 0)
    const subCents = rows.filter(r => / — subtotal$/.test(r.Category)).reduce((s, r) => s + Math.round(parseFloat(r['Closing Value']) * 100), 0)
    expect(lineCents).toBe(totalCents)
    expect(subCents).toBe(totalCents)
    expect(rows.at(-1)).toMatchObject({ Category: 'TOTAL', 'Closing Value': (totalCents / 100).toFixed(2) })
  })

  it('EXPORT: one row per item-category; a 3-way split of $10.00 shares cents exactly', () => {
    const ten = { ...split('t', ['bar', 'snacks', 'boh'], { [B('bar')]: { qty: 0, eaches: 1 }, [B('snacks')]: { qty: 0, eaches: 1 }, [B('boh')]: { qty: 0, eaches: 1 } }), _value: 10, _totalEaches: 3 }
    const { rows } = byCategoryRows([ten], CATS)
    const lines = rows.filter(r => r.Item === 't')
    expect(lines.map(r => r.Category)).toEqual(['Coffee Bar', 'Snacks', 'BOH'])
    expect(lines.map(r => r['Closing Value']).sort()).toEqual(['3.33', '3.33', '3.34'])
  })

  it('the app wires both totals to these functions', () => {
    const SRC = code('src/hooks/useInventory.js')
    expect(SRC).toMatch(/categoryTotals\(itemsWithMeta, categories, zones, completedBuckets\(session\)\)/)
    const INV = code('src/routes/Inventory.jsx')
    expect(INV).toMatch(/const \{ rows: catRows \} = byCategoryRows\(exportItems, categories\)/)
    expect(INV).toMatch(/\{fmt\$\(catStats\[cat\.key\]\?\.value \|\| 0\)\}/)
    expect(INV).toMatch(/const shown = onSheet \? portionValue\(item, cat\.key\) : \(item\._value \|\| 0\)/)
  })
})

describe('membership changes never drop a count', () => {
  const home = 'bar'
  it('flat → split: the flat count moves into the home sheet; the new sheet starts blank', () => {
    const r = rebucketForMembership(flat('m', 'bar', 2, 3), ['bar', 'boh'], home)
    expect(r.countCategories).toEqual(['bar', 'boh'])
    expect(r.patch.zones).toEqual({ [B('bar')]: { qty: 2, eaches: 3 } })
    expect([r.patch.qty, r.patch.eaches]).toEqual([null, 0])
    expect(r.dirtyKeys).toEqual([B('bar')])
  })
  it('split → split, a sheet removed: its count MERGES into home and the bucket is cleared', () => {
    const it = split('m', ['bar', 'boh', 'snacks'], { [B('bar')]: { qty: 1, eaches: 0 }, [B('boh')]: { qty: 2, eaches: 5 } })
    const r = rebucketForMembership(it, ['bar', 'snacks'], home)
    expect(r.patch.zones[B('bar')]).toEqual({ qty: 3, eaches: 5 })
    expect(r.patch.zones[B('boh')]).toEqual({ qty: null, eaches: null })
    expect(r.dirtyKeys.sort()).toEqual([B('bar'), B('boh')].sort())
  })
  it('split → one category: all sheets fold into one flat count (total eaches preserved)', () => {
    const it = split('m', ['bar', 'boh'], { [B('bar')]: { qty: 1, eaches: 2 }, [B('boh')]: { qty: 2, eaches: 3 } })
    const r = rebucketForMembership(it, ['bar'], home)
    expect(r.countCategories).toEqual([])
    expect([r.patch.qty, r.patch.eaches, r.patch.zones]).toEqual([3, 5, undefined])
    expect(derivedTotalEaches({ ...it, ...r.patch, countCategories: [], zones: undefined }, ZONES, []))
      .toBe(derivedTotalEaches(it, ZONES, []))
  })
  it('home is always kept in a split membership', () => {
    expect(rebucketForMembership(flat('m', 'bar', null), ['snacks', 'boh'], 'bar').countCategories).toEqual(['bar', 'snacks', 'boh'])
  })
  it('a deleted category merges into home, via the manager\'s onSaved', () => {
    const INV = code('src/routes/Inventory.jsx')
    expect(INV).toMatch(/const removed = categories\.map\(c => c\.key\)\.filter\(k => !next\.some\(n => n\.key === k\)\)/)
    expect(INV).toMatch(/removeCategoriesFromItems\(removed, 'general'\)/)
  })
  it('the item doc stores KEYS, and each count doc snapshots the membership it was counted with', () => {
    const SRC = code('src/hooks/useInventory.js')
    expect(SRC).toMatch(/\{ countCategories: stored \}, \{ merge: true \}/)
    expect(SRC).toMatch(/countCategories: isSplitItem\(i\) \? countCategoryKeys\(i\) : null/)
    expect(SRC).toMatch(/\.\.\.\(liveSync \? \{\} : \{ _bucketCats: Array\.isArray\(c\.countCategories\) \? c\.countCategories : \[\] \}\)/)
  })
})

describe('count upload rejects split items', () => {
  it('a split item (or one counted per zone) gets a clear reason; a plain item none', () => {
    expect(uploadRejectReason(split('m', ['bar', 'boh']))).toMatch(/more than one category sheet/)
    expect(uploadRejectReason({ id: 'z', zones: { cooler: { qty: 1 } } })).toMatch(/per zone/)
    expect(uploadRejectReason(flat('g', 'bar', 1))).toBe('')
  })
  it('the preview rejects before counting, and the apply step skips them too', () => {
    const INV = code('src/routes/Inventory.jsx')
    expect(INV).toMatch(/const why = uploadRejectReason\(item\)\n\s*if \(why\) \{ rejected\.push/)
    const SRC = code('src/hooks/useInventory.js')
    expect(SRC).toMatch(/if \(uploadRejectReason\(item\)\) return item/)
  })
})

describe('close-out names unfinished sheets', () => {
  it('a split item pending on a sheet makes that sheet unfinished, by name', () => {
    const it = split('milk', ['bar', 'boh'], { [B('bar')]: { qty: 1, eaches: 0 } })
    const issues = closeOutIssues([it], ZONES, [])
    expect(issues.unfinishedSheets).toEqual(['boh'])
    expect(issues.partial).toEqual([{ name: 'milk', pending: [B('boh')] }])
    const text = closeOutWarningText(issues, ZONES, 8, CATS)
    expect(text).toContain('1 category sheet not finished: BOH')
    expect(text).toContain('milk (not counted in BOH sheet)')
  })
  it('a done sheet is not unfinished', () => {
    const it = split('milk', ['bar', 'boh'], { [B('bar')]: { qty: 1, eaches: 0 } })
    expect(closeOutIssues([it], ZONES, [B('boh')]).any).toBe(false)
  })
})
