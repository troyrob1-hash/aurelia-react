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
  displayCents, toCents, largestRemainder, sheetUsage,
} from '../src/lib/buckets'
import { categoryDeleteMessage } from '../src/lib/categoryHelpers'
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
    const ledger = displayCents(items, CATS)
    const detailCents = items.reduce((s, i) => s + Math.round(parseFloat(inventoryExportRow(i, ledger.item(i.id))['Closing Value']) * 100), 0)
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
    expect(INV).toMatch(/const shown = \(onSheet \? centLedger\.share\(item\.id, cat\.key\) : centLedger\.item\(item\.id\)\) \/ 100/)
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

describe('DISPLAY — shown shares add up to the shown Closing Value, EXACTLY', () => {
  // Found live at Test Sandbox: 0range juice ($20.43 / 12), 2 cases on Beverages
  // + 1 case 6 on Bar / Barista. Shares rounded on their own showed $40.86 +
  // $30.64 = $71.50 under a $71.51 Closing Value.
  const oj = enrich([split('0range juice', ['bar', 'snacks'], {
    [B('bar')]: { qty: 2, eaches: 0 }, [B('snacks')]: { qty: 1, eaches: 6 },
  }, { qtyPerPack: 12, packPrice: 20.43 })])

  it('REGRESSION: the live case reconciles — $40.86 + $30.65 = $71.51', () => {
    const L = displayCents(oj, CATS)
    expect(L.closingCents).toBe(7151)
    expect([L.share('0range juice', 'bar'), L.share('0range juice', 'snacks')]).toEqual([4086, 3065])
    expect(L.share('0range juice', 'bar') + L.share('0range juice', 'snacks')).toBe(L.closingCents)
    // …and rounding each share on its own is what broke it: the 18-each share
    // is 30.6449999… in floating point, which displayed as $30.64.
    expect(Math.round(portionValue(oj[0], 'snacks') * 100)).toBe(3064)
    expect(Math.round(portionValue(oj[0], 'bar') * 100) + Math.round(portionValue(oj[0], 'snacks') * 100)).toBe(7150)
  })

  it('PROPERTY: across 600 random locations, every displayed level sums exactly', () => {
    // Deterministic PRNG so a failure reproduces.
    let seed = 0x5eed
    const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32)
    const pick = a => a[Math.floor(rnd() * a.length)]
    const keys = CATS.map(c => c.key).concat(['gone'])   // 'gone' = a deleted category
    let naiveMismatches = 0
    for (let run = 0; run < 600; run++) {
      const n = 1 + Math.floor(rnd() * 12)
      const raw = []
      for (let k = 0; k < n; k++) {
        const qpp = pick([1, 6, 12, 24, 36])
        const packPrice = Math.round(rnd() * 9000) / 100 + 0.01
        if (rnd() < 0.5) {
          const sheets = [...new Set([pick(keys), pick(keys), pick(keys)])]
          if (sheets.length < 2) sheets.push(sheets[0] === 'bar' ? 'boh' : 'bar')
          const zones = {}
          for (const s of sheets) if (rnd() < 0.9) zones[B(s)] = { qty: Math.floor(rnd() * 5), eaches: Math.floor(rnd() * 13) }
          raw.push(split(`s${run}-${k}`, sheets, zones, { qtyPerPack: qpp, packPrice, _cat: pick(keys) }))
        } else {
          raw.push(flat(`f${run}-${k}`, pick(keys.concat(['orphan'])), Math.floor(rnd() * 9), Math.floor(rnd() * 13), { qtyPerPack: qpp, packPrice }))
        }
      }
      const items = enrich(raw)
      const L = displayCents(items, CATS)
      const closingShown = toCents(closingOf(items))
      expect(L.closingCents).toBe(closingShown)                                          // KPI
      const catSum = Object.values(L.byCat).reduce((s, c) => s + c, 0) + L.uncategorizedCents
      expect(catSum).toBe(closingShown)                                                  // sheet totals → KPI
      expect(items.reduce((s, i) => s + L.item(i.id), 0)).toBe(closingShown)            // rows → KPI
      for (const i of items) {
        const alloc = allocateItemValue(i, CATS.map(c => c.key))
        const keysOf = [...new Set(alloc.map(a => a.catKey ?? null))]
        expect(keysOf.reduce((s, k) => s + L.share(i.id, k), 0)).toBe(L.item(i.id))     // shares → item
        expect(Math.abs(L.item(i.id) - (Number(i._value) || 0) * 100)).toBeLessThan(1.000001)   // never off by more than a cent
        for (const k of keysOf) expect(L.share(i.id, k)).toBeGreaterThanOrEqual(0)
      }
      // The bug this guards: rounding every displayed share on its own.
      const naive = items.reduce((s, i) => s + allocateItemValue(i, CATS.map(c => c.key)).reduce((t, a) => t + toCents(a.value), 0), 0)
      if (naive !== closingShown) naiveMismatches++
    }
    expect(naiveMismatches).toBeGreaterThan(0)   // proves the property test can see the bug
  })

  it('largestRemainder: integer parts, exact sum, deterministic ties', () => {
    expect(largestRemainder([1, 1, 1], 1000)).toEqual([334, 333, 333])
    expect(largestRemainder([2, 1], 1)).toEqual([1, 0])
    expect(largestRemainder([0, 0], 0)).toEqual([0, 0])
    expect(largestRemainder([], 5)).toEqual([])
  })

  it('toCents rounds the float that should have been a half-cent UP', () => {
    expect(toCents(18 * (20.43 / 12))).toBe(3065)
    expect(toCents(40.86 + 30.645)).toBe(7151)
    expect(toCents(0)).toBe(0)
    // Values that land a hair BELOW the half-cent in floating point — the
    // epsilon is what makes them round as the decimal amount intends.
    expect(1.005 * 100).toBeLessThan(100.5)
    expect(toCents(1.005)).toBe(101)
    expect(toCents(3 * (12.06 / 12))).toBe(302)                         // 3 eaches at $12.06/12
  })

  it('EXPORT: detail rows, By Category and TOTAL come from the same ledger', () => {
    const { rows, totalCents } = byCategoryRows(oj, CATS)
    const L = displayCents(oj, CATS)
    expect(totalCents).toBe(L.closingCents)
    expect(Math.round(parseFloat(inventoryExportRow(oj[0], L.item(oj[0].id))['Closing Value']) * 100)).toBe(7151)
    expect(rows.filter(r => r.Item).map(r => r['Closing Value'])).toEqual(['40.86', '30.65'])
  })

  it('the screen reads every displayed money number from the ledger', () => {
    const INV = code('src/routes/Inventory.jsx')
    expect(INV).toMatch(/<div className=\{styles\.kpiValue\}>\{fmt\$\(centLedger\.closingCents \/ 100\)\}<\/div>/)
    expect(INV).toMatch(/− \{fmt\$\(centLedger\.closingCents \/ 100\)\}/)
    expect(INV).toMatch(/const value = flatItems\.reduce\(\(s, i\) => s \+ centLedger\.item\(i\.id\), 0\) \/ 100/)
    expect(INV).toMatch(/This sheet's share of \$\{fmt\$\(centLedger\.item\(item\.id\) \/ 100\)\}/)
    expect(INV).toMatch(/const exportLedger = displayCents\(exportItems, categories\)/)
    expect(INV).not.toMatch(/fmt\$\(totals\.closingValue\)/)
    const SRC = code('src/hooks/useInventory.js')
    expect(SRC).toMatch(/value: \(centLedger\.byCat\[cat\.key\] \|\| 0\) \/ 100/)
  })
})

describe('category-delete prompt names counts on the sheet', () => {
  it('sheetUsage counts split items on a sheet and those holding a count there', () => {
    const items = [
      split('a', ['bar', 'zz'], { [B('zz')]: { qty: 1, eaches: 0 } }),
      split('b', ['bar', 'zz']),
      flat('c', 'zz', 1),                                  // home label 'zz' — not split, not "on the sheet"
    ]
    expect(sheetUsage(items, 'zz')).toEqual({ onSheet: 2, withCounts: 1 })
    expect(sheetUsage(items, 'boh')).toEqual({ onSheet: 0, withCounts: 0 })
  })

  it('REGRESSION: an item with a count on the sheet is never "no items" — it says the count merges into home', () => {
    const msg = categoryDeleteMessage({ homeCount: 0, sheet: { onSheet: 1, withCounts: 1 }, locationId: 'Test_Sandbox' }).join(' ')
    expect(msg).not.toMatch(/No items/)
    expect(msg).toMatch(/1 item is also counted on this sheet — 1 with a count here, which will merge into its home sheet\. Nothing is lost\./)
  })

  it('home-label moves and sheet merges are both named; "just removed" only when neither applies', () => {
    expect(categoryDeleteMessage({ homeCount: 3, sheet: { onSheet: 2, withCounts: 0 }, locationId: 'L' }))
      .toEqual(['3 items move to General at L.', '2 items are also counted on this sheet (no counts on it yet) — they will stay on their other sheets.', 'This can’t be undone in bulk.'])
    expect(categoryDeleteMessage({ homeCount: 0, sheet: { onSheet: 0, withCounts: 0 }, locationId: 'L' }))
      .toEqual(['No items use this category here — it will just be removed.'])
  })

  it('the manager is given live sheet usage, and the prompt uses it', () => {
    const INV = code('src/routes/Inventory.jsx')
    expect(INV).toMatch(/sheetUsage=\{\(catKey\) => sheetUsage\(items, catKey\)\}/)
    const M = code('src/components/inventory/CategoryManagerModal.jsx')
    expect(M).toMatch(/sheet: sheetUsage \? sheetUsage\(migration\.cat\.key\)/)
    expect(M).not.toMatch(/No items carry this label here — the category will just be removed/)
  })
})
