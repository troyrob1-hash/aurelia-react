// Shared P&L data writer
// All modules write here → Dashboard reads from here
// Path: tenants/fooda/pnl/{locId}/{period}
// Period: '2026-W14' (weekly) or '2026-04' (monthly)

import { db } from './firebase'
import { doc, setDoc, getDoc, serverTimestamp } from 'firebase/firestore'

const TENANT = 'fooda'

export function locId(name) {
  return (name || '').replace(/[^a-zA-Z0-9]/g, '_')
}

// periodKey is now passed in from PeriodContext (e.g. '2026-P01-W2')
// These helpers kept for backward compat but PeriodContext is the source of truth
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

// Generic writer — merges into existing period doc
export async function writePnL(location, period, data) {
  const ref = doc(db, 'tenants', TENANT, 'pnl', locId(location), 'periods', period)
  await setDoc(ref, { ...data, location, period, updatedAt: serverTimestamp() }, { merge: true })
}

// Reader — get full P&L for a location/period
export async function readPnL(location, period) {
  const ref = doc(db, 'tenants', TENANT, 'pnl', locId(location), 'periods', period)
  const snap = await getDoc(ref)
  return snap.exists() ? snap.data() : {}
}

// ── Module writers ────────────────────────────────────────────

// Weekly Sales → GFS + Revenue lines
export async function writeSalesPnL(location, period, { retail, catering, popup }) {
  const gfs       = retail + catering + popup
  const commission = gfs * 0.18
  const revenue   = gfs - commission
  await writePnL(location, period, {
    gfs_retail:   retail,
    gfs_catering: catering,
    gfs_popup:    popup,
    gfs_total:    gfs,
    revenue_commission: commission,
    revenue_total: revenue,
    revenue_pct_gfs: gfs > 0 ? revenue / gfs : 0,
  })
}

// Inventory week close → COGS (opening - closing)
export async function writeInventoryPnL(location, period, { closingValue, openingValue, purchases }) {
  const cogs_inventory = Math.max(0, (openingValue || 0) + (purchases || 0) - closingValue)
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
    cogs_onsite_labor: onsiteLabor,
    cogs_3rd_party:    thirdParty,
    exp_comp_benefits: compBenefits,
    labor_total:       onsiteLabor + thirdParty + compBenefits,
    labor_gl_rows:     glRows || [],
  })
}

// Purchasing AP → COGS purchases
export async function writePurchasingPnL(location, period, { invoiceTotal, paidTotal, pendingTotal }) {
  await writePnL(location, period, {
    cogs_purchases:    invoiceTotal,
    ap_paid:           paidTotal,
    ap_pending:        pendingTotal,
  })
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
