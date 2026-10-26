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
import { allocateItemValue } from '@/lib/buckets'

export function inventoryExportRow(item) {
  const closing = qtyOf(item) || 0
  const unitCost = item.unitCost || 0
  const totalValue = item._value || 0
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
 * The "By Category" sheet: one row per item-CATEGORY, carrying that
 * category's share of the item's closing value (allocateItemValue — the same
 * rule as the on-screen totals), then a subtotal per category and a grand
 * total.
 *
 * EXACT TO THE CENT: each item's value is rounded to cents ONCE (as on the
 * detail sheet) and its cents are distributed across its categories by
 * largest remainder, so the item's 2-dp shares sum to its 2-dp value exactly.
 * The grand total therefore equals the detail sheet's Total Closing Value —
 * a split item contributes its value once, divided, never multiplied.
 *
 * @returns {{ rows: object[], totalCents: number }}
 */
export function byCategoryRows(items, categories) {
  const cats = (Array.isArray(categories) ? categories : []).filter(c => c?.key)
  const known = new Set(cats.map(c => c.key))
  const UNCAT = '__none__'
  const lines = new Map([...cats.map(c => [c.key, []]), [UNCAT, []]])
  let totalCents = 0
  for (const item of items || []) {
    const cents = Math.round((Number(item?._value) || 0) * 100)
    totalCents += cents
    const alloc = allocateItemValue(item, known)
    const sum = alloc.reduce((s, a) => s + a.value, 0)
    // Largest-remainder split of the item's cents across its allocations.
    const raw = alloc.map(a => (sum ? (a.value / sum) * cents : (alloc.length === 1 ? cents : 0)))
    const floors = raw.map(Math.floor)
    let left = cents - floors.reduce((s, x) => s + x, 0)
    raw.map((r, k) => [r - floors[k], k]).sort((a, b) => b[0] - a[0])
      .forEach(([, k]) => { if (left > 0) { floors[k] += 1; left -= 1 } })
    alloc.forEach((a, k) => {
      lines.get(a.catKey ?? UNCAT).push({
        item: item?.name || '',
        share: sum ? Math.round((a.value / sum) * 100) : 100,
        cents: floors[k],
      })
    })
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
  rows.push({ 'Category': 'TOTAL', 'Item': '', 'Share of Item': '', 'Closing Value': money(totalCents) })
  return { rows, totalCents }
}
