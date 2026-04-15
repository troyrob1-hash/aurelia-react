import { useState, useEffect, useMemo, useCallback } from 'react'
import { useAuthStore } from '@/store/authStore'
import { useLocations, cleanLocName } from '@/store/LocationContext'
import { useToast } from '@/components/ui/Toast'
import { usePeriod } from '@/store/PeriodContext'
import { db } from '@/lib/firebase'
import { doc, getDoc, setDoc, addDoc, updateDoc, collection, serverTimestamp } from 'firebase/firestore'
import { Upload, Download, RefreshCw, ChevronDown, ChevronRight, Lock, Unlock, TrendingUp, TrendingDown } from 'lucide-react'
import { readPnL, writePnL } from '@/lib/pnl'
import styles from './Budgets.module.css'

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
const YEARS  = ['2025','2026','2027','2028']
const SECTION_COLORS = ['#059669','#2563eb','#7c3aed','#dc2626','#d97706','#0891b2']

// ── Period key bridge — map month number to period key format ─
function monthToPeriodKey(year, mo) {
  return `${year}-P${String(mo).padStart(2,'0')}-W1`
}

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

function slugify(str) { return str.toLowerCase().replace(/[^a-z0-9]+/g,'_').replace(/^_|_$/g,'') }
function locId(n)    { return (n||'').replace(/[^a-zA-Z0-9]/g,'_') }

// ── SAFETY GUARD ─────────────────────────────────────────────
// Blocks destructive writes when pointed at prod unless the selected
// location is explicitly a test sandbox. Client-side only — not a security
// boundary, just a midnight-mistake preventer. Remove after staging is on
// Blaze and we can do destructive work there instead.
const IS_PROD_FIREBASE = import.meta.env.VITE_FIREBASE_PROJECT_ID === 'the-grove-70180'
function assertSafeToWrite(location) {
  if (!IS_PROD_FIREBASE) return
  const name = String(location || '').toLowerCase()
  if (!/test|sandbox|dev|qa/.test(name)) {
    throw new Error('Budget writes blocked: location "' + location + '" is not a test sandbox. Safety guard active in Budgets.jsx. Select a Test/Sandbox location or remove the guard post-pilot.')
  }
}

const fmt$ = v => {
  if (v === null || v === undefined || isNaN(v)) return '—'
  const abs = Math.abs(v)
  const s   = '$' + abs.toLocaleString('en-US',{minimumFractionDigits:0,maximumFractionDigits:0})
  return v < 0 ? `(${s})` : s
}
const fmtPct  = (v, base) => base > 0 ? (v/base*100).toFixed(1)+'%' : '—'
const varColor = v => v == null ? undefined : v >= 0 ? '#059669' : '#dc2626'

function parseExcel(rows, budgetYear) {
  const MONTH_NAMES = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec']
  let monthCols = null, monthRowIdx = -1

  // ── Strategy 1: find a row of Date objects for the budget year ──
  // Real operator P&L files (e.g. Qualcomm) have date headers like 2026-01-31
  // that SheetJS converts to JS Date objects with cellDates:true.
  // We look for the row with the most date cells matching budgetYear and
  // pick exactly the 12 monthly columns in calendar order.
  const targetYear = parseInt(budgetYear) || new Date().getFullYear()

  for (let r = 0; r < Math.min(rows.length, 20); r++) {
    const row = rows[r]
    const dateCols = []
    for (let c = 0; c < row.length; c++) {
      const cell = row[c]
      if (cell instanceof Date && cell.getFullYear() === targetYear) {
        dateCols.push({ col: c, month: cell.getMonth() }) // 0-indexed month
      }
    }
    if (dateCols.length >= 12) {
      // Found a row with 12+ date cells for the target year.
      // Group by month, take the FIRST column per month (the Plan band,
      // not the Override band which comes later in the same row).
      const byMonth = {}
      dateCols.forEach(({ col, month }) => {
        if (byMonth[month] === undefined) byMonth[month] = col
      })
      if (Object.keys(byMonth).length >= 12) {
        monthCols = MONTH_NAMES.map((_, i) => byMonth[i])
        monthRowIdx = r
        break
      }
    }
  }

  // ── Strategy 2 (fallback): template-style "Jan/Feb/Mar" text headers ──
  if (!monthCols) {
    for (let r = 0; r < Math.min(rows.length, 25); r++) {
      const row = rows[r].map(c => String(c||'').toLowerCase().trim())
      const janIdx = row.findIndex(c => c === 'jan' || c === 'january')
      if (janIdx !== -1) {
        const found = MONTH_NAMES.map(m => {
          const idx = row.findIndex(c => c === m || c.startsWith(m) && c.length <= m.length + 5)
          return idx !== -1 ? idx : -1
        })
        if (found.filter(x => x !== -1).length >= 10) {
          monthCols = found.map((idx, i) => idx !== -1 ? idx : janIdx + i)
          monthRowIdx = r
          break
        }
      }
    }
  }

  if (!monthCols) return null

  // ── Row walker (unchanged logic) ──
  const sections = {}, sectionOrder = [], data = {}

  for (let r = monthRowIdx + 1; r < rows.length; r++) {
    const row   = rows[r]
    const raw   = String(row[0] || row[1] || row[2] || '').trim()
    if (!raw || raw.length < 2) continue
    const lower = raw.toLowerCase()
    if (lower.includes('seasonality') || lower.includes('business days') || lower.includes('days in') ||
        lower.includes('checksum') || lower.includes('#div') || lower.includes('#n/a') ||
        lower.includes('run rate') || lower.includes('update instructions') ||
        lower.includes('accounting site') || lower.includes('trailing') || lower.includes('inputs')) continue

    const months = {}
    let hasData = false
    monthCols.forEach((col, i) => {
      const cell = row[col]
      let val
      if (typeof cell === 'number') {
        val = cell
      } else {
        const str = String(cell || '').replace(/[$,\s]/g,'').trim()
        const isNeg = str.startsWith('(') && str.endsWith(')')
        val = parseFloat(str.replace(/[()]/g,''))
        if (isNeg && !isNaN(val)) val = -val
      }
      if (!isNaN(val) && val !== 0) { months[i+1] = val; hasData = true }
    })
    if (!hasData) continue

    const section = detectSection(raw)
    const key     = slugify(raw)
    if (!sections[section]) { sections[section] = { lines: [], colorIdx: Object.keys(sections).length }; sectionOrder.push(section) }
    if (!sections[section].lines.find(l => l.key === key)) {
      sections[section].lines.push({ key, label: raw, bold: isBoldRow(raw), highlight: isHighlightRow(raw), gfsBase: isGFSBase(raw) })
    }
    data[key] = months
  }

  const schema = sectionOrder.map((name, i) => ({
    id: slugify(name), label: name,
    color: SECTION_COLORS[i % SECTION_COLORS.length],
    lines: sections[name].lines,
  }))
  return { schema, data }
}

export default function Budgets() {
  const { user }             = useAuthStore()
  const orgId                = user?.tenantId || 'fooda'
  const { selectedLocation, visibleLocations } = useLocations()
  const { year: ctxYear }    = usePeriod()
  const toast                = useToast()
  const isDirector           = user?.role === 'Admin' || user?.role === 'Director'

  const [year,          setYear]          = useState(String(ctxYear || new Date().getFullYear()))
  const [schema,        setSchema]        = useState([])
  const [budget,        setBudget]        = useState({})
  const [actuals,       setActuals]       = useState({})
  const [loading,       setLoading]       = useState(false)
  const [saving,        setSaving]        = useState(false)
  const [dirty,         setDirty]         = useState(false)
  const [view,          setView]          = useState('budget')
  const [collapsed,     setCollapsed]     = useState({})
  const [dragOver,      setDragOver]      = useState(false)
  const [preview,       setPreview]       = useState(null)
  const [sheetNames,    setSheetNames]    = useState([])
  const [activeSheet,   setActiveSheet]   = useState('')
  const [rawWb,         setRawWb]         = useState(null)
  const [approvalStatus, setApproval]     = useState(null) // null | 'pending' | 'approved' | 'rejected'
  const [submissionId,   setSubmissionId] = useState(null)
  const [unlockRequest,  setUnlockRequest] = useState(null)
  const [showUnlockModal, setShowUnlockModal] = useState(false)
  const [unlockReason,   setUnlockReason] = useState('')
  const [scenarioGFS,    setScenarioGFS]  = useState(0)   // % adjustment
  const [showScenario,   setShowScenario] = useState(false)
  const [editingCell,    setEditingCell]  = useState(null) // { key, mo }

  const location = selectedLocation === 'all' ? null : selectedLocation
  const isLocked = approvalStatus === 'approved'

  useEffect(() => { if (location) load() }, [location, year])





  async function load() {
    setLoading(true)
    try {
      // Load schema — use tenants path
      const schemaSnap = await getDoc(doc(db,'tenants',orgId,'config','budgetSchema'))
      if (schemaSnap.exists()) setSchema(schemaSnap.data().sections || [])

      // Load budget data
      const dataSnap = await getDoc(doc(db,'tenants',orgId,'budgets',`${locId(location)}-${year}`))
      if (dataSnap.exists()) {
        setBudget(dataSnap.data().lines || {})
        setApproval(dataSnap.data().status || null)
        setSubmissionId(dataSnap.id)
      } else {
        setBudget({})
        setApproval(null)
        setSubmissionId(null)
      }
      setDirty(false)

      // Load actuals — all 12 months
      const act = {}
      await Promise.all(MONTHS.map(async (_, i) => {
        const mo  = i + 1
        const key = monthToPeriodKey(year, mo)
        try {
          const pnl = await readPnL(location, key)
          if (pnl) Object.entries(pnl).forEach(([k, v]) => {
            if (typeof v === 'number') { if (!act[k]) act[k] = {}; act[k][mo] = v }
          })
        } catch {}
      }))
      setActuals(act)
    } catch { toast.error('Failed to load budget.') }
    setLoading(false)
  }

  async function saveSchema(newSchema) {
    await setDoc(doc(db,'tenants',orgId,'config','budgetSchema'), {
      sections: newSchema, updatedAt: serverTimestamp(), updatedBy: user?.name || user?.email,
    }, { merge: true })
  }

  async function handleSave() {
    if (!location) return
    try { assertSafeToWrite(location) } catch (err) { toast.error(err.message); return }
    setSaving(true)
    try {
      // Save budget doc
      await setDoc(doc(db,'tenants',orgId,'budgets',`${locId(location)}-${year}`), {
        lines: budget, location, year,
        status: 'pending',
        submittedBy: user?.name || user?.email,
        updatedAt: serverTimestamp(),
      }, { merge: true })

      setApproval('pending')
      setDirty(false)
      toast.success('Budget saved — pending director approval')
    } catch { toast.error('Failed to save budget.') }
    setSaving(false)
  }

  async function handleApprove() {
    if (!location) return
    try { assertSafeToWrite(location) } catch (err) { toast.error(err.message); return }
    try {
      // Approve the budget
      await updateDoc(doc(db,'tenants',orgId,'budgets',`${locId(location)}-${year}`), {
        status: 'approved', approvedBy: user?.name || user?.email, approvedAt: serverTimestamp(),
      })

      // Write budget to P&L for each month using correct period key format
      const allLines = schema.flatMap(s => s.lines)
      const gfsLine  = allLines.find(l => l.gfsBase)

      await Promise.all(MONTHS.map(async (_, i) => {
        const mo        = i + 1
        const periodKey = monthToPeriodKey(year, mo)
        const gfs       = budget[gfsLine?.key]?.[mo] || 0
        const labor     = allLines.filter(l => detectSection(l.label) === 'Labor')
          .reduce((s, l) => s + (budget[l.key]?.[mo] || 0), 0)
        const revenue   = allLines.filter(l => detectSection(l.label) === 'Revenue')
          .reduce((s, l) => s + (budget[l.key]?.[mo] || 0), 0)
        const cogs      = allLines.filter(l => detectSection(l.label) === 'COGS')
          .reduce((s, l) => s + (budget[l.key]?.[mo] || 0), 0)
        const ebitdaLine = allLines.find(l => l.label.toLowerCase() === 'ebitda')
        const ebitda    = budget[ebitdaLine?.key]?.[mo] || 0

        await writePnL(location, periodKey, {
          budget_gfs:     gfs,
          budget_revenue: revenue,
          budget_cogs:    cogs,
          budget_labor:   labor,
          budget_ebitda:  ebitda,
        })
      }))

      setApproval('approved')
      toast.success('Budget approved — all 12 months posted to P&L Dashboard')
    } catch { toast.error('Approval failed.') }
  }

  async function handleReject() {
    await updateDoc(doc(db,'tenants',orgId,'budgets',`${locId(location)}-${year}`), {
      status: 'rejected', rejectedBy: user?.name || user?.email, rejectedAt: serverTimestamp(),
    })
    setApproval('rejected')
    toast.success('Budget rejected')
  }

  async function requestUnlock() {
    if (!unlockReason.trim()) { toast.error('Please provide a reason for the unlock request'); return }
    await addDoc(collection(db,'tenants',orgId,'budgetUnlockRequests'), {
      location, year, reason: unlockReason.trim(),
      requestedBy: user?.name || user?.email, requestedAt: serverTimestamp(), status: 'pending',
    })
    setShowUnlockModal(false)
    setUnlockReason('')
    toast.success('Unlock request submitted to director')
  }

  async function approveUnlock() {
    await updateDoc(doc(db,'tenants',orgId,'budgets',`${locId(location)}-${year}`), {
      status: 'approved_unlock', unlockedBy: user?.name || user?.email, unlockedAt: serverTimestamp(),
    })
    setApproval('approved_unlock')
    toast.success('Budget unlocked for adjustment')
  }

  function handleCellEdit(key, mo, val) {
    if (isLocked) return
    const num = parseFloat(val) || 0
    setBudget(prev => ({ ...prev, [key]: { ...(prev[key]||{}), [mo]: num } }))
    setDirty(true)
  }

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
    } catch { toast.error('Could not read file. Please use Excel (.xlsx) or CSV format.') }
  }

  function doParseSheet(wb, sheetName, XLSX) {
    const ws     = wb.Sheets[sheetName]
    const rows   = XLSX.utils.sheet_to_json(ws, { header:1, defval:'' })
    const result = parseExcel(rows, year)
    if (!result || result.schema.length === 0) { toast.error('No data found. Make sure the file has month columns (Jan–Dec).'); return }
    setPreview({ ...result, sheetName, lineCount: Object.keys(result.data).length })
  }

  function switchSheet(sheet) {
    setActiveSheet(sheet)
    if (rawWb) doParseSheet(rawWb.wb, sheet, rawWb.XLSX)
  }

  async function confirmImport() {
    if (!preview) return
    await saveSchema(preview.schema)
    setSchema(preview.schema)
    setBudget(preview.data)
    setPreview(null)
    setSheetNames([])
    setDirty(true)
    toast.success(`Imported ${preview.lineCount} line items — save to submit for approval`)
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
    const annualGFS = MONTHS.reduce((s,_,i) => s+(budget[gfsLine?.key]?.[i+1]||0), 0)
    const rows = [['Line Item',...MONTHS,'Annual','% GFS']]
    allLines.forEach(line => {
      const d      = budget[line.key] || {}
      const annual = MONTHS.reduce((s,_,i) => s+(d[i+1]||0), 0)
      rows.push([line.label,...MONTHS.map((_,i)=>d[i+1]||0),annual,fmtPct(annual,annualGFS)])
    })
    const csv  = rows.map(r=>r.map(v=>`"${v}"`).join(',')).join('\n')
    const blob = new Blob([csv],{type:'text/csv'})
    const url  = URL.createObjectURL(blob)
    Object.assign(document.createElement('a'),{href:url,download:`budget-${locId(location)}-${year}.csv`}).click()
    URL.revokeObjectURL(url)
  }

  // ── Derived values ─────────────────────────────────────────
  const allLines  = useMemo(() => schema.flatMap(s => s.lines), [schema])
  const gfsLine   = allLines.find(l => l.gfsBase)
  const ebitdaLine = allLines.find(l => l.label.toLowerCase() === 'ebitda')

  const annuals = useMemo(() => {
    const t = {}
    allLines.forEach(l => { t[l.key] = MONTHS.reduce((s,_,i) => s+(budget[l.key]?.[i+1]||0), 0) })
    return t
  }, [budget, allLines])

  const annualGFS    = gfsLine ? (annuals[gfsLine.key] || 1) : 1
  const annualEBITDA = ebitdaLine ? annuals[ebitdaLine.key] : 0

  // Rolling forecast — use YTD actuals to project full year
  const currentMo = new Date().getMonth() + 1
  const ytdActualGFS = useMemo(() => {
    if (!gfsLine) return 0
    const pnlKey = Object.keys(actuals).find(k => k.includes('gfs_total'))
    if (!pnlKey) return 0
    return MONTHS.slice(0, currentMo).reduce((s,_,i) => s+(actuals[pnlKey]?.[i+1]||0), 0)
  }, [actuals, gfsLine, currentMo])

  const projectedFullYearGFS = currentMo > 0 ? (ytdActualGFS / currentMo) * 12 : 0
  const forecastVsBudget     = projectedFullYearGFS - annualGFS

  // Scenario: apply GFS % adjustment to all lines proportionally
  const scenarioBudget = useMemo(() => {
    if (!showScenario || scenarioGFS === 0) return budget
    const factor = 1 + (scenarioGFS / 100)
    const result = {}
    Object.entries(budget).forEach(([key, months]) => {
      result[key] = {}
      Object.entries(months).forEach(([mo, v]) => { result[key][mo] = v * factor })
    })
    return result
  }, [budget, scenarioGFS, showScenario])

  const activeBudget = showScenario ? scenarioBudget : budget

  if (!location) return (
    <div className={styles.empty}>
      <div style={{fontSize:48}}>📊</div>
      <p className={styles.emptyTitle}>Select a location</p>
      <p className={styles.emptySub}>Choose a location from the dropdown to view and manage budgets</p>
    </div>
  )

  return (
    <div className={styles.page} onDragOver={e=>{e.preventDefault();setDragOver(true)}} onDragLeave={()=>setDragOver(false)} onDrop={onDrop}>

      {/* ── Header ── */}
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
          {dirty && !isLocked && <button className={styles.btnSave} onClick={handleSave} disabled={saving}>{saving?'Saving...':'Submit for Approval'}</button>}
          {isLocked && !isDirector && <button className={styles.btnUnlock} onClick={()=>setShowUnlockModal(true)}><Unlock size={13}/> Request Adjustment</button>}
        </div>
      </div>

      {/* ── Status bar ── */}
      {approvalStatus && (
        <div className={`${styles.statusBar} ${styles['status_'+approvalStatus.replace('_unlock','')]}`}>
          <div className={styles.statusLeft}>
            {isLocked ? <Lock size={13}/> : null}
            <span>
              {approvalStatus === 'pending'  && `Budget submitted — pending director approval before posting to P&L`}
              {approvalStatus === 'approved' && `Budget approved & locked · All 12 months posted to P&L Dashboard`}
              {approvalStatus === 'approved_unlock' && `Budget unlocked for adjustment — re-upload and resubmit`}
              {approvalStatus === 'rejected' && `Budget rejected — re-upload and resubmit`}
            </span>
          </div>
          <div className={styles.statusRight}>
            <span className={`${styles.badge} ${styles['badge_'+approvalStatus.replace('_unlock','')]}`}>
              {approvalStatus === 'pending'  ? 'Pending approval' :
               approvalStatus === 'approved' ? 'Approved & Locked' :
               approvalStatus === 'approved_unlock' ? 'Unlocked' : 'Rejected'}
            </span>
            {approvalStatus === 'pending' && isDirector && (
              <>
                <button className={styles.btnApprove} onClick={handleApprove}>Approve &amp; Post to P&L</button>
                <button className={styles.btnReject} onClick={handleReject}>Reject</button>
              </>
            )}
          </div>
        </div>
      )}

      {/* ── Unlock request modal ── */}
      {showUnlockModal && (
        <div className={styles.overlay}>
          <div className={styles.modal}>
            <h3 className={styles.modalTitle}>Request Budget Adjustment</h3>
            <p className={styles.modalSub}>Explain why an adjustment is needed. Your director will review the request.</p>
            <textarea className={styles.modalTextarea} placeholder="e.g. Catering revenue significantly exceeded Q1 budget — updating forecast for Q2-Q4" value={unlockReason} onChange={e=>setUnlockReason(e.target.value)} rows={3} autoFocus/>
            <div className={styles.modalActions}>
              <button className={styles.btnApprove} onClick={requestUnlock}>Submit Request</button>
              <button className={styles.btnCancel} onClick={()=>setShowUnlockModal(false)}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      {/* ── KPI summary bar ── */}
      {schema.length > 0 && (
        <div className={styles.kpiBar}>
          <div className={`${styles.kpi} ${styles.kpiDark}`}>
            <div className={styles.kpiL}>Annual GFS Budget</div>
            <div className={styles.kpiV}>{fmt$(annualGFS)}</div>
            {projectedFullYearGFS > 0 && (
              <div className={styles.kpiSub} style={{color: forecastVsBudget >= 0 ? '#6ee7b7' : '#fca5a5'}}>
                {forecastVsBudget >= 0 ? '▲' : '▼'} Forecast: {fmt$(projectedFullYearGFS)}
              </div>
            )}
          </div>
          <div className={styles.kpi}>
            <div className={styles.kpiL}>Annual EBITDA Budget</div>
            <div className={styles.kpiV} style={{color: annualEBITDA >= 0 ? '#059669' : '#dc2626'}}>{fmt$(annualEBITDA)}</div>
            <div className={styles.kpiSub}>EBITDA margin: {fmtPct(annualEBITDA, annualGFS)}</div>
          </div>
          <div className={styles.kpi}>
            <div className={styles.kpiL}>YTD Actual GFS</div>
            <div className={styles.kpiV}>{ytdActualGFS > 0 ? fmt$(ytdActualGFS) : '—'}</div>
            {ytdActualGFS > 0 && (
              <div className={styles.kpiSub} style={{color: varColor(ytdActualGFS - MONTHS.slice(0,currentMo).reduce((s,_,i)=>s+(budget[gfsLine?.key]?.[i+1]||0),0))}}>
                vs {fmt$(MONTHS.slice(0,currentMo).reduce((s,_,i)=>s+(budget[gfsLine?.key]?.[i+1]||0),0))} budget YTD
              </div>
            )}
          </div>
          <div className={styles.kpi}>
            <div className={styles.kpiL}>Status</div>
            <div className={styles.kpiV} style={{fontSize:14}}>
              {!approvalStatus && 'Not submitted'}
              {approvalStatus === 'pending'  && '⏳ Pending'}
              {approvalStatus === 'approved' && '✅ Approved'}
              {approvalStatus === 'rejected' && '❌ Rejected'}
            </div>
            <div className={styles.kpiSub}>{year} annual budget</div>
          </div>
        </div>
      )}

      {/* ── Scenario what-if bar ── */}
      {schema.length > 0 && isLocked && (
        <div className={styles.scenarioBar}>
          <button className={`${styles.scenarioToggle} ${showScenario ? styles.scenarioOn : ''}`} onClick={()=>setShowScenario(v=>!v)}>
            <TrendingUp size={13}/> What-if scenario
          </button>
          {showScenario && (
            <>
              <span className={styles.scenarioLabel}>GFS adjustment:</span>
              <input type="range" min="-30" max="30" step="1" value={scenarioGFS} onChange={e=>setScenarioGFS(Number(e.target.value))} className={styles.scenarioSlider}/>
              <span className={`${styles.scenarioPct} ${scenarioGFS >= 0 ? styles.scenarioPos : styles.scenarioNeg}`}>{scenarioGFS >= 0 ? '+' : ''}{scenarioGFS}%</span>
              <span className={styles.scenarioNote}>Read-only · Budget not modified</span>
              <button className={styles.scenarioReset} onClick={()=>setScenarioGFS(0)}>Reset</button>
            </>
          )}
        </div>
      )}

      {/* ── Sheet picker ── */}
      {sheetNames.length > 1 && (
        <div className={styles.sheetPicker}>
          <span className={styles.sheetLabel}>Multiple sheets — select which to import:</span>
          <div className={styles.sheetBtns}>
            {sheetNames.map(s => (
              <button key={s} className={activeSheet===s?styles.sheetActive:styles.sheetBtn} onClick={()=>switchSheet(s)}>{s}</button>
            ))}
          </div>
        </div>
      )}

      {/* ── Preview confirm ── */}
      {preview && (
        <div className={styles.previewBar}>
          <div className={styles.previewInfo}>
            <span className={styles.previewCheck}>✓</span>
            Parsed <strong>{preview.lineCount} line items</strong> across <strong>{preview.schema.length} sections</strong> from <strong>"{preview.sheetName}"</strong>
          </div>
          <div style={{display:'flex',gap:8}}>
            <button className={styles.btnCancel} onClick={()=>{setPreview(null);setSheetNames([])}}>Cancel</button>
            <button className={styles.btnConfirm} onClick={confirmImport}>{schema.length===0?'Import & set schema':'Import data'}</button>
          </div>
        </div>
      )}

      {loading ? <div className={styles.loading}>Loading...</div> :

      schema.length === 0 ? (
        /* ── Empty state ── */
        <div className={`${styles.emptyState} ${dragOver?styles.emptyStateDrag:''}`}>
          <div className={styles.emptyHeader}>
            <div className={styles.emptyTitle2}>Set your {year} budget</div>
            <div className={styles.emptySub2}>Upload your annual budget once before the fiscal year. Once approved by your director it locks and feeds the P&L Dashboard with budget vs actual variance automatically.</div>
          </div>
          <div className={styles.templateCards}>
            <div className={styles.tcard}>
              <div className={styles.tcardIcon} style={{background:'#E1F5EE'}}><Download size={16} style={{color:'#0F6E56'}}/></div>
              <div className={styles.tcardTitle}>Download a template</div>
              <div className={styles.tcardDesc}>Start with our standard P&L template. Fill in your numbers and upload when ready.</div>
              <button className={styles.tcardBtn} onClick={downloadTemplate}>↓ Download Excel template</button>
            </div>
            <div className={styles.tcard} style={{borderColor:'#B5D4F4'}}>
              <div className={styles.tcardIcon} style={{background:'#E6F1FB'}}><Upload size={16} style={{color:'#185FA5'}}/></div>
              <div className={styles.tcardTitle}>I already have a budget file</div>
              <div className={styles.tcardDesc}>Upload your existing Excel or CSV — we'll read your P&L structure automatically.</div>
              <label className={styles.tcardBtnBlue}>↑ Upload my file<input type="file" accept=".xlsx,.xls,.csv" style={{display:'none'}} onChange={e=>e.target.files[0]&&parseFile(e.target.files[0])}/></label>
            </div>
          </div>
          <div className={styles.orDivider}><div className={styles.orLine}/><span className={styles.orText}>or drag and drop anywhere on this page</span><div className={styles.orLine}/></div>
        </div>
      ) : (
        <>
          {/* Compact upload zone — only shown when not locked */}
          {!isLocked && (
            <div className={`${styles.dropzone} ${dragOver?styles.dropzoneActive:''}`}>
              <Upload size={16} style={{color:'#2563eb',marginBottom:4}}/>
              <div className={styles.dropTitle}>Drop a new budget file to update</div>
              <div className={styles.dropSub}>or <label className={styles.dropLink}>browse files<input type="file" accept=".xlsx,.xls,.csv" style={{display:'none'}} onChange={e=>e.target.files[0]&&parseFile(e.target.files[0])}/></label> · Excel or CSV</div>
            </div>
          )}

          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th className={styles.thLine}>
                    Line item
                    {isLocked && <Lock size={10} style={{marginLeft:6,opacity:.4}}/>}
                  </th>
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
                        <span className={styles.sectionToggle}>{collapsed[section.id]?<ChevronRight size={11}/>:<ChevronDown size={11}/>}</span>
                        {section.label.toUpperCase()}
                      </td>
                    </tr>

                    {!collapsed[section.id] && section.lines.map(line => {
                      const annualVal  = MONTHS.reduce((s,_,i)=>s+(activeBudget[line.key]?.[i+1]||0),0)
                      return (
                        <tr key={line.key} className={`${styles.row} ${line.bold?styles.boldRow:''} ${line.highlight?styles.highlightRow:''}`}>
                          <td className={styles.lineLabel}>{line.label}</td>
                          {MONTHS.map((_,i) => {
                            const mo   = i + 1
                            const bVal = activeBudget[line.key]?.[mo] ?? null
                            const aVal = actuals[`budget_${line.key}`]?.[mo] ?? null
                            const isEditing = editingCell?.key === line.key && editingCell?.mo === mo

                            if (view === 'variance') {
                              const actual   = actuals['gfs_total']?.[mo] != null ? actuals[Object.keys(actuals).find(k=>k===line.key)||'']?.[mo] ?? null : null
                              const variance = actual !== null && bVal !== null ? actual - bVal : null
                              return (
                                <td key={mo} className={styles.varCell}>
                                  {actual !== null && <div className={styles.varActual}>{fmt$(actual)}</div>}
                                  {bVal !== null   && <div className={styles.varBudget}>{fmt$(bVal)}</div>}
                                  {variance !== null && <div className={styles.varDiff} style={{color:varColor(variance)}}>{variance>=0?'+':''}{fmt$(variance)}</div>}
                                  {actual===null&&bVal===null&&<span className={styles.dash}>—</span>}
                                </td>
                              )
                            }

                            return (
                              <td key={mo} className={`${styles.dataCell} ${!isLocked?styles.dataCellEditable:''}`}
                                onClick={()=>!isLocked&&setEditingCell({key:line.key,mo})}>
                                {isEditing && !isLocked ? (
                                  <input autoFocus className={styles.cellInput}
                                    defaultValue={bVal ?? ''}
                                    onBlur={e=>{handleCellEdit(line.key,mo,e.target.value);setEditingCell(null)}}
                                    onKeyDown={e=>{if(e.key==='Enter'||e.key==='Tab'){handleCellEdit(line.key,mo,e.target.value);setEditingCell(null)}}}
                                  />
                                ) : bVal !== null ? (
                                  <span style={{color:line.highlight?(bVal>=0?'#059669':'#dc2626'):showScenario&&scenarioGFS!==0?'#7c3aed':undefined}}>
                                    {fmt$(bVal)}
                                  </span>
                                ) : (
                                  <span className={styles.dash}>{!isLocked?<span className={styles.emptyCell}>—</span>:'—'}</span>
                                )}
                              </td>
                            )
                          })}
                          <td className={styles.annualCell} style={{color:line.highlight?(annualVal>=0?'#059669':'#dc2626'):showScenario&&scenarioGFS!==0?'#7c3aed':undefined}}>
                            {fmt$(annualVal)}
                          </td>
                          <td className={styles.pctCell}>{line.gfsBase?'100%':fmtPct(annualVal,annualGFS)}</td>
                        </tr>
                      )
                    })}
                  </>
                ))}
              </tbody>
            </table>
          </div>

          {/* Rolling forecast footer */}
          {projectedFullYearGFS > 0 && (
            <div className={styles.forecastFooter}>
              <TrendingUp size={14} style={{color:'#7c3aed'}}/>
              <span className={styles.forecastText}>
                Rolling forecast based on {currentMo} months of actuals:
                <strong> Full-year GFS ≈ {fmt$(projectedFullYearGFS)}</strong>
                <span style={{color: forecastVsBudget >= 0 ? '#059669' : '#dc2626', marginLeft:8}}>
                  ({forecastVsBudget >= 0 ? '▲' : '▼'} {fmt$(Math.abs(forecastVsBudget))} vs budget)
                </span>
              </span>
            </div>
          )}
        </>
      )}
    </div>
  )
}