// Shared P&L data writer
// All modules write here → Dashboard reads from here
// Path: tenants/fooda/pnl/{locId}/{period}
// Period: '2026-W14' (weekly) or '2026-04' (monthly)

import { db } from './firebase'
import { doc, setDoc, getDoc, onSnapshot, serverTimestamp, collection, query, where, getDocs, documentId } from 'firebase/firestore'

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

// Walk back one period from a period key like '2026-P04-W2'.
// Assumes 4 weeks per period (Fooda fiscal calendar).
// Returns null if the key doesn't parse.
export function getPriorKey(key) {
  const parts = key?.match(/(\d+)-P(\d+)-W(\d+)/)
  if (!parts) return null
  let [, yr, p, w] = parts.map(Number)
  if (w > 1) return `${yr}-P${String(p).padStart(2,'0')}-W${w-1}`
  if (p > 1) return `${yr}-P${String(p-1).padStart(2,'0')}-W4`
  return `${yr-1}-P12-W4`
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

// Live subscription — get updates whenever the doc changes.
// Returns an unsubscribe function. Caller is responsible for cleanup.
//
// Usage:
//   const unsub = subscribePnL(location, period, (data, lastUpdated) => {
//     setPnl(data)
//   })
//   return () => unsub()
export function subscribePnL(location, period, onChange, onError) {
  const ref = doc(db, 'tenants', TENANT, 'pnl', locId(location), 'periods', period)
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
  const col = collection(db, 'tenants', TENANT, 'pnl', locId(location), 'periods')
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
