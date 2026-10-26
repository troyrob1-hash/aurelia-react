// Printable COUNT SHEETS — pure functions only (no React, no Firestore).
//
// A count sheet is a paper list of one category's items, handed to a crew
// member to fill in by hand ("here's the Coffee Bar sheet"). Read-only: nothing
// here touches counts, values, or the P&L.
//
// Three guarantees, each pinned by tests/countSheets.test.js:
//
//  1. SAME ORDER AS THE SCREEN. The shelf comparators live HERE and Inventory.jsx
//     imports them for displayGroups, so a sheet and the grouped screen are
//     sorted by the same function — not by two copies that could drift. A
//     counter walking the shelf with the sheet sees items in the order they
//     were arranged on screen.
//
//  2. NO NUMBERS THAT BIAS A COUNT. A row carries the item's name and pack
//     description only — never a price, a prior count, or an expected count.
//     A blind count is the point of handing someone a sheet.
//
//  3. NOTHING SILENTLY DROPPED. An item whose category isn't in the location's
//     category list never appears on the grouped screen; on paper that would
//     mean it is never counted. "All sheets" adds a final "Not in any category"
//     sheet for those items instead of losing them.
//
// MULTI-CATEGORY, LATER: sheetCategoryKeys() is the single membership rule.
// Today every item is on exactly one sheet (its home category, item._cat).
// When items gain `countCategories` (a list of category keys — see the
// multi-category plan), they appear on each of those sheets with no change
// here, and the home category is always included.

export const UNCATEGORIZED_SHEET_KEY = '__uncategorized__'
export const UNCATEGORIZED_SHEET_LABEL = 'Not in any category'

// Rows per printed page. Sized for US Letter at 0.5in margins with a header
// block and handwriting-height rows; names are single-line (ellipsized) in the
// print CSS, so a row can't grow and push a page past one sheet of paper.
export const ROWS_PER_PAGE = 22

/** Case-insensitive A-Z by name — the screen's base ordering. */
export const byName = (a, b) =>
  (a.name || '').localeCompare(b.name || '', undefined, { sensitivity: 'base' })

/**
 * Shelf order: arranged items first by ascending position in `field`, then
 * un-arranged (null position) items A-Z — so an item nobody has placed yet is
 * never dropped, it just falls to the bottom.
 */
export const byShelf = (field) => (a, b) => {
  const av = a[field] ?? Infinity
  const bv = b[field] ?? Infinity
  if (av !== bv) return av - bv
  return byName(a, b)
}

/**
 * Which category sheets an item belongs on (category KEYS, de-duplicated,
 * home category first). Today: just item._cat. Later: plus item.countCategories.
 */
export function sheetCategoryKeys(item) {
  const keys = [item?._cat, ...(Array.isArray(item?.countCategories) ? item.countCategories : [])]
  return [...new Set(keys.filter(k => typeof k === 'string' && k !== ''))]
}

/**
 * The pack/unit description a counter needs to know WHAT to count, e.g.
 * "case · 24 per pack". Never a price.
 */
export function packLabel(item) {
  const size = String(item?.packSize ?? '').trim()
  const qpp = Number(item?.qtyPerPack)
  const parts = []
  if (size) parts.push(size)
  if (Number.isFinite(qpp) && qpp > 1) parts.push(`${qpp} per pack`)
  if (parts.length) return parts.join(' · ')
  return String(item?.unit ?? '').trim() || 'each'
}

/**
 * The printed columns, in order. `field` columns print row data; `box` columns
 * print an empty write-in box. Two count boxes because that is how the app takes
 * a count — full packs (cases) plus loose singles — so a sheet transcribes
 * straight into the Packs and Eaches inputs without anyone converting.
 */
export const SHEET_COLUMNS = [
  { key: 'item',   label: 'Item',        field: 'name' },
  { key: 'pack',   label: 'Pack / unit', field: 'pack' },
  { key: 'packs',  label: 'Packs',       box: true },
  { key: 'eaches', label: 'Eaches',      box: true },
  { key: 'notes',  label: 'Notes' },
]

/** One printed row. Deliberately only these fields — see guarantee 2. */
function toRow(item) {
  return { id: String(item?.id ?? ''), name: String(item?.name ?? ''), pack: packLabel(item) }
}

/**
 * Build the sheets.
 *
 * @param {Array}  items       itemsWithMeta (carries _cat; may carry countCategories)
 * @param {Array}  categories  the location's categories, in display order
 * @param {object} [opts]
 * @param {string} [opts.only] a category key → just that sheet (returned even if
 *                             empty, so the caller can say "no items"). Omitted →
 *                             every category that has items, in category order,
 *                             then the "Not in any category" sheet if needed.
 * @returns {Array<{key, label, rows}>}
 */
export function buildCountSheets(items, categories, opts = {}) {
  const list = Array.isArray(items) ? items.filter(Boolean) : []
  const cats = Array.isArray(categories) ? categories.filter(c => c && c.key) : []
  const sortRows = arr => [...arr].sort(byShelf('catShelfOrder')).map(toRow)
  const sheetFor = cat => ({
    key: cat.key,
    label: cat.label || cat.key,
    rows: sortRows(list.filter(i => sheetCategoryKeys(i).includes(cat.key))),
  })

  if (opts.only) {
    if (opts.only === UNCATEGORIZED_SHEET_KEY) return [uncategorizedSheet(list, cats, sortRows)]
    const cat = cats.find(c => c.key === opts.only)
    return cat ? [sheetFor(cat)] : []
  }

  const sheets = cats.map(sheetFor).filter(s => s.rows.length > 0)
  const orphans = uncategorizedSheet(list, cats, sortRows)
  if (orphans.rows.length) sheets.push(orphans)
  return sheets
}

function uncategorizedSheet(list, cats, sortRows) {
  const known = new Set(cats.map(c => c.key))
  return {
    key: UNCATEGORIZED_SHEET_KEY,
    label: UNCATEGORIZED_SHEET_LABEL,
    rows: sortRows(list.filter(i => !sheetCategoryKeys(i).some(k => known.has(k)))),
  }
}

/**
 * Split sheets into printed pages. Every sheet starts on a new page and every
 * page knows its sheet and "page N of M", so a dropped or shuffled page can be
 * put back. An empty sheet still yields one page (an explicit blank, not
 * nothing).
 *
 * @returns {Array<{sheetKey, label, pageNo, pageCount, rows}>}
 */
export function paginateSheets(sheets, rowsPerPage = ROWS_PER_PAGE) {
  const per = Math.max(1, Math.floor(Number(rowsPerPage) || ROWS_PER_PAGE))
  const pages = []
  for (const s of sheets || []) {
    const rows = s.rows || []
    const pageCount = Math.max(1, Math.ceil(rows.length / per))
    for (let p = 0; p < pageCount; p++) {
      pages.push({
        sheetKey: s.key,
        label: s.label,
        pageNo: p + 1,
        pageCount,
        rows: rows.slice(p * per, (p + 1) * per),
      })
    }
  }
  return pages
}
