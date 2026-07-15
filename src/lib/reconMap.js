// src/lib/reconMap.js
//
// PHASE 1 — the reconciliation contract. Rolls Aurelia's fine-grained "running"
// P&L fields UP to NetSuite's coarser Enterprise-P&L lines, so the official books
// (monthly, from NetSuite) can be diffed against what Aurelia tracks.
//
// RECON_MAP is a VERIFIED DISJOINT COVER of Aurelia's 50 leaf P&L atoms: every
// atom maps into exactly ONE official line (no double-count, no orphan), and the
// Revenue-section lines sum to EXACTLY computeRevenue's REV_SUBLINES. See
// scratchpad/recon-map-verify — "the reconciliation itself reconciles."
//
// Each official line carries a `status` so the comparison view renders three ways:
//   MAPPED   — Aurelia populates this today (a running writer exists). Show the variance.
//   COMING   — the field exists but no running writer routes to it yet, or a planned
//              source (hourly labor, occupancy). Show "Aurelia doesn't track this yet."
//   EXTERNAL — structurally NetSuite-only (rent, D&A, corporate allocations, split
//              bank fees). Show muted "NetSuite only" — never expected to match.

import { doc, getDoc } from 'firebase/firestore'
import { db } from './firebase'
import { weeksInPeriod } from './pnl'   // the one authoritative Sun–Sat week-count (no 4th copy)
import { computeLedgerContributions } from './ledgerContributions'

export const STATUS = { MAPPED: 'MAPPED', COMING: 'COMING', EXTERNAL: 'EXTERNAL' }

// officialLine -> { section, acct?, status, aurelia: [atom fields that sum to it] }
// aurelia: []  → official-only (no Aurelia source; Running renders blank).
// aureliaOnly  → running-only (Aurelia has data, no official line; expect a permanent Δ).
export const RECON_MAP = {
  // ── Gross Food Sales (memo/volume) ─────────────────────────────────────────
  'GFS - Popup':    { section: 'GFS', status: STATUS.MAPPED, aurelia: ['gfs_popup'] },
  'GFS - Catering': { section: 'GFS', status: STATUS.MAPPED, aurelia: ['gfs_catering'] },
  'GFS - Retail':   { section: 'GFS', status: STATUS.MAPPED, aurelia: ['gfs_retail'] },
  'GFS - Delivery': { section: 'GFS', status: STATUS.COMING, aurelia: ['gfs_delivery'] }, // no daily-entry source yet
  'GFS - Pantry':   { section: 'GFS', status: STATUS.COMING, aurelia: ['gfs_pantry'] },   // no daily-entry source yet

  // ── Revenue (Σ of these == computeRevenue REV_SUBLINES) ─────────────────────
  'Popup Revenue':    { section: 'Revenue', acct: '40042', status: STATUS.MAPPED, aurelia: ['rev_popup_cogs', 'rev_popup_food_sales', 'rev_popup_tax', 'rev_popup_pp_fee'] },
  'Catering Revenue': { section: 'Revenue', acct: '40200', status: STATUS.MAPPED, aurelia: ['rev_catering_cogs', 'rev_catering_revenue', 'rev_catering_pp_fee'] },
  'Retail Revenue':   { section: 'Revenue', acct: '40160', status: STATUS.MAPPED, aurelia: ['rev_retail_barista', 'rev_retail_cafeteria', 'rev_retail_cogs_tax'] },
  'Client Fees':      { section: 'Revenue', acct: '40080', status: STATUS.MAPPED, aurelia: ['rev_client_fees'] },
  'Delivery Revenue': { section: 'Revenue', acct: '40100', status: STATUS.COMING, aurelia: ['rev_delivery_cogs'] },
  'Pantry Revenue':   { section: 'Revenue', acct: '40510', status: STATUS.COMING, aurelia: [] }, // official-only; Aurelia could add rev_pantry
  'Revenue Share':    { section: 'Revenue', acct: '40050', status: STATUS.COMING, aurelia: [] }, // official-only; budget key only today

  // ── Labor — COMING until 2.3a (Café hourly parser) + 2.3b (FJE model) land and
  //    the 14 pending submissions re-import. Today a labor variance would read
  //    "we haven't loaded labor," not a real discrepancy. Flip back to MAPPED then.
  'Onsite Labor (Fooda) Salaries and Wages': { section: 'Labor', acct: '50410', status: STATUS.COMING, aurelia: ['cogs_labor_salaries', 'cogs_onsite_labor_hourly'] }, // FJE salary + Café hourly. cogs_onsite_labor RETIRED as cost (now a plan field) → not summed here
  'Onsite Labor 401k':     { section: 'Labor', acct: '50411', status: STATUS.COMING, aurelia: ['cogs_labor_401k'] },
  'Onsite Labor Benefits': { section: 'Labor', acct: '50412', status: STATUS.COMING, aurelia: ['cogs_labor_benefits'] },
  'Onsite Labor Taxes':    { section: 'Labor', acct: '50413', status: STATUS.COMING, aurelia: ['cogs_labor_taxes'] },
  'Onsite Bonus':          { section: 'Labor', acct: '50414', status: STATUS.COMING, aurelia: ['cogs_labor_bonus'] },
  '3rd Party Labor':       { section: 'Labor', acct: '50420', status: STATUS.COMING, aurelia: ['cogs_3rd_party'] },

  // ── COGS ────────────────────────────────────────────────────────────────────
  'Onsite Equipment':                    { section: 'COGS', acct: '50430', status: STATUS.MAPPED, aurelia: ['cogs_equipment'] },
  'Equipment and Consumables - Barista': { section: 'COGS', acct: '50431', status: STATUS.MAPPED, aurelia: ['cogs_ec_barista'] },
  'Cleaning Supplies & Chemicals':       { section: 'COGS', acct: '65070', status: STATUS.MAPPED, aurelia: ['cogs_cleaning'] },
  'Paper Products & Consumables':        { section: 'COGS', acct: '65080', status: STATUS.MAPPED, aurelia: ['cogs_paper'] },
  'Onsite Supplies':                     { section: 'COGS', acct: '50440', status: STATUS.MAPPED, aurelia: ['cogs_supplies'] },
  'Onsite Uniforms':                     { section: 'COGS', acct: '65050', status: STATUS.MAPPED, aurelia: ['cogs_uniforms'] },
  'Onsite Other':                        { section: 'COGS', acct: '50450', status: STATUS.MAPPED, aurelia: ['cogs_maintenance'] },
  'Bank Charges, Merchant Fees':         { section: 'COGS', acct: '61020', status: STATUS.MAPPED, aurelia: ['cogs_payment_processing'] },
  'Food / Product COGS':                 { section: 'COGS', acct: '50xxx?', status: STATUS.MAPPED, aurelia: ['cogs_inventory', 'cogs_purchases'] }, // acct TENTATIVE — confirm vs real export; cogs_purchases currently includes misrouted expense invoices
  'Shrinkage Loss':                      { section: 'COGS', status: STATUS.MAPPED, aureliaOnly: true, aurelia: ['cogs_shrinkage'] }, // running-only (WasteLog); Official blank
  'Retail COGS - Barista':               { section: 'COGS', status: STATUS.COMING, aurelia: ['cogs_retail_barista'] },
  'Retail COGS - Cafeteria':             { section: 'COGS', status: STATUS.COMING, aurelia: ['cogs_retail_cafeteria'] },
  'Retail COGS - Managed Service Cost':  { section: 'COGS', acct: '50160', status: STATUS.COMING, aurelia: ['cogs_retail_managed'] },

  // ── Expenses (no running writer routes to exp_* yet — invoices flatten into
  //    cogs_purchases; these light up once Purchasing routes non-owned expense GLs) ──
  'Total Comp and Benefits':     { section: 'Expenses', acct: '68016', status: STATUS.MAPPED, aurelia: ['exp_comp_benefits'] },
  'Office Supplies & Equipment': { section: 'Expenses', acct: '65090', status: STATUS.COMING, aurelia: ['exp_office_supplies'] },
  'Marketing':                   { section: 'Expenses', acct: '62010', status: STATUS.COMING, aurelia: ['exp_mktg_cashier', 'exp_mktg_coupons', 'exp_mktg_marketing', 'exp_mktg_other'] },
  'Technology Services':         { section: 'Expenses', acct: '63010', status: STATUS.COMING, aurelia: ['exp_technology'] },
  'Travel and Entertainment':    { section: 'Expenses', acct: '64120', status: STATUS.COMING, aurelia: ['exp_travel'] },
  'Professional Fees':           { section: 'Expenses', acct: '66010', status: STATUS.COMING, aurelia: ['exp_professional'] },
  'Facilities':                  { section: 'Expenses', acct: '67200', status: STATUS.COMING, aurelia: ['exp_facilities'] },
  'Licenses, Permits and Fines': { section: 'Expenses', acct: '69003', status: STATUS.COMING, aurelia: ['exp_licenses'] },
  'Other Expenses':              { section: 'Expenses', acct: '69001', status: STATUS.COMING, aurelia: ['exp_other'] },
  'Bank Fees':                   { section: 'Expenses', acct: '61010', status: STATUS.EXTERNAL, aurelia: [] }, // Aurelia folds bank+merchant fees into cogs_payment_processing — can't split
}

// Section render order for the view.
export const SECTION_ORDER = ['GFS', 'Revenue', 'Labor', 'COGS', 'Expenses']

// Pure. Given summed atoms { field: total }, roll UP to official-line grain.
// Returns { officialLine: total | null }. null = no Aurelia source (Official-only).
export function rollupToOfficialLines(atomSums) {
  const out = {}
  for (const [line, def] of Object.entries(RECON_MAP)) {
    if (!def.aurelia.length) { out[line] = null; continue } // official-only → blank Running
    out[line] = def.aurelia.reduce((s, k) => s + (Number(atomSums?.[k]) || 0), 0)
  }
  return out
}

// Parse '2026-P05' or '2026-P05-MONTHLY' → { year, period }.
export function parseMonthKey(monthKey) {
  const m = String(monthKey).match(/(\d{4})-P(\d{2})/)
  if (!m) throw new Error(`Bad monthKey "${monthKey}" — expected YYYY-PMM`)
  return { year: +m[1], period: +m[2] }
}

// Sum Aurelia's WEEKLY pnl docs across the month and roll up to official grain.
// Post-calendar-fix, a month is exactly its weeks (no cross-month leakage), so
// Σ(W1..Wn) is the exact month total. Reads tenants/{orgId}/pnl/{locId}/periods/{weekKey}.
export async function computeRunningMonth(locId, monthKey, orgId = 'fooda') {
  const { year, period } = parseMonthKey(monthKey)
  const n = weeksInPeriod(year, period)
  const atomSums = {}
  let weeksFound = 0
  for (let w = 1; w <= n; w++) {
    const wk = `${year}-P${String(period).padStart(2, '0')}-W${w}`
    const snap = await getDoc(doc(db, 'tenants', orgId, 'pnl', locId, 'periods', wk))
    if (snap.exists()) {
      weeksFound++
      for (const [k, v] of Object.entries(snap.data())) {
        if (typeof v === 'number') atomSums[k] = (atomSums[k] || 0) + v
      }
    }
    // Ledger contributions (e.g. salary → cogs_labor_salaries) are read-time — never
    // stored on pnl — so the running month must add them per week too, or 50410 would
    // read $0 in the reconciliation and stay COMING when it's actually being tracked.
    const contribs = await computeLedgerContributions(locId, wk, orgId)
    for (const [k, v] of Object.entries(contribs)) atomSums[k] = (atomSums[k] || 0) + v
  }
  return { lines: rollupToOfficialLines(atomSums), atomSums, weekCount: n, weeksFound }
}
