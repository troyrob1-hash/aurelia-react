/**
 * Shelf position for an item placed BY HAND — the hand-add (custom item) path
 * and the edit-panel category pick. Before this, only the Item list upload and
 * Arrange mode ever wrote catShelfOrder/flatShelfOrder; a hand-placed item got
 * none, and byShelf sorts position-less items to the bottom A-Z — so a
 * category built by hand (HDK's "BiBs", Oct 2026) always read alphabetically
 * no matter the order items were added in.
 *
 * Rule: the placed item goes to the END of its sheet, in the order placed.
 *
 * The non-obvious part: byShelf puts ANY positioned item above EVERY
 * unpositioned one. So on a sheet that still has unpositioned items, giving
 * only the new item a number would put it FIRST, not last. planShelfAppend
 * therefore numbers the sheet's unpositioned items first — continuing after
 * the current max, in the exact order the sheet already displays them
 * (positioned by number, then the rest A-Z) — and only then appends. The
 * on-screen order of every existing item is unchanged; it's just made
 * explicit. Already-positioned items are NEVER written, so a deliberate
 * Arrange-mode order is never disturbed. (Arrange mode does the same
 * numbering on its first drop.)
 *
 * Split items (counted on 2+ sheets) are numbered like any other, but ON THIS
 * SHEET only: their write is sheetShelfOrder[sheet], never the shared
 * catShelfOrder, so seeding them can't move them on their other sheets (see
 * sheetPosition in countSheets.js — the per-sheet position, falling back to
 * catShelfOrder).
 *
 * Pure — no Firestore. Callers own the writes (see shelfWriteChunks).
 */
import { byShelf, sheetPosition } from '@/lib/countSheets'
import { sheetCategoryKeys, isSplitItem } from '@/lib/buckets'

/**
 * @param members  items ALREADY on the target sheet (not the item being placed):
 *                 { id, name, [field] }
 * @param field    the position field on `members` to read
 * @returns {{ seeds: Array<{id, pos}>, position: number }}
 *   seeds    — unpositioned members to number first (display order)
 *   position — the placed item's position: after everything on the sheet
 */
export function planShelfAppend(members, field) {
  const ordered = [...(members || [])].sort(byShelf(field))
  let max = 0
  for (const m of ordered) {
    const v = m[field]
    if (v != null && Number.isFinite(Number(v))) max = Math.max(max, Number(v))
  }
  const seeds = []
  let next = max
  for (const m of ordered) {
    if (m[field] != null) continue
    next += 1
    seeds.push({ id: m.id, pos: next })
  }
  return { seeds, position: next + 1 }
}

/**
 * End-of-sheet placement on a CATEGORY sheet. `items` must carry `_cat` (the
 * resolved home key) — membership is buckets.sheetCategoryKeys, the same rule
 * the grouped table and printed sheets use.
 */
export function nextShelfPosition(items, sheetKey, { excludeId } = {}) {
  const onSheet = (items || [])
    .filter(i => i && !i.removed && String(i.id) !== String(excludeId))
    .filter(i => sheetCategoryKeys(i).includes(sheetKey))
  const byId = new Map(onSheet.map(i => [String(i.id), i]))
  const members = onSheet.map(i => ({ id: i.id, name: i.name, pos: sheetPosition(i, sheetKey) }))
  const plan = planShelfAppend(members, 'pos')
  // Each seed carries its own write: catShelfOrder for a one-sheet item,
  // sheetShelfOrder[sheetKey] for a split one.
  return {
    ...plan,
    seeds: plan.seeds.map(sd => ({ ...sd, data: sheetShelfWrite(byId.get(String(sd.id)), sheetKey, sd.pos) })),
  }
}

/**
 * The write that puts `item` at `pos` on category sheet `sheetKey`: its own
 * per-sheet entry when it is counted on several sheets (home included —
 * catShelfOrder is left as the fallback), else catShelfOrder as always.
 * The same object is the Firestore merge write AND the local patch
 * (applyItemPatches merges sheetShelfOrder key by key, like merge:true does).
 */
export function sheetShelfWrite(item, sheetKey, pos) {
  return isSplitItem(item) ? { sheetShelfOrder: { [sheetKey]: pos } } : { catShelfOrder: pos }
}

/**
 * Positions for the sheets an item JOINS when its membership changes (edit
 * panel "Counted on sheets", or a split item's new home): each joined sheet
 * puts it at that sheet's END, numbering that sheet's unpositioned items first
 * (nextShelfPosition). Sheets it was already on keep their order.
 *
 * @param items     the location's items, each with `_cat` (home key)
 * @param item      the item, as it is now (with `_cat`)
 * @param nextKeys  its countCategories after the change
 * @returns {{ joined: string[], itemMap: object, seedSets: Array }}
 *   itemMap  — { [joinedSheet]: position } for the item's sheetShelfOrder
 *   seedSets — the other items' seeds, for shelfWriteChunks / seedPatches
 */
export function planJoinedSheets(items, item, nextKeys) {
  const before = sheetCategoryKeys(item)
  const joined = sheetCategoryKeys({ ...item, countCategories: nextKeys }).filter(k => !before.includes(k))
  const itemMap = {}
  const seedSets = []
  for (const key of joined) {
    const plan = nextShelfPosition(items, key, { excludeId: item.id })
    seedSets.push({ field: 'catShelfOrder', seeds: plan.seeds })
    itemMap[key] = plan.position
  }
  return { joined, itemMap, seedSets }
}

/** A stored sheetShelfOrder → a clean { [sheetKey]: number } (anything else dropped). */
export function shelfMap(v) {
  const out = {}
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    for (const [k, n] of Object.entries(v)) if (n != null && Number.isFinite(Number(n))) out[k] = Number(n)
  }
  return out
}

/** Merge two partial item writes; sheetShelfOrder merges key by key. */
export function mergeShelfData(a = {}, b = {}) {
  const out = { ...a, ...b }
  if (a.sheetShelfOrder || b.sheetShelfOrder) out.sheetShelfOrder = { ...(a.sheetShelfOrder || {}), ...(b.sheetShelfOrder || {}) }
  return out
}

/** End-of-list placement in the FLAT view (one list, no categories, no splits). */
export function nextFlatPosition(items, { excludeId } = {}) {
  const members = (items || [])
    .filter(i => i && !i.removed && String(i.id) !== String(excludeId))
    .map(i => ({ id: i.id, name: i.name, flatShelfOrder: i.flatShelfOrder ?? null }))
  return planShelfAppend(members, 'flatShelfOrder')
}

/**
 * Turn seed plans (+ the placed item's own write) into Firestore batch chunks.
 * Seeds for the same item from different fields merge into ONE write. A seed
 * may carry its own `data` (nextShelfPosition's sheet-aware seeds); otherwise
 * it writes { [field]: pos }. The
 * placed item goes in the LAST chunk, so it is never written before the
 * seeds that make its position mean "end of sheet".
 *
 * @param seedSets [{ field, seeds: [{id, pos}] }]
 * @param final    { id, data } | null — the placed item's write
 * @returns Array<Array<{id, data}>>  each ≤ size entries
 */
export function shelfWriteChunks(seedSets, final, size = 450) {
  const byId = new Map()
  for (const { field, seeds } of seedSets || []) {
    for (const { id, pos, data } of seeds || []) {
      const k = String(id)
      byId.set(k, mergeShelfData(byId.get(k), data || { [field]: pos }))
    }
  }
  const entries = [...byId].map(([id, data]) => ({ id, data }))
  if (final) entries.push(final)
  const chunks = []
  for (let i = 0; i < entries.length; i += size) chunks.push(entries.slice(i, i + size))
  return chunks
}

/** Seed patches for local state: { [id]: { field: pos, ... } } (patchItemFields shape). */
export function seedPatches(seedSets) {
  const out = {}
  for (const { field, seeds } of seedSets || []) {
    for (const { id, pos, data } of seeds || []) out[id] = mergeShelfData(out[id], data || { [field]: pos })
  }
  return out
}

// ─────────────────────────────────────────────────────────────────────────────
// Reorder within a sheet — shared by Arrange drag and typed position
// ─────────────────────────────────────────────────────────────────────────────

/** Insert-and-shift: move arr[from] to index `to`; everything between shifts by one. Never a swap. */
export function arrayMove(arr, from, to) {
  const next = arr.slice()
  const [moved] = next.splice(from, 1)
  next.splice(to, 0, moved)
  return next
}

/**
 * Parse what was typed in an Arrange position box. Whole numbers only (sign
 * allowed — planMoveTo clamps); blank, decimal, or anything else → null, which
 * the box treats as "revert, write nothing". A typo like 2.5 must not silently
 * land somewhere.
 */
export function parsePositionInput(raw) {
  const s = String(raw ?? '').trim()
  return /^[-+]?\d+$/.test(s) ? parseInt(s, 10) : null
}

/**
 * Typed move: put itemId at sheet place n (1-based) within `ids` — the sheet's
 * CURRENT displayed order — shifting the items between. Over-size clamps to the
 * end, 0/negative to 1. Returns the new order, or null for a no-op (unknown id,
 * non-integer n, or already at that place). The result is exactly what dragging
 * the item to slot n produces (same arrayMove), and goes to the same persist.
 */
export function planMoveTo(ids, itemId, n) {
  if (!Array.isArray(ids) || !Number.isInteger(n)) return null
  const from = ids.findIndex(id => String(id) === String(itemId))
  if (from < 0) return null
  const to = Math.min(Math.max(n, 1), ids.length) - 1
  if (to === from) return null
  return arrayMove(ids, from, to)
}

/**
 * The writes a reorder needs: the sheet renumbered 1..N in `orderedIds` order,
 * diffed against each item's current `field` — only changed positions are
 * written. Unpositioned items get their displayed place (so a first move
 * numbers the whole sheet, like a first drag). Used for the flat list; a
 * category sheet uses sheetReorderChanges (per-sheet positions).
 */
export function reorderChanges(items, field, orderedIds) {
  const cur = new Map((items || []).map(i => [String(i.id), i[field]]))
  const changes = []
  ;(orderedIds || []).forEach((id, idx) => {
    if (cur.get(String(id)) !== idx + 1) changes.push({ id, pos: idx + 1 })
  })
  return changes
}

/**
 * reorderChanges for one CATEGORY sheet: renumber it 1..N in `orderedIds`
 * order, comparing against each item's position on THIS sheet, and give each
 * change its write — sheetShelfOrder[sheetKey] for an item counted on several
 * sheets (so its other sheets keep their order), catShelfOrder otherwise.
 * @returns Array<{ id, pos, data }>
 */
export function sheetReorderChanges(items, sheetKey, orderedIds) {
  const byId = new Map((items || []).map(i => [String(i.id), i]))
  const changes = []
  ;(orderedIds || []).forEach((id, idx) => {
    const item = byId.get(String(id))
    if (!item) return
    if (sheetPosition(item, sheetKey) !== idx + 1) changes.push({ id, pos: idx + 1, data: sheetShelfWrite(item, sheetKey, idx + 1) })
  })
  return changes
}
