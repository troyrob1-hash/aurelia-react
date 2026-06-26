import { collection, getDocs, query, where, writeBatch } from 'firebase/firestore'
import { db } from '@/lib/firebase'
import { locId } from '@/lib/pnl'

// Inventory category migration helpers (Category manager Step 3).
//
// Pure data module — no React. The dangerous part of the category manager
// (re-tagging item docs across every location when a populated category is
// renamed) lives here, isolated and unit-testable, so it can be reviewed apart
// from any UI.
//
// CRITICAL invariants:
//   • Location item docs live at tenants/{orgId}/inventory/{locId}/items/{id},
//     where locId = sanitizeDocId(RAW prefixed location name). We always derive
//     locId from the same `name` field that drives it everywhere else — using a
//     cleaned/display name would read empty paths (the CR_/SO_ prefix trap).
//   • A re-tag writes ONLY the `category` field. qty, eaches, unitCost,
//     packPrice, glCode, parLevel, counts and every other field are untouched —
//     category is display-grouping only and never affects valuation, counts, or
//     P&L (which rolls up by GL code).
//   • Writes are chunked into batches of ≤450 ops (under Firestore's 500 limit)
//     and committed sequentially.
//   • renameCategoryAcrossLocations re-tags items ONLY. It does NOT flip the
//     settings label — the caller flips settings AFTER this resolves, so the
//     settings write is the single, explicit commit point. Re-running is
//     idempotent: it re-scans the OLD label, so already-renamed items (now
//     carrying the new label) don't match and only the remainder is processed.

const CHUNK = 450

/**
 * Read every location under orgs/{orgId}/locations, INCLUDING inactive ones —
 * an inactive location can still hold items carrying a stale category label
 * (and may be reactivated). Sub-cafes are their own location docs, so they're
 * covered too.
 *
 * @returns {Promise<Array<{ name: string, locId: string }>>} one entry per
 *   distinct locId (deduped — two names that sanitize to the same locId share
 *   one items collection and must not be processed twice).
 */
export async function enumerateLocations(orgId) {
  if (!orgId) return []
  const snap = await getDocs(collection(db, 'orgs', orgId, 'locations'))
  const byLocId = new Map()
  snap.forEach(d => {
    const name = d.data()?.name
    if (!name) return // skip nameless docs; do NOT filter on active
    const id = locId(name) // RAW prefixed name → sanitized doc id
    if (!byLocId.has(id)) byLocId.set(id, { name, locId: id })
  })
  return Array.from(byLocId.values())
}

/**
 * Dry-run for the rename confirm dialog: count items whose STORED `category`
 * field exactly equals `oldLabel`, across all locations. Read-only — writes
 * nothing. (Inferred-category items carry no stored label and group by key
 * independent of the settings label, so they neither match here nor need
 * re-tagging.)
 *
 * @returns {Promise<{ totalItems: number,
 *   locationsAffected: Array<{ name: string, locId: string, count: number }> }>}
 */
export async function scanCategoryUsage(orgId, oldLabel) {
  const locations = await enumerateLocations(orgId)
  const locationsAffected = []
  let totalItems = 0
  for (const loc of locations) {
    const snap = await getDocs(query(
      collection(db, 'tenants', orgId, 'inventory', loc.locId, 'items'),
      where('category', '==', oldLabel)
    ))
    if (snap.size > 0) {
      locationsAffected.push({ name: loc.name, locId: loc.locId, count: snap.size })
      totalItems += snap.size
    }
  }
  return { totalItems, locationsAffected }
}

/**
 * On-demand full tally for the "Load item counts" affordance: read every item
 * in every location once and tally by STORED category label. Expensive (reads
 * all item docs across all locations) — run only on explicit user action, never
 * on tab mount. Counts reflect stored labels only (inferred-only items aren't
 * counted), consistent with what a rename actually re-tags.
 *
 * @returns {Promise<Record<string, number>>} label → item count.
 */
export async function scanAllCategoryCounts(orgId) {
  const locations = await enumerateLocations(orgId)
  const counts = {}
  for (const loc of locations) {
    const snap = await getDocs(collection(db, 'tenants', orgId, 'inventory', loc.locId, 'items'))
    snap.forEach(d => {
      const cat = d.data()?.category
      if (cat == null || cat === '') return
      counts[cat] = (counts[cat] || 0) + 1
    })
  }
  return counts
}

/**
 * Re-tag every item carrying `oldLabel` → `newLabel`, across all locations.
 * Items ONLY — does NOT touch the settings doc (caller flips the settings label
 * afterward as the commit point).
 *
 * Phase 1 re-scans `oldLabel` everywhere (so retries pick up only the
 * remainder); phase 2 commits the re-tags in ≤CHUNK batches, sequentially,
 * reporting progress per committed batch.
 *
 * Each batch writes ONLY { category: newLabel } on docs that exist (they came
 * from a query), so `update` is safe and no other field is altered.
 *
 * @param {(p: { location: string|null, done: number, total: number }) => void} [onProgress]
 * @returns {Promise<{ total: number, updated: number }>}
 */
export async function renameCategoryAcrossLocations(orgId, oldLabel, newLabel, onProgress) {
  // Defensive no-op: never write when the label isn't actually changing.
  if (!orgId || !oldLabel || !newLabel || oldLabel === newLabel) {
    onProgress?.({ location: null, done: 0, total: 0 })
    return { total: 0, updated: 0 }
  }

  const locations = await enumerateLocations(orgId)

  // Phase 1 — collect matching refs per location (re-scan oldLabel → idempotent).
  const perLocation = [] // [{ name, refs: DocumentReference[] }]
  let total = 0
  for (const loc of locations) {
    const snap = await getDocs(query(
      collection(db, 'tenants', orgId, 'inventory', loc.locId, 'items'),
      where('category', '==', oldLabel)
    ))
    if (snap.size > 0) {
      perLocation.push({ name: loc.name, refs: snap.docs.map(d => d.ref) })
      total += snap.size
    }
  }

  if (total === 0) {
    onProgress?.({ location: null, done: 0, total: 0 })
    return { total: 0, updated: 0 }
  }

  // Phase 2 — commit re-tags in chunked, sequential batches.
  let done = 0
  for (const { name, refs } of perLocation) {
    for (let i = 0; i < refs.length; i += CHUNK) {
      const slice = refs.slice(i, i + CHUNK)
      const batch = writeBatch(db)
      // category field ONLY — never qty/eaches/unitCost/packPrice/glCode/counts.
      slice.forEach(ref => batch.update(ref, { category: newLabel }))
      await batch.commit()
      done += slice.length
      onProgress?.({ location: name, done, total })
    }
  }

  return { total, updated: done }
}

// ── Single-location variants (per-location categories, Phase C) ──────────────
// Once categories live per-location, rename/delete only ever touch ONE
// location's items — no enumerateLocations, no cross-location fan-out. These are
// the lean single-collection versions of the helpers above.

/**
 * Dry-run for the single-location rename/delete confirm dialog: count items in
 * THIS location whose stored `category` equals `label`. Read-only.
 *
 * @returns {Promise<number>}
 */
export async function scanCategoryUsageInLocation(orgId, locationId, label) {
  if (!orgId || !locationId || !label) return 0
  const id = locId(locationId) // RAW prefixed name → sanitized doc id (CR_/SO_ preserved)
  const snap = await getDocs(query(
    collection(db, 'tenants', orgId, 'inventory', id, 'items'),
    where('category', '==', label)
  ))
  return snap.size
}

/**
 * Re-tag items carrying `oldLabel` → `newLabel` in ONE location. Items ONLY —
 * does NOT flip the per-location categories doc (caller's commit point). Also
 * serves DELETE: pass newLabel = 'General' to reassign a deleted category's
 * items. Idempotent: re-scans `oldLabel`, so a retry processes only what's left.
 *
 * Writes ONLY { category: newLabel } on docs that exist (query-sourced), so
 * `update` is safe and no other field (qty/eaches/unitCost/packPrice/glCode/
 * counts) is altered. Batches are ≤CHUNK and committed sequentially — usually a
 * single batch (one location's matches < 450).
 *
 * @param {(p: { done: number, total: number }) => void} [onProgress]
 * @returns {Promise<{ total: number, updated: number }>}
 */
export async function renameCategoryInLocation(orgId, locationId, oldLabel, newLabel, onProgress) {
  // Defensive no-op: never write when the label isn't actually changing.
  if (!orgId || !locationId || !oldLabel || !newLabel || oldLabel === newLabel) {
    onProgress?.({ done: 0, total: 0 })
    return { total: 0, updated: 0 }
  }

  const id = locId(locationId)
  // Phase 1 — re-scan oldLabel (idempotent: already-renamed items carry newLabel
  // and won't match, so a retry only picks up the remainder).
  const snap = await getDocs(query(
    collection(db, 'tenants', orgId, 'inventory', id, 'items'),
    where('category', '==', oldLabel)
  ))
  const refs = snap.docs.map(d => d.ref)
  const total = refs.length
  if (total === 0) {
    onProgress?.({ done: 0, total: 0 })
    return { total: 0, updated: 0 }
  }

  // Phase 2 — commit re-tags in chunked, sequential batches.
  let done = 0
  for (let i = 0; i < refs.length; i += CHUNK) {
    const slice = refs.slice(i, i + CHUNK)
    const batch = writeBatch(db)
    // category field ONLY — never qty/eaches/unitCost/packPrice/glCode/counts.
    slice.forEach(ref => batch.update(ref, { category: newLabel }))
    await batch.commit()
    done += slice.length
    onProgress?.({ done, total })
  }

  return { total, updated: done }
}
