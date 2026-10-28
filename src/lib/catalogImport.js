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
    const name = col(row, ['Description', 'Item', 'Item Name', 'Name', 'Product'])
    if (!name || String(name).trim() === '') continue
    const nameStr = String(name).trim()
    if (isSkippableName(nameStr)) continue

    // Skip rows with no cost data — section headers like "Beverages", "Barista" etc.
    const rowPackPrice = parsePrice(col(row, ['Pack Price', 'Pack Cost', 'Case Price', 'Case Cost', 'Price']))
    const rowUnitCost = parsePrice(col(row, ['Cost Per Unit', 'Unit Cost', 'Cost', 'Each Cost']))
    if (rowPackPrice === 0 && rowUnitCost === 0) continue

    const itemId = catalogItemId(name)
    if (!itemId) continue
    if (seen.has(itemId)) { duplicates.push({ id: itemId, name: nameStr }); continue }   // first row wins
    seen.add(itemId)

    const sku = col(row, ['SKU', 'UPC', 'Barcode'])
    const packSize = col(row, ['Pack Size', 'Case Size', 'Unit Size']) || 'case'
    const packPrice = parsePrice(col(row, ['Pack Price', 'Pack Cost', 'Case Price', 'Case Cost']))
    const unitCost = parsePrice(col(row, ['Cost Per Unit', 'Unit Cost', 'Cost', 'Each Cost']))
    const rawQtyPerPack = parseInt(col(row, ['Qty Per Pack', 'Qty/Pack', 'Case Qty', 'Pack Qty', 'Qty']))
    const qtyPerPack = rawQtyPerPack > 0 ? rawQtyPerPack : (packPrice > 0 && unitCost > 0 ? Math.round(packPrice / unitCost) : 1)
    const vendor = col(row, ['Vendor', 'Supplier', 'Distributor', 'Purveyor']) || ''
    const rawGl = col(row, ['GL Code', 'GL', 'Account', 'GL Account']) || ''
    const glCode = parseGlCode(rawGl)
    const sellingPrice = parsePrice(col(row, ['Selling Price', 'Retail Price', 'Price', 'Sell Price']))
    const cogsRatio = col(row, ['COGS', 'COGS %', 'Food Cost'])
    const itemType = col(row, ['Item Type', 'Type', 'Category', 'Dept']) || ''

    // Category: the file's own value when the row has one; inference otherwise.
    let category, categoryExplicit = false
    const fileCat = categoryHeader ? resolveFileCategory(row[categoryHeader], known) : null
    if (fileCat) {
      category = fileCat.label
      categoryExplicit = true   // a human named it — assignCategory honors it verbatim
      if (fileCat.isNew) {
        const { color, bg } = PALETTE[(known.length) % PALETTE.length]
        const created = { key: uniqueKey(slugify(fileCat.label), known.map(c => c.key)), label: fileCat.label, color, bg, keywords: [] }
        known.push(created)
        newCategories.push(created)
      }
    } else {
      category = inferImportCategory(rawGl, itemType, name)
    }

    const position = items.length + 1   // among WRITTEN rows → no gaps
    items.push({
      id: itemId,
      data: {
        name: nameStr,
        sku: sku ? String(sku).trim() : '',
        packSize: String(packSize).trim(),
        qtyPerPack,
        packPrice,
        unitCost,
        vendor: String(vendor).trim(),
        glCode,
        glCodeFull: String(rawGl).trim(),
        sellingPrice,
        cogsRatio: parsePrice(String(cogsRatio).replace('%', '')) / 100 || 0,
        itemType: String(itemType).trim(),
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
