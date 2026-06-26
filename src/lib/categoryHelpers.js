// Pure, UI-facing helpers for the inventory category editors. Shared by the
// admin Settings tab and the inline per-location editor so the two never drift.
// No React, no Firestore — just constants + string helpers.

// Fixed palette of {color, bg} pairs — avoids per-color bg math and matches the
// default categories' aesthetic. "Add" auto-picks the next entry; edit lets the
// user choose any.
export const PALETTE = [
  { color: '#1e40af', bg: '#dbeafe' },
  { color: '#7c3aed', bg: '#ede9fe' },
  { color: '#92400e', bg: '#fef3c7' },
  { color: '#0369a1', bg: '#e0f2fe' },
  { color: '#b91c1c', bg: '#fee2e2' },
  { color: '#15803d', bg: '#dcfce7' },
  { color: '#be185d', bg: '#fce7f3' },
  { color: '#0f766e', bg: '#ccfbf1' },
  { color: '#64748b', bg: '#f1f5f9' },
  { color: '#374151', bg: '#f3f4f6' },
]

// Lowercased labels/keys the hardcoded assignCategory keyMap intercepts BEFORE
// the settings match — naming a category one of these can route its items to a
// built-in category instead. Callers WARN (not block) on collision.
export const KEYMAP_KEYS = ['barista', 'snacks', 'beverages', 'condiments', 'cafeteria', 'dairy', 'frozen', 'proteins', 'produce']

export function slugify(label) {
  return (label || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'category'
}

export function uniqueKey(base, existingKeys) {
  const taken = new Set(existingKeys)
  if (!taken.has(base)) return base
  let n = 2
  while (taken.has(`${base}_${n}`)) n++
  return `${base}_${n}`
}

export function collidesWithKeyMap(str) {
  return KEYMAP_KEYS.includes((str || '').toLowerCase())
}
