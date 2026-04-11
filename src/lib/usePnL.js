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
import { subscribePnL, fetchPnLHistory } from './pnl'

// Keys that are numeric and get summed in aggregation.
// Keep this list in sync with what the P&L schema actually reads.
const NUMERIC_KEYS = [
  'gfs_retail', 'gfs_catering', 'gfs_popup', 'gfs_total',
  'revenue_commission', 'revenue_total',
  'cogs_onsite_labor', 'cogs_3rd_party', 'cogs_inventory',
  'cogs_purchases', 'cogs_waste', 'exp_comp_benefits',
  'budget_gfs', 'budget_revenue', 'budget_cogs', 'budget_labor', 'budget_ebitda',
  'inv_closing', 'inv_opening', 'inv_purchases',
  'ap_paid', 'ap_pending', 'labor_total', 'waste_oz',
]

// Single-location subscription hook.
export function usePnL(location, period) {
  const [data, setData] = useState({})
  const [loading, setLoading] = useState(true)
  const [lastUpdated, setLastUpdated] = useState(null)

  useEffect(() => {
    if (!location || !period) {
      setData({})
      setLoading(false)
      return
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

