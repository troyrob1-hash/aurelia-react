// The Inventory "Sheet" button: one picker that replaces the category chip bar
// AND the Quick / Section / Zone / Full count-mode selector.
//
// It folds cleanly because count mode was only ever a display filter over
// (countMode, activeCat, activeZone) — see displayItems in Inventory.jsx.
// markSectionComplete / sectionsCompleted do NOT read countMode: "Mark sheet
// done" sits on each category header in every mode. So:
//   All items  → countMode 'full',    activeCat 'all'
//   Key items  → countMode 'quick',   activeCat 'all'
//   a category → countMode 'section', activeCat <key>
//   a zone     → countMode 'zone',    activeCat 'all', activeZone <key>
// (The old UI could also combine a mode with a chip — e.g. Full + a category,
// which filters exactly like Section + that category. The picker offers one
// canonical state per choice; every list the old UI could show is still one
// click away.)

export const SHEET_ALL = 'all'
export const SHEET_KEY = 'key'

/** Picker value → the filter state Inventory already understands. */
export function sheetState(value) {
  if (value === SHEET_KEY) return { countMode: 'quick', activeCat: 'all', activeZone: 'all' }
  if (typeof value === 'string' && value.startsWith('cat:')) return { countMode: 'section', activeCat: value.slice(4), activeZone: 'all' }
  if (typeof value === 'string' && value.startsWith('zone:')) return { countMode: 'zone', activeCat: 'all', activeZone: value.slice(5) }
  return { countMode: 'full', activeCat: 'all', activeZone: 'all' }
}

/** Filter state → the picker value it shows. Inverse of sheetState. */
export function sheetValue({ countMode, activeCat, activeZone }) {
  if (countMode === 'zone' && activeZone && activeZone !== 'all') return 'zone:' + activeZone
  if (countMode === 'quick') return SHEET_KEY
  if (activeCat && activeCat !== 'all') return 'cat:' + activeCat
  return SHEET_ALL
}

/**
 * The picker's options, in display order. Each: { value, label, counted, total,
 * complete, group: 'sheets' | 'zones' }. Zones appear only when the location
 * has 2+ (zonesOn) — a single-zone location looks exactly as it did before.
 * A zone's "complete" is "swept"; it carries no counted/total (an item can sit
 * in any zone, so a per-zone fraction isn't defined).
 */
export function sheetOptions({ items = [], categories = [], catStats = {}, totals = {}, zones = [], zonesOn = false, zonesCompleted = [], hasCount }) {
  const keyItems = items.filter(i => i.isKey)
  const keyCounted = keyItems.filter(hasCount).length
  const done = (c, t) => t > 0 && c === t
  const out = [
    { value: SHEET_ALL, label: 'All items', counted: totals.counted || 0, total: totals.total || 0, group: 'sheets' },
    { value: SHEET_KEY, label: 'Key items', counted: keyCounted, total: keyItems.length, group: 'sheets' },
    ...categories.map(c => {
      const s = catStats[c.key] || { counted: 0, total: 0 }
      return { value: 'cat:' + c.key, label: c.label, color: c.color, counted: s.counted || 0, total: s.total || 0, group: 'sheets' }
    }),
  ].map(o => ({ ...o, complete: done(o.counted, o.total) }))
  if (zonesOn) {
    for (const z of zones) {
      out.push({ value: 'zone:' + z.key, label: z.label, complete: zonesCompleted.includes(z.key), group: 'zones' })
    }
  }
  return out
}

/** Button text: "Beverages · 31 of 142", or "Walk-in · swept" for a zone. */
export function sheetButtonLabel(option) {
  if (!option) return 'All items'
  if (option.group === 'zones') return `${option.label} · ${option.complete ? 'swept' : 'not swept'}`
  return `${option.label} · ${option.counted} of ${option.total}`
}
