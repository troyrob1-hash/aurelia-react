// src/lib/whyRules.js
//
// Rules engines for the P&L Why panel. Given a clicked line + context,
// generates a structured narrative explaining what drove the number.
//
// Architecture:
// - buildWhyNarrative(context) is the entry point. It dispatches to the
//   right engine based on the line.key.
// - Engines can be sync (using only data already in context) or async
//   (loading additional source-tab collections via Firestore).
// - Every engine returns { headline, bullets[], factors[], drillTo? }.
// - Engines fall back gracefully when data is sparse — they do not throw.
//
// Current engines:
// - cogs_purchases: reads tenants/{orgId}/invoices for this period and prior,
//   groups by vendor, detects price movers, detects non-contract purchases
// - aggregate-only fallback: works for every line, uses only context.pnl/priorPnl/history
//
// Future engines (not yet implemented, safe fallback to aggregate-only):
// - cogs_inventory, cogs_waste, cogs_onsite_labor, cogs_3rd_party
// - revenue (gfs_*, revenue_*)
// - exp_comp_benefits

import { db } from './firebase'
import { collection, query, where, getDocs, doc, getDoc } from 'firebase/firestore'
import { getPriorKey } from './pnl'

// ============================================================================
// Entry point
// ============================================================================

export async function buildWhyNarrative(ctx) {
  if (!ctx.line) return emptyNarrative()

  const key = ctx.line.key

  try {
    if (key === 'cogs_purchases') return await explainCogsPurchases(ctx)
    if (key === 'cogs_onsite_labor' || key === 'cogs_3rd_party' || key === 'exp_comp_benefits' || key === '_labor_subtotal' || key === '_total_exp') return await explainLabor(ctx)
    if (key?.startsWith('gfs_') || key === 'revenue_total' || key === 'revenue_commission') return await explainRevenue(ctx)
    if (key === 'cogs_waste') return await explainWaste(ctx)
    if (key === 'cogs_inventory') return await explainInventory(ctx)
    // Additional engines slot in here as they are built:
    // if (key === 'cogs_waste') return await explainWaste(ctx)
    // if (key === 'cogs_inventory') return await explainInventory(ctx)
    // if (key?.startsWith('gfs_') || key?.startsWith('revenue_')) return await explainRevenue(ctx)
  } catch (e) {
    console.error('whyRules engine error for key=' + key, e)
    // Fall through to aggregate fallback
  }

  return explainFromAggregates(ctx)
}

// ============================================================================
// Helpers
// ============================================================================

function emptyNarrative() {
  return { headline: null, bullets: [], factors: [] }
}

function fmt$(v) {
  if (v == null || isNaN(v)) return '—'
  const abs = Math.abs(v)
  if (abs >= 1_000_000) return '$' + (abs / 1_000_000).toFixed(1) + 'M'
  if (abs >= 1_000)     return '$' + Math.round(abs / 1_000) + 'k'
  return '$' + Math.round(abs)
}

function pctDelta(cur, prev) {
  if (prev == null || prev === 0 || cur == null) return null
  return ((cur - prev) / Math.abs(prev)) * 100
}

// Loads ALL invoices for a given period + optional location filter.
// Returns an array of invoice objects. Empty array on failure.
async function loadInvoicesForPeriod(orgId, periodKey, location) {
  try {
    const col = collection(db, 'tenants', orgId, 'invoices')
    let q = query(col, where('periodKey', '==', periodKey))
    if (location) q = query(col, where('periodKey', '==', periodKey), where('location', '==', location))
    const snap = await getDocs(q)
    return snap.docs.map(d => ({ id: d.id, ...d.data() }))
  } catch (e) {
    console.error('loadInvoicesForPeriod failed:', e)
    return []
  }
}

// ============================================================================
// Engine: cogs_purchases — reads actual invoices
// ============================================================================

async function explainCogsPurchases(ctx) {
  const { actual, budget, prior, periodKey, orgId, location, isAllLocations } = ctx

  // When viewing "All Locations", we don't filter by location — we want the
  // vendor picture across the whole org. When viewing one location, we filter.
  const filterLoc = isAllLocations ? null : location

  const priorKey = getPriorKey(periodKey)
  const [curInvoices, priorInvoices] = await Promise.all([
    loadInvoicesForPeriod(orgId, periodKey, filterLoc),
    loadInvoicesForPeriod(orgId, priorKey, filterLoc),
  ])

  if (curInvoices.length === 0) {
    return {
      headline: `No invoices found for ${periodKey}${filterLoc ? ' at this location' : ''}. Purchases line is zero or not yet posted.`,
      bullets: [],
      factors: [],
      drillTo: '/purchasing',
    }
  }

  // Group by vendor
  const vendorTotals = {}       // vendor → { total, count, invoices[] }
  const priorVendorTotals = {}

  curInvoices.forEach(inv => {
    const v = inv.vendor || inv.vendorId || 'Unknown vendor'
    if (!vendorTotals[v]) vendorTotals[v] = { total: 0, count: 0, invoices: [] }
    vendorTotals[v].total += (inv.amount || 0)
    vendorTotals[v].count += 1
    vendorTotals[v].invoices.push(inv)
  })
  priorInvoices.forEach(inv => {
    const v = inv.vendor || inv.vendorId || 'Unknown vendor'
    if (!priorVendorTotals[v]) priorVendorTotals[v] = { total: 0, count: 0 }
    priorVendorTotals[v].total += (inv.amount || 0)
    priorVendorTotals[v].count += 1
  })

  const totalCur = Object.values(vendorTotals).reduce((s, v) => s + v.total, 0)
  const totalPrior = Object.values(priorVendorTotals).reduce((s, v) => s + v.total, 0)
  const periodDelta = totalCur - totalPrior

  // Build vendor list with deltas, sorted by biggest driver
  const vendorList = Object.entries(vendorTotals).map(([vendor, cur]) => {
    const priorTotal = priorVendorTotals[vendor]?.total || 0
    const delta = cur.total - priorTotal
    const deltaPct = pctDelta(cur.total, priorTotal)
    return { vendor, cur: cur.total, priorTotal, delta, deltaPct, count: cur.count }
  }).sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))

  // Detect price movers — vendors whose total jumped more than 15% AND
  // the delta is meaningful (>$100)
  const priceMovers = vendorList.filter(v =>
    v.priorTotal > 0 && v.deltaPct != null && Math.abs(v.deltaPct) > 15 && Math.abs(v.delta) > 100
  )

  // New vendors (appeared this period but not prior)
  const newVendors = vendorList.filter(v => v.priorTotal === 0 && v.cur > 0)

  // Build headline
  const invoiceCount = curInvoices.length
  let headline = `${invoiceCount} invoice${invoiceCount === 1 ? '' : 's'} posted this period totaling ${fmt$(totalCur)}`
  if (totalPrior > 0) {
    const deltaWord = periodDelta >= 0 ? 'up' : 'down'
    headline += `, ${deltaWord} ${fmt$(Math.abs(periodDelta))} vs prior period.`
  } else {
    headline += '.'
  }

  // Build bullets — key drivers
  const bullets = []
  if (priceMovers.length > 0) {
    const top = priceMovers[0]
    bullets.push({
      sign: top.delta > 0 ? 'up' : 'down',
      text: `${top.vendor} ${top.delta > 0 ? 'increased' : 'decreased'} ${fmt$(Math.abs(top.delta))} (${top.deltaPct >= 0 ? '+' : ''}${Math.round(top.deltaPct)}%) vs prior period`,
    })
    if (priceMovers.length > 1) {
      const others = priceMovers.length - 1
      bullets.push({
        sign: 'up',
        text: `${others} other vendor${others === 1 ? '' : 's'} also showed significant price movement`,
      })
    }
  }
  if (newVendors.length > 0) {
    const total = newVendors.reduce((s, v) => s + v.cur, 0)
    bullets.push({
      sign: 'up',
      text: `${newVendors.length} new vendor${newVendors.length === 1 ? '' : 's'} contributed ${fmt$(total)} this period`,
    })
  }
  if (budget != null && budget !== 0 && actual != null) {
    const varPct = ((actual - budget) / budget) * 100
    if (Math.abs(varPct) > 10) {
      bullets.push({
        sign: varPct > 0 ? 'up' : 'down',
        text: `${Math.round(Math.abs(varPct))}% ${varPct > 0 ? 'over' : 'under'} budget of ${fmt$(budget)}`,
      })
    }
  }

  // Build factors — top 5 vendors by absolute delta
  const factors = vendorList.slice(0, 6).map(v => ({
    label: v.vendor,
    detail: v.count + ' invoice' + (v.count === 1 ? '' : 's') + ' · ' + fmt$(v.cur),
    value: v.priorTotal > 0
      ? (v.delta >= 0 ? '+' : '') + fmt$(v.delta)
      : 'new',
    sign: v.priorTotal === 0 ? 'up' : v.delta > 0 ? 'up' : 'down',
  }))

  return {
    headline,
    bullets,
    factors,
    drillTo: '/purchasing',
  }
}

// ============================================================================
// Fallback: aggregate-only explanation for any line the engines don't handle
// ============================================================================

// ============================================================================
// Engine: labor — reads laborSubmissions
// ============================================================================

// Maps each P&L line key to the labor section it represents in the
// laborSubmissions.glRows[].section field, or null to aggregate everything.
const LABOR_KEY_TO_SECTION = {
  cogs_onsite_labor:  'Onsite',
  cogs_3rd_party:     '3rd Party',
  exp_comp_benefits:  'Comp & Benefits',
  _labor_subtotal:    null,
  _total_exp:         null,
}

async function loadLaborSubmissionsForPeriod(orgId, periodKey, location) {
  try {
    const col = collection(db, 'tenants', orgId, 'laborSubmissions')
    const q = query(col, where('period', '==', periodKey))
    const snap = await getDocs(q)
    const all = snap.docs.map(d => ({ id: d.id, ...d.data() }))
    return location ? all.filter(s => s.location === location) : all
  } catch (e) {
    console.error('loadLaborSubmissionsForPeriod failed:', e)
    return []
  }
}

function aggregateLabor(submissions, filterSection) {
  const byGl = {}
  submissions.forEach(sub => {
    ;(sub.glRows || []).forEach(row => {
      if (filterSection && row.section !== filterSection) return
      const glKey = row.gl || row.label
      if (!byGl[glKey]) byGl[glKey] = { label: row.label, amount: 0, section: row.section }
      byGl[glKey].amount += (row.amount || 0)
    })
  })
  return { byGl }
}

async function explainLabor(ctx) {
  const { line, actual, budget, periodKey, orgId, location, isAllLocations } = ctx
  const filterLoc = isAllLocations ? null : location
  const filterSection = LABOR_KEY_TO_SECTION[line.key] || null

  const priorKey = getPriorKey(periodKey)
  const [curSubs, priorSubs] = await Promise.all([
    loadLaborSubmissionsForPeriod(orgId, periodKey, filterLoc),
    loadLaborSubmissionsForPeriod(orgId, priorKey, filterLoc),
  ])

  if (curSubs.length === 0) {
    return {
      headline: `No labor submissions uploaded for ${periodKey}${filterLoc ? ' at this location' : ''} yet. ${line.label} is pending import.`,
      bullets: [],
      factors: [],
      drillTo: '/labor',
    }
  }

  const cur  = aggregateLabor(curSubs, filterSection)
  const prev = aggregateLabor(priorSubs, filterSection)

  const totalCur   = Object.values(cur.byGl).reduce((s, r) => s + r.amount, 0)
  const totalPrior = Object.values(prev.byGl).reduce((s, r) => s + r.amount, 0)
  const periodDelta = totalCur - totalPrior

  // GL-level deltas, sorted by absolute movement
  const glDeltas = Object.entries(cur.byGl).map(([gl, curRow]) => {
    const priorAmount = prev.byGl[gl]?.amount || 0
    const delta = curRow.amount - priorAmount
    const dPct = pctDelta(curRow.amount, priorAmount)
    return { gl, label: curRow.label || gl, section: curRow.section, cur: curRow.amount, prior: priorAmount, delta, deltaPct: dPct }
  }).sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))

  // Headline
  const count = curSubs.length
  let headline = `${count} labor submission${count === 1 ? '' : 's'} posted for this period`
  if (filterSection) headline += ` (${filterSection} only)`
  headline += `, totaling ${fmt$(totalCur)}`
  if (totalPrior > 0) {
    const word = periodDelta >= 0 ? 'up' : 'down'
    headline += `, ${word} ${fmt$(Math.abs(periodDelta))} vs prior period.`
  } else {
    headline += '.'
  }

  // Bullets — top GL movers
  const bullets = []
  const movers = glDeltas.filter(g => Math.abs(g.delta) > 100).slice(0, 3)
  movers.forEach(g => {
    if (g.prior === 0) {
      bullets.push({ sign: 'up', text: `New: ${g.label} contributed ${fmt$(g.cur)}` })
    } else if (Math.abs(g.deltaPct || 0) > 10) {
      bullets.push({
        sign: g.delta > 0 ? 'up' : 'down',
        text: `${g.label} ${g.delta > 0 ? 'up' : 'down'} ${fmt$(Math.abs(g.delta))} (${g.deltaPct >= 0 ? '+' : ''}${Math.round(g.deltaPct)}%)`,
      })
    }
  })
  if (budget != null && budget !== 0 && actual != null) {
    const varPct = ((actual - budget) / budget) * 100
    if (Math.abs(varPct) > 10) {
      bullets.push({
        sign: varPct > 0 ? 'up' : 'down',
        text: `${Math.round(Math.abs(varPct))}% ${varPct > 0 ? 'over' : 'under'} budget of ${fmt$(budget)}`,
      })
    }
  }

  // Factors — top 6 GL codes by absolute amount
  const factorRows = Object.values(cur.byGl)
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 6)
  const factors = factorRows.map(row => {
    const priorAmt = prev.byGl[row.gl || row.label]?.amount || 0
    const delta = row.amount - priorAmt
    return {
      label: row.label,
      detail: row.section ? `${row.section} · ${fmt$(row.amount)}` : fmt$(row.amount),
      value: priorAmt > 0 ? (delta >= 0 ? '+' : '') + fmt$(delta) : 'new',
      sign: priorAmt === 0 ? 'up' : delta > 0 ? 'up' : 'down',
    }
  })

  return { headline, bullets, factors, drillTo: '/labor' }
}

// ============================================================================
// Engine: revenue — reads salesSubmissions
// ============================================================================

// Maps each revenue line key to the category field to aggregate on from
// salesSubmissions.entries[day].{popup,catering,retail}. null = total all.
const REVENUE_KEY_TO_CATEGORY = {
  gfs_popup:          'popup',
  gfs_catering:       'catering',
  gfs_retail:         'retail',
  gfs_total:          null,
  revenue_total:      null,
  revenue_commission: null,
}

async function loadSalesSubmissionsForPeriod(orgId, periodKey, location) {
  try {
    const col = collection(db, 'tenants', orgId, 'salesSubmissions')
    const q = query(col, where('period', '==', periodKey))
    const snap = await getDocs(q)
    const all = snap.docs.map(d => ({ id: d.id, ...d.data() }))
    return location ? all.filter(s => s.location === location) : all
  } catch (e) {
    console.error('loadSalesSubmissionsForPeriod failed:', e)
    return []
  }
}

// Sum a specific category (popup/catering/retail) or total across a
// submission's daily entries. Returns a scalar.
function sumSubmissionByCategory(submission, category) {
  const entries = submission.entries || {}
  let total = 0
  Object.values(entries).forEach(day => {
    if (!day) return
    if (category) {
      total += (parseFloat(day[category]) || 0)
    } else {
      total += (parseFloat(day.popup) || 0) + (parseFloat(day.catering) || 0) + (parseFloat(day.retail) || 0)
    }
  })
  return total
}

async function explainRevenue(ctx) {
  const { line, actual, budget, periodKey, orgId, location, isAllLocations } = ctx
  const filterLoc = isAllLocations ? null : location
  const category = REVENUE_KEY_TO_CATEGORY[line.key]

  const priorKey = getPriorKey(periodKey)
  const [curSubs, priorSubs] = await Promise.all([
    loadSalesSubmissionsForPeriod(orgId, periodKey, filterLoc),
    loadSalesSubmissionsForPeriod(orgId, priorKey, filterLoc),
  ])

  if (curSubs.length === 0) {
    return {
      headline: `No sales submissions posted for ${periodKey}${filterLoc ? ' at this location' : ''} yet. ${line.label} is pending.`,
      bullets: [],
      factors: [],
      drillTo: '/sales',
    }
  }

  // Per-location totals for current + prior
  const curByLoc = {}
  const priorByLoc = {}
  curSubs.forEach(s => {
    const amt = sumSubmissionByCategory(s, category)
    curByLoc[s.location] = (curByLoc[s.location] || 0) + amt
  })
  priorSubs.forEach(s => {
    const amt = sumSubmissionByCategory(s, category)
    priorByLoc[s.location] = (priorByLoc[s.location] || 0) + amt
  })

  const totalCur   = Object.values(curByLoc).reduce((s, v) => s + v, 0)
  const totalPrior = Object.values(priorByLoc).reduce((s, v) => s + v, 0)
  const periodDelta = totalCur - totalPrior

  // Location-level deltas, sorted by absolute movement
  const locDeltas = Object.entries(curByLoc).map(([loc, cur]) => {
    const pr = priorByLoc[loc] || 0
    const delta = cur - pr
    return { loc, cur, prior: pr, delta, deltaPct: pctDelta(cur, pr) }
  }).sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))

  // Category mix — for total-revenue lines only, break down popup/catering/retail
  let categoryMix = null
  if (!category) {
    const mix = { popup: 0, catering: 0, retail: 0 }
    curSubs.forEach(s => {
      mix.popup    += sumSubmissionByCategory(s, 'popup')
      mix.catering += sumSubmissionByCategory(s, 'catering')
      mix.retail   += sumSubmissionByCategory(s, 'retail')
    })
    categoryMix = mix
  }

  // Headline
  const submissionCount = curSubs.length
  const locationCount = Object.keys(curByLoc).length
  let headline = `${submissionCount} submission${submissionCount === 1 ? '' : 's'} from ${locationCount} location${locationCount === 1 ? '' : 's'}`
  if (category) headline += ` (${category} only)`
  headline += `, totaling ${fmt$(totalCur)}`
  if (totalPrior > 0) {
    const word = periodDelta >= 0 ? 'up' : 'down'
    headline += `, ${word} ${fmt$(Math.abs(periodDelta))} (${periodDelta >= 0 ? '+' : ''}${Math.round(pctDelta(totalCur, totalPrior) || 0)}%) vs prior period.`
  } else {
    headline += '.'
  }

  // Bullets
  const bullets = []
  const topMovers = locDeltas.filter(l => Math.abs(l.delta) > 100 && l.prior > 0 && Math.abs(l.deltaPct || 0) > 10).slice(0, 2)
  topMovers.forEach(l => {
    bullets.push({
      sign: l.delta > 0 ? 'down' : 'up',  // revenue up is good
      text: `${l.loc} ${l.delta > 0 ? 'grew' : 'declined'} ${fmt$(Math.abs(l.delta))} (${l.deltaPct >= 0 ? '+' : ''}${Math.round(l.deltaPct)}%) vs prior period`,
    })
  })
  const newLocs = locDeltas.filter(l => l.prior === 0 && l.cur > 0)
  if (newLocs.length > 0) {
    const newTotal = newLocs.reduce((s, l) => s + l.cur, 0)
    bullets.push({
      sign: 'down',  // new revenue is positive
      text: `${newLocs.length} location${newLocs.length === 1 ? '' : 's'} newly contributing ${fmt$(newTotal)}`,
    })
  }
  if (categoryMix && totalCur > 0) {
    const leader = Object.entries(categoryMix).sort((a, b) => b[1] - a[1])[0]
    bullets.push({
      sign: 'neutral',
      text: `Mix: ${leader[0]} leads at ${Math.round((leader[1] / totalCur) * 100)}% of total (${fmt$(leader[1])})`,
    })
  }
  if (budget != null && budget !== 0 && actual != null) {
    const varPct = ((actual - budget) / budget) * 100
    if (Math.abs(varPct) > 10) {
      bullets.push({
        sign: varPct > 0 ? 'down' : 'up',  // revenue over budget is good
        text: `${Math.round(Math.abs(varPct))}% ${varPct > 0 ? 'over' : 'under'} budget of ${fmt$(budget)}`,
      })
    }
  }

  // Factors — top 6 locations by absolute cur amount
  const factorRows = locDeltas
    .slice()
    .sort((a, b) => b.cur - a.cur)
    .slice(0, 6)
  const factors = factorRows.map(l => ({
    label: l.loc,
    detail: fmt$(l.cur),
    value: l.prior > 0 ? (l.delta >= 0 ? '+' : '') + fmt$(l.delta) : 'new',
    sign: l.prior === 0 ? 'down' : l.delta > 0 ? 'down' : 'up',  // revenue growth is "good" → green
  }))

  return { headline, bullets, factors, drillTo: '/sales' }
}
// ============================================================================
// Engine: waste — hybrid wasteSubmissions summary + per-location detail walk
// ============================================================================

async function loadWasteSubmissionsForPeriod(orgId, periodKey, location) {
  try {
    const col = collection(db, 'tenants', orgId, 'wasteSubmissions')
    const q = query(col, where('period', '==', periodKey))
    const snap = await getDocs(q)
    const all = snap.docs.map(d => ({ id: d.id, ...d.data() }))
    return location ? all.filter(s => s.location === location) : all
  } catch (e) {
    console.error('loadWasteSubmissionsForPeriod failed:', e)
    return []
  }
}

// Walks the per-location waste subcollection to get item-level detail.
// Only called for the top N locations to keep query count bounded.
function locationToId(name) {
  return (name || '').replace(/[^a-zA-Z0-9]/g, '_')
}

async function loadWasteEntriesForLocation(orgId, locationName, periodKey) {
  try {
    const col = collection(db, 'tenants', orgId, 'locations', locationToId(locationName), 'waste')
    const q = query(col, where('period', '==', periodKey))
    const snap = await getDocs(q)
    return snap.docs.map(d => ({ id: d.id, ...d.data() }))
  } catch (e) {
    console.error('loadWasteEntriesForLocation failed for', locationName, e)
    return []
  }
}

async function explainWaste(ctx) {
  const { line, actual, budget, periodKey, orgId, location, isAllLocations } = ctx
  const filterLoc = isAllLocations ? null : location

  const priorKey = getPriorKey(periodKey)
  const [curSubs, priorSubs] = await Promise.all([
    loadWasteSubmissionsForPeriod(orgId, periodKey, filterLoc),
    loadWasteSubmissionsForPeriod(orgId, priorKey, filterLoc),
  ])

  if (curSubs.length === 0) {
    return {
      headline: `No waste logged for ${periodKey}${filterLoc ? ' at this location' : ''} yet. Waste / shrinkage line is zero.`,
      bullets: [],
      factors: [],
      drillTo: '/waste',
    }
  }

  // Per-location totals
  const curByLoc = {}
  const priorByLoc = {}
  curSubs.forEach(s => {
    curByLoc[s.location] = (curByLoc[s.location] || 0) + (s.totalCost || 0)
  })
  priorSubs.forEach(s => {
    priorByLoc[s.location] = (priorByLoc[s.location] || 0) + (s.totalCost || 0)
  })

  const totalCur   = Object.values(curByLoc).reduce((s, v) => s + v, 0)
  const totalPrior = Object.values(priorByLoc).reduce((s, v) => s + v, 0)
  const periodDelta = totalCur - totalPrior

  const locDeltas = Object.entries(curByLoc).map(([loc, cur]) => {
    const pr = priorByLoc[loc] || 0
    return { loc, cur, prior: pr, delta: cur - pr }
  }).sort((a, b) => b.cur - a.cur)

  // HYBRID: walk per-location waste subcollection for the TOP 3 contributors
  // to surface item-level narrative ("Dairy spoilage at X +$1,200")
  const top3 = locDeltas.slice(0, 3).map(l => l.loc)
  const itemLevelByLoc = {}
  await Promise.all(top3.map(async loc => {
    const entries = await loadWasteEntriesForLocation(orgId, loc, periodKey)
    if (entries.length === 0) return
    // Group by item or category
    const byItem = {}
    entries.forEach(e => {
      const key = e.item || e.category || e.partner || 'Unknown'
      if (!byItem[key]) byItem[key] = { name: key, total: 0, count: 0 }
      byItem[key].total += (e.estimatedCost || 0)
      byItem[key].count += 1
    })
    const topItem = Object.values(byItem).sort((a, b) => b.total - a.total)[0]
    if (topItem) itemLevelByLoc[loc] = topItem
  }))

  // Headline
  const submissionCount = curSubs.length
  let headline = `${submissionCount} waste submission${submissionCount === 1 ? '' : 's'} totaling ${fmt$(totalCur)}`
  if (totalPrior > 0) {
    const word = periodDelta >= 0 ? 'up' : 'down'
    headline += `, ${word} ${fmt$(Math.abs(periodDelta))} (${periodDelta >= 0 ? '+' : ''}${Math.round(pctDelta(totalCur, totalPrior) || 0)}%) vs prior period.`
  } else {
    headline += '.'
  }

  // Bullets — item-level for top contributors
  const bullets = []
  Object.entries(itemLevelByLoc).slice(0, 3).forEach(([loc, item]) => {
    bullets.push({
      sign: 'up',
      text: `${item.name} at ${loc}: ${fmt$(item.total)}${item.count > 1 ? ` across ${item.count} entries` : ''}`,
    })
  })
  if (budget != null && budget !== 0 && actual != null) {
    const varPct = ((actual - budget) / budget) * 100
    if (Math.abs(varPct) > 10) {
      bullets.push({
        sign: varPct > 0 ? 'up' : 'down',
        text: `${Math.round(Math.abs(varPct))}% ${varPct > 0 ? 'over' : 'under'} budget of ${fmt$(budget)}`,
      })
    }
  }

  // Factors — top 6 locations by total waste cost
  const factors = locDeltas.slice(0, 6).map(l => ({
    label: l.loc,
    detail: fmt$(l.cur) + (l.prior > 0 ? ` · prior ${fmt$(l.prior)}` : ' · new this period'),
    value: l.prior > 0 ? (l.delta >= 0 ? '+' : '') + fmt$(l.delta) : 'new',
    sign: l.prior === 0 ? 'up' : l.delta > 0 ? 'up' : 'down',
  }))

  return { headline, bullets, factors, drillTo: '/waste' }
}

// ============================================================================
// Engine: inventory — reads per-location inventory subcollection
// ============================================================================

async function loadInventoryForLocation(orgId, locationName, periodKey) {
  try {
    const ref = doc(db, 'tenants', orgId, 'locations', locationToId(locationName), 'inventory', periodKey)
    const snap = await getDoc(ref)
    return snap.exists() ? snap.data() : null
  } catch (e) {
    console.error('loadInventoryForLocation failed for', locationName, e)
    return null
  }
}

function inventoryValue(invDoc) {
  if (!invDoc || !Array.isArray(invDoc.items)) return 0
  return invDoc.items.reduce((s, i) => s + ((i.qty || 0) * (i.unitCost || 0)), 0)
}

async function explainInventory(ctx) {
  const { line, actual, budget, periodKey, orgId, location, isAllLocations, history, trailingKeys } = ctx
  const filterLoc = isAllLocations ? null : location
  const priorKey = getPriorKey(periodKey)

  // Determine which locations to walk. For single-location view this is just
  // one. For All Locations, walk every visible location (passed in via context
  // through trailingKeys/history is no good — we need the actual list).
  // We use the history object's keys as a proxy: if isAllLocations and we
  // don't have a single location, we fall back to the aggregate explanation
  // because we don't have the full location list in this context.
  if (isAllLocations) {
    // Fall through to a sensible aggregate-style narrative since we don't
    // walk all 62 locations from inside the engine — the Why panel has no
    // direct access to the full visible location list. The aggregate view
    // already tells the story at the org level via the P&L doc deltas.
    return explainInventoryAggregate(ctx)
  }

  const [curInv, priorInv] = await Promise.all([
    loadInventoryForLocation(orgId, filterLoc, periodKey),
    loadInventoryForLocation(orgId, filterLoc, priorKey),
  ])

  if (!curInv) {
    return {
      headline: `No inventory count posted for ${periodKey} at ${filterLoc} yet. Inventory usage is pending.`,
      bullets: [],
      factors: [],
      drillTo: '/inventory',
    }
  }

  const closingCur   = inventoryValue(curInv)
  const closingPrior = inventoryValue(priorInv)
  // Inventory usage = opening + purchases - closing.
  // We don't have purchases at this layer, so we report what we DO have:
  // the closing value movement period over period, plus item-level deltas.
  const closingDelta = closingCur - closingPrior

  // Item-level deltas
  const curItems = curInv.items || []
  const priorItems = (priorInv?.items) || []
  const priorById = {}
  priorItems.forEach(i => { priorById[i.id || i.name] = i })

  const itemDeltas = curItems.map(i => {
    const key = i.id || i.name
    const pr = priorById[key]
    const curValue = (i.qty || 0) * (i.unitCost || 0)
    const priorValue = pr ? (pr.qty || 0) * (pr.unitCost || 0) : 0
    return {
      name: i.name || key,
      category: i.category,
      curQty: i.qty,
      priorQty: pr?.qty,
      curValue,
      priorValue,
      delta: curValue - priorValue,
    }
  }).sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))

  let headline = `Inventory closing value at ${filterLoc} is ${fmt$(closingCur)}`
  if (closingPrior > 0) {
    const word = closingDelta >= 0 ? 'up' : 'down'
    headline += `, ${word} ${fmt$(Math.abs(closingDelta))} from prior period.`
  } else {
    headline += '.'
  }

  const bullets = []
  const topItems = itemDeltas.filter(i => Math.abs(i.delta) > 50).slice(0, 3)
  topItems.forEach(i => {
    bullets.push({
      sign: i.delta > 0 ? 'down' : 'up',  // higher inventory = lower usage = "good" for COGS
      text: `${i.name}${i.category ? ` (${i.category})` : ''} ${i.delta > 0 ? 'up' : 'down'} ${fmt$(Math.abs(i.delta))}`,
    })
  })
  if (actual != null && actual !== 0) {
    bullets.push({
      sign: 'neutral',
      text: `Inventory usage on the P&L is ${fmt$(actual)} (opening + purchases - closing)`,
    })
  }

  const factors = itemDeltas.slice(0, 6).map(i => ({
    label: i.name,
    detail: i.category ? `${i.category} · qty ${i.curQty || 0}` : `qty ${i.curQty || 0}`,
    value: i.priorValue > 0 ? (i.delta >= 0 ? '+' : '') + fmt$(i.delta) : 'new',
    sign: i.priorValue === 0 ? 'up' : i.delta > 0 ? 'up' : 'down',
  }))

  return { headline, bullets, factors, drillTo: '/inventory' }
}

// Aggregate-only narrative for inventory in All Locations view.
function explainInventoryAggregate(ctx) {
  const { actual, prior, periodKey } = ctx
  const headline = actual != null && actual !== 0
    ? `Inventory usage across all locations is ${fmt$(actual)} for ${periodKey}.`
    : `No inventory usage posted for ${periodKey} yet across the org.`
  const bullets = []
  if (prior != null && prior !== 0 && actual != null) {
    const delta = actual - prior
    bullets.push({
      sign: delta > 0 ? 'up' : 'down',
      text: `${delta > 0 ? 'Up' : 'Down'} ${fmt$(Math.abs(delta))} vs prior period`,
    })
    bullets.push({
      sign: 'neutral',
      text: 'Item-level inventory drill-down available when viewing a single location',
    })
  }
  return {
    headline,
    bullets,
    factors: [],
    drillTo: '/inventory',
  }
}

function explainFromAggregates(ctx) {
  const { line, actual, budget, prior, history, trailingKeys } = ctx

  if (actual == null || actual === 0) {
    return {
      headline: `${line.label} is zero for this period. No activity posted yet.`,
      bullets: [],
      factors: [],
      drillTo: line.drillTo,
    }
  }

  const bullets = []
  const factors = []

  // Prior period comparison
  if (prior != null && prior !== 0) {
    const delta = actual - prior
    const pct = pctDelta(actual, prior)
    bullets.push({
      sign: delta > 0 ? 'up' : 'down',
      text: `${delta > 0 ? 'Up' : 'Down'} ${fmt$(Math.abs(delta))} vs prior period (${pct > 0 ? '+' : ''}${Math.round(pct)}%)`,
    })
  }

  // Budget variance
  if (budget != null && budget !== 0) {
    const variance = actual - budget
    const varPct = (variance / budget) * 100
    if (Math.abs(varPct) > 5) {
      bullets.push({
        sign: variance > 0 ? 'up' : 'down',
        text: `${variance > 0 ? 'Over' : 'Under'} budget by ${fmt$(Math.abs(variance))} (${Math.round(Math.abs(varPct))}%)`,
      })
    } else {
      bullets.push({
        sign: 'neutral',
        text: `Within 5% of budget (${fmt$(budget)})`,
      })
    }
  }

  // Historical context — compare to trailing 12 average
  if (history && Array.isArray(trailingKeys) && trailingKeys.length > 1) {
    const historicalValues = trailingKeys
      .slice(0, -1)  // exclude current
      .map(k => {
        const p = history[k] || {}
        return line.computeFn ? line.computeFn(p) : p[line.key]
      })
      .filter(v => v != null && !isNaN(v) && v !== 0)

    if (historicalValues.length >= 3) {
      const avg = historicalValues.reduce((a, b) => a + b, 0) / historicalValues.length
      const diffPct = pctDelta(actual, avg)
      if (diffPct != null && Math.abs(diffPct) > 10) {
        bullets.push({
          sign: diffPct > 0 ? 'up' : 'down',
          text: `${diffPct > 0 ? 'Above' : 'Below'} trailing ${historicalValues.length}-period average (${fmt$(avg)}) by ${Math.round(Math.abs(diffPct))}%`,
        })
      }
      factors.push({
        label: 'Trailing average',
        detail: `${historicalValues.length} prior periods`,
        value: fmt$(avg),
        sign: 'neutral',
      })
    }
  }

  if (prior != null) {
    factors.push({
      label: 'Prior period',
      detail: null,
      value: fmt$(prior),
      sign: 'neutral',
    })
  }
  if (budget != null && budget !== 0) {
    factors.push({
      label: 'Budget',
      detail: null,
      value: fmt$(budget),
      sign: 'neutral',
    })
  }

  const headline = prior != null && prior !== 0
    ? `${line.label} landed at ${fmt$(actual)} for this period, ${actual >= prior ? 'up' : 'down'} ${fmt$(Math.abs(actual - prior))} vs prior.`
    : `${line.label} is at ${fmt$(actual)} for this period.`

  return { headline, bullets, factors, drillTo: line.drillTo }
}

// ============================================================================
// Period-over-period narrative diff — for the executive summary at the top
// ============================================================================
//
// Generates a 1-3 sentence executive summary comparing current period to
// prior period. Used at the top of the P&L tab to give an at-a-glance
// "what happened this period" before the user dives into the table.
//
// Returns { summary, sentiment } where sentiment is 'positive', 'negative',
// or 'neutral' for color-coding the banner.
export function buildPeriodDiff(pnl, priorPnl, history, trailingKeys, locationLabel, isAllLocations) {
  if (!pnl || Object.keys(pnl).length === 0 || (pnl.gfs_total || 0) === 0) {
    return {
      summary: `No activity posted yet for this period. Once data flows in from Weekly Sales, Purchasing, Labor, and the other source tabs, the executive summary will appear here.`,
      sentiment: 'neutral',
    }
  }

  const gfs       = pnl.gfs_total || 0
  const rev       = pnl.revenue_total || 0
  const labor     = (pnl.cogs_onsite_labor || 0) + (pnl.cogs_3rd_party || 0)
  const payproc   = gfs * 0.018
  const cogs      = labor + (pnl.cogs_inventory || 0) + (pnl.cogs_purchases || 0) + (pnl.cogs_waste || 0) + payproc
  const ebitda    = rev - cogs - (pnl.exp_comp_benefits || 0)

  const priorGfs   = priorPnl?.gfs_total || 0
  const priorRev   = priorPnl?.revenue_total || 0
  const priorLabor = (priorPnl?.cogs_onsite_labor || 0) + (priorPnl?.cogs_3rd_party || 0)
  const priorPayp  = priorGfs * 0.018
  const priorCogs  = priorLabor + (priorPnl?.cogs_inventory || 0) + (priorPnl?.cogs_purchases || 0) + (priorPnl?.cogs_waste || 0) + priorPayp
  const priorEbitda = priorRev - priorCogs - (priorPnl?.exp_comp_benefits || 0)

  // No prior data — give a snapshot summary instead of a comparison
  if (priorGfs === 0 && priorRev === 0) {
    return {
      summary: `${isAllLocations ? 'Across all locations' : locationLabel}: ${fmt$(rev)} in revenue, ${fmt$(ebitda)} EBITDA. No prior period data available to compare against yet.`,
      sentiment: 'neutral',
    }
  }

  // Compute the key deltas
  const ebitdaDelta = ebitda - priorEbitda
  const revDelta    = rev - priorRev
  const laborDelta  = labor - priorLabor
  const cogsDelta   = cogs - priorCogs

  // Identify the top driver(s) of the EBITDA change
  const drivers = []
  if (Math.abs(revDelta) > 100) {
    drivers.push({
      kind: revDelta > 0 ? 'revenue growth' : 'revenue decline',
      magnitude: Math.abs(revDelta),
      direction: revDelta > 0 ? 'positive' : 'negative',
    })
  }
  if (Math.abs(laborDelta) > 100) {
    drivers.push({
      kind: laborDelta > 0 ? 'higher labor costs' : 'reduced labor costs',
      magnitude: Math.abs(laborDelta),
      direction: laborDelta > 0 ? 'negative' : 'positive',
    })
  }
  const foodCostDelta = (pnl.cogs_inventory || 0) + (pnl.cogs_purchases || 0) + (pnl.cogs_waste || 0)
                      - ((priorPnl?.cogs_inventory || 0) + (priorPnl?.cogs_purchases || 0) + (priorPnl?.cogs_waste || 0))
  if (Math.abs(foodCostDelta) > 100) {
    drivers.push({
      kind: foodCostDelta > 0 ? 'higher food costs' : 'reduced food costs',
      magnitude: Math.abs(foodCostDelta),
      direction: foodCostDelta > 0 ? 'negative' : 'positive',
    })
  }
  drivers.sort((a, b) => b.magnitude - a.magnitude)

  // Build the summary sentence(s)
  const scope = isAllLocations ? 'across all locations' : `at ${locationLabel}`
  const sentiment = ebitdaDelta > 100 ? 'positive' : ebitdaDelta < -100 ? 'negative' : 'neutral'

  let summary
  if (Math.abs(ebitdaDelta) < 100) {
    summary = `EBITDA ${scope} is essentially flat vs prior period at ${fmt$(ebitda)}. Revenue ${revDelta >= 0 ? 'up' : 'down'} ${fmt$(Math.abs(revDelta))}, costs ${cogsDelta >= 0 ? 'up' : 'down'} ${fmt$(Math.abs(cogsDelta))} — net wash.`
  } else {
    const direction = ebitdaDelta > 0 ? 'better' : 'worse'
    summary = `This period is trending ${fmt$(Math.abs(ebitdaDelta))} ${direction} ${scope} vs prior period (EBITDA ${fmt$(ebitda)} vs ${fmt$(priorEbitda)}).`

    if (drivers.length > 0) {
      const topDriver = drivers[0]
      summary += ` Largest driver: ${topDriver.kind} of ${fmt$(topDriver.magnitude)}.`
      if (drivers.length > 1) {
        const secondDriver = drivers[1]
        summary += ` Also notable: ${secondDriver.kind} of ${fmt$(secondDriver.magnitude)}.`
      }
    }
  }

  // Optional: how does this compare to the trailing 12-period average?
  if (history && Array.isArray(trailingKeys) && trailingKeys.length > 4) {
    const historicalEbitdas = trailingKeys
      .slice(0, -1)
      .map(k => {
        const p = history[k] || {}
        const r = p.revenue_total || 0
        const l = (p.cogs_onsite_labor || 0) + (p.cogs_3rd_party || 0)
        const pp = (p.gfs_total || 0) * 0.018
        const c = l + (p.cogs_inventory || 0) + (p.cogs_purchases || 0) + (p.cogs_waste || 0) + pp
        return r - c - (p.exp_comp_benefits || 0)
      })
      .filter(v => v !== 0 && !isNaN(v))

    if (historicalEbitdas.length >= 4) {
      const avg = historicalEbitdas.reduce((a, b) => a + b, 0) / historicalEbitdas.length
      const diffFromAvg = ebitda - avg
      if (Math.abs(diffFromAvg) > Math.abs(avg) * 0.1) {  // more than 10% off trend
        const word = diffFromAvg > 0 ? 'above' : 'below'
        summary += ` ${diffFromAvg > 0 ? 'Tracking above' : 'Tracking below'} the trailing ${historicalEbitdas.length}-period average of ${fmt$(avg)}.`
      }
    }
  }

  return { summary, sentiment }
}

