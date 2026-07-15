import SubCafeBar from '@/components/ui/SubCafePrompt'
import { useState, useMemo, useEffect, Fragment } from 'react'
import { useToast } from '@/components/ui/Toast'
import AllLocationsGrid from '@/components/AllLocationsGrid'
import { Upload, Download, CheckCircle, Clock, AlertCircle, RefreshCw, Plus, ChevronRight, ChevronDown } from 'lucide-react'
import { useLocations } from '@/store/LocationContext'
import { useAuthStore } from '@/store/authStore'
import { usePeriod } from '@/store/PeriodContext'
import { readPeriodClose, computeOnsiteLabor, computeLaborBurden, getLaborRates } from '@/lib/pnl'
import { writeLaborPnL } from '@/lib/pnl'
import { useLedgerEnrichedPnL } from '@/lib/usePnL'
import CafeLaborImport from '@/components/CafeLaborImport'
import { db } from '@/lib/firebase'
import {
  doc, getDoc, collection, addDoc, updateDoc,
  query, where, orderBy, limit, getDocs, serverTimestamp
} from 'firebase/firestore'
import styles from './LaborPlanner.module.css'
import { useAutosave } from '@/hooks/useAutosave'
import SaveStatusBar from '@/components/SaveStatusBar'

const PERIOD_OPTS = ['Weekly', 'Monthly', 'Period to date']

const INTEGRATIONS = [
  { key: '7shifts', label: '7shifts' },
  { key: 'adp',     label: 'ADP'    },
  { key: 'gusto',   label: 'Gusto'  },
]

const DEFAULT_GL_MAP = {
  '50410': { label: 'Onsite Labor (Fooda) Salaries and Wages', section: 'Location Costs' },
  '50411': { label: '401k',                 section: 'Location Costs' },
  '50412': { label: 'Benefits',             section: 'Location Costs' },
  '50413': { label: 'Payroll Taxes',        section: 'Location Costs' },
  '50414': { label: 'Bonus',                section: 'Location Costs' },
  '50420': { label: '3rd Party Labor',      section: 'Location Costs' },
  '68011': { label: 'Contractors (1099)',   section: 'Comp & Benefits' },
  '68014': { label: 'Payroll Processing',   section: 'Comp & Benefits' },
  '68015': { label: 'Workers Comp',         section: 'Comp & Benefits' },
  '68016': { label: 'Salary Expense',       section: 'Comp & Benefits' },
  '68017': { label: 'Labor Subsidy',        section: 'Comp & Benefits' },
  '68018': { label: 'Payroll Tax',          section: 'Comp & Benefits' },
  '68019': { label: 'Retirement',           section: 'Comp & Benefits' },
  '68020': { label: 'Benefits Expense',     section: 'Comp & Benefits' },
  '68021': { label: 'Bonus Expense',        section: 'Comp & Benefits' },
  '68022': { label: 'Delivery Bonus',       section: 'Comp & Benefits' },
  '68023': { label: 'Employee Tax Credit',  section: 'Comp & Benefits' },
  '68024': { label: 'Severance',            section: 'Comp & Benefits' },
}

function fmt(n) {
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}
function pct(n, base) {
  if (!base || base === 0) return '—'
  return ((n / base) * 100).toFixed(1) + '%'
}
function varianceCls(v) {
  if (v > 0) return styles.varOver
  if (v < 0) return styles.varUnder
  return styles.varNeutral
}
function varianceArrow(v) {
  if (v > 0) return `▲ +$${fmt(v)}`
  if (v < 0) return `▼ ($${fmt(Math.abs(v))})`
  return '—'
}

export default function LaborPlanner() {
  const toast = useToast()
  const { user } = useAuthStore()
  const orgId = user?.tenantId
  const { selectedLocation, setSelectedLocation , isParentLocation , getParentName } = useLocations()
  const location = selectedLocation === 'all' ? null : selectedLocation

  // ── Fix 1: use periodKey from PeriodContext ──────────────────
  const { periodKey } = usePeriod()

  const [periodView, setPeriodView]   = useState('Weekly')
  const [rows, setRows]               = useState([])
  const [pnl, setPnl]                 = useState({})
  const [source, setSource]           = useState('')
  const [importedAt, setImportedAt]   = useState(null)
  const [importedBy, setImportedBy]   = useState('')
  const [approvalStatus, setApproval] = useState(null)

  const [periodClosed, setPeriodClosed] = useState(false)
  const [dirty, setDirty] = useState(false)

  // Manual entry: update (or promote) a GL row's amount in `rows`. Works for
  // imported rows, glMap defaults, and unmapped GLs. Marks the tab dirty so
  // autosave picks it up. Same `rows` shape import produces -> same save/P&L.
  function setAmount(gl, value) {
    const num = parseFloat(String(value).replace(/[$,\s]/g, ''))
    const amount = isNaN(num) ? 0 : num
    setRows(prev => {
      const exists = prev.some(r => r.gl === gl)
      if (exists) return prev.map(r => r.gl === gl ? { ...r, amount } : r)
      const cfg = glMap[gl] || {}
      return [...prev, { gl, label: cfg.label || gl, section: cfg.section || 'Other', amount }]
    })
    setDirty(true)
  }

  // Spreadsheet-style keyboard nav between Actual inputs. Enter/ArrowDown moves
  // to the next GL input, ArrowUp to the previous. Uses DOM order of the
  // data-labor-gl inputs so it works across both sections seamlessly.
  function handleLaborKeyDown(e) {
    if (e.key !== 'Enter' && e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    const inputs = Array.from(document.querySelectorAll('input[data-labor-gl]'))
    const idx = inputs.indexOf(e.target)
    if (idx === -1) return
    const next = (e.key === 'ArrowUp') ? idx - 1 : idx + 1
    if (next >= 0 && next < inputs.length) {
      e.preventDefault()
      inputs[next].focus()
      inputs[next].select()
    }
  }

  // Draft save for manual entry: writes the current rows to a laborSubmissions
  // doc (same shape import produces) and posts to P&L. Create-or-update so
  // autosave doesn't spawn a new submission per keystroke. Status stays
  // 'pending' so manual entries enter the approval queue like imports do.
  async function saveLabor() {
    if (!location) return false
    if (approvalStatus === 'approved') return false
    try {
      const name = user?.name || user?.email || 'unknown'
      const payload = {
        period:     periodKey,
        location:   location,
        glRows:     rows,
        importedBy: name,
        status:     'pending',
        updatedAt:  serverTimestamp(),
      }
      if (submissionId) {
        await updateDoc(doc(db, 'tenants', orgId, 'laborSubmissions', submissionId), payload)
      } else {
        const ref = await addDoc(collection(db, 'tenants', orgId, 'laborSubmissions'), { ...payload, createdAt: serverTimestamp() })
        setSubmissionId(ref.id)
      }
      const onsiteLabor  = rows.filter(r => r.gl?.startsWith('504') && r.gl !== '50420').reduce((sum, r) => sum + r.amount, 0)
      const thirdParty   = rows.find(r => r.gl === '50420')?.amount || 0
      const compBenefits = rows.filter(r => r.gl?.startsWith('68')).reduce((sum, r) => sum + r.amount, 0)
      await writeLaborPnL(location, periodKey, { onsiteLabor, thirdParty, compBenefits, glRows: rows })
      if (approvalStatus !== 'pending') setApproval('pending')
      setDirty(false)
      return true
    } catch (e) {
      console.error('Labor save failed:', e)
      return false
    }
  }

  // Shared autosave lifecycle: debounce + page-exit flush + location-switch
  // flush + status badge. saveLabor is the draft-save; enabled while editable.
  const { autoSaveStatus, lastSavedAt } = useAutosave({
    dirty,
    save: saveLabor,
    enabled: approvalStatus !== 'approved' && !periodClosed,
    flushKey: location,
  })
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
        const oid = user?.tenantId
        const ref = fbDoc(db, 'tenants', oid, 'laborClose', `${(selectedLocation||'').replace(/[^a-zA-Z0-9]/g,'_')}-${periodKey}`)
        const snap = await getDoc(ref)
        if (snap.exists()) setTabClosed(true)
      } catch {}
    })()
  }, [selectedLocation, periodKey])

  // ── CANONICAL labor total — the SAME helpers the Dashboard uses, on the same
  // ledger-enriched pnl (salary FJE + Café hourly + legacy + derived burden). The
  // tab's headline now equals the Dashboard's for the same (location, period).
  // `rows` (laborSubmissions) stays only as the manual GL-submission working state
  // (save payload + Comp & Benefits detail), never as a displayed labor total.
  const { data: enrichedPnl } = useLedgerEnrichedPnL(location, periodKey)
  const canonicalLabor = computeOnsiteLabor(enrichedPnl)           // == Dashboard "Total Onsite Labor"
  const lborBurden = computeLaborBurden(enrichedPnl?.cogs_labor_salaries, enrichedPnl?.cogs_onsite_labor_hourly)
  const burdenCost  = (lborBurden.cogs_labor_taxes || 0) + (lborBurden.cogs_labor_benefits || 0) + (lborBurden.cogs_labor_401k || 0) + (lborBurden.cogs_labor_bonus || 0)
  const thirdCost   = Number(enrichedPnl?.cogs_3rd_party) || 0
  const wagesCost   = canonicalLabor - burdenCost - thirdCost      // residual → breakdown always sums to the total, whether or not legacy cogs_onsite_labor is still in the cost sum

  // The 50410 combined line's two components (salary JE vs Café hourly) — shown as an
  // on-demand expand under the 50410 GL row rather than a separate breakdown block.
  const salariesActual = Number(enrichedPnl?.cogs_labor_salaries) || 0
  const hourlyActual   = Number(enrichedPnl?.cogs_onsite_labor_hourly) || 0

  const gfsTotal = pnl?.gfs_total || enrichedPnl?.gfs_total || 0
  const laborPct = gfsTotal > 0 ? (canonicalLabor / gfsTotal) * 100 : 0
  const laborOverBudget = pnl?.budget_labor && canonicalLabor > pnl.budget_labor
  const laborBudgetVar = pnl?.budget_labor ? ((canonicalLabor / pnl.budget_labor - 1) * 100).toFixed(1) : null


  async function handleCloseTab() {
    if (!selectedLocation || selectedLocation === 'all') return
    if (!window.confirm(`Close Labor for ${periodKey}?`)) return
    try {
      const { setDoc, doc: fbDoc, serverTimestamp } = await import('firebase/firestore')
      const oid = user?.tenantId
      await setDoc(fbDoc(db, 'tenants', oid, 'laborClose', `${(selectedLocation||'').replace(/[^a-zA-Z0-9]/g,'_')}-${periodKey}`), {
        location: selectedLocation, period: periodKey,
        closedBy: user?.name || user?.email, closedAt: serverTimestamp(),
      })
      const { writePnL: wp } = await import('@/lib/pnl')
      await wp(selectedLocation, periodKey, { source_labor: 'closed' })
      setTabClosed(true)
      toast.success('Labor closed for ' + periodKey)
    } catch (err) {
      toast.error('Failed: ' + (err.message || ''))
    }
  }

  const [submissionId, setSubmissionId] = useState(null)
  const [rejectedReason, setRejectedReason] = useState('')
  const [glMap, setGlMap]             = useState(DEFAULT_GL_MAP)
  const [cafeFile, setCafeFile]       = useState(null)   // a detected Café file handed to CafeLaborImport
  const [detecting, setDetecting]     = useState(false)  // peeking a picked file's headers
  const [showLaborSplit, setShowLaborSplit] = useState(false)  // expand the 50410 row into salary vs hourly
  const [budgets, setBudgets]         = useState({})
  const [gfsSales, setGfsSales]       = useState(0)
  const [connectedIntegrations, setConnectedIntegrations] = useState({ '7shifts': true, adp: false, gusto: false })
  const [syncing, setSyncing]         = useState(false)

  // ── Fix 2: reject modal state ────────────────────────────────
  const [showRejectModal, setShowRejectModal] = useState(false)
  const [rejectNote, setRejectNote]           = useState('')

  // Reload when period changes
  useEffect(() => {
    async function loadOrgConfig() {
      try {
        const snap = await getDoc(doc(db, 'tenants', orgId, 'config', 'laborGlMap'))
        if (snap.exists()) setGlMap(snap.data())
      } catch { /* fall back to default */ }
    }
    async function loadBudgets() {
      // Read labor budgets from the P&L doc where the Budgets approval flow
      // writes them (budget_cogs_labor_* keys). Map back to GL codes so the
      // per-row Budget column can look up budgets[r.gl].
      // Post-pilot: extract to a shared glLookup.js and add 68000-range codes
      // once they're included in the budget upload Excel.
      const GL_TO_PNL_BUDGET_KEY = {
        '50410': 'budget_cogs_labor_salaries',
        '50411': 'budget_cogs_labor_401k',
        '50412': 'budget_cogs_labor_benefits',
        '50413': 'budget_cogs_labor_taxes',
        '50414': 'budget_cogs_labor_bonus',
      }
      try {
        const locKey = location || 'all'
        const snap = await getDoc(doc(db, 'tenants', orgId, 'pnl', locKey, 'periods', periodKey))
        if (!snap.exists()) return
        const pnlData = snap.data() || {}
        setPnl(pnlData)
        const pnl = pnlData
        const budgetLaborKeys = Object.keys(pnl).filter(k => k.startsWith('budget_cogs_labor') || k.startsWith('budget_labor'))
        const glBudgets = {}
        for (const [gl, pnlKey] of Object.entries(GL_TO_PNL_BUDGET_KEY)) {
          const v = pnl[pnlKey]
          if (typeof v === 'number' && v !== 0) glBudgets[gl] = v
        }
        setBudgets(glBudgets)
      } catch { /* no budgets yet */ }
    }
    async function loadGFS() {
      try {
        const locKey = location || 'all'
        const snap = await getDoc(doc(db, 'tenants', orgId, 'pnl', locKey, 'periods', periodKey))
        if (snap.exists()) setGfsSales(snap.data().gfs_total || 0)
      } catch { /* no sales yet */ }
    }
    async function loadIntegrations() {
      try {
        const snap = await getDoc(doc(db, 'tenants', orgId, 'config', 'integrations'))
        if (snap.exists()) setConnectedIntegrations(snap.data())
      } catch { /* defaults */ }
    }
    async function loadPendingSubmission() {
      try {
        const q = query(
          collection(db, 'tenants', orgId, 'laborSubmissions'),
          where('period', '==', periodKey),
          where('location', '==', location || 'all'),
        )
        const snap = await getDocs(q)
        if (!snap.empty) {
          // Get the most recent submission
          const sorted = snap.docs.sort((a, b) => (b.data().createdAt?.seconds || 0) - (a.data().createdAt?.seconds || 0))
          const d = sorted[0].data()
          setSubmissionId(sorted[0].id)
          setRows(d.glRows || [])
          setSource(d.fileName || '')
          setImportedBy(d.importedBy || '')
          setImportedAt(d.createdAt?.toDate() || null)
          // A 'reopened' submission is no longer a lock — treat as editable.
          setApproval(d.status === 'reopened' ? null : d.status)
          setRejectedReason(d.rejectNote || '')
        } else {
          // Clear state when switching to a period with no submission
          setRows([])
          setSource('')
          setImportedAt(null)
          setImportedBy('')
          setApproval(null)
          setSubmissionId(null)
          setRejectedReason('')
        }
      } catch { /* no existing */ }
    }
    loadOrgConfig()
    loadBudgets()
    loadGFS()
    loadIntegrations()
    loadPendingSubmission()
  }, [orgId, periodKey, location]) // re-runs when period changes

  // Peek a picked file's first ~20 rows and classify it. The two labor formats are
  // DISJOINT: Café has "Week of Event" / "Actual Labor $" columns; the GL report has
  // "GL Code"/"Amount" headers, a Mosaic "50410 - …" first cell, or raw 5-digit GL
  // rows. Returns { type: 'cafe' | 'gl' | null, headers }.
  async function detectLaborFile(file) {
    const XLSX = await import('xlsx')
    const ab   = await file.arrayBuffer()
    const wb   = XLSX.read(new Uint8Array(ab), { type: 'array' })
    const sheetName = wb.SheetNames.find(s => /labor|payroll|hours|site|summary/i.test(s)) || wb.SheetNames[0]
    const aoa  = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, raw: false, blankrows: false })
    const scan = aoa.slice(0, 20)                                   // the header lives in the first rows
    const cells = scan.flat().map(c => String(c ?? '').trim())
    const lower = cells.map(c => c.toLowerCase())
    const hasCell = (s) => lower.some(c => c === s || c.includes(s))
    // Café first (disjoint markers) — "Actual Labor" covers both the $ and hours cols.
    if (hasCell('week of event') || hasCell('actual labor')) return { type: 'cafe' }
    // GL report: explicit headers, or a 5-digit GL in the first cell of any scanned row.
    const firstCells = scan.map(r => String(r?.[0] ?? '').trim())
    const glLike = (c) => /^\d{5}\s*[-–—]/.test(c) || /^\d{5}\s+\S/.test(c) || /^\d{5}$/.test(c)
    if (hasCell('gl code') || lower.some(c => c === 'amount') || firstCells.some(glLike)) return { type: 'gl' }
    return { type: null, headers: cells.filter(Boolean).slice(0, 12) }
  }

  // The ONE "Import Labor" front door: detect, then route to each format's OWN
  // existing preview/flow (Café's self-contained modal, or the GL grid submission).
  async function handleLaborImportPick(e) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setDetecting(true)
    try {
      const { type, headers } = await detectLaborFile(file)
      if (type === 'cafe') {
        setCafeFile(file)                                          // → CafeLaborImport (controlled)
      } else if (type === 'gl') {
        await handleImport({ target: { files: [file], value: '' } })  // → GL grid flow (event-like)
      } else {
        toast.error(`Not a recognized labor file — expected the Cafe Labor Efficiency export (Week of Event / Actual Labor $) or a GL labor report (GL Code / Amount, or "50410 - …"). Found headers: ${headers.join(', ') || '(none)'}`)
      }
    } catch (err) {
      toast.error('Could not read the file — ' + (err?.message || ''))
    }
    setDetecting(false)
  }

  async function handleImport(e) {
    const file = e.target.files[0]
    if (!file) return

    // Block re-import if period is already approved
    if (approvalStatus === 'approved') {
      toast.error('This period is already approved. Unlock it before re-importing.')
      e.target.value = ''
      return
    }

    // Warn if re-importing over a pending submission
    if (approvalStatus === 'pending') {
      const ok = window.confirm('A pending submission exists for this period. Replace it?')
      if (!ok) { e.target.value = ''; return }
    }

    try {
      const XLSX = await import('xlsx')
      const ab   = await file.arrayBuffer()
      const wb   = XLSX.read(new Uint8Array(ab), { type: 'array' })
      // Managers may upload the whole multi-sheet workbook — prefer a sheet whose
      // name looks like labor/payroll/hours; fall back to the first sheet. A wrong
      // sheet is caught by the zero-rows-parsed guard below.
      const sheetName = wb.SheetNames.find(s => /labor|payroll|hours/i.test(s)) || wb.SheetNames[0]
      const ws   = wb.Sheets[sheetName]
      const data = XLSX.utils.sheet_to_json(ws, { raw: false })

      const parsed = []
      // Try standard column-based format first
      const firstRow = data[0] || {}
      const hasGLCol = firstRow['GL Code'] || firstRow['GL'] || firstRow['Account'] || firstRow['gl_code']
      const hasAmtCol = firstRow['Amount'] || firstRow['amount'] || firstRow['Value'] || firstRow['value']

      if (hasGLCol || hasAmtCol) {
        // Standard format: GL Code | Amount | Description columns
        data.forEach(row => {
          const glRaw = String(row['GL Code'] || row['GL'] || row['Account'] || row['gl_code'] || '').trim()
          const gl    = Object.keys(glMap).find(k => glRaw.includes(k))
          const amount = parseFloat(String(row['Amount'] || row['amount'] || row['Value'] || row['value'] || 0).replace(/[,$()]/g, ''))
          const desc   = row['Description'] || row['description'] || row['Desc'] || glMap[gl]?.label || glRaw
          if (glRaw || amount) {
            parsed.push({ gl: gl || glRaw, label: desc, amount, section: glMap[gl]?.section || 'Other' })
          }
        })
      } else {
        // Mosaic format: first column is "50410 - Description", second column is amount
        // Also handles cases where GL code and description are in the same cell
        const cols = Object.keys(firstRow)
        data.forEach(row => {
          const firstVal = String(row[cols[0]] || '').trim()
          // Skip header/total rows
          if (!firstVal || firstVal.toLowerCase().includes('total') || firstVal.toLowerCase().includes('compensation and benefits')) return
          // Extract GL code from start of string (e.g. "50410 - Onsite Labor...")
          const glMatch = firstVal.match(/^(\d{5})\s*[-–—]\s*(.+)/)
          if (!glMatch) {
            // Try without dash: "50410 Onsite Labor..."
            const glMatch2 = firstVal.match(/^(\d{5})\s+(.+)/)
            if (!glMatch2) return
            const gl = glMatch2[1]
            const desc = glMatch2[2].trim()
            // Amount is in the second column or any subsequent column
            let amount = 0
            for (let ci = 1; ci < cols.length; ci++) {
              const v = parseFloat(String(row[cols[ci]] || '0').replace(/[,$()]/g, ''))
              if (!isNaN(v) && v !== 0) { amount = v; break }
            }
            if (glMap[gl] || amount) {
              parsed.push({ gl, label: glMap[gl]?.label || desc, amount, section: glMap[gl]?.section || 'Other' })
            }
            return
          }
          const gl = glMatch[1]
          const desc = glMatch[2].trim()
          // Amount from second column or any subsequent column
          let amount = 0
          for (let ci = 1; ci < cols.length; ci++) {
            const v = parseFloat(String(row[cols[ci]] || '0').replace(/[,$()]/g, ''))
            if (!isNaN(v) && v !== 0) { amount = v; break }
          }
          if (glMap[gl] || amount) {
            parsed.push({ gl, label: glMap[gl]?.label || desc, amount, section: glMap[gl]?.section || 'Other' })
          }
        })
      }

      // Also handle the case where data came as raw rows (no headers)
      // by checking if we parsed anything
      if (parsed.length === 0) {
        // Try raw approach: scan all rows for GL code patterns
        const rawData = XLSX.utils.sheet_to_json(ws, { header: 1 })
        rawData.forEach(row => {
          if (!Array.isArray(row) || row.length < 2) return
          const cell0 = String(row[0] || '').trim()
          const glMatch = cell0.match(/^(\d{5})\s*[-–—]?\s*(.*)/)
          if (!glMatch) return
          const gl = glMatch[1]
          const desc = (glMatch[2] || '').trim()
          const amount = parseFloat(String(row[1] || '0').replace(/[,$()]/g, ''))
          if (glMap[gl] || amount) {
            parsed.push({ gl, label: glMap[gl]?.label || desc || gl, amount, section: glMap[gl]?.section || 'Other' })
          }
        })
      }

      // Fail-loud on a wrong sheet: no GL-code/amount rows parsed means we read a
      // cover page / summary, not the labor data. Reject BEFORE writing a submission
      // or posting $0 to P&L, naming the sheet read and listing the file's tabs.
      if (parsed.length === 0) {
        toast.error(
          `Couldn't find labor data on sheet "${sheetName}". Sheets in this file: ${wb.SheetNames.join(', ')}. ` +
          `Aurelia looks for GL code + amount columns (e.g. "GL Code" and "Amount", or a Mosaic "50410 - …" layout).`
        )
        e.target.value = ''
        return
      }

      const now  = new Date()
      const name = user?.name || user?.email || 'Unknown'

      const submissionRef = await addDoc(collection(db, 'tenants', orgId, 'laborSubmissions'), {
        period:     periodKey,
        fileName:   file.name,
        glRows:     parsed,
        importedBy: name,
        status:     'pending',
        createdAt:  serverTimestamp(),
        location:   location || 'all',
      })

      setRows(parsed)
      setSource(file.name)
      setImportedAt(now)
      setImportedBy(name)
      setApproval('pending')
      setSubmissionId(submissionRef.id)
      setRejectedReason('')

      // Post to P&L immediately on import so labor is visible right away.
      // Director approval is the separate week-level sign-off; it does not
      // gate P&L visibility.
      if (location) {
        try {
          const onsiteLabor  = parsed.filter(r => r.gl?.startsWith('504') && r.gl !== '50420').reduce((sum, r) => sum + r.amount, 0)
          const thirdParty   = parsed.find(r => r.gl === '50420')?.amount || 0
          const compBenefits = parsed.filter(r => r.gl?.startsWith('68')).reduce((sum, r) => sum + r.amount, 0)
          await writeLaborPnL(location, periodKey, { onsiteLabor, thirdParty, compBenefits, glRows: parsed })
        } catch (pnlErr) {
          console.error('Failed to post labor to P&L on import:', pnlErr)
        }
      }

      toast.success(`Imported ${parsed.length} GL lines and posted to P&L — pending director sign-off to close the week`)
    } catch (err) {
      console.error(err)
      toast.error('Import failed. Please check the file format.')
    }
    e.target.value = ''
  }

  async function handleApprove() {
    if (!submissionId) return
    try {
      await updateDoc(doc(db, 'tenants', orgId, 'laborSubmissions', submissionId), {
        status:     'approved',
        approvedBy: user?.name || user?.email,
        approvedAt: serverTimestamp(),
      })
      if (location) {
        const onsiteLabor  = rows.filter(r => r.gl?.startsWith('504') && r.gl !== '50420').reduce((s, r) => s + r.amount, 0)
        const thirdParty   = rows.find(r => r.gl === '50420')?.amount || 0
        const compBenefits = rows.filter(r => r.gl?.startsWith('68')).reduce((s, r) => s + r.amount, 0)
        await writeLaborPnL(location, periodKey, { onsiteLabor, thirdParty, compBenefits, glRows: rows })
      }
      setApproval('approved')
      toast.success('Labor approved — week signed off and locked')
    } catch {
      toast.error('Approval failed — please try again')
    }
  }

  // ── Fix 2: reject with required note ────────────────────────
  async function handleRejectConfirm() {
    if (!rejectNote.trim()) {
      toast.error('Please enter a reason for rejection')
      return
    }
    if (!submissionId) return
    try {
      await updateDoc(doc(db, 'tenants', orgId, 'laborSubmissions', submissionId), {
        status:     'rejected',
        rejectedBy: user?.name || user?.email,
        rejectedAt: serverTimestamp(),
        rejectNote: rejectNote.trim(),
      })
      setApproval('rejected')
      setRejectedReason(rejectNote.trim())
      setShowRejectModal(false)
      setRejectNote('')
      toast.success('Submission rejected')
    } catch {
      toast.error('Action failed')
    }
  }

  async function handleSync(integrationKey) {
    setSyncing(true)
    toast.success(`Syncing from ${integrationKey}… (integration coming soon)`)
    setTimeout(() => setSyncing(false), 1500)
  }

  function exportCSV() {
    const csv = [
      ['GL Code', 'Description', 'Section', 'Actual', 'Budget', 'Variance', '% of GFS'],
      ...rows.map(r => {
        const bud = budgets[r.gl] || 0
        const v   = r.amount - bud
        return [r.gl, r.label, r.section, r.amount.toFixed(2), bud.toFixed(2), v.toFixed(2), pct(r.amount, gfsSales)]
      }),
    ].map(r => r.map(v => `"${v}"`).join(',')).join('\n')
    const blob = new Blob([csv], { type: 'text/csv' })
    const url  = URL.createObjectURL(blob)
    Object.assign(document.createElement('a'), { href: url, download: `labor-${periodKey}.csv` }).click()
    URL.revokeObjectURL(url)
  }

  // Always render the full GL chart of accounts as an editable surface.
  // Start from glMap (every GL line), then merge in any amount the user has
  // typed or imported (tracked in `rows`). This removes the old shell/empty
  // dead-end: there's always a table to type into or import over.
  const displayRows = useMemo(() => {
    const byGl = {}
    rows.forEach(r => { if (r.gl) byGl[r.gl] = r })
    // Preserve any imported rows whose GL isn't in glMap (custom/unmapped).
    const extraRows = rows.filter(r => r.gl && !glMap[r.gl])
    // The Location Costs labor lines are sourced from the SAME enriched P&L as the
    // KPIs — NOT the stale laborSubmissions rows — reading the exact fields
    // computeOnsiteLabor sums, so the section total equals the Total Labor KPI by
    // construction. Each is derived/owned elsewhere (salaries=salary JE, burden=
    // computeLaborBurden via enrichPnLLabor, hourly=Café import, 3rd=3rd-party JE),
    // so these rows are READ-ONLY here — this is the f4434cb P&L-statement fix
    // applied to the Labor tab's GL grid, which was a separate stale component.
    // GL 50410 is ONE chart-of-accounts line holding BOTH salaried and hourly wages,
    // so the row combines them for DISPLAY (fields stay separate underneath: salary
    // JE vs Café import, different writers — merging fields would clobber). The rest
    // are their own GL lines.
    const laborActuals = {
      '50410': (Number(enrichedPnl?.cogs_labor_salaries) || 0)
             + (Number(enrichedPnl?.cogs_onsite_labor_hourly) || 0),  // salaries + hourly (GL 50410)
      '50411': Number(enrichedPnl?.cogs_labor_401k) || 0,       // derived burden
      '50412': Number(enrichedPnl?.cogs_labor_benefits) || 0,   // derived burden
      '50413': Number(enrichedPnl?.cogs_labor_taxes) || 0,      // derived burden
      '50414': Number(enrichedPnl?.cogs_labor_bonus) || 0,      // derived burden
      '50420': Number(enrichedPnl?.cogs_3rd_party) || 0,        // 3rd-party (GL 50420)
    }
    const mapped = Object.entries(glMap).map(([gl, cfg]) => (
      gl in laborActuals
        ? { gl, label: byGl[gl]?.label || cfg.label, section: cfg.section, amount: laborActuals[gl], derived: true }
        : { gl, label: byGl[gl]?.label || cfg.label, section: byGl[gl]?.section || cfg.section, amount: byGl[gl]?.amount || 0 }
    ))
    return [...mapped, ...extraRows]
  }, [rows, glMap, enrichedPnl])
  const sections = useMemo(() => {
    const s = {}
    displayRows.forEach(r => {
      // Value-driven rows (68xxx Comp & Benefits, imported extras) display ONLY once
      // they carry a real value — from a JE to that GL or the monthly GL-report upload.
      // Zero/empty is never shown. Core labor lines (r.derived: 50410 / 50411-50414
      // burden / 50420) ALWAYS show, even at $0, so the labor structure stays visible.
      const visible = r.derived || Math.abs(r.amount || 0) > 0.005
      if (!visible) return
      if (!s[r.section]) s[r.section] = []
      s[r.section].push(r)
    })
    // A section with no visible rows (e.g. all-zero Comp & Benefits) drops out entirely
    // — header and total hidden — because it never gets a key here.
    return s
  }, [displayRows, budgets])

  // All labor totals read the SAME enriched basis as the section grid (displayRows:
  // Location Costs sourced from computeOnsiteLabor/derived burden, Comp & Benefits from
  // 68xxx) — NOT the stale `rows` (laborSubmissions), which is empty for Café/JE-sourced
  // locations. So grandTotal == the sum of every section's secActual == the Total Labor
  // KPI, by construction, and can never diverge from what's shown above it.
  const totalOnsite   = displayRows.filter(r => r.gl?.startsWith('504') && r.gl !== '50420').reduce((s, r) => s + r.amount, 0)
  const total3rd      = displayRows.find(r => r.gl === '50420')?.amount || 0
  const totalBenTax   = displayRows.filter(r => r.gl?.startsWith('68')).reduce((s, r) => s + r.amount, 0)
  const grandTotal    = displayRows.reduce((s, r) => s + r.amount, 0)
  const budgetTotal   = displayRows.reduce((s, r) => s + (budgets[r.gl] || 0), 0)
  const grandVariance = grandTotal - budgetTotal   // both displayRows-based — consistent

  const importedAtStr = importedAt
    ? importedAt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) +
      ' at ' + importedAt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
    : null

  const isDirector = /^(admin|director)$/i.test(user?.role || '')

  if (!selectedLocation || selectedLocation === 'all') return (
    <AllLocationsGrid
      title="Labor"
      subtitle="Select a location to view labor data"
      onSelectLocation={name => setSelectedLocation(name)}
    />
  )

  return (
    <div className={styles.page}>



      {/* ── Sub-cafe selector ── */}
      {isParentLocation?.(selectedLocation) && (
        <div style={{ marginBottom: 16 }}>
          <SubCafeBar parentName={selectedLocation} activeSubCafe={null} />
        </div>
      )}
      {getParentName?.(selectedLocation) && (
        <div style={{ marginBottom: 16 }}>
          <SubCafeBar parentName={getParentName(selectedLocation)} activeSubCafe={selectedLocation} />
        </div>
      )}

      {gfsTotal > 0 && (
        <div style={{
          padding: '12px 18px', marginBottom: 16, borderRadius: 10,
          background: '#f8fafc', border: '1px solid #e2e8f0',
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        }}>
          <div style={{ fontSize: 13, color: '#475569' }}>
            <span style={{ fontWeight: 600 }}>Labor:</span> {laborPct.toFixed(1)}% of GFS
            {/* Real comparison kept: labor vs the approved budget. No invented % target. */}
            {laborOverBudget && <span style={{ color: '#b45309' }}> · {laborBudgetVar}% over budget</span>}
          </div>
        </div>
      )}

      {/* ── Header ── */}
      <div className={styles.header}>
        <div>
          <h1 className={styles.title}>Labor Costs</h1>
          <p className={styles.subtitle}>
            {source
              ? `${periodKey} · Imported: ${source}`
              : `${periodKey} · No data loaded · Import a GL labor report or sync a connected integration`}
          </p>
        </div>
        <div className={styles.actions}>
          {rows.length > 0 && (
            <button className={styles.btnIcon} onClick={exportCSV} title="Export CSV">
              <Download size={15} />
            </button>
          )}
          {/* ONE front door: auto-detects Café (multi-site/period hourly) vs GL report
              (single-location grid) and routes to each format's own preview/flow. Not
              gated on approval — a GL re-import is blocked inside handleImport, while a
              Café import is location-independent and stays available. */}
          <label className={styles.btnImport}>
            <Upload size={14} /> {detecting ? 'Reading…' : 'Import Labor'}
            <input type="file" accept=".csv,.xlsx,.xls" style={{ display: 'none' }} onChange={handleLaborImportPick} disabled={detecting} />
          </label>
          <CafeLaborImport file={cafeFile} onDone={() => setCafeFile(null)} />
          {rows.length > 0 && approvalStatus !== 'approved' && (
            <button className={styles.btnClear} onClick={() => { setRows([]); setSource(''); setApproval(null); setSubmissionId(null) }}>
              Clear
            </button>
          )}
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
              {importedAtStr ? `Imported ${importedAtStr} by ${importedBy} · ` : ''}
              {approvalStatus === 'pending'  && 'Pending director approval before closing'}
              {approvalStatus === 'approved' && 'Approved & closed'}
              {approvalStatus === 'rejected' && `Rejected${rejectedReason ? ` — "${rejectedReason}"` : ''} · Re-import to resubmit`}
            </span>
          </div>
          <div className={styles.statusRight}>
            <span className={`${styles.badge} ${styles['badge_' + approvalStatus]}`}>
              {approvalStatus === 'pending' ? 'Pending approval' : approvalStatus === 'approved' ? 'Approved' : 'Rejected'}
            </span>
            {approvalStatus === 'pending' && isDirector && (
              <>
                <button className={styles.btnApprove} onClick={handleApprove}>Approve &amp; Close</button>
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
            <h3 className={styles.modalTitle}>Reject Labor Submission</h3>
            <p className={styles.modalSub}>Provide a reason so the submitter knows what to fix.</p>
            <textarea
              className={styles.modalTextarea}
              placeholder="e.g. GL 50413 payroll taxes appear doubled — please verify source data"
              value={rejectNote}
              onChange={e => setRejectNote(e.target.value)}
              rows={3}
              autoFocus
            />
            <div className={styles.modalActions}>
              <button className={styles.btnReject} onClick={handleRejectConfirm}>Confirm Rejection</button>
              <button className={styles.btnClear} onClick={() => { setShowRejectModal(false); setRejectNote('') }}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Connected integrations ── */}
      <div className={styles.intBar}>
        <span className={styles.intLabel}>Connected integrations</span>
        <div className={styles.intPills}>
          {INTEGRATIONS.map(i => (
            <div key={i.key} className={`${styles.intPill} ${connectedIntegrations[i.key] ? styles.intConnected : styles.intDisconnected}`}>
              <span className={styles.intDot} />
              {i.label} — {connectedIntegrations[i.key] ? 'connected' : 'not connected'}
              {connectedIntegrations[i.key] && (
                <button className={styles.intSync} onClick={() => handleSync(i.label)} disabled={syncing}>
                  <RefreshCw size={11} />
                </button>
              )}
            </div>
          ))}
          <button className={styles.intAdd}><Plus size={11} /> Add integration</button>
        </div>
      </div>

      {/* ── Period toggle ── */}
      <div className={styles.periodRow}>
        {PERIOD_OPTS.map(p => (
          <button key={p} className={`${styles.periodBtn} ${periodView === p ? styles.periodActive : ''}`} onClick={() => setPeriodView(p)}>
            {p}
          </button>
        ))}
      </div>

      {/* ── KPI bar ── */}
      <div className={styles.kpiBar}>
        {/* Canonical labor via computeOnsiteLabor/computeLaborBurden — equals the Dashboard. */}
        <div className={`${styles.kpi} ${styles.kpiPrimary}`}>
          <div className={styles.kpiL}>Total Labor</div>
          <div className={styles.kpiV}>{canonicalLabor ? `$${fmt(canonicalLabor)}` : '—'}</div>
          <div className={styles.kpiSub}>{canonicalLabor ? pct(canonicalLabor, gfsSales) : '—'} of GFS · matches P&amp;L</div>
          {pnl?.budget_labor > 0 && (
            <div className={`${styles.kpiBadge} ${laborOverBudget ? styles.kpiBadgeOver : styles.kpiBadgeUnder}`}>
              {laborOverBudget ? '▲ Over' : '▼ Under'} budget ${fmt(Math.abs(canonicalLabor - (pnl.budget_labor || 0)))}
            </div>
          )}
        </div>
        <div className={styles.kpi}>
          <div className={styles.kpiL}>Wages (salary + hourly)</div>
          <div className={styles.kpiV}>{canonicalLabor ? `$${fmt(wagesCost)}` : '—'}</div>
          <div className={styles.kpiSub}>{canonicalLabor ? pct(wagesCost, gfsSales) : '—'} of GFS</div>
        </div>
        <div className={styles.kpi}>
          <div className={styles.kpiL}>3rd Party Labor</div>
          <div className={styles.kpiV}>{canonicalLabor ? `$${fmt(thirdCost)}` : '—'}</div>
          <div className={styles.kpiSub}>{canonicalLabor ? pct(thirdCost, gfsSales) : '—'} of GFS</div>
        </div>
        <div className={styles.kpi}>
          <div className={styles.kpiL}>Burden (derived)</div>
          <div className={styles.kpiV}>{canonicalLabor ? `$${fmt(burdenCost)}` : '—'}</div>
          <div className={styles.kpiSub}>tax + benefits + 401k + bonus</div>
        </div>
        <div className={styles.kpi}>
          <div className={styles.kpiL}>GL Lines (detail)</div>
          <div className={styles.kpiV} style={{ color: '#7c3aed' }}>{rows.length || '—'}</div>
          <div className={styles.kpiSub}>{Object.keys(sections).length || '—'} sections</div>
        </div>
      </div>

      {/* ── GL structure shell (no data) or populated table ── */}
      {displayRows.length === 0 ? (
        <div className={styles.tableWrap}>
          {Object.entries(glMap).reduce((acc, [gl, cfg]) => {
            if (!acc[cfg.section]) acc[cfg.section] = []
            acc[cfg.section].push({ gl, ...cfg })
            return acc
          }, {}) && Object.entries(
            Object.entries(glMap).reduce((acc, [gl, cfg]) => {
              if (!acc[cfg.section]) acc[cfg.section] = []
              acc[cfg.section].push({ gl, ...cfg })
              return acc
            }, {})
          ).map(([section, sRows]) => (
            <div key={section}>
              <div className={styles.sectionHeader}>
                <span>{section}</span>
                <span className={styles.sectionHeaderTotal}>—</span>
              </div>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>GL Code</th>
                    <th>Description</th>
                    <th style={{ textAlign: 'right' }}>Actual</th>
                    <th style={{ textAlign: 'right' }}>Budget</th>
                    <th style={{ textAlign: 'right' }}>Variance</th>
                    <th style={{ textAlign: 'right' }}>% of GFS</th>
                  </tr>
                </thead>
                <tbody>
                  {sRows.map((r, i) => (
                    <tr key={i} className={styles.shellRow}>
                      <td className={styles.glCode}>{r.gl}</td>
                      <td className={styles.desc}>{r.label}</td>
                      <td style={{ textAlign: 'right' }} className={styles.shellDash}>—</td>
                      <td style={{ textAlign: 'right' }} className={styles.shellDash}>—</td>
                      <td style={{ textAlign: 'right' }} className={styles.shellDash}>—</td>
                      <td style={{ textAlign: 'right' }} className={styles.shellDash}>—</td>
                    </tr>
                  ))}
                  <tr className={styles.sectionTotal}>
                    <td colSpan={2} style={{ textAlign: 'right', fontWeight: 700, color: '#555' }}>Section Total</td>
                    <td colSpan={4} style={{ textAlign: 'right', color: '#ccc' }}>— Import to populate</td>
                  </tr>
                </tbody>
              </table>
            </div>
          ))}
          <div className={styles.grandTotalRow}>
            <span className={styles.grandTotalLabel}>Total Labor — All Sections</span>
            <div className={styles.grandTotalRight}>
              <span className={styles.grandTotalAmt} style={{ color: '#666' }}>— No data for {periodKey}</span>
            </div>
          </div>
        </div>
      ) : (
        <div className={styles.tableWrap}>
          {Object.entries(sections).map(([section, sRows]) => {
            const secActual   = sRows.reduce((s, r) => s + r.amount, 0)
            const secBudget   = sRows.reduce((s, r) => s + (budgets[r.gl] || 0), 0)
            const secVariance = secActual - secBudget
            return (
              <div key={section}>
                <div className={styles.sectionHeader}>
                  <span>{section}</span>
                  <span className={styles.sectionHeaderTotal}>${fmt(secActual)}</span>
                </div>
                <table className={styles.table}>
                  <thead>
                    <tr>
                      <th>GL Code</th>
                      <th>Description</th>
                      <th style={{ textAlign: 'right' }}>Actual</th>
                      <th style={{ textAlign: 'right' }}>Budget</th>
                      <th style={{ textAlign: 'right' }}>Variance</th>
                      <th style={{ textAlign: 'right' }}>% of GFS</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sRows.map((r, i) => {
                      const bud = budgets[r.gl] || 0
                      const v   = r.amount - bud
                      // GL 50410 is the combined salary+hourly line; let a manager expand
                      // it to see the two components (the one thing the removed breakdown
                      // block showed that this books-view otherwise hides).
                      const is50410 = r.gl === '50410'
                      return (
                        <Fragment key={i}>
                        <tr>
                          <td className={styles.glCode}>{r.gl || '—'}</td>
                          <td className={styles.desc}>
                            {is50410 ? (
                              <button onClick={() => setShowLaborSplit(x => !x)}
                                title="Show salary vs hourly split"
                                style={{ display: 'inline-flex', alignItems: 'center', gap: 4, background: 'none', border: 'none', padding: 0, cursor: 'pointer', font: 'inherit', color: 'inherit' }}>
                                {showLaborSplit ? <ChevronDown size={13} color="#94a3b8" /> : <ChevronRight size={13} color="#94a3b8" />}
                                {r.label}
                              </button>
                            ) : r.label}
                          </td>
                          <td style={{ textAlign: 'right', padding: '4px 8px' }}>
                            {r.derived ? (
                              // Read-only: sourced from the enriched P&L (salary JE / Café /
                              // derived burden / 3rd-party JE), not typed here.
                              <span style={{ fontWeight: 700, color: r.amount > 0 ? '#0f172a' : '#cbd5e1' }} title="Derived from the P&L — edit via a journal entry, the Cafe import, or salary/rates settings">
                                {r.amount > 0 ? `$${fmt(r.amount)}` : '—'}
                              </span>
                            ) : (() => {
                              const locked = approvalStatus === 'approved' || periodClosed
                              const hasVal = r.amount > 0
                              // Three states: empty = plain gray; filled w/ budget = variance
                              // tint (over=red, on/under=green); filled w/o budget = subtle
                              // neutral fill (entry confirmation, matches inventory pattern).
                              const tint = (hasVal && bud)
                                ? (v > 0 ? { bd: '#fca5a5', bg: '#fef2f2' } : { bd: '#86efac', bg: '#f0fdf4' })
                                : hasVal
                                ? { bd: '#cbd5e1', bg: '#f1f5f9' }
                                : { bd: '#e2e8f0', bg: '#f8fafc' }
                              return (
                                <div style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'flex-end', gap: 2 }}>
                                  <span style={{ color: '#94a3b8', fontWeight: 600, fontSize: 12 }}>$</span>
                                  <input
                                    type="text"
                                    inputMode="decimal"
                                    value={r.amount ? String(r.amount) : ''}
                                    onChange={e => setAmount(r.gl, e.target.value)}
                                    placeholder="0"
                                    disabled={locked}
                                    data-labor-gl={r.gl}
                                    onKeyDown={handleLaborKeyDown}
                                    style={{
                                      width: 88, textAlign: 'right', fontWeight: 700,
                                      border: locked ? '1px solid transparent' : `1px solid ${tint.bd}`,
                                      borderRadius: 5,
                                      padding: '4px 6px', fontSize: 13, fontFamily: 'inherit',
                                      background: locked ? 'transparent' : tint.bg,
                                      color: '#0f172a',
                                      cursor: locked ? 'not-allowed' : 'text',
                                      outline: 'none',
                                      transition: 'border-color 0.12s, background 0.12s, box-shadow 0.12s',
                                    }}
                                    onFocus={e => { if (!locked) { e.target.style.borderColor = '#2563eb'; e.target.style.boxShadow = '0 0 0 2px rgba(37,99,235,0.12)' } }}
                                    onBlur={e => { if (!locked) { e.target.style.borderColor = tint.bd } e.target.style.boxShadow = 'none' }}
                                  />
                                </div>
                              )
                            })()}
                          </td>
                          <td style={{ textAlign: 'right', color: '#999' }}>{bud ? `$${fmt(bud)}` : '—'}</td>
                          <td style={{ textAlign: 'right' }}>
                            {bud ? <span className={varianceCls(v)}>{varianceArrow(v)}</span> : <span style={{ color: '#ccc' }}>—</span>}
                          </td>
                          <td style={{ textAlign: 'right', color: '#999' }}>{pct(r.amount, gfsSales)}</td>
                        </tr>
                        {is50410 && showLaborSplit && (
                          [['Salaries & Wages', 'salary JE', salariesActual],
                           ['Hourly (Café actual)', 'timekeeping', hourlyActual]].map(([label, note, val]) => (
                            <tr key={label} style={{ background: '#fafbfc' }}>
                              <td></td>
                              <td style={{ paddingLeft: 30, color: '#64748b', fontSize: 12 }}>
                                {label} <span style={{ color: '#94a3b8' }}>· {note}</span>
                              </td>
                              <td style={{ textAlign: 'right', color: '#64748b', fontSize: 12, fontVariantNumeric: 'tabular-nums', paddingRight: 8 }}>
                                {val > 0 ? `$${fmt(val)}` : '—'}
                              </td>
                              <td colSpan={3}></td>
                            </tr>
                          ))
                        )}
                        </Fragment>
                      )
                    })}
                    <tr className={styles.sectionTotal}>
                      <td colSpan={2} style={{ textAlign: 'right', fontWeight: 700, color: '#555' }}>Section Total</td>
                      <td style={{ textAlign: 'right', fontWeight: 800 }}>${fmt(secActual)}</td>
                      <td style={{ textAlign: 'right', fontWeight: 700, color: '#999' }}>{secBudget ? `$${fmt(secBudget)}` : '—'}</td>
                      <td style={{ textAlign: 'right' }}>
                        {secBudget ? <span className={varianceCls(secVariance)}>{varianceArrow(secVariance)}</span> : '—'}
                      </td>
                      <td style={{ textAlign: 'right', color: '#999' }}>{pct(secActual, gfsSales)}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            )
          })}

          <div className={styles.grandTotalRow}>
            <span className={styles.grandTotalLabel}>Total Labor — All Sections</span>
            <div className={styles.grandTotalRight}>
              {budgetTotal > 0 && (
                <span className={`${styles.grandBudget} ${grandVariance > 0 ? styles.grandOver : styles.grandUnder}`}>
                  Budget: ${fmt(budgetTotal)} &nbsp;·&nbsp;
                  {grandVariance > 0 ? '▲ Over' : '▼ Under'} ${fmt(Math.abs(grandVariance))}
                </span>
              )}
              <span className={styles.grandTotalAmt}>${fmt(grandTotal)}</span>
            </div>
          </div>

          {approvalStatus === 'pending' && isDirector && (
            <div className={styles.approvalFooter}>
              <span className={styles.approvalNote}>
                <Clock size={13} /> Pending your approval before posting to P&L.
              </span>
              <div style={{ display: 'flex', gap: 8 }}>
                <button className={styles.btnApprove} onClick={handleApprove}>Approve &amp; Close Period</button>
                <button className={styles.btnReject} onClick={() => setShowRejectModal(true)}>Reject</button>
              </div>
            </div>
          )}
        </div>
      )}

      <SaveStatusBar
        metricLabel="Total Labor"
        metricValue={`$${fmt(grandTotal)}`}
        autoSaveStatus={autoSaveStatus}
        lastSavedAt={lastSavedAt}
        dirty={dirty}
        reassurance="Labor entries save automatically"
        onSave={saveLabor}
        saveLabel="Save"
        saving={false}
        hidden={approvalStatus === 'approved' || periodClosed}
      />
    </div>
  )
}