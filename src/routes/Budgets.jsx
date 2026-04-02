import { useState, useEffect, useMemo, useCallback } from 'react'
import { useAuthStore } from '@/store/authStore'
import { useLocations, cleanLocName } from '@/store/LocationContext'
import { useToast } from '@/components/ui/Toast'
import { db } from '@/lib/firebase'
import { doc, getDoc, setDoc, serverTimestamp } from 'firebase/firestore'
import { Upload, Download, RefreshCw, ChevronDown, ChevronRight, Settings } from 'lucide-react'
import { readPnL } from '@/lib/pnl'
import styles from './Budgets.module.css'

const MONTHS  = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
const YEARS   = ['2025','2026','2027']
const SECTION_COLORS = ['#059669','#2563eb','#7c3aed','#dc2626','#d97706','#0891b2']

// ── Detect section from row label ─────────────────────────────
function detectSection(label) {
  const l = label.toLowerCase()
  if (l.includes('gross food') || l.includes('gfs') || l === 'popup' || l === 'catering' || l === 'retail' || l === 'delivery' || l === 'pantry') return 'Gross Food Sales'
  if (l.includes('revenue') || l.includes('commission') || l.includes('fee') || l.includes('subsid')) return 'Revenue'
  if (l.includes('labor') || l.includes('wage') || l.includes('salar') || l.includes('bonus') || l.includes('benefit') || l.includes('barista') || l.includes('concierge') || l.includes('dishwash') || l.includes('utility') || l.includes('catering runner')) return 'Labor'
  if (l.includes('equipment') || l.includes('consumable') || l.includes('supplies') || l.includes('cleaning') || l.includes('paper product')) return 'Consumables'
  if (l.includes('cost of goods') || l.includes('cogs') || l.includes('payment process') || l.includes('retail cogs') || l.includes('revenue share')) return 'COGS'
  if (l.includes('gross margin')) return 'Gross Margin'
  if (l.includes('ebitda')) return 'EBITDA'
  if (l.includes('expense') || l.includes('marketing') || l.includes('technology') || l.includes('travel') || l.includes('professional') || l.includes('facilit') || l.includes('license') || l.includes('permit')) return 'Expenses'
  return 'Other'
}

function isBoldRow(label) {
  const l = label.toLowerCase()
  return l.startsWith('total') || l === 'ebitda' || l === 'gross margin' || l.includes('gross margin') || l.includes('total labor') || l.includes('total revenue') || l.includes('total cogs') || l.includes('total cost of goods')
}

function isHighlightRow(label) {
  const l = label.toLowerCase()
  return l === 'ebitda' || l === 'gross margin' || l.includes('total gross food sales') || l === 'net income'
}

function isGFSBase(label) {
  const l = label.toLowerCase()
  return l.includes('total gross food sales') || l === 'total gfs'
}

function slugify(str) {
  return str.toLowerCase().replace(/[^a-z0-9]+/g,'_').replace(/^_|_$/g,'')
}

function locId(n) { return (n||'').replace(/[^a-zA-Z0-9]/g,'_') }

const fmt$ = v => {
  if (v === null || v === undefined || isNaN(v)) return '—'
  const abs = Math.abs(v)
  const s   = '$' + abs.toLocaleString('en-US',{minimumFractionDigits:0,maximumFractionDigits:0})
  return v < 0 ? `(${s})` : s
}
const fmtPct = (v, base) => base > 0 ? (v/base*100).toFixed(1)+'%' : '—'
const varColor = v => v === null || v === undefined ? undefined : v >= 0 ? '#059669' : '#dc2626'

// ── Excel → schema + data parser ─────────────────────────────
function parseExcel(rows) {
  // Step 1: find month header row
  let monthCols = null
  let monthRowIdx = -1
  const MONTH_NAMES = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec']

  for (let r = 0; r < Math.min(rows.length, 25); r++) {
    const row = rows[r].map(c => String(c||'').toLowerCase().trim())
    const janIdx = row.findIndex(c => c.startsWith('jan'))
    if (janIdx !== -1) {
      monthCols = MONTH_NAMES.map(m => {
        const idx = row.findIndex(c => c.startsWith(m))
        return idx !== -1 ? idx : janIdx + MONTH_NAMES.indexOf(m)
      })
      monthRowIdx = r
      break
    }
  }

  if (!monthCols) return null

  // Step 2: parse data rows into sections + lines
  const sections = {}
  const sectionOrder = []
  const data = {} // lineKey → { 1: val, ... 12: val }

  for (let r = monthRowIdx + 1; r < rows.length; r++) {
    const row   = rows[r]
    const raw   = String(row[0] || row[1] || '').trim()
    if (!raw || raw.length < 2) continue

    // Skip metadata / formula rows
    const lower = raw.toLowerCase()
    if (lower.includes('seasonality') || lower.includes('business days') || lower.includes('days in') ||
        lower.includes('checksum') || lower.includes('variance (sb') || lower.includes('#div') ||
        lower.includes('#n/a') || lower.includes('run rate') || lower.includes('update instructions') ||
        lower.includes('accounting site') || lower.includes('trailing') || lower.includes('inputs')) continue

    // Read month values
    const months = {}
    let hasData = false
    monthCols.forEach((col, i) => {
      const cell = String(row[col] || '').replace(/[$,\s]/g,'').trim()
      // Handle parentheses as negatives: (12,345) → -12345
      const isNeg = cell.startsWith('(') && cell.endsWith(')')
      const clean = cell.replace(/[()]/g,'')
      const val   = parseFloat(clean)
      if (!isNaN(val) && val !== 0) {
        months[i+1] = isNeg ? -val : val
        hasData = true
      }
    })

    if (!hasData) continue

    const section = detectSection(raw)
    const key     = slugify(raw)

    if (!sections[section]) {
      sections[section] = { lines: [], colorIdx: Object.keys(sections).length }
      sectionOrder.push(section)
    }

    // Don't duplicate keys
    if (!sections[section].lines.find(l => l.key === key)) {
      sections[section].lines.push({
        key,
        label:     raw,
        bold:      isBoldRow(raw),
        highlight: isHighlightRow(raw),
        gfsBase:   isGFSBase(raw),
      })
    }

    data[key] = months
  }

  // Build schema array
  const schema = sectionOrder.map((name, i) => ({
    id:    slugify(name),
    label: name,
    color: SECTION_COLORS[i % SECTION_COLORS.length],
    lines: sections[name].lines,
  }))

  return { schema, data }
}

export default function Budgets() {
  const { user }             = useAuthStore()
  const { selectedLocation } = useLocations()
  const toast                = useToast()

  const [year,      setYear]      = useState('2026')
  const [schema,    setSchema]    = useState([])   // [{id,label,color,lines:[]}]
  const [budget,    setBudget]    = useState({})   // { lineKey: { 1:val,...12:val } }
  const [actuals,   setActuals]   = useState({})
  const [loading,   setLoading]   = useState(false)
  const [saving,    setSaving]    = useState(false)
  const [dirty,     setDirty]     = useState(false)
  const [view,      setView]      = useState('budget')
  const [collapsed, setCollapsed] = useState({})
  const [dragOver,  setDragOver]  = useState(false)
  const [preview,   setPreview]   = useState(null)
  const [sheetNames,  setSheetNames]  = useState([])
  const [activeSheet, setActiveSheet] = useState('')
  const [rawWb,       setRawWb]       = useState(null)

  const location = selectedLocation === 'all' ? null : selectedLocation
  const orgId    = 'fooda' // TODO: pull from useAuth once org migration complete

  useEffect(() => { if (location) load() }, [location, year])

  async function load() {
    setLoading(true)
    try {
      // Load schema
      const schemaSnap = await getDoc(doc(db,'orgs',orgId,'budgetSchema','default'))
      if (schemaSnap.exists()) setSchema(schemaSnap.data().sections || [])

      // Load budget data
      const dataSnap = await getDoc(doc(db,'tenants','fooda','budgets',`${locId(location)}-${year}`))
      setBudget(dataSnap.exists() ? dataSnap.data().lines || {} : {})
      setDirty(false)

      // Load actuals
      const act = {}
      await Promise.all(MONTHS.map(async (_, i) => {
        const mo  = i + 1
        const key = `${year}-P${String(mo).padStart(2,'0')}`
        try {
          const pnl = await readPnL(location, key)
          if (pnl) {
            // Map known P&L fields to budget keys dynamically
            Object.entries(pnl).forEach(([pnlKey, val]) => {
              if (!act[pnlKey]) act[pnlKey] = {}
              act[pnlKey][mo] = val
            })
          }
        } catch {}
      }))
      setActuals(act)
    } catch(e) { toast.error('Failed to load budget.') }
    setLoading(false)
  }

  async function saveSchema(newSchema) {
    await setDoc(doc(db,'orgs',orgId,'budgetSchema','default'), {
      sections:  newSchema,
      updatedAt: serverTimestamp(),
      updatedBy: user?.email || 'unknown',
    }, { merge: true })
  }

  async function handleSave() {
    if (!location) return
    setSaving(true)
    try {
      await setDoc(doc(db,'tenants','fooda','budgets',`${locId(location)}-${year}`), {
        lines: budget, location, year,
        updatedAt: serverTimestamp(), updatedBy: user?.email || 'unknown'
      }, { merge: true })
      toast.success('Budget saved!')
      setDirty(false)
    } catch(e) { toast.error('Failed to save budget.') }
    setSaving(false)
  }

  // ── File parsing ──────────────────────────────────────────
  async function parseFile(file) {
    try {
      const XLSX = await import('xlsx')
      const ab   = await file.arrayBuffer()
      const wb   = XLSX.read(new Uint8Array(ab), { type:'array', cellDates:true })
      setRawWb({ wb, XLSX })

      if (wb.SheetNames.length === 1) {
        doParseSheet(wb, wb.SheetNames[0], XLSX)
      } else {
        setSheetNames(wb.SheetNames)
        setActiveSheet(wb.SheetNames[0])
        doParseSheet(wb, wb.SheetNames[0], XLSX)
      }
    } catch(e) {
      console.error(e)
      toast.error('Could not read file. Please use Excel (.xlsx) or CSV format.')
    }
  }

  function doParseSheet(wb, sheetName, XLSX) {
    const ws   = wb.Sheets[sheetName]
    const rows = XLSX.utils.sheet_to_json(ws, { header:1, defval:'' })
    const result = parseExcel(rows)

    if (!result || result.schema.length === 0) {
      toast.error('No data found. Make sure the file has month columns (Jan–Dec).')
      return
    }

    setPreview({ ...result, sheetName, lineCount: Object.keys(result.data).length })
  }

  function switchSheet(sheet) {
    setActiveSheet(sheet)
    if (rawWb) doParseSheet(rawWb.wb, sheet, rawWb.XLSX)
  }

  async function confirmImport() {
    if (!preview) return
    // Save schema (shared across org) + budget data (per location)
    await saveSchema(preview.schema)
    setSchema(preview.schema)
    setBudget(preview.data)
    setPreview(null)
    setSheetNames([])
    setDirty(true)
    toast.success(`Imported ${preview.lineCount} line items — click Save to persist.`)
  }

  const onDrop = useCallback(e => {
    e.preventDefault(); setDragOver(false)
    const file = e.dataTransfer.files[0]
    if (file) parseFile(file)
  }, [])

  function downloadTemplate() {
    const rows = [
      ['Line Item','Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'],
      ['GROSS FOOD SALES','','','','','','','','','','','',''],
      ['Popup','','','','','','','','','','','',''],
      ['Catering','','','','','','','','','','','',''],
      ['Retail','','','','','','','','','','','',''],
      ['Total Gross Food Sales','','','','','','','','','','','',''],
      ['REVENUE','','','','','','','','','','','',''],
      ['Total Revenue','','','','','','','','','','','',''],
      ['LABOR','','','','','','','','','','','',''],
      ['Total Salaries & Wages','','','','','','','','','','','',''],
      ['Bonuses','','','','','','','','','','','',''],
      ['Benefits & Taxes','','','','','','','','','','','',''],
      ['Total Labor','','','','','','','','','','','',''],
      ['COGS','','','','','','','','','','','',''],
      ['Payment Processing Fees','','','','','','','','','','','',''],
      ['Retail COGS','','','','','','','','','','','',''],
      ['Total Cost of Goods Sold','','','','','','','','','','','',''],
      ['GROSS MARGIN','','','','','','','','','','','',''],
      ['Gross Margin','','','','','','','','','','','',''],
      ['EXPENSES','','','','','','','','','','','',''],
      ['Marketing & Advertising','','','','','','','','','','','',''],
      ['Technology Services','','','','','','','','','','','',''],
      ['Other','','','','','','','','','','','',''],
      ['Expenses','','','','','','','','','','','',''],
      ['EBITDA','','','','','','','','','','','',''],
      ['EBITDA','','','','','','','','','','','',''],
    ]
    const csv  = rows.map(r => r.map(v=>`"${v}"`).join(',')).join('\n')
    const blob = new Blob([csv],{type:'text/csv'})
    const url  = URL.createObjectURL(blob)
    Object.assign(document.createElement('a'),{href:url,download:'aurelia-budget-template.csv'}).click()
    URL.revokeObjectURL(url)
  }

  function exportCSV() {
    const allLines = schema.flatMap(s => s.lines)
    const gfsLine  = allLines.find(l => l.gfsBase)
    const gfsData  = gfsLine ? budget[gfsLine.key] || {} : {}
    const annualGFS = MONTHS.reduce((s,_,i) => s+(gfsData[i+1]||0), 0)

    const rows = [['Line Item',...MONTHS,'Annual','% GFS']]
    allLines.forEach(line => {
      const d = budget[line.key] || {}
      const annual = MONTHS.reduce((s,_,i) => s+(d[i+1]||0), 0)
      rows.push([line.label,...MONTHS.map((_,i)=>d[i+1]||0),annual,fmtPct(annual,annualGFS)])
    })
    const csv  = rows.map(r=>r.map(v=>`"${v}"`).join(',')).join('\n')
    const blob = new Blob([csv],{type:'text/csv'})
    const url  = URL.createObjectURL(blob)
    Object.assign(document.createElement('a'),{href:url,download:`budget-${locId(location)}-${year}.csv`}).click()
    URL.revokeObjectURL(url)
  }

  // ── Computed ──────────────────────────────────────────────
  const allLines = useMemo(() => schema.flatMap(s => s.lines), [schema])

  const annuals = useMemo(() => {
    const t = {}
    allLines.forEach(l => {
      const d = budget[l.key] || {}
      t[l.key] = MONTHS.reduce((s,_,i) => s+(d[i+1]||0), 0)
    })
    return t
  }, [budget, allLines])

  const gfsLine   = allLines.find(l => l.gfsBase)
  const annualGFS = gfsLine ? (annuals[gfsLine.key] || 1) : 1

  if (!location) return (
    <div className={styles.empty}>
      <div style={{fontSize:48}}>📊</div>
      <p className={styles.emptyTitle}>Select a location</p>
      <p className={styles.emptySub}>Choose a location from the dropdown to view and manage budgets</p>
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
          {schema.length > 0 && (
            <div className={styles.viewToggle}>
              <button className={view==='budget'?styles.viewActive:styles.viewBtn} onClick={()=>setView('budget')}>Budget</button>
              <button className={view==='variance'?styles.viewActive:styles.viewBtn} onClick={()=>setView('variance')}>Actual vs Budget</button>
            </div>
          )}
          <select value={year} onChange={e=>setYear(e.target.value)} className={styles.yearSel}>
            {YEARS.map(y=><option key={y}>{y}</option>)}
          </select>
          {schema.length > 0 && <button className={styles.btnIcon} onClick={exportCSV} title="Export CSV"><Download size={15}/></button>}
          <button className={styles.btnIcon} onClick={load} title="Refresh"><RefreshCw size={14}/></button>
          {dirty && <button className={styles.btnSave} onClick={handleSave} disabled={saving}>{saving?'Saving...':'Save'}</button>}
        </div>
      </div>

      {/* Drop zone */}
      <div
        className={`${styles.dropzone} ${dragOver?styles.dropzoneActive:''}`}
        onDragOver={e=>{e.preventDefault();setDragOver(true)}}
        onDragLeave={()=>setDragOver(false)}
        onDrop={onDrop}
      >
        <Upload size={18} style={{color:'#2563eb',marginBottom:6}}/>
        <div className={styles.dropTitle}>
          {schema.length === 0 ? 'Upload your budget file to get started' : 'Drop a new budget file to update'}
        </div>
        <div className={styles.dropSub}>
          or <label className={styles.dropLink}>browse files
            <input type="file" accept=".xlsx,.xls,.csv" style={{display:'none'}} onChange={e=>e.target.files[0]&&parseFile(e.target.files[0])}/>
          </label> · Excel or CSV · single or multi-tab
        </div>
        {schema.length === 0 && (
          <div className={styles.dropHint}>First upload sets your P&L structure for this org — future uploads update numbers only</div>
        )}
      </div>

      {/* Sheet picker */}
      {sheetNames.length > 1 && (
        <div className={styles.sheetPicker}>
          <span className={styles.sheetLabel}>Multiple sheets found — select which to import:</span>
          <div className={styles.sheetBtns}>
            {sheetNames.map(s => (
              <button key={s} className={activeSheet===s?styles.sheetActive:styles.sheetBtn} onClick={()=>switchSheet(s)}>{s}</button>
            ))}
          </div>
        </div>
      )}

      {/* Preview confirm */}
      {preview && (
        <div className={styles.previewBar}>
          <div className={styles.previewInfo}>
            <span className={styles.previewCheck}>✓</span>
            Parsed <strong>{preview.lineCount} line items</strong> across <strong>{preview.schema.length} sections</strong> from <strong>"{preview.sheetName}"</strong>
            {schema.length === 0 && <span className={styles.previewNew}> · New schema will be saved for this org</span>}
          </div>
          <div style={{display:'flex',gap:8}}>
            <button className={styles.btnCancel} onClick={()=>{setPreview(null);setSheetNames([])}}>Cancel</button>
            <button className={styles.btnConfirm} onClick={confirmImport}>
              {schema.length === 0 ? 'Import & set schema' : 'Import data'}
            </button>
          </div>
        </div>
      )}

      {loading ? <div className={styles.loading}>Loading...</div> :
       schema.length === 0 ? (
        <div className={styles.noSchema}>
          <div style={{fontSize:32,marginBottom:12,opacity:.3}}>📋</div>
          <p style={{fontWeight:600,fontSize:15,marginBottom:6}}>No budget schema yet</p>
          <p style={{fontSize:13,color:'var(--text-secondary)',maxWidth:360,textAlign:'center',lineHeight:1.6}}>
            Upload your budget Excel file above. Aurelia will read your P&L structure automatically — sections, line items, everything.
          </p>
        </div>
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th className={styles.thLine}>Line item</th>
                {MONTHS.map(m => <th key={m} className={styles.th}>{m}</th>)}
                <th className={styles.thAnnual}>Annual</th>
                <th className={styles.thPct}>% GFS</th>
              </tr>
            </thead>
            <tbody>
              {schema.map(section => (
                <>
                  <tr key={section.id} className={styles.sectionRow} onClick={()=>setCollapsed(p=>({...p,[section.id]:!p[section.id]}))}>
                    <td colSpan={15} className={styles.sectionLabel} style={{borderTopColor:section.color,color:section.color}}>
                      <span className={styles.sectionToggle}>
                        {collapsed[section.id] ? <ChevronRight size={11}/> : <ChevronDown size={11}/>}
                      </span>
                      {section.label.toUpperCase()}
                    </td>
                  </tr>

                  {!collapsed[section.id] && section.lines.map(line => {
                    const annualVal = annuals[line.key] || 0

                    return (
                      <tr key={line.key} className={`${styles.row} ${line.bold?styles.boldRow:''} ${line.highlight?styles.highlightRow:''}`}>
                        <td className={styles.lineLabel}>{line.label}</td>

                        {MONTHS.map((_,i) => {
                          const mo   = i + 1
                          const bVal = budget[line.key]?.[mo] ?? null
                          const aVal = actuals[line.key]?.[mo] ?? null

                          if (view === 'variance') {
                            const variance = aVal !== null && bVal !== null ? aVal - bVal : null
                            return (
                              <td key={mo} className={styles.varCell}>
                                {aVal !== null && <div className={styles.varActual}>{fmt$(aVal)}</div>}
                                {bVal !== null && <div className={styles.varBudget}>{fmt$(bVal)}</div>}
                                {variance !== null && <div className={styles.varDiff} style={{color:varColor(variance)}}>{variance>=0?'+':''}{fmt$(variance)}</div>}
                                {aVal===null&&bVal===null&&<span className={styles.dash}>—</span>}
                              </td>
                            )
                          }

                          return (
                            <td key={mo} className={styles.dataCell}>
                              {bVal !== null
                                ? <span style={{color:line.highlight?(bVal>=0?'#059669':'#dc2626'):undefined}}>{fmt$(bVal)}</span>
                                : <span className={styles.dash}>—</span>
                              }
                            </td>
                          )
                        })}

                        <td className={styles.annualCell} style={{color:line.highlight?(annualVal>=0?'#059669':'#dc2626'):undefined}}>
                          {fmt$(annualVal)}
                        </td>
                        <td className={styles.pctCell}>
                          {line.gfsBase ? '100%' : fmtPct(annualVal, annualGFS)}
                        </td>
                      </tr>
                    )
                  })}
                </>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}