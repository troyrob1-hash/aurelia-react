// Count-sheet upload: column resolution + catalog matching.
//
// Extracted from Inventory.jsx's parseCountFile so the money-path column aliases
// and item-match keying are unit-testable (mirrors resolveOfficialLine in
// parseOfficialPnl.js). The component reads the file/preview; these are the pure
// decisions — which header is the count column, and which catalog item a row hits.
//
// COLUMN MATCHING is letters-only (strip every non-letter, lowercase) then EXACT
// set membership. That is whitespace/punctuation-tolerant ("Packs on Hand" ==
// "packs  on-hand" == "PACKS ON HAND" -> "packsonhand") while still refusing the
// adjacent cost columns: "Pack Cost" -> "packcost" and "Unit Cost" -> "unitcost"
// are NOT in the count sets, so they can never be mistaken for a count column.

const lettersOnly = (h) => String(h ?? '').toLowerCase().replace(/[^a-z]/g, '')

const NAME_ALIASES = new Set(['item', 'name', 'description', 'itemname', 'product'])
const UPC_ALIASES = new Set(['upc', 'barcode', 'sku', 'gtin'])
// Packs/cases count. "packsonhand" and "packs" added for the Wings_Inv_Item sheet.
const CASES_ALIASES = new Set(['cases', 'case', 'qty', 'quantity', 'count', 'counted', 'packs', 'packsonhand'])
// Eaches/loose-units count. "unitsonhand" added; "units"/"each"/"loose" were already accepted.
const EACHES_ALIASES = new Set(['eaches', 'each', 'units', 'loose', 'unitsonhand'])

// UPC/SKU normalized to bare digits (empty string when there is none). A 12-digit
// UPC is within JS safe-integer range, so XLSX hands it back as the number
// 810035110489 and String() gives "810035110489" — no scientific-notation loss.
export function normUpc(v) {
  return String(v ?? '').replace(/\D/g, '')
}

// Same slug the catalog uses to key item docs, so an uploaded row matches the way
// items were imported (kept in lockstep with Inventory.jsx's item-doc id builder).
export function nameSlug(n) {
  return String(n || '').trim()
    .replace(/[^a-zA-Z0-9\s]/g, '').replace(/\s+/g, '_').toLowerCase().slice(0, 80)
}

// Resolve the four columns we care about from the header row. Returns the ORIGINAL
// header strings (so row[col] works) or null for any not present.
//
// PRECEDENCE: the packs set and the eaches set are DISJOINT, so a packs column and
// an eaches column never collide with each other. Within one group, if a sheet
// carries two synonyms (e.g. both "Eaches" and "Units on Hand"), the LEFTMOST
// matching column wins — deterministic for a given sheet. Old sheets (Cases/Eaches)
// and the new Wings sheet (Packs on Hand/Units on Hand) each name only one column
// per group, so in practice there is nothing to disambiguate.
export function resolveCountColumns(headers) {
  const pick = (set) => headers.find((h) => set.has(lettersOnly(h))) || null
  return {
    nameCol: pick(NAME_ALIASES),
    upcCol: pick(UPC_ALIASES),
    casesCol: pick(CASES_ALIASES),
    eachesCol: pick(EACHES_ALIASES),
  }
}

// Build UPC / slug / name lookups from the location's loaded catalog items.
export function buildCatalogIndex(items) {
  const bySku = {}, bySlug = {}, byName = {}
  for (const it of items || []) {
    const sku = normUpc(it.sku)
    if (sku) bySku[sku] = it
    bySlug[nameSlug(it.name)] = it
    byName[String(it.name || '').toLowerCase().trim()] = it
  }
  return { bySku, bySlug, byName }
}

// Attach one uploaded row to a catalog item. UPC wins (stable identity), then the
// name slug, then a plain lowercased-name match. matchedBy names which key hit.
export function matchCountRow(row, cols, index) {
  const upc = cols.upcCol ? normUpc(row[cols.upcCol]) : ''
  if (upc && index.bySku[upc]) return { item: index.bySku[upc], matchedBy: 'upc', rawName: String(row[cols.nameCol] ?? '').trim() }
  const rawName = String(row[cols.nameCol] ?? '').trim()
  if (!rawName) return { item: null, matchedBy: null, rawName: '' }
  const slugHit = index.bySlug[nameSlug(rawName)]
  if (slugHit) return { item: slugHit, matchedBy: 'slug', rawName }
  const nameHit = index.byName[rawName.toLowerCase().trim()]
  if (nameHit) return { item: nameHit, matchedBy: 'name', rawName }
  return { item: null, matchedBy: null, rawName }
}
