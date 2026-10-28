/**
 * Item-list upload — MERGE (the default, safe behavior) + full-replace demoted
 * behind an explicit, named confirm. Stage: the old uploadCatalog deleted every
 * item at a location and rebuilt from the file, wiping par levels, shelf
 * position, category overrides, removed-flags, and multi-category sheet
 * membership on every re-upload. Now "Item list" merges; the old behavior is
 * "Replace entire catalog", separate, confirmed, and backed up first.
 *
 * THE NON-NEGOTIABLE GUARANTEE: a merge never writes countCategories for a
 * matched (existing) item — not reset, not re-set — so a split item can't
 * collapse to its home sheet mid-count. Tested directly, repeatedly, below.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import {
  buildCatalogMerge, catalogLossSummary, catalogLossWarningText, catalogBackupTimestamp,
} from '../src/lib/catalogImport'
import { buildCatalogIndex, normUpc, nameSlug } from '../src/lib/countUpload'
import { getDefaultCategories } from '../src/hooks/useInventory'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const code = p => readFileSync(resolve(ROOT, p), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

const CATS = getDefaultCategories()
const row = (name, extra = {}) => ({ Description: name, 'Pack Price': '$12.00', Vendor: 'sysco', ...extra })
const H = rows => Object.keys(rows[0])

// An "existing" item doc, as stored — the full set of fields a real catalog
// item at this location can carry, so a test can assert each one survives.
const existingDoc = (id, overrides = {}) => ({
  id,
  data: {
    name: id, sku: '', vendor: 'old-vendor', packSize: 'case', qtyPerPack: 1, packPrice: 5, unitCost: 5,
    glCode: '', category: 'General', categoryExplicit: false,
    parLevel: null, reorderPoint: null, avgDailyUsage: null,
    catShelfOrder: null, flatShelfOrder: null, isKey: false,
    countCategories: [], removed: false, custom: false,
    ...overrides,
  },
})

describe('back-compat case — an item NOT in the file, and a plain re-upload', () => {
  it('an existing item matched by name is updated (pricing) but not touched for anything else', () => {
    const existing = [existingDoc('old_cola', {
      name: 'Old Cola', vendor: 'old-vendor', packPrice: 5,
      parLevel: 12, reorderPoint: 4, catShelfOrder: 7, flatShelfOrder: 40, isKey: true,
      category: 'Hand-Picked Category', categoryExplicit: true,
    })]
    const r = [row('Old Cola', { 'Pack Price': '$99.00', Vendor: 'new-vendor' })]
    const m = buildCatalogMerge(r, H(r), existing, CATS, {}, {})
    expect(m.toAdd).toEqual([])
    expect(m.toUpdate).toHaveLength(1)
    const u = m.toUpdate[0]
    expect(u.id).toBe('old_cola')
    expect(u.data.packPrice).toBe(99)
    expect(u.data.vendor).toBe('new-vendor')
    // PRESERVED — none of these keys are even PRESENT in the update payload,
    // so merge:true cannot touch them regardless of what's currently stored.
    for (const key of ['parLevel', 'reorderPoint', 'catShelfOrder', 'flatShelfOrder', 'isKey', 'category', 'categoryExplicit', 'countCategories', 'removed', 'removedAt', 'removedBy', 'custom']) {
      expect(u.data).not.toHaveProperty(key)
    }
  })
})

describe('AN ITEM NOT IN THE FILE IS NEVER DESTROYED', () => {
  const existing = [existingDoc('in_file'), existingDoc('missing_item', { name: 'Missing Item' })]
  const r = [row('in_file')]

  it('report-only by default: notInFile lists it, toHide is empty, no write targets it', () => {
    const m = buildCatalogMerge(r, H(r), existing, CATS, {}, {})
    expect(m.notInFile).toEqual([{ id: 'missing_item', name: 'Missing Item' }])
    expect(m.toHide).toEqual([])
    expect(m.toUpdate.map(u => u.id)).not.toContain('missing_item')
    expect(m.toAdd.map(a => a.id)).not.toContain('missing_item')
  })

  it('opt-in hideNotInFile: flagged for the REMOVED mechanism (restorable), never a delete instruction', () => {
    const m = buildCatalogMerge(r, H(r), existing, CATS, { hideNotInFile: true }, {})
    expect(m.toHide).toEqual([{ id: 'missing_item', name: 'Missing Item' }])
    // The merge module itself never returns a "delete" instruction of any kind —
    // the caller (Inventory.jsx) turns toHide into a removed:true WRITE.
    expect(m).not.toHaveProperty('toDelete')
  })

  it('merge never writes ANY delete, with or without the checkbox', () => {
    const SRC = code('src/routes/Inventory.jsx')
    const fn = SRC.slice(SRC.indexOf('async function uploadCatalog'), SRC.indexOf('async function replaceCatalog'))
    expect(fn).not.toMatch(/\.delete\(/)
    expect(fn).not.toMatch(/deleteDoc/)
    expect(fn).toMatch(/removed: true/)   // the hide path is a write, not a delete
  })
})

describe('new rows get the next available position, never position 1', () => {
  it('appended after the max existing position on BOTH shelf fields', () => {
    const existing = [existingDoc('a', { catShelfOrder: 3, flatShelfOrder: 50 }), existingDoc('b', { catShelfOrder: 9, flatShelfOrder: 12 })]
    const r = [row('New One'), row('New Two')]
    const m = buildCatalogMerge(r, H(r), existing, CATS, {}, {})
    expect(m.toAdd.map(a => [a.data.catShelfOrder, a.data.flatShelfOrder])).toEqual([[10, 51], [11, 52]])
  })

  it('an empty catalog still starts after 0 (position 1), as before', () => {
    const r = [row('First'), row('Second')]
    const m = buildCatalogMerge(r, H(r), [], CATS, {}, {})
    expect(m.toAdd.map(a => a.data.catShelfOrder)).toEqual([1, 2])
  })

  it('new items keep FILE ORDER relative to each other, not matched/unmatched interleaving', () => {
    const existing = [existingDoc('b_item', { name: 'B Item' })]
    const r = [row('Z New'), row('B Item', { 'Pack Price': '$1.00' }), row('A New')]
    const m = buildCatalogMerge(r, H(r), existing, CATS, {}, {})
    expect(m.toAdd.map(a => a.data.name)).toEqual(['Z New', 'A New'])
    expect(m.toAdd[0].data.catShelfOrder).toBeLessThan(m.toAdd[1].data.catShelfOrder)
  })
})

describe('matching: UPC, then slug, then name — same priority as countUpload.js', () => {
  it('UPC wins even when the name differs completely', () => {
    const existing = [existingDoc('old_id', { name: 'Totally Different Name', sku: '041100005067' })]
    const r = [row('Brand New Name On The File', { UPC: '041100005067' })]
    const m = buildCatalogMerge(r, H(r), existing, CATS, {}, {})
    expect(m.toUpdate).toHaveLength(1)
    expect(m.toUpdate[0].id).toBe('old_id')
  })

  it('falls to slug when there is no UPC hit (or no UPC column)', () => {
    const existing = [existingDoc('coke_20oz', { name: 'Coke 20oz' })]
    const r = [row('  coke   20OZ  ')]   // slugs identically despite spacing/case
    const m = buildCatalogMerge(r, H(r), existing, CATS, {}, {})
    expect(m.toUpdate[0]?.id).toBe('coke_20oz')
  })

  it('falls to raw lowercased name when neither UPC nor slug hits', () => {
    // nameSlug() strips punctuation, so "Ben & Jerry's" slugs to "ben_jerrys";
    // give the existing item a DIFFERENT stored name so slug can't match, but
    // let the raw lowercased name match exactly.
    const existing = [existingDoc('bj_pint', { name: "ben & jerry's pint" })]
    const r = [row("Ben & Jerry's Pint")]
    const m = buildCatalogMerge(r, H(r), existing, CATS, {}, {})
    expect(m.toUpdate[0]?.id).toBe('bj_pint')
  })

  it('reuses buildCatalogIndex/normUpc/nameSlug directly — not a recomputed, possibly-drifted slug', () => {
    const SRC = code('src/lib/catalogImport.js')
    const fn = SRC.slice(SRC.indexOf('export function buildCatalogMerge'), SRC.indexOf('const notInFile ='))
    expect(fn).toMatch(/buildCatalogIndex\(/)
    expect(fn).toMatch(/normUpc\(sku\)/)
    expect(fn).toMatch(/nameSlug\(nameStr\)/)
  })
})

describe('a renamed-since-import item\'s doc id is never silently stolen by a new row', () => {
  it('a new row whose computed id collides with an unmatched existing doc gets a suffixed id', () => {
    // 'coke_20oz' now holds "Mega Coke 20oz" (renamed after its own import) —
    // content matching correctly finds no match for a file row named "Coke 20oz".
    const existing = [existingDoc('coke_20oz', { name: 'Mega Coke 20oz' })]
    const r = [row('Coke 20oz')]
    const m = buildCatalogMerge(r, H(r), existing, CATS, {}, {})
    expect(m.toUpdate).toEqual([])               // correctly NOT matched
    expect(m.toAdd).toHaveLength(1)
    expect(m.toAdd[0].id).not.toBe('coke_20oz')  // never the existing item's id
    expect(m.toAdd[0].id).toBe('coke_20oz_2')
  })
})

describe('THE NON-NEGOTIABLE GUARANTEE — countCategories is NEVER written for a matched row', () => {
  it('a currently-SPLIT matched item: the update payload has no countCategories key at all', () => {
    const existing = [existingDoc('milk', { countCategories: ['bar', 'boh'] })]
    const r = [row('milk', { 'Pack Price': '$8.00' })]
    const m = buildCatalogMerge(r, H(r), existing, CATS, {}, {})
    expect(m.toUpdate[0].data).not.toHaveProperty('countCategories')
  })

  it('a non-split matched item: still no countCategories key (never reset to [])', () => {
    const existing = [existingDoc('gum', { countCategories: [] })]
    const r = [row('gum')]
    const m = buildCatalogMerge(r, H(r), existing, CATS, {}, {})
    expect(m.toUpdate[0].data).not.toHaveProperty('countCategories')
  })

  it('holds with updateCategories ALSO checked — the two options are independent', () => {
    const existing = [existingDoc('milk', { countCategories: ['bar', 'boh'] })]
    const r = [row('milk', { Category: 'Beverages' })]
    const m = buildCatalogMerge(r, H(r), existing, CATS, { updateCategories: true }, {})
    expect(m.toUpdate[0].data).not.toHaveProperty('countCategories')
    expect(m.toUpdate[0].data.category).toBe('Beverages')   // category DID update — different field
  })

  it('a brand-new item never has countCategories either (0/1 category is the only valid starting state)', () => {
    const r = [row('New Split Candidate')]
    const m = buildCatalogMerge(r, H(r), [], CATS, {}, {})
    expect(m.toAdd[0].data).not.toHaveProperty('countCategories')
  })

  it('the source literally never assigns to merge.toUpdate[].data.countCategories', () => {
    const SRC = code('src/lib/catalogImport.js')
    const fn = SRC.slice(SRC.indexOf('export function buildCatalogMerge'), SRC.indexOf('const notInFile ='))
    const updatePayload = fn.slice(fn.indexOf('toUpdate.push({'), fn.indexOf('continue\n    }'))
    expect(updatePayload).not.toMatch(/countCategories/)
  })
})

describe('category: file applies to NEW items always; existing items only opt-in and only when the row has a value', () => {
  it('a NEW item always gets the file category, with no opt-in needed', () => {
    const r = [row('Brand New', { Category: 'Coke Storage Closet' })]
    const m = buildCatalogMerge(r, H(r), [], CATS, {}, {})
    expect(m.toAdd[0].data).toMatchObject({ category: 'Coke Storage Closet', categoryExplicit: true })
    expect(m.newCategories).toHaveLength(1)
  })

  it('a MATCHED item: file category is IGNORED by default, even though the row names one', () => {
    const existing = [existingDoc('gum', { category: 'Hand Picked', categoryExplicit: true })]
    const r = [row('gum', { Category: 'Snacks' })]
    const m = buildCatalogMerge(r, H(r), existing, CATS, {}, {})
    expect(m.toUpdate[0].data).not.toHaveProperty('category')
    expect(m.toUpdate[0].data).not.toHaveProperty('categoryExplicit')
    expect(m.newCategories).toEqual([])
  })

  it('a MATCHED item with updateCategories ON: applies the file category (reusing an existing/built-in label, never duplicating)', () => {
    const existing = [existingDoc('gum', { category: 'Hand Picked', categoryExplicit: true })]
    const r = [row('gum', { Category: 'Snacks' })]   // "Snacks" is a built-in alias for the real "Pantry / Snacks" category
    const m = buildCatalogMerge(r, H(r), existing, CATS, { updateCategories: true }, {})
    expect(m.toUpdate[0].data).toMatchObject({ category: 'Pantry / Snacks', categoryExplicit: true })
    expect(m.newCategories).toEqual([])   // reused, not created
  })

  it('updateCategories ON but the row has NO category value: still untouched (never falls back to inference)', () => {
    const existing = [existingDoc('gum', { category: 'Hand Picked', categoryExplicit: true })]
    const r = [row('gum')]   // no Category column value at all
    const m = buildCatalogMerge(r, H(r), existing, CATS, { updateCategories: true }, {})
    expect(m.toUpdate[0].data).not.toHaveProperty('category')
  })

  it('updateCategories ON, file names a NEW category for a matched item: creates it once, assigns it', () => {
    const existing = [existingDoc('gum')]
    const r = [row('gum', { Category: 'Coke Storage Closet' })]
    const m = buildCatalogMerge(r, H(r), existing, CATS, { updateCategories: true }, {})
    expect(m.newCategories).toHaveLength(1)
    expect(m.toUpdate[0].data.category).toBe('Coke Storage Closet')
  })
})

describe('custom items — never matched, never updated, never flagged as missing', () => {
  it('a custom item is excluded from matching (a same-name file row creates a NEW item instead)', () => {
    const existing = [existingDoc('custom_123', { name: 'Hand Entered Thing', custom: true })]
    const r = [row('Hand Entered Thing')]
    const m = buildCatalogMerge(r, H(r), existing, CATS, {}, {})
    expect(m.toUpdate).toEqual([])
    expect(m.toAdd).toHaveLength(1)
    expect(m.toAdd[0].id).not.toBe('custom_123')
  })

  it('a custom item never appears in notInFile', () => {
    const existing = [existingDoc('custom_123', { name: 'Hand Entered Thing', custom: true })]
    const m = buildCatalogMerge([], [], existing, CATS, {}, {})
    expect(m.notInFile).toEqual([])
  })
})

describe('an already-removed (hidden) item', () => {
  it('still matches by name/UPC (so its pricing refreshes) but removed-state is never in the update payload', () => {
    const existing = [existingDoc('hidden_item', { name: 'Hidden Item', removed: true })]
    const r = [row('Hidden Item', { 'Pack Price': '$50.00' })]
    const m = buildCatalogMerge(r, H(r), existing, CATS, {}, {})
    expect(m.toUpdate).toHaveLength(1)
    expect(m.toUpdate[0].data.packPrice).toBe(50)
    expect(m.toUpdate[0].data).not.toHaveProperty('removed')
  })

  it('never appears in notInFile (it is already intentionally hidden — not new information)', () => {
    const existing = [existingDoc('hidden_item', { name: 'Hidden Item', removed: true })]
    const m = buildCatalogMerge([], [], existing, CATS, {}, {})
    expect(m.notInFile).toEqual([])
  })
})

describe('duplicates — first wins, in both directions', () => {
  it('two file rows match the SAME existing item: first updates, second is reported', () => {
    const existing = [existingDoc('coke', { name: 'Coke' })]
    const r = [row('Coke', { 'Pack Price': '$10.00' }), row('Coke', { 'Pack Price': '$99.00' })]
    const m = buildCatalogMerge(r, H(r), existing, CATS, {}, {})
    expect(m.toUpdate).toHaveLength(1)
    expect(m.toUpdate[0].data.packPrice).toBe(10)
    expect(m.duplicates).toEqual([{ id: 'coke', name: 'Coke', reason: 'matched-existing' }])
  })

  it('two unmatched rows collide on the same NEW id: first is added, second reported', () => {
    const r = [row('Brand New', { 'Pack Price': '$10.00' }), row('Brand New', { 'Pack Price': '$99.00' })]
    const m = buildCatalogMerge(r, H(r), [], CATS, {}, {})
    expect(m.toAdd).toHaveLength(1)
    expect(m.toAdd[0].data.packPrice).toBe(10)
    expect(m.duplicates).toEqual([{ id: 'brand_new', name: 'Brand New', reason: 'file-row' }])
  })
})

describe('full replace: the loss summary names exact counts, not a generic warning', () => {
  it('counts par, position, split-membership, key-items and hidden items independently', () => {
    const existing = [
      existingDoc('a', { parLevel: 5 }),
      existingDoc('b', { catShelfOrder: 1 }),
      existingDoc('c', { countCategories: ['bar', 'boh'] }),
      existingDoc('d', { isKey: true }),
      existingDoc('e', { removed: true }),
      existingDoc('f'),
    ]
    const s = catalogLossSummary(existing)
    expect(s).toEqual({ total: 5, withPar: 1, withPosition: 1, withSplit: 1, withKey: 1, removedCount: 1 })
  })

  it('withPar counts ANY of parLevel/reorderPoint/avgDailyUsage, not parLevel alone', () => {
    const existing = [
      existingDoc('only-reorder', { reorderPoint: 3 }),
      existingDoc('only-avg', { avgDailyUsage: 2 }),
      existingDoc('neither'),
    ]
    expect(catalogLossSummary(existing).withPar).toBe(2)
  })

  it('withPosition counts EITHER shelf field alone, not just flatShelfOrder', () => {
    expect(catalogLossSummary([existingDoc('x', { catShelfOrder: 1, flatShelfOrder: null })]).withPosition).toBe(1)
  })

  it('the warning text names every non-zero count, and nothing when the catalog is empty', () => {
    const s = catalogLossSummary([existingDoc('a', { parLevel: 5, catShelfOrder: 1, countCategories: ['bar', 'boh'], isKey: true })])
    const text = catalogLossWarningText(s, 'Test Sandbox')
    expect(text).toContain('Replace the ENTIRE item catalog at Test Sandbox?')
    expect(text).toContain('1 item with a saved shelf/print order')
    expect(text).toContain('1 item with par/reorder levels set')
    expect(text).toContain('1 item counted on more than one category sheet')
    expect(text).toContain('1 item marked as a quick-count key item')
    expect(catalogLossWarningText(catalogLossSummary([]), 'Empty Loc')).toMatch(/nothing will be lost/)
  })

  it('replaceCatalog shows this confirm BEFORE deleting, and aborts on cancel', () => {
    const SRC = code('src/routes/Inventory.jsx')
    const fn = SRC.slice(SRC.indexOf('async function replaceCatalog'), SRC.indexOf('async function'.length > 0 ? SRC.indexOf('async function', SRC.indexOf('async function replaceCatalog') + 1) : SRC.length))
    const confirmAt = fn.indexOf('catalogLossWarningText(')
    expect(confirmAt).toBeGreaterThan(-1)
    expect(confirmAt).toBeLessThan(fn.indexOf('if (existingDocs.length) {'))
    expect(fn).toMatch(/if \(!window\.confirm\(catalogLossWarningText\(summary, cleanLocName\(location\)\)\)\) \{/)
  })

  it('both merge and replace write a backup BEFORE their first catalog-mutating write', () => {
    const SRC = code('src/routes/Inventory.jsx')
    const mergeFn = SRC.slice(SRC.indexOf('async function uploadCatalog'), SRC.indexOf('async function replaceCatalog'))
    const mergeBackupAt = mergeFn.indexOf('backupLocationCatalog(')
    const mergeWriteAt = mergeFn.indexOf('buildCatalogMerge(')
    expect(mergeBackupAt).toBeGreaterThan(-1)    // present at all — NOT just "earlier than a write that may not exist"
    expect(mergeWriteAt).toBeGreaterThan(-1)
    expect(mergeBackupAt).toBeLessThan(mergeWriteAt)

    const replaceFn = SRC.slice(SRC.indexOf('async function replaceCatalog'))
    const replaceBackupAt = replaceFn.indexOf('backupLocationCatalog(')
    const replaceWriteAt = replaceFn.indexOf('buildCatalogImport(')
    expect(replaceBackupAt).toBeGreaterThan(-1)
    expect(replaceWriteAt).toBeGreaterThan(-1)
    expect(replaceBackupAt).toBeLessThan(replaceWriteAt)
  })
})

describe('backup timestamp', () => {
  it('is a valid, sortable, Firestore-doc-id-safe string', () => {
    const t = catalogBackupTimestamp(new Date('2026-01-02T03:04:05.678Z'))
    expect(t).toBe('2026-01-02T03-04-05-678Z')
    expect(t).not.toMatch(/[:.]/)
  })
})

describe('the isKey hydration bug (found in scope, fixed here)', () => {
  it('a location-owned catalog item now hydrates isKey — toggleKey no longer gets silently dropped on reload', () => {
    const SRC = code('src/hooks/useInventory.js')
    const block = SRC.slice(SRC.indexOf('if (locationHasOwnCatalog) {'), SRC.indexOf("console.log('Using location-specific catalog:'"))
    expect(block).toMatch(/isKey: item\.isKey \|\| false,/)
  })
})

describe('UI wiring — merge is the default "Item list" button; replace is separate and demoted', () => {
  const INV = code('src/routes/Inventory.jsx')

  it('the Item list input still calls uploadCatalog (now merge)', () => {
    expect(INV).toMatch(/id="catalog-upload"[\s\S]{0,120}uploadCatalog\(e\.target\.files\[0\]\)/)
  })

  it('a separate input + trigger exist for replaceCatalog, not reachable from the Item list label', () => {
    expect(INV).toMatch(/id="catalog-replace-upload"[\s\S]{0,120}replaceCatalog\(e\.target\.files\[0\]\)/)
    expect(INV).toMatch(/htmlFor=\{replacingCatalog \? undefined : 'catalog-replace-upload'\}/)
  })

  it('both checkboxes are read at upload time and default off', () => {
    expect(INV).toMatch(/const \[mergeUpdateCategories, setMergeUpdateCategories\] = useState\(false\)/)
    expect(INV).toMatch(/const \[mergeHideNotInFile, setMergeHideNotInFile\] = useState\(false\)/)
    expect(INV).toMatch(/updateCategories: mergeUpdateCategories, hideNotInFile: mergeHideNotInFile/)
  })
})
