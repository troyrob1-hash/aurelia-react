import { useState, useEffect, useMemo } from 'react'
import { useAuthStore } from '@/store/authStore'
import { useLocations, cleanLocName } from '@/store/LocationContext'
import { useToast } from '@/components/ui/Toast'
import { db } from '@/lib/firebase'
import { doc, getDoc, setDoc, serverTimestamp } from 'firebase/firestore'
import { Save, Upload, Download } from 'lucide-react'
import styles from './Budgets.module.css'

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
const YEARS  = ['2025','2026','2027']
const LINES  = [
  { key:'gfs',    label:'Gross Food Sales',  section:'Revenue' },
  { key:'revenue',label:'Net Revenue',        section:'Revenue' },
  { key:'cogs',   label:'Total COGS',         section:'Costs' },
  { key:'labor',  label:'Labor',              section:'Costs' },
  { key:'ebitda', label:'EBITDA',             section:'Profit' },
]

function locationId(n) { return n.replace(/[^a-zA-Z0-9]/g,'_') }

export default function Budgets() {
  const { user } = useAuthStore()
  const { selectedLocation, groupedLocations } = useLocations()
  const toast = useToast()
  const [year, setYear]     = useState('2026')
  const [budget, setBudget] = useState({})
  const [loading, setLoading] = useState(false)
  const [saving, setSaving]  = useState(false)
  const [dirty, setDirty]    = useState(false)
  const [view, setView]      = useState('location') // location | region

  const location = selectedLocation==='all' ? null : selectedLocation

  useEffect(() => { if (location) load() }, [location, year])

  async function load() {
    setLoading(true)
    try {
      const ref  = doc(db,'tenants','fooda','budgets',`${locationId(location)}-${year}`)
      const snap = await getDoc(ref)
      setBudget(snap.exists() ? snap.data().months||{} : {})
      setDirty(false)
    } catch(e) { toast.error('Failed to load budget.') }
    setLoading(false)
  }

  async function handleSave() {
    if (!location) return
    setSaving(true)
    try {
      const ref = doc(db,'tenants','fooda','budgets',`${locationId(location)}-${year}`)
      await setDoc(ref, { months:budget, location, year, updatedAt:serverTimestamp(), updatedBy:user?.email||'unknown' }, {merge:true})
      toast.success('Budget saved!')
      setDirty(false)
    } catch(e) { toast.error('Failed to save budget.') }
    setSaving(false)
  }

  async function handleImport(e) {
    const file = e.target.files[0]
    if (!file) return
    try {
      const XLSX = await import('xlsx')
      const ab   = await file.arrayBuffer()
      const wb   = XLSX.read(new Uint8Array(ab), {type:'array'})
      const ws   = wb.Sheets[wb.SheetNames[0]]
      const data = XLSX.utils.sheet_to_json(ws, {raw:false})
      const newBudget = {}
      data.forEach(row => {
        const mo = parseInt(row['Month']||row['month']||0)
        if (!mo || mo<1 || mo>12) return
        if (!newBudget[mo]) newBudget[mo] = {}
        LINES.forEach(l => {
          const v = parseFloat(row[l.label]||row[l.key]||0)
          if (v) newBudget[mo][l.key] = v
        })
      })
      setBudget(newBudget)
      setDirty(true)
      toast.success('Budget imported!')
    } catch(err) { toast.error('Import failed.') }
    e.target.value = ''
  }

  function setVal(mo, key, val) {
    setBudget(prev => ({ ...prev, [mo]: { ...(prev[mo]||{}), [key]: parseFloat(val)||0 } }))
    setDirty(true)
  }

  function exportCSV() {
    const rows = [['Month',...LINES.map(l=>l.label)],
      ...MONTHS.map((m,i) => [m,...LINES.map(l=>(budget[i+1]?.[l.key]||0).toFixed(2))])]
    const csv = rows.map(r=>r.map(v=>`"${v}"`).join(',')).join('\n')
    const blob = new Blob([csv],{type:'text/csv'})
    const url = URL.createObjectURL(blob)
    Object.assign(document.createElement('a'),{href:url,download:`budget-${cleanLocName(location||'all')}-${year}.csv`}).click()
    URL.revokeObjectURL(url)
  }

  const annualTotals = useMemo(() => {
    const t = {}
    LINES.forEach(l => { t[l.key] = MONTHS.reduce((s,_,i)=>s+(budget[i+1]?.[l.key]||0),0) })
    return t
  }, [budget])

  if (!location) return (
    <div className={styles.empty}>
      <div style={{fontSize:48}}>📊</div>
      <p className={styles.emptyTitle}>Select a location</p>
      <p className={styles.emptySub}>Choose a location from the dropdown to view and edit budgets</p>
    </div>
  )

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <div>
          <h1 className={styles.title}>Budget Manager</h1>
          <p className={styles.subtitle}>{cleanLocName(location)} · {year}</p>
        </div>
        <div className={styles.actions}>
          <select value={year} onChange={e=>setYear(e.target.value)} className={styles.yearSel}>
            {YEARS.map(y=><option key={y}>{y}</option>)}
          </select>
          <label className={styles.btnImport}><Upload size={14}/> Upload
            <input type="file" accept=".csv,.xlsx,.xls" style={{display:'none'}} onChange={handleImport}/>
          </label>
          <button className={styles.btnIcon} onClick={exportCSV}><Download size={15}/></button>
          {dirty && <button className={styles.btnSave} onClick={handleSave} disabled={saving}><Save size={14}/> {saving?'Saving...':'Save'}</button>}
        </div>
      </div>

      {loading ? <div className={styles.loading}>Loading...</div> : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th className={styles.thLine}>Line Item</th>
                {MONTHS.map(m=><th key={m} className={styles.th}>{m}</th>)}
                <th className={styles.th}>Annual</th>
              </tr>
            </thead>
            <tbody>
              {['Revenue','Costs','Profit'].map(section => (
                <>
                  <tr key={section} className={styles.sectionRow}>
                    <td colSpan={14} className={styles.sectionLabel}>{section.toUpperCase()}</td>
                  </tr>
                  {LINES.filter(l=>l.section===section).map(line => (
                    <tr key={line.key} className={styles.row}>
                      <td className={styles.lineLabel}>{line.label}</td>
                      {MONTHS.map((_,i) => (
                        <td key={i} className={styles.inputCell}>
                          <input
                            type="number" min="0" step="1000"
                            value={budget[i+1]?.[line.key]||''}
                            onChange={e=>setVal(i+1,line.key,e.target.value)}
                            className={styles.budgetInput}
                            placeholder="—"
                          />
                        </td>
                      ))}
                      <td className={styles.annualCell}>
                        ${annualTotals[line.key].toLocaleString('en-US',{minimumFractionDigits:0})}
                      </td>
                    </tr>
                  ))}
                </>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
