// Parser for the "Cafe Product Mix" export → the SOLD feed (Increment 1).
//
// Shape (verified against the real 11-column export, "Cafe Product Mix (2).xlsx"):
//   Site | Account Internal Name | Restaurant | Item Name | Weekday of Event Date | <6 week columns>
//   - Site/Account/Restaurant/Item are FILL-DOWN (blank = same as the row above).
//   - Per item, one "Total" row then Monday…Friday weekday rows.
//   - Week columns are "Week of Event Date" SUNDAYS (Jun 7, 14, 21, 28, Jul 5, 12).
//
// FISCAL-SAFE rule (the reason we read weekday rows, not the per-week Total):
//   Fooda fiscal weeks are chopped at the month boundary, but the report's week
//   columns are calendar Sun–Sat. The "June 28" column spans Jun 28–Jul 4, which
//   straddles P06/P07 — its Total can't be assigned to one fiscal week. So we
//   expand each WEEKDAY cell to its real date (week-start Sunday + weekday offset),
//   run it through the canonical dateToKey, and sum by fiscal periodKey. The Total
//   row is used only as a CHECKSUM. dateToKey is imported (not re-implemented) so
//   this never becomes a 4th drifting copy of the fiscal calendar.
import { dateToKey as canonicalDateToKey } from '@/store/PeriodContext'

// ── Account Internal Name → Aurelia locId (a BUSINESS RULE, not a heuristic) ──
// The 9 café accounts resolve to the 6 locIds the pnl/inventory docs already use
// (Cafe_AZ/Q/S/WT, CR_QualcommBoulder, CR_QualcommSantaClara — verified live). The
// three retail-only satellites are lumped into their parent café per Troy:
//   AY → AZ,  N → S,  R → Q.
// Because the row loop accumulates by (locId, periodKey, itemSlug), a satellite's
// units are SUMMED with its parent's for the same item+period automatically.
export const ACCOUNT_TO_CAFE = {
  'Qualcomm - Boulder':        'CR_QualcommBoulder',
  'Qualcomm Santa Clara':      'CR_QualcommSantaClara',
  'Qualcomm - San Diego AZ':   'Cafe_AZ',
  'Qualcomm San Diego - AY':   'Cafe_AZ',   // AY (retail satellite) → AZ
  'Qualcomm - San Diego - S':  'Cafe_S',
  'Qualcomm - San Diego - N':  'Cafe_S',    // N  (retail satellite) → S
  'Qualcomm - San Diego - Q':  'Cafe_Q',
  'Qualcomm San Diego - R':    'Cafe_Q',    // R  (retail satellite) → Q
  'Qualcomm - San Diego - WT': 'Cafe_WT',
}

// Resolve an account name → locId, or null when unmapped (surfaced, never dropped
// silently — an unmapped account means the map needs a new entry, fail loud).
export function resolveCafe(accountName) {
  return ACCOUNT_TO_CAFE[String(accountName || '').trim()] || null
}

// Stable doc-id-safe slug for an item name (the salesItems doc key).
export function itemSlug(name) {
  return String(name || '').toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}

// The salesItems write path — keyed by the SAME locId the counts use so SOLD lines
// up with COUNTED at reconciliation time.
export function salesItemPath(orgId, locId, periodKey, slug) {
  return `tenants/${orgId}/salesItems/${locId}/periods/${periodKey}/items/${slug}`
}

const WEEKDAY_OFFSET = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 }

// (week-start Sunday label, e.g. "June 28, 2026") + weekday name → real Date.
export function weekdayDate(weekStartLabel, weekdayName) {
  const base = new Date(String(weekStartLabel || '').trim())
  if (isNaN(base.getTime())) return null
  const off = WEEKDAY_OFFSET[String(weekdayName || '').trim().toLowerCase()]
  if (off == null) return null
  const d = new Date(base.getFullYear(), base.getMonth(), base.getDate() + off, 12, 0, 0)
  return d
}

// Parse the sheet (array-of-arrays; header at row index 1, data from index 2) →
//   { items: [{ locId, periodKey, itemName, itemSlug, qtySold, weekdayBreakdown }],
//     checksumTotal, weekdaySum, unmappedAccounts, weekLabels }
// dateToKey is injectable purely for testing; production/app use the canonical one.
export function parseCafeProductMix(rows, { dateToKey = canonicalDateToKey } = {}) {
  if (!rows || rows.length < 3) throw new Error('Cafe Product Mix: sheet too short — expected a header row + data')
  const header = rows[1]
  const findCol = (re) => header.findIndex((h) => re.test(String(h || '')))
  const siteC = findCol(/^site$/i)
  const acctC = findCol(/account internal name/i)
  const restC = findCol(/^restaurant$/i)
  const itemC = findCol(/item name/i)
  const wdC   = findCol(/weekday/i)
  if (acctC < 0 || itemC < 0 || wdC < 0) {
    throw new Error(`Cafe Product Mix: missing expected columns (account=${acctC}, item=${itemC}, weekday=${wdC}). Wrong report?`)
  }
  const weekCols = []
  for (let c = wdC + 1; c < header.length; c++) if (header[c] != null && String(header[c]).trim() !== '') {
    weekCols.push({ c, label: String(header[c]).trim() })
  }

  const out = new Map()               // `${locId}__${periodKey}__${slug}` → record
  const unmapped = new Map()          // accountName → qty (surfaced)
  let checksumTotal = 0, weekdaySum = 0
  let site = null, acct = null, rest = null, item = null

  const ff = (r, c, cur) => (c >= 0 && r[c] != null && String(r[c]).trim() !== '' ? String(r[c]).trim() : cur)

  for (let i = 2; i < rows.length; i++) {
    const r = rows[i]; if (!r) continue
    site = ff(r, siteC, site); acct = ff(r, acctC, acct); rest = ff(r, restC, rest); item = ff(r, itemC, item)
    const wd = r[wdC] != null ? String(r[wdC]).trim() : ''
    if (!wd) continue

    if (wd === 'Total') {                 // checksum only — never summed into the feed
      for (const w of weekCols) { const v = parseFloat(r[w.c]); if (!isNaN(v)) checksumTotal += v }
      continue
    }

    const locId = resolveCafe(acct)
    if (!locId) {                         // unmapped account → surface, don't drop
      let uq = 0; for (const w of weekCols) { const v = parseFloat(r[w.c]); if (!isNaN(v)) uq += v }
      if (uq) unmapped.set(acct, (unmapped.get(acct) || 0) + uq)
      continue
    }

    for (const w of weekCols) {
      const v = parseFloat(r[w.c]); if (isNaN(v) || v === 0) continue
      const date = weekdayDate(w.label, wd); if (!date) continue
      const periodKey = dateToKey(date); if (!periodKey) continue
      weekdaySum += v
      const slug = itemSlug(item)
      const key = `${locId}__${periodKey}__${slug}`
      let rec = out.get(key)
      if (!rec) { rec = { locId, periodKey, itemName: item, itemSlug: slug, qtySold: 0, weekdayBreakdown: {} }; out.set(key, rec) }
      rec.qtySold += v
      const dk = wd.toLowerCase()
      rec.weekdayBreakdown[dk] = (rec.weekdayBreakdown[dk] || 0) + v
    }
  }

  return {
    items: [...out.values()],
    checksumTotal,
    weekdaySum,
    unmappedAccounts: [...unmapped.entries()].map(([account, qty]) => ({ account, qty })),
    weekLabels: weekCols.map((w) => w.label),
  }
}
