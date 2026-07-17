// Shared P&L data writer
// All modules write here → Dashboard reads from here
// Path: tenants/{orgId}/pnl/{locId}/{period}
// Period: '2026-W14' (weekly) or '2026-04' (monthly)

import { db } from './firebase'
import { doc, setDoc, getDoc, onSnapshot, serverTimestamp, collection, query, where, getDocs, documentId } from 'firebase/firestore'
import { useAuthStore } from '@/store/authStore'

// Legacy fallback commission rate (0.18). This was an INVENTED constant — the
// budget workbook shows real commission is ~23% popup / ~19% catering. Kept only
// as the fail-open fallback inside getRates() when settings/rates is unreadable.
export const DEFAULT_COMMISSION_RATE = 0.18

// ── Configurable contract-term rates ────────────────────────────────────────
// Commission (popup/catering) and retail tax live at tenants/{org}/settings/rates,
// with optional per-location overrides on the location doc (orgs/{org}/locations
// where name == location, field `rates`). Directors/VPs/admins edit them (rule:
// settings/rates). Memoized per session. FAIL-OPEN: a missing/unreadable settings
// doc falls back to the prior constants so saving a sales week never blocks on
// config (logs a warning so the fallback is visible, not silent).
const RATE_FALLBACK = Object.freeze({
  commissionRatePopup: DEFAULT_COMMISSION_RATE,     // 0.18 (legacy)
  commissionRateCatering: DEFAULT_COMMISSION_RATE,  // 0.18 (legacy)
  retailTaxRate: 0.077,                             // prior hardcoded retail tax
})
let _ratesTenant = null
const _ratesByLoc = {}
// Test/seed hook — drop the memo so a fresh read picks up an edited settings doc.
export function _clearRatesCache() { _ratesTenant = null; for (const k in _ratesByLoc) delete _ratesByLoc[k] }

export async function getRates(location) {
  if (!_ratesTenant) {
    try {
      const snap = await getDoc(doc(db, 'tenants', _getOrgId(), 'settings', 'rates'))
      if (snap.exists()) {
        _ratesTenant = { ...RATE_FALLBACK, ...snap.data() }
      } else {
        console.warn('getRates: tenants/*/settings/rates missing — using fallback', RATE_FALLBACK)
        _ratesTenant = { ...RATE_FALLBACK }
      }
    } catch (e) {
      console.warn('getRates: settings/rates unreadable — using fallback:', e?.message)
      _ratesTenant = { ...RATE_FALLBACK }
    }
  }
  if (!location) return _ratesTenant
  if (_ratesByLoc[location] !== undefined) return _ratesByLoc[location]
  let merged = _ratesTenant
  try {
    const q = await getDocs(query(collection(db, 'orgs', _getOrgId(), 'locations'), where('name', '==', location)))
    const ov = q.docs[0]?.get('rates')
    if (ov && typeof ov === 'object') merged = { ..._ratesTenant, ...ov }
  } catch (e) {
    console.warn('getRates: per-location override lookup failed for', location, '—', e?.message)
  }
  _ratesByLoc[location] = merged
  return merged
}

// Previously this read `auth.currentUser?.tenantId` — but that property is
// Firebase Auth's multi-tenancy field (GCIP tenants), not the `custom:tenantId`
// claim Aurelia uses. It was ALWAYS undefined for Aurelia users, so the
// `|| 'fooda'` fallback fired on every call and every writePnL silently
// targeted the fooda tenant regardless of the signed-in user's actual tenant.
// Now reads from useAuthStore (which carries the real claim via mapUser) and
// throws if missing — better to fail loudly than write to the wrong tenant.
function _getOrgId() {
  const tenantId = useAuthStore.getState().user?.tenantId
  if (!tenantId) {
    throw new Error('pnl.js: _getOrgId called without a signed-in user/tenantId — pnl writers must not run before sign-in completes')
  }
  return tenantId
}

export function locId(name) {
  return (name || '').replace(/[^a-zA-Z0-9]/g, '_')
}

// The revenue sub-lines that sum to total revenue. Single source of truth so the
// helper below and applyScenario's scaling can't drift.
export const REV_SUBLINES = [
  'rev_popup_cogs', 'rev_popup_food_sales', 'rev_popup_tax', 'rev_popup_pp_fee',
  'rev_catering_cogs', 'rev_catering_revenue', 'rev_catering_pp_fee',
  'rev_delivery_cogs',
  'rev_retail_barista', 'rev_retail_cafeteria', 'rev_retail_cogs_tax',
  'rev_client_fees',
]

// Canonical revenue. The rev_* sub-lines are AUTHORITATIVE (both manual entry and
// the event import populate them); the stored `revenue_total` is a last-resort
// fallback ONLY — the manual save path never writes it, so reading it directly
// shows $0 on every hand-keyed week. This is the rule the Dashboard statement
// already documents; computeRevenue makes every reader obey it. Same treatment as
// computePrimeCost — one definition, no drift.
export function computeRevenue(p) {
  if (!p) return 0
  const rev = REV_SUBLINES.reduce((s, k) => s + (Number(p[k]) || 0), 0)
  return rev !== 0 ? rev : (Number(p.revenue_total) || 0)
}

// Canonical TOTAL ONSITE LABOR — the single definition of the labor cost bucket,
// so a new labor source is ONE edit here, not N reader updates (the divergence
// class that caused the revenue bug). Sums, in order: FJE ledger labor (salaries,
// 401k, benefits, taxes, bonus) + cogs_onsite_labor (legacy single-line) +
// cogs_onsite_labor_hourly (Café Labor 2.3a) + cogs_3rd_party. Every Dashboard /
// whyRules labor sum routes through this. Same treatment as computeRevenue.
// NOTE: cogs_onsite_labor is RETIRED as a cost — the Labor-tab grid now writes it
// as a PLAN (labor_planned_hourly), and the authoritative hourly COST is Café
// actuals (cogs_onsite_labor_hourly). Leaving cogs_onsite_labor OUT of this sum is
// what prevents the tab plan from double-counting against Café actuals.
export const ONSITE_LABOR_FIELDS = [
  'cogs_labor_salaries', 'cogs_labor_401k', 'cogs_labor_benefits', 'cogs_labor_taxes', 'cogs_labor_bonus',
  'cogs_onsite_labor_hourly', 'cogs_3rd_party',
]
export function computeOnsiteLabor(p) {
  if (!p) return 0
  return ONSITE_LABOR_FIELDS.reduce((s, k) => s + (Number(p[k]) || 0), 0)
}

// ── Labor burden (read-time derivation) ──────────────────────────────────────
// Burden is NEVER stored — always derived from the base (salary + hourly). The
// salary base itself comes from the LEDGER (computeLedgerContributions → 50410),
// enriched into the in-memory pnl object; hourly comes from the Café import field.
// Rates are director-editable at tenants/{org}/settings/laborRates, fail-open to
// the locked defaults: 15% taxes, 22.5% benefits, 1.875% 401k on (salary+hourly),
// 8% bonus on salary ONLY.
export const LABOR_RATE_FALLBACK = { taxRate: 0.15, benefitsRate: 0.225, retirement401kRate: 0.01875, bonusRate: 0.08 }
let _laborRates = null
export async function getLaborRates() {
  if (_laborRates) return _laborRates
  try {
    const snap = await getDoc(doc(db, 'tenants', _getOrgId(), 'settings', 'laborRates'))
    _laborRates = snap.exists() ? { ...LABOR_RATE_FALLBACK, ...snap.data() } : { ...LABOR_RATE_FALLBACK }
    if (!snap.exists()) console.warn('getLaborRates: settings/laborRates missing — using fallback', LABOR_RATE_FALLBACK)
  } catch (e) {
    console.warn('getLaborRates: settings/laborRates unreadable — using fallback:', e?.message)
    _laborRates = { ...LABOR_RATE_FALLBACK }
  }
  return _laborRates
}

// PURE. Derive the four burden lines from the base. Bonus is salary-only.
export function computeLaborBurden(salaries, hourly, rates = LABOR_RATE_FALLBACK) {
  const sal = Number(salaries) || 0
  const base = sal + (Number(hourly) || 0)
  return {
    cogs_labor_taxes:    base * (rates.taxRate ?? LABOR_RATE_FALLBACK.taxRate),
    cogs_labor_benefits: base * (rates.benefitsRate ?? LABOR_RATE_FALLBACK.benefitsRate),
    cogs_labor_401k:     base * (rates.retirement401kRate ?? LABOR_RATE_FALLBACK.retirement401kRate),
    cogs_labor_bonus:    sal  * (rates.bonusRate ?? LABOR_RATE_FALLBACK.bonusRate),
  }
}

// PURE. Merge ledger contributions into an IN-MEMORY pnl object and derive burden.
// NOTHING is written to Firestore — this is the read-time enrichment the readers see.
// contributions: { [glCode]: amount } from computeLedgerContributions.
export function enrichPnLLabor(p, contributions = {}, rates = LABOR_RATE_FALLBACK) {
  const out = { ...(p || {}) }
  for (const [gl, amt] of Object.entries(contributions)) out[gl] = (Number(out[gl]) || 0) + (Number(amt) || 0)
  const burden = computeLaborBurden(out.cogs_labor_salaries, out.cogs_onsite_labor_hourly, rates)
  return { ...out, ...burden }   // burden SETS the four cogs_labor_* lines (no running source writes them)
}

// periodKey is now passed in from PeriodContext (e.g. '2026-P01-W2')
// These helpers kept for backward compat but PeriodContext is the source of truth
// DEPRECATED: returns an approximate W1 key and is wrong for any other week.
// OrderHub still calls this — must be migrated to PeriodContext periodKey.
export function weekPeriod(offset = 0) {
  const d = new Date()
  d.setDate(d.getDate() + offset * 7)
  const yr = d.getFullYear()
  const mo = d.getMonth() + 1
  // approximate - real period key comes from PeriodContext
  return `${yr}-P${String(mo).padStart(2,'0')}-W1`
}

export function monthPeriod(date = new Date()) {
  return `${date.getFullYear()}-P${String(date.getMonth()+1).padStart(2,'0')}`
}

// Walk back one period from a period key like '2026-P04-W2'.
// Assumes 4 weeks per period (Fooda fiscal calendar).
// Returns null if the key doesn't parse.
// Fooda fiscal calendar: periods = calendar months.
// Week 1 starts on the 1st, ends on the first Sunday.
// Middle weeks are full Mon-Sun. Last week ends on the last day of the month.
// Number of weeks per period depends on the month.
export function weeksInPeriod(year, period) {
  // period 1=Jan, 2=Feb, ..., 12=Dec
  const firstDay = new Date(year, period - 1, 1)        // 1st of the month
  const lastDay  = new Date(year, period, 0)             // last day of the month
  const daysInMonth = lastDay.getDate()
  // Fooda weeks run Sun–Sat. Week 1: day 1 through the first Saturday.
  const daysToSat = (6 - firstDay.getDay() + 7) % 7    // days from the 1st to the first Saturday
  const firstSaturday = 1 + daysToSat                   // date of the first Saturday
  // Remaining days after the first Saturday
  const remainingDays = daysInMonth - firstSaturday
  // Full Sun–Sat weeks in the middle + 1 partial last week if leftover days
  const fullWeeks = Math.floor(remainingDays / 7)
  const leftover = remainingDays % 7
  // Total: week 1 (partial) + full weeks + last partial week (if any)
  return 1 + fullWeeks + (leftover > 0 ? 1 : 0)
}

export function getPriorKey(key) {
  const parts = key?.match(/(\d+)-P(\d+)-W(\d+)/)
  if (!parts) return null
  let [, yr, p, w] = parts.map(Number)
  if (w > 1) return `${yr}-P${String(p).padStart(2,'0')}-W${w-1}`
  // Go to last week of prior period
  if (p > 1) {
    const priorWeeks = weeksInPeriod(yr, p - 1)
    return `${yr}-P${String(p-1).padStart(2,'0')}-W${priorWeeks}`
  }
  // Go to last week of December of prior year
  const decWeeks = weeksInPeriod(yr - 1, 12)
  return `${yr-1}-P12-W${decWeeks}`
}

// Build a list of N trailing period keys ending at (and including) currentKey.
// Example: getTrailingPeriodKeys('2026-P04-W2', 12) returns
//   ['2026-P01-W3', '2026-P01-W4', '2026-P02-W1', ..., '2026-P04-W2']
// (12 keys, oldest first, newest last)
export function getTrailingPeriodKeys(currentKey, count = 12) {
  if (!currentKey) return []
  const keys = [currentKey]
  let k = currentKey
  for (let i = 1; i < count; i++) {
    k = getPriorKey(k)
    if (!k) break
    keys.unshift(k)
  }
  return keys
}

// Generic writer — merges into existing period doc
export async function writePnL(location, period, data, options = {}) {
  // Check if period is locked (unless force override)
  if (!options.force) {
    const lockRef = doc(db, 'tenants', _getOrgId(), 'periodLocks', locId(location) + '__' + period)
    const lockSnap = await getDoc(lockRef)
    if (lockSnap.exists() && lockSnap.data().locked) {
      throw new Error('Period ' + period + ' is locked. Use the 🔓 Reopen button on the period bar to unlock (director+ only).')
    }
  }
  const ref = doc(db, 'tenants', _getOrgId(), 'pnl', locId(location), 'periods', period)
  await setDoc(ref, { ...data, location, period, updatedAt: serverTimestamp() }, { merge: true })
}

// Reader — get full P&L for a location/period
export async function readPnL(location, period) {
  const ref = doc(db, 'tenants', _getOrgId(), 'pnl', locId(location), 'periods', period)
  const snap = await getDoc(ref)
  return snap.exists() ? snap.data() : {}
}

// Live subscription — get updates whenever the doc changes.
// Returns an unsubscribe function. Caller is responsible for cleanup.
//
// Usage:
//   const unsub = subscribePnL(location, period, (data, lastUpdated) => {
//     setPnl(data)
//   })
//   return () => unsub()
export function subscribePnL(location, period, onChange, onError) {
  const ref = doc(db, 'tenants', _getOrgId(), 'pnl', locId(location), 'periods', period)
  return onSnapshot(
    ref,
    snap => {
      const data = snap.exists() ? snap.data() : {}
      // Extract the updatedAt timestamp for "last updated" indicator.
      // Firestore serverTimestamp may still be pending on the first snapshot
      // right after a write — fall back to current time in that case.
      let lastUpdated = null
      if (data.updatedAt?.toDate) {
        lastUpdated = data.updatedAt.toDate()
      } else if (snap.exists()) {
        lastUpdated = new Date()
      }
      onChange(data, lastUpdated)
    },
    err => {
      console.error('subscribePnL error:', err)
      if (onError) onError(err)
    }
  )
}

// Batched historical reader — fetches multiple periods for ONE location
// in a single Firestore collection query. Much faster than N separate
// getDoc calls, especially when loading 12 periods for 62 locations.
//
// Returns an object keyed by period: { '2026-P04-W1': {...}, '2026-P03-W4': {...}, ... }
// Missing periods are omitted (not returned as empty objects).
export async function fetchPnLHistory(location, periodKeys) {
  if (!location || !Array.isArray(periodKeys) || periodKeys.length === 0) {
    return {}
  }
  // Firestore 'in' queries are capped at 30 values per query. We batch
  // if more than 30 periods are requested (unlikely but defensive).
  const BATCH_SIZE = 30
  const batches = []
  for (let i = 0; i < periodKeys.length; i += BATCH_SIZE) {
    batches.push(periodKeys.slice(i, i + BATCH_SIZE))
  }
  const col = collection(db, 'tenants', _getOrgId(), 'pnl', locId(location), 'periods')
  const results = {}
  await Promise.all(
    batches.map(async batch => {
      const q = query(col, where(documentId(), 'in', batch))
      const snap = await getDocs(q)
      snap.forEach(docSnap => {
        results[docSnap.id] = docSnap.data()
      })
    })
  )
  return results
}

// ── Module writers ────────────────────────────────────────────

// Weekly Sales → GFS + Revenue lines
export async function writeSalesPnL(location, period, salesData) {
  // Supports both legacy { retail, catering, popup } and new event import data
  // with full Revenue sub-line fields.
  if (salesData.rev_popup_cogs !== undefined || salesData.rev_catering_cogs !== undefined) {
    // New event import — only write non-zero fields to avoid overwriting
    // data from a separate import (e.g. catering overwriting popup data).
    // Skip gfs_total and revenue_total — Dashboard computes these from sub-lines.
    const skipKeys = new Set(['revenue_pct_gfs'])
    const filtered = {}
    for (const [k, v] of Object.entries(salesData)) {
      if (skipKeys.has(k)) continue
      if (v !== 0 && v !== undefined && v !== null) filtered[k] = v
    }
    await writePnL(location, period, filtered)
  } else {
    // Manual / paste entry — { retail, catering, popup } gross figures.
    // Manual entry has only a gross-per-stream number; it lacks the line-item
    // detail (food net, tax, pp fee, commission) the event import has. To make
    // manual entry flow through Dashboard's PRIMARY revenue path (which reads
    // rev_* sub-lines) rather than a fragile fallback, we populate the SAME
    // rev_* fields the import writes, using the import's per-stream model:
    //
    //   popup/catering: Fooda books the COMMISSION as revenue. The import
    //     represents this as rev_*_cogs = -(gfs - commission) offset by a
    //     positive food/revenue line. We mirror that net: cogs contra +
    //     food/revenue line nets to gfs * rate (the commission).
    //   retail: managed service — books GROSS (matches import:
    //     rev_retail_cafeteria += gfs), less the retail tax line the import applies.
    //
    // Rates are configurable (settings/rates + per-location override) via getRates,
    // NOT the invented 0.18 constant. Popup and catering carry DIFFERENT commission
    // rates (~23% vs ~19% budget-derived); retail tax is its own rate.
    // Only non-zero streams are written, so a paste of one stream never
    // overwrites another stream's data in the same period doc.
    const { retail = 0, catering = 0, popup = 0 } = salesData
    const rates = await getRates(location)
    const pnlData = {}

    if (popup > 0) {
      const rate = rates.commissionRatePopup
      pnlData.gfs_popup = popup
      // net contribution = popup * rate (the commission Fooda keeps)
      pnlData.rev_popup_cogs = -(popup - popup * rate)   // = -popup*(1-rate)
      pnlData.rev_popup_food_sales = popup               // nets with cogs to popup*rate
      // tax / pp_fee unknown for manual entry -> left unset (0)
    }
    if (catering > 0) {
      const rate = rates.commissionRateCatering
      pnlData.gfs_catering = catering
      pnlData.rev_catering_cogs = -(catering - catering * rate)
      pnlData.rev_catering_revenue = catering            // nets to catering*rate
    }
    if (retail > 0) {
      pnlData.gfs_retail = retail
      // retail books gross (managed service), less the configurable retail tax line
      pnlData.rev_retail_cafeteria = retail
      pnlData.rev_retail_cogs_tax = -Math.abs(retail * rates.retailTaxRate)
    }

    const gfs = (pnlData.gfs_retail || 0) + (pnlData.gfs_catering || 0) + (pnlData.gfs_popup || 0)
    if (gfs > 0) {
      pnlData.gfs_total = gfs
    }
    if (Object.keys(pnlData).length > 0) {
      await writePnL(location, period, pnlData)
    }
  }
}

// The ONE canonical food-COGS roll-up. cogs_inventory is the PURE inventory delta
// (opening − closing, legitimately negative on a stock-up week); cogs_purchases is the
// hardened invoice sum. The two food atoms are added EXACTLY ONCE here, and the only
// clamp lives here (final food COGS never goes negative). Every consumer — Dashboard
// Total COGS / EBITDA / prime / gross profit, the Why panel, reconciliation — routes
// through this. Result: the purchases atom can never be double-counted, and
// cogs_inventory can never freeze a stale purchases snapshot (it no longer contains
// purchases at all). No closing count → cogs_inventory absent → food COGS = purchases alone.
export function computeFoodCogs(p) {
  return Math.max(0, (p?.cogs_inventory || 0) + (p?.cogs_purchases || 0))
}

// Inventory week close → inventory DELTA (opening − closing). NOT purchases-inclusive and
// NOT clamped at write: a genuine stock-up week (real prior close, closing > opening) is
// legitimately negative and must offset that week's purchases at aggregation (see
// computeFoodCogs). Purchases live SOLELY in cogs_purchases, so nothing here freezes a
// purchases snapshot that later goes stale.
//
// FIRST-COUNT GUARD: store the delta ONLY when a real prior close exists. On a no-prior
// week the opening defaults to 0, so (0 − closing) would be a spurious full-negative delta
// that wrongly cancels the week's real purchases — store 0 instead (food COGS = purchases
// alone). "Opening came from a real prior close" and "we store a delta" are the SAME
// condition. Caller passes priorCountExists; absent that, fall back to openingValue > 0.
// This is the canonical, unit-tested contract; the client (useInventory) and CF
// (functions/index.js) inline the IDENTICAL guard against their own live prior read.
export function inventoryDelta({ openingValue, closingValue, priorCountExists }) {
  const hasPrior = priorCountExists != null ? priorCountExists : ((openingValue || 0) > 0)
  return hasPrior ? ((openingValue || 0) - (closingValue || 0)) : 0
}

export async function writeInventoryPnL(location, period, { closingValue, openingValue, purchases, priorCountExists }) {
  const cogs_inventory = inventoryDelta({ openingValue, closingValue, priorCountExists })
  await writePnL(location, period, {
    inv_closing: closingValue,
    inv_opening: openingValue || 0,
    inv_purchases: purchases || 0,
    cogs_inventory,
  })
}

// Labor import → COGS labor + Expenses comp & benefits
export async function writeLaborPnL(location, period, { onsiteLabor, thirdParty, compBenefits, glRows }) {
  await writePnL(location, period, {
    // The tab's onsite-labor total is now a PLAN (scheduled), NOT a P&L cost line —
    // the authoritative hourly COST is Café actuals (cogs_onsite_labor_hourly), which
    // is the only field ONSITE_LABOR_FIELDS reads. This is what makes the plan
    // structurally incapable of double-counting against actuals.
    labor_planned_hourly: onsiteLabor,
    // 3rd-party COST is now owned SOLELY by the read-time 3rd-party JE (New Entry →
    // 3rd-Party Labor → cogs_3rd_party). The GL grid's 50420 is a PLAN, not a cost —
    // so it can't double-count with the JE. (Same retirement as cogs_onsite_labor.)
    labor_planned_3rd_party: thirdParty,
    exp_comp_benefits: compBenefits,
    labor_gl_rows:     glRows || [],
  })
}

// Purchasing AP → COGS purchases
export async function writePurchasingPnL(location, period, { invoiceTotal, paidTotal, pendingTotal, namedLineTotals }) {
  // Only write fields that are provided and meaningful. Because writes merge,
  // passing 0/undefined for a field would otherwise STOMP an existing value
  // (e.g. OrderHub writes only ap_pending and must not zero out cogs_purchases
  // that the Purchasing tab wrote). Purchasing passes a real invoiceTotal to
  // set cogs_purchases; OrderHub passes only pendingTotal.
  const data = {}
  if (invoiceTotal !== undefined && invoiceTotal !== null) data.cogs_purchases = invoiceTotal
  if (paidTotal    !== undefined && paidTotal    !== null) data.ap_paid        = paidTotal
  if (pendingTotal !== undefined && pendingTotal !== null) data.ap_pending     = pendingTotal
  // Dedicated named lines, each already re-derived by the caller as the SUM of its
  // invoices this period. SET here (merge) so a line is never overwritten by a
  // single invoice's amount — the write-loss bug the caller re-derive fixes.
  if (namedLineTotals) for (const [line, sum] of Object.entries(namedLineTotals)) data[line] = sum
  if (Object.keys(data).length > 0) {
    await writePnL(location, period, data)
  }
}

// ── GL code → dedicated P&L line (VF #4 translation bridge) ──────────────────
// A numeric catalog GL code that posts to a DEDICATED Dashboard COGS line. A code
// NOT listed here (12xxx inventory purchases, or anything unknown) returns null
// and flattens into cogs_purchases. Every target is already a NAMED_GL_LINE, so
// after translation the existing named-line logic applies unchanged. Verified
// against Dashboard.jsx: cogs_cleaning/paper/equipment/ec_barista/supplies/
// uniforms/maintenance are dedicated lines; cogs_3rd_party has no standalone line
// but is summed into the labor subtotal (_labor_subtotal).
export const GL_NUMERIC_TO_PNL = {
  '65070': 'cogs_cleaning',
  '65080': 'cogs_paper',
  '50430': 'cogs_equipment',
  '50431': 'cogs_ec_barista',
  '50440': 'cogs_supplies',
  '50450': 'cogs_maintenance',
  '65050': 'cogs_uniforms',
  // 50420 (3rd-Party Labor) is DELIBERATELY NOT mapped: cogs_3rd_party is written
  // by the Labor module (writeLaborPnL), so a Purchasing re-derive would clobber
  // Labor's value. 50420 invoices therefore FLATTEN into cogs_purchases — the only
  // option with no cross-module write collision. Revisit with a distinct
  // Purchasing-owned field if 3rd-party labor via Purchasing becomes common.
}
// The dedicated P&L field a mapped numeric GL code posts to, or null if unmapped
// (→ flatten into cogs_purchases). Callers do `toPnlLine(glCode) || glCode` then
// gate on NAMED_GL_LINES membership, so a mapped code lands on its line and
// everything else flattens — a bare pnl[<code>] junk field can never be written.
export function toPnlLine(glCode) {
  return GL_NUMERIC_TO_PNL[String(glCode)] || null
}

// Waste → COGS shrinkage
export async function writeWastePnL(location, period, { wasteCost, wasteOz }) {
  await writePnL(location, period, {
    cogs_waste: wasteCost,
    waste_oz:   wasteOz,
  })
}

// Budget → all budget lines for variance
export async function writeBudgetPnL(location, year, monthlyBudgets) {
  // Write each month
  const writes = Object.entries(monthlyBudgets).map(([mo, vals]) => {
    const period = `${year}-${String(mo).padStart(2, '0')}`
    return writePnL(location, period, {
      budget_gfs:     vals.gfs     || 0,
      budget_revenue: vals.revenue || 0,
      budget_cogs:    vals.cogs    || 0,
      budget_labor:   vals.labor   || 0,
      budget_ebitda:  vals.ebitda  || 0,
    })
  })
  await Promise.all(writes)
}


// ── Period close ─────────────────────────────────────────────

// Write period close status to the P&L period doc.
// Status: 'open' | 'closed' | 'reopened'
export async function writePeriodClose(location, period, { status, actor, reason }) {
  const closeData = {
    periodStatus: status,
    [`${status}By`]: actor,
    [`${status}At`]: serverTimestamp(),
  }
  if (reason) closeData.reopenReason = reason
  await writePnL(location, period, closeData)
}

// Read period close status from the P&L period doc.
// Returns { periodStatus, closedBy, closedAt, reopenedBy, reopenedAt, reopenReason }
export async function readPeriodClose(location, period) {
  const data = await readPnL(location, period)
  return {
    periodStatus: data.periodStatus || 'open',
    closedBy: data.closedBy || null,
    closedAt: data.closedAt || null,
    reopenedBy: data.reopenedBy || null,
    reopenedAt: data.reopenedAt || null,
    reopenReason: data.reopenReason || null,
  }
}


// Period locking
export async function lockPeriod(location, period, user) {
  const orgId = _getOrgId()
  const ref = doc(db, 'tenants', orgId, 'periodLocks', locId(location) + '__' + period)
  await setDoc(ref, {
    locked: true,
    lockedBy: user?.email || 'unknown',
    lockedAt: serverTimestamp(),
    location,
  })
}

export async function unlockPeriod(location, period, user) {
  const orgId = _getOrgId()
  const ref = doc(db, 'tenants', orgId, 'periodLocks', locId(location) + '__' + period)
  await setDoc(ref, {
    locked: false,
    unlockedBy: user?.email || 'unknown',
    unlockedAt: serverTimestamp(),
  }, { merge: true })
}

export async function isPeriodLocked(location, period) {
  const orgId = _getOrgId()
  const ref = doc(db, 'tenants', orgId, 'periodLocks', locId(location) + '__' + period)
  const snap = await getDoc(ref)
  return snap.exists() && snap.data().locked === true
}
