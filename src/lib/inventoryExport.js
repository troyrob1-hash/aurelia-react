// Inventory Excel/CSV export — the per-item detail row. Pure (no React, no
// Firestore) so the money column is tested against the code that ships.
//
// Closing Value is item._value: the SAME itemValue that the screen's totals
// and the P&L closing use. It used to be qty × unitCost, which ignored loose
// eaches, priced packs at the per-EACH cost (unitCost is per each — itemValue
// derives packPrice as qtyPerPack × unitCost), and valued a zoned item at $0
// because a zoned item's top-level qty is null by construction. The export
// disagreed with the app it was exported from.
//
// Closing is the zone-aware pack count (qtyOf → _countQty); a legacy item
// reads item.qty exactly as before. One row per item.
//
// No Opening / Purchased / Usage / Usage Value columns: Opening and Purchased
// read item.openingQty / item.purchased, which nothing in the app ever sets, so
// they were always 0 — and Usage (opening + purchased − closing) was therefore
// always −Closing, Usage Value meaningless. Dropped rather than shipped empty.

import { qtyOf } from '@/lib/variance'
import { allocateItemValue, displayCents, countCategoryKeys, isSplitItem } from '@/lib/buckets'
import { byShelf, byShelfOn } from '@/lib/countSheets'
import { formatAlsoOn, EXPORT_MARKER } from '@/lib/catalogImport'

// `cents` — the item's slice of the cent ledger (displayCents). When given,
// Closing Value is exactly what the screen shows and the rows sum exactly to
// the export's total; without it, the item's own value rounded (legacy callers).
//
// The columns after Reorder make the file an uploadable item list (Edit sheet →
// Upload item list reads them back — see catalogImport's "Aurelia's own export"
// section): every definition field at full precision, the home sheet as
// Category, stored positions, the other sheets an item is counted on, and its
// doc id. `categories` (the location's sheets) resolves sheet labels; without
// it the placement columns are left blank.
export function inventoryExportRow(item, cents, categories = null) {
  const closing = qtyOf(item) || 0
  const unitCost = Number(item.unitCost) || 0
  const totalValue = cents != null ? cents / 100 : (item._value || 0)
  const parLevel = item.parLevel || item.minStock || ''
  const needsReorder = parLevel && closing <= parLevel ? 'Yes' : ''
  const cats = Array.isArray(categories) ? categories : []
  const labelOf = (k) => cats.find(c => c.key === k)?.label
  const home = item._cat
  const sheets = isSplitItem(item) ? countCategoryKeys(item) : []
  const also = sheets.filter(k => k !== home && labelOf(k))
    .map(k => ({ label: labelOf(k), pos: item.sheetShelfOrder?.[k] ?? null }))
  const blank = (v) => (v == null ? '' : v)
  return {
    'Item': item.name || '',
    'Category': labelOf(home) || item.category || '',
    'GL Code': item.glCodeFull || item.glCode || '',
    'SKU': item.sku || '',
    'Unit': item.unit || 'ea',
    'Closing': closing,
    'Unit Cost': unitCost,
    'Closing Value': totalValue.toFixed(2),
    'Par Level': parLevel,
    'Reorder': needsReorder,
    'Vendor': item.vendor || '',
    'Pack Size': item.packSize || '',
    'Items per Pack': blank(item.qtyPerPack),
    'Pack Price': blank(item.packPrice),
    'Selling Price': blank(item.sellingPrice),
    'COGS %': item.cogsRatio != null && item.cogsRatio !== '' ? Number((Number(item.cogsRatio) * 100).toPrecision(12)) : '',
    'Item Type': item.itemType || '',
    'Position': blank(item.catShelfOrder),
    'Flat Position': blank(item.flatShelfOrder),
    [EXPORT_MARKER]: formatAlsoOn({ only: sheets.length > 0 && !sheets.includes(home), sheets: also }),
    'Item ID': item.id ?? '',
  }
}

/**
 * Every item once, in sheet order: each item under its HOME sheet (the sheets
 * in the location's order), in that sheet's on-screen order; anything without
 * a home sheet last, in flat order. The full list — never the search-filtered
 * view — so a file uploaded back with Replace can't silently drop items.
 */
export function exportItemsInSheetOrder(items, categories) {
  const list = Array.isArray(items) ? items : []
  const out = []
  const placed = new Set()
  for (const c of Array.isArray(categories) ? categories : []) {
    for (const i of list.filter(x => x._cat === c.key).sort(byShelfOn(c.key))) {
      if (placed.has(i.id)) continue
      placed.add(i.id); out.push(i)
    }
  }
  out.push(...list.filter(i => !placed.has(i.id)).sort(byShelf('flatShelfOrder')))
  return out
}

/** The location's sheets for the export's "Sheets" tab / CSV "Sheet," lines (see catalogFile). */
export function sheetListRows(categories) {
  return (Array.isArray(categories) ? categories : []).filter(c => c?.key).map(c => ({
    'Sheet': c.label || c.key, 'Key': c.key, 'Color': c.color || '', 'Background': c.bg || '',
    'Keywords': (c.keywords || []).join('|'),
  }))
}

/** One CSV cell, quoted when it needs to be. */
export function csvCell(v) {
  const s = String(v ?? '')
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s
}


/**
 * One item per row, in first-seen order. The on-screen groups list a SPLIT
 * item once per category sheet it is on — exporting rows straight from them
 * would repeat it, and Total Closing Value would count it once per sheet.
 */
export function uniqueItems(groups) {
  const seen = new Set()
  const out = []
  for (const g of groups || []) {
    for (const i of g?.items || []) {
      const id = String(i?.id ?? '')
      if (seen.has(id)) continue
      seen.add(id)
      out.push(i)
    }
  }
  return out
}

/**
 * The "By Category" sheet: one row per item-CATEGORY carrying that category's
 * share of the item's closing value, a subtotal per category, and a TOTAL.
 *
 * Built on the SAME cent ledger as the screen (displayCents): the closing
 * value is rounded to whole cents once and distributed — to items, then to
 * each item's sheets — by largest remainder. So every share is a slice of one
 * integer total: the rows sum to the subtotals, the subtotals to TOTAL, and
 * TOTAL equals the detail sheet's Total Closing Value and the Closing Value
 * KPI, to the cent. A split item counts once, divided, never multiplied.
 *
 * @returns {{ rows: object[], totalCents: number, ledger }}
 */
export function byCategoryRows(items, categories) {
  const cats = (Array.isArray(categories) ? categories : []).filter(c => c?.key)
  const known = new Set(cats.map(c => c.key))
  const ledger = displayCents(items, cats)
  const UNCAT = '__none__'
  const lines = new Map([...cats.map(c => [c.key, []]), [UNCAT, []]])
  for (const item of items || []) {
    if (!item) continue
    const alloc = allocateItemValue(item, known)
    const sum = alloc.reduce((s, a) => s + a.value, 0)
    const seen = new Set()
    for (const a of alloc) {
      const key = a.catKey ?? UNCAT
      if (seen.has(key)) continue   // one row per item-category (stray value already pooled)
      seen.add(key)
      lines.get(key).push({
        item: item?.name || '',
        share: sum ? Math.round((a.value / sum) * 100) : 100,
        cents: ledger.share(item.id, a.catKey ?? null),
      })
    }
  }
  const money = c => (c / 100).toFixed(2)
  const rows = []
  for (const [key, list] of lines) {
    if (!list.length) continue
    const label = key === UNCAT ? 'Not in any category' : (cats.find(c => c.key === key)?.label || key)
    let sub = 0
    for (const l of list) {
      rows.push({ 'Category': label, 'Item': l.item, 'Share of Item': `${l.share}%`, 'Closing Value': money(l.cents) })
      sub += l.cents
    }
    rows.push({ 'Category': `${label} — subtotal`, 'Item': '', 'Share of Item': '', 'Closing Value': money(sub) })
  }
  rows.push({ 'Category': 'TOTAL', 'Item': '', 'Share of Item': '', 'Closing Value': money(ledger.closingCents) })
  return { rows, totalCents: ledger.closingCents, ledger }
}

/**
 * The export's CSV text: report lines, the location's sheets ("Sheet," lines,
 * read back by Upload item list), the detail header + rows, and a totals row
 * placed by header NAME (the old fixed positions had drifted a column).
 */
export function buildExportCsv({ locationLabel, periodKey, exportedAt, totals, rows, categories }) {
  const headers = Object.keys(rows[0] || {})
  const lines = [
    ['Inventory Count Report'],
    ['Location: ' + locationLabel],
    ['Period: ' + periodKey],
    ['Exported: ' + exportedAt],
    [''],
    ['Summary'],
    ['Total Items', totals.totalItems],
    ['Items Counted', totals.itemsCounted],
    ['Total Closing Value', '$' + totals.totalClosingValue.toFixed(2)],
    ['Items Needing Reorder', totals.needsReorder],
    [''],
    ...sheetListRows(categories).map(r => ['Sheet', r['Sheet'], r['Key'], r['Color'], r['Background'], r['Keywords']]),
    [''],
    headers,
    ...rows.map(r => headers.map(h => r[h])),
    [''],
    headers.map((h, k) => h === 'Closing Value' ? totals.totalClosingValue.toFixed(2)
      : headers[k + 1] === 'Closing Value' ? 'Total:' : ''),
  ]
  return lines.map(r => r.map(csvCell).join(',')).join('\n')
}

/** The export's workbook: Summary, Inventory Count (detail), Sheets, By Category. */
export function buildExportWorkbook(XLSX, { locationLabel, periodKey, exportedAt, totals, rows, categories, catRows }) {
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
    ['Inventory Count Report'],
    [''],
    ['Location', locationLabel],
    ['Period', periodKey],
    ['Exported', exportedAt],
    [''],
    ['Summary'],
    ['Total Items', totals.totalItems],
    ['Items Counted', totals.itemsCounted],
    ['Total Closing Value', totals.totalClosingValue],
    ['Items Needing Reorder', totals.needsReorder],
  ]), 'Summary')
  const detail = XLSX.utils.json_to_sheet(rows)
  detail['!cols'] = [
    // Item, Category, GL Code, SKU, Unit, Closing, Unit Cost, Closing Value, Par Level, Reorder
    { wch: 30 }, { wch: 15 }, { wch: 12 }, { wch: 8 }, { wch: 8 },
    { wch: 10 }, { wch: 10 }, { wch: 14 }, { wch: 10 }, { wch: 8 },
    // Vendor, Pack Size, Items per Pack, Pack Price, Selling Price, COGS %,
    // Item Type, Position, Flat Position, Also counted on, Item ID
    { wch: 16 }, { wch: 10 }, { wch: 8 }, { wch: 10 }, { wch: 10 }, { wch: 8 },
    { wch: 12 }, { wch: 8 }, { wch: 8 }, { wch: 30 }, { wch: 24 },
  ]
  XLSX.utils.book_append_sheet(wb, detail, 'Inventory Count')
  // The location's sheets, in order — Upload item list rebuilds them from this.
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(sheetListRows(categories)), 'Sheets')
  if (catRows) {
    const catSheet = XLSX.utils.json_to_sheet(catRows)
    catSheet['!cols'] = [{ wch: 26 }, { wch: 30 }, { wch: 12 }, { wch: 14 }]
    XLSX.utils.book_append_sheet(wb, catSheet, 'By Category')
  }
  return wb
}

