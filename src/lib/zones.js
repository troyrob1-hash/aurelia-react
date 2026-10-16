// Multi-zone inventory MODEL LAYER (Phase 1) — pure functions only.
//
// One item counted separately in several named zones ("FOH cooler", "BOH
// storage") that roll up into ONE canonical total on-hand, in EACHES. No
// Firestore, no React, no write path — Phase 1 is the arithmetic and the
// completeness rule, nothing else. shrinkage.js and pnl.js are deliberately
// untouched; this module IMPORTS the canonical arithmetic from shrinkage.js
// rather than restating it, so the two can never disagree on what an "each" is.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE HONESTY RULE — the single most important behaviour in this feature
// ─────────────────────────────────────────────────────────────────────────────
// A partially-counted item must resolve to INCOMPLETE (null), never to the sum
// of only the zones counted so far. A false-low total is not a smaller error
// than no total: shrinkage is `expected − closing`, so an understated closing
// is reported as physical loss. "Cooler counted, storage pending" summing to
// cooler-only would invent shrinkage that never happened, on real money, with
// nothing on screen to suggest the number is partial.
//
// Resolution per zone (the agreed sweep table). A zone is "swept" when the
// counter has declared they walked it — the same idea as
// session.sectionsCompleted, which zonesCompleted mirrors:
//
//   swept + has entry  → that value
//   swept + no entry   → a REAL 0   (they walked it; the item wasn't there)
//   unswept + entry    → that value
//   unswept + no entry → UNKNOWN    → the whole item is incomplete → null
//
// Note the asymmetry is the entire point: absence only means zero once someone
// has asserted they looked.
//
// ─────────────────────────────────────────────────────────────────────────────
// BACK-COMPAT — no migration, by construction
// ─────────────────────────────────────────────────────────────────────────────
// An item with NO `zones` map is a legacy flat record that predates zoning. Its
// top-level qty/eaches IS its complete total, and it is evaluated exactly as
// today: `isCounted` decides counted-ness, `countEaches` computes the value.
// Zone completeness applies ONLY once an item actually carries a zones map
// (which nothing writes until Phase 2). This is what stops a manager adding a
// second zone from retroactively marking every historical count incomplete.
//
// ─────────────────────────────────────────────────────────────────────────────
// NO DOUBLE-COUNTING
// ─────────────────────────────────────────────────────────────────────────────
// Once zones exist on an item, the top-level qty/eaches becomes the DERIVED
// denormalisation of those zones (Phase 2 writes it) — an output, not an input.
// So the rollup reads top-level ONLY when there is no zones map. Summing both
// would double every zoned item's on-hand.

import { countEaches, isCounted } from '@/lib/shrinkage'
import { resolveZones } from '@/lib/zoneHelpers'

/**
 * Reserved key for the implicit bucket holding a legacy flat record's
 * top-level qty/eaches. Not a configurable zone and never written as one —
 * it exists so a pre-zones record can flow through the same rollup.
 */
export const UNZONED_KEY = '__unzoned'

/** True when an item actually carries per-zone data (vs. a legacy flat record). */
export function hasZoneData(item) {
  const z = item?.zones
  return !!z && typeof z === 'object' && !Array.isArray(z) && Object.keys(z).length > 0
}

/** True when a single zone entry holds a real count. Reuses shrinkage's rule so
 *  "counted" means the same thing at zone grain as at item grain — notably,
 *  an entered 0 IS counted, while null/''/absent is not. */
export function zoneHasEntry(entry) {
  return isCounted(entry)
}

/**
 * Per-zone totals in EACHES: { [zoneKey]: eaches }.
 *
 * Pure arithmetic — carries no completeness opinion (that is isZoneComplete).
 * Each zone = qty × qtyPerPack + eaches, with qtyPerPack taken from the ITEM:
 * pack size is a property of the product, not of the shelf it sits on.
 *
 * A legacy flat record (no zones map) yields a single { __unzoned } entry, so
 * zoned and unzoned records both compose with rollupZones.
 *
 * Zone keys present on the item but NO LONGER in the location's configured list
 * (a deleted zone) are still included — their counts are real and must never be
 * silently dropped by a config change.
 */
export function zoneTotals(item) {
  if (!hasZoneData(item)) {
    return { [UNZONED_KEY]: countEaches(item) }
  }
  const qtyPerPack = item?.qtyPerPack
  const out = {}
  for (const [key, entry] of Object.entries(item.zones)) {
    // Reuse countEaches by lending each zone the item's pack size.
    out[key] = countEaches({ qty: entry?.qty, eaches: entry?.eaches, qtyPerPack })
  }
  return out
}

/**
 * Sum a per-zone totals map into one number.
 *
 * Takes the output of zoneTotals, so the __unzoned fallback is already folded
 * in for legacy records and there is no path that adds a zoned item's
 * denormalised top-level on top of its own zones.
 */
export function rollupZones(totals) {
  if (!totals || typeof totals !== 'object') return 0
  return Object.values(totals).reduce((sum, v) => sum + (Number(v) || 0), 0)
}

/**
 * The honesty rule. Is this item fully resolved across every configured zone?
 *
 * SIGNATURE NOTE: this takes the location's configured `zones` list as well as
 * the swept list. It cannot be derived from the item alone — the dangerous case
 * is a zone with NO entry on the item, which is invisible without knowing the
 * zone exists. A two-argument version would silently treat "storage pending" as
 * "storage doesn't apply", which is the exact false-low this rule exists to
 * prevent.
 *
 * @param {object} item            the count line (may carry item.zones)
 * @param {Array}  zones           the location's configured zones [{key,...}]
 * @param {string[]} zonesCompleted zone keys the counter has swept
 * @returns {boolean}
 */
export function isZoneComplete(item, zones, zonesCompleted) {
  // Legacy flat record: predates zoning, so its top-level value is the whole
  // truth. Counted-ness is the only question, exactly as today.
  if (!hasZoneData(item)) return isCounted(item)

  const swept = new Set(Array.isArray(zonesCompleted) ? zonesCompleted : [])
  const configured = resolveZones(zones)

  for (const z of configured) {
    const key = z?.key
    if (!key) continue
    if (zoneHasEntry(item.zones[key])) continue  // known value
    if (swept.has(key)) continue                 // swept and empty → a real 0
    return false                                 // unswept and empty → UNKNOWN
  }
  return true
}

/**
 * The derived total, in eaches — the number Phase 2 will denormalise onto the
 * count line's top-level qty/eaches.
 *
 * Returns a number ONLY when the item is complete, and null otherwise. Writing
 * null (rather than a partial sum) is what makes the honesty rule hold all the
 * way downstream for free: the existing isCounted/hasCount already read null as
 * uncounted and render "—", so no consumer ever sees a confident-but-low total.
 *
 * @returns {number|null}
 */
export function derivedTotalEaches(item, zones, zonesCompleted) {
  if (!isZoneComplete(item, zones, zonesCompleted)) return null
  if (!hasZoneData(item)) return isCounted(item) ? countEaches(item) : null
  return rollupZones(zoneTotals(item))
}

/**
 * Does a LEGACY flat record hold a real count, for display/save purposes?
 *
 * Deliberately NOT isCounted. The two differ on {qty:null, eaches:0}:
 *   - isCounted says YES (an entered 0 is a real count) — correct for
 *     shrinkage, where a counted zero must not be confused with a missing feed.
 *   - here it must be NO, because load() hydrates `eaches: c.eaches ?? 0` and
 *     base catalog rows start at 0, so EVERY uncounted item carries eaches === 0.
 *     Treating that as counted would render a confident "0" on every untouched
 *     line instead of "—".
 *
 * Mirrors useInventory's hasCount(), which is the save path's rule. It is
 * restated here rather than imported because useInventory imports this module —
 * importing back would be a cycle. The duplication is two lines and pinned by
 * a test that compares the two implementations.
 */
export function flatHasCount(item) {
  if (!item) return false
  if (item.qty != null) return true
  return typeof item.eaches === 'number' && item.eaches > 0
}

/**
 * Sweep progress for the session header: { swept, total }.
 * Mirrors the existing "N/M sections" counter; drives "2/3 zones swept".
 */
export function zoneProgress(zones, zonesCompleted) {
  const configured = resolveZones(zones)
  const swept = new Set(Array.isArray(zonesCompleted) ? zonesCompleted : [])
  return {
    total: configured.length,
    swept: configured.filter(z => z?.key && swept.has(z.key)).length,
  }
}

/**
 * What the count cell should DISPLAY for an item. The single resolution point
 * for Phase 4 rendering.
 *
 * THE TRAP THIS EXISTS TO PREVENT: a zoned item's in-memory top-level is NOT
 * its derived total. load() hydrates `eaches: c.eaches ?? 0`, so an INCOMPLETE
 * item — stored with a deliberate null total — comes back as 0. Rendering
 * item.eaches would therefore show a confident "0" for an item whose real
 * on-hand is unknown: the exact false-low the whole feature is built to avoid,
 * surfaced at the last possible moment. Always render from here.
 *
 * @returns {{zoned:boolean, incomplete:boolean, total:number|null, pending:string[]}}
 *   incomplete → render "—" (never a number), with `pending` naming why.
 */
export function countDisplay(item, zones, zonesCompleted) {
  if (!hasZoneData(item)) {
    // Legacy flat record: unchanged — counted shows its value, uncounted "—".
    //
    // Uses flatHasCount, NOT isCounted. isCounted treats an entered 0 as a real
    // count, which is right for shrinkage — but load() defaults `eaches: 0` on
    // EVERY item, counted or not, so by that rule every uncounted item would
    // render a confident "0" instead of "—". flatHasCount is the display/save
    // rule (qty entered, or eaches > 0), matching useInventory's hasCount.
    const counted = flatHasCount(item)
    return {
      zoned: false,
      incomplete: !counted,
      total: counted ? countEaches(item) : null,
      pending: [],
    }
  }
  const total = derivedTotalEaches(item, zones, zonesCompleted)
  return {
    zoned: true,
    incomplete: total === null,
    total,
    pending: pendingZones(item, zones, zonesCompleted),
  }
}

/**
 * Human sentence for the "—" tooltip: names the outstanding zones by LABEL
 * (not key), so the counter reads "Not counted yet in: BOH storage" rather
 * than a slug. Returns '' when nothing is pending.
 */
export function pendingZonesLabel(pending, zones) {
  if (!Array.isArray(pending) || pending.length === 0) return ''
  const byKey = new Map(resolveZones(zones).map(z => [z.key, z.label || z.key]))
  const names = pending.map(k => byKey.get(k) || k)
  return `Not counted yet in: ${names.join(', ')}`
}

/**
 * Which configured zones are still blocking completeness — the data a "—" cell
 * needs in order to say WHY it is incomplete rather than just showing a dash.
 * Empty array means complete.
 */
export function pendingZones(item, zones, zonesCompleted) {
  if (!hasZoneData(item)) return isCounted(item) ? [] : resolveZones(zones).map(z => z.key)
  const swept = new Set(Array.isArray(zonesCompleted) ? zonesCompleted : [])
  return resolveZones(zones)
    .filter(z => z?.key && !zoneHasEntry(item.zones[z.key]) && !swept.has(z.key))
    .map(z => z.key)
}
