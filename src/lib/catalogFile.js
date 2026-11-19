// Reading an uploaded item-list workbook: which sheet, which header row, and
// (for Aurelia's own export) the sheet list it carries. Pure — takes a parsed
// SheetJS workbook — so both upload paths and the round-trip test read a file
// exactly the same way. The two fail-loud checks (wrong sheet / counts column)
// are reported here; the caller turns them into a toast / confirm.

import * as XLSX from 'xlsx'

// Priority order for Fooda inventory templates. Managers upload the WHOLE
// multi-sheet OneDrive workbook; the item data lives on "INVItems", which may
// not be first. Names are normalized (lowercase, no spaces/underscores).
// "Inventory Count" is Aurelia's own export's detail tab (its first tab is
// "Summary", which has no items).
const SHEET_PRIORITY = ['INVItems', 'INV Items', 'INV_Items', 'InvItems', 'Items', 'Inventory Count', 'Inv_By_Item', 'Inventory_UPC', 'Items_UPC']
const normSheet = (s) => String(s).toLowerCase().replace(/[\s_]+/g, '')

// The export's category list: an xlsx "Sheets" tab, or CSV lines starting
// "Sheet," above the header row. Columns: Sheet (label), Key, Color,
// Background, Keywords ("|"-separated).
const SHEETS_TAB = 'Sheets'
export const SHEET_LIST_COLUMNS = ['Sheet', 'Key', 'Color', 'Background', 'Keywords']

const NAME_ALIASES = ['description', 'item name', 'item', 'name', 'product']
const COUNT_COL_RE = /^(qty|quantity|count|counted|on[\s-]?hand|onhand|cases|units)$/i

function toCategory([label, key, color, bg, keywords]) {
  const l = String(label ?? '').trim()
  if (!l) return null
  return {
    key: String(key ?? '').trim() || l.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''),
    label: l,
    ...(color ? { color: String(color) } : {}),
    ...(bg ? { bg: String(bg) } : {}),
    keywords: String(keywords ?? '').split('|').map(s => s.trim()).filter(Boolean),
  }
}

/**
 * @param workbook  XLSX.read(...) result
 * @returns {{ bestSheet, rows, headers, sheetList: object[]|null, countCol: string|null, error: string|null }}
 */
export function readCatalogWorkbook(workbook) {
  let bestSheet = null
  for (const target of SHEET_PRIORITY) {
    const hit = workbook.SheetNames.find(s => normSheet(s) === normSheet(target))
    if (hit) { bestSheet = hit; break }
  }
  if (!bestSheet) bestSheet = workbook.SheetNames.find(s => s.toLowerCase().includes('item')) || workbook.SheetNames[0]
  const ws = workbook.Sheets[bestSheet]
  const allRows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' })

  // Header row: a row with a name column AND a vendor/cost/price/GL column.
  // Scanned deep enough for the export's CSV, whose report lines and one
  // "Sheet," line per category sit above its header row.
  let headerRowIdx = 0
  let found = false
  for (let i = 0; i < Math.min(allRows.length, 200); i++) {
    const vals = allRows[i].map(v => String(v || '').toLowerCase().trim())
    if (vals.some(v => v === 'description' || v === 'item name' || v === 'item') &&
        vals.some(v => v.includes('vendor') || v.includes('cost') || v.includes('price') || v.includes('gl'))) {
      headerRowIdx = i; found = true
      break
    }
  }
  // Else: the first row with a dollar value — the header is one row before it.
  if (!found) {
    for (let i = 0; i < Math.min(allRows.length, 30); i++) {
      if (allRows[i].some(v => String(v || '').includes('$'))) { headerRowIdx = Math.max(0, i - 1); break }
    }
  }

  // The export's sheet list (null for every other file).
  let sheetList = null
  const tab = workbook.SheetNames.find(s => normSheet(s) === normSheet(SHEETS_TAB))
  if (tab && tab !== bestSheet) {
    const t = XLSX.utils.sheet_to_json(workbook.Sheets[tab], { header: 1, defval: '' })
    const body = String(t[0]?.[0] || '').trim().toLowerCase() === 'sheet' ? t.slice(1) : t
    sheetList = body.map(toCategory).filter(Boolean)
  } else {
    const above = allRows.slice(0, headerRowIdx).filter(r => String(r[0] || '').trim() === 'Sheet')
    if (above.length) sheetList = above.map(r => toCategory(r.slice(1))).filter(Boolean)
  }
  if (sheetList && !sheetList.length) sheetList = null

  const rows = XLSX.utils.sheet_to_json(ws, { range: headerRowIdx, defval: '' })
  const headers = rows.length ? Object.keys(rows[0]) : []
  let error = null
  if (!rows.length) error = 'No data found in file'
  else if (!headers.some(h => NAME_ALIASES.some(a => String(h).toLowerCase().trim() === a || String(h).toLowerCase().includes(a)))) {
    error = `Couldn't find item data on sheet "${bestSheet}". Sheets in this file: ${workbook.SheetNames.join(', ')}. ` +
      'Aurelia looks for a sheet named INVItems (or Items). Expected columns: name/description, pack size, pack price, vendor, GL code.'
  }
  const countCol = headers.find(h => COUNT_COL_RE.test(String(h).trim())) || null
  return { bestSheet, rows, headers, sheetList, countCol, error }
}
