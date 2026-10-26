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

/**
 * The category-DELETE confirmation, as plain parts (the modal bolds numbers).
 * Two independent effects, both named when present:
 *   - homeCount: items whose home category this is → they move to General.
 *   - sheet: split items also counted on this sheet → their counts on it
 *     MERGE into each item's home sheet (nothing is lost).
 * Only when neither applies is it "just removed". The old text said "No items
 * carry this label" even while an item held a count on the sheet.
 *
 * @returns {string[]} sentences, in order
 */
export function categoryDeleteMessage({ homeCount = 0, sheet = { onSheet: 0, withCounts: 0 }, locationId = '' }) {
  const s = n => (n === 1 ? '' : 's')
  const out = []
  if (homeCount > 0) out.push(`${homeCount} item${s(homeCount)} move to General at ${locationId}.`)
  if (sheet.onSheet > 0) {
    out.push(sheet.withCounts > 0
      ? `${sheet.onSheet} item${s(sheet.onSheet)} ${sheet.onSheet === 1 ? 'is' : 'are'} also counted on this sheet — ${sheet.withCounts} with a count here, which will merge into ${sheet.withCounts === 1 ? 'its' : 'their'} home sheet. Nothing is lost.`
      : `${sheet.onSheet} item${s(sheet.onSheet)} ${sheet.onSheet === 1 ? 'is' : 'are'} also counted on this sheet (no counts on it yet) — ${sheet.onSheet === 1 ? 'it' : 'they'} will stay on ${sheet.onSheet === 1 ? 'its' : 'their'} other sheets.`)
  }
  if (!out.length) out.push('No items use this category here — it will just be removed.')
  else if (homeCount > 0) out.push('This can’t be undone in bulk.')
  return out
}
