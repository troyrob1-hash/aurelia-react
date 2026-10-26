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
