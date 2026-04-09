import { useState, useEffect, useMemo } from 'react'
import { useAuthStore } from '@/store/authStore'
import { useLocations, cleanLocName } from '@/store/LocationContext'
import { db } from '@/lib/firebase'
import { doc, getDoc, setDoc, addDoc, updateDoc, collection, query, where, orderBy, limit, getDocs, serverTimestamp } from 'firebase/firestore'
import { Download, Upload, CheckCircle, Clock, AlertCircle, TrendingUp, TrendingDown } from 'lucide-react'
import { useToast } from '@/components/ui/Toast'
import { usePeriod } from '@/store/PeriodContext'
import { writeSalesPnL } from '@/lib/pnl'
import styles from './WeeklySales.module.css'

const TENANT = 'fooda'
const DAYS   = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday']

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
  const { selectedLocation, visibleLocations } = useLocations()
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
  const [submissionId,   setSubmissionId] = useState(null)
  const [showRejectModal, setShowRejectModal] = useState(false)
  const [rejectNote,   setRejectNote]   = useState(false)
  const [anomalies,    setAnomalies]    = useState({})
  const [allLocData,   setAllLocData]   = useState([])
  const [isDragging,   setIsDragging]   = useState(false)

  const location = selectedLocation === 'all' ? null : selectedLocation
  const isAll    = selectedLocation === 'all'
  const isDirector = user?.role === 'Admin' || user?.role === 'Director'

  const week = useMemo(() => {
    if (!currentWeek) return null
    const start = currentWeek.start
    const end   = currentWeek.end
    return {
      weekKey: periodKey,
      label: `P${period} Wk ${weekNum} · ${start.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} – ${end.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`,
      days: DAYS.map((name, i) => {
        const d = new Date(start)
        d.setDate(start.getDate() + i)
        d.setHours(12, 0, 0, 0)
        return d <= end ? { name, date: d, key: d.toISOString().slice(0, 10) } : null
      }).filter(Boolean)
    }
  }, [currentWeek, periodKey, period, weekNum])

  const priorKey = getPriorKey(periodKey)
  const yoyKey   = getYoYKey(periodKey)

  useEffect(() => {
    if (!week) return
    if (isAll) { loadAllLocations(); return }
    if (!location) return
    loadData()
  }, [location, week?.weekKey, isAll])

  async function loadData() {
    setLoading(true)
    try {
      const cfgSnap = await getDoc(doc(db, 'tenants', orgId, 'config', 'sales'))
      if (cfgSnap.exists()) setCommRate(cfgSnap.data().commissionRate || 0.18)

      const ref  = doc(db, 'tenants', TENANT, 'locations', locId(location), 'sales', periodKey)
      const snap = await getDoc(ref)
      const data = snap.exists() ? (snap.data().entries || {}) : {}
      setEntries(data)
      setLastSaved(snap.exists() ? snap.data().updatedAt : null)
      setSavedBy(snap.exists() ? snap.data().updatedBy || '' : '')

      if (priorKey) {
        const pRef  = doc(db, 'tenants', TENANT, 'locations', locId(location), 'sales', priorKey)
        const pSnap = await getDoc(pRef)
        setPriorEntries(pSnap.exists() ? (pSnap.data().entries || {}) : {})
      }

      if (yoyKey) {
        const yRef  = doc(db, 'tenants', TENANT, 'locations', locId(location), 'sales', yoyKey)
        const ySnap = await getDoc(yRef)
        setYoyEntries(ySnap.exists() ? (ySnap.data().entries || {}) : {})
      }

      const bRef  = doc(db, 'tenants', TENANT, 'budgets', `${locId(location)}-${year}`)
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

      await loadHistoryAndForecast(data)

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
      } else {
        setApproval(null)
        setSubmissionId(null)
      }

    } catch (e) { toast.error('Something went wrong loading sales data.') }
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
          const hRef  = doc(db, 'tenants', TENANT, 'locations', locId(location), 'sales', histKey)
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
    } catch { /* non-critical */ }
  }

  async function loadAllLocations() {
    setLoading(true)
    try {
      const locNames = Object.keys(visibleLocations)
      const results  = await Promise.all(locNames.map(async name => {
        const ref  = doc(db, 'tenants', TENANT, 'locations', locId(name), 'sales', periodKey)
        const snap = await getDoc(ref)
        const entries = snap.exists() ? snap.data().entries || {} : {}
        const total = Object.values(entries).reduce((s, d) =>
          s + CATS.reduce((ss, c) => ss + (parseFloat(d[c.key] || 0)), 0), 0)
        const priorRef  = doc(db, 'tenants', TENANT, 'locations', locId(name), 'sales', priorKey)
        const priorSnap = await getDoc(priorRef)
        const priorEntries = priorSnap.exists() ? priorSnap.data().entries || {} : {}
        const priorTotal = Object.values(priorEntries).reduce((s, d) =>
          s + CATS.reduce((ss, c) => ss + (parseFloat(d[c.key] || 0)), 0), 0)
        return { name, total, priorTotal, hasData: total > 0 }
      }))
      setAllLocData(results.sort((a, b) => b.total - a.total))
    } catch { toast.error('Failed to load location data.') }
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
      const ref = doc(db, 'tenants', TENANT, 'locations', locId(location), 'sales', week.weekKey)
      await setDoc(ref, {
        entries,
        weekKey:   week.weekKey,
        location,
        updatedAt: new Date().toISOString(),
        updatedBy: user?.name || user?.email || 'unknown',
      }, { merge: true })

      const subData = {
        period:      periodKey,
        location,
        entries,
        weekTotal:   weekTotal,
        submittedBy: user?.name || user?.email,
        status:      'pending',
        createdAt:   serverTimestamp(),
      }
      if (submissionId) {
        await updateDoc(doc(db, 'tenants', orgId, 'salesSubmissions', submissionId), { ...subData, updatedAt: serverTimestamp() })
      } else {
        const newRef = await addDoc(collection(db, 'tenants', orgId, 'salesSubmissions'), subData)
        setSubmissionId(newRef.id)
      }
      setApproval('pending')
      toast.success('Sales saved — pending director approval before posting to P&L')
      setDirty(false)
      setLastSaved(new Date().toISOString())
      setSavedBy(user?.name || user?.email || '')
    } catch { toast.error('Something went wrong. Please try again.') }
    setSaving(false)
  }

  async function handleApprove() {
    if (!submissionId) return
    try {
      await updateDoc(doc(db, 'tenants', orgId, 'salesSubmissions', submissionId), {
        status:     'approved',
        approvedBy: user?.name || user?.email,
        approvedAt: serverTimestamp(),
      })
      const popup    = Object.values(entries).reduce((s, d) => s + (parseFloat(d?.popup)    || 0), 0)
      const catering = Object.values(entries).reduce((s, d) => s + (parseFloat(d?.catering) || 0), 0)
      const retail   = Object.values(entries).reduce((s, d) => s + (parseFloat(d?.retail)   || 0), 0)
      await writeSalesPnL(location, periodKey, { retail, catering, popup })
      setApproval('approved')
      toast.success('Sales approved and posted to P&L')
    } catch { toast.error('Approval failed') }
  }

  async function handleRejectConfirm() {
    if (!rejectNote?.trim()) { toast.error('Please enter a reason'); return }
    try {
      await updateDoc(doc(db, 'tenants', orgId, 'salesSubmissions', submissionId), {
        status:     'rejected',
        rejectedBy: user?.name || user?.email,
        rejectedAt: serverTimestamp(),
        rejectNote: rejectNote.trim(),
      })
      setApproval('rejected')
      setShowRejectModal(false)
      setRejectNote('')
      toast.success('Submission rejected')
    } catch { toast.error('Action failed') }
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
    } catch (err) {
      toast.error('Import failed. Try exporting as CSV from Excel first.')
    }
  }

  async function handleImport(e) {
    const file = e.target.files[0]
    await processSalesFile(file)
    e.target.value = ''
  }

  function handleDragOver(e) {
    e.preventDefault()
    e.stopPropagation()
    if (!isDragging) setIsDragging(true)
  }

  function handleDragLeave(e) {
    e.preventDefault()
    e.stopPropagation()
    if (e.currentTarget === e.target) setIsDragging(false)
  }

  async function handleDrop(e) {
    e.preventDefault()
    e.stopPropagation()
    setIsDragging(false)
    const file = e.dataTransfer.files?.[0]
    if (!file) return
    const validExts = ['.xlsx', '.xls', '.csv']
    const isValid = validExts.some(ext => file.name.toLowerCase().endsWith(ext))
    if (!isValid) {
      toast.error('Please drop a .xlsx, .xls, or .csv file')
      return
    }
    await processSalesFile(file)
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
      const key = d.toISOString().slice(0, 10)
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
      toast.warning('No matching data found. Check that the location name matches.')
    } else {
      toast.success(`Imported ${fmt$(total)} in sales`)
      setEntries(newEntries)
      setDirty(true)
    }
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

  const dropOverlay = isDragging && (
    <div style={{
      position: 'fixed',
      top: 0, left: 0, right: 0, bottom: 0,
      background: 'rgba(15, 23, 42, 0.85)',
      zIndex: 9999,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      pointerEvents: 'none',
    }}>
      <div style={{
        background: '#fff',
        border: '3px dashed #F15D3B',
        borderRadius: 16,
        padding: '48px 64px',
        textAlign: 'center',
        maxWidth: 480,
      }}>
        <Upload size={48} style={{color:'#F15D3B',marginBottom:16}} />
        <div style={{fontSize:20,fontWeight:600,color:'#0f172a',marginBottom:8}}>
          Drop sales file here
        </div>
        <div style={{fontSize:14,color:'#6b7280'}}>
          Accepts .xlsx, .xls, or .csv
        </div>
      </div>
    </div>
  )

  if (!location && !isAll) return (
    <div className={styles.empty}>
      <div className={styles.emptyIcon}><TrendingUp size={32} strokeWidth={1.5} /></div>
      <p className={styles.emptyTitle}>Select a location to view sales</p>
      <p className={styles.emptySub}>Choose a location from the dropdown above to log or review weekly sales</p>
    </div>
  )

  if (!week) return <div className={styles.loading}>Loading...</div>

  if (isAll) {
    const allTotal      = allLocData.reduce((s, l) => s + l.total, 0)
    const allPriorTotal = allLocData.reduce((s, l) => s + l.priorTotal, 0)
    return (
      <div className={styles.page}>
        <div className={styles.header}>
          <div>
            <h1 className={styles.title}>Weekly Sales</h1>
            <p className={styles.subtitle}>All Locations · {week.label}</p>
          </div>
        </div>
        <div className={styles.kpiBar} style={{ gridTemplateColumns: 'repeat(3,1fr)' }}>
          <div className={styles.kpiMain}>
            <div className={styles.kpiMainLabel}>Total GFS</div>
            <div className={styles.kpiMainVal}>{fmt$(allTotal)}</div>
            {allPriorTotal > 0 && <div className={styles.kpiMainSub}>vs {fmt$(allPriorTotal)} prior week</div>}
          </div>
          <div className={styles.kpi}>
            <div className={styles.kpiLabel}>vs Prior Week</div>
            <div className={styles.kpiVal} style={{ color: weekVsLW != null ? (weekVsLW >= 0 ? '#059669' : '#dc2626') : undefined }}>
              {allPriorTotal > 0 ? fmtPct(pctChange(allTotal, allPriorTotal)) : '—'}
            </div>
          </div>
          <div className={styles.kpi}>
            <div className={styles.kpiLabel}>Locations reporting</div>
            <div className={styles.kpiVal}>{allLocData.filter(l => l.hasData).length} / {allLocData.length}</div>
          </div>
        </div>
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th className={styles.thDay}>#</th>
                <th className={styles.thDay}>Location</th>
                <th className={styles.thTotal}>GFS</th>
                <th className={styles.thVar}>vs LW</th>
                <th className={styles.thVar}>Status</th>
              </tr>
            </thead>
            <tbody>
              {allLocData.map((loc, i) => {
                const chg = pctChange(loc.total, loc.priorTotal)
                return (
                  <tr key={loc.name} className={styles.row}>
                    <td className={styles.tdDay} style={{ color: '#999', fontWeight: 700 }}>{i + 1}</td>
                    <td className={styles.tdDay}><div className={styles.dayName}>{cleanLocName(loc.name)}</div></td>
                    <td className={styles.tdTotal}><span style={{ color: loc.total > 0 ? '#059669' : '#bbb', fontWeight: 600 }}>{fmt$(loc.total)}</span></td>
                    <td className={styles.tdVar}>
                      {chg != null && loc.total > 0 ? <span className={chg >= 0 ? styles.varUp : styles.varDown}>{fmtPct(chg)}</span> : <span className={styles.varNeutral}>—</span>}
                    </td>
                    <td className={styles.tdVar}>
                      {loc.hasData
                        ? <span className={styles.varUp}>✓ Submitted</span>
                        : <span className={styles.varNeutral}>Not submitted</span>}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>
    )
  }

  return (
    <div
      className={styles.page}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >

      {/* ── Header ── */}
      <div className={styles.header}>
        <div>
          <h1 className={styles.title}>Weekly Sales</h1>
          <p className={styles.subtitle}>{cleanLocName(location)}</p>
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
              {approvalStatus === 'pending'  && 'Pending director approval before posting to P&L'}
              {approvalStatus === 'approved' && 'Approved and posted to P&L — period is locked'}
              {approvalStatus === 'rejected' && 'Rejected — re-enter and resubmit'}
            </span>
          </div>
          <div className={styles.statusRight}>
            <span className={`${styles.badge} ${styles['badge_' + approvalStatus]}`}>
              {approvalStatus === 'pending' ? 'Pending approval' : approvalStatus === 'approved' ? 'Approved' : 'Rejected'}
            </span>
            {approvalStatus === 'pending' && isDirector && (
              <>
                <button className={styles.btnApprove} onClick={handleApprove}>Approve &amp; Post</button>
                <button className={styles.btnReject} onClick={() => setShowRejectModal(true)}>Reject</button>
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
      <div className={styles.weekNav}>
        <button className={styles.weekBtn} onClick={prevWeek}>‹</button>
        <span className={styles.weekLabel}>{week.label}</span>
        <button className={styles.weekBtn} onClick={nextWeek}>›</button>
        {paceStatus && (
          <span className={`${styles.paceBadge} ${paceStatus === 'ahead' ? styles.paceAhead : styles.paceBehind}`}>
            {paceStatus === 'ahead' ? '▲' : '▼'} {paceStatus === 'ahead' ? 'Ahead' : 'Behind'} pace by {fmt$(Math.abs(paceGap))}
          </span>
        )}
      </div>

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
              {week.days.map(day => {
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

                    {CATS.map(cat => {
                      const isAnomaly = !!anomalies[`${day.key}_${cat.key}`]
                      const hasValue  = !!entries[day.key]?.[cat.key]
                      return (
                        <td key={cat.key} className={styles.tdInput}>
                          <div className={`${styles.inputWrap} ${isAnomaly ? styles.inputAnomaly : ''} ${hasValue ? styles.inputFilled : ''}`}>
                            <span className={styles.dollar}>$</span>
                            <input
                              type="number" min="0" step="0.01"
                              value={getVal(day.key, cat.key)}
                              onChange={e => setVal(day.key, cat.key, e.target.value)}
                              className={styles.input}
                              placeholder={fc > 0 && forecast[day.key] ? (forecast[day.key][cat.key] || 0).toFixed(0) : '0.00'}
                              disabled={isFuture || approvalStatus === 'approved'}
                              title={isAnomaly ? `Unusual vs 8-week average — please verify` : undefined}
                            />
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
            {saving ? 'Saving...' : 'Save & Submit for Approval'}
          </button>
        )}
      </div>

      {dropOverlay}
    </div>
  )
}