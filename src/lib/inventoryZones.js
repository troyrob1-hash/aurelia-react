import { collection, getDocs, query, where, writeBatch } from 'firebase/firestore'
import { db } from '@/lib/firebase'
import { locId } from '@/lib/pnl'

// Per-location inventory ZONE migration helpers — the exact single-location
// shape of inventoryCategories.js (scanCategoryUsageInLocation /
// renameCategoryInLocation), isolated and unit-testable apart from any UI.
//
// Phase 0 ships the CONFIG layer only: items do not carry a `zone` field yet
// (that write path is Phase 1). So today scanZoneUsageInLocation always returns
// 0 and reassignZoneInLocation is a no-op — nothing references zones on items
// yet. The functions are built now, the careful way categories does it, so the
// delete/merge path is already correct when Phase 1 starts tagging counts with
// a zone. The critical-safety rule from the plan — deleting a zone that holds
// counts must MERGE them into another zone, never silently drop them — is
// implemented here (reassign before the caller removes the zone), even though
// there is nothing to merge yet.
//
// CRITICAL invariants (mirror inventoryCategories.js):
//   • Location item docs live at tenants/{orgId}/inventory/{locId}/items/{id},
//     locId = sanitizeDocId(RAW prefixed location name). Always derive locId
//     from the same `name` field everything else uses (the CR_/SO_ prefix trap).
//   • A reassign writes ONLY the `zone` field. qty, eaches, unitCost, category,
//     counts and every other field are untouched — zone is a counting-location
//     grouping and never affects valuation, counts, or P&L.
//   • Writes are chunked into batches of ≤450 ops and committed sequentially.
//   • reassignZoneInLocation re-tags items ONLY. It does NOT flip the settings
//     zones doc — the caller flips settings AFTER this resolves, the single,
//     explicit commit point. Re-running is idempotent: it re-scans the OLD key.

const CHUNK = 450

/**
 * Dry-run for the delete/merge confirm dialog: count items in THIS location
 * whose stored `zone` field equals `zoneKey`. Read-only — writes nothing.
 *
 * Returns 0 today (no item carries a zone until Phase 1), which is the correct
 * "nothing to merge" signal the delete flow already handles.
 *
 * @returns {Promise<number>}
 */
export async function scanZoneUsageInLocation(orgId, locationId, zoneKey) {
  if (!orgId || !locationId || !zoneKey) return 0
  const id = locId(locationId) // RAW prefixed name → sanitized doc id (CR_/SO_ preserved)
  const snap = await getDocs(query(
    collection(db, 'tenants', orgId, 'inventory', id, 'items'),
    where('zone', '==', zoneKey)
  ))
  return snap.size
}

/**
 * Merge every item carrying `fromZoneKey` → `toZoneKey` in ONE location. Items
 * ONLY — does NOT flip the per-location zones doc (caller's commit point). This
 * is the "never silently drop counts on delete" guarantee: a deleted zone's
 * items are reassigned to a surviving zone BEFORE the caller removes the zone.
 * Idempotent: re-scans `fromZoneKey`, so a retry processes only what's left.
 *
 * Writes ONLY { zone: toZoneKey } on query-sourced docs (so `update` is safe and
 * no other field is altered). Batches are ≤CHUNK, committed sequentially.
 *
 * @param {(p: { done: number, total: number }) => void} [onProgress]
 * @returns {Promise<{ total: number, updated: number }>}
 */
export async function reassignZoneInLocation(orgId, locationId, fromZoneKey, toZoneKey, onProgress) {
  // Defensive no-op: never write when the zone isn't actually changing.
  if (!orgId || !locationId || !fromZoneKey || !toZoneKey || fromZoneKey === toZoneKey) {
    onProgress?.({ done: 0, total: 0 })
    return { total: 0, updated: 0 }
  }

  const id = locId(locationId)
  // Phase 1 — re-scan fromZoneKey (idempotent: already-moved items carry
  // toZoneKey and won't match, so a retry only picks up the remainder).
  const snap = await getDocs(query(
    collection(db, 'tenants', orgId, 'inventory', id, 'items'),
    where('zone', '==', fromZoneKey)
  ))
  const refs = snap.docs.map(d => d.ref)
  const total = refs.length
  if (total === 0) {
    onProgress?.({ done: 0, total: 0 })
    return { total: 0, updated: 0 }
  }

  // Phase 2 — commit reassigns in chunked, sequential batches.
  let done = 0
  for (let i = 0; i < refs.length; i += CHUNK) {
    const slice = refs.slice(i, i + CHUNK)
    const batch = writeBatch(db)
    // zone field ONLY — never qty/eaches/unitCost/category/counts.
    slice.forEach(ref => batch.update(ref, { zone: toZoneKey }))
    await batch.commit()
    done += slice.length
    onProgress?.({ done, total })
  }

  return { total, updated: done }
}
