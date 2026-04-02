import { useState, useEffect, useMemo } from 'react'
import { useAuthStore } from '@/store/authStore'
import { useLocations, cleanLocName } from '@/store/LocationContext'
import { db } from '@/lib/firebase'
import { doc, getDoc, setDoc } from 'firebase/firestore'
import { Download, ChevronLeft, ChevronRight, Upload } from 'lucide-react'
import { useToast } from '@/components/ui/Toast'
import { usePeriod } from '@/store/PeriodContext'
import { writeSalesPnL } from '@/lib/pnl'
import styles from './WeeklySales.module.css'

const TENANT = 'fooda'
const DAYS   = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday']
const CATS   = [
  { key: 'retail',   label: 'Retail',   color: '#059669', description: 'Café, barista & grab-and-go' },
  { key: 'catering', label: 'Catering', color: '#7c3aed', description: 'Catering & events' },
  { key: 'popup',    label: 'Pop-up',   color: '#2563eb', description: 'Pop-up events' },
]

function getWeekInfo(offset) {
  const now = new Date()
  const day = now.getDay()
  const mon = new Date(now)
  mon.setDate(now.getDate() - (day === 0 ? 6 : day - 1) + offset * 7)
  mon.setHours(0,0,0,0)
  const sun = new Date(mon); sun.setDate(mon.getDate() + 6)
  const yr  = mon.getFullYear()
  const wn  = Math.ceil(((mon - new Date(yr,0,1)) / 86400000 + new Date(yr,0,1).getDay() + 1) / 7)
  return {
    weekKey: yr + '-W' + String(wn).padStart(2,'0'),
    label: 'Week ' + wn + ' · ' + mon.toLocaleDateString('en-US',{month:'short',day:'numeric'}) + ' – ' + sun.toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'}),
    days: DAYS.map(function(name, i) {
      var d = new Date(mon); d.setDate(mon.getDate() + i)
      return { name: name, date: d, key: d.toISOString().slice(0,10) }
    })
  }
}

function locId(name) { return name.replace(/[^a-zA-Z0-9]/g,'_') }

export default function WeeklySales() {
  var { user }                    = useAuthStore()
  var { selectedLocation }        = useLocations()
  var { year, period, week: weekNum, weeks, currentWeek, periodKey, prevWeek, nextWeek } = usePeriod()
  var [entries, setEntries]       = useState({})
  var [loading, setLoading]       = useState(false)
  var [saving, setSaving]         = useState(false)
  var [dirty, setDirty]           = useState(false)

  var location = selectedLocation === 'all' ? null : selectedLocation
  // Build week object compatible with existing code
  var week = useMemo(function() {
    if (!currentWeek) return null
    var start = currentWeek.start
    var end   = currentWeek.end
    var wn    = Math.ceil(((start - new Date(start.getFullYear(),0,1)) / 86400000 + new Date(start.getFullYear(),0,1).getDay() + 1) / 7)
    return {
      weekKey: periodKey,
      label: 'P' + period + ' Wk ' + weekNum + ' · ' + start.toLocaleDateString('en-US',{month:'short',day:'numeric'}) + ' – ' + end.toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'}),
      days: DAYS.map(function(name, i) {
        var d = new Date(start); d.setDate(start.getDate() + i)
        return d <= end ? { name: name, date: d, key: d.toISOString().slice(0,10) } : null
      }).filter(Boolean)
    }
  }, [currentWeek, periodKey, period, weekNum])

  useEffect(function() {
    if (!location) return
    loadData()
  }, [location, week.weekKey])

  async function loadData() {
    setLoading(true)
    try {
      var ref  = doc(db, 'tenants', TENANT, 'locations', locId(location), 'sales', week.weekKey)
      var snap = await getDoc(ref)
      setEntries(snap.exists() ? (snap.data().entries || {}) : {})
    } catch(e) { toast.error('Something went wrong. Please try again.') }
    setLoading(false); setDirty(false)
  }

  async function handleSave() {
    setSaving(true)
    try {
      var ref = doc(db, 'tenants', TENANT, 'locations', locId(location), 'sales', week.weekKey)
      await setDoc(ref, { entries: entries, weekKey: week.weekKey, location: location, updatedAt: new Date().toISOString(), updatedBy: user?.email || 'unknown' }, { merge: true })
      // Write P&L data
      const retail   = CATS.find(c=>c.key==='retail')   ? Object.values(entries).reduce((s,d)=>s+(parseFloat(d?.retail)||0),0)   : 0
      const catering = CATS.find(c=>c.key==='catering') ? Object.values(entries).reduce((s,d)=>s+(parseFloat(d?.catering)||0),0) : 0
      const popup    = CATS.find(c=>c.key==='popup')    ? Object.values(entries).reduce((s,d)=>s+(parseFloat(d?.popup)||0),0)    : 0
      await writeSalesPnL(location, week.weekKey, { retail, catering, popup })
      toast.success('Sales saved!')
      setDirty(false)
    } catch(e) { toast.error('Something went wrong. Please try again.') }
    setSaving(false)
  }

  function setVal(dateKey, cat, val) {
    setEntries(function(prev) {
      var next = Object.assign({}, prev)
      next[dateKey] = Object.assign({}, prev[dateKey] || {}, { [cat]: parseFloat(val) || 0 })
      return next
    })
    setDirty(true)
  }

  function getVal(dateKey, cat) { return entries[dateKey]?.[cat] ?? '' }

  var dayTotals  = week.days.map(function(d) { return CATS.reduce(function(s,c) { return s + (parseFloat(entries[d.key]?.[c.key]) || 0) }, 0) })
  var catTotals  = CATS.reduce(function(acc,c) { acc[c.key] = week.days.reduce(function(s,d) { return s + (parseFloat(entries[d.key]?.[c.key]) || 0) }, 0); return acc }, {})
  var weekTotal  = Object.values(catTotals).reduce(function(s,v) { return s+v }, 0)

  function exportCSV() {
    var rows = [['Date'].concat(CATS.map(function(c){return c.label})).concat(['Day Total'])]
    week.days.forEach(function(d,i) { rows.push([d.key].concat(CATS.map(function(c){return entries[d.key]?.[c.key]||0})).concat([dayTotals[i].toFixed(2)])) })
    rows.push(['TOTAL'].concat(CATS.map(function(c){return catTotals[c.key].toFixed(2)})).concat([weekTotal.toFixed(2)]))
    var blob = new Blob([rows.map(function(r){return r.join(',')}).join('\n')], { type:'text/csv' })
    var url  = URL.createObjectURL(blob)
    Object.assign(document.createElement('a'), { href:url, download:'sales-'+location+'-'+week.weekKey+'.csv' }).click()
    URL.revokeObjectURL(url)
  }

  async function handleImport(e) {
    var file = e.target.files[0]
    if (!file) return
    try {
      var XLSX = await import('xlsx')
      var arrayBuffer = await file.arrayBuffer()
      var wb = XLSX.read(new Uint8Array(arrayBuffer), { type:'array', cellDates:true })
      // Skip Sheet1 (pivot) — use first data sheet
      var sheetName = wb.SheetNames.find(function(s) { return s !== 'Sheet1' }) || wb.SheetNames[0]
      var ws  = wb.Sheets[sheetName]
      var rows = XLSX.utils.sheet_to_json(ws, { raw:false, dateNF:'yyyy-mm-dd' })
      parseFoodaRows(rows)
    } catch(err) {
      console.error('Import error:', err)
      toast.error('Import failed. Try exporting as CSV from Excel first.')
    }
    e.target.value = ''
  }

  function parseFoodaRows(rows) {
    // Fooda export: Event Date (col 0), Site Name (col 4), Location Name (col 13), Gross Food Sales (col 26)
    var newData = emptyWeek()
    var weekDatesArr = getWeekDates(week)
    var weekStart = new Date(weekDatesArr[0]); weekStart.setHours(0,0,0,0)
    var weekEnd   = new Date(weekDatesArr[6]); weekEnd.setHours(23,59,59,999)

    // Current location's Site Name (e.g. CR_QualcommSanDiego)
    var currentSite = location || ''

    rows.forEach(function(row) {
      // Filter by site if a location is selected
      if (currentSite) {
        var site = (row['Site Name'] || row['site_name'] || '').trim()
        if (site !== currentSite) return
      }

      var dateVal = row['Event Date'] || row['event_date']
      if (!dateVal) return
      var d = new Date(dateVal)
      if (isNaN(d)) return
      d.setHours(12,0,0,0) // normalize

      if (d < weekStart || d > weekEnd) return

      var dayNames = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday']
      var dayName = dayNames[d.getDay()]
      if (!newData[dayName]) return

      // Use Location Name to determine category
      var locName = (row['Location Name'] || '').toLowerCase()
      var cat = 'retail' // default — barista rolls into retail
      if (/cater/i.test(locName)) cat = 'catering'
      else if (/pop.?up|popup/i.test(locName)) cat = 'popup'

      var gross = parseFloat(row['Gross Food Sales'] || row['Gross Food Sale (before min sales adjustments)'] || 0)
      if (!gross) return
      var current = parseFloat(newData[dayName][cat]) || 0
      newData[dayName][cat] = (current + gross).toFixed(2)
    })

    var total = Object.values(newData).reduce(function(s, day) {
      return s + Object.values(day).reduce(function(ss, v) { return ss + (parseFloat(v)||0) }, 0)
    }, 0)

    if (total === 0) {
      toast.warning('No matching data found for ' + (currentSite || 'this period') + '. Check that the site name matches.')
    } else {
      toast.success('Imported $' + total.toLocaleString('en-US', {minimumFractionDigits:2}) + ' in sales.')
    }

    setData(newData)
    setDirty(true)
  }

  function parseFoodaCSV(lines) {
    // CSV fallback
    var header = lines[0].split(',').map(function(h) { return h.replace(/"/g,'').trim() })
    var dateIdx = header.indexOf('Event Date')
    var locIdx  = header.indexOf('Location Name')
    var grossIdx = header.indexOf('Gross Food Sales')
    if (grossIdx === -1) grossIdx = header.indexOf('Gross Food Sale (before min sales adjustments)')

    var newData = emptyWeek()
    lines.slice(1).forEach(function(line) {
      var cols = line.split(',').map(function(c) { return c.replace(/"/g,'').trim() })
      var dateStr = cols[dateIdx], locName = (cols[locIdx]||'').toLowerCase()
      var gross = parseFloat(cols[grossIdx]) || 0
      if (!dateStr || !gross) return

      var d = new Date(dateStr)
      if (isNaN(d)) return
      var dayNames = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday']
      var dayName = dayNames[d.getDay()]
      if (!newData[dayName]) return

      var cat = 'retail'
      if (/cater/i.test(locName)) cat = 'catering'
      else if (/pop.?up|popup/i.test(locName)) cat = 'popup'

      var current = parseFloat(newData[dayName][cat]) || 0
      newData[dayName][cat] = (current + gross).toFixed(2)
    })
    setData(newData)
    setDirty(true)
  }

  if (!location) return (
    <div className={styles.empty}>
      <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#d1d5db" strokeWidth="1.5" strokeLinecap="round"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>
      <p className={styles.emptyTitle}>Select a location</p>
      <p className={styles.emptySub}>Choose a location from the dropdown above to log weekly sales</p>
    </div>
  )

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <div>
          <h1 className={styles.title}>Weekly Sales</h1>
          <p className={styles.subtitle}>{cleanLocName(location)}</p>
        </div>
        <div className={styles.headerActions}>
          {dirty && <button className={styles.btnSave} onClick={handleSave} disabled={saving}>{saving?'Saving...':'Save Changes'}</button>}
          <button className={styles.btnIcon} onClick={exportCSV} title="Export"><Download size={15}/></button>
        </div>
      </div>

      <div className={styles.weekNav}>
        <button className={styles.weekBtn} onClick={function(){setWeekOffset(function(w){return w-1})}}><ChevronLeft size={16}/></button>
        <div className={styles.weekLabel}>{week.label}</div>
        <button className={styles.weekBtn} onClick={function(){setWeekOffset(function(w){return w+1})}} disabled={weekOffset >= 0}><ChevronRight size={16}/></button>
        {weekOffset !== 0 && <button className={styles.weekToday} onClick={function(){setWeekOffset(0)}}>This week</button>}
      </div>

      <div className={styles.kpiBar}>
        <div className={styles.kpiMain}>
          <div className={styles.kpiLabel}>Week Total</div>
          <div className={styles.kpiValue}>${weekTotal.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}</div>
        </div>
        {CATS.map(function(cat) {
          return (
            <div key={cat.key} className={styles.kpi}>
              <div className={styles.kpiLabel} style={{color:cat.color}}>{cat.label}</div>
              <div className={styles.kpiSmall}>${catTotals[cat.key].toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}</div>
            </div>
          )
        })}
      </div>

      {loading ? <div className={styles.loading}>Loading...</div> : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th className={styles.thDay}>Day</th>
                {CATS.map(function(cat) { return <th key={cat.key} className={styles.thCat} style={{color:cat.color}}>{cat.label}</th> })}
                <th className={styles.thTotal}>Total</th>
              </tr>
            </thead>
            <tbody>
              {week.days.map(function(day, idx) {
                var dt      = dayTotals[idx]
                var isToday = day.date.toDateString() === new Date().toDateString()
                var isFuture= day.date > new Date()
                return (
                  <tr key={day.key} className={styles.row + (isToday?' '+styles.today:'') + (isFuture?' '+styles.future:'')}>
                    <td className={styles.tdDay}>
                      <div className={styles.dayName}>{day.name}</div>
                      <div className={styles.dayDate}>{day.date.toLocaleDateString('en-US',{month:'short',day:'numeric'})}</div>
                    </td>
                    {CATS.map(function(cat) {
                      return (
                        <td key={cat.key} className={styles.tdInput}>
                          <div className={styles.inputWrap}>
                            <span className={styles.dollar}>$</span>
                            <input type="number" min="0" step="0.01"
                              value={getVal(day.key, cat.key)}
                              onChange={function(e){setVal(day.key, cat.key, e.target.value)}}
                              className={styles.input} placeholder="0.00" disabled={isFuture}/>
                          </div>
                        </td>
                      )
                    })}
                    <td className={styles.tdTotal}>
                      <span style={{color:dt>0?'#059669':'#bbb',fontWeight:700}}>
                        {dt>0?'$'+dt.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}):'—'}
                      </span>
                    </td>
                  </tr>
                )
              })}
            </tbody>
            <tfoot>
              <tr className={styles.totalRow}>
                <td className={styles.tfDay}>Weekly Total</td>
                {CATS.map(function(cat) { return <td key={cat.key} className={styles.tfCat}>${catTotals[cat.key].toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}</td> })}
                <td className={styles.tfTotal}>${weekTotal.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  )
}
