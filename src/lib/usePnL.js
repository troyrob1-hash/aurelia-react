// src/lib/usePnL.js
//
// React hooks wrapping the subscribePnL Firestore primitive.
//
// - usePnL(location, period): single-location live subscription
// - useMultiLocationPnL(locations, period): parallel subscriptions across
//   multiple locations with aggregation (for the "All Locations" view)
//
// Both hooks return { data, loading, lastUpdated } and auto-cleanup on unmount.

import { useState, useEffect, useRef } from 'react'
import { subscribePnL, fetchPnLHistory, weeksInPeriod, locId, getLaborRates, enrichPnLLabor } from './pnl'
import { ledgerContributionsForPeriod, ledgerContributionsMulti } from './ledgerContributions'
import { useLocations } from '@/store/LocationContext'

// Keys that are numeric and get summed in aggregation.
// Keep this list in sync with what the P&L schema actually reads.
const NUMERIC_KEYS = [
  // Revenue / GFS
  'gfs_retail', 'gfs_catering', 'gfs_popup', 'gfs_total',
  'revenue_commission', 'revenue_total',
  // Revenue sub-lines (manual + import both populate these now)
  'rev_popup_cogs', 'rev_popup_food_sales', 'rev_popup_tax', 'rev_popup_pp_fee',
  'rev_catering_cogs', 'rev_catering_revenue', 'rev_catering_pp_fee',
  'rev_retail_barista', 'rev_retail_cafeteria', 'rev_retail_cogs_tax', 'rev_client_fees',
  // Labor
  'cogs_onsite_labor', 'cogs_onsite_labor_hourly', 'cogs_3rd_party', 'exp_comp_benefits', 'labor_total',
  'cogs_labor_salaries', 'cogs_labor_401k', 'cogs_labor_benefits', 'cogs_labor_taxes', 'cogs_labor_bonus',
  // COGS — inventory + purchasing rollup + categorized GL lines
  'cogs_inventory', 'cogs_purchases', 'cogs_waste', 'closingValue', 'openingValue',
  'cogs_cleaning', 'cogs_equipment', 'cogs_ec_barista', 'cogs_paper',
  'cogs_supplies', 'cogs_uniforms', 'cogs_maintenance', 'cogs_shrinkage',
  'cogs_payment_processing',
  'cogs_retail_barista', 'cogs_retail_cafeteria', 'cogs_retail_managed',
  // Expenses
  'exp_office_supplies', 'exp_mktg_cashier', 'exp_mktg_coupons', 'exp_mktg_marketing',
  'exp_mktg_other', 'exp_technology', 'exp_travel', 'exp_professional',
  'exp_facilities', 'exp_licenses', 'exp_other',
  // Budget lines
  'budget_gfs', 'budget_revenue', 'budget_cogs', 'budget_labor', 'budget_ebitda', 'budget_expenses',
  // AP / misc
  'ap_paid', 'ap_pending', 'waste_oz',
]

// READ-TIME LEDGER ENRICHMENT — the JE→P&L bridge (model a). Wraps usePnL and
// folds live journal-entry contributions (e.g. salary → cogs_labor_salaries on
// GL 50410) into the in-memory pnl object, then derives burden. pnl docs are
// NEVER mutated — enrichment is per-read and always the sum of the JE sources.
// Every P&L reader that shows a JE-targeted line goes through this hook.
export function useLedgerEnrichedPnL(location, period) {
  const { data, loading, lastUpdated } = usePnL(location, period)
  const [enriched, setEnriched] = useState(data)

  useEffect(() => {
    let cancelled = false
    if (!location || !period) { setEnriched(data); return }
    ;(async () => {
      try {
        const [contribs, rates] = await Promise.all([
          ledgerContributionsForPeriod(locId(location), period),
          getLaborRates(),
        ])
        if (!cancelled) setEnriched(enrichPnLLabor(data, contribs, rates))
      } catch {
        if (!cancelled) setEnriched(enrichPnLLabor(data, {}, undefined)) // fail-open: burden on stored base
      }
    })()
    return () => { cancelled = true }
  }, [location, period, data])

  return { data: enriched, loading, lastUpdated }
}

// All-Locations variant — same read-time ledger enrichment on the aggregate
// (salary + burden summed across the location set).
export function useLedgerEnrichedMultiPnL(locations, period) {
  const base = useMultiLocationPnL(locations, period)
  const [enriched, setEnriched] = useState(base.data)

  useEffect(() => {
    let cancelled = false
    if (!Array.isArray(locations) || !locations.length || !period) { setEnriched(base.data); return }
    ;(async () => {
      try {
        const [contribs, rates] = await Promise.all([
          ledgerContributionsMulti(locations.map(locId), period),
          getLaborRates(),
        ])
        if (!cancelled) setEnriched(enrichPnLLabor(base.data, contribs, rates))
      } catch {
        if (!cancelled) setEnriched(enrichPnLLabor(base.data, {}, undefined))
      }
    })()
    return () => { cancelled = true }
  }, [JSON.stringify(locations), period, base.data])

  return { ...base, data: enriched }
}

// Single-location subscription hook.
export function usePnL(location, period) {
  const [data, setData] = useState({})
  const [loading, setLoading] = useState(true)
  const [lastUpdated, setLastUpdated] = useState(null)
  const { allLocations } = useLocations()

  // Determine if this is a parent location with sub-cafes
  const locObj = allLocations.find(l => l.name === location || l.id === location || l.locationId === location)
  const isParent = locObj?.type === 'parent'
  const subCafes = isParent
    ? allLocations.filter(l => l.parentLocationId === locObj?.locationId || l.parentLocationId === locObj?.id || l.parentLocation === locObj?.name)
    : []

  useEffect(() => {
    if (!location || !period) {
      setData({})
      setLoading(false)
      return
    }

    // Parent location: subscribe to all sub-cafe P&Ls and aggregate
    if (isParent && subCafes.length > 0) {
      setLoading(true)
      const subSnapshots = {}
      const unsubs = []

      for (const sub of subCafes) {
        if (period.endsWith('-MONTHLY')) {
          // Monthly: aggregate weeks for each sub-cafe
          const base = period.replace('-MONTHLY', '')
          const parts = base.match(/(\d+)-P(\d+)/)
          if (!parts) continue
          const numWks = weeksInPeriod(parseInt(parts[1]), parseInt(parts[2]))
          for (let w = 1; w <= numWks; w++) {
            const wk = base + '-W' + w
            const subKey = sub.name + '|' + wk
            unsubs.push(subscribePnL(sub.name, wk, (snap) => {
              subSnapshots[subKey] = snap
              aggregateAndSet()
            }))
          }
        } else {
          unsubs.push(subscribePnL(sub.name, period, (snap) => {
            subSnapshots[sub.name] = snap
            aggregateAndSet()
          }))
        }
      }

      // Also subscribe to the parent's own doc (for budget fields)
      unsubs.push(subscribePnL(location, period, (snap) => {
        subSnapshots['__parent__'] = snap
        aggregateAndSet()
      }))

      function aggregateAndSet() {
        const merged = {}
        Object.entries(subSnapshots).forEach(([key, snap]) => {
          if (key === '__parent__') {
            // Only pull budget fields from parent
            Object.entries(snap).forEach(([k, v]) => {
              if (k.startsWith('budget_') && typeof v === 'number') {
                merged[k] = v
              }
            })
            return
          }
          Object.entries(snap).forEach(([k, v]) => {
            if (typeof v === 'number') merged[k] = (merged[k] || 0) + v
            else if (!(k in merged)) merged[k] = v
          })
        })
        merged._isRollup = true
        merged._subCafeCount = subCafes.length
        setData(merged)
        setLoading(false)
        setLastUpdated(new Date())
      }

      return () => unsubs.forEach(fn => fn())
    }

    // Monthly view: aggregate all week docs for this period
    if (period.endsWith('-MONTHLY')) {
      setLoading(true)
      const base = period.replace('-MONTHLY', '')
      const parts = base.match(/(\d+)-P(\d+)/)
      if (!parts) { setData({}); setLoading(false); return }
      const numWks = weeksInPeriod(parseInt(parts[1]), parseInt(parts[2]))
      const weekSnapshots = {}
      const unsubs = []
      for (let w = 1; w <= numWks; w++) {
        const wk = base + '-W' + w
        unsubs.push(subscribePnL(location, wk, (snap) => {
          weekSnapshots[wk] = snap
          // Re-aggregate every time any week updates
          const merged = {}
          Object.values(weekSnapshots).forEach(ws => {
            Object.entries(ws).forEach(([k, v]) => {
              if (typeof v === 'number') merged[k] = (merged[k] || 0) + v
              else if (!(k in merged)) merged[k] = v
            })
          })
          setData(merged)
          setLoading(false)
          setLastUpdated(new Date())
        }))
      }
      return () => unsubs.forEach(fn => fn())
    }

    setLoading(true)
    const unsub = subscribePnL(location, period, (snapshot, updatedAt) => {
      setData(snapshot)
      setLastUpdated(updatedAt)
      setLoading(false)
    }, () => {
      setLoading(false)
    })
    return () => unsub()
  }, [location, period])

  return { data, loading, lastUpdated }
}

// Multi-location aggregation hook.
// Subscribes to each location in parallel and returns the SUM across all
// numeric keys. lastUpdated reflects the most recent update across all subs.
export function useMultiLocationPnL(locations, period) {
  const [perLocation, setPerLocation] = useState({})
  const [loading, setLoading] = useState(true)
  const [lastUpdated, setLastUpdated] = useState(null)
  const receivedRef = useRef(new Set())

  useEffect(() => {
    if (!Array.isArray(locations) || locations.length === 0 || !period) {
      setPerLocation({})
      setLoading(false)
      return
    }
    setLoading(true)
    setPerLocation({})
    receivedRef.current = new Set()

    const unsubs = locations.map(loc =>
      subscribePnL(loc, period, (snapshot, updatedAt) => {
        setPerLocation(prev => ({ ...prev, [loc]: snapshot }))
        if (updatedAt) {
          setLastUpdated(prev => (!prev || updatedAt > prev) ? updatedAt : prev)
        }
        receivedRef.current.add(loc)
        if (receivedRef.current.size >= locations.length) {
          setLoading(false)
        }
      }, () => {
        receivedRef.current.add(loc)
        if (receivedRef.current.size >= locations.length) {
          setLoading(false)
        }
      })
    )
    return () => unsubs.forEach(u => u && u())
  }, [JSON.stringify(locations), period])

  // Aggregate numeric keys across all locations
  const aggregated = {}
  NUMERIC_KEYS.forEach(k => { aggregated[k] = 0 })
  Object.values(perLocation).forEach(locData => {
    NUMERIC_KEYS.forEach(k => {
      aggregated[k] += (locData[k] || 0)
    })
  })

  return { data: aggregated, perLocation, loading, lastUpdated }
}

// Historical data hook — loads N prior periods of P&L data for one or
// many locations. Used to power KPI strip sparklines and 12-period
// trend charts.
//
// Unlike usePnL / useMultiLocationPnL, this is NOT a live subscription:
// historical data doesn't change, so we load once per (locations, periodKeys)
// input and cache in state.
//
// Returns:
//   {
//     byPeriod: { '2026-P04-W1': { gfs_total: 4820, ... }, ... },
//     loading
//   }
// For multi-location calls, byPeriod values are SUMS across all locations.
export function usePnLHistory(locations, periodKeys) {
  const [byPeriod, setByPeriod] = useState({})
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!Array.isArray(locations) || locations.length === 0 ||
        !Array.isArray(periodKeys) || periodKeys.length === 0) {
      setByPeriod({})
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)
    ;(async () => {
      try {
        // Fetch each location's history in parallel
        const perLocation = await Promise.all(
          locations.map(loc => fetchPnLHistory(loc, periodKeys).catch(() => ({})))
        )
        if (cancelled) return

        // Aggregate: for each period, sum numeric keys across all locations
        const aggregated = {}
        periodKeys.forEach(pk => {
          const zeros = {}
          NUMERIC_KEYS.forEach(k => { zeros[k] = 0 })
          perLocation.forEach(locHistory => {
            const periodData = locHistory[pk]
            if (!periodData) return
            NUMERIC_KEYS.forEach(k => {
              zeros[k] += (periodData[k] || 0)
            })
          })
          aggregated[pk] = zeros
        })
        // Read-time ledger enrichment per period (salary → cogs_labor_salaries +
        // derived burden), so trend/EBITDA sparklines include ledger labor too.
        const rates = await getLaborRates()
        const locIds = locations.map(locId)
        await Promise.all(periodKeys.map(async pk => {
          const contribs = await ledgerContributionsMulti(locIds, pk).catch(() => ({}))
          aggregated[pk] = enrichPnLLabor(aggregated[pk], contribs, rates)
        }))
        if (cancelled) return
        setByPeriod(aggregated)
      } catch (e) {
        console.error('usePnLHistory error:', e)
        setByPeriod({})
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [JSON.stringify(locations), JSON.stringify(periodKeys)])

  return { byPeriod, loading }
}

