// Vendor-robust invoice line-item extraction (shrinkage +Purchased feed).
//
// The MODEL (Claude, via the PDF parse) does the raw extraction using the prompt
// below; the PURE HELPERS here recompute eaches, apply the two disambiguation rules
// Troy set, and validate the parse against the invoice's own checksums. Split this
// way so the money-path logic is unit-testable without an API call.
//
// Scoped against 4 real distributor formats (Sysco, Reyes Coca-Cola, Nassau Candy,
// RTZN) — see scripts/test-parse-invoices.mjs for the live parse harness.
//
// Per-line extraction target:
//   { itemCode, upc, casesOrdered, packCount, eachesPerCase, size, description,
//     unitPrice, total, eachesTotal, warnings[] }
//   eachesTotal = casesOrdered × packCount  (the +Purchased number, in eaches)

// ── The prompt ────────────────────────────────────────────────────────────────
// Teaches the model each vendor's pack pattern + the item-code/UPC locations.
// max_tokens must be generous — a 28-line Sysco invoice with this richer schema
// overruns the old 2000-token cap (callers should use >=4096).
export const INVOICE_LINES_PROMPT = `Extract EVERY line item from this distributor invoice as structured data.

First identify the VENDOR from the header — one of: "sysco", "reyes_coca_cola",
"nassau_candy", "rtzn", or "other". Return it as vendor.

For EACH line item return:
- itemCode: the vendor's stable per-line SKU / item number / MAT#. If the line has NO
  distinct code (only a product name or activity label), return "" — do NOT invent one
  and do NOT use the description as the code.
- upc: the 11-13 digit UPC/barcode if the line shows one, else "".
- casesOrdered: the QTY column value (number of cases/units ordered).
- packCount: eaches (consumer-sellable units) per case. Extract from wherever the pack
  is stated — it appears FOUR different ways depending on vendor:
    * Sysco: a PACK number fused to the SIZE and the next word in the raw text, e.g.
      "641.5 OZLAYS" = packCount 64, size "1.5 OZ", description "LAYS…";
      "20002 OZ" = packCount 2000, size "2 OZ"; "200.5 OZ KIKOMAN" = packCount 200.
    * Reyes Coca-Cola: a category header line ending "…1-Ls 24" and a bare number
      printed under the UPC line = packCount 24.
    * Nassau Candy: embedded in the description as "{size}-{CT}CT-{N}/CS", e.g.
      "1.4OZ-12CT-6/CS" = size "1.4OZ", packCount = CT × N = 12 × 6 = 72.
    * RTZN: a parenthetical "(6ct)" / "(12ct)" in the description line.
  If packCount is genuinely NOT determinable from the line, return null and add
  "pack unresolved" to that line's warnings — do NOT guess.
- eachesPerCase: same as packCount (the per-case each count) — return the value you used.
- size: the unit size (e.g. "1.5 OZ", "500ML"), separated out of the description.
- description: the product name WITH pack/size/code tokens removed (brand + product).
- unitPrice: the unit/case price column.
- total: the extended $ for the line.
- warnings: array of strings, [] if none.

Also return invoice-level fields:
- vendor, invoiceNumber, invoiceDate (YYYY-MM-DD)
- subtotal: the pre-tax, pre-freight SUBTOTAL / SALE AMOUNT (the sum of line totals),
  NOT the grand total that adds tax/freight/cold-pack/surcharges.
- tax, total (grand total)
- netConsumerQty: if the invoice prints a total consumer/each quantity checksum
  (e.g. Reyes category subtotals like "3/72" summing to a net each count), return that
  total each-count; else null.
- glCode: best GL from {cogs_food, cogs_supplies, cogs_paper, cogs_cleaning} for a
  distributor food/supply invoice (most distributor lines are cogs_food).

Return ONLY valid JSON, no markdown, no backticks:
{"vendor":"","invoiceNumber":"","invoiceDate":"","subtotal":0,"tax":0,"total":0,"netConsumerQty":null,"glCode":"","lineItems":[{"itemCode":"","upc":"","casesOrdered":0,"packCount":null,"eachesPerCase":null,"size":"","description":"","unitPrice":0,"total":0,"warnings":[]}]}`

// ── Vendor normalization ──────────────────────────────────────────────────────
const VENDOR_ALIASES = [
  [/sysco/i, 'sysco'],
  [/reyes|coca[- ]?cola/i, 'reyes_coca_cola'],
  [/nassau/i, 'nassau_candy'],
  [/rtzn|righteous\s*felon/i, 'rtzn'],
]
export function normalizeVendor(raw) {
  const s = String(raw || '')
  for (const [re, key] of VENDOR_ALIASES) if (re.test(s)) return key
  return (s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_')) || 'other'
}

const money = (v) => Number(v) || 0
// Reconciliation tolerance: 1¢ or 0.5%, whichever is larger (rounding on unit prices).
const within = (a, b) => Math.abs(money(a) - money(b)) <= Math.max(0.02, 0.005 * Math.abs(money(b)))

// ── Per-line enrichment: recompute eaches + apply the two disambiguation rules ──
// Rule 1 (Nassau BX/CS): eachesPerCase = CT × (N/CS) from the model, but the pricing
//   reconciliation is the tiebreaker — unitPrice(per CS) × casesOrdered must ≈ total.
//   If it can't be reconciled, casesOrdered is untrustworthy → flag "pack unresolved".
// Rule 2 (missing code): no clean itemCode → flag "code unresolved" for one-time human
//   mapping. NEVER fall back to description-as-key (that is fuzzy matching in disguise).
export function enrichLine(line, vendor) {
  const warnings = Array.isArray(line.warnings) ? [...line.warnings] : []
  const cases = line.casesOrdered == null ? null : Number(line.casesOrdered)
  let packCount = line.packCount == null ? null : Number(line.packCount)

  // Rule 1 — Nassau pricing tiebreaker for the BX-vs-CS ambiguity.
  if (vendor === 'nassau_candy' && packCount != null && cases != null) {
    const pricingReconciles = within(money(line.unitPrice) * cases, line.total)
    if (!pricingReconciles) {
      warnings.push('pack unresolved (BX/CS not reconciled by unitPrice × cases ≠ total)')
      packCount = null
    }
  }

  const eachesTotal = (packCount != null && cases != null) ? cases * packCount : null
  if (eachesTotal == null && !warnings.some((w) => w.startsWith('pack unresolved'))) {
    warnings.push('pack unresolved')
  }

  // Rule 2 — code-unresolved flag (no description fallback).
  const code = String(line.itemCode || '').trim()
  const codeUnresolved = code === ''
  if (codeUnresolved && !String(line.upc || '').trim()) warnings.push('code unresolved')

  return {
    itemCode: code,
    upc: String(line.upc || '').trim(),
    casesOrdered: cases,
    packCount,
    eachesPerCase: packCount,
    size: line.size || '',
    description: line.description || '',
    unitPrice: money(line.unitPrice),
    total: money(line.total),
    eachesTotal,
    codeUnresolved,
    warnings,
  }
}

// ── Invoice-level validation against the invoice's OWN checksums ───────────────
//   money:  Σ line totals ≈ SUBTOTAL / SALE AMOUNT (never the grand total).
//   eaches: Σ eachesTotal ≈ netConsumerQty checksum (Reyes), when present.
export function validateInvoice(parsed, lines) {
  const sumTotals = lines.reduce((s, l) => s + money(l.total), 0)
  const subtotalTarget = money(parsed.subtotal)
  const sumEaches = lines.reduce((s, l) => s + (l.eachesTotal || 0), 0)
  const eachesTarget = parsed.netConsumerQty == null ? null : Number(parsed.netConsumerQty)

  return {
    sumTotals: Math.round(sumTotals * 100) / 100,
    subtotalTarget,
    subtotalOk: subtotalTarget > 0 ? within(sumTotals, subtotalTarget) : null,
    sumEaches,
    eachesTarget,
    eachesOk: eachesTarget != null ? Math.abs(sumEaches - eachesTarget) <= Math.max(1, 0.02 * eachesTarget) : null,
    linesPackUnresolved: lines.filter((l) => l.warnings.some((w) => w.startsWith('pack unresolved'))).length,
    linesCodeUnresolved: lines.filter((l) => l.codeUnresolved && !l.upc).length,
  }
}

// Convenience: enrich all lines + validate in one call.
export function processInvoice(parsed) {
  const vendor = normalizeVendor(parsed.vendor)
  const lines = (parsed.lineItems || []).map((l) => enrichLine(l, vendor))
  return { vendor, lines, validation: validateInvoice(parsed, lines) }
}
