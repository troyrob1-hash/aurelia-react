// "Item list" (catalog) upload — the row → item-record mapping, pure.
//
// Extracted from Inventory.jsx's uploadCatalog so the rules are tested against
// the code that ships. The parsing helpers (findCol, parsePrice, parseGlCode,
// the skip rules, the id slug, inferImportCategory) moved here VERBATIM; two
// things are new:
//
//  1. FILE ORDER IS KEPT. Each written item is stamped with catShelfOrder and
//     flatShelfOrder = its position among the written rows (1, 2, 3… — skipped
//     rows don't leave gaps). Those are the fields drag-to-reorder writes and
//     byShelf sorts by, so an uploaded category comes out in the file's row
//     order on screen, after reload, and on the printed count sheet. Without a
//     position every uploaded item fell to byShelf's "unplaced → A–Z" bucket,
//     which is why uploads always came out alphabetical. Drag still overrides.
//
//  2. THE FILE'S CATEGORY IS HONORED. A "Category" / "Dept" / "Department" /
//     "Item Type" column assigns the item to the category NAMED in the file
//     (e.g. "Coke Storage Closet"), creating it at the location if it doesn't
//     exist. A name that already exists — in any capitalization, or as a
//     built-in alias ("Barista" → Bar / Barista, "Beverage" → Beverages) —
//     reuses that category instead of creating a duplicate. Only a row with no
//     category value falls back to inferImportCategory (GL / name keywords).
//
// Duplicate ids (two rows whose names slug to the same id): the FIRST row wins
// — its position and its data. A later duplicate is skipped and reported.

import { PALETTE, slugify, uniqueKey } from '@/lib/categoryHelpers'
import { buildCatalogIndex, normUpc, nameSlug } from '@/lib/countUpload'

/** Doc id for an imported item — the slug the upload has always used. */
export function catalogItemId(name) {
  return String(name).trim()
    .replace(/[^a-zA-Z0-9\s]/g, '')
    .replace(/\s+/g, '_')
    .toLowerCase()
    .slice(0, 80)
}

/** Fuzzy column finder — exact (case-insensitive) first, then partial. */
export function findCol(row, headers, aliases) {
  for (const alias of aliases) {
    const match = headers.find(h => h.toLowerCase().trim() === alias.toLowerCase().trim())
    if (match && row[match] !== undefined && row[match] !== '') return row[match]
  }
  for (const alias of aliases) {
    const match = headers.find(h => h.toLowerCase().trim().includes(alias.toLowerCase().trim()))
    if (match && row[match] !== undefined && row[match] !== '') return row[match]
  }
  return null
}

export function parsePrice(val) {
  if (val == null || val === '') return 0
  const s = String(val).replace(/[\$,\s]/g, '').trim()
  return parseFloat(s) || 0
}

export function parseGlCode(val) {
  if (!val) return ''
  const s = String(val).trim()
  // Extract numeric GL code from "12000 - Inventory - Cafeteria"
  const match = s.match(/^(\d+)/)
  return match ? match[1] : s
}

/** Instruction / header / total rows in Fooda templates — never items. */
export function isSkippableName(nameStr) {
  const l = nameStr.toLowerCase()
  if (nameStr.length > 80) return true
  if (l.startsWith('step ') || l.startsWith('complete ') || l.startsWith('enter ') || l.startsWith('review ') || l.startsWith('this report')) return true
  if (nameStr.includes('12000 -') || nameStr.includes('12002 -') || nameStr.includes('Inventory -')) return true
  return ['grand total', 'total ending', 'beginning inventory', 'ending inventory', 'cost of goods',
    'monthly purchases', 'transfer log', 'waste log', 'return to dashboard', 'cogs',
    'inventory count performed', 'café pos'].some(w => l.includes(w))
}

/** The upload's long-standing category inference — now only the FALLBACK. */
export function inferImportCategory(glCode, itemType, itemName) {
  const gl = String(glCode).toLowerCase()
  const t = String(itemType || '').toLowerCase()
  const n = String(itemName || '').toLowerCase()

  // 1. GL code is the strongest signal
  if (gl.includes('12002')) return 'Barista'

  // 2. Explicit item type from Excel (handle typos)
  if (t.includes('barista')) return 'Barista'
  if (t.includes('beverage') || t.includes('bev')) return 'Beverages'
  if (t.includes('snack') || t.includes('snac')) return 'Snacks'
  if (t.includes('condiment') || t.includes('cond')) return 'Condiments'

  // 3. Infer from item name — beverages
  const bevWords = ['juice', 'water', 'soda', 'kombucha', 'tea', 'lemonade', 'coffee', 'frappuccino', 'cola', 'coke', 'sprite', 'gatorade', 'celsius', 'red bull', 'rockstar', 'yerba', 'milk ', 'almond milk', 'oat milk', 'soy milk', 'coconut milk', 'half & half', 'cream', 'protein shake', 'naked ', 'illy ', 'tractor beverage', 'aura bora', 'boylan', "virgil's", "joe's", 'joe tea', 'eclipse water', 'boxed water', 'smart water', 'topochico', 'perrier', 'pelegrino']
  if (bevWords.some(w => n.includes(w))) return 'Beverages'

  // 4. Infer from name — barista
  const barWords = ['cafe moto', 'espresso', 'chai', 'syrup 1883', 'syrup ', 'ghirardelli', 'david rio', 'matcha', 'teavana', 'starbucks cold brew', 'starbucks veranda', 'starbucks pike', 'starbucks verona', 'starbucks decaf', 'starbucks holiday', 'cream charger', 'agave', 'caramel sauce', 'chocolate sauce', 'white chocolate sauce', 'pumpkin spice', 'caramel brulee', 'freeze dried', 'dragonfruit', 'strawberry acai', 'mango dragonfruit', 'ground cinnamon', 'heavy cream']
  if (barWords.some(w => n.includes(w))) return 'Barista'

  // 5. Infer from name — condiments/supplies
  const condWords = ['sauce', 'hot sauce', 'sriracha', 'cholula', 'tapatio', 'tabasco', 'ketchup', 'mustard', 'mayonnaise', 'soy sauce', 'salt packet', 'pepper packet', 'sugar ', 'sweetener', 'packet']
  if (condWords.some(w => n.includes(w))) return 'Condiments'

  // 6. Infer from name — snacks/food
  const snackWords = ['bar ', 'chip', 'cookie', 'candy', 'chocolate', 'gummy', 'jerky', 'pretzel', 'popcorn', 'cracker', 'nut ', 'nuts', 'almond', 'cashew', 'granola', 'oatmeal', 'yogurt', 'cheese', 'salami', 'hummus', 'guacamole', 'pickle', 'olive', 'seaweed', 'mints', 'gum', 'fruit', 'wafel', 'uncrustable', 'pop tart', 'oreo', 'ice cream', 'frozen', 'soup', 'cheesecake', 'brownie', 'blondie', 'marshmallow', 'rice crisp']
  if (snackWords.some(w => n.includes(w))) return 'Snacks'

  // 7. Fallback by GL
  if (gl.includes('12000')) return 'Snacks'
  return 'Other'
}

// Headers that carry the item's category, in priority order. Matched EXACTLY
// (case/space-insensitive) — a partial match would catch "Subcategory" or a
// pack "Type" column.
const CATEGORY_HEADERS = ['category', 'dept', 'department', 'item type', 'itemtype']
const normHeader = h => String(h).toLowerCase().replace(/[\s_]+/g, ' ').trim()

/** The header holding each row's category, or null when the file has none. */
export function findCategoryHeader(headers) {
  for (const want of CATEGORY_HEADERS) {
    const hit = (headers || []).find(h => normHeader(h) === want || normHeader(h).replace(/ /g, '') === want.replace(/ /g, ''))
    if (hit) return hit
  }
  return null
}

// Built-in spellings that mean an EXISTING built-in category (so a template's
// "Beverage" or "Snack" doesn't create a near-duplicate). Values are the keys
// assignCategory resolves them to (see CATEGORY_ALIASES in useInventory.js).
const BUILTIN_SYNONYMS = {
  barista: 'bar_items', baristas: 'bar_items',
  beverage: 'beverages', beverages: 'beverages', bev: 'beverages', bevs: 'beverages',
  snack: 'pantry', snacks: 'pantry',
  condiment: 'condiments', condiments: 'condiments',
  cafeteria: 'pantry',
}

/**
 * Resolve a file's category value against the location's categories.
 * @returns {{ label: string, key: string, isNew: boolean } | null}  null = blank value
 *   label — what to store on item.category (an existing category's own label)
 */
export function resolveFileCategory(value, categories) {
  const name = String(value ?? '').trim().replace(/\s+/g, ' ')
  if (!name) return null
  const cats = Array.isArray(categories) ? categories : []
  const low = name.toLowerCase()
  const byLabelOrKey = cats.find(c => String(c.label || '').toLowerCase() === low || String(c.key || '').toLowerCase() === low)
    || cats.find(c => c.key === slugify(name))
  if (byLabelOrKey) return { label: byLabelOrKey.label || byLabelOrKey.key, key: byLabelOrKey.key, isNew: false }
  const syn = BUILTIN_SYNONYMS[low]
  const builtin = syn && cats.find(c => c.key === syn)
  if (builtin) return { label: builtin.label || builtin.key, key: builtin.key, isNew: false }
  return { label: name, key: null, isNew: true }
}

/**
 * Map the sheet's rows to item records to write, in FILE ORDER.
 *
 * @param rows        sheet_to_json rows (objects keyed by header)
 * @param headers     the header row's keys
 * @param categories  the location's current categories
 * @param meta        { importedAt, importedBy }
 * @returns {{
 *   items: { id: string, data: object }[],  in file order, positions 1..N
 *   newCategories: object[],                 categories to create (full {key,label,color,bg,keywords})
 *   duplicates: { id, name }[],              later rows skipped because an earlier row had the same id
 *   categoryHeader: string|null,
 * }}
 */
export function buildCatalogImport(rows, headers, categories, meta = {}) {
  const hdrs = headers || []
  const col = (row, aliases) => findCol(row, hdrs, aliases)
  const categoryHeader = findCategoryHeader(hdrs)
  const known = [...(Array.isArray(categories) ? categories : [])]
  const newCategories = []
  const items = []
  const duplicates = []
  const seen = new Set()

  for (const row of rows || []) {
    const parsed = parseCatalogRow(row, hdrs)
    if (!parsed) continue
    const { nameStr } = parsed

    const itemId = catalogItemId(nameStr)
    if (!itemId) continue
    if (seen.has(itemId)) { duplicates.push({ id: itemId, name: nameStr }); continue }   // first row wins
    seen.add(itemId)

    const { category, categoryExplicit } = resolveRowCategory(row, categoryHeader, parsed, known, newCategories)

    const position = items.length + 1   // among WRITTEN rows → no gaps
    items.push({
      id: itemId,
      data: {
        ...parsedRowToItemFields(parsed),
        category,
        ...(categoryExplicit ? { categoryExplicit: true } : {}),
        // File row order — the same fields drag-to-reorder writes (byShelf).
        catShelfOrder: position,
        flatShelfOrder: position,
        isCatalogItem: true,
        qty: null,
        active: true,
        importedAt: meta.importedAt ?? new Date().toISOString(),
        importedBy: meta.importedBy ?? '',
      },
    })
  }
  return { items, newCategories, duplicates, categoryHeader }
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared per-row parsing — ONE place both buildCatalogImport (full replace) and
// buildCatalogMerge share, so the two can never read a column differently.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse one sheet row into its raw fields, or null for a row that isn't an
 * item (no name, an instruction/section/total row per isSkippableName, or no
 * cost data at all — the same "section header" skip buildCatalogImport always
 * used). Pure extraction only — no id, no category, no position.
 */
function parseCatalogRow(row, hdrs) {
  const col = (aliases) => findCol(row, hdrs, aliases)
  const name = col(['Description', 'Item', 'Item Name', 'Name', 'Product'])
  if (!name || String(name).trim() === '') return null
  const nameStr = String(name).trim()
  if (isSkippableName(nameStr)) return null

  // NOTE two different alias lists for the same thing, on purpose, preserving
  // buildCatalogImport's exact original behavior byte-for-byte: the skip-check
  // (is this row an item at all?) is generous and also accepts a bare "Price"
  // column; the STORED packPrice value is read with the narrower list, without
  // "Price". A row whose only price column is literally "Price" is therefore
  // still recognized as a real item (not skipped as a section header) but its
  // packPrice is left at 0 — that was already true before this file existed as
  // a shared module, so it's kept rather than "fixed" as part of a refactor.
  const skipCheckPackPrice = parsePrice(col(['Pack Price', 'Pack Cost', 'Case Price', 'Case Cost', 'Price']))
  const rowUnitCost = parsePrice(col(['Cost Per Unit', 'Unit Cost', 'Cost', 'Each Cost']))
  if (skipCheckPackPrice === 0 && rowUnitCost === 0) return null

  const sku = col(['SKU', 'UPC', 'Barcode'])
  const packSize = col(['Pack Size', 'Case Size', 'Unit Size']) || 'case'
  const packPrice = parsePrice(col(['Pack Price', 'Pack Cost', 'Case Price', 'Case Cost']))
  const unitCost = rowUnitCost
  const rawQtyPerPack = parseInt(col(['Qty Per Pack', 'Qty/Pack', 'Case Qty', 'Pack Qty', 'Qty']))
  const qtyPerPack = rawQtyPerPack > 0 ? rawQtyPerPack : (packPrice > 0 && unitCost > 0 ? Math.round(packPrice / unitCost) : 1)
  const vendor = col(['Vendor', 'Supplier', 'Distributor', 'Purveyor']) || ''
  const rawGl = col(['GL Code', 'GL', 'Account', 'GL Account']) || ''
  const glCode = parseGlCode(rawGl)
  const sellingPrice = parsePrice(col(['Selling Price', 'Retail Price', 'Price', 'Sell Price']))
  const cogsRatio = col(['COGS', 'COGS %', 'Food Cost'])
  const itemType = col(['Item Type', 'Type', 'Category', 'Dept']) || ''

  return {
    nameStr, sku, packSize, packPrice, unitCost, qtyPerPack, vendor,
    rawGl, glCode, sellingPrice, cogsRatio, itemType,
  }
}

/** The pricing/definition fields a row contributes — shared by add and update payloads. */
function parsedRowToItemFields(parsed) {
  return {
    name: parsed.nameStr,
    sku: parsed.sku ? String(parsed.sku).trim() : '',
    packSize: String(parsed.packSize).trim(),
    qtyPerPack: parsed.qtyPerPack,
    packPrice: parsed.packPrice,
    unitCost: parsed.unitCost,
    vendor: String(parsed.vendor).trim(),
    glCode: parsed.glCode,
    glCodeFull: String(parsed.rawGl).trim(),
    sellingPrice: parsed.sellingPrice,
    cogsRatio: parsePrice(String(parsed.cogsRatio).replace('%', '')) / 100 || 0,
    itemType: String(parsed.itemType).trim(),
  }
}

/** Category for a NEW item: the file's value (creating the category if needed), else inference. */
function resolveRowCategory(row, categoryHeader, parsed, known, newCategories) {
  const fileCat = categoryHeader ? resolveFileCategory(row[categoryHeader], known) : null
  if (!fileCat) return { category: inferImportCategory(parsed.rawGl, parsed.itemType, parsed.nameStr), categoryExplicit: false }
  if (fileCat.isNew) {
    const { color, bg } = PALETTE[known.length % PALETTE.length]
    const created = { key: uniqueKey(slugify(fileCat.label), known.map(c => c.key)), label: fileCat.label, color, bg, keywords: [] }
    known.push(created)
    newCategories.push(created)
  }
  return { category: fileCat.label, categoryExplicit: true }
}

// ─────────────────────────────────────────────────────────────────────────────
// MERGE — the default "Item list" upload. Update what's in the file, add what's
// new, NEVER delete, NEVER touch the fields the file can't describe.
// ─────────────────────────────────────────────────────────────────────────────
//
// Matching reuses countUpload.js's exact matcher (buildCatalogIndex: UPC/SKU →
// name-slug → lowercased name) against the location's EXISTING items — not a
// freshly recomputed slug of the file row's name, so an item renamed since its
// last import (whose doc id no longer slugs from its current name) still matches
// by UPC or by its CURRENT name, rather than being treated as a stray new row.
//
// THE INTEGRATION GUARANTEE (multi-category): a matched row's update payload is
// built field-by-field in mergeUpdatePayload below and NEVER includes
// countCategories — not a reset to [], not a re-set to the file's value (the
// file has no way to express multi-category membership at all — one category
// column, one value per row). A split item stays split, with its per-sheet
// counts untouched, through any number of catalog re-uploads. Same guarantee
// for catShelfOrder/flatShelfOrder (arrangement), isKey (quick-count), and
// removed/removedAt/removedBy (a hidden item stays hidden — its pricing still
// refreshes, but it does not reappear on the count sheet).
//
// Category is updated for a matched row ONLY when opts.updateCategories is true
// AND the row has a non-blank file category value — never from inference (that
// would silently relabel a hand-corrected item from a column that doesn't even
// claim to name its category).

/**
 * @param rows        sheet_to_json rows
 * @param headers     the header row's keys
 * @param existingDocs  this location's CURRENT item docs — [{id, data}], RAW
 *                      Firestore data, not the display-enriched itemsWithMeta
 * @param categories  the location's current categories
 * @param opts        { updateCategories?: bool, hideNotInFile?: bool }
 * @param meta        { importedAt, importedBy }
 * @returns {{
 *   toAdd:    { id, data }[],   new items — full record, incl. position
 *   toUpdate: { id, data }[],   matched items — pricing/definition fields only
 *   toHide:   { id, name }[],   existing active items not in the file — ONLY
 *                               when opts.hideNotInFile; empty otherwise
 *   notInFile:{ id, name }[],   the same set, ALWAYS populated — the report
 *   newCategories: object[],
 *   duplicates: { id, name, reason: 'file-row'|'matched-existing' }[],
 *   categoryHeader: string|null,
 * }}
 */
export function buildCatalogMerge(rows, headers, existingDocs, categories, opts = {}, meta = {}) {
  const hdrs = headers || []
  const categoryHeader = findCategoryHeader(hdrs)
  const known = [...(Array.isArray(categories) ? categories : [])]
  const newCategories = []
  const existing = (existingDocs || []).filter(d => d && d.id != null)
  const existingIds = new Set(existing.map(d => d.id))
  // Custom items are NEVER match candidates — nothing in a file claims to BE a
  // custom item, so a same-name row must create a new item, never blend onto
  // the custom one. Already-REMOVED items ARE still matchable (so a matched
  // row's pricing/vendor/GL refreshes even while the item stays hidden — see
  // the removed-state guarantee below); they're excluded only from the
  // notInFile REPORT further down, since an item already hidden on purpose
  // isn't "missing," it's working as intended.
  const matchable = existing.filter(d => !d.data?.custom)
  const index = buildCatalogIndex(matchable.map(d => ({ id: d.id, name: d.data?.name, sku: d.data?.sku })))

  const toAdd = []
  const toUpdate = []
  const duplicates = []
  const matchedIds = new Set()
  const usedNewIds = new Set()

  // New items are appended AFTER every existing position (both shelf fields),
  // never at position 1 — a merge must never jump new rows ahead of an
  // arranged category. A safe global ceiling (not a per-category one): every
  // existing item's position is strictly less than any new item's, so a new
  // item sorts after every existing item regardless of which category it
  // lands in — byShelf only compares positions within one group, so gaps
  // introduced by this are harmless (see buildCatalogImport's header note).
  const maxOf = (field) => existing.reduce((m, d) => Math.max(m, Number(d.data?.[field]) || 0), 0)
  let nextCatPos = maxOf('catShelfOrder')
  let nextFlatPos = maxOf('flatShelfOrder')

  for (const row of rows || []) {
    const parsed = parseCatalogRow(row, hdrs)
    if (!parsed) continue
    const { nameStr, sku } = parsed

    const upc = normUpc(sku)
    const match = (upc && index.bySku[upc]) || index.bySlug[nameSlug(nameStr)] || index.byName[nameStr.toLowerCase().trim()] || null

    if (match) {
      if (matchedIds.has(match.id)) { duplicates.push({ id: match.id, name: nameStr, reason: 'matched-existing' }); continue }
      matchedIds.add(match.id)
      const fileCat = (opts.updateCategories && categoryHeader) ? resolveFileCategory(row[categoryHeader], known) : null
      if (fileCat?.isNew) {
        const { color, bg } = PALETTE[known.length % PALETTE.length]
        const created = { key: uniqueKey(slugify(fileCat.label), known.map(c => c.key)), label: fileCat.label, color, bg, keywords: [] }
        known.push(created)
        newCategories.push(created)
      }
      toUpdate.push({
        id: match.id,
        data: {
          ...parsedRowToItemFields(parsed),
          // Category ONLY when explicitly opted in AND the row actually names
          // one — see the file header note. Every other field below this line
          // in a normal item record is DELIBERATELY ABSENT: countCategories,
          // catShelfOrder, flatShelfOrder, isKey, removed/removedAt/removedBy,
          // custom. Omitted, not set-to-null — merge:true leaves them alone.
          ...(fileCat ? { category: fileCat.label, categoryExplicit: true } : {}),
          importedAt: meta.importedAt ?? new Date().toISOString(),
          importedBy: meta.importedBy ?? '',
        },
      })
      continue
    }

    // No match → a new item. Compute the same id buildCatalogImport would, but
    // guard against it colliding with an EXISTING doc that content-matching
    // didn't find (e.g. that item was renamed since its own last import, so its
    // doc id no longer slugs from its current name). A collision there must
    // never silently blend this row's fields onto an unrelated item — suffix
    // the new id instead (same uniqueKey scheme the category editor uses).
    let itemId = catalogItemId(nameStr)
    if (!itemId) continue
    if (usedNewIds.has(itemId)) { duplicates.push({ id: itemId, name: nameStr, reason: 'file-row' }); continue }
    if (existingIds.has(itemId)) itemId = uniqueKey(itemId, [...existingIds, ...usedNewIds])
    usedNewIds.add(itemId)

    const { category, categoryExplicit } = resolveRowCategory(row, categoryHeader, parsed, known, newCategories)
    nextCatPos += 1
    nextFlatPos += 1
    toAdd.push({
      id: itemId,
      data: {
        ...parsedRowToItemFields(parsed),
        category,
        ...(categoryExplicit ? { categoryExplicit: true } : {}),
        catShelfOrder: nextCatPos,
        flatShelfOrder: nextFlatPos,
        isCatalogItem: true,
        qty: null,
        active: true,
        importedAt: meta.importedAt ?? new Date().toISOString(),
        importedBy: meta.importedBy ?? '',
      },
    })
  }

  const notInFile = matchable
    .filter(d => !matchedIds.has(d.id) && !d.data?.removed)
    .map(d => ({ id: d.id, name: d.data?.name || d.id }))
  const toHide = opts.hideNotInFile ? notInFile.map(x => ({ ...x })) : []

  return { toAdd, toUpdate, toHide, notInFile, newCategories, duplicates, categoryHeader }
}

// ─────────────────────────────────────────────────────────────────────────────
// Pre-upload backup + the full-replace loss summary
// ─────────────────────────────────────────────────────────────────────────────

/** Sanitized timestamp for a backup's doc path — safe in a Firestore doc id. */
export function catalogBackupTimestamp(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-')
}

/**
 * What a FULL REPLACE would destroy, counted from the existing docs — the
 * numbers the replace confirm names explicitly instead of a generic warning.
 * withPar/withPosition/withSplit are independent (an item can count in more
 * than one), so they don't sum to total.
 */
export function catalogLossSummary(existingDocs) {
  const docs = (existingDocs || []).filter(d => d && !d.data?.removed)
  const withPar = docs.filter(d => d.data?.parLevel != null || d.data?.reorderPoint != null || d.data?.avgDailyUsage != null).length
  const withPosition = docs.filter(d => d.data?.catShelfOrder != null || d.data?.flatShelfOrder != null).length
  const withSplit = docs.filter(d => Array.isArray(d.data?.countCategories) && d.data.countCategories.length >= 2).length
  const withKey = docs.filter(d => d.data?.isKey === true).length
  const removedCount = (existingDocs || []).filter(d => d?.data?.removed).length
  return { total: docs.length, withPar, withPosition, withSplit, withKey, removedCount }
}

/** The full-replace confirm text, naming exact counts — never a generic warning. */
export function catalogLossWarningText(summary, locationLabel) {
  if (!summary.total && !summary.removedCount) {
    return `Replace the entire item catalog at ${locationLabel}? There's nothing there yet, so nothing will be lost.`
  }
  const lines = [`Replace the ENTIRE item catalog at ${locationLabel}?`, '', `This deletes all ${summary.total} current item${summary.total === 1 ? '' : 's'}, including:`]
  if (summary.withPosition) lines.push(`• ${summary.withPosition} item${summary.withPosition === 1 ? '' : 's'} with a saved shelf/print order`)
  if (summary.withPar) lines.push(`• ${summary.withPar} item${summary.withPar === 1 ? '' : 's'} with par/reorder levels set`)
  if (summary.withSplit) lines.push(`• ${summary.withSplit} item${summary.withSplit === 1 ? '' : 's'} counted on more than one category sheet`)
  if (summary.withKey) lines.push(`• ${summary.withKey} item${summary.withKey === 1 ? '' : 's'} marked as a quick-count key item`)
  if (summary.removedCount) lines.push(`• ${summary.removedCount} hidden item${summary.removedCount === 1 ? '' : 's'} and their removal history`)
  lines.push('', 'A backup of the current catalog is saved automatically, but there is no restore button yet —', 'recovering it means a manual Firestore read. Consider "Item list" (merge) instead unless you', 'specifically mean to start over.', '', 'Continue?')
  return lines.join('\n')
}
