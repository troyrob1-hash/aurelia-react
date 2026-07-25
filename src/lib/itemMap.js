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

// Abbreviation expansion — applied BEFORE the ≤2-char token filter so a short abbreviation
// (e.g. "mt", 2 chars) isn't dropped before it can be matched to its spelled-out form.
// TIGHT list: only abbreviations PROVEN to flip a real unmapped item on live data. Verified:
// catalog "Mt. Dew" tokenizes to {dew} ("mt" filtered) while sold "Mountain Dew" → {mountain,
// dew} — 0 overlap on "mt"; mt/mtn → mountain closes it (Mountain Dew → Mt. Dew = 1.00). Runs
// on BOTH sides (it's in the shared tokenizer), so sold and catalog meet at the same tokens.
const ABBREV = [[/\bmt\b/g, 'mountain'], [/\bmtn\b/g, 'mountain']]
export function expandAbbrev(s) { let x = String(s || ''); for (const [re, to] of ABBREV) x = x.replace(re, to); return x }

export function normalizeItemName(s) {
  return expandAbbrev(String(s || '').toLowerCase()).replace(/&/g, ' and ')
    .replace(SIZE, ' ').replace(NUM, ' ').replace(/[^a-z ]+/g, ' ')
    .split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w)).sort().join(' ').trim()
}
export function itemTokens(s) { return new Set(normalizeItemName(s).split(' ').filter(Boolean)) }
// Meaningful tokens in ORIGINAL (unsorted) order — for the brand (first) and the B-tier
// positional rule (a vendor prefix is a run of leading tokens; a mid-name token is not).
export function tokenArr(s) {
  return expandAbbrev(String(s || '').toLowerCase()).replace(/&/g, ' and ').replace(SIZE, ' ').replace(NUM, ' ')
    .replace(/[^a-z ]+/g, ' ').split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w))
}
export function brandOf(s) { return tokenArr(s)[0] || '' }
function jaccard(a, b) { let i = 0; for (const t of a) if (b.has(t)) i++; return i / (a.size + b.size - i || 1) }

// ── Fuzzy token matching (spelling/spacing — the C tier) ──────────────────────
// Levenshtein, bounded (returns 2 as soon as it can't be ≤1 — we only ever ask "≤1?").
function lev(a, b) {
  const m = a.length, n = b.length
  if (Math.abs(m - n) > 1) return 2
  const d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)])
  for (let j = 0; j <= n; j++) d[0][j] = j
  for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++)
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
  return d[m][n]
}
// Two tokens match if equal OR (both ≥5 chars and one edit apart) — "Frappucino"~"Frappuccino",
// "Sherbet"~"Sherbert", "Mightly"~"Mighty". The ≥5 floor stops short-token noise (a 1-edit gap
// on a 4-char token — "diet"/"debt", "mango"/"tango" are 5 but see the flavor guard) from
// over-merging; flavor differences are still caught by isVariantRisk.
export function fuzzyTokenMatch(x, y) { return x === y || (x.length >= 5 && y.length >= 5 && lev(x, y) <= 1) }
// Fuzzy jaccard — token overlap counting an edit-≤1 pair as a match (greedy, each catalog
// token used once). Used by fuzzyBest so a spelling variant scores like an exact match.
function fuzzyJaccard(A, B) {
  const a = [...A], b = [...B], used = new Array(b.length).fill(false)
  let i = 0
  for (const x of a) for (let k = 0; k < b.length; k++) { if (!used[k] && fuzzyTokenMatch(x, b[k])) { i++; used[k] = true; break } }
  return i / (a.length + b.length - i || 1)
}
// De-spaced form (spacing/concatenation — "AlaniNu"→"alaninu" vs "Alani Nu"→"alaninu").
export function despace(s) { return expandAbbrev(String(s || '').toLowerCase()).replace(/[^a-z0-9]/g, '') }

// ── Product-Mix sold-name normalizer ──────────────────────────────────────────
// POS/Product-Mix names are verbose & format-laden ("Pepsi, Soda, Mountain Dew, 20 fl oz",
// "20 oz Pepsi_Mug Root Beer_Soda", "Pepsi Soda Original 20 fl oz"), so they score below the
// 0.6 auto bar against terse catalog names ("Pepsi") — the category token "soda" alone drops
// {pepsi,soda} vs {pepsi} to 0.5. This strips the NOISE (category/type words + the leading
// reseller/distributor label) to recover the real product identity BEFORE fuzzy scoring.
// The original name is still stored as the soldAlias — only the SCORING uses the normalized
// form. Applied sold-side only (catalog names are already terse).
//
// SAFETY (never collapse variants): only CATEGORY/TYPE words are dropped. DISTINGUISHING
// tokens — diet, zero, sugar, cherry, and every flavor — are NEVER here (flavors are guarded
// by FLAVOR/isVariantRisk and aren't category words), so "Diet Pepsi" / "Pepsi Zero" /
// "Pepsi Cherry" keep their discriminator and still out-score plain "Pepsi" to their OWN item.
const PM_CATEGORY_FIELD = /^(sodas?|sports ?drinks?|energy ?drinks?|flavored ?waters?|still|sparkling|drinks?|beverages?|juices?|snacks?|waters?)$/i
const PM_CATEGORY_WORD = /\b(sodas?|sparkling|flavored|sports|beverages?|wtr|still)\b/gi
// Soda RESELLERS that lead the comma-format as a distributor label, not the product brand.
// Drop a LEADING distributor field so the product's own brand anchors the match (Diet Pepsi
// → brand "diet" hits catalog "Diet Pepsi"; without this, brand "pepsi" would skip it).
const PM_DISTRIBUTOR = /^(pepsi|coca[- ]?cola|coke|dr\.? ?pepper|keurig)$/i
const pmStripSize = (s) => s.replace(SIZE, ' ').replace(/\b\d+(\.\d+)?\s?(oz|l)\b/gi, ' ')

export function normalizeSoldName(name) {
  let fields = String(name || '').split(/[_,;]+/).map((f) => pmStripSize(f).trim()).filter(Boolean)
  fields = fields.filter((f) => !PM_CATEGORY_FIELD.test(f))                 // drop pure category fields
  if (fields.length > 1 && PM_DISTRIBUTOR.test(fields[0])) fields = fields.slice(1)   // drop leading reseller
  const s = fields.join(' ').replace(PM_CATEGORY_WORD, ' ').replace(/\s+/g, ' ').trim()
  return s || String(name || '').trim()                                    // never return empty
}

// canonicalId: a stable, doc-id-safe slug for a canonical item.
export function canonicalIdFor(name) {
  return String(name || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}

// Diet-class discriminators — sugar-free vs regular is a DIFFERENT product, not a flavor.
// Unlike flavors (symmetric guard), this is ONE-SIDED: if one side is diet/zero and the
// match isn't, never auto-collapse (e.g. "Mtn Dew Zero" must NOT map to plain "Mt. Dew" when
// no zero variant exists — it goes to the manual picker). Tight list, only what's in the data.
const DIET_CLASS = new Set(['diet', 'zero'])

// Variant risk: NEVER auto-map when the two carry distinct discriminators —
//  • FLAVOR (ONE-SIDED): a flavor token on ONE side that the matched other side lacks →
//    different product. Generalized from the old symmetric rule so it also catches the case
//    where only one side names the flavor: "Frappuccino Caramel" vs "Frappuccino Coffee"
//    (caramel unmatched → manual), not just Chobani-peach-vs-strawberry. A flavor counts as
//    matched if an exact OR edit-distance-≤1 counterpart exists (aligns with the C spelling
//    matcher, so "vanilla"/"vanila" don't false-trigger).
//  • DIET-CLASS (one-sided): one side is diet/zero, the match isn't (regular vs sugar-free).
// Either → human decides.
export function isVariantRisk(aTokens, bTokens) {
  const has = (t, set) => set.has(t) || [...set].some((y) => fuzzyTokenMatch(t, y))
  const af = [...aTokens].filter((t) => FLAVOR.test(t))
  const bf = [...bTokens].filter((t) => FLAVOR.test(t))
  const flavorRisk = af.some((t) => !has(t, bTokens)) || bf.some((t) => !has(t, aTokens))
  const ad = [...aTokens].filter((t) => DIET_CLASS.has(t))
  const bd = [...bTokens].filter((t) => DIET_CLASS.has(t))
  const dietRisk = ad.some((t) => !bTokens.has(t)) || bd.some((t) => !aTokens.has(t))
  return !!(flavorRisk || dietRisk)
}

// Best fuzzy match of `name` against candidates [{ id, name }]. Brand-anchored, with the C
// tier: token overlap counts edit-≤1 pairs (fuzzyJaccard — spelling), and an exact de-spaced
// match ("AlaniNu"=="Alani Nu") scores 1 AND bypasses the brand anchor (the concatenation
// "AlaniNu" breaks the brand token, so anchoring would wrongly skip it). variantRisk still
// gates flavor/diet, so a spelling win can't collapse a flavor (Caramel vs Coffee).
export function fuzzyBest(name, candidates) {
  const nt = itemTokens(name), nb = brandOf(name), nd = despace(name)
  let best = 0, match = null, risk = false
  for (const c of candidates) {
    const cd = c._despaced || despace(c.name)
    const despaceHit = nd.length > 4 && nd === cd
    const cb = c._brand || brandOf(c.name)
    if (nb && cb && nb !== cb && !despaceHit) continue      // brand-anchored (de-space exact bypasses)
    const ct = c._tokens || itemTokens(c.name)
    let j = fuzzyJaccard(nt, ct)
    if (despaceHit) j = Math.max(j, 1)
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

// ── B tier — brand-anchor relaxation ──────────────────────────────────────────
// Best match ignoring the brand anchor (order-independent — jaccard is set-based; fuzzy for
// spelling). For sold names whose PRODUCT leads and the VENDOR trails ("Chicken Salad
// Sandwich-Heartland Harvest" vs catalog "Heartland Harvest - Chicken Salad Sandwich") the
// brand anchor blocks the correct match; this finds it.
function brandRelaxedBest(name, candidates) {
  const nt = itemTokens(name)
  let best = 0, match = null, risk = false
  for (const c of candidates) {
    const ct = c._tokens || itemTokens(c.name)
    const j = fuzzyJaccard(nt, ct)
    if (j > best) { best = j; match = c; risk = isVariantRisk(nt, ct) }
  }
  return { score: best, match, variantRisk: risk }
}
// A brand-cross match is SAFE to auto (vs surface as a proposal) only when:
//  (1) every SOLD token is present in the catalog — no sold-side extra like the brand
//      "Schweppes" that the generic catalog "Ginger Ale" lacks (→ uncertain, manual); AND
//  (2) every catalog token the sold lacks is part of the LEADING vendor prefix (the run of
//      tokens before the first shared one — "Heartland Harvest", "Oceanspray", "Starbucks"),
//      NOT a mid-name discriminator ("...Spicy...") (→ regular-vs-spicy, manual).
// Frequency can't separate these (spicy=4 ≈ oceanspray=2); token POSITION can.
export function bTierSafe(soldName, cand) {
  const st = itemTokens(soldName)
  const ctArr = cand._arr || tokenArr(cand.name)
  const inSet = (t, set) => set.has(t) || [...set].some((y) => fuzzyTokenMatch(t, y))
  const ctSet = new Set(ctArr)
  if (![...st].every((t) => inSet(t, ctSet))) return false      // (1) sold-side extra → not safe
  let seenMatch = false
  for (const t of ctArr) {                                       // (2) catalog extras must be leading
    if (inSet(t, st)) seenMatch = true
    else if (seenMatch) return false
  }
  return true
}

// ── Auto-map planner (pure decision, applied by the import path) ───────────────
// Two-stage per sold name:
//   • BRAND-ANCHORED fuzzyBest (+ C spelling/de-space) → classifyMatch → auto/proposal/none.
//   • If not auto, the B TIER: brand-relaxed best. If it clears the threshold, it AUTO-maps
//     only when bTierSafe + not variant-risk (the deli line, Water Life); otherwise it's a
//     high-ranked PROPOSAL (Spicy Chicken Salad, Schweppes Ginger Ale) — surfaced, not guessed.
// Returns the plan — the caller applies writeMapping for 'auto' and stashes the rest.
export function planAutoMap(items, candidates, { alreadyMapped = new Set() } = {}) {
  const auto = [], proposals = [], unmapped = []
  for (const it of items) {
    if (alreadyMapped.has(it.name)) continue
    // Score on it.matchName (the normalized product identity) when provided; the ORIGINAL
    // it.name stays the soldAlias identity. Callers without matchName score on the raw name.
    const matchName = it.matchName ?? it.name
    const fz = fuzzyBest(matchName, candidates)
    let kind = classifyMatch(fz)
    let m = fz.match, score = fz.score, variantRisk = fz.variantRisk
    if (kind !== 'auto') {
      const bz = brandRelaxedBest(matchName, candidates)         // B tier
      if (bz.match && bz.score >= AUTO_MAP_THRESHOLD && bz.score > score) {
        m = bz.match; score = bz.score; variantRisk = bz.variantRisk
        kind = (!bz.variantRisk && bTierSafe(matchName, bz.match)) ? 'auto' : 'proposal'
      }
    }
    const row = { ...it, match: m ? { id: m.id, name: m.name } : null, score, variantRisk, kind }
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

// ── COUNT-side alias bridge ───────────────────────────────────────────────────
// Inventory count docs DON'T carry the numeric catalogItemId — count lines are keyed
// by a per-location name-slug / custom id (verified on real Wesley data: 0/252 count
// lines carry the numeric id; even a name-matched item's count.id="custom_…" ≠
// catalogItemId="18"). So there is NO stable id shared between a count line and the
// itemMap. The only durable bridge is an explicit NAME alias — same pattern as
// soldAliases, but for the COUNT side: countAliases[] records the count-doc name(s)
// that ARE this canonical, so a mapped item attaches its Opening/Closing even when the
// count name differs from the sold/canonical name (e.g. count "Gatorade Lemon Lime" ↔
// canonical "gatorade 20 oz lemon lime"). Consumed only by the shrinkage read (which
// loads all mappings) — no separate index needed, unlike soldAliasIndex.
//
// The join key is itemNameKey (shrinkage.js) — identical slug rule to canonicalIdFor
// here (lowercase, non-alnum → '-'), so a count name that already equals the canonical
// name joins with NO alias (the baseline), and countAliases only EXTEND that to cover
// the names that differ. Kept as canonicalIdFor to avoid importing shrinkage.js.

// Dedup a countAliases list by its name-key, preserving the first original spelling.
export function dedupeCountAliases(aliases) {
  const seen = new Set(), out = []
  for (const a of aliases || []) {
    const name = String(a ?? '').trim()
    if (!name) continue
    const k = canonicalIdFor(name)
    if (!k || seen.has(k)) continue
    seen.add(k)
    out.push(name)
  }
  return out
}

// All count name-keys a canonical currently attaches: its own name + every countAlias.
// (Mirrors the join in computeShrinkageRow — the canonicalName is the baseline key.)
export function countNameKeysFor(mapping) {
  const keys = new Set([canonicalIdFor(mapping.canonicalName)])
  for (const a of mapping.countAliases || []) { const k = canonicalIdFor(a); if (k) keys.add(k) }
  return keys
}

// AUTO-SEED (where safe): a count name whose key ALREADY equals a canonical's name-key
// is unambiguously that item — record it as an explicit countAlias so the attachment is
// durable (survives a canonical rename) and visible, with no manual tap. Returns the
// writes needed: [{ canonicalId, canonicalName, countName }] for exact-name matches not
// already covered. Pure + idempotent — re-running after applying returns []. Only exact
// name-key equality seeds; anything that merely fuzzy-matches stays a manual decision.
export function planCountAliasSeed(mappings, countNames) {
  const byKey = new Map()
  for (const m of mappings || []) byKey.set(canonicalIdFor(m.canonicalName), m)
  const out = []
  const emitted = new Set()
  for (const raw of countNames || []) {
    const name = String(raw ?? '').trim()
    if (!name) continue
    const k = canonicalIdFor(name)
    const m = byKey.get(k)
    if (!m) continue                                   // no canonical with this exact name
    if ((m.countAliases || []).some((a) => canonicalIdFor(a) === k)) continue   // already an alias
    const sig = `${m.canonicalId}__${k}`
    if (emitted.has(sig)) continue
    emitted.add(sig)
    out.push({ canonicalId: m.canonicalId, canonicalName: m.canonicalName, countName: name })
  }
  return out
}

// FUZZY AUTO-SEED — the count-side mirror of planAutoMap (auto the safe, manual the
// ambiguous, no bulk approval queue). For each unattached count name, fuzzy-score it
// against every canonical's NAME + its soldAliases (the same normalized brand-anchored
// matcher the sold side uses), then classify:
//   • auto      : high-confidence (≥AUTO_MAP_THRESHOLD), non-variant, UNAMBIGUOUS →
//                 add to countAliases silently.
//   • proposal  : mid-confidence, OR variant-risk, OR ambiguous → surfaced in the manual
//                 picker as a tap-to-confirm suggestion (NOT auto-attached).
//   • unmapped  : below the floor → stays in the plain unattached list, no suggestion.
//
// TWO guards keep a wrong silent attach from landing:
//   1. VARIANT (isVariantRisk) — same brand, distinct flavor token each side (Chobani
//      peach vs strawberry). Same guard as the sold side.
//   2. AMBIGUITY — normalizeItemName STRIPS size tokens (20 oz / 28 oz both → "gatorade
//      lemon lime"), so the flavor guard can't tell two sizes apart. If ≥2 DISTINCT
//      canonicals tie for the top score, the count name can't be safely assigned → manual.
// Exact-name matches are handled at higher confidence by planCountAliasSeed; this runs on
// the residue. Pure — the caller applies `auto` as writes and feeds `proposals` to the UI.
export function planCountAliasAutoSeed(mappings, countNames) {
  const candidates = []
  for (const m of mappings || []) {
    for (const nm of [m.canonicalName, ...(m.soldAliases || [])]) {
      if (!nm) continue
      candidates.push({ id: m.canonicalId, name: nm, _tokens: itemTokens(nm), _brand: brandOf(nm) })
    }
  }
  const nameById = new Map((mappings || []).map((m) => [m.canonicalId, m.canonicalName]))
  const attached = new Set()
  for (const m of mappings || []) for (const k of countNameKeysFor(m)) attached.add(k)

  const auto = [], proposals = [], unmapped = []
  const seen = new Set()
  for (const raw of countNames || []) {
    const name = String(raw ?? '').trim()
    if (!name) continue
    const key = canonicalIdFor(name)
    if (!key || attached.has(key) || seen.has(key)) continue   // already attached / dup
    seen.add(key)

    const fz = fuzzyBest(name, candidates)
    if (!fz.match || fz.score <= 0) { unmapped.push(name); continue }

    // AMBIGUITY: count distinct canonicals that TIE the top score (brand-anchored, same
    // scan fuzzyBest uses). >1 → the size/variant that would disambiguate was normalized
    // away, so we can't pick safely → manual.
    const nb = brandOf(name), nt = itemTokens(name)
    const topCanonicals = new Set()
    for (const c of candidates) {
      const cb = c._brand || brandOf(c.name)
      if (nb && cb && nb !== cb) continue
      if (jaccard(nt, c._tokens || itemTokens(c.name)) >= fz.score - 1e-9) topCanonicals.add(c.id)
    }
    const ambiguous = topCanonicals.size > 1

    const kind = ambiguous ? 'proposal' : classifyMatch(fz)
    const rec = { canonicalId: fz.match.id, canonicalName: nameById.get(fz.match.id) || fz.match.name, countName: name, score: fz.score, variantRisk: fz.variantRisk, ambiguous }
    if (kind === 'auto') auto.push(rec)
    else if (kind === 'proposal') proposals.push(rec)
    else unmapped.push(name)
  }
  return { auto, proposals, unmapped }
}

// Build the default itemMap doc.
export function newMappingDoc({ canonicalName, catalogItemId = null, soldAliases = [], countAliases = [], purchaseKeys = [], status = 'active', source = 'auto', confidence = null, createdBy = 'unknown' }) {
  return {
    canonicalId: canonicalIdFor(canonicalName),
    canonicalName,
    catalogItemId,
    soldAliases,
    countAliases,                             // count-doc name(s) that ARE this item
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

// Attach/replace a canonical's COUNT aliases. Pass the FULL desired list (existing +
// new) — merge overwrites the array wholesale, same contract as soldAliases. Deduped by
// name-key. No index write: countAliases are read only by the shrinkage load (all
// mappings in memory), so there's nothing to denormalize. Reversible — pass a shorter
// list to detach. A minimal single-doc merge (not writeMapping) so attaching a count
// name doesn't re-walk purchaseKeys/soldAliases indexes.
export async function writeCountAliases(orgId, canonicalId, aliases, actor = 'unknown') {
  await setDoc(doc(db, 'tenants', orgId, 'itemMap', canonicalId),
    { countAliases: dedupeCountAliases(aliases), source: 'manual', updatedBy: actor, updatedAt: serverTimestamp() }, { merge: true })
}

// ── Auto-link counts (Bug 2) ──────────────────────────────────────────────────
// The shared engine that attaches count-doc lines to canonicals via countAliases, so a
// mapped item whose COUNT-line name differs from the canonical name (count "Tropicana
// Apple Juice" vs canonical "tropicana apple juice 10 oz") gets its Opening/Closing
// without a manual tap. TWO confidence tiers, both guarded — the SAME matcher +
// variant/ambiguity guard the CountAliasPicker uses (planCountAliasSeed +
// planCountAliasAutoSeed), one code path so they can't drift:
//   • exact name-key match           → attach (planCountAliasSeed)
//   • high-confidence, non-variant, UNAMBIGUOUS fuzzy → attach (planCountAliasAutoSeed.auto)
//   • ambiguous / variant-risk (the size-suffix "20 oz" vs "28 oz" case) → NOT attached;
//     returned as `proposals` for the manual picker.
// Applies writes and mutates `mappings` in place (so a later location in the same batch
// sees the freshly-attached aliases and dedups). Internal — the exported wrappers below
// load the data and call this.
async function applyCountAliasSeeds(orgId, mappings, countNames, actor) {
  const apply = async (recs) => {
    const byCanonical = new Map()
    for (const r of recs) { const a = byCanonical.get(r.canonicalId) || []; a.push(r.countName); byCanonical.set(r.canonicalId, a) }
    for (const [cid, ns] of byCanonical) {
      const m = mappings.find((x) => x.canonicalId === cid)
      const full = [...(m?.countAliases || []), ...ns]
      if (m) m.countAliases = full                      // in-memory so subsequent tiers/locs skip it
      await writeCountAliases(orgId, cid, full, actor)
    }
    return recs.length
  }
  const nExact = await apply(planCountAliasSeed(mappings, countNames))   // tier 1 (merged first)
  const fuzzy = planCountAliasAutoSeed(mappings, countNames)             // tier 2 (skips tier-1 attaches)
  const nFuzzy = await apply(fuzzy.auto)
  return { linked: nExact + nFuzzy, proposals: fuzzy.proposals }
}

// Auto-link counts for ONE (location, period). Returns { linked, proposals, mappings,
// items } — the picker uses mappings/items to render (single load path, no double-read).
// Count lines key on `name` (verified 252/252 on real data); a nameless line is skipped.
export async function autoLinkCountAliases(orgId, lk, periodKey, actor = 'unknown') {
  const [mapSnap, countDoc] = await Promise.all([
    getDocs(collection(db, 'tenants', orgId, 'itemMap')),
    getDoc(doc(db, 'tenants', orgId, 'locations', lk, 'inventory', periodKey)),
  ])
  const mappings = mapSnap.docs.map((d) => ({ id: d.id, ...d.data() }))
  const items = (countDoc.exists() && countDoc.data().items) || []
  const names = items.filter((i) => i && i.name).map((i) => i.name)
  const { linked, proposals } = names.length
    ? await applyCountAliasSeeds(orgId, mappings, names, actor)
    : { linked: 0, proposals: [] }
  return { linked, proposals, mappings, items }
}

// Auto-link counts across MANY locations at one period, loading the itemMap ONCE (the
// on-map / on-load path in the mapping view, where the sold queue is tenant-wide). A
// countAlias is tenant-global, so a name linked from any location applies everywhere;
// the shared `mappings` accumulates across locations so a name isn't re-attached twice.
export async function autoLinkCountAliasesForLocations(orgId, lks, periodKey, actor = 'unknown') {
  const mapSnap = await getDocs(collection(db, 'tenants', orgId, 'itemMap'))
  const mappings = mapSnap.docs.map((d) => ({ id: d.id, ...d.data() }))
  let linked = 0
  for (const lk of lks || []) {
    const countDoc = await getDoc(doc(db, 'tenants', orgId, 'locations', lk, 'inventory', periodKey))
    const items = (countDoc.exists() && countDoc.data().items) || []
    const names = items.filter((i) => i && i.name).map((i) => i.name)
    if (!names.length) continue
    const r = await applyCountAliasSeeds(orgId, mappings, names, actor)
    linked += r.linked
  }
  return { linked }
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
//
// locationCatalogIds: the locIds whose PER-LOCATION catalog (inventory/{lk}/items) to add
// to the candidate pool — UNION with the global inventoryCatalog + existing canonicals,
// never a replace (global matches other locations rely on stay available). A location's
// real products (Starry, Alani flavors, the deli line) live in its own catalog, NOT the
// global one — so matching there is what lifts coverage, AND the matched name IS the count
// line's name (name-key join works with no alias) and its id IS the count's id. Verified on
// real Wesley data: top-30 sellers 0 → 16 auto-map from this alone. Variant guard +
// threshold unchanged (planAutoMap): still never auto-maps across a size/flavor difference.
export async function autoMapSoldItems(orgId, soldNames, actor = 'unknown', locationCatalogIds = []) {
  const mappings = await loadMappings(orgId)
  const alreadyMapped = new Set()
  for (const m of mappings) for (const a of m.soldAliases || []) alreadyMapped.add(a)

  const mkCand = (id, nm) => ({ id, name: nm, _tokens: itemTokens(nm), _brand: brandOf(nm) })
  const catSnap = await getDocs(collection(db, 'tenants', orgId, 'inventoryCatalog'))
  const globalCands = catSnap.docs.map((d) => { const x = d.data(); return mkCand(d.id, x.name || x.itemName || d.id) })

  // Per-location catalog(s) — the catalog the COUNTS come from. Skip removed items.
  const locCands = []
  for (const lk of [...new Set(locationCatalogIds)].filter(Boolean)) {
    const locSnap = await getDocs(collection(db, 'tenants', orgId, 'inventory', lk, 'items'))
    locSnap.forEach((d) => { const x = d.data(); if (x.removed) return; const nm = x.name || x.itemName || d.id; if (nm) locCands.push(mkCand(d.id, nm)) })
  }

  const canonCands = mappings.map((m) => ({ ...mkCand(m.canonicalId, m.canonicalName), _canonical: true }))
  // Order: global → location → canonicals. For the coverage-lift items global scores 0
  // (they're not in it), so location wins → canonicalName == count name. canonicalId-merge
  // in the write loop dedups by name, so an existing canonical isn't duplicated.
  const candidates = [...globalCands, ...locCands, ...canonCands]

  // Score on the normalized product identity (strips category/format noise) but keep the
  // ORIGINAL name as the soldAlias — the sold-feed join matches on the raw itemName.
  const items = [...new Set(soldNames)].map((name) => ({ name, matchName: normalizeSoldName(name) }))
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
