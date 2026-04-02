import { useState, useEffect, useMemo } from 'react'
import { useAuthStore } from '@/store/authStore'
import { useLocations, cleanLocName } from '@/store/LocationContext'
import { db } from '@/lib/firebase'
import { doc, getDoc, setDoc } from 'firebase/firestore'
import { Download } from 'lucide-react'
import { useToast } from '@/components/ui/Toast'
import { usePeriod } from '@/store/PeriodContext'
import { writeSalesPnL } from '@/lib/pnl'
import styles from './WeeklySales.module.css'

const TENANT = 'fooda'
const DAYS   = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday']
const CATS   = [
  { key: 'retail',   label: 'Popup',    color: '#059669' },
  { key: 'catering', label: 'Catering', color: '#7c3aed' },
  { key: 'popup',    label: 'Retail',   color: '#2563eb' },
]

function locId(name) { return name.replace(/[^a-zA-Z0-9]/g,'_') }

const fmt$ = v => v ? '$' + Number(v).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}) : '—'
const fmtPct = v => v > 0 ? `▲ ${v.toFixed(1)}%` : v < 0 ? `▼ ${Math.abs(v).toFixed(1)}%` : '—'

export default function WeeklySales() {
  const { user }             = useAuthStore()
  const { selectedLocation } = useLocations()
  const { year, period, week: weekNum, currentWeek, periodKey, prevWeek, nextWeek } = usePeriod()
  const toast                = useToast()

  const [entries,    setEntries]    = useState({})
  const [prevEntries,setPrevEntries]= useState({}) // last week's data for variance
  const [budgetData, setBudgetData] = useState({}) // budget for this period
  const [lastImport, setLastImport] = useState(null)
  const [loading,    setLoading]    = useState(false)
  const [saving,     setSaving]     = useState(false)
  const [dirty,      setDirty]      = useState(false)

  const location = selectedLocation === 'all' ? null : selectedLocation

  const week = useMemo(() => {
    if (!currentWeek) return null
    const start = currentWeek.start
    const end   = currentWeek.end
    return {
      weekKey: periodKey,
      label: `P${period} Wk ${weekNum} · ${start.toLocaleDateString('en-US',{month:'short',day:'numeric'})} – ${end.toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'})}`,
      days: DAYS.map((name, i) => {
        const d = new Date(start); d.setDate(start.getDate() + i)
        return d <= end ? { name, date: d, key: d.toISOString().slice(0,10) } : null
      }).filter(Boolean)
    }
  }, [currentWeek, periodKey, period, weekNum])

  // Derive previous week key
  const prevWeekKey = useMemo(() => {
    if (!currentWeek) return null
    const prevStart = new Date(currentWeek.start)
    prevStart.setDate(prevStart.getDate() - 7)
    return prevStart.toISOString().slice(0,7) + '-W' + String(Math.ceil(((prevStart - new Date(prevStart.getFullYear(),0,1))/86400000 + new Date(prevStart.getFullYear(),0,1).getDay()+1)/7)).padStart(2,'0')
  }, [currentWeek])

  useEffect(() => {
    if (!location || !week) return
    loadData()
  }, [location, week?.weekKey])

  async function loadData() {
    setLoading(true)
    try {
      // Current week
      const ref  = doc(db, 'tenants', TENANT, 'locations', locId(location), 'sales', week.weekKey)
      const snap = await getDoc(ref)
      const data = snap.exists() ? (snap.data().entries || {}) : {}
      setEntries(data)
      setLastImport(snap.exists() ? snap.data().updatedAt : null)

      // Previous week for variance
      if (prevWeekKey) {
        const prevRef  = doc(db, 'tenants', TENANT, 'locations', locId(location), 'sales', prevWeekKey)
        const prevSnap = await getDoc(prevRef)
        setPrevEntries(prevSnap.exists() ? (prevSnap.data().entries || {}) : {})
      }

      // Budget data
      const budgetKey = `${year}-P${String(period).padStart(2,'0')}`
      const bRef  = doc(db, 'tenants', TENANT, 'budgets', `${locId(location)}-${year}`)
      const bSnap = await getDoc(bRef)
      if (bSnap.exists()) {
        const months = bSnap.data().months || {}
        setBudgetData(months[period] || {})
      }
    } catch(e) { toast.error('Something went wrong loading sales data.') }
    setLoading(false)
    setDirty(false)
  }

  async function handleSave() {
    setSaving(true)
    try {
      const ref = doc(db, 'tenants', TENANT, 'locations', locId(location), 'sales', week.weekKey)
      await setDoc(ref, {
        entries, weekKey: week.weekKey, location,
        updatedAt: new Date().toISOString(),
        updatedBy: user?.email || 'unknown'
      }, { merge: true })

      const retail   = Object.values(entries).reduce((s,d)=>s+(parseFloat(d?.retail)||0),0)
      const catering = Object.values(entries).reduce((s,d)=>s+(parseFloat(d?.catering)||0),0)
      const popup    = Object.values(entries).reduce((s,d)=>s+(parseFloat(d?.popup)||0),0)
      await writeSalesPnL(location, week.weekKey, { retail, catering, popup })

      toast.success('Sales saved & submitted to P&L')
      setDirty(false)
      setLastImport(new Date().toISOString())
    } catch(e) { toast.error('Something went wrong. Please try again.') }
    setSaving(false)
  }

  function setVal(dateKey, cat, val) {
    setEntries(prev => ({
      ...prev,
      [dateKey]: { ...(prev[dateKey]||{}), [cat]: parseFloat(val)||0 }
    }))
    setDirty(true)
  }

  function getVal(dateKey, cat) { return entries[dateKey]?.[cat] ?? '' }

  function dayTotal(dateKey) {
    return CATS.reduce((s,c) => s+(parseFloat(entries[dateKey]?.[c.key])||0), 0)
  }

  function prevDayTotal(dateKey) {
    // Map current date to equivalent prev week date
    const d = new Date(dateKey)
    d.setDate(d.getDate() - 7)
    const prevKey = d.toISOString().slice(0,10)
    return CATS.reduce((s,c) => s+(parseFloat(prevEntries[prevKey]?.[c.key])||0), 0)
  }

  function pctChange(curr, prev) {
    if (!prev || prev === 0) return null
    return ((curr - prev) / prev) * 100
  }

  const catTotals  = CATS.reduce((acc,c) => {
    acc[c.key] = week ? week.days.reduce((s,d) => s+(parseFloat(entries[d.key]?.[c.key])||0), 0) : 0
    return acc
  }, {})
  const weekTotal  = Object.values(catTotals).reduce((s,v) => s+v, 0)
  const prevWeekTotal = week ? week.days.reduce((s,d) => s+prevDayTotal(d.key), 0) : 0
  const budgetTotal   = budgetData.gfs || 0
  const weekVsBudget  = pctChange(weekTotal, budgetTotal)
  const weekVsLW      = pctChange(weekTotal, prevWeekTotal)

  function exportCSV() {
    const rows = [['Date',...CATS.map(c=>c.label),'Day Total','vs Last Week']]
    week?.days.forEach(d => {
      const dt   = dayTotal(d.key)
      const prev = prevDayTotal(d.key)
      const chg  = pctChange(dt, prev)
      rows.push([d.key,...CATS.map(c=>entries[d.key]?.[c.key]||0),dt.toFixed(2),chg!==null?chg.toFixed(1)+'%':''])
    })
    const blob = new Blob([rows.map(r=>r.join(',')).join('\n')],{type:'text/csv'})
    const url  = URL.createObjectURL(blob)
    Object.assign(document.createElement('a'),{href:url,download:`sales-${location}-${week?.weekKey}.csv`}).click()
    URL.revokeObjectURL(url)
  }

  async function handleImport(e) {
    const file = e.target.files[0]
    if (!file) return
    try {
      const XLSX      = await import('xlsx')
      const ab        = await file.arrayBuffer()
      const wb        = XLSX.read(new Uint8Array(ab),{type:'array',cellDates:true})
      const sheetName = wb.SheetNames.find(s=>s!=='Sheet1') || wb.SheetNames[0]
      const ws        = wb.Sheets[sheetName]
      const rows      = XLSX.utils.sheet_to_json(ws,{raw:false,dateNF:'yyyy-mm-dd'})
      parseSalesRows(rows)
    } catch(err) {
      console.error(err)
      toast.error('Import failed. Try exporting as CSV from Excel first.')
    }
    e.target.value = ''
  }

  function parseSalesRows(rows) {
    const newEntries = {}
    const weekDates  = new Set(week?.days.map(d=>d.key))
    const currentSite = location || ''

    rows.forEach(row => {
      if (currentSite) {
        const site = (row['Site Name']||row['site_name']||'').trim()
        if (site && site !== currentSite) return
      }
      const dateVal = row['Event Date']||row['event_date']||row['Date']||row['date']
      if (!dateVal) return
      const d = new Date(dateVal)
      if (isNaN(d)) return
      const key = d.toISOString().slice(0,10)
      if (!weekDates.has(key)) return

      const locName = (row['Location Name']||'').toLowerCase()
      let cat = 'retail'
      if (/cater/i.test(locName)) cat = 'catering'
      else if (/pop.?up|popup/i.test(locName)) cat = 'popup'

      const gross = parseFloat(row['Gross Food Sales']||row['Gross Food Sale (before min sales adjustments)']||row['Amount']||0)
      if (!gross) return
      if (!newEntries[key]) newEntries[key] = {}
      newEntries[key][cat] = ((parseFloat(newEntries[key][cat])||0) + gross)
    })

    const total = Object.values(newEntries).reduce((s,d)=>s+Object.values(d).reduce((ss,v)=>ss+(v||0),0),0)
    if (total === 0) {
      toast.warning('No matching data found. Check that the location name matches.')
    } else {
      toast.success(`Imported $${total.toLocaleString('en-US',{minimumFractionDigits:2})} in sales`)
      setEntries(newEntries)
      setDirty(true)
    }
  }

  if (!location) return (
    <div className={styles.empty}>
      <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#d1d5db" strokeWidth="1.5"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>
      <p className={styles.emptyTitle}>Select a location</p>
      <p className={styles.emptySub}>Choose a location from the dropdown above to log weekly sales</p>
    </div>
  )

  if (!week) return <div className={styles.loading}>Loading...</div>

  return (
    <div className={styles.page}>

      {/* Header */}
      <div className={styles.header}>
        <div>
          <h1 className={styles.title}>Weekly Sales</h1>
          <p className={styles.subtitle}>{cleanLocName(location)}</p>
        </div>
        <div className={styles.headerActions}>
          <button className={styles.btnIcon} onClick={exportCSV} title="Export CSV"><Download size={15}/></button>
        </div>
      </div>

      {/* Last import indicator */}
      {lastImport && (
        <div className={styles.sourceBar}>
          <span className={styles.sourceDot}/>
          Last saved {new Date(lastImport).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'})}
        </div>
      )}

      {/* Week nav */}
      <div className={styles.weekNav}>
        <button className={styles.weekBtn} onClick={prevWeek}>‹</button>
        <span className={styles.weekLabel}>{week.label}</span>
        <button className={styles.weekBtn} onClick={nextWeek}>›</button>
        {budgetTotal > 0 && (
          <span className={styles.paceBadge} style={{color: weekVsBudget !== null && weekVsBudget < -5 ? '#dc2626' : '#059669'}}>
            On pace: {fmt$(weekTotal)} vs {fmt$(budgetTotal)} budget
          </span>
        )}
      </div>

      {/* KPI strip */}
      <div className={styles.kpiBar}>
        <div className={styles.kpiMain}>
          <div className={styles.kpiMainLabel}>Week Total</div>
          <div className={styles.kpiMainVal}>{fmt$(weekTotal) !== '—' ? fmt$(weekTotal) : '$0.00'}</div>
          {prevWeekTotal > 0 && <div className={styles.kpiMainSub}>vs {fmt$(prevWeekTotal)} last week</div>}
        </div>
        {CATS.map(cat => {
          const prev = week.days.reduce((s,d) => {
            const pk = new Date(d.key); pk.setDate(pk.getDate()-7)
            return s+(parseFloat(prevEntries[pk.toISOString().slice(0,10)]?.[cat.key])||0)
          }, 0)
          const chg = pctChange(catTotals[cat.key], prev)
          return (
            <div key={cat.key} className={styles.kpi}>
              <div className={styles.kpiLabel} style={{color:cat.color}}>{cat.label}</div>
              <div className={styles.kpiVal}>{fmt$(catTotals[cat.key])}</div>
              {chg !== null && (
                <div className={styles.kpiChange} style={{color:chg>=0?'#059669':'#dc2626'}}>
                  {fmtPct(chg)} vs LW
                </div>
              )}
            </div>
          )
        })}
        <div className={styles.kpi}>
          <div className={styles.kpiLabel}>vs Budget</div>
          <div className={styles.kpiVal} style={{color: weekVsBudget !== null ? (weekVsBudget >= 0 ? '#059669':'#dc2626') : undefined}}>
            {budgetTotal > 0 ? fmt$(weekTotal - budgetTotal) : '—'}
          </div>
          {weekVsBudget !== null && budgetTotal > 0 && (
            <div className={styles.kpiChange} style={{color:weekVsBudget>=0?'#059669':'#dc2626'}}>
              {fmtPct(weekVsBudget)}
            </div>
          )}
        </div>
      </div>

      {/* Import bar */}
      <div className={styles.importBar}>
        <span className={styles.importBarLabel}>Import from your data source or enter manually below</span>
        <label className={styles.btnImport}>
          ↑ Import sales data
          <input type="file" accept=".xlsx,.xls,.csv" style={{display:'none'}} onChange={handleImport}/>
        </label>
      </div>

      {/* Table */}
      {loading ? <div className={styles.loading}>Loading...</div> : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th className={styles.thDay}>Day</th>
                {CATS.map(c => <th key={c.key} className={styles.thCat} style={{color:c.color}}>{c.label}</th>)}
                <th className={styles.thTotal}>Total</th>
                <th className={styles.thVar}>vs Last Week</th>
                {budgetTotal > 0 && <th className={styles.thVar}>vs Budget</th>}
              </tr>
            </thead>
            <tbody>
              {week.days.map(day => {
                const dt       = dayTotal(day.key)
                const prev     = prevDayTotal(day.key)
                const chg      = pctChange(dt, prev)
                const isToday  = day.date.toDateString() === new Date().toDateString()
                const isFuture = day.date > new Date()
                const isAlert  = chg !== null && chg < -10 && !isFuture && dt > 0

                return (
                  <tr key={day.key} className={`${styles.row} ${isToday?styles.today:''} ${isFuture?styles.future:''} ${isAlert?styles.alert:''}`}>
                    <td className={styles.tdDay}>
                      <div className={styles.dayName}>
                        {isAlert && <span className={styles.alertIcon}>⚠</span>}
                        {day.name}
                        {isToday && <span className={styles.todayBadge}>Today</span>}
                      </div>
                      <div className={styles.dayDate}>{day.date.toLocaleDateString('en-US',{month:'short',day:'numeric'})}</div>
                      {isAlert && <div className={styles.alertMsg}>More than 10% below last week</div>}
                    </td>

                    {CATS.map(cat => (
                      <td key={cat.key} className={styles.tdInput}>
                        <div className={styles.inputWrap}>
                          <span className={styles.dollar}>$</span>
                          <input
                            type="number" min="0" step="0.01"
                            value={getVal(day.key, cat.key)}
                            onChange={e=>setVal(day.key, cat.key, e.target.value)}
                            className={styles.input}
                            placeholder="0.00"
                            disabled={isFuture}
                          />
                        </div>
                      </td>
                    ))}

                    <td className={styles.tdTotal}>
                      <span style={{color:dt>0?'#059669':'#bbb',fontWeight:600}}>
                        {dt>0 ? fmt$(dt) : '—'}
                      </span>
                    </td>

                    <td className={styles.tdVar}>
                      {chg !== null && dt > 0 ? (
                        <span className={chg>=0?styles.varUp:styles.varDown}>
                          {fmtPct(chg)}
                        </span>
                      ) : <span className={styles.varNeutral}>—</span>}
                    </td>

                    {budgetTotal > 0 && (
                      <td className={styles.tdVar}>
                        <span className={styles.varNeutral}>—</span>
                      </td>
                    )}
                  </tr>
                )
              })}
            </tbody>
            <tfoot>
              <tr className={styles.totalRow}>
                <td className={styles.tfDay}>Weekly Total</td>
                {CATS.map(c => <td key={c.key} className={styles.tfCat}>{fmt$(catTotals[c.key])}</td>)}
                <td className={styles.tfTotal}>{fmt$(weekTotal)}</td>
                <td className={styles.tfVar}>
                  {weekVsLW !== null && prevWeekTotal > 0 ? (
                    <span className={weekVsLW>=0?styles.varUp:styles.varDown}>{fmtPct(weekVsLW)}</span>
                  ) : '—'}
                </td>
                {budgetTotal > 0 && (
                  <td className={styles.tfVar}>
                    {weekVsBudget !== null ? (
                      <span className={weekVsBudget>=0?styles.varUp:styles.varDown}>{fmtPct(weekVsBudget)}</span>
                    ) : '—'}
                  </td>
                )}
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      {/* Submit bar */}
      <div className={styles.submitBar}>
        <div className={styles.submitInfo}>
          {dirty
            ? <>Unsaved changes · <strong>{fmt$(weekTotal)}</strong> total this week</>
            : <><strong>{fmt$(weekTotal)}</strong> saved for this week</>
          }
        </div>
        <button className={styles.btnSave} onClick={handleSave} disabled={saving||!dirty}>
          {saving ? 'Saving...' : 'Save & submit to P&L'}
        </button>
      </div>

    </div>
  )
}