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
import { allocateItemValue, displayCents } from '@/lib/buckets'

// `cents` — the item's slice of the cent ledger (displayCents). When given,
// Closing Value is exactly what the screen shows and the rows sum exactly to
// the export's total; without it, the item's own value rounded (legacy callers).
export function inventoryExportRow(item, cents) {
  const closing = qtyOf(item) || 0
  const unitCost = item.unitCost || 0
  const totalValue = cents != null ? cents / 100 : (item._value || 0)
  const parLevel = item.parLevel || item.minStock || ''
  const needsReorder = parLevel && closing <= parLevel ? 'Yes' : ''
  return {
    'Item': item.name || '',
    'Category': item.category || item.vendor || '',
    'GL Code': item.glCode || '',
    'SKU': item.sku || '',
    'Unit': item.unit || 'ea',
    'Closing': closing,
    'Unit Cost': unitCost.toFixed(2),
    'Closing Value': totalValue.toFixed(2),
    'Par Level': parLevel,
    'Reorder': needsReorder,
  }
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
