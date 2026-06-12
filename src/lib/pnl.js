// Shared P&L data writer
// All modules write here → Dashboard reads from here
// Path: tenants/{orgId}/pnl/{locId}/{period}
// Period: '2026-W14' (weekly) or '2026-04' (monthly)

import { db } from './firebase'
import { doc, setDoc, getDoc, onSnapshot, serverTimestamp, collection, query, where, getDocs, documentId } from 'firebase/firestore'


import { auth } from './firebase'

// Default commission rate. Interim: single constant (was hardcoded 0.18 in
// multiple files). Future: read per-location commissionRate from the location
// doc, falling back to this. Change here once to update everywhere.
export const DEFAULT_COMMISSION_RATE = 0.18

function _getOrgId() {
  const user = auth.currentUser
  if (!user) console.warn('_getOrgId: no authenticated user; defaulting to fooda tenant')
  return user?.tenantId || 'fooda'
}

export function locId(name) {
  return (name || '').replace(/[^a-zA-Z0-9]/g, '_')
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
  // Week 1: day 1 through first Sunday
  const firstSunday = firstDay.getDay() === 0 ? 1 : (7 - firstDay.getDay() + 1)
  // Remaining days after first Sunday
  const remainingDays = daysInMonth - firstSunday
  // Full Mon-Sun weeks in the middle + 1 partial last week if leftover days
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
      throw new Error('Period ' + period + ' is locked. Unlock it in Settings to make changes.')
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
    //     rev_retail_cafeteria += gfs), less the 7.7% tax line the import applies.
    //
    // Only non-zero streams are written, so a paste of one stream never
    // overwrites another stream's data in the same period doc.
    const { retail = 0, catering = 0, popup = 0 } = salesData
    const rate = DEFAULT_COMMISSION_RATE
    const pnlData = {}

    if (popup > 0) {
      pnlData.gfs_popup = popup
      // net contribution = popup * rate (the commission Fooda keeps)
      pnlData.rev_popup_cogs = -(popup - popup * rate)   // = -popup*(1-rate)
      pnlData.rev_popup_food_sales = popup               // nets with cogs to popup*rate
      // tax / pp_fee unknown for manual entry -> left unset (0)
    }
    if (catering > 0) {
      pnlData.gfs_catering = catering
      pnlData.rev_catering_cogs = -(catering - catering * rate)
      pnlData.rev_catering_revenue = catering            // nets to catering*rate
    }
    if (retail > 0) {
      pnlData.gfs_retail = retail
      // retail books gross (managed service), less 7.7% tax line per import
      pnlData.rev_retail_cafeteria = retail
      pnlData.rev_retail_cogs_tax = -Math.abs(retail * 0.077)
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
    labor_total:       (onsiteLabor || 0) + (thirdParty || 0) + (compBenefits || 0),
    labor_gl_rows:     glRows || [],
  })
}

// Purchasing AP → COGS purchases
export async function writePurchasingPnL(location, period, { invoiceTotal, paidTotal, pendingTotal }) {
  // Only write fields that are provided and meaningful. Because writes merge,
  // passing 0/undefined for a field would otherwise STOMP an existing value
  // (e.g. OrderHub writes only ap_pending and must not zero out cogs_purchases
  // that the Purchasing tab wrote). Purchasing passes a real invoiceTotal to
  // set cogs_purchases; OrderHub passes only pendingTotal.
  const data = {}
  if (invoiceTotal !== undefined && invoiceTotal !== null) data.cogs_purchases = invoiceTotal
  if (paidTotal    !== undefined && paidTotal    !== null) data.ap_paid        = paidTotal
  if (pendingTotal !== undefined && pendingTotal !== null) data.ap_pending     = pendingTotal
  if (Object.keys(data).length > 0) {
    await writePnL(location, period, data)
  }
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
