import { useState, useEffect, useMemo } from 'react'
import { useAuthStore } from '@/store/authStore'
import { useLocations, cleanLocName } from '@/store/LocationContext'
import { db } from '@/lib/firebase'
import { doc, getDoc, setDoc } from 'firebase/firestore'
import { Download, ChevronLeft, ChevronRight } from 'lucide-react'
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

function locId(name) { return name.replace(/[^a-zA-Z0-9]/g,'_') }

function getWeekDates(week) {
  return week.days.map(function(d) { return d.key })
}

function emptyWeek() {
  var result = {}
  DAYS.forEach(function(d) { result[d] = { retail: '', catering: '', popup: '' } })
  return result
}

export default function WeeklySales() {
  var { user }             = useAuthStore()
  var { selectedLocation } = useLocations()
  var { year, period, week: weekNum, currentWeek, periodKey, prevWeek, nextWeek } = usePeriod()
  var [entries, setEntries] = useState({})
  var [loading, setLoading] = useState(false)
  var [saving,  setSaving]  = useState(false)
  var [dirty,   setDirty]   = useState(false)
  var toast                 = useToast()

  var location = selectedLocation === 'all' ? null : selectedLocation

  var week = useMemo(function() {
    if (!currentWeek) return null
    var start = currentWeek.start
    var end   = currentWeek.end
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
    if (!location || !week) return
    loadData()
  }, [location, week?.weekKey])

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
      await setDoc(ref, {
        entries, weekKey: week.weekKey, location,
        updatedAt: new Date().toISOString(),
        updatedBy: user?.email || 'unknown'
      }, { merge: true })
      const retail   = Object.values(entries).reduce(function(s,d){return s+(parseFloat(d?.retail)||0)},0)
      const catering = Object.values(entries).reduce(function(s,d){return s+(parseFloat(d?.catering)||0)},0)
      const popup    = Object.values(entries).reduce(function(s,d){return s+(parseFloat(d?.popup)||0)},0)
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

  var dayTotals = week ? week.days.map(function(d) {
    return CATS.reduce(function(s,c) { return s + (parseFloat(entries[d.key]?.[c.key]) || 0) }, 0)
  }) : []

  var catTotals = CATS.reduce(function(acc,c) {
    acc[c.key] = week ? week.days.reduce(function(s,d) { return s + (parseFloat(entries[d.key]?.[c.key]) || 0) }, 0) : 0
    return acc
  }, {})

  var weekTotal = Object.values(catTotals).reduce(function(s,v) { return s+v }, 0)

  function exportCSV() {
    var rows = [['Date'].concat(CATS.map(function(c){return c.label})).concat(['Day Total'])]
    week.days.forEach(function(d,i) {
      rows.push([d.key].concat(CATS.map(function(c){return entries[d.key]?.[c.key]||0})).concat([dayTotals[i].toFixed(2)]))
    })
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
      var sheetName = wb.SheetNames.find(function(s) { return s !== 'Sheet1' }) || wb.SheetNames[0]
      var ws   = wb.Sheets[sheetName]
      var rows = XLSX.utils.sheet_to_json(ws, { raw:false, dateNF:'yyyy-mm-dd' })
      parseFoodaRows(rows)
    } catch(err) {
      console.error('Import error:', err)
      toast.error('Import failed. Try exporting as CSV from Excel first.')
    }
    e.target.value = ''
  }

  function parseFoodaRows(rows) {
    var newEntries = {}
    var weekDates  = new Set(week.days.map(function(d){return d.key}))
    var currentSite = location || ''

    rows.forEach(function(row) {
      if (currentSite) {
        var site = (row['Site Name'] || row['site_name'] || '').trim()
        if (site !== currentSite) return
      }
      var dateVal = row['Event Date'] || row['event_date']
      if (!dateVal) return
      var d = new Date(dateVal)
      if (isNaN(d)) return
      var key = d.toISOString().slice(0,10)
      if (!weekDates.has(key)) return

      var locName = (row['Location Name'] || '').toLowerCase()
      var cat = 'retail'
      if (/cater/i.test(locName)) cat = 'catering'
      else if (/pop.?up|popup/i.test(locName)) cat = 'popup'

      var gross = parseFloat(row['Gross Food Sales'] || row['Gross Food Sale (before min sales adjustments)'] || 0)
      if (!gross) return
      if (!newEntries[key]) newEntries[key] = {}
      newEntries[key][cat] = ((parseFloat(newEntries[key][cat]) || 0) + gross).toFixed(2)
    })

    var total = Object.values(newEntries).reduce(function(s, day) {
      return s + Object.values(day).reduce(function(ss, v) { return ss + (parseFloat(v)||0) }, 0)
    }, 0)

    if (total === 0) {
      toast.warning('No matching data found for ' + (currentSite || 'this period') + '. Check that the site name matches.')
    } else {
      toast.success('Imported $' + total.toLocaleString('en-US', {minimumFractionDigits:2}) + ' in sales.')
    }
    setEntries(newEntries)
    setDirty(true)
  }

  if (!location) return (
    <div className={styles.empty}>
      <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#d1d5db" strokeWidth="1.5" strokeLinecap="round"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>
      <p className={styles.emptyTitle}>Select a location</p>
      <p className={styles.emptySub}>Choose a location from the dropdown above to log weekly sales</p>
    </div>
  )

  if (!week) return <div className={styles.loading}>Loading...</div>

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <div>
          <h1 className={styles.title}>Weekly Sales</h1>
          <p className={styles.subtitle}>{cleanLocName(location)}</p>
        </div>
        <div className={styles.headerActions}>
          <label className={styles.btnIcon} title="Import from Fooda export">
            <input type="file" accept=".xlsx,.xls,.csv" onChange={handleImport} style={{display:'none'}}/>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
          </label>
          {dirty && <button className={styles.btnSave} onClick={handleSave} disabled={saving}>{saving?'Saving...':'Save Changes'}</button>}
          <button className={styles.btnIcon} onClick={exportCSV} title="Export"><Download size={15}/></button>
        </div>
      </div>

      {/* Week navigation — uses prevWeek/nextWeek from usePeriod */}
      <div className={styles.weekNav}>
        <button className={styles.weekBtn} onClick={prevWeek}><ChevronLeft size={16}/></button>
        <div className={styles.weekLabel}>{week.label}</div>
        <button className={styles.weekBtn} onClick={nextWeek}><ChevronRight size={16}/></button>
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
                {CATS.map(function(cat) {
                  return <th key={cat.key} className={styles.thCat} style={{color:cat.color}}>{cat.label}</th>
                })}
                <th className={styles.thTotal}>Total</th>
              </tr>
            </thead>
            <tbody>
              {week.days.map(function(day, idx) {
                var dt       = dayTotals[idx]
                var isToday  = day.date.toDateString() === new Date().toDateString()
                var isFuture = day.date > new Date()
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
                {CATS.map(function(cat) {
                  return <td key={cat.key} className={styles.tfCat}>${catTotals[cat.key].toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}</td>
                })}
                <td className={styles.tfTotal}>${weekTotal.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  )
}