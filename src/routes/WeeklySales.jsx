import { useState, useEffect, useMemo, useRef } from 'react'
import { useAuthStore } from '@/store/authStore'
import { useLocations, cleanLocName } from '@/store/LocationContext'
import { db } from '@/lib/firebase'
import { doc, getDoc, setDoc, addDoc, updateDoc, collection, query, where, orderBy, limit, getDocs, serverTimestamp, writeBatch } from 'firebase/firestore'
import { Download, Upload, CheckCircle, Clock, AlertCircle, TrendingUp, TrendingDown } from 'lucide-react'
import { useToast } from '@/components/ui/Toast'
import { usePeriod } from '@/store/PeriodContext'
import { readPeriodClose } from '@/lib/pnl'
import { writeSalesPnL } from '@/lib/pnl'
import Breadcrumb from '@/components/ui/Breadcrumb'
import { useDragDropUpload } from '@/hooks/useDragDropUpload'
import DropZoneOverlay from '@/components/ui/DropZoneOverlay'
import { canApproveSales } from '@/lib/permissions'
import {
  ResponsiveContainer, ComposedChart, Area, Line, ReferenceLine,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from 'recharts'
import styles from './WeeklySales.module.css'

// Full list of weekday names — used for iterating over a week. Individual
// locations can customize which days they operate via the operatingDays
// field on their location doc (falls back to Mon-Fri if unset).
const DAYS = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday']
const DAY_ABBR = { Monday: 'Mon', Tuesday: 'Tue', Wednesday: 'Wed', Thursday: 'Thu', Friday: 'Fri', Saturday: 'Sat', Sunday: 'Sun' }
const DEFAULT_OPERATING_DAYS = ['Mon','Tue','Wed','Thu','Fri']

/**
 * Returns the list of weekday abbreviations this location operates on.
 * Reads from the location config if present, otherwise returns the default.
 *
 * NOTE: Location configs currently live at tenants/{orgId}/legacy/inv_locs
 * as part of a single document's `value` map. This is tracked in FOLLOWUPS.md
 * under "reconcile locations two-path split" — post-pilot migration to
 * proper subcollection.
 */
function getOperatingDays(locationData) {
  const days = locationData?.operatingDays
  if (Array.isArray(days) && days.length > 0) return days
  return DEFAULT_OPERATING_DAYS
}

const CATS = [
  { key: 'popup',    label: 'Popup',    color: '#059669' },
  { key: 'catering', label: 'Catering', color: '#7c3aed' },
  { key: 'retail',   label: 'Retail',   color: '#2563eb' },
]

function locId(name) { return (name || '').replace(/[^a-zA-Z0-9]/g, '_') }

const fmt$ = v => v ? '$' + Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—'
const fmtPct = v => v > 0 ? `▲ ${v.toFixed(1)}%` : v < 0 ? `▼ ${Math.abs(v).toFixed(1)}%` : '—'
const fmtPctRaw = v => v !== null ? (v * 100).toFixed(1) + '%' : '—'

function getPriorKey(key) {
  const parts = key.match(/(\d+)-P(\d+)-W(\d+)/)
  if (!parts) return null
  let [, yr, p, w] = parts.map(Number)
  if (w > 1) return `${yr}-P${String(p).padStart(2,'0')}-W${w-1}`
  if (p > 1) return `${yr}-P${String(p-1).padStart(2,'0')}-W4`
  return `${yr-1}-P12-W4`
}

function getYoYKey(key) {
  const parts = key.match(/(\d+)-P(\d+)-W(\d+)/)
  if (!parts) return null
  const [, yr, p, w] = parts
  return `${Number(yr)-1}-P${p}-W${w}`
}

export default function WeeklySales() {
  const { user }             = useAuthStore()
  const orgId                = user?.tenantId || 'fooda'
  const { selectedLocation, visibleLocations, currentLocation } = useLocations()
  const { year, period, week: weekNum, currentWeek, periodKey, prevWeek, nextWeek } = usePeriod()
  const toast                = useToast()

  const [entries,      setEntries]      = useState({})
  const [priorEntries, setPriorEntries] = useState({})
  const [yoyEntries,   setYoyEntries]   = useState({})
  const [forecast,     setForecast]     = useState({})
  const [budgetData,   setBudgetData]   = useState({})
  const [commRate,     setCommRate]     = useState(0.18)
  const [lastSaved,    setLastSaved]    = useState(null)
  const [savedBy,      setSavedBy]      = useState('')
  const [loading,      setLoading]      = useState(false)
  const [saving,       setSaving]       = useState(false)
  const [dirty,        setDirty]        = useState(false)
  const [approvalStatus, setApproval]   = useState(null)

  const [periodClosed, setPeriodClosed] = useState(false)
  useEffect(() => {
    if (!selectedLocation || selectedLocation === 'all' || !periodKey) return
    (async () => {
      try {
        const close = await readPeriodClose(selectedLocation, periodKey)
        setPeriodClosed(close.periodStatus === 'closed')
      } catch {}
    })()
  }, [selectedLocation, periodKey])

  const [tabClosed, setTabClosed] = useState(false)
  useEffect(() => {
    if (!selectedLocation || selectedLocation === 'all' || !periodKey) return
    (async () => {
      try {
        const { getDoc, doc: fbDoc } = await import('firebase/firestore')
        const oid = user?.tenantId || 'fooda'
        const ref = fbDoc(db, 'tenants', oid, 'salesClose', `${(selectedLocation||'').replace(/[^a-zA-Z0-9]/g,'_')}-${periodKey}`)
        const snap = await getDoc(ref)
        if (snap.exists()) setTabClosed(true)
      } catch {}
    })()
  }, [selectedLocation, periodKey])

  async function handleCloseTab() {
    if (!selectedLocation || selectedLocation === 'all') return
    if (!window.confirm(`Close Sales for ${periodKey}?`)) return
    try {
      const { setDoc, doc: fbDoc, serverTimestamp } = await import('firebase/firestore')
      const oid = user?.tenantId || 'fooda'
      await setDoc(fbDoc(db, 'tenants', oid, 'salesClose', `${(selectedLocation||'').replace(/[^a-zA-Z0-9]/g,'_')}-${periodKey}`), {
        location: selectedLocation, period: periodKey,
        closedBy: user?.name || user?.email, closedAt: serverTimestamp(),
      })
      const { writePnL: wp } = await import('@/lib/pnl')
      await wp(selectedLocation, periodKey, { source_sales: 'closed' })
      setTabClosed(true)
      toast.success('Sales closed for ' + periodKey)
    } catch (err) {
      toast.error('Failed: ' + (err.message || ''))
    }
  }
  const [submissionId,   setSubmissionId] = useState(null)
  const [showRejectModal, setShowRejectModal] = useState(false)
  const [rejectNote,   setRejectNote]   = useState(false)
  const [approving, setApproving] = useState(false)
  const [submissionEvents, setSubmissionEvents] = useState([])
  const [rejectNoteFromDoc, setRejectNoteFromDoc] = useState('')
  const [hoveredCell, setHoveredCell] = useState(null)  // { dateKey, catKey, x, y } for context card
  const [compareMode, setCompareMode]   = useState(null)  // null | 'priorPeriod' | 'yoy' | 'location'
  const [compareTarget, setCompareTarget] = useState(null)  // location name for 'location' mode
  const [compareData, setCompareData]   = useState([])  // parallel 12-week data for comparison
  const [compareLoading, setCompareLoading] = useState(false)
  const [showCompareMenu, setShowCompareMenu] = useState(false)
  const [anomalies,    setAnomalies]    = useState({})
  const [allLocData,   setAllLocData]   = useState([])
  const [historyChart, setHistoryChart] = useState([])  // trailing 12 weeks for chart


  // Request counter to cancel stale loadData calls when user rapidly switches
  // locations or weeks. Each loadData bumps this and captures its own ID;
  // if the ID doesn't match by the time an await resolves, bail silently.
  const loadRequestId = useRef(0)

  // Dismiss hover context card when the user scrolls — the card is
  // position: fixed and would otherwise strand at the wrong screen position
  // while the underlying cell scrolls out from under it.
  useEffect(() => {
    if (!hoveredCell) return
    const dismiss = () => setHoveredCell(null)
    window.addEventListener('scroll', dismiss, true)
    return () => window.removeEventListener('scroll', dismiss, true)
  }, [hoveredCell])

  // Drag-and-drop file upload (shared hook handles enter/leave counting,
  // escape-to-dismiss, and drag-end cleanup)
  const { isDragging, dragHandlers, dismiss: dismissDropZone } = useDragDropUpload({
    acceptedExtensions: ['.xlsx', '.xls', '.csv'],
    onFile: async (file) => { await processSalesFile(file) },
    onInvalidFile: () => toast.error('Please drop a .xlsx, .xls, or .csv file'),
  })

  const location = selectedLocation === 'all' ? null : selectedLocation
  const isAll    = selectedLocation === 'all'
  const isDirector = canApproveSales(user)  // directors, VPs, and admins can approve

  const week = useMemo(() => {
    if (!currentWeek) return null
    const start = currentWeek.start
    const end   = currentWeek.end
    const operatingDays = getOperatingDays(currentLocation)
    return {
      weekKey: periodKey,
      label: `P${period} Wk ${weekNum} · ${start.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} – ${end.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`,
      operatingDays,
      days: DAYS.map((name, i) => {
        const d = new Date(start)
        d.setDate(start.getDate() + i)
        d.setHours(12, 0, 0, 0)
        if (d > end) return null
        if (!operatingDays.includes(DAY_ABBR[name])) return null
        return { name, date: d, key: d.toISOString().slice(0, 10) }
      }).filter(Boolean)
    }
  }, [currentWeek, periodKey, period, weekNum, currentLocation])

  // Derive chart data with the current week's forecast projection layered in,
  // and compare data layered in if compare mode is active.
  const chartDataWithForecast = useMemo(() => {
    if (!historyChart.length || !week) return historyChart

    return historyChart.map((row, i) => {
      let enhanced = row

      // Forecast layer for the current week
      if (row.isCurrent) {
        const today = new Date()
        today.setHours(0, 0, 0, 0)

        let projectedTotal = 0
        week.days.forEach(day => {
          const dayEntered = (parseFloat(entries[day.key]?.popup)    || 0) +
                             (parseFloat(entries[day.key]?.catering) || 0) +
                             (parseFloat(entries[day.key]?.retail)   || 0)
          if (dayEntered > 0 || day.date <= today) {
            projectedTotal += dayEntered
          } else {
            const fc = forecast[day.key] || {}
            projectedTotal += (parseFloat(fc.popup)    || 0) +
                              (parseFloat(fc.catering) || 0) +
                              (parseFloat(fc.retail)   || 0)
          }
        })

        enhanced = {
          ...enhanced,
          forecastTotal: projectedTotal > row.total ? projectedTotal : null,
        }
      }

      // Compare layer — parallel value at the same index
      if (compareMode && compareData[i] !== undefined) {
        enhanced = { ...enhanced, compareTotal: compareData[i] }
      }

      return enhanced
    })
  }, [historyChart, forecast, entries, week, compareMode, compareData])

  const priorKey = getPriorKey(periodKey)
  const yoyKey   = getYoYKey(periodKey)

  useEffect(() => {
    if (!week) return
    if (isAll) { loadAllLocations(); return }
    if (!location) return
    loadData()
  }, [location, week?.weekKey, isAll])

  async function loadData() {
    // Bump the request counter and capture this call's ID
    const requestId = ++loadRequestId.current
    const isStale = () => loadRequestId.current !== requestId

    setLoading(true)
    // Reset all data state so a failed or empty load doesn't show stale data
    // from a previously-viewed location. Without this, switching locations
    // can display the wrong location's numbers in the "Prior Week" and "YoY"
    // comparison columns until the new data loads.
    setPriorEntries({})
    setYoyEntries({})
    setBudgetData({})
    try {
      const cfgSnap = await getDoc(doc(db, 'tenants', orgId, 'config', 'sales'))
      if (cfgSnap.exists()) setCommRate(cfgSnap.data().commissionRate || 0.18)

      const ref  = doc(db, 'tenants', orgId, 'locations', locId(location), 'sales', periodKey)
      const snap = await getDoc(ref)
      if (isStale()) return
      const data = snap.exists() ? (snap.data().entries || {}) : {}
      setEntries(data)
      setLastSaved(snap.exists() ? snap.data().updatedAt : null)
      setSavedBy(snap.exists() ? snap.data().updatedBy || '' : '')

      if (priorKey) {
        const pRef  = doc(db, 'tenants', orgId, 'locations', locId(location), 'sales', priorKey)
        const pSnap = await getDoc(pRef)
        setPriorEntries(pSnap.exists() ? (pSnap.data().entries || {}) : {})
      }

      if (yoyKey) {
        const yRef  = doc(db, 'tenants', orgId, 'locations', locId(location), 'sales', yoyKey)
        const ySnap = await getDoc(yRef)
        setYoyEntries(ySnap.exists() ? (ySnap.data().entries || {}) : {})
      }

      const bRef  = doc(db, 'tenants', orgId, 'budgets', `${locId(location)}-${year}`)
      const bSnap = await getDoc(bRef)
      if (bSnap.exists()) {
        const months = bSnap.data().months || {}
        const monthly = months[period] || {}
        setBudgetData({
          gfs:      (monthly.gfs      || 0) / 4.33,
          popup:    (monthly.popup    || 0) / 4.33,
          catering: (monthly.catering || 0) / 4.33,
          retail:   (monthly.retail   || 0) / 4.33,
        })
      }

      if (isStale()) return  // user moved on; don't overwrite state
      await loadHistoryAndForecast(data)
      if (isStale()) return
      await loadHistoryChart()

      const q = query(
        collection(db, 'tenants', orgId, 'salesSubmissions'),
        where('period', '==', periodKey),
        where('location', '==', location),
        where('status', 'in', ['pending', 'approved', 'rejected']),
        orderBy('createdAt', 'desc'),
        limit(1)
      )
      const subSnap = await getDocs(q)
      if (!subSnap.empty) {
        const d = subSnap.docs[0].data()
        setSubmissionId(subSnap.docs[0].id)
        setApproval(d.status)
        setSubmissionEvents(d.events || [])
        setRejectNoteFromDoc(d.rejectNote || '')
      } else {
        setApproval(null)
        setSubmissionId(null)
        setSubmissionEvents([])
        setRejectNoteFromDoc('')
      }

    } catch (e) {
      if (isStale()) return  // stale error, ignore
      console.error('Failed to load sales data:', e)
      toast.error('Failed to load sales data — ' + (e.message || 'unknown error'))
    }
    if (isStale()) return
    setLoading(false)
    setDirty(false)
  }

  async function loadHistoryAndForecast(currentEntries) {
    if (!week || !location) return
    try {
      const history = {}
      for (let i = 1; i <= 8; i++) {
        const d = new Date(currentWeek.start)
        d.setDate(d.getDate() - (i * 7))
        const histYear = d.getFullYear()
        const histMo   = d.getMonth() + 1
        const histKey  = `${histYear}-P${String(histMo).padStart(2,'0')}-W1`
        try {
          const hRef  = doc(db, 'tenants', orgId, 'locations', locId(location), 'sales', histKey)
          const hSnap = await getDoc(hRef)
          if (hSnap.exists()) history[histKey] = hSnap.data().entries || {}
        } catch { /* skip */ }
      }

      const fc = {}
      week.days.forEach(day => {
        const dow = day.date.getDay()
        const samples = { popup: [], catering: [], retail: [] }

        Object.values(history).forEach(weekEntries => {
          Object.entries(weekEntries).forEach(([dateKey, vals]) => {
            const d = new Date(dateKey)
            if (d.getDay() === dow) {
              CATS.forEach(c => {
                const v = parseFloat(vals[c.key] || 0)
                if (v > 0) samples[c.key].push(v)
              })
            }
          })
        })

        fc[day.key] = {}
        CATS.forEach(c => {
          const arr = samples[c.key].slice(-4)
          fc[day.key][c.key] = arr.length > 0 ? arr.reduce((s, v) => s + v, 0) / arr.length : 0
        })
      })
      setForecast(fc)

      const flags = {}
      week.days.forEach(day => {
        CATS.forEach(c => {
          const current = parseFloat(currentEntries[day.key]?.[c.key] || 0)
          if (current === 0) return
          const dow = day.date.getDay()
          const samples = []
          Object.values(history).forEach(weekEntries => {
            Object.entries(weekEntries).forEach(([dateKey, vals]) => {
              const d = new Date(dateKey)
              if (d.getDay() === dow) {
                const v = parseFloat(vals[c.key] || 0)
                if (v > 0) samples.push(v)
              }
            })
          })
          if (samples.length < 3) return
          const mean = samples.reduce((s, v) => s + v, 0) / samples.length
          const std  = Math.sqrt(samples.reduce((s, v) => s + (v - mean) ** 2, 0) / samples.length)
          if (std > 0 && Math.abs(current - mean) > 2.5 * std) {
            flags[`${day.key}_${c.key}`] = { mean, std, direction: current > mean ? 'high' : 'low' }
          }
        })
      })
      setAnomalies(flags)
    } catch (e) { console.warn('Anomaly detection skipped:', e) }
  }

  // Load trailing 12 weeks of sales for the history chart.
  // Returns data in shape: [{ weekKey, label, popup, catering, retail, total }, ...]
  // ordered oldest to newest. Current week is always the last entry.
  async function loadHistoryChart() {
    if (!location || !week) return
    try {
      const weekKeys = []
      let key = week.weekKey
      weekKeys.unshift(key)
      for (let i = 0; i < 11; i++) {
        key = getPriorKey(key)
        if (!key) break
        weekKeys.unshift(key)
      }

      // Load all 12 weeks in parallel
      const results = await Promise.all(weekKeys.map(async (wk) => {
        try {
          const ref = doc(db, 'tenants', orgId, 'locations', locId(location), 'sales', wk)
          const snap = await getDoc(ref)
          const entries = snap.exists() ? (snap.data().entries || {}) : {}
          const totals = { popup: 0, catering: 0, retail: 0 }
          Object.values(entries).forEach(day => {
            CATS.forEach(c => {
              totals[c.key] += parseFloat(day?.[c.key]) || 0
            })
          })
          const parts = wk.match(/(\d+)-P(\d+)-W(\d+)/)
          const label = parts ? `P${parts[2]}W${parts[3]}` : wk
          const total = totals.popup + totals.catering + totals.retail
          return {
            weekKey: wk,
            label,
            ...totals,
            total,
            isCurrent: wk === week.weekKey,
            // forecastTotal is populated only for the current week in the effect below,
            // after forecast data has been loaded.
            forecastTotal: null,
          }
        } catch {
          return null
        }
      }))

      setHistoryChart(results.filter(Boolean))
    } catch (e) {
      console.error('Failed to load sales history chart:', e)
    }
  }

  // Load a parallel 12-week dataset for comparison mode.
  // Supports: prior period, year-over-year, or another location.
  async function loadCompareData(mode, targetLocation = null) {
    if (!location || !week) return
    setCompareLoading(true)
    try {
      // Build 12 week keys depending on mode
      const weekKeys = []
      let seedKey = week.weekKey
      if (mode === 'priorPeriod') {
        // Shift each week back by 4 (roughly one period) to compare
        // previous period's same-week numbers
        for (let i = 0; i < 4; i++) seedKey = getPriorKey(seedKey)
      } else if (mode === 'yoy') {
        seedKey = getYoYKey(seedKey)
      }
      // For 'location' mode we keep the same weeks, just a different location.
      if (!seedKey) {
        setCompareLoading(false)
        return
      }

      weekKeys.push(seedKey)
      let k = seedKey
      for (let i = 0; i < 11; i++) {
        k = getPriorKey(k)
        if (!k) break
        weekKeys.unshift(k)
      }

      const targetLoc = mode === 'location' ? targetLocation : location
      const results = await Promise.all(weekKeys.map(async (wk) => {
        try {
          const ref = doc(db, 'tenants', orgId, 'locations', locId(targetLoc), 'sales', wk)
          const snap = await getDoc(ref)
          const entries = snap.exists() ? (snap.data().entries || {}) : {}
          const totals = { popup: 0, catering: 0, retail: 0 }
          Object.values(entries).forEach(day => {
            CATS.forEach(c => {
              totals[c.key] += parseFloat(day?.[c.key]) || 0
            })
          })
          return totals.popup + totals.catering + totals.retail
        } catch {
          return 0
        }
      }))

      setCompareData(results)
    } catch (e) {
      console.error('Failed to load compare data:', e)
      toast.error('Failed to load comparison data')
    } finally {
      setCompareLoading(false)
    }
  }

  function openCompare(mode, targetLocation = null) {
    setCompareMode(mode)
    setCompareTarget(targetLocation)
    setShowCompareMenu(false)
    loadCompareData(mode, targetLocation)
  }

  function clearCompare() {
    setCompareMode(null)
    setCompareTarget(null)
    setCompareData([])
    setShowCompareMenu(false)
  }

  async function loadAllLocations() {
    setLoading(true)
    try {
      const locNames = visibleLocations.map(l => l.name)

      // Build the list of 8 prior week keys once (same for every location)
      const weekKeys = [periodKey]
      let k = periodKey
      for (let i = 0; i < 7; i++) {
        k = getPriorKey(k)
        if (!k) break
        weekKeys.unshift(k)
      }

      const results = await Promise.all(locNames.map(async name => {
        // Fetch all 8 weeks for this location in parallel
        const weekSnaps = await Promise.all(weekKeys.map(async wk => {
          try {
            const ref = doc(db, 'tenants', orgId, 'locations', locId(name), 'sales', wk)
            const snap = await getDoc(ref)
            const entries = snap.exists() ? (snap.data().entries || {}) : {}
            const total = Object.values(entries).reduce((s, d) =>
              s + CATS.reduce((ss, c) => ss + (parseFloat(d?.[c.key] || 0)), 0), 0)
            return { weekKey: wk, total }
          } catch {
            return { weekKey: wk, total: 0 }
          }
        }))

        // Current and prior week totals are derived from the sparkline data
        const current = weekSnaps[weekSnaps.length - 1]
        const prior   = weekSnaps[weekSnaps.length - 2]
        const total      = current?.total || 0
        const priorTotal = prior?.total || 0

        return {
          name,
          total,
          priorTotal,
          hasData: total > 0,
          sparkline: weekSnaps.map(w => w.total),
        }
      }))
      setAllLocData(results.sort((a, b) => b.total - a.total))
    } catch (e) { console.error('Failed to load location data:', e); toast.error('Failed to load location data — ' + (e.message || 'unknown')) }
    setLoading(false)
  }

  async function handleSave() {
    if (!location || !week) return
    if (approvalStatus === 'approved') {
      toast.error('This period is already approved. Contact a director to unlock.')
      return
    }
    setSaving(true)
    try {
      // Atomic batch write: sales doc + submission doc succeed or fail together.
      // Previously, a mid-save failure could leave orphaned sales data with no
      // corresponding submission record, or vice versa.
      const batch = writeBatch(db)

      const salesRef = doc(db, 'tenants', orgId, 'locations', locId(location), 'sales', week.weekKey)
      batch.set(salesRef, {
        entries,
        weekKey:   week.weekKey,
        location,
        updatedAt: serverTimestamp(),  // use server time for consistency with submission
        updatedBy: user?.name || user?.email || 'unknown',
      }, { merge: true })

      const actor = user?.name || user?.email || 'unknown'
      const now   = new Date().toISOString()

      const subData = {
        period:      periodKey,
        location,
        entries,
        weekTotal,
        submittedBy: actor,
        status:      'pending',
        updatedAt:   serverTimestamp(),
      }

      let newSubmissionId = submissionId
      if (submissionId) {
        const subRef = doc(db, 'tenants', orgId, 'salesSubmissions', submissionId)
        // On re-submission (after rejection or edit), append a 'resubmitted' event
        const { arrayUnion } = await import('firebase/firestore')
        batch.update(subRef, {
          ...subData,
          events: arrayUnion({
            action: approvalStatus === 'rejected' ? 'resubmitted' : 'updated',
            actor,
            timestamp: now,
            weekTotal,
          }),
        })
      } else {
        // Create a new ref with an auto-generated ID so we can use batch.set()
        const subRef = doc(collection(db, 'tenants', orgId, 'salesSubmissions'))
        batch.set(subRef, {
          ...subData,
          createdAt: serverTimestamp(),
          events: [{
            action: 'submitted',
            actor,
            timestamp: now,
            weekTotal,
          }],
        })
        newSubmissionId = subRef.id
      }

      await batch.commit()
      if (!submissionId) setSubmissionId(newSubmissionId)
      setApproval('pending')
      toast.success('Sales saved — pending director approval before posting to P&L')
      setDirty(false)
      setLastSaved(new Date().toISOString())
      setSavedBy(user?.name || user?.email || '')
    } catch (e) {
      console.error('Save failed:', e)
      toast.error('Save failed — ' + (e.message || 'Please try again.'))
    }
    setSaving(false)
  }

  async function handleApprove() {
    if (!submissionId) return
    // Confirm with the director before posting to P&L (destructive action)
    const confirmMsg = `Approve this submission and post ${fmt$(weekTotal)} to the P&L?\n\nLocation: ${cleanLocName(location)}\nPeriod: ${periodKey}\n\nThis cannot be undone without manual P&L adjustment.`
    if (!window.confirm(confirmMsg)) return
    setApproving(true)
    try {
      // Read the submission from Firestore to get the ACTUAL submitted data,
      // not whatever the director currently has on screen. This prevents
      // a director from approving the wrong period by accident if they
      // navigated to a different week while reviewing.
      const subRef  = doc(db, 'tenants', orgId, 'salesSubmissions', submissionId)
      const subSnap = await getDoc(subRef)
      if (!subSnap.exists()) {
        toast.error('Submission not found')
        return
      }
      const submittedData = subSnap.data()

      const { arrayUnion } = await import('firebase/firestore')
      const actor = user?.name || user?.email || 'unknown'

      // Mark the submission as approved and append an audit event
      await updateDoc(subRef, {
        status:     'approved',
        approvedBy: actor,
        approvedAt: serverTimestamp(),
        events: arrayUnion({
          action: 'approved',
          actor,
          timestamp: new Date().toISOString(),
          weekTotal: submittedData.weekTotal || 0,
        }),
      })

      // Compute totals from the SUBMITTED entries (not current state)
      const subEntries = submittedData.entries || {}
      const popup    = Object.values(subEntries).reduce((s, d) => s + (parseFloat(d?.popup)    || 0), 0)
      const catering = Object.values(subEntries).reduce((s, d) => s + (parseFloat(d?.catering) || 0), 0)
      const retail   = Object.values(subEntries).reduce((s, d) => s + (parseFloat(d?.retail)   || 0), 0)

      // Post to P&L using the submitted location and period, not current state
      await writeSalesPnL(
        submittedData.location || location,
        submittedData.period || periodKey,
        { retail, catering, popup }
      )

      setApproval('approved')
      toast.success('Sales approved — period closed')
    } catch (e) {
      console.error('Approval failed:', e)
      toast.error('Approval failed — ' + (e.message || 'unknown error'))
    } finally {
      setApproving(false)
    }
  }

  async function handleRejectConfirm() {
    if (!rejectNote?.trim()) { toast.error('Please enter a reason'); return }
    if (!submissionId) { toast.error('No submission to reject'); return }
    try {
      const { arrayUnion } = await import('firebase/firestore')
      const actor = user?.name || user?.email || 'unknown'
      const note = rejectNote.trim()

      await updateDoc(doc(db, 'tenants', orgId, 'salesSubmissions', submissionId), {
        status:     'rejected',
        rejectedBy: actor,
        rejectedAt: serverTimestamp(),
        rejectNote: note,
        events: arrayUnion({
          action: 'rejected',
          actor,
          timestamp: new Date().toISOString(),
          note,
        }),
      })
      setApproval('rejected')
      setShowRejectModal(false)
      setRejectNote('')
      toast.success('Submission rejected')
    } catch (e) {
      console.error('Rejection failed:', e)
      toast.error('Rejection failed — ' + (e.message || 'unknown error'))
    }
  }

  function setVal(dateKey, cat, val) {
    const num = parseFloat(val) || 0
    if (num < 0) { toast.error('Sales cannot be negative'); return }
    if (num > 999999) { toast.error('Value seems too large — please verify'); return }
    setEntries(prev => ({
      ...prev,
      [dateKey]: { ...(prev[dateKey] || {}), [cat]: num }
    }))
    setDirty(true)
  }

  // Keyboard navigation between entry cells.
  // Arrow keys move to adjacent cells, Enter moves to the next row,
  // Cmd/Ctrl+Enter saves the week.
  function handleCellKeyDown(e, rowIdx, colIdx) {
    const maxRows = week?.days.length || 0
    const maxCols = CATS.length

    const focusCell = (row, col) => {
      const target = document.querySelector(`[data-entry-row="${row}"][data-entry-col="${col}"]`)
      if (target) {
        target.focus()
        target.select()
      }
    }

    if (e.key === 'ArrowDown' || (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey)) {
      e.preventDefault()
      focusCell(Math.min(rowIdx + 1, maxRows - 1), colIdx)
    } else if (e.key === 'ArrowUp' || (e.key === 'Enter' && e.shiftKey)) {
      e.preventDefault()
      focusCell(Math.max(rowIdx - 1, 0), colIdx)
    } else if (e.key === 'ArrowRight' && e.currentTarget.selectionStart === e.currentTarget.value.length) {
      e.preventDefault()
      focusCell(rowIdx, Math.min(colIdx + 1, maxCols - 1))
    } else if (e.key === 'ArrowLeft' && e.currentTarget.selectionStart === 0) {
      e.preventDefault()
      focusCell(rowIdx, Math.max(colIdx - 1, 0))
    } else if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault()
      if (dirty && !saving) handleSave()
    }
  }

  // Excel-style bulk paste: paste a grid of numbers (tab-separated cols,
  // newline-separated rows) and fill the entry table starting from the
  // focused cell. Parses clipboard text and writes all values in a single
  // setState call for proper batching.
  function handleCellPaste(e, rowIdx, colIdx) {
    const text = e.clipboardData?.getData('text')
    if (!text) return

    // Parse the clipboard as a grid. Support tab, comma, or semicolon as
    // column delimiters; newline as row delimiter.
    const rows = text.trim().split(/\r?\n/).map(row => row.split(/[\t,;]/))

    // If it's a single value, fall through to default paste behavior
    if (rows.length === 1 && rows[0].length === 1) return

    e.preventDefault()
    if (approvalStatus === 'approved') {
      toast.error('This period is locked. Contact a director to unlock.')
      return
    }

    const maxRows = week?.days.length || 0
    const maxCols = CATS.length
    let cellsWritten = 0
    let skipped = 0

    setEntries(prev => {
      const next = { ...prev }
      rows.forEach((rowVals, rOffset) => {
        const targetRow = rowIdx + rOffset
        if (targetRow >= maxRows) return
        const day = week.days[targetRow]
        if (!day) return

        rowVals.forEach((rawVal, cOffset) => {
          const targetCol = colIdx + cOffset
          if (targetCol >= maxCols) return
          const cat = CATS[targetCol]
          // Strip currency symbols and commas, then parse
          const cleaned = rawVal.replace(/[$,\s]/g, '')
          const num = parseFloat(cleaned)
          if (isNaN(num) || num < 0) { skipped++; return }
          if (num > 999999) { skipped++; return }
          next[day.key] = { ...(next[day.key] || {}), [cat.key]: num }
          cellsWritten++
        })
      })
      return next
    })

    if (cellsWritten > 0) {
      setDirty(true)
      toast.success(`Pasted ${cellsWritten} value${cellsWritten !== 1 ? 's' : ''}${skipped > 0 ? ` (${skipped} skipped)` : ''}`)
    } else if (skipped > 0) {
      toast.error(`Paste failed — ${skipped} invalid values`)
    }
  }

  function getVal(dateKey, cat) { return entries[dateKey]?.[cat] ?? '' }

  function dayTotal(dateKey, src = entries) {
    return CATS.reduce((s, c) => s + (parseFloat(src[dateKey]?.[c.key]) || 0), 0)
  }

  function pctChange(curr, prev) {
    if (!prev || prev === 0) return null
    return ((curr - prev) / prev) * 100
  }

  // Shared parser used by both file picker and drag-drop
  async function processSalesFile(file) {
    if (!file) return
    if (approvalStatus === 'approved') {
      toast.error('This period is already approved.')
      return
    }
    try {
      const XLSX      = await import('xlsx')
      const ab        = await file.arrayBuffer()
      const wb        = XLSX.read(new Uint8Array(ab), { type: 'array', cellDates: true })
      const sheetName = wb.SheetNames.find(s => s !== 'Sheet1') || wb.SheetNames[0]
      const ws        = wb.Sheets[sheetName]
      const rows      = XLSX.utils.sheet_to_json(ws, { raw: false, dateNF: 'yyyy-mm-dd' })
      parseSalesRows(rows)
    } catch (err) { console.error("Sales import failed:", err);
      toast.error('Import failed. Try exporting as CSV from Excel first.')
    }
  }

  async function handleImport(e) {
    const file = e.target.files[0]
    await processSalesFile(file)
    e.target.value = ''
  }

  function parseSalesRows(rows) {
    const newEntries = {}
    const weekDates  = new Set(week?.days.map(d => d.key))
    const currentSite = location || ''

    rows.forEach(row => {
      if (currentSite) {
        const site = (row['Site Name'] || row['site_name'] || '').trim()
        if (site && site !== currentSite) return
      }
      const dateVal = row['Event Date'] || row['event_date'] || row['Date'] || row['date']
      if (!dateVal) return
      const d = new Date(dateVal)
      if (isNaN(d)) return
      // Build the date key from LOCAL components, not UTC.
      // toISOString() returns UTC which can shift the date by a day for users
      // west of UTC when the source is a pure date string (Excel dates without time).
      const yyyy = d.getFullYear()
      const mm   = String(d.getMonth() + 1).padStart(2, '0')
      const dd   = String(d.getDate()).padStart(2, '0')
      const key  = `${yyyy}-${mm}-${dd}`
      if (!weekDates.has(key)) return

      const locName = (row['Location Name'] || '').toLowerCase()
      let cat = 'retail'
      if (/cater/i.test(locName))        cat = 'catering'
      else if (/pop.?up|popup/i.test(locName)) cat = 'popup'

      const gross = parseFloat(row['Gross Food Sales'] || row['Gross Food Sale (before min sales adjustments)'] || row['Amount'] || 0)
      if (!gross) return
      if (!newEntries[key]) newEntries[key] = {}
      newEntries[key][cat] = ((parseFloat(newEntries[key][cat]) || 0) + gross)
    })

    const total = Object.values(newEntries).reduce((s, d) => s + Object.values(d).reduce((ss, v) => ss + (v || 0), 0), 0)
    if (total === 0) {
      toast.error('No matching data found. Check that the location name matches.')
      return
    }

    // MERGE with existing entries instead of replacing them. The previous
    // behavior destroyed manually-entered sales if the CSV didn't contain
    // the same days/categories. Now we only update the specific (date, category)
    // pairs that appear in the CSV, leaving everything else intact.
    setEntries(prev => {
      const merged = { ...prev }
      Object.entries(newEntries).forEach(([dateKey, cats]) => {
        merged[dateKey] = { ...(prev[dateKey] || {}), ...cats }
      })
      return merged
    })
    setDirty(true)
    toast.success(`Imported ${fmt$(total)} in sales`)
  }

  function exportCSV() {
    const rows = [['Date', ...CATS.map(c => c.label), 'Day Total', 'vs LW', 'vs LY', 'Forecast']]
    week?.days.forEach(d => {
      const dt    = dayTotal(d.key)
      const prior = dayTotal(d.key, priorEntries)
      const yoy   = dayTotal(d.key, yoyEntries)
      const fc    = forecast[d.key] ? CATS.reduce((s, c) => s + (forecast[d.key][c.key] || 0), 0) : 0
      rows.push([d.key, ...CATS.map(c => entries[d.key]?.[c.key] || 0), dt.toFixed(2),
        prior ? pctChange(dt, prior)?.toFixed(1) + '%' : '', yoy ? pctChange(dt, yoy)?.toFixed(1) + '%' : '', fc.toFixed(2)])
    })
    const blob = new Blob([rows.map(r => r.join(',')).join('\n')], { type: 'text/csv' })
    const url  = URL.createObjectURL(blob)
    Object.assign(document.createElement('a'), { href: url, download: `sales-${location}-${periodKey}.csv` }).click()
    URL.revokeObjectURL(url)
  }

  const catTotals = CATS.reduce((acc, c) => {
    acc[c.key] = week ? week.days.reduce((s, d) => s + (parseFloat(entries[d.key]?.[c.key]) || 0), 0) : 0
    return acc
  }, {})
  const weekTotal      = Object.values(catTotals).reduce((s, v) => s + v, 0)
  const priorWeekTotal = week ? week.days.reduce((s, d) => s + dayTotal(d.key, priorEntries), 0) : 0
  const yoyWeekTotal   = week ? week.days.reduce((s, d) => s + dayTotal(d.key, yoyEntries), 0) : 0
  const forecastTotal  = week ? week.days.reduce((s, d) => {
    return s + (forecast[d.key] ? CATS.reduce((ss, c) => ss + (forecast[d.key][c.key] || 0), 0) : 0)
  }, 0) : 0
  const budgetTotal    = budgetData.gfs || 0
  const weekVsBudget   = pctChange(weekTotal, budgetTotal)
  const weekVsLW       = pctChange(weekTotal, priorWeekTotal)
  const weekVsYoY      = pctChange(weekTotal, yoyWeekTotal)

  const today       = new Date(); today.setHours(12, 0, 0, 0)
  const daysElapsed = week ? week.days.filter(d => d.date <= today).length : 0
  const daysTotal   = week?.days.length || 7
  const paceTarget  = budgetTotal > 0 && daysElapsed > 0 ? (budgetTotal / daysTotal) * daysElapsed : null
  const paceStatus  = paceTarget ? (weekTotal >= paceTarget ? 'ahead' : 'behind') : null
  const paceGap     = paceTarget ? weekTotal - paceTarget : null

  const catMix = CATS.map(c => ({
    ...c,
    total: catTotals[c.key],
    pct:   weekTotal > 0 ? catTotals[c.key] / weekTotal : 0,
  }))

  if (!location && !isAll) return (
    <div className={styles.empty}>
      <div className={styles.emptyIcon}><TrendingUp size={32} strokeWidth={1.5} /></div>
      <p className={styles.emptyTitle}>Select a location to view sales</p>
      <p className={styles.emptySub}>Choose a location from the dropdown above to log or review weekly sales</p>
    </div>
  )

  if (!week) return <div className={styles.loading}>Loading...</div>

  if (isAll) {
    const allTotal       = allLocData.reduce((s, l) => s + l.total, 0)
    const allPriorTotal  = allLocData.reduce((s, l) => s + l.priorTotal, 0)
    const reportingCount = allLocData.filter(l => l.hasData).length
    const reportingPct   = allLocData.length > 0 ? (reportingCount / allLocData.length) * 100 : 0
    const wowChange      = allPriorTotal > 0 ? pctChange(allTotal, allPriorTotal) : null
    const topPerformers  = [...allLocData].filter(l => l.hasData && l.priorTotal > 0).sort((a, b) => {
      const aChg = (a.total - a.priorTotal) / a.priorTotal
      const bChg = (b.total - b.priorTotal) / b.priorTotal
      return bChg - aChg
    }).slice(0, 3)

    // Mini sparkline renderer — a small SVG showing 8-week trend
    const Sparkline = ({ data, color = '#1D9E75' }) => {
      if (!data || data.length === 0) return null
      const max = Math.max(...data, 1)
      const min = Math.min(...data)
      const range = max - min || 1
      const w = 80
      const h = 24
      const points = data.map((v, i) => {
        const x = (i / (data.length - 1)) * w
        const y = h - ((v - min) / range) * h
        return `${x},${y}`
      }).join(' ')
      return (
        <svg width={w} height={h} style={{ display: 'block' }}>
          <polyline
            points={points}
            fill="none"
            stroke={color}
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <circle
            cx={(data.length - 1) / (data.length - 1) * w}
            cy={h - ((data[data.length - 1] - min) / range) * h}
            r="2.5"
            fill={color}
          />
        </svg>
      )
    }

    return (
      <div className={styles.page}>
        {/* ── Header ── */}
        <div className={styles.header}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <Breadcrumb items={['Revenue', 'Weekly Sales']} />
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 2, flexWrap: 'wrap' }}>
              <h1 className={styles.title} style={{ margin: 0 }}>Weekly Sales</h1>
              <span style={{
                display: 'inline-flex', alignItems: 'center', gap: 6,
                padding: '4px 10px', background: '#f1f5f9', border: '0.5px solid #e2e8f0',
                borderRadius: 20, fontSize: 12, color: '#475569', fontWeight: 500,
              }}>
                📍 All Locations
              </span>
              <span style={{
                display: 'inline-flex', alignItems: 'center', gap: 6,
                padding: '4px 10px', background: '#f1f5f9', border: '0.5px solid #e2e8f0',
                borderRadius: 20, fontSize: 12, color: '#475569', fontWeight: 500,
              }}>
                📅 {periodKey}
              </span>
            </div>
            <div style={{ fontSize: 12, color: '#94a3b8', marginTop: 6 }}>
              {reportingCount} of {allLocData.length} locations reporting · {fmt$(allTotal)} total this week
            </div>
          </div>
        </div>

        {/* ── Summary KPI bar ── */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 20 }}>
          <div style={{ padding: '18px 20px', background: '#0f172a', borderRadius: 12, color: '#fff' }}>
            <div style={{ fontSize: 10, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 600 }}>Total GFS</div>
            <div style={{ fontSize: 26, fontWeight: 700, marginTop: 6 }}>{fmt$(allTotal)}</div>
            {allPriorTotal > 0 && (
              <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 4 }}>
                vs {fmt$(allPriorTotal)} prior week
              </div>
            )}
          </div>
          <div style={{ padding: '18px 20px', background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12 }}>
            <div style={{ fontSize: 10, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 600 }}>vs Prior Week</div>
            <div style={{ fontSize: 26, fontWeight: 700, marginTop: 6, color: wowChange != null ? (wowChange >= 0 ? '#059669' : '#dc2626') : '#0f172a' }}>
              {wowChange != null ? fmtPct(wowChange) : '—'}
            </div>
            {wowChange != null && (
              <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 4 }}>
                {wowChange >= 0 ? 'Growing' : 'Declining'}
              </div>
            )}
          </div>
          <div style={{ padding: '18px 20px', background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12 }}>
            <div style={{ fontSize: 10, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 600 }}>Reporting</div>
            <div style={{ fontSize: 26, fontWeight: 700, marginTop: 6 }}>
              {reportingCount}<span style={{ fontSize: 16, color: '#94a3b8', fontWeight: 500 }}>/{allLocData.length}</span>
            </div>
            <div style={{ position: 'relative', height: 4, background: '#f1f5f9', borderRadius: 2, marginTop: 8, overflow: 'hidden' }}>
              <div style={{
                position: 'absolute', top: 0, left: 0, bottom: 0,
                width: `${reportingPct}%`,
                background: reportingPct === 100 ? '#10b981' : reportingPct >= 80 ? '#3b82f6' : '#f59e0b',
                borderRadius: 2,
                transition: 'width 0.4s ease-out',
              }} />
            </div>
          </div>
          <div style={{ padding: '18px 20px', background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12 }}>
            <div style={{ fontSize: 10, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 600 }}>Top Performers</div>
            <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 3 }}>
              {topPerformers.length > 0 ? topPerformers.map((loc, i) => {
                const pct = pctChange(loc.total, loc.priorTotal)
                return (
                  <div key={loc.name} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11 }}>
                    <span style={{ color: '#0f172a', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 140 }}>
                      {i + 1}. {cleanLocName(loc.name)}
                    </span>
                    <span style={{ color: '#059669', fontWeight: 600, flexShrink: 0 }}>+{pct.toFixed(0)}%</span>
                  </div>
                )
              }) : <div style={{ fontSize: 11, color: '#94a3b8' }}>No comparable data yet</div>}
            </div>
          </div>
        </div>

        {/* ── Location heat grid ── */}
        {loading ? (
          <div style={{ textAlign: 'center', padding: 60, color: '#94a3b8' }}>Loading locations...</div>
        ) : allLocData.length === 0 ? (
          <div style={{ textAlign: 'center', padding: 60, color: '#94a3b8' }}>No locations to display</div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 12 }}>
            {allLocData.map((loc) => {
              const chg = pctChange(loc.total, loc.priorTotal)
              const performanceColor = !loc.hasData ? '#e2e8f0'
                : chg == null ? '#64748b'
                : chg >= 10 ? '#10b981'
                : chg >= 0 ? '#3b82f6'
                : chg >= -10 ? '#f59e0b'
                : '#dc2626'

              return (
                <div
                  key={loc.name}
                  onClick={() => setSelectedLocation(loc.name)}
                  style={{
                    padding: '16px 18px',
                    background: '#fff',
                    border: '1px solid #e5e7eb',
                    borderRadius: 12,
                    borderLeft: `3px solid ${performanceColor}`,
                    cursor: 'pointer',
                    transition: 'all 0.15s',
                  }}
                  onMouseEnter={e => { e.currentTarget.style.transform = 'translateY(-2px)'; e.currentTarget.style.boxShadow = '0 4px 12px rgba(0,0,0,0.06)' }}
                  onMouseLeave={e => { e.currentTarget.style.transform = 'translateY(0)'; e.currentTarget.style.boxShadow = 'none' }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: '#0f172a', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '75%' }}>
                      {cleanLocName(loc.name)}
                    </div>
                    {loc.hasData
                      ? <span style={{ fontSize: 9, padding: '2px 6px', background: '#dcfce7', color: '#166534', borderRadius: 10, fontWeight: 600 }}>●</span>
                      : <span style={{ fontSize: 9, padding: '2px 6px', background: '#fef3c7', color: '#854d0e', borderRadius: 10, fontWeight: 600 }}>○</span>}
                  </div>

                  <div style={{ fontSize: 22, fontWeight: 700, color: loc.hasData ? '#0f172a' : '#cbd5e1' }}>
                    {loc.hasData ? fmt$(loc.total) : '—'}
                  </div>

                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 10 }}>
                    {chg != null && loc.hasData ? (
                      <span style={{
                        fontSize: 11, fontWeight: 600,
                        color: chg >= 0 ? '#059669' : '#dc2626',
                      }}>
                        {chg >= 0 ? '▲' : '▼'} {Math.abs(chg).toFixed(1)}%
                      </span>
                    ) : (
                      <span style={{ fontSize: 11, color: '#94a3b8' }}>
                        {loc.hasData ? 'No prior data' : 'Not submitted'}
                      </span>
                    )}
                    <Sparkline data={loc.sparkline} color={performanceColor !== '#e2e8f0' ? performanceColor : '#94a3b8'} />
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    )
  }

  return (
    <div
      className={styles.page}
      {...dragHandlers}
    >
      {isDragging && (
        <DropZoneOverlay
          title="Drop sales file here"
          subtitle="Accepts .xlsx, .xls, or .csv"
          onClose={dismissDropZone}
        />
      )}

      <style>{`
        @keyframes anomalyPulse {
          0%, 100% {
            box-shadow: 0 0 0 0 rgba(245, 158, 11, 0.6);
          }
          50% {
            box-shadow: 0 0 0 4px rgba(245, 158, 11, 0);
          }
        }
        @keyframes pulseDot {
          0%, 100% { opacity: 1; transform: scale(1); }
          50% { opacity: 0.4; transform: scale(0.85); }
        }
        @keyframes contextFadeIn {
          from { opacity: 0; transform: translate(-50%, -4px); }
          to { opacity: 1; transform: translate(-50%, 0); }
        }
      `}</style>

      {/* ── Cell hover context card ── */}
      {hoveredCell && (() => {
        const { dateKey, catKey, dayName, catLabel, catColor, x, y } = hoveredCell
        const currentVal  = parseFloat(entries[dateKey]?.[catKey]) || 0
        const priorVal    = parseFloat(priorEntries[dateKey]?.[catKey]) || 0
        const yoyVal      = parseFloat(yoyEntries[dateKey]?.[catKey]) || 0
        const forecastVal = parseFloat(forecast[dateKey]?.[catKey]) || 0
        const anomaly     = anomalies[`${dateKey}_${catKey}`]
        const avg8w       = anomaly?.mean || 0

        // Always show the card — even empty state is informative
        // (the user learns the hover feature exists)
        const hasAnyData = currentVal > 0 || priorVal > 0 || yoyVal > 0 || forecastVal > 0 || avg8w > 0

        const compareLine = (label, val, color) => {
          if (val === 0) return null
          const diff = currentVal - val
          const pct  = val > 0 ? ((diff / val) * 100) : null
          return (
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 11, padding: '4px 0' }}>
              <span style={{ color: '#94a3b8' }}>{label}</span>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ color: '#e2e8f0', fontFamily: 'ui-monospace, monospace' }}>{fmt$(val)}</span>
                {currentVal > 0 && pct !== null && (
                  <span style={{
                    fontSize: 10, fontWeight: 600,
                    color: diff >= 0 ? '#6ee7b7' : '#fca5a5',
                    minWidth: 46, textAlign: 'right',
                  }}>
                    {diff >= 0 ? '+' : ''}{pct.toFixed(0)}%
                  </span>
                )}
              </div>
            </div>
          )
        }

        return (
          <div
            style={{
              position: 'fixed',
              left: x,
              top: y - 8,
              transform: 'translate(-50%, -100%)',
              background: '#0f172a',
              color: '#fff',
              borderRadius: 10,
              padding: '12px 14px',
              minWidth: 240,
              boxShadow: '0 8px 24px rgba(0, 0, 0, 0.25)',
              zIndex: 1500,
              pointerEvents: 'none',
              animation: 'contextFadeIn 0.12s ease-out',
              fontFamily: 'inherit',
            }}
          >
            {/* Header */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, paddingBottom: 8, marginBottom: 8, borderBottom: '1px solid rgba(255,255,255,0.1)' }}>
              <span style={{ width: 8, height: 8, borderRadius: 2, background: catColor, display: 'inline-block' }} />
              <span style={{ fontSize: 11, fontWeight: 600, color: '#e2e8f0' }}>{dayName} · {catLabel}</span>
            </div>

            {/* Current value */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 8 }}>
              <span style={{ fontSize: 10, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 600 }}>Current</span>
              <span style={{ fontSize: 18, fontWeight: 700, color: '#fff', fontFamily: 'ui-monospace, monospace' }}>
                {currentVal > 0 ? fmt$(currentVal) : '—'}
              </span>
            </div>

            {/* Comparisons */}
            <div style={{ borderTop: '1px solid rgba(255,255,255,0.1)', paddingTop: 6 }}>
              {hasAnyData ? (
                <>
                  {compareLine('8-wk avg',     avg8w,       '#94a3b8')}
                  {compareLine('Last week',    priorVal,    '#94a3b8')}
                  {compareLine('Same wk YoY',  yoyVal,      '#94a3b8')}
                  {compareLine('Forecast',     forecastVal, '#94a3b8')}
                </>
              ) : (
                <div style={{ fontSize: 11, color: '#64748b', fontStyle: 'italic', textAlign: 'center', padding: '6px 0' }}>
                  No comparison data yet
                </div>
              )}
            </div>

            {/* Arrow pointer */}
            <div style={{
              position: 'absolute',
              bottom: -6,
              left: '50%',
              transform: 'translateX(-50%) rotate(45deg)',
              width: 12, height: 12,
              background: '#0f172a',
            }} />
          </div>
        )
      })()}

      {/* ── Header ── */}
      <div className={styles.header}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <Breadcrumb items={['Revenue', 'Weekly Sales']} />
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 2, flexWrap: 'wrap' }}>
            <h1 className={styles.title} style={{ margin: 0 }}>Weekly Sales</h1>
            <span style={{
              display: 'inline-flex', alignItems: 'center', gap: 6,
              padding: '4px 10px', background: '#f1f5f9', border: '0.5px solid #e2e8f0',
              borderRadius: 20, fontSize: 12, color: '#475569', fontWeight: 500,
            }}>
              📍 {isAll ? 'All Locations' : cleanLocName(location)}
            </span>
            <span style={{
              display: 'inline-flex', alignItems: 'center', gap: 6,
              padding: '4px 10px', background: '#f1f5f9', border: '0.5px solid #e2e8f0',
              borderRadius: 20, fontSize: 12, color: '#475569', fontWeight: 500,
            }}>
              📅 {periodKey}
            </span>
            {approvalStatus && (
              <span style={{
                display: 'inline-flex', alignItems: 'center', gap: 6,
                padding: '4px 10px',
                background: approvalStatus === 'approved' ? '#dcfce7' : approvalStatus === 'pending' ? '#fef3c7' : '#fee2e2',
                color: approvalStatus === 'approved' ? '#166534' : approvalStatus === 'pending' ? '#854d0e' : '#991b1b',
                border: `0.5px solid ${approvalStatus === 'approved' ? '#86efac' : approvalStatus === 'pending' ? '#fcd34d' : '#fca5a5'}`,
                borderRadius: 20, fontSize: 12, fontWeight: 500,
              }}>
                {approvalStatus === 'approved' ? '✓ Approved' : approvalStatus === 'pending' ? '⏳ Pending approval' : '✕ Rejected'}
              </span>
            )}
          </div>
          <div style={{ fontSize: 12, color: '#94a3b8', marginTop: 6 }}>
            {lastSaved ? `Last saved ${new Date(lastSaved).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}${savedBy ? ` by ${savedBy}` : ''}` : 'No data entered yet'}
            {weekTotal > 0 && ` · ${fmt$(weekTotal)} week total`}
          </div>
        </div>
        <div className={styles.headerActions}>
          <button className={styles.btnIcon} onClick={exportCSV} title="Export CSV"><Download size={15} /></button>
          <label className={styles.btnImport}>
            <Upload size={13} /> Import
            <input type="file" accept=".xlsx,.xls,.csv" style={{ display: 'none' }} onChange={handleImport} />
          </label>
        </div>
      </div>

      {/* ── Status bar ── */}
      {approvalStatus && (
        <div className={styles.statusBar}>
          <div className={styles.statusLeft}>
            {approvalStatus === 'pending'  && <Clock size={13} className={styles.iconPending} />}
            {approvalStatus === 'approved' && <CheckCircle size={13} className={styles.iconApproved} />}
            {approvalStatus === 'rejected' && <AlertCircle size={13} className={styles.iconRejected} />}
            <span className={styles.statusText}>
              {lastSaved ? `Saved ${new Date(lastSaved).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} by ${savedBy} · ` : ''}
              {approvalStatus === 'pending'  && 'Pending director approval before closing'}
              {approvalStatus === 'approved' && 'Approved & closed — period is locked'}
              {approvalStatus === 'rejected' && 'Rejected — re-enter and resubmit'}
            </span>
          </div>
          <div className={styles.statusRight}>
            <span className={`${styles.badge} ${styles['badge_' + approvalStatus]}`}>
              {approvalStatus === 'pending' ? 'Pending approval' : approvalStatus === 'approved' ? 'Approved' : 'Rejected'}
            </span>
            {approvalStatus === 'pending' && isDirector && (
              <>
                <button className={styles.btnApprove} onClick={handleApprove} disabled={approving} style={{ opacity: approving ? 0.5 : 1, cursor: approving ? 'wait' : 'pointer' }}>
                  {approving ? 'Closing…' : 'Approve & Close'}
                </button>
                <button className={styles.btnReject} onClick={() => setShowRejectModal(true)} disabled={approving}>Reject</button>
              </>
            )}
          </div>
        </div>
      )}

      {/* ── Reject modal ── */}
      {showRejectModal && (
        <div className={styles.modalOverlay}>
          <div className={styles.modal}>
            <h3 className={styles.modalTitle}>Reject Sales Submission</h3>
            <p className={styles.modalSub}>Provide a reason so the submitter knows what to fix.</p>
            <textarea className={styles.modalTextarea} placeholder="e.g. Tuesday catering figure appears doubled" value={rejectNote || ''} onChange={e => setRejectNote(e.target.value)} rows={3} autoFocus />
            <div className={styles.modalActions}>
              <button className={styles.btnApprove} onClick={handleRejectConfirm}>Confirm Rejection</button>
              <button className={styles.btnClearModal} onClick={() => { setShowRejectModal(false); setRejectNote('') }}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Week nav ── */}
      {/* ── Sales History Chart (trailing 12 weeks) ── */}
      {!isAll && historyChart.length > 1 && (
        <div style={{
          background: '#fff',
          border: '1px solid #e5e7eb',
          borderRadius: 12,
          padding: '20px 24px 12px',
          marginBottom: 16,
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12 }}>
            <div>
              <div style={{ fontSize: 11, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 600, marginBottom: 2 }}>
                12-Week Trend
              </div>
              <div style={{ fontSize: 14, color: '#0f172a', fontWeight: 600 }}>
                Sales by category · {cleanLocName(location)}
                {compareMode && (
                  <span style={{ color: '#94a3b8', fontWeight: 500 }}>
                    {' '}vs{' '}
                    <span style={{ color: '#7c3aed' }}>
                      {compareMode === 'priorPeriod' ? 'prior period' :
                       compareMode === 'yoy' ? 'last year' :
                       `${cleanLocName(compareTarget)}`}
                    </span>
                  </span>
                )}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', position: 'relative' }}>
              {compareMode ? (
                <button
                  onClick={clearCompare}
                  style={{
                    fontSize: 11, padding: '6px 12px',
                    background: '#f3e8ff', color: '#7c3aed',
                    border: '1px solid #e9d5ff', borderRadius: 20,
                    cursor: 'pointer', fontWeight: 500, fontFamily: 'inherit',
                    display: 'flex', alignItems: 'center', gap: 5,
                  }}
                >
                  ✕ Clear comparison
                </button>
              ) : (
                <button
                  onClick={() => setShowCompareMenu(m => !m)}
                  style={{
                    fontSize: 11, padding: '6px 12px',
                    background: '#fff', color: '#475569',
                    border: '1px solid #e2e8f0', borderRadius: 20,
                    cursor: 'pointer', fontWeight: 500, fontFamily: 'inherit',
                  }}
                >
                  Compare ▾
                </button>
              )}
              {showCompareMenu && (
                <>
                  <div
                    onClick={() => setShowCompareMenu(false)}
                    style={{ position: 'fixed', inset: 0, zIndex: 100 }}
                  />
                  <div style={{
                    position: 'absolute', top: 34, right: 0,
                    background: '#fff',
                    border: '1px solid #e5e7eb',
                    borderRadius: 10,
                    boxShadow: '0 8px 24px rgba(0,0,0,0.08)',
                    padding: 6,
                    minWidth: 220,
                    zIndex: 101,
                  }}>
                    <button
                      onClick={() => openCompare('priorPeriod')}
                      style={{
                        display: 'block', width: '100%', textAlign: 'left',
                        padding: '8px 12px', fontSize: 12,
                        background: 'none', border: 'none', cursor: 'pointer',
                        color: '#0f172a', borderRadius: 6, fontFamily: 'inherit',
                      }}
                      onMouseEnter={e => e.currentTarget.style.background = '#f8fafc'}
                      onMouseLeave={e => e.currentTarget.style.background = 'none'}
                    >
                      <div style={{ fontWeight: 500 }}>Prior period</div>
                      <div style={{ fontSize: 10, color: '#94a3b8', marginTop: 1 }}>Compare to P{Math.max(1, period - 1)}</div>
                    </button>
                    <button
                      onClick={() => openCompare('yoy')}
                      style={{
                        display: 'block', width: '100%', textAlign: 'left',
                        padding: '8px 12px', fontSize: 12,
                        background: 'none', border: 'none', cursor: 'pointer',
                        color: '#0f172a', borderRadius: 6, fontFamily: 'inherit',
                      }}
                      onMouseEnter={e => e.currentTarget.style.background = '#f8fafc'}
                      onMouseLeave={e => e.currentTarget.style.background = 'none'}
                    >
                      <div style={{ fontWeight: 500 }}>Same week last year</div>
                      <div style={{ fontSize: 10, color: '#94a3b8', marginTop: 1 }}>YoY comparison</div>
                    </button>
                    <div style={{ height: 1, background: '#f1f5f9', margin: '4px 6px' }} />
                    <div style={{ padding: '6px 12px 2px', fontSize: 10, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 600 }}>
                      Another location
                    </div>
                    <div style={{ maxHeight: 180, overflowY: 'auto' }}>
                      {visibleLocations.map(l => l.name).filter(n => n !== location).map(name => (
                        <button
                          key={name}
                          onClick={() => openCompare('location', name)}
                          style={{
                            display: 'block', width: '100%', textAlign: 'left',
                            padding: '7px 12px', fontSize: 12,
                            background: 'none', border: 'none', cursor: 'pointer',
                            color: '#0f172a', borderRadius: 6, fontFamily: 'inherit',
                          }}
                          onMouseEnter={e => e.currentTarget.style.background = '#f8fafc'}
                          onMouseLeave={e => e.currentTarget.style.background = 'none'}
                        >
                          {cleanLocName(name)}
                        </button>
                      ))}
                    </div>
                  </div>
                </>
              )}
            </div>
            <div style={{ display: 'flex', gap: 14, fontSize: 11, alignItems: 'center' }}>
              {CATS.map(cat => (
                <div key={cat.key} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                  <span style={{ width: 9, height: 9, borderRadius: 2, background: cat.color, display: 'inline-block' }} />
                  <span style={{ color: '#64748b', fontWeight: 500 }}>{cat.label}</span>
                </div>
              ))}
              {chartDataWithForecast.some(r => r.forecastTotal) && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 5, paddingLeft: 10, borderLeft: '1px solid #e5e7eb' }}>
                  <span style={{ width: 14, height: 2, background: 'repeating-linear-gradient(90deg, #1D9E75 0 4px, transparent 4px 7px)', display: 'inline-block' }} />
                  <span style={{ color: '#1D9E75', fontWeight: 600 }}>Forecast</span>
                </div>
              )}
              {compareMode && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 5, paddingLeft: 10, borderLeft: '1px solid #e5e7eb' }}>
                  <span style={{ width: 14, height: 2, background: 'repeating-linear-gradient(90deg, #7c3aed 0 3px, transparent 3px 6px)', display: 'inline-block' }} />
                  <span style={{ color: '#7c3aed', fontWeight: 600 }}>Comparison</span>
                </div>
              )}
            </div>
          </div>

          <ResponsiveContainer width="100%" height={220}>
            <ComposedChart
              data={chartDataWithForecast}
              margin={{ top: 8, right: 8, left: -12, bottom: 0 }}
            >
              <defs>
                <linearGradient id="gradPopup" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#059669" stopOpacity={0.35} />
                  <stop offset="100%" stopColor="#059669" stopOpacity={0.02} />
                </linearGradient>
                <linearGradient id="gradCatering" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#7c3aed" stopOpacity={0.35} />
                  <stop offset="100%" stopColor="#7c3aed" stopOpacity={0.02} />
                </linearGradient>
                <linearGradient id="gradRetail" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#2563eb" stopOpacity={0.35} />
                  <stop offset="100%" stopColor="#2563eb" stopOpacity={0.02} />
                </linearGradient>
              </defs>

              <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" vertical={false} />
              <XAxis
                dataKey="label"
                tick={{ fontSize: 10, fill: '#94a3b8' }}
                axisLine={{ stroke: '#e5e7eb' }}
                tickLine={false}
              />
              <YAxis
                tickFormatter={(v) => v >= 1000 ? `$${(v / 1000).toFixed(0)}k` : `$${v}`}
                tick={{ fontSize: 10, fill: '#94a3b8' }}
                axisLine={{ stroke: '#e5e7eb' }}
                tickLine={false}
                width={44}
              />
              <Tooltip
                contentStyle={{
                  background: '#0f172a',
                  border: 'none',
                  borderRadius: 8,
                  fontSize: 11,
                  color: '#fff',
                  padding: '8px 12px',
                }}
                labelStyle={{ color: '#94a3b8', fontSize: 10, marginBottom: 4 }}
                itemStyle={{ color: '#fff', padding: '1px 0' }}
                formatter={(value, name) => [fmt$(value), name]}
              />

              <Area type="monotone" dataKey="retail"   stackId="1" stroke="#2563eb" strokeWidth={1.5} fill="url(#gradRetail)"   name="Retail" />
              <Area type="monotone" dataKey="catering" stackId="1" stroke="#7c3aed" strokeWidth={1.5} fill="url(#gradCatering)" name="Catering" />
              <Area type="monotone" dataKey="popup"    stackId="1" stroke="#059669" strokeWidth={1.5} fill="url(#gradPopup)"    name="Popup" />

              <Line
                type="monotone"
                dataKey="total"
                stroke="#0f172a"
                strokeWidth={2}
                dot={{ r: 3, fill: '#0f172a', strokeWidth: 0 }}
                activeDot={{ r: 5, fill: '#0f172a', stroke: '#fff', strokeWidth: 2 }}
                name="Total"
              />
              <Line
                type="monotone"
                dataKey="forecastTotal"
                stroke="#1D9E75"
                strokeWidth={2}
                strokeDasharray="5 3"
                dot={{ r: 4, fill: '#1D9E75', stroke: '#fff', strokeWidth: 2 }}
                connectNulls={false}
                name="Forecast"
                isAnimationActive={false}
              />
              {compareMode && (
                <Line
                  type="monotone"
                  dataKey="compareTotal"
                  stroke="#7c3aed"
                  strokeWidth={2}
                  strokeDasharray="3 3"
                  dot={{ r: 3, fill: '#7c3aed', strokeWidth: 0 }}
                  activeDot={{ r: 5, fill: '#7c3aed', stroke: '#fff', strokeWidth: 2 }}
                  connectNulls={true}
                  name="Comparison"
                  isAnimationActive={false}
                />
              )}

              {/* Highlight the current week with a reference line */}
              {historyChart.some(d => d.isCurrent) && (
                <ReferenceLine
                  x={historyChart.find(d => d.isCurrent)?.label}
                  stroke="#1D9E75"
                  strokeDasharray="4 4"
                  strokeWidth={1.5}
                  label={{
                    value: 'Now',
                    position: 'top',
                    fill: '#1D9E75',
                    fontSize: 10,
                    fontWeight: 600,
                  }}
                />
              )}
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* ── Period Pulse ── */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 16,
        padding: '14px 18px', marginBottom: 16,
        background: 'linear-gradient(135deg, #0f172a 0%, #1e293b 100%)',
        borderRadius: 12, color: '#fff',
        boxShadow: '0 1px 3px rgba(0,0,0,.08)',
      }}>
        <button
          onClick={prevWeek}
          style={{
            background: 'rgba(255,255,255,0.08)', color: '#fff',
            border: '1px solid rgba(255,255,255,0.15)',
            width: 32, height: 32, borderRadius: 8,
            cursor: 'pointer', fontSize: 16,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontFamily: 'inherit',
          }}
        >‹</button>

        {/* Progress ring (SVG) */}
        <div style={{ position: 'relative', width: 44, height: 44, flexShrink: 0 }}>
          <svg width="44" height="44" viewBox="0 0 44 44" style={{ transform: 'rotate(-90deg)' }}>
            <circle cx="22" cy="22" r="18" fill="none" stroke="rgba(255,255,255,0.12)" strokeWidth="3" />
            <circle
              cx="22" cy="22" r="18" fill="none"
              stroke={paceStatus === 'ahead' ? '#10b981' : paceStatus === 'behind' ? '#f59e0b' : '#94a3b8'}
              strokeWidth="3"
              strokeLinecap="round"
              strokeDasharray={`${2 * Math.PI * 18}`}
              strokeDashoffset={`${2 * Math.PI * 18 * (1 - daysElapsed / daysTotal)}`}
              style={{ transition: 'stroke-dashoffset 0.6s ease-out, stroke 0.3s' }}
            />
          </svg>
          <div style={{
            position: 'absolute', top: 0, left: 0, width: '100%', height: '100%',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 11, fontWeight: 700, color: '#fff',
          }}>
            {daysElapsed}/{daysTotal}
          </div>
        </div>

        {/* Label + progress details */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 600, lineHeight: 1.2 }}>
            {week.label}
          </div>
          <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.6)', marginTop: 3, display: 'flex', alignItems: 'center', gap: 10 }}>
            <span>Day {daysElapsed} of {daysTotal}</span>
            <span style={{ color: 'rgba(255,255,255,0.3)' }}>·</span>
            <span>{Math.round((daysElapsed / daysTotal) * 100)}% through</span>
            {dirty && (
              <>
                <span style={{ color: 'rgba(255,255,255,0.3)' }}>·</span>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: '#fcd34d' }}>
                  <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#fcd34d', display: 'inline-block', animation: 'pulseDot 1.4s ease-in-out infinite' }} />
                  Unsaved
                </span>
              </>
            )}
          </div>
        </div>

        {/* Pace indicator */}
        {paceStatus && (() => {
          // Build velocity spark data: for each operating day, compute
          // cumulative actual and cumulative pace target (budget/days * day#).
          // The spark shows both as overlaid lines — actual (solid) and
          // target (dotted). Color-coded to match the pace status.
          const dailyBudget = budgetTotal > 0 && daysTotal > 0 ? budgetTotal / daysTotal : 0
          const sparkPoints = []
          let cumActual = 0
          week.days.forEach((d, idx) => {
            const dayTotal = (parseFloat(entries[d.key]?.popup)    || 0) +
                             (parseFloat(entries[d.key]?.catering) || 0) +
                             (parseFloat(entries[d.key]?.retail)   || 0)
            cumActual += dayTotal
            const cumTarget = dailyBudget * (idx + 1)
            sparkPoints.push({ actual: cumActual, target: cumTarget })
          })
          const maxVal = Math.max(
            ...sparkPoints.map(p => Math.max(p.actual, p.target)),
            1
          )
          const W = 100, H = 24
          const xStep = sparkPoints.length > 1 ? W / (sparkPoints.length - 1) : 0
          const actualPath = sparkPoints
            .map((p, i) => `${i === 0 ? 'M' : 'L'}${(i * xStep).toFixed(1)},${(H - (p.actual / maxVal) * H).toFixed(1)}`)
            .join(' ')
          const targetPath = sparkPoints
            .map((p, i) => `${i === 0 ? 'M' : 'L'}${(i * xStep).toFixed(1)},${(H - (p.target / maxVal) * H).toFixed(1)}`)
            .join(' ')
          const lineColor = paceStatus === 'ahead' ? '#6ee7b7' : '#fcd34d'

          return (
            <div style={{
              display: 'flex', flexDirection: 'column', alignItems: 'flex-end',
              padding: '8px 14px',
              background: paceStatus === 'ahead' ? 'rgba(16, 185, 129, 0.15)' : 'rgba(245, 158, 11, 0.15)',
              border: `1px solid ${paceStatus === 'ahead' ? 'rgba(16, 185, 129, 0.3)' : 'rgba(245, 158, 11, 0.3)'}`,
              borderRadius: 8,
              minWidth: 128,
            }}>
              <div style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.05em', color: lineColor, fontWeight: 600 }}>
                {paceStatus === 'ahead' ? '▲ Ahead of pace' : '▼ Behind pace'}
              </div>
              <div style={{ fontSize: 16, fontWeight: 700, color: '#fff', marginTop: 2 }}>
                {paceStatus === 'ahead' ? '+' : '−'}{fmt$(Math.abs(paceGap))}
              </div>
              {sparkPoints.length > 1 && dailyBudget > 0 && (
                <svg width={W} height={H} style={{ marginTop: 4, display: 'block' }}>
                  {/* Target (dotted) */}
                  <path
                    d={targetPath}
                    fill="none"
                    stroke="rgba(255,255,255,0.35)"
                    strokeWidth="1"
                    strokeDasharray="2 2"
                  />
                  {/* Actual (solid) */}
                  <path
                    d={actualPath}
                    fill="none"
                    stroke={lineColor}
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                  {/* Dot on the latest actual point */}
                  {sparkPoints.length > 0 && (() => {
                    const last = sparkPoints[sparkPoints.length - 1]
                    const cx = (sparkPoints.length - 1) * xStep
                    const cy = H - (last.actual / maxVal) * H
                    return <circle cx={cx} cy={cy} r="2" fill={lineColor} />
                  })()}
                </svg>
              )}
            </div>
          )
        })()}

        <button
          onClick={nextWeek}
          style={{
            background: 'rgba(255,255,255,0.08)', color: '#fff',
            border: '1px solid rgba(255,255,255,0.15)',
            width: 32, height: 32, borderRadius: 8,
            cursor: 'pointer', fontSize: 16,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontFamily: 'inherit',
          }}
        >›</button>
      </div>

      {/* ── Approval audit trail ── */}
      {approvalStatus && submissionEvents.length > 0 && (
        <div style={{
          background: '#fff',
          border: '1px solid #e5e7eb',
          borderRadius: 12,
          padding: '16px 20px',
          marginBottom: 16,
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
            <div style={{ fontSize: 11, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 600 }}>
              Approval Trail
            </div>
            <span style={{
              fontSize: 11, padding: '3px 10px', borderRadius: 20, fontWeight: 500,
              background: approvalStatus === 'approved' ? '#dcfce7' : approvalStatus === 'pending' ? '#fef3c7' : '#fee2e2',
              color:      approvalStatus === 'approved' ? '#166534' : approvalStatus === 'pending' ? '#854d0e' : '#991b1b',
              border: `0.5px solid ${approvalStatus === 'approved' ? '#86efac' : approvalStatus === 'pending' ? '#fcd34d' : '#fca5a5'}`,
            }}>
              {approvalStatus === 'approved' ? '✓ Approved' : approvalStatus === 'pending' ? '⏳ Pending' : '✕ Rejected'}
            </span>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {submissionEvents.map((event, i) => {
              const isLast = i === submissionEvents.length - 1
              const colors = {
                submitted:   { bg: '#dbeafe', text: '#1e40af', label: 'Submitted' },
                updated:     { bg: '#e0e7ff', text: '#4338ca', label: 'Updated' },
                resubmitted: { bg: '#e0e7ff', text: '#4338ca', label: 'Resubmitted' },
                approved:    { bg: '#dcfce7', text: '#166534', label: 'Approved' },
                rejected:    { bg: '#fee2e2', text: '#991b1b', label: 'Rejected' },
              }
              const c = colors[event.action] || colors.submitted
              const dt = event.timestamp ? new Date(event.timestamp) : null
              return (
                <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 12, position: 'relative' }}>
                  {/* Timeline connector line */}
                  {!isLast && (
                    <div style={{
                      position: 'absolute',
                      left: 11,
                      top: 24,
                      bottom: -10,
                      width: 1,
                      background: '#e5e7eb',
                    }} />
                  )}

                  {/* Numbered circle */}
                  <div style={{
                    width: 22, height: 22, borderRadius: '50%',
                    background: c.bg, color: c.text,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: 10, fontWeight: 700,
                    flexShrink: 0, position: 'relative', zIndex: 1,
                  }}>
                    {i + 1}
                  </div>

                  {/* Content */}
                  <div style={{ flex: 1, fontSize: 12, lineHeight: 1.5 }}>
                    <div>
                      <span style={{ color: c.text, fontWeight: 600 }}>{c.label}</span>
                      <span style={{ color: '#64748b' }}> by </span>
                      <span style={{ color: '#0f172a', fontWeight: 500 }}>{event.actor}</span>
                      {event.weekTotal > 0 && (
                        <>
                          <span style={{ color: '#64748b' }}> · </span>
                          <span style={{ color: '#0f172a', fontWeight: 600 }}>{fmt$(event.weekTotal)}</span>
                        </>
                      )}
                    </div>
                    {dt && (
                      <div style={{ color: '#94a3b8', fontSize: 11, marginTop: 2 }}>
                        {dt.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })}
                      </div>
                    )}
                    {event.note && (
                      <div style={{
                        marginTop: 6,
                        padding: '8px 10px',
                        background: '#fef2f2',
                        borderLeft: '2px solid #fca5a5',
                        borderRadius: 4,
                        fontSize: 11,
                        color: '#7f1d1d',
                        fontStyle: 'italic',
                      }}>
                        "{event.note}"
                      </div>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* ── KPI strip ── */}
      <div className={styles.kpiBar}>
        <div className={styles.kpiMain}>
          <div className={styles.kpiMainLabel}>Week Total GFS</div>
          <div className={styles.kpiMainVal}>{weekTotal > 0 ? fmt$(weekTotal) : '—'}</div>
          {priorWeekTotal > 0 && <div className={styles.kpiMainSub}>vs {fmt$(priorWeekTotal)} last week</div>}
          {forecastTotal > 0 && <div className={styles.kpiMainSub}>forecast: {fmt$(forecastTotal)}</div>}
        </div>
        {CATS.map(cat => {
          const prior = week?.days.reduce((s, d) => {
            return s + (parseFloat(priorEntries[
              new Date(new Date(d.key).getTime() - 7 * 86400000).toISOString().slice(0, 10)]?.[cat.key]) || 0)
          }, 0) || 0
          const chg = pctChange(catTotals[cat.key], prior)
          const mix = weekTotal > 0 ? catTotals[cat.key] / weekTotal : 0
          return (
            <div key={cat.key} className={styles.kpi}>
              <div className={styles.kpiLabel} style={{ color: cat.color }}>{cat.label}</div>
              <div className={styles.kpiVal}>{fmt$(catTotals[cat.key])}</div>
              <div className={styles.kpiMix}>{mix > 0 ? (mix * 100).toFixed(0) + '% of GFS' : '—'}</div>
              {chg !== null && (
                <div className={styles.kpiChange} style={{ color: chg >= 0 ? '#059669' : '#dc2626' }}>
                  {fmtPct(chg)} vs LW
                </div>
              )}
            </div>
          )
        })}
        <div className={styles.kpi}>
          <div className={styles.kpiLabel}>vs Budget</div>
          <div className={styles.kpiVal} style={{ color: weekVsBudget != null ? (weekVsBudget >= 0 ? '#059669' : '#dc2626') : undefined }}>
            {budgetTotal > 0 ? fmt$(weekTotal - budgetTotal) : '—'}
          </div>
          {weekVsBudget != null && budgetTotal > 0 && (
            <div className={styles.kpiChange} style={{ color: weekVsBudget >= 0 ? '#059669' : '#dc2626' }}>
              {fmtPct(weekVsBudget)}
            </div>
          )}
        </div>
        <div className={styles.kpi}>
          <div className={styles.kpiLabel}>vs Last Year</div>
          <div className={styles.kpiVal} style={{ color: weekVsYoY != null ? (weekVsYoY >= 0 ? '#059669' : '#dc2626') : undefined }}>
            {yoyWeekTotal > 0 ? fmt$(weekTotal - yoyWeekTotal) : '—'}
          </div>
          {weekVsYoY != null && yoyWeekTotal > 0 && (
            <div className={styles.kpiChange} style={{ color: weekVsYoY >= 0 ? '#059669' : '#dc2626' }}>
              {fmtPct(weekVsYoY)} YoY
            </div>
          )}
        </div>
      </div>

      {/* ── Anomaly alerts ── */}
      {Object.keys(anomalies).length > 0 && (
        <div className={styles.anomalyBar}>
          <AlertCircle size={13} />
          <span><strong>Data check:</strong> {Object.entries(anomalies).map(([k, v]) => {
            const [dateKey, catKey] = k.split('_')
            const cat = CATS.find(c => c.key === catKey)
            const day = week?.days.find(d => d.key === dateKey)
            return `${day?.name} ${cat?.label} is unusually ${v.direction} vs your 8-week average`
          }).join(' · ')}</span>
        </div>
      )}

      {/* ── Table ── */}
      {loading ? <div className={styles.loading}>Loading...</div> : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th className={styles.thDay}>Day</th>
                {CATS.map(c => <th key={c.key} className={styles.thCat} style={{ color: c.color }}>{c.label}</th>)}
                <th className={styles.thTotal}>Total</th>
                <th className={styles.thVar}>vs LW</th>
                <th className={styles.thVar}>vs LY</th>
                <th className={styles.thVar}>Forecast</th>
              </tr>
            </thead>
            <tbody>
              {week.days.map((day, rowIdx) => {
                const dt      = dayTotal(day.key)
                const prior   = dayTotal(day.key, priorEntries)
                const yoy     = dayTotal(day.key, yoyEntries)
                const fc      = forecast[day.key] ? CATS.reduce((s, c) => s + (forecast[day.key][c.key] || 0), 0) : 0
                const chgLW   = pctChange(dt, prior)
                const chgYoY  = pctChange(dt, yoy)
                const now     = new Date(); now.setHours(12, 0, 0, 0)
                const isToday  = day.date.toDateString() === now.toDateString()
                const isFuture = day.date > now
                const isAlert  = chgLW !== null && chgLW < -10 && !isFuture && dt > 0
                const hasAnomaly = CATS.some(c => anomalies[`${day.key}_${c.key}`])

                return (
                  <tr key={day.key} className={`${styles.row} ${isToday ? styles.today : ''} ${isFuture ? styles.future : ''} ${isAlert ? styles.alert : ''}`}>
                    <td className={styles.tdDay}>
                      <div className={styles.dayName}>
                        {(isAlert || hasAnomaly) && <span className={styles.alertIcon}>⚠</span>}
                        {day.name}
                        {isToday && <span className={styles.todayBadge}>Today</span>}
                      </div>
                      <div className={styles.dayDate}>{day.date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</div>
                      {isAlert && <div className={styles.alertMsg}>↓ 10%+ below last week</div>}
                    </td>

                    {CATS.map((cat, colIdx) => {
                      const anomaly   = anomalies[`${day.key}_${cat.key}`]
                      const isAnomaly = !!anomaly
                      const hasValue  = !!entries[day.key]?.[cat.key]
                      const currentVal = parseFloat(entries[day.key]?.[cat.key]) || 0
                      const anomalyPct = anomaly ? Math.round(((currentVal - anomaly.mean) / anomaly.mean) * 100) : 0
                      const anomalyTooltip = anomaly
                        ? `${anomalyPct > 0 ? '+' : ''}${anomalyPct}% vs 8-week average ($${anomaly.mean.toFixed(0)}) — please verify`
                        : undefined
                      return (
                        <td
                          key={cat.key}
                          className={styles.tdInput}
                          style={{ position: 'relative' }}
                          onMouseEnter={e => {
                            const rect = e.currentTarget.getBoundingClientRect()
                            setHoveredCell({
                              dateKey: day.key,
                              catKey: cat.key,
                              dayName: day.name,
                              catLabel: cat.label,
                              catColor: cat.color,
                              x: rect.left + rect.width / 2,
                              y: rect.top,
                            })
                          }}
                          onMouseLeave={() => setHoveredCell(null)}
                        >
                          <div className={`${styles.inputWrap} ${isAnomaly ? styles.inputAnomaly : ''} ${hasValue ? styles.inputFilled : ''}`}>
                            <span className={styles.dollar}>$</span>
                            <input
                              type="number" min="0" step="0.01"
                              value={getVal(day.key, cat.key)}
                              onChange={e => setVal(day.key, cat.key, e.target.value)}
                              onKeyDown={e => handleCellKeyDown(e, rowIdx, colIdx)}
                              onPaste={e => handleCellPaste(e, rowIdx, colIdx)}
                              data-entry-row={rowIdx}
                              data-entry-col={colIdx}
                              className={styles.input}
                              placeholder={fc > 0 && forecast[day.key] ? (forecast[day.key][cat.key] || 0).toFixed(0) : '0.00'}
                              disabled={isFuture || approvalStatus === 'approved'}
                              title={anomalyTooltip}
                            />
                            {isAnomaly && (
                              <>
                                <span
                                  style={{
                                    position: 'absolute',
                                    top: 6,
                                    right: 6,
                                    width: 6,
                                    height: 6,
                                    borderRadius: '50%',
                                    background: anomaly.direction === 'high' ? '#f59e0b' : '#3b82f6',
                                    boxShadow: `0 0 0 0 ${anomaly.direction === 'high' ? 'rgba(245, 158, 11, 0.5)' : 'rgba(59, 130, 246, 0.5)'}`,
                                    animation: 'anomalyPulse 2s ease-in-out infinite',
                                    pointerEvents: 'none',
                                  }}
                                />
                                <div
                                  style={{
                                    position: 'absolute',
                                    bottom: -14,
                                    left: 0,
                                    right: 0,
                                    fontSize: 9,
                                    fontWeight: 600,
                                    color: anomaly.direction === 'high' ? '#b45309' : '#1e40af',
                                    textAlign: 'center',
                                    lineHeight: 1,
                                    pointerEvents: 'none',
                                    letterSpacing: '0.02em',
                                  }}
                                >
                                  {anomalyPct > 0 ? '+' : ''}{anomalyPct}% vs avg
                                </div>
                              </>
                            )}
                          </div>
                        </td>
                      )
                    })}

                    <td className={styles.tdTotal}>
                      <span style={{ color: dt > 0 ? '#059669' : '#bbb', fontWeight: 600 }}>
                        {dt > 0 ? fmt$(dt) : isFuture ? <span style={{ color: '#bbb' }}>{fc > 0 ? fmt$(fc) : '—'}</span> : '—'}
                      </span>
                    </td>
                    <td className={styles.tdVar}>
                      {chgLW !== null && dt > 0 ? <span className={chgLW >= 0 ? styles.varUp : styles.varDown}>{fmtPct(chgLW)}</span> : <span className={styles.varNeutral}>{prior > 0 && !isFuture ? fmt$(prior) : '—'}</span>}
                    </td>
                    <td className={styles.tdVar}>
                      {chgYoY !== null && dt > 0 ? <span className={chgYoY >= 0 ? styles.varUp : styles.varDown}>{fmtPct(chgYoY)}</span> : <span className={styles.varNeutral}>{yoy > 0 ? fmt$(yoy) : '—'}</span>}
                    </td>
                    <td className={styles.tdVar}>
                      <span className={styles.varNeutral} style={{ color: '#bbb' }}>{fc > 0 ? fmt$(fc) : '—'}</span>
                    </td>
                  </tr>
                )
              })}
            </tbody>
            <tfoot>
              <tr className={styles.totalRow}>
                <td className={styles.tfDay}>Weekly Total</td>
                {CATS.map(c => <td key={c.key} className={styles.tfCat} style={{ color: c.color }}>{fmt$(catTotals[c.key])}</td>)}
                <td className={styles.tfTotal}>{fmt$(weekTotal)}</td>
                <td className={styles.tfVar}>
                  {weekVsLW != null && priorWeekTotal > 0 ? <span className={weekVsLW >= 0 ? styles.varUp : styles.varDown}>{fmtPct(weekVsLW)}</span> : '—'}
                </td>
                <td className={styles.tfVar}>
                  {weekVsYoY != null && yoyWeekTotal > 0 ? <span className={weekVsYoY >= 0 ? styles.varUp : styles.varDown}>{fmtPct(weekVsYoY)}</span> : '—'}
                </td>
                <td className={styles.tfVar}>
                  <span style={{ color: '#bbb', fontSize: 12 }}>{forecastTotal > 0 ? fmt$(forecastTotal) : '—'}</span>
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      {/* ── Submit bar ── */}
      <div className={`${styles.submitBar} ${dirty ? styles.submitBarDirty : ''}`}>
        <div className={styles.submitInfo}>
          {dirty
            ? <>Unsaved changes · <strong>{fmt$(weekTotal)}</strong> total this week</>
            : approvalStatus === 'approved'
              ? <>Period locked · <strong>{fmt$(weekTotal)}</strong> posted to P&L</>
              : <><strong>{fmt$(weekTotal)}</strong> saved for this week</>
          }
        </div>
        {approvalStatus !== 'approved' && (
          <button className={styles.btnSave} onClick={handleSave} disabled={saving || !dirty}>
            {saving ? 'Saving...' : 'Save & Close Period'}
          </button>
        )}
      </div>

          </div>
  )
}