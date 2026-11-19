// Shared fixture for the export → item-list round-trip tests: a site whose
// sheets and items exercise the hard cases (renamed built-in sheets, a label
// with a comma, a label that is a built-in alias, an empty sheet, two-sheet
// items with and without per-sheet positions, one not on its own home sheet,
// a home by alias, duplicate names, zero cost, a custom item, a hidden item,
// an SKU with a leading zero, 4-decimal and percentage values).
export const CATS = [
  { key: 'beverages', label: 'Coffee Bar', color: '#1e40af', bg: '#dbeafe', keywords: [] },
  { key: 'dairy', label: 'Coke Cooler 1', color: '#0369a1', bg: '#e0f2fe', keywords: ['coke'] },
  { key: 'coke_closet', label: 'Coke Closet', color: '#374151', bg: '#f3f4f6', keywords: [] },
  { key: 'chips_cubby', label: 'Chips, Cubby', color: '#92400e', bg: '#fef3c7', keywords: ['chip', 'lays'] },
  { key: 'empty_sheet', label: 'Empty Sheet', color: '#64748b', bg: '#f1f5f9', keywords: [] },
  // Its label is a built-in alias (snacks → pantry): only an EXPLICIT category keeps an item here.
  { key: 'snack_shelf', label: 'Snacks', color: '#15803d', bg: '#dcfce7', keywords: [] },
]
export const base = { isCatalogItem: true, active: true, qty: null, packSize: 'case', qtyPerPack: 24, packPrice: 24, unitCost: 1, vendor: 'Coca-Cola', glCode: '12000', glCodeFull: '12000 - Inventory - Cafeteria', sellingPrice: 0, cogsRatio: 0, itemType: '', sku: '' }
export const DOCS = [
  // Two sheets, with a position on the second; key item, par level.
  { id: '500ml_mexican_coke', data: { ...base, name: '500mL Mexican Coke', category: 'Coke Cooler 1', categoryExplicit: true, countCategories: ['dairy', 'coke_closet'], sheetShelfOrder: { coke_closet: 13 }, catShelfOrder: 4, flatShelfOrder: 38, packSize: 'EACH', packPrice: 33.17, unitCost: 1.3821, sku: '0126689', sellingPrice: 33.17, cogsRatio: 0.3, isKey: true, parLevel: 6 } },
  // Home by alias ("Beverages" → the beverages key, labelled Coffee Bar); no positions (A–Z).
  { id: 'sprite_20oz', data: { ...base, name: 'Sprite 20oz', category: 'Beverages' } },
  { id: 'apple_juice', data: { ...base, name: 'Apple Juice', category: 'Coffee Bar', categoryExplicit: true, catShelfOrder: 1, flatShelfOrder: 2 } },
  // Counted on two sheets but NOT on its own home sheet.
  { id: 'coke_zero', data: { ...base, name: 'Coke Zero', category: 'Coke Cooler 1', categoryExplicit: true, countCategories: ['coke_closet', 'chips_cubby'], sheetShelfOrder: { coke_closet: 2 }, catShelfOrder: 1, flatShelfOrder: 5 } },
  { id: 'coke_classic', data: { ...base, name: 'Coke Classic', category: 'Coke Cooler 1', categoryExplicit: true, catShelfOrder: 2, flatShelfOrder: 4 } },
  // Same name, two items; a label with a comma; a zero-cost item.
  { id: 'lays_classic', data: { ...base, name: 'Lays Classic', category: 'Chips, Cubby', categoryExplicit: true, catShelfOrder: 2, flatShelfOrder: 3, vendor: 'Frito-Lay', glCode: '12000' } },
  { id: 'lays_classic_2', data: { ...base, name: 'Lays Classic', category: 'Chips, Cubby', categoryExplicit: true, catShelfOrder: 1, flatShelfOrder: 1, vendor: 'Frito-Lay, Inc.', itemType: 'Snack' } },
  { id: 'napkins', data: { ...base, name: 'Napkins', category: 'Chips, Cubby', categoryExplicit: true, packPrice: 0, unitCost: 0, catShelfOrder: 3 } },
  // A custom item on two sheets (no position on the second → falls back to its own).
  { id: 'custom_1791376417432_h9shw', data: { name: 'Stir Sticks', custom: true, category: 'Coffee Bar', countCategories: ['beverages', 'coke_closet'], catShelfOrder: 7, flatShelfOrder: 9, packSize: 'CS', qtyPerPack: 5000, packPrice: 41.51, unitCost: 0, vendor: 'Sysco', glCode: '50431' } },
  { id: 'trail_mix', data: { ...base, name: 'Trail Mix', category: 'Snacks', categoryExplicit: true, catShelfOrder: 1, flatShelfOrder: 6 } },
  // Hidden: not on any sheet, not exported.
  { id: 'old_hidden', data: { ...base, name: 'Old Hidden', category: 'Coffee Bar', removed: true } },
]

