import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import { doc, getDoc, setDoc, collection, getDocs, serverTimestamp, writeBatch, deleteDoc, deleteField, updateDoc, arrayUnion, arrayRemove, onSnapshot } from 'firebase/firestore'
import { db } from '@/lib/firebase'
import { getPriorKey as getPriorKeyLib, locId as locIdLib, isPeriodLocked, resolveOpeningWindow } from '@/lib/pnl'
import { classifyVariance } from '@/lib/variance'
import { useCountsListener } from '@/hooks/useCountsListener'
import { useToast } from '@/components/ui/Toast'
import { resolveZones } from '@/lib/zoneHelpers'
// Phase 1 model layer — the single source of the zone arithmetic and the
// honesty rule. The write path CALLS these; it never restates them.
import { hasBucketData, bucketHasEntry, derivedTotalEaches, mergeRemoteBuckets, itemCountQty, itemTotalEaches, storedCountQty, isBucketed, isSplitItem, countCategoryKeys, bucketsFor, catBucketKey, completedBuckets, categoryTotals, rebucketForMembership, displayCents } from '@/lib/buckets'

// getPriorKey + sanitizeDocId moved to @/lib/pnl as the canonical source.
// Re-exported here so existing call sites (Inventory.jsx imports sanitizeDocId
// from this module) keep working without churn.
const getPriorKey = getPriorKeyLib
export const sanitizeDocId = locIdLib

export const fmt$ = (v) => '$' + Number(v || 0).toLocaleString('en-US', { 
  minimumFractionDigits: 2, 
  maximumFractionDigits: 2 
})

// Inventory count variance vs the prior count. Thin wrapper over the canonical
// classifyVariance (lib/variance) — one definition of the 10%/25% bands, no drift.
function getVarianceClass(curr, prior) {
  return classifyVariance(curr, prior)
}

function calcDaysOnHand(qty, avgDailyUsage) {
  if (!avgDailyUsage || avgDailyUsage <= 0) return null
  return Math.round((qty / avgDailyUsage) * 10) / 10
}

function inferCategory(glCode, itemType, itemName) {
  const gl = String(glCode || '').toLowerCase()
  const t = String(itemType || '').toLowerCase()
  const n = String(itemName || '').toLowerCase()
  if (gl.includes('12002')) return 'Barista'
  if (t.includes('barista')) return 'Barista'
  if (t.includes('beverage') || t.includes('bev')) return 'Beverages'
  if (t.includes('snack') || t.includes('snac')) return 'Snacks'
  if (t.includes('condiment') || t.includes('cond')) return 'Condiments'
  const bevWords = ['juice','water','soda','kombucha','tea ','lemonade','coffee','frappuccino','cola','coke','sprite','gatorade','celsius','red bull','rockstar','yerba','milk','almond milk','oat milk','soy milk','coconut milk','half and half','half & half','cream','protein shake','naked','illy','tractor','aura bora','boylan','virgil','joe ','eclipse','boxed water','smart water','topochico','perrier','pelegrino','pellegrino','diet coke','coke zero','coconut water','cold brew']
  if (bevWords.some(w => n.includes(w))) return 'Beverages'
  const barWords = ['cafe moto','espresso','chai','syrup','ghirardelli','david rio','matcha','teavana','starbucks','cream charger','agave','caramel sauce','chocolate sauce','white chocolate sauce','pumpkin spice','caramel brulee','freeze dried','dragonfruit','strawberry acai','mango dragonfruit','cinnamon','heavy cream','decaf moto','charger','latte']
  if (barWords.some(w => n.includes(w))) return 'Barista'
  const condWords = ['sauce','sriracha','cholula','tapatio','tabasco','ketchup','mustard','mayonnaise','soy sauce','salt packet','pepper packet','sugar','sweetener','packet','cracker','saltine']
  if (condWords.some(w => n.includes(w))) return 'Condiments'
  const snackWords = ['bar','chip','cookie','candy','chocolate','gummy','gummi','bears','jerky','pretzel','popcorn','puffcorn','nut ','nuts','almond','cashew','granola','oatmeal','yogurt','cheese','string cheese','salami','hummus','guacamole','pickle','olive','seaweed','mints','mint','gum','fruit','wafel','waffle','uncrustable','pop tart','oreo','ice cream','frozen','soup','cheesecake','brownie','blondie','marshmallow','rice crisp','snickers','twix','kit kat','reese','m&m','skittles','starburst','haribo','kind ','clif','rxbar','rx bar','builder','luna','88 acres','lenka','shameless','love corn','lovecorn','hippeas','popchips','uglies','north fork','sahale','ferris','poshi','bean vivo','gimme','quinn','solely','soley','chimes','vegobear','rip van','awake','justin','righteous','legally addictive','sabra','unreal','k protein','special k','nature valley','nut harvest','barebell','kopper','peeled','blue bunny','sweet street','sweet craft','dibs','haagen','ice cream cone','soft frozen','core power','oikos','block & barrel','marish','orchard valley','blobs','apple','fuji','banana','grand','frito']
  if (snackWords.some(w => n.includes(w))) return 'Snacks'
  if (gl.includes('12000')) return 'Snacks'
  return 'Other'
}

/**
 * Predicate: does this item carry a count worth persisting?
 * True if EITHER qty is set (incl. 0 — a legitimate "I counted zero of these")
 * OR eaches is a positive number (the loose-units count). False if both fields
 * are absent / zero. Used to:
 *   - decide which items to include in newCounts (the save list)
 *   - decide which touched items are "explicitly cleared" (the deletion list)
 * Before this predicate existed, the filter was `i.qty != null` alone, which
 * silently dropped items where the user only filled in the eaches input
 * (qty stays null, eaches gets the value) — those items would contribute to
 * closingValue but never land on the counts doc.
 */
export function hasCount(item) {
  if (!item) return false
  // ZONED item (Phase 2): counted-ness is decided by the ZONES, never by the
  // derived top-level. Two reasons this must come first:
  //   1. A fully-counted item whose zones legitimately total 0 would otherwise
  //      fail the `eaches > 0` test below, get filtered out of newCounts AND
  //      swept into `deletions` — destroying the zone data for a real count.
  //   2. An INCOMPLETE item writes a null top-level on purpose; it still has
  //      zone entries worth persisting and must not be deleted.
  // Legacy items (no zones map) fall through to the original logic unchanged.
  if (hasBucketData(item)) return Object.values(item.zones).some(bucketHasEntry)
  if (item.qty != null) return true
  if (typeof item.eaches === 'number' && item.eaches > 0) return true
  return false
}

/**
 * Pure "roll forward" transform for the short-week rollover button: copies each item's
 * qty/eaches from priorItems (by id) into items, for the stub week that has no real count
 * yet. An item with no matching prior entry, or a prior that itself has no count, is left
 * untouched (never fabricates a count the prior week didn't have). Exported so the actual
 * copy logic is unit-testable without Firestore.
 */
export function applyRollover(items, priorItems, meta = {}) {
  const priorById = new Map((priorItems || []).map(p => [String(p.id), p]))
  const at = meta.at ?? null
  const by = meta.by || 'unknown'
  return (items || []).map(item => {
    const p = priorById.get(String(item.id))
    if (!p || !hasCount(p)) return item
    return {
      ...item,
      qty: p.qty ?? null,
      eaches: p.eaches ?? 0,
      lastCountedAt: at,
      lastCountedBy: by,
      _qtyRaw: null,
      _eachesRaw: null,
    }
  })
}

/**
 * Merge a fresh batch of counted items into the existing Firestore items list,
 * applying explicit deletions for items the user cleared in this session.
 *
 * Three classes of input behavior:
 *   - `newCounts` entries OVERRIDE existing entries with the same id (the
 *     normal "user updated this item" case).
 *   - `deletions` ids are REMOVED from the result. Without this signal a
 *     cleared item would fall through to the existing Firestore value and
 *     silently survive — that's the W1 $61K-reappear bug from 2026-06-18.
 *   - Existing entries that are NOT in `newCounts` and NOT in `deletions`
 *     are PRESERVED — the "Tracy protection": a partial save must never
 *     wipe items the user didn't touch this session.
 *
 * Pure function — no Firestore access. Exported for unit testing.
 */
export function mergeCountsWithDeletions(existing, newCounts, deletions) {
  const byId = {}
  for (const it of existing || []) {
    if (it && it.id != null) byId[String(it.id)] = it
  }
  for (const it of newCounts || []) {
    if (it && it.id != null) byId[String(it.id)] = it
  }
  for (const id of deletions || []) {
    delete byId[String(id)]
  }
  return Object.values(byId)
}

/**
 * Per-item count writer (concurrency-safe re-architecture, Phase 1). Writes ONE
 * doc per counted item to counts/{periodKey}/items/{itemId} and DELETES the doc
 * for each cleared item. Two counters on different devices touch different item
 * docs, so writes can never clobber one another — no read-merge-write, no race.
 *
 * Each count doc is a complete record (plain `set`, last-write-wins per item)
 * carrying qty/eaches + attribution + DENORMALIZED pricing (packPrice /
 * qtyPerPack / unitCost) captured at count time, so the Phase-2 Cloud Function
 * can value the count without re-joining the catalog. Ops are chunked ≤450 per
 * writeBatch and committed sequentially (Firestore's 500-op limit).
 *
 * Pure Firestore, no React. `colRef` = collection(... 'counts', periodKey, 'items').
 */

/**
 * Collision-safe Firestore document id for a count doc, derived from the item
 * id. Catalog item ids are arbitrary FIELD values (SKUs with '/', empty, etc.)
 * that are ILLEGAL as raw doc ids — so keying by String(id) threw and aborted
 * the whole write (the Phase-1 COGS=0 regression).
 *
 * We do NOT use the locId-style sanitizer ([^a-zA-Z0-9]→_) here: it is LOSSY, so
 * distinct ids ("A/B" and "A-B") collapse to the same doc id and one count
 * would clobber another — unacceptable on a money path. encodeURIComponent is
 * INJECTIVE (reversible), so distinct ids always map to distinct doc ids. The
 * "id_" prefix guarantees the result is never empty / "." / ".." / a reserved
 * "__…__" id, and encodeURIComponent removes "/". The RAW id is also stored in
 * the doc data (itemId) so the read matches on the raw id directly.
 */
/**
 * Shallow-merge `patches` ({ [itemId]: {field: value} }) into an items array.
 *
 * The reducer behind patchItemFields, extracted so the "an edit-panel write
 * shows up without a reload" guarantee is unit-testable against the SAME code
 * the hook runs — rather than a copy of it in the test that could drift.
 * Untouched ids keep their identity; only patched fields change on patched ids.
 */
export function applyItemPatches(items, patches) {
  if (!patches || !Object.keys(patches).length) return items
  return (items || []).map(i => (patches[i.id] ? { ...i, ...patches[i.id] } : i))
}

/** The `zones` part of a count write; omitted (not {}) when no zone is written. */
export function zonesWrite(c) {
  if (!hasBucketData(c)) return {}
  const payload = buildZonePayload(c.zones, c.zoneKeys)
  return Object.keys(payload).length ? { zones: payload } : {}
}

/**
 * The ONE row shape every count write uses — autosave (saveCounts), Save &
 * Close (save), and the "preserve unsaved counts" writes in restoreItem and
 * addCustomItem. Those last two used to build their own rows from the raw
 * in-memory qty/eaches with no `zones`: for a zoned item that took the legacy
 * whole-record set() branch in persistCountItems, which REPLACES the stored
 * doc — wiping its zone map — and wrote the unreliable in-memory top-level as
 * the total. One builder means no path can drift from the zone rules again.
 *
 * ZONED: top-level = the DERIVED total in eaches (qty:null), null while
 * incomplete (zonedTopLevel); `zones` = the full local map (touchedIdsToClear
 * compares against it); `zoneKeys` = the zones THIS device edited — the only
 * ones written (buildZonePayload). LEGACY: qty/eaches exactly as before.
 */
export function buildCountWrite(i, zones, zonesCompleted, zoneKeys) {
  return {
    id: i.id,
    ...zonedTopLevel(i, zones, zonesCompleted),
    ...(hasBucketData(i) ? { zones: i.zones, zoneKeys: [...(zoneKeys || [])] } : {}),
    // The membership this count was taken under (split items) — read back for
    // past periods (see load's _bucketCats). null for a non-split item.
    // Only on bucketed rows, so a legacy row is byte-identical to before.
    ...(isBucketed(i) ? { countCategories: isSplitItem(i) ? countCategoryKeys(i) : null } : {}),
    countedAt: i.lastCountedAt || null,
    countedBy: i.lastCountedBy || null,
    // Denormalized pricing for the Phase-2 CF valuation (price-at-count-time).
    packPrice: i.packPrice ?? null,
    qtyPerPack: i.qtyPerPack ?? null,
    unitCost: i.unitCost ?? null,
    // Denormalized metadata for the CF Path B rebuild (see persistCountItems).
    name: i.name ?? null, category: i.category ?? null, vendor: i.vendor ?? null,
    countedViaUpload: i.countedViaUpload,   // carries the upload audit flag through
  }
}

/**
 * qty/eaches for a Path B snapshot row. LEGACY: exactly the old row
 * (qty passed through, eaches || 0). ZONED: the derived total via
 * zonedTopLevel — the in-memory top-level of a zoned item is whatever load()
 * coerced, not its count, so copying it put a wrong number in the snapshot that
 * WasteLog and the Why panel read.
 */
export function pathBCount(i, zones, zonesCompleted) {
  if (!hasBucketData(i)) return { qty: i.qty, eaches: i.eaches || 0 }
  const top = zonedTopLevel(i, zones, zonesCompleted)
  return { qty: null, eaches: top.eaches ?? 0 }
}

export function countDocId(id) {
  return 'id_' + encodeURIComponent(String(id ?? ''))
}

/**
 * Build the `zones` sub-map for a zoned count write.
 *
 * A zone holding a real count writes its {qty, eaches}. A zone the user CLEARED
 * writes deleteField() at zones.<key> rather than {qty:null,eaches:null} —
 * merge:true cannot express "remove" by omission, and the two states are not
 * the same thing: an absent key means "not counted here" (so completeness falls
 * back to whether the zone was swept), whereas a stored null would read as an
 * entry. Getting this wrong turns "I haven't counted the cooler" into "the
 * cooler is empty".
 */
export function buildZonePayload(zones, onlyKeys) {
  // MULTI-DEVICE: write only the zones THIS device edited. Writing every key in
  // the local map re-sends zones another counter changed since we loaded them —
  // merge:true can't protect a key we explicitly write — so our stale copy
  // overwrote their fresh count. `onlyKeys` (the item's dirty zone keys) scopes
  // the write; a cleared dirty zone is still included, as deleteField().
  // Undefined → every key (the pre-fix behaviour), kept only for direct callers;
  // every save path passes the dirty keys via buildCountWrite.
  const keys = Array.isArray(onlyKeys) ? new Set(onlyKeys) : null
  const out = {}
  for (const [key, entry] of Object.entries(zones || {})) {
    if (keys && !keys.has(key)) continue
    out[key] = bucketHasEntry(entry)
      ? { qty: entry.qty ?? null, eaches: Number(entry.eaches) || 0 }
      : deleteField()
  }
  return out
}

/**
 * The top-level {qty, eaches} to persist for one item.
 *
 * LEGACY (no zones map): unchanged from the pre-zones write — qty passed
 * through null-preserving, eaches coerced to a finite number. Byte-identical.
 *
 * ZONED: the top-level becomes the DERIVED denormalisation of the zones, so
 * every existing consumer (closing value, Path B, exports, shrinkage's
 * countEaches) keeps working without being taught about zones. It is expressed
 * purely in eaches with qty:null, which is value-preserving — eachPrice is
 * packPrice ÷ packSize, so totalEaches × eachPrice equals the per-zone sum of
 * (qty × packPrice + eaches × eachPrice).
 *
 * derivedTotalEaches returns null unless the item is COMPLETE, so an item with
 * an unswept, unentered zone writes a null total rather than a low one. That
 * null is what makes the honesty rule hold downstream for free: isCounted and
 * hasCount already read null as uncounted and render "—".
 */
export function zonedTopLevel(item, zones, zonesCompleted) {
  const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0 }
  if (!hasBucketData(item)) {
    return { qty: item?.qty == null ? null : num(item.qty), eaches: num(item?.eaches) }
  }
  return { qty: null, eaches: derivedTotalEaches(item, zones, zonesCompleted) }
}

/**
 * Dollar value of one counted item. The SINGLE construction, shared by both
 * closingValue reduces and itemsWithMeta._value — those were three separate
 * copies of the same expression and would otherwise have to learn about zones
 * independently (and could drift).
 *
 * LEGACY: identical expression to before — qty × packPrice + eaches × eachPrice.
 *
 * ZONED: values the DERIVED total at eachPrice. Arithmetically the same number
 * the per-zone sum would give, because eachPrice = packPrice ÷ packSize.
 *
 * An INCOMPLETE zoned item has a null total and so contributes 0 — deliberately
 * the same treatment an uncounted item already gets today, not a new silent
 * understatement. The counter sees "—" on the line (Phase 4 surfaces which zone
 * is pending); what must never happen is a confident partial, which is exactly
 * what derivedTotalEaches refuses to produce.
 */
export function itemValue(item, zones, zonesCompleted) {
  const pp = item?.packPrice || ((item?.qtyPerPack || 1) * (item?.unitCost || 0))
  const eachPrice = (item?.qtyPerPack || 1) > 0 ? pp / (item?.qtyPerPack || 1) : (item?.unitCost || 0)
  if (isBucketed(item)) {
    return (derivedTotalEaches(item, zones, zonesCompleted) || 0) * eachPrice
  }
  return ((item?.qty || 0) * pp) + ((item?.eaches || 0) * eachPrice)
}

export async function persistCountItems(colRef, newCounts, deletions, updatedBy, locationName) {
  const ops = [
    ...(newCounts || [])
      .filter(c => c && c.id != null && String(c.id) !== '')
      .map(c => ({
        type: 'set', docId: countDocId(c.id),
        // ZONED items merge; legacy items keep the original whole-record write.
        // Whole-record set() on a zoned item would clobber a zone this client
        // never saw — the exact cross-device loss zones must not introduce.
        // With merge:true Firestore merges nested maps key-by-key, so
        // zones.cooler and zones.storage written by two devices BOTH survive.
        merge: hasBucketData(c),
        data: {
          // Omit `zones` entirely when no zone is being written: with
          // merge:true an EMPTY map is itself a value and would replace the
          // stored map with {} — wiping every zone.
          ...zonesWrite(c),
          itemId: String(c.id),   // RAW id — read matches on this (encoding-independent)
          // Split membership snapshot. On a merge write (bucketed doc) a no-longer
          // split item must DELETE the stale list rather than leave it behind.
          ...(c.countCategories ? { countCategories: c.countCategories }
            : hasBucketData(c) ? { countCategories: deleteField() } : {}),
          qty: c.qty, eaches: c.eaches,
          countedAt: c.countedAt ?? null, countedBy: c.countedBy ?? null,
          packPrice: c.packPrice ?? null, qtyPerPack: c.qtyPerPack ?? null, unitCost: c.unitCost ?? null,
          // Denormalized item metadata for the Phase-2 CF Path B rebuild (join-free).
          // category = i.category (raw items carry it; NOT i._cat, which lives only on
          // itemsWithMeta). locationName = raw prefixed display name (design option a).
          // Additive: no reads/filters change; old docs lack these until re-touched.
          name: c.name ?? null, category: c.category ?? null, vendor: c.vendor ?? null,
          locationName: locationName ?? null,
          updatedAt: serverTimestamp(), updatedBy: updatedBy || 'unknown',
          // Audit marker for file-uploaded counts; manual entry stays unmarked.
          ...(c.countedViaUpload ? { countedViaUpload: true } : {}),
        },
      })),
    ...(deletions || [])
      .filter(id => id != null && String(id) !== '')
      .map(id => ({ type: 'delete', docId: countDocId(id) })),
  ]
  for (let i = 0; i < ops.length; i += 450) {
    const slice = ops.slice(i, i + 450)
    const batch = writeBatch(db)
    for (const op of slice) {
      const ref = doc(colRef, op.docId)   // encoded id → always a legal doc reference
      if (op.type === 'set') {
        // Legacy (unzoned): full record, clean last-write-wins per item —
        // byte-identical to the pre-zones write. Zoned: merge, so a concurrent
        // write to a DIFFERENT zone of the same item is preserved.
        if (op.merge) batch.set(ref, op.data, { merge: true })
        else batch.set(ref, op.data)
      }
      else batch.delete(ref)
    }
    await batch.commit()
  }
}

/**
 * Decide which touched ids are SAFE to clear after a persist. An id is safe to
 * clear IFF its CURRENT local value still matches what we just persisted — i.e.
 * the user did NOT re-type it during the await window. Ids re-edited mid-await
 * (a count typed after newCounts was built, or a new count on a just-deleted
 * item) are KEPT touched so the next save persists them.
 *
 * Fixes the eaches-stranding race: values typed during the persist's await were
 * written to local `items` (→ Path B + closingValue) but excluded from the
 * already-built newCounts, then wrongly cleared from touched by the pre-await
 * snapshot — so they never reached the per-item subcollection the CF reads.
 *
 * `touchedSnapshot` = Set of ids captured pre-await. `persistedCounts` = the
 * newCounts array actually written. `latestItems` = itemsRef.current (CURRENT
 * local items, NOT the stale save-closure copy).
 */
export function touchedIdsToClear(touchedSnapshot, persistedCounts, latestItems) {
  const persistedById = new Map((persistedCounts || []).map(c => [String(c.id), c]))
  const latestById = new Map((latestItems || []).map(i => [String(i.id), i]))
  // Null-aware numeric equality: qty can be null (uncounted); eaches is numeric.
  const eqNum = (a, b) => {
    const na = a == null ? null : Number(a)
    const nb = b == null ? null : Number(b)
    return na === nb
  }
  // Zone-aware equality (Phase 2). Comparing only qty/eaches would clear a
  // touched id whose ZONE edit landed during the await: for a zoned item the
  // top-level is the derived total, so two different zone maps can share one
  // total (3 cooler + 0 storage vs 0 cooler + 3 storage), and an incomplete
  // item's total is null on BOTH sides. Either case looks "unchanged", the id
  // is cleared, and the zone edit is silently never persisted — the same class
  // as the eaches-stranding race this function exists to fix.
  const eqZones = (a, b) => {
    const az = a?.zones, bz = b?.zones
    const aHas = !!az && Object.keys(az).length > 0
    const bHas = !!bz && Object.keys(bz).length > 0
    if (!aHas && !bHas) return true
    if (aHas !== bHas) return false
    const keys = new Set([...Object.keys(az), ...Object.keys(bz)])
    for (const k of keys) {
      if (!eqNum(az[k]?.qty, bz[k]?.qty)) return false
      if (!eqNum(az[k]?.eaches, bz[k]?.eaches)) return false
    }
    return true
  }

  const cleared = new Set()
  touchedSnapshot.forEach(id => {
    const key = String(id)
    const cur = latestById.get(key)
    const persisted = persistedById.get(key)
    if (persisted) {
      // Persisted a count — clear only if the local value is UNCHANGED.
      if (cur && eqNum(cur.qty, persisted.qty) && eqNum(cur.eaches, persisted.eaches) && eqZones(cur, persisted)) cleared.add(key)
    } else {
      // Persisted a delete (or the item is gone) — clear only if it's STILL not
      // a real count locally (no new count typed during the await).
      if (!cur || !hasCount(cur)) cleared.add(key)
    }
  })
  return cleared
}

/**
 * Which stored per-item totals a zone sweep (or un-sweep) changes, and to what.
 *
 * WHY THIS EXISTS: sweeping changes an item's completeness without anyone
 * touching the item, so before this fix the sweep only moved the on-screen
 * calc. The stored count doc kept the total it was last saved with — null for
 * an item saved while the zone was unswept — and the server-side valuation
 * (functions/index.js reads the stored top-level qty/eaches, it knows nothing
 * of zones) priced that item at $0. On a CF-authoritative location that is a
 * false-low closing, i.e. phantom shrinkage: the exact failure the honesty rule
 * exists to prevent, reintroduced by the persistence layer.
 *
 * Only items whose total CAN change are returned: a zoned item that holds a
 * count somewhere (hasCount) but has NO entry in the swept zone. An item with
 * an entry in that zone doesn't depend on the sweep; an item with no zone
 * entries at all has no count doc worth updating (and reads "—" regardless).
 *
 * `nextZonesCompleted` is the swept list AFTER the toggle, so the same function
 * serves both directions: sweep → totals fill; un-sweep → back to null.
 *
 * @returns {{id, qty:null, eaches:number|null}[]}
 */
export function sweepTotalUpdates(items, zoneKey, zones, nextZonesCompleted) {
  if (!zoneKey) return []
  const out = []
  for (const i of items || []) {
    if (!i || i.id == null || String(i.id) === '') continue
    if (!hasBucketData(i) || !hasCount(i)) continue
    if (bucketHasEntry(i.zones[zoneKey])) continue
    // Only items actually counted in this bucket: a zone sweep can't change a
    // split item (its buckets are category sheets), and a sheet can't change
    // an item that isn't on it.
    if (!bucketsFor(i, zones).some(b => b.key === zoneKey)) continue
    out.push({ id: i.id, ...zonedTopLevel(i, zones, nextZonesCompleted) })
  }
  return out
}

/**
 * Persist the derived totals computed by sweepTotalUpdates — TOP-LEVEL ONLY.
 *
 * Deliberately does NOT go through the full saveCounts payload: that rewrites
 * the item's whole `zones` map from THIS device's copy, and this device's copy
 * of zones another counter entered can be stale (the live listener patches
 * top-level qty/eaches only, never zones). Doing that for every zoned item on
 * every sweep would turn a sweep into a mass cross-device zone clobber. Writing
 * only {qty, eaches} changes nothing but the total, which is all the sweep
 * changed — and each write fires the valuation trigger, so a CF-authoritative
 * location's closing recomputes from the corrected totals.
 *
 * updateDoc, not set: a doc that doesn't exist yet (an item typed but not yet
 * autosaved) must not be created as a stub with no zones/pricing. Those fail
 * with not-found, harmlessly — the pending autosave writes them in full, and
 * bucketsDoneRef is already updated, so it writes the post-sweep total.
 *
 * @returns {Promise<{written:number, failed:number}>} failed excludes not-found.
 */
export async function persistDerivedTotals(colRef, updates, updatedBy) {
  const results = await Promise.allSettled((updates || []).map(u =>
    updateDoc(doc(colRef, countDocId(u.id)), {
      qty: u.qty ?? null,
      eaches: u.eaches ?? null,
      updatedAt: serverTimestamp(),
      updatedBy: updatedBy || 'unknown',
    })
  ))
  let written = 0, failed = 0
  const writtenIds = []
  results.forEach((r, k) => {
    if (r.status === 'fulfilled') { written++; writtenIds.push(String(updates[k].id)) }
    else if (r.reason?.code !== 'not-found') failed++
  })
  return { written, failed, writtenIds }
}

/**
 * Zoned items whose STORED total no longer matches the total this device
 * derives — the multi-device convergence step, run after every save.
 *
 * Two devices writing different zones of one item at nearly the same moment
 * each write a total computed from their own copy, so the last write's total
 * can be one zone stale even though both zone entries landed (zone writes are
 * scoped, so neither clobbers the other's entry). The server-side valuation
 * reads exactly that stored total. Once the live listener has delivered the
 * other device's zone, this finds the item and the save rewrites the total —
 * top-level only, via persistDerivedTotals.
 *
 * Skips items written in this save (`skipIds`) and items with no known stored
 * total (`_storedTotal` undefined — never loaded from a doc).
 *
 * @returns {{id, qty:null, eaches:number|null}[]}
 */
export function staleDerivedTotals(items, zones, zonesCompleted, skipIds) {
  const skip = skipIds instanceof Set ? skipIds : new Set(skipIds || [])
  const out = []
  for (const i of items || []) {
    if (!i || i.id == null || !hasBucketData(i) || !hasCount(i)) continue
    if (skip.has(String(i.id)) || !('_storedTotal' in i)) continue
    const top = zonedTopLevel(i, zones, zonesCompleted)
    const stored = i._storedTotal == null ? null : Number(i._storedTotal)
    if (top.eaches !== stored) out.push({ id: i.id, ...top })
  }
  return out
}

/**
 * Apply one live-listener update to one local item. Pure — the rule behind
 * handleRemoteCounts, exported so it is tested against the code the hook runs.
 *
 * @param item     local item
 * @param patch    the listener's parsed doc ({qty, eaches, zones, storedTotal, ...}),
 *                 or null when the doc was REMOVED remotely
 * @param touched  this device has unsaved edits on the item
 * @param dirtyZoneKeys  zones this device edited and hasn't persisted (Set)
 *
 * LEGACY items keep the original rule: a touched item is skipped (local edit
 * wins), an untouched one takes the remote qty/eaches.
 *
 * ZONED items merge PER ZONE (mergeRemoteBuckets): remote values win for every
 * zone except the ones this device has dirty. The old whole-item skip meant a
 * remote zone edit arriving while this device had touched ANY zone of the item
 * was dropped for good — and with category sheets, two counters on different
 * sheets of one item is the normal case. `_storedTotal` tracks the total as
 * stored in Firestore, so a save can tell when it is stale (staleDerivedTotals).
 */
export function applyRemoteCountPatch(item, patch, touched, dirtyZoneKeys) {
  const remoteZoned = !!(patch && patch.zones)
  if (hasBucketData(item) || remoteZoned) {
    const dirty = dirtyZoneKeys || new Set()
    const zones = mergeRemoteBuckets(item.zones, patch ? patch.zones : null, dirty)
    const { zones: _drop, ...rest } = item
    const next = {
      ...rest,
      ...(zones ? { zones } : {}),
      _storedTotal: patch ? (patch.storedTotal ?? null) : null,
    }
    if (!touched) {
      // Untouched: the top-level mirrors the doc, exactly as for legacy items.
      next.qty = patch ? (patch.qty ?? null) : null
      next.eaches = patch ? (patch.eaches ?? 0) : 0
      next.lastCountedAt = patch ? (patch.lastCountedAt ?? item.lastCountedAt ?? null) : null
      next.lastCountedBy = patch ? (patch.lastCountedBy ?? item.lastCountedBy ?? null) : null
      next._qtyRaw = null
      next._eachesRaw = null
    }
    return next
  }
  if (touched) return item                         // legacy: local edit wins
  if (!patch) {
    return { ...item, qty: null, eaches: 0, lastCountedAt: null, lastCountedBy: null, _qtyRaw: null, _eachesRaw: null }
  }
  return {
    ...item,
    qty: patch.qty ?? null,
    eaches: patch.eaches ?? 0,
    lastCountedAt: patch.lastCountedAt ?? item.lastCountedAt ?? null,
    lastCountedBy: patch.lastCountedBy ?? item.lastCountedBy ?? null,
    ...('qty' in patch ? { _qtyRaw: null } : {}),
    ...('eaches' in patch ? { _eachesRaw: null } : {}),
  }
}

/**
 * Why a count upload can't set this item's total, or '' if it can. An item
 * counted per bucket — split across category sheets, or holding zone entries —
 * has no single place an uploaded total could honestly go.
 */
export function uploadRejectReason(item) {
  if (isSplitItem(item)) return 'counted on more than one category sheet — enter it on each sheet'
  if (hasBucketData(item)) return 'counted per zone — enter it in each zone'
  return ''
}

export function useInventory(orgId, locationId, periodKey, user, liveSync = false) {
  const [items, setItems] = useState([])
  const [priorItems, setPriorItems] = useState([])
  const [priorFromPeriod, setPriorFromPeriod] = useState(null)   // set when Prior walked back past the immediate prior
  const [openingValue, setOpeningValue] = useState(0)
  const [purchases, setPurchases] = useState(0)
  const [categories, setCategories] = useState([])
  const [zones, setZones] = useState(() => resolveZones(null)) // single default zone until a manager configures more (Phase 0)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [session, setSession] = useState(null)
  const [error, setError] = useState(null)
  // Buddy mode: dual attribution for team counts. Counts taken in buddy mode
  // get both names persisted to lastCountedBy + counterNames.
  const [buddyMode, setBuddyMode] = useState(false)
  const [buddyNames, setBuddyNames] = useState({ caller: '', marker: '' })

  const toast = useToast()

  // Period lock — the canonical enforcement gate (periodLocks/{loc}__{period}).
  // When locked, ALL count writes early-return with a toast (never silent), and
  // Inventory disables the actual inputs. Fixes a latent gap: today a closed
  // period only blocks writes routed through writePnL — inventory count docs +
  // the direct P&L setDoc bypass it. periodLockedRef mirrors the state so the
  // save callbacks read the current value without being re-created.
  const [periodLocked, setPeriodLocked] = useState(false)
  const periodLockedRef = useRef(false)
  periodLockedRef.current = periodLocked
  useEffect(() => {
    let cancelled = false
    if (!orgId || !locationId || !periodKey) { setPeriodLocked(false); return }
    isPeriodLocked(locationId, periodKey)
      .then(l => { if (!cancelled) setPeriodLocked(!!l) })
      .catch(() => { /* fail open on read error — enforcement is best-effort client-side */ })
    return () => { cancelled = true }
  }, [orgId, locationId, periodKey])
  // Optimistic flip so the UI locks instantly after a successful close, without
  // waiting for a re-read.
  const markPeriodLocked = useCallback(() => setPeriodLocked(true), [])
  // Shared guard for every count-write path.
  const blockedByLock = useCallback(() => {
    if (periodLockedRef.current) {
      toast.error('Period is closed — a director must reopen it to make changes.')
      return true
    }
    return false
  }, [toast])

  const priorKey = getPriorKey(periodKey)
  const locId = sanitizeDocId(locationId)

  const load = useCallback(async () => {
    if (!locationId || !periodKey || !orgId) {
      setItems([])
      setPriorItems([])
      setPriorFromPeriod(null)
      setOpeningValue(0)
      setPurchases(0)
      return
    }

    setLoading(true)
    setError(null)

    try {
      const [
        masterItemsSnap,
        locationItemsSnap,
        priorPnlSnap,
        currentPnlSnap,
        settingsSnap,
        sessionSnap,
        countsSnap,
        countsItemsSnap,
        locCatSnap,
        locZonesSnap
      ] = await Promise.all([
        getDocs(collection(db, 'tenants', orgId, 'inventoryCatalog')),
        getDocs(collection(db, 'tenants', orgId, 'inventory', locId, 'items')),
        priorKey ? getDoc(doc(db, 'tenants', orgId, 'pnl', locId, 'periods', priorKey)) : Promise.resolve(null),
        getDoc(doc(db, 'tenants', orgId, 'pnl', locId, 'periods', periodKey)),
        // Org-wide category list — kept as the fallback SEED source for
        // locations that haven't customized their own (Phase A).
        getDoc(doc(db, 'tenants', orgId, 'settings', 'inventory')),
        getDoc(doc(db, 'tenants', orgId, 'inventorySessions', `${locId}_${periodKey}`)),
        // Per-week counts — LEGACY single-doc array (pre per-item refactor).
        // Kept as the fallback read for historical periods; new/current periods
        // read the per-item subcollection below and this is ignored.
        getDoc(doc(db, 'tenants', orgId, 'inventory', locId, 'counts', periodKey)),
        // Per-ITEM count docs (Phase 1) — the canonical count store now. One doc
        // per item, concurrency-safe. Preferred over the legacy array when
        // non-empty; empty means a legacy/never-counted period → array fallback.
        getDocs(collection(db, 'tenants', orgId, 'inventory', locId, 'counts', periodKey, 'items')),
        // Per-location category list. Absent until this location is customized
        // (Phase B writes it on first edit); until then locCats is null and the
        // resolution below falls back to the global list, then defaults.
        getDoc(doc(db, 'tenants', orgId, 'inventory', locId, 'settings', 'categories')),
        // Per-location ZONE list. Absent until a manager configures zones; until
        // then locZones is null and resolveZones() returns the single default
        // zone, so the location behaves exactly as it does with no zones at all.
        getDoc(doc(db, 'tenants', orgId, 'inventory', locId, 'settings', 'zones'))
      ])

      // Read master items from the per-tenant inventoryCatalog collection.
      // Fall back to the legacy global aurelia/inv_items doc if the new
      // collection is empty (safety net during the migration window).
      let masterItems = []
      if (!masterItemsSnap.empty) {
        masterItems = masterItemsSnap.docs.map(d => d.data())
        console.log('masterItems loaded from inventoryCatalog:', masterItems.length)
      } else {
        // Fallback: read the legacy global catalog
        try {
          const legacySnap = await getDoc(doc(db, 'aurelia', 'inv_items'))
          if (legacySnap.exists()) {
            const data = legacySnap.data()
            let rawValue = data.value
            if (typeof rawValue === 'string') {
              try { rawValue = JSON.parse(rawValue) } catch(e) { rawValue = [] }
            }
            masterItems = Array.isArray(rawValue) ? rawValue : []
            console.warn('masterItems loaded from LEGACY aurelia/inv_items:', masterItems.length, '— per-tenant collection is empty')
          }
        } catch (e) {
          console.error('Legacy catalog fallback failed:', e)
        }
      }

      const locationOverrides = {}
      const locationHasOwnCatalog = !locationItemsSnap.empty && locationItemsSnap.docs.some(d => d.data().isCatalogItem)
      locationItemsSnap.forEach(d => {
        locationOverrides[d.id] = d.data()
      })

      // If location has its own catalog (uploaded by manager), use that instead of master
      let inventoryItems
      if (locationHasOwnCatalog) {
        inventoryItems = locationItemsSnap.docs
          .filter(d => !d.data().removed && !d.data().custom)
          .map(d => {
            const item = d.data()
            return {
              id: d.id,
              name: item.name || '',
              unitCost: item.unitCost || 0,
              packSize: item.packSize,
              qtyPerPack: item.qtyPerPack,
              packPrice: item.packPrice,
              vendor: item.vendor,
              glCode: item.glCode,
              sellingPrice: item.sellingPrice,
              itemType: item.itemType,
              qty: item.qty ?? null,
              eaches: item.eaches ?? 0,
              qtyPerPack: item.qtyPerPack,
              parLevel: item.parLevel,
              reorderPoint: item.reorderPoint,
              avgDailyUsage: item.avgDailyUsage,
              lastCountedAt: item.lastCountedAt || null,
              isCatalogItem: true,
              // categoryExplicit (set by the edit panel) means a human picked
              // this — honor it verbatim, including 'General'/'Other'. Only an
              // unattributed 'General'/'Other' (catalog/upload filler) falls
              // through to inference. See assignCategory for the full rationale.
              category: (item.categoryExplicit === true && item.category)
                ? item.category
                : (item.category && item.category !== 'General' && item.category !== 'Other')
                  ? item.category
                  : inferCategory(item.glCode, item.itemType, item.name),
              categoryExplicit: item.categoryExplicit === true,
              // Multi-category: the category KEYS this item is counted under
              // (home included). 0/1 → a normal item; 2+ → a split item.
              countCategories: Array.isArray(item.countCategories) ? item.countCategories : [],
              // Shelf-to-sheet ordering (Stage 1). Location-own catalog doc IS
              // the per-location record, so read directly off item.X (no
              // override layer here).
              catShelfOrder:  item.catShelfOrder  ?? null,
              flatShelfOrder: item.flatShelfOrder ?? null,
            }
          })
        console.log('Using location-specific catalog:', inventoryItems.length, 'items')
      } else {
        // Fall back to master catalog with overrides
        inventoryItems = masterItems
          .filter(item => {
            const override = locationOverrides[String(item.id)]
            return !override?.removed
          })
          .map(item => {
            const override = locationOverrides[String(item.id)] || {}
            return {
              id: String(item.id),
              name: override.name ?? item.name,
              // Edit-panel writes for these 6 fields land on the per-location
              // override doc — prefer them over the catalog so edits stick on
              // reload. ?? respects an explicit override of 0 / "" while
              // falling back to catalog when the override field is absent.
              unitCost: override.unitCost ?? item.unitCost ?? 0,
              packSize: override.packSize ?? item.packSize,
              qtyPerPack: override.qtyPerPack ?? item.qtyPerPack,
              packPrice: override.packPrice ?? item.packPrice,
              vendor: override.vendor ?? item.vendor,
              glCode: override.glCode ?? item.glCode,
              sellingPrice: item.sellingPrice,
              itemType: item.itemType,
              qty: override.qty ?? null,
              parLevel: override.parLevel,
              reorderPoint: override.reorderPoint,
              avgDailyUsage: override.avgDailyUsage,
              lastCountedAt: override.lastCountedAt,
            lastCountedBy: override.lastCountedBy,
            isKey: override.isKey || false,
            category: override.category || inferCategory(item.glCode, item.itemType, item.name),
            // Carried so assignCategory can tell a user-picked category from an
            // inferred one. The read above already honored any non-empty
            // override; this is what stops assignCategory re-inferring over it.
            categoryExplicit: override.categoryExplicit === true,
            // Multi-category membership is per-location → the override layer.
            countCategories: Array.isArray(override.countCategories) ? override.countCategories : [],
            // Shelf-to-sheet ordering (Stage 1) — per-location physical order.
            // catShelfOrder sorts within the category group; flatShelfOrder
            // sorts all items in the location. Same override.X ?? item.X ?? null
            // pattern as the other edit-panel fields so values stick on reload.
            catShelfOrder:  override.catShelfOrder  ?? item.catShelfOrder  ?? null,
            flatShelfOrder: override.flatShelfOrder ?? item.flatShelfOrder ?? null,
          }
        })
      }

      // Pick up custom items — overrides that aren't tied to a master item.
      // These have id starting with 'custom_' and the data is fully self-contained.
      const customItems = []
      locationItemsSnap.forEach(d => {
        const data = d.data()
        if (data.custom && !data.removed) {
          customItems.push({
            id: d.id,
            name: data.name || 'Untitled item',
            unitCost: data.unitCost || 0,
            packSize: data.packSize || null,
            qtyPerPack: data.qtyPerPack || 1,
            packPrice: data.packPrice || (data.unitCost || 0),
            vendor: data.vendor || null,
            glCode: data.glCode || null,
            category: data.category || inferCategory(data.glCode, null, data.name),
            categoryExplicit: data.categoryExplicit === true,
            countCategories: Array.isArray(data.countCategories) ? data.countCategories : [],
            qty: data.qty ?? null,
            parLevel: data.parLevel || null,
            reorderPoint: data.reorderPoint || null,
            avgDailyUsage: data.avgDailyUsage || null,
            lastCountedAt: data.lastCountedAt || null,
            lastCountedBy: data.lastCountedBy || null,
            isKey: data.isKey || false,
            // Shelf-to-sheet ordering (Stage 1). Custom items are fully
            // self-contained in the location-items doc, so read off data.X.
            catShelfOrder:  data.catShelfOrder  ?? null,
            flatShelfOrder: data.flatShelfOrder ?? null,
            custom: true,
          })
        }
      })

      // ── Current-week snapshot hydration ───────────────────────────────
      // The live items collection (inventory/{loc}/items) is period-agnostic
      // and is cleared (qty: null) when a new week's count begins. The real
      // entered counts for any week live in that week's Path B snapshot at
      // locations/{loc}/inventory/{periodKey}. Without reading it back, a
      // previously-counted week renders blank even though its data is intact.
      // Overlay the current week's snapshot qty/eaches onto the built rows so
      // any counted week displays exactly what was entered. Live docs remain
      // the scratchpad for the active, never-counted week (no snapshot -> noop).
      // ── Per-week counts merge ─────────────────────────────────────────
      // Item DEFINITIONS come from the shared items docs (above). COUNTS for
      // THIS week come solely from inventory/{loc}/counts/{periodKey}. If that
      // doc does not exist, the week has not been counted yet and every cell
      // is blank — no carry-over from prior weeks. This makes counts truly
      // period-scoped at the source.
      let hydratedItems = [...inventoryItems, ...customItems].map(row => ({
        ...row, qty: null, eaches: 0
      }))
      // ── Dual-read (Phase 1): per-item subcollection first, legacy array next.
      // If ANY per-item count doc exists, that subcollection is authoritative and
      // the legacy array is IGNORED (no double-count). An empty subcollection
      // means a historical/never-counted period → fall back to the legacy single
      // array doc, then the even-older Path B snapshot below.
      let countsArr = []
      if (countsItemsSnap && !countsItemsSnap.empty) {
        // Match on the RAW itemId stored in the doc (encoding-independent), so
        // the sanitized doc id never has to be reversed. Falls back to d.id for
        // any pre-fix docs that predate the itemId field.
        countsArr = countsItemsSnap.docs.map(d => { const data = d.data(); return { ...data, id: data.itemId ?? d.id } })
      } else if (countsSnap?.exists() && Array.isArray(countsSnap.data().items)) {
        countsArr = countsSnap.data().items
      }

      // ── Legacy snapshot fallback ──────────────────────────────────────
      // Weeks counted before the per-week counts refactor have no counts doc;
      // their data lives in the old snapshot at
      // locations/{loc}/inventory/{periodKey}. If neither the per-item
      // subcollection nor the legacy array has data, fall back to that snapshot
      // so previously-counted weeks still display.
      if (!countsArr.length) {
        try {
          const legacySnap = await getDoc(doc(db, 'tenants', orgId, 'locations', locId, 'inventory', periodKey))
          if (legacySnap.exists() && Array.isArray(legacySnap.data().items)) {
            countsArr = legacySnap.data().items
          }
        } catch (e) {
          console.warn('Legacy snapshot fallback failed:', e)
        }
      }

      if (countsArr.length) {
        // Build the id→count map preferring NEW-style docs (those carrying an
        // `itemId` field) over any legacy orphan for the same item. A location
        // that successfully wrote docs during buggy Phase 1 has old-style docs
        // keyed by String(id); after the doc-id fix its re-saves add new-style
        // docs (keyed id_<enc>) for the same item — the new one is authoritative.
        const byId = new Map()
        for (const c of countsArr) {
          const key = String(c.id)
          if (!byId.has(key) || c.itemId != null) byId.set(key, c)
        }
        hydratedItems = hydratedItems.map(row => {
          const c = byId.get(String(row.id))
          if (!c) return row
          return {
            ...row,
            qty: c.qty ?? null,
            eaches: c.eaches ?? 0,
            // Per-zone detail (Phase 2). Only attached when the stored doc
            // actually carries zones — a legacy doc must stay zone-free so
            // hasBucketData() keeps reading it as the flat record it is.
            ...(c.zones && Object.keys(c.zones).length ? { zones: c.zones, _storedTotal: c.eaches ?? null } : {}),
            // A PAST period is read with the membership it was counted with
            // (stored on the doc), so a category added since can't turn last
            // week's split item incomplete. The current period uses the live
            // item.countCategories (adding a category mid-period → incomplete
            // until that sheet is counted, by design).
            ...(liveSync ? {} : { _bucketCats: Array.isArray(c.countCategories) ? c.countCategories : [] }),
            lastCountedAt: c.countedAt ?? row.lastCountedAt ?? null,
            lastCountedBy: c.countedBy ?? row.lastCountedBy ?? null,
          }
        })
      }

      // ── Dedupe by id ──────────────────────────────────────────────────
      // Custom items stored in a location-specific catalog are picked up twice:
      // once in inventoryItems (catalog branch maps all location docs) and again
      // in customItems (data.custom === true). Same id, two entries. The save and
      // snapshot key documents by id, so duplicates collapse to one document —
      // quantities on the dropped entry are omitted while closingValue (summed
      // over the full array) still looks correct. Collapse duplicates here,
      // preferring the entry that actually has a count.
      const _seen = new Map()
      for (const it of hydratedItems) {
        const key = String(it.id)
        const existing = _seen.get(key)
        if (!existing) { _seen.set(key, it); continue }
        if (existing.qty == null && it.qty != null) _seen.set(key, it)
        else if (existing.qty != null && it.qty != null) _seen.set(key, it)
      }
      const dedupedItems = Array.from(_seen.values())
      if (dedupedItems.length !== hydratedItems.length) {
        console.warn('[DEDUPE] collapsed', hydratedItems.length - dedupedItems.length,
                     'duplicate item id(s) on load')
      }
      setItems(dedupedItems)

      // Load prior period items for the Prior column (variance + copyPrior reference).
      // WALK-BACK: the immediately-prior period may have been skipped (a 1-day stub week the
      // team skipped for a month-close), so reuse resolveOpeningWindow — the SAME helper the
      // shrinkage OPENING uses — to reach back (cap 5) to the most recent period that actually
      // has a count. Display-only: the reference may be older than last week, and we surface
      // which period it came from (setPriorFromPeriod) so the counter knows. Best-effort.
      try {
        const WALK_CAP = 5
        const priorCandidates = []
        { let cur = periodKey; for (let i = 0; i < WALK_CAP; i++) { const p = getPriorKey(cur); if (!p) break; priorCandidates.push(p); cur = p } }
        // Pre-read each candidate's per-item counts subcollection (the canonical count store);
        // hasCount = non-empty. Bounded reads, only walked when the immediate prior is empty.
        const candSnaps = await Promise.all(priorCandidates.map((pk) =>
          getDocs(collection(db, 'tenants', orgId, 'inventory', locId, 'counts', pk, 'items')).catch(() => null)))
        const snapItems = (pk) => { const i = priorCandidates.indexOf(pk); const s = i >= 0 ? candSnaps[i] : null; return (s && !s.empty) ? s.docs.map(d => { const x = d.data(); return { ...x, id: x.itemId ?? d.id } }) : null }
        const hasCount = (pk) => !!snapItems(pk)
        const { openingPeriod } = resolveOpeningWindow(periodKey, hasCount, WALK_CAP)

        let priorArr = []
        if (openingPeriod) {
          priorArr = snapItems(openingPeriod) || []
        } else if (priorKey) {
          // No per-item counts within the cap — preserve the legacy fallback on the IMMEDIATE
          // prior (older pre-refactor periods stored counts as an array / Path B snapshot).
          const priorCounts = await getDoc(doc(db, 'tenants', orgId, 'inventory', locId, 'counts', priorKey))
          if (priorCounts.exists() && Array.isArray(priorCounts.data().items) && priorCounts.data().items.length) {
            priorArr = priorCounts.data().items
          } else {
            const priorSnap = await getDoc(doc(db, 'tenants', orgId, 'locations', locId, 'inventory', priorKey))
            if (priorSnap.exists() && Array.isArray(priorSnap.data().items)) priorArr = priorSnap.data().items
          }
        }
        setPriorItems(priorArr)
        // Label only when Prior came from FURTHER back than the immediate prior.
        setPriorFromPeriod(openingPeriod && openingPeriod !== priorKey ? openingPeriod : null)
      } catch (e) {
        console.warn('Failed to load prior period items:', e)
        setPriorItems([])
        setPriorFromPeriod(null)
      }

      if (priorPnlSnap?.exists()) {
        setOpeningValue(priorPnlSnap.data().closingValue || 0)
      } else {
        setOpeningValue(0)
      }

      if (currentPnlSnap?.exists()) {
        setPurchases(currentPnlSnap.data().cogs_purchases || 0)
      } else {
        setPurchases(0)
      }

      // Category source precedence (Phase A — per-location storage):
      //   1. this location's own list (tenants/{org}/inventory/{loc}/settings/categories)
      //   2. else the org-wide list (the seed source) — IN MEMORY, no write here
      //   3. else the built-in defaults
      // Phase A writes nothing, so locCats is always null today → every location
      // resolves to (global || defaults) = exactly the prior behavior. The
      // per-location doc materializes only on first edit (Phase B).
      const locCats = locCatSnap?.exists() ? locCatSnap.data().categories : null
      const globalCats = settingsSnap?.exists() ? settingsSnap.data().categories : null
      if (Array.isArray(locCats) && locCats.length) {
        setCategories(locCats)
      } else if (Array.isArray(globalCats) && globalCats.length) {
        setCategories(globalCats)
      } else {
        setCategories(getDefaultCategories())
      }

      // Per-location zone resolution (Phase 0). Absent doc → single default
      // zone, so a never-configured location is unchanged. resolveZones is the
      // one gate that enforces "no zones doc == one implicit zone".
      setZones(resolveZones(locZonesSnap?.exists() ? locZonesSnap.data().zones : null))

      if (sessionSnap?.exists()) {
        setSession(sessionSnap.data())
      } else {
        const newSession = {
          startedAt: serverTimestamp(),
          startedBy: user?.email || 'unknown',
          startedByName: user?.name || user?.email || 'Unknown',
          status: 'in_progress',
          sectionsCompleted: [],
          counters: [{
            uid: user?.uid || 'unknown',
            name: user?.name || user?.email || 'Unknown',
            itemsCounted: 0,
            startedAt: new Date().toISOString()
          }]
        }
        setSession(newSession)
        // Best-effort, own try — the session doc is tracking metadata (who's counting,
        // when it started), not the count data itself. A write failure here (e.g. a
        // permission gap on a legacy role) must NEVER fail the whole page load: items/
        // openingValue/purchases/categories above already loaded successfully and must
        // still render. Same "isolate a non-critical write" pattern as the prior-period-
        // items walk-back above.
        try {
          await setDoc(
            doc(db, 'tenants', orgId, 'inventorySessions', `${locId}_${periodKey}`),
            newSession
          )
        } catch (e) {
          console.warn('Failed to create inventory session doc (non-blocking):', e)
        }
      }

      setDirty(false)
    } catch (err) {
      console.error('Failed to load inventory:', err)
      setError('Failed to load inventory data')
    } finally {
      setLoading(false)
    }
  }, [orgId, locationId, locId, periodKey, priorKey, liveSync])   // liveSync: past periods read frozen membership

  useEffect(() => {
    load()
  }, [load])

  // Tracks item ids the user has explicitly mutated in THIS session (any of
  // setQty/setEaches/adjust/adjustEaches/copyPrior/mergeDraft adds to it).
  // saveCounts and save use this set to distinguish:
  //   - "qty=null because the user never counted this item"  → preserve
  //     existing Firestore value (Tracy protection)
  //   - "qty=null because the user explicitly cleared it"    → delete from
  //     the counts doc (the W1 $61K-reappear fix)
  // Cleared per-save (only the just-persisted ids) and on context change.
  const touchedItemsRef = useRef(new Set())
  // Per-item ZONE keys this device has edited and not yet persisted:
  // Map<itemId, Set<zoneKey>>. touchedItemsRef says WHICH items to write; this
  // says which of a zoned item's zones to write (buildZonePayload) and which
  // zones a remote snapshot must not overwrite (mergeRemoteBuckets). Cleared in
  // step with touchedItemsRef, once the persisted value is confirmed unchanged.
  const touchedZonesRef = useRef(new Map())

  // Phase 3 step 2: live-merge the OTHER counter's counts into local `items`.
  // Applied per snapshot delta from useCountsListener (current period only).
  // Invariants (see the guards below):
  //   • touchedItemsRef.has(id) → SKIP on EVERY change type — a remote change
  //     never touches an item the local user is editing this session.
  //   • Only qty / eaches / lastCountedAt / lastCountedBy are merged. _qtyRaw /
  //     _eachesRaw (the in-progress typing state) are NEVER touched — and can't
  //     be, since any typed item is in touchedItemsRef and thus skipped.
  //   • Never sets dirty and never adds to touchedItemsRef → cannot schedule the
  //     debounced autosave (no cross-counter autosave-echo loop). Display only;
  //     closingValue converges naturally because it derives from `items`.
  const handleRemoteCounts = useCallback(({ patches, removedIds }) => {
    const touched = touchedItemsRef.current
    const removed = new Set((removedIds || []).map(String))
    setItems(prev => prev.map(item => {
      const id = String(item.id)
      const p = patches && patches[id]
      if (!p && !removed.has(id)) return item
      // Per-item rule (legacy skip-if-touched; zoned per-zone merge) lives in
      // applyRemoteCountPatch. Untouched items also drop stale _qtyRaw/_eachesRaw
      // so the input's `_qtyRaw ?? qty` fallback shows the merged value.
      return applyRemoteCountPatch(item, removed.has(id) ? null : p, touched.has(id), touchedZonesRef.current.get(id))
    }))
  }, [])

  useCountsListener({ orgId, locId, periodKey, enabled: liveSync, onRemote: handleRemoteCounts })

  // Live session sync (current period only, same gate as the counts listener).
  // Swept zones / completed sections are shared state: a sweep on one device
  // changes completeness — and so totals — on every device. Without this each
  // device kept the session it loaded, so two devices could derive different
  // totals for the same item and each "correct" the other on save.
  // Merges over the local session so local-only fields are kept; snapshots of
  // this device's own pending writes carry the same values, so no flicker.
  useEffect(() => {
    if (!liveSync || !orgId || !locId || !periodKey) return undefined
    const unsub = onSnapshot(
      doc(db, 'tenants', orgId, 'inventorySessions', `${locId}_${periodKey}`),
      (snap) => {
        try {
          if (snap.exists()) setSession(prev => ({ ...(prev || {}), ...snap.data() }))
        } catch (e) {
          console.error('session listener: apply failed (ignored):', e)
        }
      },
      (err) => console.error('session listener: subscription error:', err)
    )
    return unsub
  }, [liveSync, orgId, locId, periodKey])

  // Reset the touched-items tracker when location/period changes — otherwise
  // a cleared id from W1 would carry into W2 and could falsely trigger a
  // deletion on a different period's save.
  useEffect(() => {
    touchedItemsRef.current = new Set()
    touchedZonesRef.current = new Map()
  }, [locationId, periodKey])

  const adjust = useCallback((itemId, delta) => {
    touchedItemsRef.current.add(String(itemId))
    setItems(prev => prev.map(item => {
      if (item.id !== itemId) return item
      const next = Math.max(0, parseFloat(((item.qty || 0) + delta).toFixed(2)))
      const attribution = buddyMode && buddyNames.caller && buddyNames.marker
        ? `${buddyNames.caller} + ${buddyNames.marker}`
        : (user?.email || 'unknown')
      return {
        ...item,
        qty: next,
        lastCountedAt: new Date().toISOString(),
        lastCountedBy: attribution,
        countedInBuddyMode: buddyMode,
      }
    }))
    setDirty(true)
  }, [user, buddyMode, buddyNames])

  const adjustEaches = useCallback((itemId, delta) => {
    touchedItemsRef.current.add(String(itemId))
    setItems(prev => prev.map(item => {
      if (item.id !== itemId) return item
      const next = Math.max(0, parseFloat(((item.eaches || 0) + delta).toFixed(2)))
      return { ...item, eaches: next, lastCountedAt: new Date().toISOString(), lastCountedBy: user?.email || 'unknown' }
    }))
    setDirty(true)
  }, [user])

  const setEaches = useCallback((itemId, value) => {
    touchedItemsRef.current.add(String(itemId))
    setItems(prev => prev.map(item => {
      if (item.id !== itemId) return item
      // Mirror setQty: preserve the raw typed string in _eachesRaw so the
      // controlled input doesn't wipe in-progress decimals ('1.' → 1 → display
      // shows '1' → next keystroke produces '10', not '1.0'). The number form
      // (eaches) drives math; the raw form drives display.
      const raw = value
      const eaches = value === '' ? 0 : Math.max(0, parseFloat(value) || 0)
      return { ...item, eaches, _eachesRaw: raw, lastCountedAt: new Date().toISOString(), lastCountedBy: user?.email || 'unknown' }
    }))
    setDirty(true)
  }, [user])

  const setQty = useCallback((itemId, value) => {
    touchedItemsRef.current.add(String(itemId))
    setItems(prev => prev.map(item => {
      if (item.id !== itemId) return item
      // Keep the raw typed string so in-progress decimals ('.', '0.', '.5')
      // are not wiped by parseFloat while the user is still typing.
      const raw = value
      const parsed = value === '' ? null : Math.max(0, parseFloat(value))
      const qty = (parsed === null || isNaN(parsed)) ? (value === '' ? null : 0) : parsed
      const attribution = buddyMode && buddyNames.caller && buddyNames.marker
        ? `${buddyNames.caller} + ${buddyNames.marker}`
        : (user?.email || 'unknown')
      return {
        ...item,
        qty,
        _qtyRaw: raw,
        lastCountedAt: new Date().toISOString(),
        lastCountedBy: attribution,
        countedInBuddyMode: buddyMode,
      }
    }))
    setDirty(true)
  }, [user, buddyMode, buddyNames])

  const copyPrior = useCallback((itemId) => {
    const priorItem = priorItems.find(p => p.id === itemId)
    if (priorItem?.qty != null) {
      setQty(itemId, priorItem.qty)
      if (priorItem.eaches != null) setEaches(itemId, priorItem.eaches)
    }
  }, [priorItems, setQty, setEaches])

  // Merge a draft of counts (from useAutosave's localStorage backstop) into
  // the currently-loaded items. Returns true if any items were updated.
  // Used by Inventory.jsx after load completes to restore counts the user
  // typed before navigating away.
  const itemsRef = useRef(items)
  useEffect(() => { itemsRef.current = items }, [items])

  // Zone config + swept list as refs, so the save path can read the CURRENT
  // values without widening the big saveCounts/save dependency arrays (the
  // same reason itemsRef and periodLockedRef exist). zonesCompleted lives on
  // the session doc, mirroring sectionsCompleted; Phase 3 wires the UI that
  // writes it — the write path only needs to READ it.
  const zonesRef = useRef(zones)
  useEffect(() => { zonesRef.current = zones }, [zones])
  // Every bucket marked done this session — swept zones AND completed category
  // sheets ('cat:' keys). The one list completeness reads (completedBuckets).
  const bucketsDoneRef = useRef([])
  useEffect(() => { bucketsDoneRef.current = completedBuckets(session) }, [session])

  const mergeDraft = useCallback((draftItems) => {
    if (!Array.isArray(draftItems) || draftItems.length === 0) return false
    const current = itemsRef.current
    if (!Array.isArray(current) || current.length === 0) return false

    const byId = new Map(current.map(i => [String(i.id), i]))
    let changed = 0
    draftItems.forEach(d => {
      const id = String(d.id)
      const existing = byId.get(id)
      if (existing) {
        // The draft represents user edits from a prior session that may not
        // have made it to Firestore. Treat each restored id as "touched" so a
        // subsequent save can also persist a clear via the deletion path.
        touchedItemsRef.current.add(id)
        byId.set(id, {
          ...existing,
          qty: d.qty,
          eaches: d.eaches ?? 0,
          lastCountedAt: d.lastCountedAt || existing.lastCountedAt || null,
          lastCountedBy: d.lastCountedBy || existing.lastCountedBy || null,
        })
        changed++
      }
    })

    if (changed === 0) return false
    setItems(Array.from(byId.values()))
    setDirty(true)
    return true
  }, [])

  // Toggle whether an item is marked as "key" — surfaces in Quick count mode.
  // Persists immediately so the flag survives a reload even if the user
  // hasn't clicked Save yet.
  const toggleKey = useCallback(async (itemId) => {
    const target = items.find(i => i.id === itemId)
    if (!target) return
    const nextValue = !target.isKey
    // Optimistic local update
    setItems(prev => prev.map(i => i.id === itemId ? { ...i, isKey: nextValue } : i))
    // Persist immediately to the per-item override doc
    try {
      await setDoc(
        doc(db, 'tenants', orgId, 'inventory', locId, 'items', itemId),
        { isKey: nextValue, updatedAt: serverTimestamp() },
        { merge: true }
      )
    } catch (e) {
      console.error('Failed to toggle isKey:', e)
      // Revert on failure
      setItems(prev => prev.map(i => i.id === itemId ? { ...i, isKey: !nextValue } : i))
    }
  }, [items, orgId, locId])

  // Targeted local patch (Stage 2b shelf-order sync). `patches` is a map of
  // itemId -> partial-fields object; merges each into ONLY that item, leaving
  // qty/eaches/counts and every other field intact. Lets the caller reflect a
  // persisted shelf-order reorder in memory WITHOUT a reload — load() would
  // rebuild items blank and wipe unsaved counts. Pure local state; the caller
  // owns the Firestore write and should call this only after it succeeds.
  const patchItemFields = useCallback((patches) => {
    if (!patches || !Object.keys(patches).length) return
    setItems(prev => applyItemPatches(prev, patches))
  }, [])

  // Bulk-apply file-uploaded counts to local items, then mark them touched so the
  // NEXT save() persists exactly these items via the audited touched-scoped
  // persistCountItems path (no new write logic). countsById = { [id]: {qty,eaches} }.
  // Sets attribution to the uploader + a countedViaUpload marker for audit.
  // Clears _qtyRaw/_eachesRaw (to null) so the input reflects the uploaded value,
  // never a stale typed string (same guard as the live-merge fix). Caller awaits
  // save() itself.
  const applyUploadedCounts = useCallback((countsById, uploaderEmail) => {
    if (!countsById || !Object.keys(countsById).length) return
    const at = new Date().toISOString()
    const by = uploaderEmail || user?.email || 'unknown'
    const applied = new Set()
    setItems(prev => prev.map(item => {
      const c = countsById[String(item.id)]
      if (!c) return item
      // Never write an uploaded single total onto an item counted per bucket
      // (split across category sheets, or holding zone entries): there is no
      // honest way to say which sheet the number belongs to. The preview
      // rejects these with a message (uploadRejectReason); this is the backstop.
      if (uploadRejectReason(item)) return item
      applied.add(String(item.id))
      return {
        ...item,
        qty: c.qty ?? null,
        eaches: c.eaches ?? 0,
        lastCountedAt: at,
        lastCountedBy: by,
        countedViaUpload: true,
        _qtyRaw: null,
        _eachesRaw: null,
      }
    }))
    Object.keys(countsById).forEach(id => {
      const it = itemsRef.current.find(i => String(i.id) === String(id))
      if (it && !uploadRejectReason(it)) touchedItemsRef.current.add(String(id))
    })
    setDirty(true)
  }, [user])

  // Replace the in-memory category list after the inline per-location editor
  // writes the per-location categories doc. Lets KPI bubbles + grouping reflect
  // add/reorder/recolor/rename immediately WITHOUT a reload — load() would
  // rebuild items blank and wipe unsaved counts. Caller owns the Firestore write
  // and calls this only on success. Same pattern as patchItemFields.
  const setCategoriesLocal = useCallback((arr) => {
    if (Array.isArray(arr)) setCategories(arr)
  }, [])

  // Replace the in-memory zone list after the ZoneManagerModal writes the
  // per-location zones doc. Same no-reload pattern as setCategoriesLocal.
  const setZonesLocal = useCallback((arr) => {
    if (Array.isArray(arr)) setZones(arr)
  }, [])

  // Apply a membership change to ONE local item: re-shape its in-progress
  // counts (rebucketForMembership — never drops a count) and mark what the
  // save must write. Returns the countCategories to store.
  const applyMembership = (item, nextKeys, homeKey) => {
    const r = rebucketForMembership(item, nextKeys, homeKey)
    setItems(prev => prev.map(i => {
      if (String(i.id) !== String(item.id)) return i
      const merged = { ...i, ...r.patch }
      if ('zones' in r.patch && r.patch.zones === undefined) delete merged.zones
      return merged
    }))
    if (r.changedCounts) {
      const id = String(item.id)
      touchedItemsRef.current.add(id)
      if (r.dirtyKeys.length) {
        const zk = touchedZonesRef.current.get(id) || new Set()
        r.dirtyKeys.forEach(k => zk.add(k))
        touchedZonesRef.current.set(id, zk)
      }
      setDirty(true)
    }
    return r.countCategories
  }

  /**
   * Set which category sheets an item is counted on (edit-panel multi-select).
   * Stores category KEYS on the per-location item doc; 0/1 → a normal item.
   * Its in-progress counts are re-shaped by rebucketForMembership: a flat count
   * moves into the home sheet; a removed sheet merges into home; going back to
   * one category folds the sheets into one count.
   */
  const setItemCountCategories = useCallback(async (itemId, nextKeys) => {
    if (blockedByLock()) return
    const item = itemsRef.current.find(i => String(i.id) === String(itemId))
    if (!item) return
    const homeKey = assignCategory(item, categories)
    const stored = applyMembership(item, nextKeys, homeKey)
    await setDoc(doc(db, 'tenants', orgId, 'inventory', locId, 'items', String(itemId)),
      { countCategories: stored }, { merge: true })
  }, [categories, orgId, locId, blockedByLock])

  /**
   * Categories were deleted at this location: drop them from every item's
   * membership, MERGING any count on a deleted sheet into the item's home
   * sheet (never blocking, never dropping). `fallbackHomeKey` is the home for
   * items whose home category was itself deleted (the manager re-tags those
   * to General). Item docs are updated in batches.
   */
  const removeCategoriesFromItems = useCallback(async (removedKeys, fallbackHomeKey = 'general') => {
    const removed = new Set(removedKeys || [])
    if (!removed.size) return 0
    const affected = itemsRef.current.filter(i => Array.isArray(i.countCategories) && i.countCategories.some(k => removed.has(k)))
    const writes = []
    for (const item of affected) {
      let homeKey = assignCategory(item, categories)
      if (removed.has(homeKey) || !categories.some(c => c.key === homeKey)) homeKey = fallbackHomeKey
      const next = item.countCategories.filter(k => !removed.has(k))
      const stored = applyMembership(item, next.includes(homeKey) ? next : [homeKey, ...next], homeKey)
      writes.push([String(item.id), stored])
    }
    for (let k = 0; k < writes.length; k += 450) {
      const batch = writeBatch(db)
      for (const [id, stored] of writes.slice(k, k + 450)) {
        batch.set(doc(db, 'tenants', orgId, 'inventory', locId, 'items', id), { countCategories: stored }, { merge: true })
      }
      await batch.commit()
    }
    return affected.length
  }, [categories, orgId, locId])

  // Hide an item from this location. For master items this sets removed: true
  // on the override doc. For custom items it also sets removed: true (we don't
  // hard-delete, so it can be restored).
  const removeItem = useCallback(async (itemId) => {
    const target = items.find(i => i.id === itemId)
    if (!target) return
    // Optimistic: remove from local state immediately
    setItems(prev => prev.filter(i => i.id !== itemId))
    try {
      await setDoc(
        doc(db, 'tenants', orgId, 'inventory', locId, 'items', itemId),
        {
          removed:   true,
          removedAt: serverTimestamp(),
          removedBy: user?.email || 'unknown',
          // Persist name + vendor for ALL items (master too, not just custom) so
          // the removed-items list is self-describing — no catalog join needed to
          // show what was removed. (VF #3.)
          name:      target.name ?? null,
          vendor:    target.vendor ?? null,
          // For custom items, also preserve the pricing/data fields so we can restore.
          ...(target.custom ? {
            custom:   true,
            unitCost: target.unitCost,
            packSize: target.packSize,
          } : {}),
        },
        { merge: true }
      )
    } catch (e) {
      console.error('Failed to remove item:', e)
      setItems(prev => [...prev, target])  // revert
    }
  }, [items, orgId, locId, user])

  // Restore a previously removed item.
  const restoreItem = useCallback(async (itemId) => {
    if (blockedByLock()) return
    try {
      // Persist in-progress counts before the reload below, so restoring an
      // item mid-count never wipes unsaved counts. Per-item docs (Phase 1) —
      // must write the subcollection, since the dual-read prefers it and would
      // ignore a legacy array write here. Use hasCount so eaches-only persist.
      const preserveCounts = items
        // Touched-scope (Phase 3 step 3): preserve only THIS session's unsaved
        // edits. Remote-merged / already-saved items are in the subcollection
        // and survive the load() — re-writing them here would clobber the other
        // counter's attribution.
        .filter(i => touchedItemsRef.current.has(String(i.id)) && hasCount(i))
        // The shared row builder — a hand-built row here wiped zoned docs.
        .map(i => buildCountWrite(i, zonesRef.current, bucketsDoneRef.current, touchedZonesRef.current.get(String(i.id))))
      if (preserveCounts.length) {
        const itemsCol = collection(db, 'tenants', orgId, 'inventory', locId, 'counts', periodKey, 'items')
        await persistCountItems(itemsCol, preserveCounts, [], user?.email, locationId)
      }
      await setDoc(
        doc(db, 'tenants', orgId, 'inventory', locId, 'items', itemId),
        {
          removed:    false,
          restoredAt: serverTimestamp(),
          restoredBy: user?.email || 'unknown',
        },
        { merge: true }
      )
      await load()
    } catch (e) {
      console.error('Failed to restore item:', e)
    }
  }, [items, orgId, locId, periodKey, user, load])

  // Add a custom item that exists only at this location.
  const addCustomItem = useCallback(async (data) => {
    if (!data.name) return
    if (blockedByLock()) return
    const customId = `custom_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
    const newItem = {
      name:     data.name,
      unitCost: parseFloat(data.unitCost) || 0,
      packSize: data.packSize || null,
      qtyPerPack: parseFloat(data.qtyPerPack) || 1,
      // Path (a): if user enters unitCost + qtyPerPack but no packPrice,
      // derive packPrice = unitCost × qtyPerPack so the case valuation is
      // correct (not just one unit at unit cost — which would undercount
      // by qtyPerPack times).
      packPrice: parseFloat(data.packPrice) || ((parseFloat(data.unitCost) || 0) * (parseFloat(data.qtyPerPack) || 1)),
      vendor:   data.vendor || null,
      glCode:   (data.glCode || '').trim() || null,
      category: data.category || null,
      custom:   true,
      removed:  false,
      createdAt: serverTimestamp(),
      createdBy: user?.email || 'unknown',
    }
    try {
      await setDoc(
        doc(db, 'tenants', orgId, 'inventory', locId, 'items', customId),
        newItem
      )
      // Persist any in-progress counts BEFORE the optimistic insert, so adding
      // an item can never discard unsaved counts (a reload would otherwise
      // rebuild items blank and wipe them). Per-item docs (Phase 1) — must write
      // the subcollection, which the dual-read prefers. hasCount → eaches-only persist.
      try {
        const preserveCounts = items
          // Touched-scope (Phase 3 step 3): only THIS session's unsaved edits;
          // remote/already-saved items survive the reload from the subcollection.
          .filter(i => touchedItemsRef.current.has(String(i.id)) && hasCount(i))
          // The shared row builder — a hand-built row here wiped zoned docs.
          .map(i => buildCountWrite(i, zonesRef.current, bucketsDoneRef.current, touchedZonesRef.current.get(String(i.id))))
        if (preserveCounts.length) {
          const itemsCol = collection(db, 'tenants', orgId, 'inventory', locId, 'counts', periodKey, 'items')
          await persistCountItems(itemsCol, preserveCounts, [], user?.email, locationId)
        }
      } catch (persistErr) {
        console.error('Failed to persist counts before adding item:', persistErr)
      }

      // Optimistic local insert (preserves all current in-progress counts)
      setItems(prev => [...prev, {
        id: customId,
        ...newItem,
        qty: null,
        eaches: 0,
        isKey: false,
      }])
    } catch (e) {
      console.error('Failed to add custom item:', e)
    }
  }, [orgId, locId, periodKey, items, user])

  // List of removed items for the manage drawer. We need to query the
  // override collection separately because removed items are filtered out
  // of the main items list during load.
  const [removedItems, setRemovedItems] = useState([])

  // GL code catalog (VF #4) — read settings/glCodes ONCE per hook mount and cache
  // (not per panel-open). Stays null on missing/unreadable so the GL dropdowns
  // fail-open to free text. Seeded shape: { codes: [{code,label,restricted,inventoryItem}] }.
  const [glCodes, setGlCodes] = useState(null)
  useEffect(() => {
    if (!orgId) return
    let cancelled = false
    ;(async () => {
      try {
        const snap = await getDoc(doc(db, 'tenants', orgId, 'settings', 'glCodes'))
        if (!cancelled) setGlCodes(snap.exists() && Array.isArray(snap.data().codes) ? snap.data().codes : null)
      } catch (e) {
        if (!cancelled) { console.warn('glCodes load failed — GL fields fall back to free text:', e); setGlCodes(null) }
      }
    })()
    return () => { cancelled = true }
  }, [orgId])
  const loadRemovedItems = useCallback(async () => {
    if (!orgId || !locId) return
    try {
      const snap = await getDocs(collection(db, 'tenants', orgId, 'inventory', locId, 'items'))
      const rawRemoved = []
      snap.forEach(d => {
        if (d.data().removed) rawRemoved.push({ id: d.id, data: d.data() })
      })

      // Retroactive name resolution (VF #3): docs removed BEFORE name-on-removal
      // shipped carry no name. Resolve those from the master catalog by id — but
      // ONLY fetch the catalog when there's a nameless doc to resolve, so the
      // common case (all docs self-describing via part 1) skips the read entirely.
      let catalogById = null
      if (rawRemoved.some(r => !r.data.name)) {
        const catSnap = await getDocs(collection(db, 'tenants', orgId, 'inventoryCatalog'))
        catalogById = new Map()
        catSnap.forEach(c => {
          const cd = c.data() || {}
          catalogById.set(c.id, { name: cd.name, vendor: cd.vendor })
          if (cd.id != null) catalogById.set(String(cd.id), { name: cd.name, vendor: cd.vendor })
        })
      }

      const removed = rawRemoved.map(({ id, data }) => {
        const cat = catalogById ? catalogById.get(id) : null
        return {
          id,
          // doc name → catalog name → fallback. `Master item ${id}` remains ONLY
          // for docs missing from BOTH the override and the catalog (orphaned).
          name:      data.name || (cat && cat.name) || (data.custom ? 'Untitled custom item' : `Master item ${id}`),
          vendor:    data.vendor || (cat && cat.vendor) || null,
          custom:    data.custom || false,
          removedAt: data.removedAt || null,
        }
      })
      setRemovedItems(removed)
    } catch (e) {
      console.error('Failed to load removed items:', e)
    }
  }, [orgId, locId])

  /**
   * Mark a BUCKET done, or undo it — the one path behind both "zone swept"
   * (markZoneSwept) and "category sheet complete" (markSectionComplete).
   * Done means "I covered this bucket; anything I didn't enter isn't there":
   * a blank in a done bucket counts as a real 0 instead of leaving the item
   * incomplete. Undo is a legitimate correction and sends affected items back
   * to incomplete.
   *
   * Session write: an atomic arrayUnion/arrayRemove of ONE key on `field`
   * (zonesCompleted | sectionsCompleted) — never the whole local session, which
   * would un-mark a bucket another device marked meanwhile.
   *
   * Persistence: marking changes affected items' totals without touching
   * them, so after the session write the stored totals are re-persisted
   * (sweepTotalUpdates → persistDerivedTotals; top-level only). Without that the
   * server-side valuation keeps pricing them from the stale total. Then
   * setDirty so autosave refreshes the live closingValue.
   */
  const markBucketDone = useCallback(async ({ field, key, bucketKey, done }) => {
    if (!session || !key) return
    if (blockedByLock()) return   // period closed — this changes stored totals
    const current = session[field] || []
    const next = done
      ? (current.includes(key) ? current : [...current, key])
      : current.filter(k => k !== key)
    if (next.length === current.length) return   // no change — already in that state
    const prevSession = session
    const updatedSession = { ...session, [field]: next }
    setSession(updatedSession)
    // Synchronous, not via the [session] effect: a save fired before the next
    // render (Save & Close straight after) must value with the NEW state.
    const prevDone = bucketsDoneRef.current
    const nextDone = completedBuckets(updatedSession)
    bucketsDoneRef.current = nextDone
    try {
      await setDoc(
        doc(db, 'tenants', orgId, 'inventorySessions', `${locId}_${periodKey}`),
        { [field]: done ? arrayUnion(key) : arrayRemove(key) },
        { merge: true }
      )
    } catch (err) {
      // Roll back rather than persist totals for a mark the session doc
      // doesn't record — on reload the two would disagree.
      console.error('Failed to update ' + field + ':', err)
      setSession(prevSession)
      bucketsDoneRef.current = prevDone
      toast.error('Could not save that — please try again.')
      return
    }
    const updates = sweepTotalUpdates(itemsRef.current, bucketKey, zonesRef.current, nextDone)
    if (updates.length) {
      const itemsCol = collection(db, 'tenants', orgId, 'inventory', locId, 'counts', periodKey, 'items')
      const { failed, writtenIds } = await persistDerivedTotals(itemsCol, updates, user?.email)
      if (failed) toast.error(`${failed} item total${failed === 1 ? '' : 's'} did not update — save again before closing.`)
      const landed = new Map(updates.filter(u => writtenIds.includes(String(u.id))).map(u => [String(u.id), u.eaches ?? null]))
      if (landed.size) setItems(prev => prev.map(i => landed.has(String(i.id)) ? { ...i, _storedTotal: landed.get(String(i.id)) } : i))
    }
    setDirty(true)
  }, [session, orgId, locId, periodKey, blockedByLock, user, toast])

  /**
   * Category SHEET complete (or undo). The bucket is 'cat:<key>': a blank on a
   * completed sheet counts as 0 for split items on that sheet. Unsplit items
   * are unaffected — their count is their single flat entry. (sectionsCompleted
   * also drives the "N/M sections" session counter, as before.)
   */
  const markSectionComplete = useCallback((sectionKey, done = true) =>
    markBucketDone({ field: 'sectionsCompleted', key: sectionKey, bucketKey: catBucketKey(sectionKey), done }),
  [markBucketDone])

  /** Storage zone swept (or undo) — see markBucketDone. */
  const markZoneSwept = useCallback((zoneKey, swept = true) =>
    markBucketDone({ field: 'zonesCompleted', key: zoneKey, bucketKey: zoneKey, done: swept }),
  [markBucketDone])

  /**
   * Per-zone count entry (Phase 4 inputs). Mirrors setQty/setEaches but writes
   * into item.zones[zoneKey] instead of the top-level, because for a zoned item
   * the top-level is the DERIVED total and must never be typed into directly.
   *
   * `field` is 'qty' or 'eaches'. The raw typed string is preserved per zone
   * (_raw) for the same reason setQty keeps _qtyRaw: parseFloat would eat an
   * in-progress '.', '0.' or '.5' while the user is still typing — the exact
   * bug that produced the 100x eaches corruption.
   */
  const setZoneValue = useCallback((itemId, zoneKey, field, value) => {
    if (!zoneKey || (field !== 'qty' && field !== 'eaches')) return
    touchedItemsRef.current.add(String(itemId))
    {
      const zk = touchedZonesRef.current.get(String(itemId)) || new Set()
      zk.add(zoneKey)
      touchedZonesRef.current.set(String(itemId), zk)
    }
    setItems(prev => prev.map(item => {
      if (item.id !== itemId) return item
      const parsed = value === '' ? null : Math.max(0, parseFloat(value))
      const clean = (parsed === null || isNaN(parsed)) ? (value === '' ? null : 0) : parsed
      const attribution = buddyMode && buddyNames.caller && buddyNames.marker
        ? `${buddyNames.caller} + ${buddyNames.marker}`
        : (user?.email || 'unknown')
      const prevZone = item.zones?.[zoneKey] || {}
      return {
        ...item,
        zones: { ...(item.zones || {}), [zoneKey]: { ...prevZone, [field]: clean, [`_${field}Raw`]: value } },
        lastCountedAt: new Date().toISOString(),
        lastCountedBy: attribution,
        countedInBuddyMode: buddyMode,
      }
    }))
    setDirty(true)
  }, [user, buddyMode, buddyNames])

  // Lightweight autosave: persist counts (qty/eaches) to the per-week counts
  // doc and refresh the live PnL closingValue, WITHOUT marking the session
  // completed or closing the period. Safe to call repeatedly (debounced).
  // Multi-device convergence, run after every successful count write: rewrite
  // (top-level only) any zoned item's stored total that no longer matches the
  // derived total — see staleDerivedTotals — then record what is now stored on
  // the written + reconciled items. Best-effort: a failure here is logged and
  // never fails the save; the next save retries, because _storedTotal is only
  // advanced for writes that actually landed.
  const reconcileStoredTotals = async (colRef, sourceItems, writtenRows) => {
    try {
      const written = new Set((writtenRows || []).map(c => String(c.id)))
      const stale = staleDerivedTotals(sourceItems, zonesRef.current, bucketsDoneRef.current, written)
      const { writtenIds } = stale.length
        ? await persistDerivedTotals(colRef, stale, user?.email)
        : { writtenIds: [] }
      const nowStored = new Map()
      for (const c of writtenRows || []) if (hasBucketData(c)) nowStored.set(String(c.id), c.eaches ?? null)
      const landed = new Set(writtenIds)
      for (const u of stale) if (landed.has(String(u.id))) nowStored.set(String(u.id), u.eaches ?? null)
      if (nowStored.size) {
        setItems(prev => prev.map(i => nowStored.has(String(i.id)) ? { ...i, _storedTotal: nowStored.get(String(i.id)) } : i))
      }
    } catch (e) {
      console.error('Stored-total reconcile failed (non-blocking):', e)
    }
  }

  const saveCounts = useCallback(async (opts = {}) => {
    if (!locationId || !periodKey) return false
    if (blockedByLock()) return false   // period closed — no count writes
    // sourceItems lets rollOverFromPrior pass the just-computed rolled-forward array
    // directly, rather than the (still-stale, pre-render) `items` closure — setItems()
    // is async, so a caller that setItems()s then immediately calls saveCounts() would
    // otherwise persist the OLD items. Normal callers omit itemsOverride and get `items`.
    const sourceItems = opts.itemsOverride || items
    // Guard: if items haven't loaded yet (transition / reload), do NOT write —
    // saving an empty/partial set here would clobber real counts.
    if (!Array.isArray(sourceItems) || sourceItems.length === 0) return false
    try {
      const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0 }
      // Include any item with EITHER qty OR positive eaches — see hasCount.
      // Pre-fix this filtered on qty != null alone, so eaches-only entries
      // never landed on the counts doc even though they contributed to
      // closingValue (W1 $3.83 divergence, 2026-06-18).
      const newCounts = sourceItems
        // Touched-scope (Phase 3 step 3): persist ONLY items the local user
        // touched this session — never re-write another counter's merged items
        // under our attribution. closingValue (below) stays FULL-set.
        .filter(i => touchedItemsRef.current.has(String(i.id)) && hasCount(i))
        // ZONED rows write the derived total + only this device's edited zones —
        // see buildCountWrite. LEGACY rows are unchanged.
        .map(i => buildCountWrite(i, zonesRef.current, bucketsDoneRef.current, touchedZonesRef.current.get(String(i.id))))
      // Deletions: items the user explicitly cleared (no qty, no eaches) AND
      // touched in this session. Excluding hasCount items here is critical —
      // an item with qty=null and eaches=1.08 must NOT be deleted just
      // because qty is null; the eaches counts as a real count.
      // Snapshot the set first so items touched DURING the async writes remain
      // pending for the next save.
      const touchedSnapshot = new Set(touchedItemsRef.current)
      const deletions = sourceItems
        .filter(i => !hasCount(i) && touchedSnapshot.has(String(i.id)))
        .map(i => String(i.id))
      // Per-item count docs (Phase 1) — one doc per touched item, cleared items
      // deleted. Concurrency-safe: two devices write different item docs and
      // can't clobber. In its OWN try so a counts-write failure can NEVER skip
      // the closingValue/P&L write below — COGS is computed from local `items`
      // and must persist regardless (the Phase-1 COGS=0 regression).
      const itemsCol = collection(db, 'tenants', orgId, 'inventory', locId, 'counts', periodKey, 'items')
      // countsPersisted gates the touched-clear below: a FAILED write must leave
      // its ids (and dirty zone keys) touched so the next save retries them.
      // Clearing them anyway — the old behaviour — silently dropped the edit.
      let countsPersisted = true
      try {
        await persistCountItems(itemsCol, newCounts, deletions, user?.email, locationId)
      } catch (countErr) {
        countsPersisted = false
        console.error('Per-item count write failed (P&L still written from local items):', countErr)
        setError('Some counts failed to save; totals were still updated.')
      }
      if (countsPersisted) await reconcileStoredTotals(itemsCol, sourceItems, newCounts)
      const closingValue = sourceItems.reduce((sum, item) => {
        // Shared with itemsWithMeta._value — see itemValue(). Zone-aware:
        // an incomplete zoned item contributes 0, as an uncounted item does.
        return sum + itemValue(item, zonesRef.current, bucketsDoneRef.current)
      }, 0)
      // Refresh opening from prior week's CURRENT closingValue at write time.
      // The state var is a load-time snapshot and goes stale once the prior
      // week is re-saved. UI reads opening live and is unaffected; this
      // protects downstream consumers that read the stored field.
      let freshOpening = openingValue
      // Best-effort init from cached opening; overwritten by the authoritative prior read
      // below when priorKey is present. On a read error we keep this (a cached nonzero
      // opening implies a real prior close) rather than regressing a genuine delta to 0.
      let priorCountExists = (openingValue || 0) > 0
      if (priorKey) {
        try {
          const priorPnlSnap = await getDoc(doc(db, 'tenants', orgId, 'pnl', locId, 'periods', priorKey))
          // "Prior was actually COUNTED" = prior doc has a closingValue. A doc that exists
          // from purchasing/labor alone (no closingValue) is NOT a real prior close.
          const priorClosing = priorPnlSnap.exists() ? priorPnlSnap.data().closingValue : null
          priorCountExists = priorClosing != null
          freshOpening = priorCountExists ? (priorClosing || 0) : 0
          if (freshOpening !== openingValue) setOpeningValue(freshOpening)
        } catch (e) {
          console.warn('Failed to refresh opening from prior week at save; using cached value', e)
        }
      }
      // Option (a): cogs_inventory is the pure inventory DELTA (opening − closing), NOT
      // purchases-inclusive and NOT clamped — a genuine stock-up week (real prior close,
      // closing > opening) is legitimately negative and offsets that week's purchases at
      // aggregation (see computeFoodCogs in pnl.js). Purchases live solely in cogs_purchases.
      // FIRST-COUNT GUARD: with no real prior close, opening defaults to 0 and (0 − closing)
      // would be a spurious full-negative delta that wrongly cancels the week's real
      // purchases — store 0 instead (food COGS = purchases alone). Same condition the
      // opening value itself derives from.
      const cogs = priorCountExists ? (freshOpening - closingValue) : 0

      // valuationMode gate (cutover build 2) — read the per-location authority
      // flag at WRITE TIME (design: no listener needed for correctness). The
      // count docs above ALWAYS persisted (source of truth + CF trigger); only
      // the LIVE P&L + Path B writes below are skipped when the CF owns this
      // location. FAIL-SAFE: any read error, missing doc, or 'client' leaves
      // cfAuthoritative false → we write exactly as today. Only an explicit
      // authoritative === 'cf' hands the live writes off to the CF.
      let cfAuthoritative = false
      try {
        const modeSnap = await getDoc(doc(db, 'tenants', orgId, 'valuationMode', locId))
        cfAuthoritative = modeSnap.exists() && modeSnap.data().authoritative === 'cf'
      } catch (modeErr) {
        console.warn('valuationMode read failed — defaulting to client-authoritative (writing as today):', modeErr)
        cfAuthoritative = false
      }

      // rolledOverFrom: set ONLY on the rollover's own write (opts.rolledOverFrom is the
      // source period). Every OTHER call to saveCounts — autosave, a manual edit — omits
      // it, so this line always writes `null` and CLEARS a stale flag the moment the
      // manager touches anything post-rollover (point 4: editable, not a lock).
      const rolledOverFrom = opts.rolledOverFrom || null

      // LIVE P&L write — skipped when the CF is authoritative for this location.
      if (!cfAuthoritative) await setDoc(
        doc(db, 'tenants', orgId, 'pnl', locId, 'periods', periodKey),
        { closingValue, openingValue: freshOpening, cogs_inventory: cogs, inventoryCountedAt: serverTimestamp(), inventoryCountedBy: user?.email, rolledOverFrom },
        { merge: true }
      )

      // Path B snapshot — autosave now writes it too. Previously ONLY save()
      // did, so with users overwhelmingly autosaving, Path B was near-empty
      // fleet-wide, blinding WasteLog / the P&L Why panel AND removing the
      // divergence-audit signal that caught the eaches stranding. Full-set (all
      // counted items — a view snapshot, same reasoning as closingValue), and
      // filtered with hasCount so eaches-only items are INCLUDED (closes the
      // qty!=null TODO that dropped them; the 121-vs-282 Wesley gap). AFTER the
      // P&L write, in its OWN try — a Path B failure must never abort the counts
      // or P&L write above.
      const snapshotItems = sourceItems
        .filter(hasCount)
        .map(i => ({
          id: i.id,
          name: i.name,
          // Zone-aware top-level (the derived total for a zoned item — its
          // in-memory qty/eaches is not its count); legacy unchanged.
          ...pathBCount(i, zonesRef.current, bucketsDoneRef.current),
          qtyPerPack: i.qtyPerPack || 1,
          packPrice: i.packPrice || null,
          unitCost: i.unitCost || 0,
          category: i.category || null,   // was i._cat (only on itemsWithMeta) → always null
          vendor: i.vendor || null,
        }))
      // Path B write — also skipped when the CF owns this location (it rebuilds
      // Path B server-side). Own try so a Path B failure never aborts the save.
      // rolledOverFrom lands here too (not just the P&L doc) because ShrinkageTable reads
      // its closing feed from THIS doc — that's the flag it checks to withhold a phantom
      // shrinkage number for a stub week that was carried forward, not physically counted.
      if (!cfAuthoritative) try {
        await setDoc(
          doc(db, 'tenants', orgId, 'locations', locId, 'inventory', periodKey),
          {
            items:        snapshotItems,
            closingValue,
            period:       periodKey,
            locationName: locationId,
            updatedAt:    serverTimestamp(),
            updatedBy:    user?.email || 'unknown',
            rolledOverFrom,
          },
          { merge: true }
        )
      } catch (pathBErr) {
        console.error('Path B snapshot write failed in saveCounts (P&L already written):', pathBErr)
      }

      // Scope the touched-clear to ids whose CURRENT local value still matches
      // what we persisted. Ids re-typed during the await (or newly-counted after
      // a delete) stay touched so the next save persists them — fixes the
      // eaches-stranding race. itemsRef.current is the latest React-state items;
      // for an itemsOverride call itemsRef hasn't caught up to the just-setItems()
      // value yet (state update is still in-flight), so fall back to sourceItems.
      const cleared = countsPersisted
        ? touchedIdsToClear(touchedSnapshot, newCounts, opts.itemsOverride || itemsRef.current)
        : new Set()
      cleared.forEach(id => { touchedItemsRef.current.delete(id); touchedZonesRef.current.delete(id) })
      // Root-cause fix for stale-raw (#7): drop _qtyRaw/_eachesRaw (to null, not
      // '') on the just-cleared ids so a later remote merge shows the merged qty,
      // not a sticky old typed string. Only the CLEARED ids — items kept touched
      // may be mid-typing, so their raw display is preserved.
      setItems(prev => prev.map(i =>
        cleared.has(String(i.id)) ? { ...i, _qtyRaw: null, _eachesRaw: null } : i
      ))
      setDirty(false)
      return true
    } catch (err) {
      console.error('Autosave (counts) failed:', err)
      setError('Count save failed: ' + (err?.message || 'unknown error'))
      return false
    }
  }, [items, locationId, locId, periodKey, orgId, openingValue, purchases, user])

  // Short-week rollover: carry the prior period's counts forward as THIS (stub) week's
  // count doc, so a 1-day week the team skipped doesn't leave the next full week's
  // opening dangling (see resolveOpeningWindow's walk-back — this makes the walk-back
  // unnecessary in the common case, kept as a safety net for weeks nobody rolls over).
  // Writes a NORMAL editable count doc (any line can still be overwritten by a real
  // count) carrying rolledOverFrom so ShrinkageTable knows this closing isn't a physical
  // count and withholds a computed shrinkage number for it (point 6 — see saveCounts).
  const rollOverFromPrior = useCallback(async () => {
    if (blockedByLock()) return false
    if (!Array.isArray(priorItems) || priorItems.length === 0) {
      toast.error('No prior period count to roll over')
      return false
    }
    const sourcePeriod = priorFromPeriod || priorKey
    if (!sourcePeriod) {
      toast.error('No prior period to roll over from')
      return false
    }
    const rolledItems = applyRollover(items, priorItems, { at: new Date().toISOString(), by: user?.email })
    rolledItems.forEach(i => { if (hasCount(i)) touchedItemsRef.current.add(String(i.id)) })
    setItems(rolledItems)
    setDirty(true)
    const ok = await saveCounts({ itemsOverride: rolledItems, rolledOverFrom: sourcePeriod })
    if (ok) toast.success(`Rolled over counts from ${sourcePeriod}`)
    return ok
  }, [items, priorItems, priorFromPeriod, priorKey, user, saveCounts, blockedByLock, toast])

  const save = useCallback(async () => {
    if (!locationId || !periodKey) return false
    if (blockedByLock()) return false   // period closed — no count writes

    setSaving(true)
    setError(null)

    try {
      // Item DEFINITION fields only (par/reorder/usage) go to the shared items
      // docs. COUNTS (qty/eaches) are NOT written here — they go to the
      // per-week counts doc below, so they stay period-scoped.
      // Write definition fields (par/reorder/usage) for every item that has
      // any of them set — NOT just counted items — so par levels on uncounted
      // items are never silently dropped.
      const batch = []
      for (const item of items) {
        if (item.parLevel != null || item.reorderPoint != null || item.avgDailyUsage != null) {
          batch.push(
            setDoc(
              doc(db, 'tenants', orgId, 'inventory', locId, 'items', item.id),
              {
                parLevel: item.parLevel ?? null,
                reorderPoint: item.reorderPoint ?? null,
                avgDailyUsage: item.avgDailyUsage ?? null,
                updatedAt: serverTimestamp(),
                updatedBy: user?.email
              },
              { merge: true }
            )
          )
        }
      }
      await Promise.all(batch)

      // ── Per-ITEM count docs (Phase 1) — canonical count store ─────────
      const num2 = (v) => { const x = Number(v); return Number.isFinite(x) ? x : 0 }
      // Same hasCount predicate as saveCounts — include eaches-only entries.
      const newCounts2 = items
        // Touched-scope (Phase 3 step 3): persist only this session's edits.
        // closingValue + the Path B snapshot below stay FULL-set.
        .filter(i => touchedItemsRef.current.has(String(i.id)) && hasCount(i))
        // Same row builder as saveCounts — see buildCountWrite.
        .map(i => buildCountWrite(i, zonesRef.current, bucketsDoneRef.current, touchedZonesRef.current.get(String(i.id))))
      // Deletions: only items with NEITHER qty NOR eaches that the user
      // touched. Same rationale as saveCounts.
      const touchedSnapshot2 = new Set(touchedItemsRef.current)
      const deletions2 = items
        .filter(i => !hasCount(i) && touchedSnapshot2.has(String(i.id)))
        .map(i => String(i.id))
      // One doc per touched item; cleared items deleted. In its OWN try so a
      // counts-write failure can NEVER skip the closingValue/P&L write below.
      const itemsCol2 = collection(db, 'tenants', orgId, 'inventory', locId, 'counts', periodKey, 'items')
      let countsPersisted2 = true   // see countsPersisted in saveCounts
      try {
        await persistCountItems(itemsCol2, newCounts2, deletions2, user?.email, locationId)
      } catch (countErr) {
        countsPersisted2 = false
        console.error('Per-item count write failed (P&L still written from local items):', countErr)
      }
      if (countsPersisted2) await reconcileStoredTotals(itemsCol2, items, newCounts2)

      const closingValue = items.reduce((sum, item) => {
        // Shared with itemsWithMeta._value — see itemValue(). Zone-aware:
        // an incomplete zoned item contributes 0, as an uncounted item does.
        return sum + itemValue(item, zonesRef.current, bucketsDoneRef.current)
      }, 0)

      // See saveCounts — refresh opening from prior week's CURRENT closingValue
      // so the stored field doesn't go stale relative to live reads.
      let freshOpening = openingValue
      // Best-effort init from cached opening; overwritten by the authoritative prior read
      // below when priorKey is present. On a read error we keep this (a cached nonzero
      // opening implies a real prior close) rather than regressing a genuine delta to 0.
      let priorCountExists = (openingValue || 0) > 0
      if (priorKey) {
        try {
          const priorPnlSnap = await getDoc(doc(db, 'tenants', orgId, 'pnl', locId, 'periods', priorKey))
          // "Prior was actually COUNTED" = prior doc has a closingValue. A doc that exists
          // from purchasing/labor alone (no closingValue) is NOT a real prior close.
          const priorClosing = priorPnlSnap.exists() ? priorPnlSnap.data().closingValue : null
          priorCountExists = priorClosing != null
          freshOpening = priorCountExists ? (priorClosing || 0) : 0
          if (freshOpening !== openingValue) setOpeningValue(freshOpening)
        } catch (e) {
          console.warn('Failed to refresh opening from prior week at save; using cached value', e)
        }
      }
      // Option (a): cogs_inventory is the pure inventory DELTA (opening − closing), NOT
      // purchases-inclusive and NOT clamped — a genuine stock-up week (real prior close,
      // closing > opening) is legitimately negative and offsets that week's purchases at
      // aggregation (see computeFoodCogs in pnl.js). Purchases live solely in cogs_purchases.
      // FIRST-COUNT GUARD: with no real prior close, opening defaults to 0 and (0 − closing)
      // would be a spurious full-negative delta that wrongly cancels the week's real
      // purchases — store 0 instead (food COGS = purchases alone). Same condition the
      // opening value itself derives from.
      const cogs = priorCountExists ? (freshOpening - closingValue) : 0

      // valuationMode gate (cutover build 2) — same as saveCounts. Count docs
      // above always persisted; the LIVE P&L + Path B writes below are skipped
      // when the CF owns this location. FAIL-SAFE: read error / missing / 'client'
      // → cfAuthoritative false → write as today. Only 'cf' hands off.
      let cfAuthoritative = false
      try {
        const modeSnap = await getDoc(doc(db, 'tenants', orgId, 'valuationMode', locId))
        cfAuthoritative = modeSnap.exists() && modeSnap.data().authoritative === 'cf'
      } catch (modeErr) {
        console.warn('valuationMode read failed — defaulting to client-authoritative (writing as today):', modeErr)
        cfAuthoritative = false
      }

      // LIVE P&L write — skipped when the CF is authoritative for this location.
      // Deliberately does NOT touch `rolledOverFrom` here (unlike saveCounts): this is
      // the explicit "Close Period" action, not autosave, and merge:true on an omitted
      // field leaves whatever saveCounts last wrote untouched — so closing a period right
      // after a rollover (no intervening real edit) can't accidentally clobber the flag
      // ShrinkageTable relies on to withhold a phantom shrinkage number (point 6).
      if (!cfAuthoritative) await setDoc(
        doc(db, 'tenants', orgId, 'pnl', locId, 'periods', periodKey),
        {
          closingValue,
          openingValue: freshOpening,
          cogs_inventory: cogs,
          inventoryCountedAt: serverTimestamp(),
          inventoryCountedBy: user?.email
        },
        { merge: true }
      )

      // Path B snapshot — period-keyed items array at
      // tenants/{orgId}/locations/{locId}/inventory/{periodKey}.
      // This is the canonical inventory location-period snapshot that Waste
      // and the P&L Why panel inventory engine read from. Without this write,
      // those consumers see no data for any period.
      const snapshotItems = items
        // hasCount (not qty!=null) so eaches-only items are included — matches
        // saveCounts' Path B write; closes the TODO that dropped eaches-only rows.
        .filter(hasCount)
        .map(i => ({
          id: i.id,
          name: i.name,
          // Zone-aware top-level (the derived total for a zoned item — its
          // in-memory qty/eaches is not its count); legacy unchanged.
          ...pathBCount(i, zonesRef.current, bucketsDoneRef.current),
          qtyPerPack: i.qtyPerPack || 1,
          packPrice: i.packPrice || null,
          unitCost: i.unitCost || 0,
          category: i.category || null,   // was i._cat (only on itemsWithMeta) → always null
          vendor: i.vendor || null,
        }))
      // Own try — Path B failure must not abort the save (P&L is already
      // written above; Waste/Why read Path B best-effort).
      // Path B write — also skipped when the CF owns this location (it rebuilds
      // Path B server-side). Own try so a Path B failure never aborts the save.
      if (!cfAuthoritative) try {
        await setDoc(
          doc(db, 'tenants', orgId, 'locations', locId, 'inventory', periodKey),
          {
            items:        snapshotItems,
            closingValue,
            period:       periodKey,
            locationName: locationId,
            updatedAt:    serverTimestamp(),
            updatedBy:    user?.email || 'unknown',
          },
          { merge: true }
        )
      } catch (pathBErr) {
        console.error('Path B snapshot write failed (P&L already written):', pathBErr)
      }

      if (session) {
        await setDoc(
          doc(db, 'tenants', orgId, 'inventorySessions', `${locId}_${periodKey}`),
          // Status fields ONLY. `...session` re-sent this device's copy of the
          // swept/section lists, so closing from a device that loaded before a
          // colleague's sweep un-swept it at the worst possible moment.
          {
            status: 'completed',
            completedAt: serverTimestamp(),
            completedBy: user?.email
          },
          { merge: true }
        )
      }

      // Scope the touched-clear to ids whose CURRENT local value still matches
      // what we persisted — ids re-typed during the await stay touched for the
      // next save (fixes the eaches-stranding race; parallels saveCounts).
      const cleared2 = countsPersisted2 ? touchedIdsToClear(touchedSnapshot2, newCounts2, itemsRef.current) : new Set()
      cleared2.forEach(id => { touchedItemsRef.current.delete(id); touchedZonesRef.current.delete(id) })
      // Stale-raw root-cause fix (#7) — drop _qtyRaw/_eachesRaw (null, not '') on
      // the just-cleared ids only. Kept-touched items may be mid-typing.
      setItems(prev => prev.map(i =>
        cleared2.has(String(i.id)) ? { ...i, _qtyRaw: null, _eachesRaw: null } : i
      ))
      setDirty(false)
      return true
    } catch (err) {
      console.error('Failed to save inventory:', err)
      setError('Failed to save inventory')
      return false
    } finally {
      setSaving(false)
    }
  }, [items, locationId, locId, periodKey, orgId, openingValue, purchases, user, session])

  const itemsWithMeta = useMemo(() => {
    return items.map(item => {
      const prior = priorItems.find(p => p.id === item.id)
      // COUNT READERS go through zones.js, never item.qty directly: a zoned
      // item's top-level qty is null by construction, so every reader below
      // used to see it as 0 / uncounted. LEGACY items read exactly as before
      // (itemCountQty / storedCountQty return item.qty for a flat record).
      const zonesSwept = completedBuckets(session)   // swept zones + completed sheets
      const countQty = itemCountQty(item, zones, zonesSwept)
      const priorQty = storedCountQty(prior) || 0
      // A zoned prior's stored total is ALL in eaches and already in priorQty
      // (as packs) — showing it again as loose eaches would double it.
      const priorEaches = hasBucketData(prior) ? 0 : (prior?.eaches || 0)
      const variance = (countQty || 0) - priorQty
      const varClass = getVarianceClass(countQty, priorQty)
      const cat = assignCategory(item, categories)
      const daysOnHand = calcDaysOnHand(countQty, item.avgDailyUsage)
      const belowPar = item.parLevel && countQty != null && countQty < item.parLevel
      const atReorder = item.reorderPoint && countQty != null && countQty <= item.reorderPoint

      return {
        ...item,
        _cat: cat,
        _priorQty: priorQty,
        _priorEaches: priorEaches,
        _variance: variance,
        _varClass: varClass,
        _daysOnHand: daysOnHand,
        _belowPar: belowPar,
        _atReorder: atReorder,
        _value: itemValue(item, zones, zonesSwept),
        // Pack-denominated count (par/variance/Prior units) and total on hand in
        // eaches — the fields every reader outside this hook uses instead of
        // item.qty. null = not (fully) counted.
        _countQty: countQty,
        _totalEaches: itemTotalEaches(item, zones, zonesSwept),
      }
    })
  }, [items, priorItems, categories, zones, session])

  // Per-category totals from PORTIONS (categoryTotals): a split item contributes
  // its share to each of its sheets — never its full value to each — so the
  // category values always sum (with `uncategorized`) to closingValue.
  const categoryBreakdown = useMemo(
    () => categoryTotals(itemsWithMeta, categories, zones, completedBuckets(session)),
    [itemsWithMeta, categories, zones, session])
  // The cent ledger for everything DISPLAYED (displayCents): closing rounded to
  // whole cents once, distributed to items then sheets by largest remainder —
  // so rows, sheet totals and the Closing Value KPI add up exactly on screen.
  const centLedger = useMemo(() => displayCents(itemsWithMeta, categories), [itemsWithMeta, categories])
  const catStats = useMemo(() => {
    const stats = {}
    categories.forEach(cat => {
      const b = categoryBreakdown.byCat[cat.key] || { items: 0, counted: 0, value: 0 }
      // value: this sheet's cents from the ledger (exact), not a float sum.
      stats[cat.key] = { total: b.items, counted: b.counted, value: (centLedger.byCat[cat.key] || 0) / 100 }
    })
    return stats
  }, [categoryBreakdown, categories, centLedger])

  // DISPLAY-ONLY opening value for the KPI card, walked back to match the Prior column: when
  // the immediately-prior period was skipped (priorFromPeriod set), openingValue (the pnl-based
  // immediate-prior close, used by save() + liveCOGS below) is $0, while the Prior column shows
  // the walked-back counts. Derive the card's value from those SAME walked-back count items
  // (they carry packPrice/qtyPerPack/unitCost) so the $ total and the column agree. Falls back
  // to openingValue in the normal (immediate-prior) case and for old count docs missing prices —
  // so nothing changes off a stub, and save()/liveCOGS are untouched.
  const openingValueDisplay = useMemo(() => {
    if (!priorFromPeriod || !priorItems.length) return openingValue
    let sum = 0, priced = false
    for (const p of priorItems) {
      const pp = Number(p.packPrice) || ((Number(p.qtyPerPack) || 1) * (Number(p.unitCost) || 0))
      const ep = (Number(p.qtyPerPack) || 1) > 0 ? pp / (Number(p.qtyPerPack) || 1) : (Number(p.unitCost) || 0)
      if (pp > 0) priced = true
      sum += ((Number(p.qty) || 0) * pp) + ((Number(p.eaches) || 0) * ep)
    }
    return priced ? sum : openingValue
  }, [priorFromPeriod, priorItems, openingValue])

  const totals = useMemo(() => {
    const closingValue = itemsWithMeta.reduce((sum, i) => sum + i._value, 0)
    const counted = itemsWithMeta.filter(hasCount).length
    const liveCOGS = Math.max(0, openingValue + purchases - closingValue)   // save-aligned (immediate-prior)
    const belowPar = itemsWithMeta.filter(i => i._belowPar).length
    const atReorder = itemsWithMeta.filter(i => i._atReorder).length

    return {
      closingValue,
      openingValue,
      openingValueDisplay,           // walked-back for the KPI card (== openingValue in the normal case)
      purchases,
      liveCOGS,
      counted,
      total: items.length,
      progress: items.length ? Math.round((counted / items.length) * 100) : 0,
      belowPar,
      atReorder,
      wellStocked: items.length - belowPar - atReorder
    }
  }, [itemsWithMeta, openingValue, openingValueDisplay, purchases, items.length])

  const varianceAlerts = useMemo(() => {
    return itemsWithMeta
      .filter(i => i._varClass === 'alert' || i._varClass === 'warn')
      .sort((a, b) => Math.abs(b._variance * b.unitCost) - Math.abs(a._variance * a.unitCost))
      .slice(0, 5)
  }, [itemsWithMeta])

  const itemsBelowPar = useMemo(() => {
    return itemsWithMeta
      .filter(i => i._belowPar || i._atReorder)
      .sort((a, b) => (a._daysOnHand || 999) - (b._daysOnHand || 999))
  }, [itemsWithMeta])

  return {
    items: itemsWithMeta,
    priorFromPeriod,          // non-null when the Prior column walked back past the immediate prior
    categories,
    zones,
    catStats,
    categoryBreakdown,    // portions + uncategorized; sums to closingValue
    centLedger,           // exact display cents: closing, per item, per sheet
    totals,
    varianceAlerts,
    itemsBelowPar,
    session,
    loading,
    saving,
    dirty,
    error,
    load,
    adjust,
    adjustEaches,
    setEaches,
    setQty,
    copyPrior,
    toggleKey,
    removeItem,
    restoreItem,
    addCustomItem,
    removedItems,
    loadRemovedItems,
    glCodes,
    buddyMode,
    setBuddyMode,
    buddyNames,
    setBuddyNames,
    markSectionComplete,
    markZoneSwept,        // Phase 3 — zone sweeps
    setItemCountCategories,     // multi-category membership (edit panel)
    removeCategoriesFromItems,  // category deleted → merge its counts into home
    setZoneValue,         // Phase 4 — per-zone count entry
    save,
    saveCounts,
    rollOverFromPrior,
    mergeDraft,
    patchItemFields,
    setCategoriesLocal,
    setZonesLocal,
    periodLocked,
    markPeriodLocked,
    applyUploadedCounts,
  }
}

/**
 * Legacy label → built-in category key aliases.
 *
 * Hoisted to module scope so the edit panel's <select> and assignCategory read
 * ONE map. They previously kept private copies that had drifted: the panel's
 * had 7 entries (no proteins/produce) and no fallback to the location's own
 * category list, so a saved category could resolve to a different key in the
 * dropdown than in the grouped table.
 */
export const CATEGORY_ALIASES = {
  'barista': 'bar_items',
  'snacks': 'pantry',
  'beverages': 'beverages',
  'condiments': 'condiments',
  'cafeteria': 'pantry',
  'dairy': 'dairy',
  'frozen': 'frozen',
  'proteins': 'proteins',
  'produce': 'produce',
}

/**
 * Resolve an item to a category KEY.
 *
 * `item.categoryExplicit === true` is the sentinel meaning "a human picked this
 * category in the edit panel" — as opposed to `item.category` holding a value
 * that arrived from a catalog upload or a previous inferCategory() run. The two
 * cases need opposite handling and used to be indistinguishable:
 *
 *   - NOT explicit: 'General'/'Other' mean "nobody categorized this", so they
 *     are ignored and the name/glCode inference below runs. Preserved exactly
 *     as-is — uploads legitimately carry those as filler.
 *   - EXPLICIT: the stored label is the user's decision and is honored verbatim,
 *     INCLUDING 'General'/'Other'. Without this, picking General sent the item
 *     straight back through inference — i.e. back to the keyword guess the user
 *     was trying to correct, which read as "the change didn't save."
 *
 * Alias precedence also flips for an explicit choice: the location's own
 * category list wins over CATEGORY_ALIASES, so a per-location category whose
 * label happens to collide with a built-in alias (e.g. one named "Snacks")
 * keeps its own key instead of being rerouted to 'pantry'. For non-explicit
 * values the aliases still win, preserving historical grouping.
 */
export function assignCategory(item, categories) {
  const explicit = item?.categoryExplicit === true
  const raw = item?.category
  const usable = raw && (explicit || (raw !== 'Other' && raw !== 'General'))

  if (usable) {
    const catName = String(raw).toLowerCase()
    const match = (categories || []).find(
      c => c.key === catName || String(c.label).toLowerCase() === catName
    )
    if (explicit && match) return match.key
    if (CATEGORY_ALIASES[catName]) return CATEGORY_ALIASES[catName]
    if (match) return match.key
    return catName
  }

  for (const cat of categories) {
    if (cat.rx && new RegExp(cat.rx, 'i').test(item.name || '')) {
      return cat.key
    }
    if (cat.keywords?.some(kw => (item.name || '').toLowerCase().includes(kw.toLowerCase()))) {
      return cat.key
    }
  }
  return 'general'
}

export function getDefaultCategories() {
  return [
    { key: 'beverages', label: 'Beverages', color: '#1e40af', bg: '#dbeafe', keywords: ['red bull', 'celsius', 'coke', 'sprite', 'juice', 'water', 'tea', 'coffee', 'lemonade', 'gatorade'] },
    { key: 'bar_items', label: 'Bar / Barista', color: '#7c3aed', bg: '#ede9fe', keywords: ['espresso', 'syrup', 'chai', 'matcha', 'cold brew', 'latte'] },
    { key: 'pantry', label: 'Pantry / Snacks', color: '#92400e', bg: '#fef3c7', keywords: ['chip', 'bar', 'snack', 'cookie', 'candy', 'nuts', 'pretzel', 'popcorn'] },
    { key: 'dairy', label: 'Dairy', color: '#0369a1', bg: '#e0f2fe', keywords: ['milk', 'cream', 'yogurt', 'cheese', 'butter'] },
    { key: 'frozen', label: 'Frozen', color: '#1d4ed8', bg: '#dbeafe', keywords: ['ice cream', 'frozen', 'popsicle'] },
    { key: 'proteins', label: 'Proteins', color: '#b91c1c', bg: '#fee2e2', keywords: ['chicken', 'beef', 'steak', 'salmon', 'fish', 'pork', 'turkey', 'shrimp'] },
    { key: 'produce', label: 'Produce', color: '#15803d', bg: '#dcfce7', keywords: ['lettuce', 'tomato', 'onion', 'pepper', 'carrot', 'fruit', 'apple', 'banana'] },
    { key: 'condiments', label: 'Condiments', color: '#64748b', bg: '#f1f5f9', keywords: ['sauce', 'ketchup', 'mustard', 'mayo', 'salt', 'pepper', 'sugar', 'sweetener', 'packet', 'sriracha', 'cholula', 'tabasco', 'tapatio', 'soy sauce', 'cracker'] },
    { key: 'general', label: 'General', color: '#374151', bg: '#f3f4f6', keywords: [] }
  ]
}

export default useInventory