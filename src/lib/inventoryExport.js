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
// KNOWN, NOT FIXED HERE: Opening (item.openingQty) and Purchased
// (item.purchased) are never populated anywhere in the app, so Usage is always
// −Closing and Usage Value is meaningless. Left as-is pending a decision on
// whether to source or drop those columns.

import { qtyOf } from '@/lib/variance'

export function inventoryExportRow(item) {
  const opening = item.openingQty || 0
  const closing = qtyOf(item) || 0
  const purchased = item.purchased || 0
  const usage = opening + purchased - closing
  const unitCost = item.unitCost || 0
  const totalValue = item._value || 0
  const usageValue = usage * unitCost
  const parLevel = item.parLevel || item.minStock || ''
  const needsReorder = parLevel && closing <= parLevel ? 'Yes' : ''
  return {
    'Item': item.name || '',
    'Category': item.category || item.vendor || '',
    'GL Code': item.glCode || '',
    'SKU': item.sku || '',
    'Unit': item.unit || 'ea',
    'Opening': opening,
    'Purchased': purchased,
    'Closing': closing,
    'Usage': usage,
    'Unit Cost': unitCost.toFixed(2),
    'Closing Value': totalValue.toFixed(2),
    'Usage Value': usageValue.toFixed(2),
    'Par Level': parLevel,
    'Reorder': needsReorder,
  }
}
