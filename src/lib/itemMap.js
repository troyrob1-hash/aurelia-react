// Increment 2 — the item mapping layer. One canonical identity per physical product,
// linking the three feeds: SOLD (POS names) ↔ COUNTED (inventory catalog) ↔ PURCHASED
// (vendor item codes). Classification is mapping-DERIVED: an item is shrinkage-tracked
// IFF it maps to a sold item; café-use items never map → auto-excluded from shrinkage,
// still counted in COGS.
//
// Two halves:
//   • PURE (this half + the matcher): normalization, fuzzy scoring, volume ranking,
//     coverage — unit-tested, no Firestore.
//   • WRITER (bottom): thin Firestore mutations (auto-map, remap, café-use) + the
//     denormalized index for O(1) code resolution at import time.
//
// Auto-map, no approval gate. Purchased side resolves by CODE (map once per code, then
// every future invoice line auto-resolves). Sold↔catalog auto-maps high-confidence names.
// Everything else lands in the VOLUME-RANKED unmapped list — map the high-volume items
// first, watch the coverage indicator, stop when the tail goes optional.

import { db } from '@/lib/firebase'
import { doc, getDoc, getDocs, setDoc, collection, serverTimestamp } from 'firebase/firestore'

// ── Normalization + fuzzy matcher (shared by auto-map + proposals) ────────────
const SIZE = /\b\d+(\.\d+)?\s?(fl\s?oz|oz|ml|l|ct|count|pack|pk|lb|g|gal|mg)\b/gi
const NUM = /\b\d+(\.\d+)?\b/g
const STOP = new Set(['the', 'and', 'of', 'with', 'fl', 'oz', 'ct', 'mex', 'llc', 'organic', 'original', 'inc'])
// Flavor/variant discriminators — the guard against merging Chobani peach vs strawberry.
const FLAVOR = /berry|peach|straw|mango|choc|vanilla|lime|lemon|orange|grape|zero|cherry|mint|coconut|caramel|punch|guava|banana|apple|pineapple/i

export function normalizeItemName(s) {
  return String(s || '').toLowerCase().replace(/&/g, ' and ')
    .replace(SIZE, ' ').replace(NUM, ' ').replace(/[^a-z ]+/g, ' ')
    .split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w)).sort().join(' ').trim()
}
export function itemTokens(s) { return new Set(normalizeItemName(s).split(' ').filter(Boolean)) }
export function brandOf(s) {
  // brand = first non-stop meaningful token in ORIGINAL order (not sorted)
  const raw = String(s || '').toLowerCase().replace(/&/g, ' and ').replace(SIZE, ' ').replace(NUM, ' ')
    .replace(/[^a-z ]+/g, ' ').split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w))
  return raw[0] || ''
}
function jaccard(a, b) { let i = 0; for (const t of a) if (b.has(t)) i++; return i / (a.size + b.size - i || 1) }

// canonicalId: a stable, doc-id-safe slug for a canonical item.
export function canonicalIdFor(name) {
  return String(name || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}

// Variant risk: same brand, but each side carries a distinct flavor token the other
// lacks → NEVER auto-map (Chobani peach vs Chobani strawberry). Human decides.
export function isVariantRisk(aTokens, bTokens) {
  const af = [...aTokens].filter((t) => FLAVOR.test(t))
  const bf = [...bTokens].filter((t) => FLAVOR.test(t))
  if (!af.length && !bf.length) return false
  return af.some((t) => !bTokens.has(t)) && bf.some((t) => !aTokens.has(t))
}

// Best fuzzy match of `name` against candidates [{ id, name }]. Brand must agree.
export function fuzzyBest(name, candidates) {
  const nt = itemTokens(name), nb = brandOf(name)
  let best = 0, match = null, risk = false
  for (const c of candidates) {
    const cb = c._brand || brandOf(c.name)
    if (nb && cb && nb !== cb) continue          // brand-anchored
    const ct = c._tokens || itemTokens(c.name)
    const j = jaccard(nt, ct)
    if (j > best) { best = j; match = c; risk = isVariantRisk(nt, ct) }
  }
  return { score: best, match, variantRisk: risk }
}

// Confidence thresholds. Conservative HI: a wrong auto-map is worse than an
// unmapped-list entry (whose cost is one-time-per-code). Tune here.
export const AUTO_MAP_THRESHOLD = 0.6
export const PROPOSAL_FLOOR = 0.35

// Classify a fuzzy result → what auto-map should do with it.
//   'auto'     : high-confidence, no variant risk → create the mapping silently
//   'proposal' : mid-confidence OR variant-risk   → unmapped list, PRE-FILLED suggestion
//                (variant-risk shows the suggestion but is NOT pre-selected)
//   'none'     : below floor                       → unmapped list, no suggestion
export function classifyMatch({ score, variantRisk }) {
  if (score >= AUTO_MAP_THRESHOLD && !variantRisk) return 'auto'
  if (score >= PROPOSAL_FLOOR || variantRisk) return 'proposal'
  return 'none'
}

// ── Volume-ranked unmapped list + coverage indicator ──────────────────────────
// The refinement the sizing revealed: the ~600 unmapped sold items are NOT equal.
// Rank by qtySold desc so the manager maps the high-volume items first, and show a
// running "top N mapped = X% of units covered" so they know when the tail goes optional.
//
// items: [{ name, qtySold, proposal? }]  → returns them sorted desc with cumulative %.
export function rankUnmappedByVolume(items) {
  const total = items.reduce((s, it) => s + (it.qtySold || 0), 0) || 1
  let cum = 0
  return items
    .slice()
    .sort((a, b) => (b.qtySold || 0) - (a.qtySold || 0))
    .map((it, i) => {
      cum += it.qtySold || 0
      return { ...it, rank: i + 1, cumUnits: cum, cumPct: (cum / total) * 100 }
    })
}

// Given the volume-ranked list and a set of already-mapped names, what % of TOTAL sold
// units is covered, and how many of the remaining unmapped items would the next X% need.
export function coverageStats(rankedAll, mappedNames) {
  const total = rankedAll.reduce((s, it) => s + (it.qtySold || 0), 0) || 1
  const mapped = new Set(mappedNames)
  const coveredUnits = rankedAll.filter((it) => mapped.has(it.name)).reduce((s, it) => s + (it.qtySold || 0), 0)
  const unmappedRanked = rankedAll.filter((it) => !mapped.has(it.name))
  // "map the next N high-volume items to reach the next milestone"
  const milestones = [50, 75, 85, 90, 95].map((pct) => {
    const target = total * (pct / 100)
    let running = coveredUnits, need = 0
    for (const it of unmappedRanked) { if (running >= target) break; running += it.qtySold || 0; need++ }
    return { pct, itemsNeeded: need, reachable: running >= target }
  })
  return {
    totalUnits: total,
    coveredUnits,
    coveredPct: (coveredUnits / total) * 100,
    unmappedCount: unmappedRanked.length,
    unmappedTailCount: unmappedRanked.filter((it) => (it.qtySold || 0) <= 5).length,
    milestones,
  }
}

// ── Auto-map planner (pure decision, applied by the import path) ───────────────
// The auto-map logic, decoupled from Firestore so it's testable and reviewable:
//   • SOLD side: fuzzy-match each unmapped sold name to candidates (catalog + existing
//     canonicals). classifyMatch → 'auto' (create silently) / 'proposal' (unmapped list,
//     pre-filled suggestion) / 'none' (unmapped list, no suggestion).
//   • PURCHASED side is CODE-FIRST and handled at import by resolvePurchaseKey (exact,
//     O(1)); only a NEW code falls through to this same fuzzy planner on its description.
// Returns the plan — the caller applies writeMapping for 'auto' and stashes the rest in
// the unmapped list. Never guesses a low-confidence or variant-risk mapping.
export function planAutoMap(items, candidates, { alreadyMapped = new Set() } = {}) {
  const auto = [], proposals = [], unmapped = []
  for (const it of items) {
    if (alreadyMapped.has(it.name)) continue
    const fz = fuzzyBest(it.name, candidates)
    const kind = classifyMatch(fz)
    const row = { ...it, match: fz.match ? { id: fz.match.id, name: fz.match.name } : null, score: fz.score, variantRisk: fz.variantRisk, kind }
    if (kind === 'auto') auto.push(row)
    else if (kind === 'proposal') proposals.push(row)
    else unmapped.push(row)
  }
  return { auto, proposals, unmapped }
}

// ── Firestore: index key + resolution ─────────────────────────────────────────
export const purchaseKeyId = (vendor, itemCode) => `${vendor}__${String(itemCode).trim()}`
export const upcKeyId = (upc) => `upc__${String(upc).trim()}`

// Resolve a purchase line to a canonicalId via the denormalized index (O(1), code-first).
// Prefer UPC (cross-vendor) over (vendor,itemCode). Returns canonicalId or null.
export async function resolvePurchaseKey(orgId, { vendor, itemCode, upc }) {
  if (upc) {
    const u = await getDoc(doc(db, 'tenants', orgId, 'purchaseKeyIndex', upcKeyId(upc)))
    if (u.exists()) return u.data().canonicalId
  }
  if (itemCode) {
    const k = await getDoc(doc(db, 'tenants', orgId, 'purchaseKeyIndex', purchaseKeyId(vendor, itemCode)))
    if (k.exists()) return k.data().canonicalId
  }
  return null
}

// ── READ-TIME purchase resolution (self-heals; no backfill) ───────────────────
// Purchase-line resolution stored at parse time freezes: a line parsed before its code
// was mapped keeps canonicalId:null forever. Instead, resolve LIVE from the current
// mappings — a line's canonical is whatever the mapping says NOW, not what was stamped.
// buildPurchaseLookup builds a (vendor,itemCode)/upc → canonicalId index from the itemMap
// docs; resolvePurchaseLineLive resolves one line against it (UPC preferred, matching
// resolvePurchaseKey's precedence). Callers ignore the stored l.canonicalId.
export function buildPurchaseLookup(mappings) {
  const byCode = new Map(), byUpc = new Map()
  for (const m of mappings || []) {
    for (const pk of m.purchaseKeys || []) {
      if (pk.itemCode) byCode.set(purchaseKeyId(pk.vendor, pk.itemCode), m.canonicalId)
      if (pk.upc) byUpc.set(upcKeyId(pk.upc), m.canonicalId)
    }
  }
  return { byCode, byUpc }
}

// Resolve a purchase line to a canonicalId at read time, or null. vendorKey is the
// invoice-level normalized vendor (line.itemCode is vendor-scoped; upc is universal).
export function resolvePurchaseLineLive(lookup, vendorKey, line) {
  const upc = String(line?.upc || '').trim()
  if (upc) { const c = lookup.byUpc.get(upcKeyId(upc)); if (c) return c }   // UPC first (cross-vendor)
  const code = String(line?.itemCode || '').trim()
  if (code) { const c = lookup.byCode.get(purchaseKeyId(vendorKey, code)); if (c) return c }
  return null
}

// Collapse purchaseKeys to unique (vendor, itemCode, upc) tuples — remapping the same
// code must not append a duplicate. Order-independent (a {itemCode,vendor,upc} and a
// {upc,vendor,itemCode} for the same tuple collapse), and re-normalizes existing docs on
// their next write (writeMapping/remapPurchaseKey both run it; merge overwrites the array).
export function dedupePurchaseKeys(keys) {
  const seen = new Set(), out = []
  for (const pk of keys || []) {
    const vendor = String(pk?.vendor ?? '').trim() || null
    const itemCode = String(pk?.itemCode ?? '').trim() || null
    const upc = String(pk?.upc ?? '').trim() || null
    if (!itemCode && !upc) continue                       // no stable key → drop
    const sig = `${vendor || ''}__${itemCode || ''}__${upc || ''}`
    if (seen.has(sig)) continue
    seen.add(sig)
    out.push({ vendor, itemCode, upc })
  }
  return out
}

// Build the default itemMap doc.
export function newMappingDoc({ canonicalName, catalogItemId = null, soldAliases = [], purchaseKeys = [], status = 'active', source = 'auto', confidence = null, createdBy = 'unknown' }) {
  return {
    canonicalId: canonicalIdFor(canonicalName),
    canonicalName,
    catalogItemId,
    soldAliases,
    purchaseKeys,
    status,                                   // 'active' | 'cafe_use'
    // unit fields — STUB for Increment 3 (unit normalization)
    soldUnit: null, countUnit: null, purchaseUnit: 'each', eachesPerCount: null,
    source, confidence,
    createdBy, createdAt: serverTimestamp(), updatedBy: createdBy, updatedAt: serverTimestamp(),
  }
}

// Write/merge a mapping doc + refresh its indexes. Idempotent by canonicalId.
export async function writeMapping(orgId, mapping, actor = 'unknown') {
  const id = mapping.canonicalId || canonicalIdFor(mapping.canonicalName)
  // Dedupe purchaseKeys before write. merge overwrites the array wholesale, so this also
  // normalizes any existing doc that carried dupes (e.g. from an earlier double-append).
  const purchaseKeys = dedupePurchaseKeys(mapping.purchaseKeys)
  await setDoc(doc(db, 'tenants', orgId, 'itemMap', id),
    { ...mapping, canonicalId: id, purchaseKeys, updatedBy: actor, updatedAt: serverTimestamp() }, { merge: true })
  // index every purchaseKey (vendor,itemCode) + upc → canonicalId
  for (const pk of purchaseKeys) {
    if (pk.itemCode) await setDoc(doc(db, 'tenants', orgId, 'purchaseKeyIndex', purchaseKeyId(pk.vendor, pk.itemCode)), { canonicalId: id, ...pk }, { merge: true })
    if (pk.upc) await setDoc(doc(db, 'tenants', orgId, 'purchaseKeyIndex', upcKeyId(pk.upc)), { canonicalId: id, ...pk }, { merge: true })
  }
  // index every sold alias (normalized) → canonicalId
  for (const alias of mapping.soldAliases || []) {
    await setDoc(doc(db, 'tenants', orgId, 'soldAliasIndex', canonicalIdFor(normalizeItemName(alias))), { canonicalId: id, alias }, { merge: true })
  }
  return id
}

// INLINE CORRECT — remap a purchase key or sold alias to a different canonical item.
// Adds to the target's arrays + repoints the index (a stale index row is overwritten,
// last-write-wins). Old canonical keeps its other keys.
export async function remapPurchaseKey(orgId, { vendor, itemCode, upc }, targetCanonicalId, actor = 'unknown') {
  const targetRef = doc(db, 'tenants', orgId, 'itemMap', targetCanonicalId)
  const snap = await getDoc(targetRef)
  const cur = snap.exists() ? snap.data() : null
  if (!cur) throw new Error(`remap target ${targetCanonicalId} not found`)
  const keys = dedupePurchaseKeys([...(cur.purchaseKeys || []), { vendor, itemCode, upc: upc || null }])
  await setDoc(targetRef, { purchaseKeys: keys, source: 'manual', confidence: null, updatedBy: actor, updatedAt: serverTimestamp() }, { merge: true })
  if (itemCode) await setDoc(doc(db, 'tenants', orgId, 'purchaseKeyIndex', purchaseKeyId(vendor, itemCode)), { canonicalId: targetCanonicalId, vendor, itemCode }, { merge: true })
  if (upc) await setDoc(doc(db, 'tenants', orgId, 'purchaseKeyIndex', upcKeyId(upc)), { canonicalId: targetCanonicalId, upc }, { merge: true })
}

// INLINE CORRECT — mark café-use (drops from shrinkage, stays in COGS). Reversible.
export async function setCafeUse(orgId, canonicalId, cafeUse, actor = 'unknown') {
  await setDoc(doc(db, 'tenants', orgId, 'itemMap', canonicalId),
    { status: cafeUse ? 'cafe_use' : 'active', source: 'manual', updatedBy: actor, updatedAt: serverTimestamp() }, { merge: true })
}

// Load all mappings once (for the resolver + the unmapped-list builder).
export async function loadMappings(orgId) {
  const snap = await getDocs(collection(db, 'tenants', orgId, 'itemMap'))
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }))
}

// ── Import-time orchestration ─────────────────────────────────────────────────
// SOLD side (called after the Cafe Product Mix import writes salesItems): fuzzy the
// distinct sold names against candidates (catalog + existing canonicals) and AUTO-MAP
// the high-confidence non-variant matches. Proposals + no-matches are left for the
// volume-ranked unmapped list — never guessed. Returns counts for the import toast.
export async function autoMapSoldItems(orgId, soldNames, actor = 'unknown') {
  const mappings = await loadMappings(orgId)
  const alreadyMapped = new Set()
  for (const m of mappings) for (const a of m.soldAliases || []) alreadyMapped.add(a)

  const catSnap = await getDocs(collection(db, 'tenants', orgId, 'inventoryCatalog'))
  const candidates = [
    ...catSnap.docs.map((d) => { const x = d.data(); const nm = x.name || x.itemName || d.id; return { id: d.id, name: nm, _tokens: itemTokens(nm), _brand: brandOf(nm) } }),
    ...mappings.map((m) => ({ id: m.canonicalId, name: m.canonicalName, _tokens: itemTokens(m.canonicalName), _brand: brandOf(m.canonicalName), _canonical: true })),
  ]

  const items = [...new Set(soldNames)].map((name) => ({ name }))
  const { auto, proposals, unmapped } = planAutoMap(items, candidates, { alreadyMapped })

  const byCanonical = new Map(mappings.map((m) => [m.canonicalName, m]))
  for (const row of auto) {
    const existing = byCanonical.get(row.match.name)
    const mapping = existing
      ? { ...existing, soldAliases: [...new Set([...(existing.soldAliases || []), row.name])] }
      : newMappingDoc({ canonicalName: row.match.name, catalogItemId: row.match._canonical ? null : row.match.id, soldAliases: [row.name], source: 'auto', confidence: row.score, createdBy: actor })
    await writeMapping(orgId, mapping, actor)
    byCanonical.set(row.match.name, mapping)
  }
  return { autoMapped: auto.length, proposals: proposals.length, unmapped: unmapped.length }
}

// PURCHASED side (called during invoice import, per line): code-first resolve. Returns
// each line tagged with its canonicalId (or null → falls to the unmapped list). NOTE:
// requires the line to carry { vendor, itemCode, upc } — i.e. the parseInvoiceLines
// schema, so this activates once that parser is wired into the invoice importer.
export async function resolvePurchaseLines(orgId, vendor, lines) {
  const out = []
  for (const l of lines) {
    const canonicalId = await resolvePurchaseKey(orgId, { vendor, itemCode: l.itemCode, upc: l.upc })
    out.push({ ...l, canonicalId, resolved: !!canonicalId })
  }
  return out
}
