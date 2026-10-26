// COUNT-IN-MULTIPLE-BUCKETS model layer — pure functions only.
//
// One item counted separately in several BUCKETS that roll up into one total.
// Two kinds of bucket share this one module (no parallel system):
//
//   • STORAGE ZONES — location-wide ("FOH cooler", "BOH storage"). Every item
//     at a multi-zone location is expected in every zone. Done = "swept"
//     (session.zonesCompleted).
//   • CATEGORY SHEETS — per item. A SPLIT item (2+ countCategories) is counted
//     once per category sheet it belongs to. Done = "sheet complete"
//     (session.sectionsCompleted). Bucket key = 'cat:' + category key, so a
//     category bucket can never collide with a zone key (zone keys are
//     slugified [a-z0-9_] and cannot contain ':').
//
// An item's buckets are its category sheets if it is split, else the
// location's zones (bucketsFor). Both kinds live in the count doc's `zones`
// map — the field name predates categories and is kept so existing zoned docs
// need no migration. Everything below (the honesty rule, the derived total,
// the multi-device merge in useInventory) is bucket-agnostic.
//
// (Original Phase 1 notes, still accurate with "zone" read as "bucket":)
//
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
export const UNBUCKETED_KEY = '__unzoned'

// ── Category buckets ────────────────────────────────────────────────────────
export const CAT_BUCKET_PREFIX = 'cat:'
/** Bucket key for a category sheet. */
export const catBucketKey = (catKey) => CAT_BUCKET_PREFIX + catKey
export const isCatBucketKey = (k) => typeof k === 'string' && k.startsWith(CAT_BUCKET_PREFIX)
/** Category key from a category bucket key; null for a zone key. */
export const catKeyOfBucket = (k) => (isCatBucketKey(k) ? k.slice(CAT_BUCKET_PREFIX.length) : null)

/**
 * The item's count categories (KEYS), de-duplicated, home first when present.
 * `_bucketCats` — the membership stored on the count doc — wins when set: a
 * past period is read with the membership it was COUNTED with, so adding a
 * category today can't turn last week's split item incomplete. In the current
 * period it is unset and the live item.countCategories applies (so adding a
 * category mid-period makes the item incomplete until that sheet is counted —
 * intended, and named at close).
 */
export function countCategoryKeys(item) {
  const src = Array.isArray(item?._bucketCats) ? item._bucketCats : item?.countCategories
  if (!Array.isArray(src)) return []
  const keys = [...new Set(src.filter(k => typeof k === 'string' && k !== ''))]
  const home = item?._cat
  return home && keys.includes(home) ? [home, ...keys.filter(k => k !== home)] : keys
}

/** A SPLIT item is counted per category sheet: 2+ count categories. 0 or 1 → exactly as before. */
export function isSplitItem(item) {
  return countCategoryKeys(item).length >= 2
}

/**
 * Which category SHEETS an item appears on (screen groups, printed sheets).
 * Split: one per count category (= its buckets). Otherwise: its home (_cat).
 */
export function sheetCategoryKeys(item) {
  if (isSplitItem(item)) return countCategoryKeys(item)
  return typeof item?._cat === 'string' && item._cat !== '' ? [item._cat] : []
}

/** The buckets an item is counted in: its category sheets if split, else the location's zones. */
export function bucketsFor(item, zones) {
  return isSplitItem(item)
    ? countCategoryKeys(item).map(k => ({ key: catBucketKey(k) }))
    : resolveZones(zones)
}

/** Counted per bucket (split, or holding bucket entries) rather than as one flat record. */
export function isBucketed(item) {
  return isSplitItem(item) || hasBucketData(item)
}

/**
 * Every bucket key marked done this session: swept zones + completed category
 * sheets (as 'cat:' keys). The one list completeness reads.
 */
export function completedBuckets(session) {
  const z = Array.isArray(session?.zonesCompleted) ? session.zonesCompleted : []
  const c = Array.isArray(session?.sectionsCompleted) ? session.sectionsCompleted : []
  return [...z, ...c.map(catBucketKey)]
}

/** True when an item actually carries per-zone data (vs. a legacy flat record). */
export function hasBucketData(item) {
  const z = item?.zones
  return !!z && typeof z === 'object' && !Array.isArray(z) && Object.keys(z).length > 0
}

/** True when a single zone entry holds a real count. Reuses shrinkage's rule so
 *  "counted" means the same thing at zone grain as at item grain — notably,
 *  an entered 0 IS counted, while null/''/absent is not. */
export function bucketHasEntry(entry) {
  return isCounted(entry)
}

/**
 * Per-zone totals in EACHES: { [zoneKey]: eaches }.
 *
 * Pure arithmetic — carries no completeness opinion (that is isBucketComplete).
 * Each zone = qty × qtyPerPack + eaches, with qtyPerPack taken from the ITEM:
 * pack size is a property of the product, not of the shelf it sits on.
 *
 * A legacy flat record (no zones map) yields a single { __unzoned } entry, so
 * zoned and unzoned records both compose with rollupBuckets.
 *
 * Zone keys present on the item but NO LONGER in the location's configured list
 * (a deleted zone) are still included — their counts are real and must never be
 * silently dropped by a config change.
 */
export function bucketTotals(item) {
  if (!hasBucketData(item)) {
    // A split item with no entries yet has nothing counted — never fall back to
    // its in-memory top-level (load() coerces that; it is not a count).
    if (isSplitItem(item)) return {}
    return { [UNBUCKETED_KEY]: countEaches(item) }
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
 * Takes the output of bucketTotals, so the __unzoned fallback is already folded
 * in for legacy records and there is no path that adds a zoned item's
 * denormalised top-level on top of its own zones.
 */
export function rollupBuckets(totals) {
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
export function isBucketComplete(item, zones, zonesCompleted) {
  // Legacy flat record: predates zoning, so its top-level value is the whole
  // truth. Counted-ness is the only question, exactly as today.
  if (!isBucketed(item)) return isCounted(item)

  const swept = new Set(Array.isArray(zonesCompleted) ? zonesCompleted : [])
  const configured = bucketsFor(item, zones)

  for (const z of configured) {
    const key = z?.key
    if (!key) continue
    if (bucketHasEntry(item.zones?.[key])) continue  // known value
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
  if (!isBucketComplete(item, zones, zonesCompleted)) return null
  if (!isBucketed(item)) return isCounted(item) ? countEaches(item) : null
  return rollupBuckets(bucketTotals(item))
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
export function bucketProgress(zones, zonesCompleted) {
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
  if (!isBucketed(item)) {
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
      split: false,
      incomplete: !counted,
      total: counted ? countEaches(item) : null,
      pending: [],
    }
  }
  const total = derivedTotalEaches(item, zones, zonesCompleted)
  return {
    zoned: true,          // counted per bucket (zones or category sheets)
    split: isSplitItem(item),
    incomplete: total === null,
    total,
    pending: pendingBuckets(item, zones, zonesCompleted),
  }
}

/**
 * Human sentence for the "—" tooltip: names the outstanding zones by LABEL
 * (not key), so the counter reads "Not counted yet in: BOH storage" rather
 * than a slug. Returns '' when nothing is pending.
 */
export function pendingBucketsLabel(pending, zones, categories) {
  if (!Array.isArray(pending) || pending.length === 0) return ''
  const label = bucketLabeler(zones, categories)
  return `Not counted yet in: ${pending.map(label).join(', ')}`
}

/**
 * key → human label for both bucket kinds: a zone by its label, a category
 * bucket as "<Category> sheet". Unknown keys fall back to the key (a deleted
 * zone) or the bare category key (a deleted category).
 */
export function bucketLabeler(zones, categories) {
  const byKey = new Map(resolveZones(zones).map(z => [z.key, z.label || z.key]))
  for (const c of Array.isArray(categories) ? categories : []) {
    if (c?.key) byKey.set(catBucketKey(c.key), `${c.label || c.key} sheet`)
  }
  return k => byKey.get(k) || catKeyOfBucket(k) || k
}

/**
 * Which configured zones are still blocking completeness — the data a "—" cell
 * needs in order to say WHY it is incomplete rather than just showing a dash.
 * Empty array means complete.
 */
export function pendingBuckets(item, zones, zonesCompleted) {
  if (!isBucketed(item)) return isCounted(item) ? [] : resolveZones(zones).map(z => z.key)
  const swept = new Set(Array.isArray(zonesCompleted) ? zonesCompleted : [])
  return bucketsFor(item, zones)
    .filter(z => z?.key && !bucketHasEntry(item.zones?.[z.key]) && !swept.has(z.key))
    .map(z => z.key)
}

/**
 * What a period close would lock in as incomplete — the data behind the
 * Save & Close guard. Closing with gaps stays ALLOWED (a counter may genuinely
 * be done); it just must never happen silently, because every gap below
 * closes at $0 and an understated closing reads as shrinkage.
 *
 * Resolution is countDisplay's, so the guard can never disagree with what the
 * count cells show:
 *   - notCounted: item names with no count at all (a flat record, or an item
 *     with no zone entries) — the "—" an un-zoned location already has.
 *   - partial:    zoned items with a count somewhere but an unswept, unentered
 *     zone: [{ name, pending: [zoneKey] }].
 *   - unsweptZones: configured zone keys not yet swept — ONLY when the location
 *     has multiple zones; a single-zone location has no sweep UI, so naming
 *     its implicit zone would be noise (the Phase 0 gate).
 */
export function closeOutIssues(items, zones, zonesCompleted) {
  const notCounted = []
  const partial = []
  const sheets = []   // unfinished category sheets (category keys), first-seen order
  for (const item of items || []) {
    if (!item) continue
    const d = countDisplay(item, zones, zonesCompleted)
    if (!d.incomplete) continue
    const name = item.name || String(item.id ?? '')
    // Partly counted = a bucketed item with at least one real entry; a split
    // item with nothing entered yet is simply not counted.
    const anyEntry = hasBucketData(item) && Object.values(item.zones).some(bucketHasEntry)
    if (d.zoned && anyEntry) partial.push({ name, pending: d.pending })
    else notCounted.push(name)
    // A category sheet is unfinished while any split item on it is pending there.
    for (const k of d.pending) {
      const cat = catKeyOfBucket(k)
      if (cat && !sheets.includes(cat)) sheets.push(cat)
    }
  }
  const configured = resolveZones(zones)
  const swept = new Set(Array.isArray(zonesCompleted) ? zonesCompleted : [])
  const unsweptZones = configured.length > 1
    ? configured.filter(z => z?.key && !swept.has(z.key)).map(z => z.key)
    : []
  return {
    notCounted,
    partial,
    unsweptZones,
    unfinishedSheets: sheets,
    any: notCounted.length > 0 || partial.length > 0 || unsweptZones.length > 0 || sheets.length > 0,
  }
}

/**
 * The warning paragraph for the close confirm, naming what is incomplete.
 * Lists are capped at `max` names with "and N more" so a big catalog can't
 * produce an unreadable dialog. Returns '' when there is nothing to warn about.
 */
export function closeOutWarningText(issues, zones, max = 8, categories = []) {
  if (!issues?.any) return ''
  const label = bucketLabeler(zones, categories)
  const catLabel = k => (Array.isArray(categories) && categories.find(c => c?.key === k)?.label) || k
  const list = names => names.length > max
    ? `${names.slice(0, max).join(', ')} and ${names.length - max} more`
    : names.join(', ')
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`
  const lines = []
  if (issues.unsweptZones.length) {
    lines.push(`• ${plural(issues.unsweptZones.length, 'zone', 'zones')} not swept: ${list(issues.unsweptZones.map(label))}`)
  }
  if (issues.unfinishedSheets?.length) {
    lines.push(`• ${plural(issues.unfinishedSheets.length, 'category sheet', 'category sheets')} not finished: ${list(issues.unfinishedSheets.map(catLabel))}`)
  }
  if (issues.partial.length) {
    const named = issues.partial.map(p => `${p.name} (not counted in ${p.pending.map(label).join(', ')})`)
    lines.push(`• ${plural(issues.partial.length, 'item', 'items')} only partly counted: ${list(named)}`)
  }
  if (issues.notCounted.length) {
    lines.push(`• ${plural(issues.notCounted.length, 'item has', 'items have')} no count: ${list(issues.notCounted)}`)
  }
  return `This count is incomplete:\n\n${lines.join('\n')}\n\nIncomplete items close at $0, which shows up as shrinkage.`
}

// ─────────────────────────────────────────────────────────────────────────────
// COUNT READERS — one place that knows how much of an item is on hand
// ─────────────────────────────────────────────────────────────────────────────
// A zoned item's in-memory top-level qty/eaches is NOT its count (see
// countDisplay's trap note): qty is null by construction and eaches is whatever
// load() coerced. Every reader that used `item.qty` therefore saw a zoned item
// as 0 / uncounted — variance, Prior, days-on-hand, par, the Why panel, exports.
// These helpers are the replacement. LEGACY items are byte-identical to before:
// the pack view returns item.qty exactly as those readers always read it.

/**
 * Total on hand in EACHES, or null when not (fully) counted.
 * Zoned: the derived total (null while incomplete — the honesty rule).
 * Legacy: countEaches when it holds a count, else null.
 */
export function itemTotalEaches(item, zones, zonesCompleted) {
  if (!item) return null
  if (isBucketed(item)) return derivedTotalEaches(item, zones, zonesCompleted)
  return flatHasCount(item) ? countEaches(item) : null
}

/**
 * The PACK-denominated count that par levels, reorder points, variance and
 * days-on-hand compare against. Legacy: item.qty, unchanged. Zoned: the derived
 * total expressed in packs (eaches ÷ pack size), null while incomplete.
 */
export function itemCountQty(item, zones, zonesCompleted) {
  if (!item) return null
  if (!isBucketed(item)) return item.qty ?? null
  const total = derivedTotalEaches(item, zones, zonesCompleted)
  return total == null ? null : toPacks(total, item)
}

/**
 * The same pack view, read from a STORED count record (a prior period's doc,
 * a Path B snapshot row). For a stored zoned record the persisted top-level
 * eaches IS the authoritative total (written null while incomplete), so no
 * zone config or sweep state is needed — or wanted: a closed period's total is
 * what it was saved as.
 */
export function storedCountQty(rec) {
  if (!rec) return null
  if (!hasBucketData(rec)) return rec.qty ?? null
  return rec.eaches == null ? null : toPacks(Number(rec.eaches), rec)
}

// Eaches → packs, rounded to 2 dp: it is displayed (Prior column, par) and a
// 1/12-pack remainder shouldn't print as 2.0833333.
function toPacks(eaches, item) {
  return Math.round((eaches / packSizeOf(item)) * 100) / 100
}

function packSizeOf(item) {
  const q = Number(item?.qtyPerPack)
  return Number.isFinite(q) && q > 0 ? q : 1
}

// ─────────────────────────────────────────────────────────────────────────────
// MULTI-DEVICE — merge remote zone entries without losing local edits
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Merge a remote zones map (from the live listener) into the local one.
 * Zones THIS device has edited and not yet persisted (`dirtyKeys`) keep their
 * local value; every other zone takes the remote value — including a remote
 * DELETE (the key absent remotely is dropped locally). Returns undefined when
 * the result is empty, so a legacy record stays zone-free.
 *
 * Why per-zone and not per-item: two counters on different sheets of the SAME
 * item is the normal case. Skipping the whole item while it's locally touched
 * (the pre-zones rule) meant a remote zone edit arriving then was never
 * applied, and this device's total stayed wrong until reload.
 */
export function mergeRemoteBuckets(localZones, remoteZones, dirtyKeys) {
  const dirty = dirtyKeys instanceof Set ? dirtyKeys : new Set(dirtyKeys || [])
  const out = {}
  for (const [k, v] of Object.entries(remoteZones || {})) {
    if (!dirty.has(k)) out[k] = v
  }
  for (const k of dirty) {
    if (localZones && k in localZones) out[k] = localZones[k]
  }
  return Object.keys(out).length ? out : undefined
}

/**
 * Dollar value of a STORED count record (a Path B snapshot row, a count doc) —
 * the same valuation as useInventory's itemValue: qty × packPrice + eaches ×
 * eachPrice, with packPrice falling back to qtyPerPack × unitCost (unitCost is
 * the per-EACH cost). For a stored zoned record qty is null and eaches is the
 * derived total, so this values it correctly too.
 */
export function storedRecordValue(rec) {
  if (!rec) return 0
  const qpp = packSizeOf(rec)
  const unit = Number(rec.unitCost) || 0
  const pp = Number(rec.packPrice) || qpp * unit
  const eachPrice = pp / qpp
  return (Number(rec.qty) || 0) * pp + (Number(rec.eaches) || 0) * eachPrice
}

// ─────────────────────────────────────────────────────────────────────────────
// CATEGORY PORTIONS — category totals that always sum to the closing value
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The share of a SPLIT item's value that belongs to one category sheet:
 * value × (that sheet's eaches ÷ the item's total eaches). Because one
 * each-price applies to every bucket, that is exactly sheetEaches × eachPrice,
 * and an item's portions sum to its value by construction.
 *
 * An INCOMPLETE item has value 0 (it contributes nothing to closing), so all
 * its portions are 0 — that is what keeps category totals reconciling to
 * closing while a sheet is still out. A complete item totalling 0 eaches has
 * nothing to share.
 *
 * Works on itemsWithMeta (needs _value and _totalEaches, both zone/sheet-aware).
 */
export function portionValue(item, catKey) {
  const value = Number(item?._value) || 0
  const total = Number(item?._totalEaches)
  if (!value || !Number.isFinite(total) || total <= 0) return 0
  const sheet = bucketTotals(item)[catBucketKey(catKey)] || 0
  return value * (sheet / total)
}

/**
 * Where ONE item's value goes, category by category — the single allocation
 * rule behind both the on-screen category totals (categoryTotals) and the
 * export's "By Category" sheet, so the two can never disagree.
 *
 * The item's value is allocated ONCE, never multiplied:
 *   - SPLIT item → its portion on each of its sheets (portionValue); a sheet
 *     for a category no longer in `knownKeys`, and value held in stray
 *     buckets (a zone entry, a deleted category), goes to null =
 *     "not in any category".
 *   - otherwise → its whole value to its home category (_cat), or null when
 *     the home isn't in the list.
 * Σ allocation values === item._value, always (up to float rounding).
 *
 * @returns {{ catKey: string|null, value: number }[]}
 */
export function allocateItemValue(item, knownKeys) {
  const known = knownKeys instanceof Set ? knownKeys : new Set(knownKeys || [])
  const value = Number(item?._value) || 0
  if (!isSplitItem(item)) {
    return [{ catKey: known.has(item?._cat) ? item._cat : null, value }]
  }
  const out = []
  let placed = 0
  for (const k of countCategoryKeys(item)) {
    if (!known.has(k)) continue
    const share = portionValue(item, k)
    out.push({ catKey: k, value: share })
    placed += share
  }
  const rest = value - placed
  if (Math.abs(rest) > 1e-9) out.push({ catKey: null, value: rest })
  return out
}

/**
 * Category totals for the screen headers and catStats, built from
 * allocateItemValue so that
 *
 *     Σ byCat[k].value + uncategorized.value  ===  Σ item._value  (closingValue)
 *
 * A SPLIT item contributes its portion to each of its sheets — never its full
 * value to each (the double-count risk). Per category also: `items` (rows on
 * that sheet) and `counted` (rows whose count on THAT sheet is known — an
 * entry, or the sheet is complete).
 *
 * @returns {{ byCat: Record<string,{value,items,counted}>, uncategorized: {value,items}, total }}
 */
export function categoryTotals(items, categories, zones, done) {
  const keys = (Array.isArray(categories) ? categories : []).map(c => c?.key).filter(Boolean)
  const known = new Set(keys)
  const doneSet = new Set(Array.isArray(done) ? done : [])
  const byCat = Object.fromEntries(keys.map(k => [k, { value: 0, items: 0, counted: 0 }]))
  const uncategorized = { value: 0, items: 0 }
  let total = 0
  for (const item of items || []) {
    if (!item) continue
    total += Number(item._value) || 0
    for (const a of allocateItemValue(item, known)) {
      if (a.catKey == null) { uncategorized.value += a.value; uncategorized.items += 1; continue }
      byCat[a.catKey].value += a.value
    }
    // Row counts per sheet the item appears on (membership, not value).
    if (isSplitItem(item)) {
      for (const k of countCategoryKeys(item)) {
        if (!known.has(k)) continue
        byCat[k].items += 1
        const b = catBucketKey(k)
        if (bucketHasEntry(item.zones?.[b]) || doneSet.has(b)) byCat[k].counted += 1
      }
    } else if (known.has(item._cat)) {
      byCat[item._cat].items += 1
      if (!countDisplay(item, zones, done).incomplete) byCat[item._cat].counted += 1
    }
  }
  return { byCat, uncategorized, total }
}

// ─────────────────────────────────────────────────────────────────────────────
// MEMBERSHIP CHANGES — re-shape an item's counts, never drop one
// ─────────────────────────────────────────────────────────────────────────────

/** Sum two bucket entries field-wise; null stays null only when both are. */
function sumEntries(a, b) {
  const add = f => (a?.[f] == null && b?.[f] == null) ? null : (Number(a?.[f]) || 0) + (Number(b?.[f]) || 0)
  return { qty: add('qty'), eaches: add('eaches') }
}

/**
 * Re-shape an item's in-progress counts when its category membership changes
 * (edit-panel multi-select, or a category deleted). Pure.
 *
 *   flat → split   An existing flat count moves into the HOME sheet's bucket.
 *                  The other sheets start blank, so the item reads incomplete
 *                  until they are counted (intended; named at close).
 *   split → split  A removed sheet's count MERGES into the home sheet (the
 *                  category-delete rule); the removed bucket is cleared.
 *   split → flat   Every bucket entry folds into one flat count (qty and
 *                  eaches summed separately, which preserves total eaches).
 *
 * @param item      the local item (raw, with its current zones/countCategories)
 * @param nextKeys  the new count categories (keys); ≤1 means "not split"
 * @param homeKey   the item's home category key — the merge target
 * @returns {{ countCategories: string[], patch: object, dirtyKeys: string[], changedCounts: boolean }}
 *   countCategories — what to store on the item doc ([] when not split; home
 *   always included when split). patch — fields to set on the local item
 *   (`zones: undefined` means remove the map). dirtyKeys — bucket keys the
 *   save must write. changedCounts — the item's counts moved (mark it touched).
 */
export function rebucketForMembership(item, nextKeys, homeKey) {
  const valid = k => typeof k === 'string' && k !== ''
  const next = [...new Set((nextKeys || []).filter(valid))]
  const willSplit = next.length >= 2
  const stored = willSplit ? (next.includes(homeKey) ? next : [homeKey, ...next]).filter(valid) : []
  const wasSplit = isSplitItem({ countCategories: item?.countCategories })
  const zones = { ...(item?.zones || {}) }
  const home = catBucketKey(homeKey)

  if (!wasSplit && willSplit) {
    if (!flatHasCount(item)) return { countCategories: stored, patch: { countCategories: stored }, dirtyKeys: [], changedCounts: false }
    zones[home] = sumEntries(zones[home], { qty: item.qty ?? null, eaches: Number(item.eaches) || 0 })
    return {
      countCategories: stored,
      patch: { countCategories: stored, zones, qty: null, eaches: 0, _qtyRaw: null, _eachesRaw: null },
      dirtyKeys: [home],
      changedCounts: true,
    }
  }

  if (wasSplit && willSplit) {
    const keep = new Set(stored.map(catBucketKey))
    const dirty = []
    for (const k of Object.keys(zones)) {
      if (!isCatBucketKey(k) || keep.has(k)) continue
      if (bucketHasEntry(zones[k])) { zones[home] = sumEntries(zones[home], zones[k]); if (!dirty.includes(home)) dirty.push(home) }
      zones[k] = { qty: null, eaches: null }   // cleared → written as deleteField
      dirty.push(k)
    }
    return { countCategories: stored, patch: { countCategories: stored, zones }, dirtyKeys: dirty, changedCounts: dirty.length > 0 }
  }

  if (wasSplit && !willSplit) {
    let flat = { qty: null, eaches: null }
    for (const v of Object.values(zones)) if (bucketHasEntry(v)) flat = sumEntries(flat, v)
    return {
      countCategories: [],
      patch: { countCategories: [], zones: undefined, qty: flat.qty, eaches: flat.eaches ?? 0, _qtyRaw: null, _eachesRaw: null },
      dirtyKeys: [],
      changedCounts: Object.keys(zones).length > 0,
    }
  }

  return { countCategories: stored, patch: { countCategories: stored }, dirtyKeys: [], changedCounts: false }
}
