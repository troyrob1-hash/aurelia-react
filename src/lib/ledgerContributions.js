// src/lib/ledgerContributions.js
//
// PHASE (JE→P&L bridge) · GATE 1 — read-time model (a). pnl docs NEVER carry a JE
// amount; a JE-derived GL line is ALWAYS the live sum of every JE targeting that
// (location, week, GL), computed fresh — structurally incapable of drifting from
// its sources (same architecture as computeRevenue / computeOnsiteLabor).
//
// DAILY PRORATION. A fiscal year has 61–63 Sun–Sat buckets (month-chopping splits
// boundary weeks), NOT 52 — so amortization prorates by DAYS, never a flat
// per-bucket divide. An amortizing JE's contribution to a fiscal week =
//   (days of the JE's window that fall in that week) × (amount / window_days)
// window_days: annual = 364 (=52×7 → a full 7-day week = annual/52 = $1,538.46 on
// $80k), quarterly = 91 (=13×7), monthly = the actual days of its N-month span.
// A month-boundary week chopped to N days gets N/7 of a week's pay; its sibling
// stub gets the rest — the two sum to exactly one week. No rounding here (raw
// floats) so a full window sums to the amount with zero penny drift; round only
// at display.

import { collection, getDocs } from 'firebase/firestore'
import { db } from './firebase'
import { locId, weeksInPeriod } from './pnl'
import { getPeriodWeeks } from '@/store/PeriodContext'

// serial day number (UTC midnight) — integer, for clean inclusive-day overlap.
// ── Fetch is SEPARATE from compute. jeContribution / rollups are pure math on an
// already-fetched JE list; this is the only place that touches Firestore. A short
// TTL dedupes the many per-(loc,week) reads a single Dashboard render triggers
// (sparkline ~13 weeks + current + prior + scenario) into ONE query. JEs change
// rarely; call invalidateLedgerJEs() after creating/editing one to force a refetch.
let _jeCache = null, _jeCacheAt = 0
export function invalidateLedgerJEs() { _jeCache = null }
export async function getLedgerJEs(orgId = 'fooda') {
  const now = Date.now()
  if (_jeCache && (now - _jeCacheAt) < 15000) return _jeCache
  _jeCache = (await getDocs(collection(db, 'tenants', orgId, 'journalEntries'))).docs.map(d => d.data())
  _jeCacheAt = now
  return _jeCache
}

const serialOf = (y, m, d) => Math.floor(Date.UTC(y, m - 1, d) / 86400000)
const serialDate = (dt) => serialOf(dt.getFullYear(), dt.getMonth() + 1, dt.getDate())
const parseYMD = (s) => { const m = String(s || '').match(/(\d{4})-(\d{2})-(\d{2})/); return m ? { y: +m[1], mo: +m[2], d: +m[3] } : null }
const overlapDays = (aS, aE, bS, bE) => Math.max(0, Math.min(aE, bE) - Math.max(aS, bS) + 1)


// Year-chaining (fiscalYearAnchor / nextAnnualWindowStart) was RETIRED with the
// unified JE model — windows are now explicit finite N-month spans anchored to the
// entry period (see jeContribution), so a salary is just a 50410 JE over 12 months,
// re-entered each year rather than auto-chained.

// fiscal-week [start,end] serials for a periodKey (via the ONE calendar source).
export function weekRangeOf(periodKey) {
  const m = String(periodKey).match(/(\d{4})-P(\d{2})-W(\d+)/); if (!m) return null
  const y = +m[1], p = +m[2], w = +m[3]
  const weeks = getPeriodWeeks(y, p); const wk = weeks[w - 1]; if (!wk) return null
  return { start: serialDate(wk.start), end: serialDate(wk.end), y, p, w }
}

// the fiscal week (serial bounds + key) that contains a given serial day.
function weekContaining(serial) {
  const dt = new Date(serial * 86400000)
  const y = dt.getUTCFullYear(), mo = dt.getUTCMonth() + 1
  const weeks = getPeriodWeeks(y, mo)
  for (let i = 0; i < weeks.length; i++) {
    const s = serialDate(weeks[i].start), e = serialDate(weeks[i].end)
    if (serial >= s && serial <= e) return { start: s, end: e, key: `${y}-P${String(mo).padStart(2, '0')}-W${i + 1}` }
  }
  return null
}

function windowDays(je, startSerial) {
  if (je.amortization === 'annual') return 364
  if (je.amortization === 'quarterly') return 91
  if (je.amortization === 'monthly') {
    const n = parseInt(je.amortMonths) || 1
    const st = parseYMD(je.windowStartDate); if (!st) return 0
    return serialOf(st.y, st.mo + n, st.d) - startSerial   // actual days across N months
  }
  return 0
}

// PURE. One JE's contribution (a number; negative for reversals) to one fiscal
// week [weekStart,weekEnd] (serials). glCode lives on the JE.
export function jeContribution(je, weekStart, weekEnd) {
  if (!je || je.status === 'reversed') return 0
  const amt = Number(je.totalAmount) || 0
  if (!amt) return 0

  // ── UNIFIED model: entryPeriod (a periodKey) + amortizeMonths (0/blank = once). ──
  // The window STARTS at the entry period's fiscal-week start and runs N calendar
  // months forward, daily-prorated (days-in-week × amount/window_days). Conserves to
  // the penny, boundary weeks split, and it FALLS TO 0 after the window ends — no
  // start-date picker, no year-chaining. Behavior is glCode-driven, not type-driven.
  if (je.entryPeriod) {
    const ew = weekRangeOf(je.entryPeriod); if (!ew) return 0
    const n = parseInt(je.amortizeMonths) || 0
    if (n <= 0) return ew.start === weekStart ? amt : 0            // once — full amount in the entry week
    const dt = new Date(ew.start * 86400000)
    const endEx = Math.floor(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth() + n, dt.getUTCDate()) / 86400000)
    const wd = endEx - ew.start; if (wd <= 0) return 0             // calendar days across the N-month span
    return overlapDays(ew.start, ew.start + wd - 1, weekStart, weekEnd) * (amt / wd)
  }

  // ── LEGACY fallback (pre-unified JEs: salary FJE / 3rd-party with amortization + ──
  // windowStartDate/entryDate). Kept so existing entries keep resolving; new entries
  // always carry entryPeriod and take the branch above.
  if (je.amortization === 'once') {
    const ed = parseYMD(je.entryDate) || parseYMD(je.windowStartDate); if (!ed) return 0
    const e = serialOf(ed.y, ed.mo, ed.d)
    let c = 0
    if (e >= weekStart && e <= weekEnd) c += amt                       // full amount in entry week
    if (je.autoReverse) {                                              // negative in the NEXT fiscal week
      const entryWk = weekContaining(e)
      const nextWk = entryWk && weekContaining(entryWk.end + 1)
      if (nextWk && nextWk.start === weekStart && nextWk.end === weekEnd) c += -amt
    }
    return c
  }

  if (je.amortization === 'annual' || je.amortization === 'quarterly' || je.amortization === 'monthly') {
    const st = parseYMD(je.windowStartDate); if (!st) return 0
    const startSerial = serialOf(st.y, st.mo, st.d)
    const wd = windowDays(je, startSerial); if (wd <= 0) return 0
    const endSerial = startSerial + wd - 1
    const daily = amt / wd
    return overlapDays(startSerial, endSerial, weekStart, weekEnd) * daily   // days × daily — no rounding
  }

  if (je.amortization === 'recurring') {
    const st = parseYMD(je.windowStartDate); if (!st) return 0
    if (weekStart < serialOf(st.y, st.mo, 1)) return 0                 // only from the start month forward
    const dt = new Date(weekStart * 86400000)
    const daysInMonth = new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth() + 1, 0)).getUTCDate()
    return (weekEnd - weekStart + 1) * (amt / daysInMonth)             // `amount` per period, day-spread
  }

  return 0
}

// LIVE sum of every JE's contribution to (locId, periodKey), keyed by glCode.
// Nothing is written to pnl — derived fresh on every read. Accepts pre-fetched
// JE docs (jeDocs) to avoid re-reading for a monthly roll-up across weeks.
export async function computeLedgerContributions(locIdArg, periodKey, orgId = 'fooda', jeDocs = null) {
  const wr = weekRangeOf(periodKey); if (!wr) return {}
  const jes = jeDocs || (await getLedgerJEs(orgId))
  const out = {}
  for (const je of jes) {
    if (je.location && je.location !== 'all' && locId(je.location) !== locIdArg) continue  // location scope
    const c = jeContribution(je, wr.start, wr.end)
    if (c !== 0) out[je.glCode] = (out[je.glCode] || 0) + c
  }
  return out
}

// Sum contributions across MANY locations (the All-Locations aggregate), fetching
// the JE set once. locIds = sanitized ids; returns { [glCode]: total }.
export async function ledgerContributionsMulti(locIds, periodKey, orgId = 'fooda') {
  const jeDocs = await getLedgerJEs(orgId)
  const keys = /-MONTHLY$/.test(periodKey)
    ? (() => { const m = String(periodKey).match(/(\d{4})-P(\d{2})/); const y = +m[1], p = +m[2]; return Array.from({ length: weeksInPeriod(y, p) }, (_, i) => `${y}-P${String(p).padStart(2, '0')}-W${i + 1}`) })()
    : [periodKey]
  const set = new Set(locIds)
  const out = {}
  for (const wk of keys) {
    const wr = weekRangeOf(wk); if (!wr) continue
    for (const je of jeDocs) {
      if (je.location && je.location !== 'all' && !set.has(locId(je.location))) continue
      const c = jeContribution(je, wr.start, wr.end)
      if (c !== 0) out[je.glCode] = (out[je.glCode] || 0) + c
    }
  }
  return out
}

// Dispatch for a period key: a week key returns that week; a '…-MONTHLY' key sums
// every week in the month (matching usePnL's monthly aggregation). Fetches the JE
// set ONCE and reuses it across the month's weeks.
export async function ledgerContributionsForPeriod(locIdArg, periodKey, orgId = 'fooda') {
  const jeDocs = await getLedgerJEs(orgId)
  const m = String(periodKey).match(/(\d{4})-P(\d{2})/); if (!m) return {}
  if (!/-MONTHLY$/.test(periodKey)) return computeLedgerContributions(locIdArg, periodKey, orgId, jeDocs)
  const y = +m[1], p = +m[2]; const n = weeksInPeriod(y, p); const out = {}
  for (let w = 1; w <= n; w++) {
    const wk = `${y}-P${String(p).padStart(2, '0')}-W${w}`
    const c = await computeLedgerContributions(locIdArg, wk, orgId, jeDocs)
    for (const [gl, amt] of Object.entries(c)) out[gl] = (out[gl] || 0) + amt
  }
  return out
}
