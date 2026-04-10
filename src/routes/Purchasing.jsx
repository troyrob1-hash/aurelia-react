import { useState, useEffect, useMemo, useRef } from 'react'
import { useAuthStore } from '@/store/authStore'
import { useLocations, cleanLocName } from '@/store/LocationContext'
import { useToast } from '@/components/ui/Toast'
import { usePeriod } from '@/store/PeriodContext'
import { db } from '@/lib/firebase'
import {
  collection, query, orderBy, getDocs, addDoc, updateDoc,
  doc, getDoc, serverTimestamp, where
} from 'firebase/firestore'
import { Plus, Download, Search, CheckCircle, AlertCircle, Upload, TrendingUp, TrendingDown } from 'lucide-react'
import { writePurchasingPnL } from '@/lib/pnl'
import Breadcrumb from '@/components/ui/Breadcrumb'
import styles from './Purchasing.module.css'

// ── Fallback vendors — overridden by Firestore per org ───────
const DEFAULT_VENDORS = [
  { id: 'sysco',       label: 'Sysco',          glCode: '50413' },
  { id: 'nassau',      label: 'Nassau',          glCode: '50413' },
  { id: 'vistar',      label: 'Vistar',          glCode: '50413' },
  { id: 'cafemoto',    label: 'Café Moto',       glCode: '50412' },
  { id: 'davidrio',    label: 'David Rio',       glCode: '50412' },
  { id: 'amazon',      label: 'Amazon',          glCode: '50414' },
  { id: 'webstaurant', label: 'Webstaurant',     glCode: '50413' },
  { id: 'bluecart',    label: 'Blue Cart',       glCode: '50413' },
  { id: 'rtzn',        label: 'RTZN',            glCode: '50413' },
  { id: 'donedwards',  label: 'Don Edwards',     glCode: '50412' },
  { id: 'other',       label: 'Other',           glCode: '' },
]

const STATUSES = ['Pending', 'Approved', 'Paid', 'Overdue', 'Disputed', 'Void']

const STATUS_META = {
  Pending:  { color: '#d97706', bg: '#fef3c7', border: '#fcd34d' },
  Approved: { color: '#2563eb', bg: '#eff6ff', border: '#bfdbfe' },
  Paid:     { color: '#059669', bg: '#f0fdf4', border: '#bbf7d0' },
  Overdue:  { color: '#dc2626', bg: '#fef2f2', border: '#fca5a5' },
  Disputed: { color: '#7c3aed', bg: '#faf5ff', border: '#ddd6fe' },
  Void:     { color: '#6b7280', bg: '#f9fafb', border: '#e5e7eb' },
}

// Approval thresholds — amounts above these require director approval
const APPROVAL_THRESHOLD = 500

function agingBucket(inv) {
  if (inv.status === 'Paid' || inv.status === 'Void') return null
  if (!inv.dueDate) return 'current'
  const days = Math.floor((new Date() - new Date(inv.dueDate)) / 86400000)
  if (days <= 0)  return 'current'
  if (days <= 30) return '1-30'
  if (days <= 60) return '31-60'
  if (days <= 90) return '61-90'
  return '90+'
}

const fmt$ = v => '$' + Number(v || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

const EMPTY_FORM = {
  invoiceNum: '', vendorId: 'sysco', invoiceDate: new Date().toISOString().slice(0, 10),
  dueDate: '', amount: '', amountPaid: '0', location: '', glCode: '',
  notes: '', status: 'Pending', poNumber: '', periodKey: '',
}

export default function Purchasing() {
  const { user }    = useAuthStore()
  const orgId       = user?.tenantId || 'fooda'
  const toast       = useToast()
  const { selectedLocation, visibleLocations } = useLocations()
  const { periodKey } = usePeriod()

  const [invoices,      setInvoices]      = useState([])
  const [vendors,       setVendors]       = useState(DEFAULT_VENDORS)
  const [budgetData,    setBudgetData]    = useState({})
  const [loading,       setLoading]       = useState(false)
  const [saving,        setSaving]        = useState(false)
  const [showForm,      setShowForm]      = useState(false)
  const [form,          setForm]          = useState(EMPTY_FORM)
  const [editId,        setEditId]        = useState(null)
  const [search,        setSearch]        = useState('')
  const [filterStatus,  setFilterStatus]  = useState('')
  const [filterVendor,  setFilterVendor]  = useState('')
  const [filterPeriod,  setFilterPeriod]  = useState('all')
  const [view,          setView]          = useState('list')  // 'list' | 'kanban'
  const [expandVendor,  setExpandVendor]  = useState({})
  const [dupWarning,    setDupWarning]    = useState(null)
  const [spendTrend,    setSpendTrend]    = useState([])
  const [isDragging,    setIsDragging]    = useState(false)
  const [backfillMode,  setBackfillMode]  = useState(false)
  const fileRef = useRef()

  const location   = selectedLocation === 'all' ? null : selectedLocation
  const isDirector = user?.role === 'admin' || user?.role === 'director'
  const isAdmin    = user?.role === 'admin'

  useEffect(() => { loadAll() }, [selectedLocation, periodKey])

  async function loadAll() {
    setLoading(true)
    try {
      // Load org vendors from Firestore — fallback to defaults
      const vSnap = await getDoc(doc(db, 'tenants', orgId, 'config', 'vendors'))
      if (vSnap.exists() && vSnap.data().list?.length) setVendors(vSnap.data().list)

      // Load invoices — scoped to location if selected
      let q = query(collection(db, 'tenants', orgId, 'invoices'), orderBy('invoiceDate', 'desc'))
      const snap = await getDocs(q)
      let all = snap.docs.map(d => ({ id: d.id, ...d.data() }))
      if (location) all = all.filter(i => i.location === location)
      setInvoices(all)

      // Load budget for spend velocity
      if (location) {
        const bRef  = doc(db, 'tenants', orgId, 'budgets', `${location.replace(/[^a-zA-Z0-9]/g, '_')}-${new Date().getFullYear()}`)
        const bSnap = await getDoc(bRef)
        if (bSnap.exists()) {
          const months = bSnap.data().months || {}
          const mo     = new Date().getMonth() + 1
          setBudgetData(months[mo] || {})
        }
      }

      // Build spend trend — last 6 periods
      buildSpendTrend(all)
    } catch { toast.error('Failed to load invoices.') }
    setLoading(false)
  }

  function buildSpendTrend(all) {
    const byPeriod = {}
    all.forEach(i => {
      const p = i.periodKey || i.invoiceDate?.slice(0, 7) || 'unknown'
      byPeriod[p] = (byPeriod[p] || 0) + (i.amount || 0)
    })
    const sorted = Object.entries(byPeriod).sort((a, b) => a[0].localeCompare(b[0])).slice(-6)
    setSpendTrend(sorted)
  }

  // Smart GL suggestion based on vendor history
  function suggestGL(vendorId) {
    const vendor = vendors.find(v => v.id === vendorId)
    if (vendor?.glCode) return vendor.glCode
    const vendorInvoices = invoices.filter(i => i.vendorId === vendorId && i.glCode)
    if (vendorInvoices.length > 0) return vendorInvoices[0].glCode
    return ''
  }

  function handleVendorChange(vendorId) {
    setForm(f => ({ ...f, vendorId, glCode: suggestGL(vendorId) }))
  }

  // Duplicate detection — same vendor + similar amount + within 30 days
  function checkDuplicate(form) {
    const amount = parseFloat(form.amount) || 0
    const date   = new Date(form.invoiceDate)
    const dup = invoices.find(i => {
      if (editId && i.id === editId) return false
      if (i.vendorId !== form.vendorId) return false
      const diff = Math.abs(i.amount - amount)
      const daysDiff = Math.abs((new Date(i.invoiceDate) - date) / 86400000)
      return diff < 1 && daysDiff <= 30
    })
    return dup || null
  }

  async function handleSave(e, skipDupCheck = false) {
    e.preventDefault()
    // Duplicate check
    const dup = checkDuplicate(form)
    if (dup && !skipDupCheck) {
      setDupWarning(`Possible duplicate: ${fmt$(dup.amount)} from same vendor on ${dup.invoiceDate}. Save anyway?`)
      return
    }
    setDupWarning(null)
    setSaving(true)
    try {
      const vendorLabel = vendors.find(v => v.id === form.vendorId)?.label || form.vendorId
      const entry = {
        ...form,
        vendor:     vendorLabel,
        amount:     parseFloat(form.amount) || 0,
        amountPaid: parseFloat(form.amountPaid) || 0,
        periodKey:  form.periodKey || periodKey,
        updatedBy:  user?.name || user?.email || 'unknown',
        updatedAt:  serverTimestamp(),
        location:   form.location || location || '',
      }
      if (editId) {
        await updateDoc(doc(db, 'tenants', orgId, 'invoices', editId), entry)
        setInvoices(prev => prev.map(i => i.id === editId ? { ...i, ...entry } : i))
        toast.success('Invoice updated')
      } else {
        entry.createdBy = user?.name || user?.email
        entry.createdAt = serverTimestamp()
        entry.syncStatus = null  // ready for external sync (e.g. NetSuite)
        const ref = await addDoc(collection(db, 'tenants', orgId, 'invoices'), entry)
        setInvoices(prev => [{ id: ref.id, ...entry }, ...prev])
        toast.success('Invoice added — pending approval')
      }
      setForm(EMPTY_FORM); setShowForm(false); setEditId(null)
    } catch { toast.error('Failed to save invoice.') }
    setSaving(false)
  }

  async function approve(id) {
    const inv = invoices.find(i => i.id === id)
    await updateDoc(doc(db, 'tenants', orgId, 'invoices', id), {
      status: 'Approved', approvedBy: user?.name || user?.email, approvedAt: serverTimestamp(), updatedAt: serverTimestamp()
    })
    setInvoices(prev => prev.map(i => i.id === id ? { ...i, status: 'Approved' } : i))
    toast.success('Invoice approved')
  }

  async function markPaid(id) {
    const inv = invoices.find(i => i.id === id)
    if (!inv) return

    // Update the invoice to Paid status
    await updateDoc(doc(db, 'tenants', orgId, 'invoices', id), {
      status: 'Paid',
      amountPaid: inv.amount,
      paidBy: user?.name || user?.email,
      paidAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      syncStatus: null,  // ready for external sync (e.g. NetSuite) — see INTEGRATIONS_ARCHITECTURE.md
    })

    // Recalculate P&L totals for the invoice's own period (not the current period — they may differ)
    const targetPeriod = inv.periodKey || periodKey
    const targetLocation = inv.location || location || 'all'

    // Build the period's invoice list AS IF this invoice were already paid (no double-counting)
    const periodInvoices = invoices
      .filter(i => i.periodKey === targetPeriod && i.status !== 'Void')
      .map(i => i.id === id ? { ...i, status: 'Paid', amountPaid: inv.amount } : i)

    const invoiceTotal = periodInvoices.reduce((s, i) => s + (i.amount || 0), 0)
    const paidTotal    = periodInvoices.filter(i => i.status === 'Paid').reduce((s, i) => s + (i.amount || 0), 0)
    const pendingTotal = periodInvoices.filter(i => i.status === 'Pending' || i.status === 'Approved').reduce((s, i) => s + (i.amount || 0), 0)

    await writePurchasingPnL(targetLocation, targetPeriod, {
      invoiceTotal, paidTotal, pendingTotal,
    })

    // EXTENSION POINT: post-payment hooks (NetSuite sync, notifications, etc.)
    // See INTEGRATIONS_ARCHITECTURE.md section 2 for the NetSuite integration plan.
    // Implementation pattern: Cloud Function trigger on this invoice doc's status change to 'Paid'.

    setInvoices(prev => prev.map(i => i.id === id ? { ...i, status: 'Paid', amountPaid: i.amount } : i))
    toast.success('Marked as paid — P&L updated')
  }

  async function updateStatus(id, status) {
    await updateDoc(doc(db, 'tenants', orgId, 'invoices', id), { status, updatedAt: serverTimestamp() })
    setInvoices(prev => prev.map(i => i.id === id ? { ...i, status } : i))
  }

  function handleEdit(inv) {
    const vendorId = vendors.find(v => v.label === inv.vendor)?.id || inv.vendorId || 'other'
    setForm({ ...inv, vendorId, amount: String(inv.amount), amountPaid: String(inv.amountPaid || 0) })
    setEditId(inv.id)
    setShowForm(true)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  // CSV import — shared parser used by both file picker and drag-drop
  async function processInvoiceFile(file) {
    if (!file) return
    try {
      const XLSX = await import('xlsx')
      const ab   = await file.arrayBuffer()
      const wb   = XLSX.read(new Uint8Array(ab), { type: 'array' })
      const ws   = wb.Sheets[wb.SheetNames[0]]
      const rows = XLSX.utils.sheet_to_json(ws, { raw: false })
      let imported = 0
      for (const row of rows) {
        const amount = parseFloat(row['Amount'] || row['amount'] || row['Total'] || 0)
        if (!amount) continue
        const vendorLabel = row['Vendor'] || row['vendor'] || 'Other'
        const vendor = vendors.find(v => v.label.toLowerCase() === vendorLabel.toLowerCase())
        const entry = {
          invoiceNum:  row['Invoice #'] || row['invoice_num'] || '',
          vendor:      vendorLabel,
          vendorId:    vendor?.id || 'other',
          glCode:      row['GL Code'] || row['gl_code'] || vendor?.glCode || '',
          invoiceDate: row['Date'] || row['invoice_date'] || new Date().toISOString().slice(0, 10),
          dueDate:     row['Due Date'] || row['due_date'] || '',
          amount,
          amountPaid:  parseFloat(row['Paid'] || 0),
          // Status validation: only admins in backfill mode can preserve CSV-provided statuses.
          // All other imports are forced to 'Pending' to prevent bypass of the approval workflow.
          // EXTENSION POINT: invoices created via the future Order Hub → Purchasing flow
          // will run through a Cloud Function with admin credentials and bypass this validation.
          // See INTEGRATIONS_ARCHITECTURE.md section 1.
          status:      (isAdmin && backfillMode && row['Status']) ? row['Status'] : 'Pending',
          location:    row['Location'] || location || '',
          periodKey,
          notes:       row['Notes'] || '',
          syncStatus:  null,  // ready for external sync (e.g. NetSuite)
          createdBy:   user?.name || user?.email,
          createdAt:   serverTimestamp(),
          updatedAt:   serverTimestamp(),
        }
        const ref = await addDoc(collection(db, 'tenants', orgId, 'invoices'), entry)
        setInvoices(prev => [{ id: ref.id, ...entry }, ...prev])
        imported++
      }
      toast.success(`Imported ${imported} invoices`)
    } catch { toast.error('Import failed — check file format') }
  }

  async function handleImport(e) {
    const file = e.target.files[0]
    await processInvoiceFile(file)
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
    await processInvoiceFile(file)
  }

  function exportCSV() {
    const rows = [
      ['Invoice #', 'Vendor', 'Date', 'Due Date', 'Amount', 'Paid', 'Balance', 'Status', 'Location', 'GL Code', 'PO #', 'Period'],
      ...filtered.map(i => [
        i.invoiceNum, i.vendor, i.invoiceDate, i.dueDate || '',
        i.amount, i.amountPaid || 0, (i.amount - (i.amountPaid || 0)).toFixed(2),
        i.status, i.location || '', i.glCode || '', i.poNumber || '', i.periodKey || '',
      ])
    ]
    const csv  = rows.map(r => r.map(v => `"${v ?? ''}"`).join(',')).join('\n')
    const blob = new Blob([csv], { type: 'text/csv' })
    const url  = URL.createObjectURL(blob)
    Object.assign(document.createElement('a'), { href: url, download: `invoices-${periodKey}.csv` }).click()
    URL.revokeObjectURL(url)
  }

  // ── Derived ──────────────────────────────────────────────────
  const filtered = useMemo(() => invoices.filter(i => {
    if (filterStatus && i.status !== filterStatus) return false
    if (filterVendor && i.vendorId !== filterVendor && i.vendor !== filterVendor) return false
    if (filterPeriod !== 'all' && i.periodKey !== filterPeriod) return false
    if (search && !i.invoiceNum?.toLowerCase().includes(search.toLowerCase()) &&
        !i.vendor?.toLowerCase().includes(search.toLowerCase()) &&
        !i.glCode?.includes(search) && !i.poNumber?.includes(search)) return false
    return true
  }), [invoices, filterStatus, filterVendor, filterPeriod, search])

  const aging = useMemo(() => {
    const b = { current: 0, '1-30': 0, '31-60': 0, '61-90': 0, '90+': 0 }
    invoices.filter(i => i.status !== 'Paid' && i.status !== 'Void').forEach(i => {
      const bucket = agingBucket(i)
      if (bucket) b[bucket] += (i.amount - (i.amountPaid || 0))
    })
    return b
  }, [invoices])

  const agingMax   = Math.max(...Object.values(aging), 1)
  const totalOwed  = invoices.filter(i => i.status !== 'Paid' && i.status !== 'Void').reduce((s, i) => s + (i.amount - (i.amountPaid || 0)), 0)
  const totalPaid  = invoices.filter(i => i.status === 'Paid').reduce((s, i) => s + i.amount, 0)
  const overdueAmt = aging['1-30'] + aging['31-60'] + aging['61-90'] + aging['90+']
  const periodSpend = invoices.filter(i => i.periodKey === periodKey && i.status !== 'Void').reduce((s, i) => s + i.amount, 0)
  const budgetCOGS  = (budgetData.cogs || 0) / 4.33
  const spendPct    = budgetCOGS > 0 ? periodSpend / budgetCOGS : null

  // Vendor spend summary
  const vendorSpend = useMemo(() => {
    const v = {}
    invoices.filter(i => i.periodKey === periodKey).forEach(i => {
      const key = i.vendor || 'Other'
      v[key] = (v[key] || 0) + i.amount
    })
    return Object.entries(v).sort((a, b) => b[1] - a[1]).slice(0, 5)
  }, [invoices, periodKey])

  // Kanban columns
  const kanbanCols = useMemo(() => {
    const cols = { Pending: [], Approved: [], Paid: [], Overdue: [], Disputed: [] }
    filtered.forEach(i => { if (cols[i.status]) cols[i.status].push(i) })
    return cols
  }, [filtered])

  // Unique periods for filter
  const periods = useMemo(() => {
    const ps = new Set(invoices.map(i => i.periodKey).filter(Boolean))
    return Array.from(ps).sort().reverse().slice(0, 8)
  }, [invoices])

  return (
    <div
      className={styles.page}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >

      {/* ── Header ── */}
      <div className={styles.header}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <Breadcrumb items={['Operations', 'Purchasing / AP']} />
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 2, flexWrap: 'wrap' }}>
            <h1 className={styles.title} style={{ margin: 0 }}>Purchasing / AP</h1>
            <span style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              padding: '4px 10px',
              background: '#f1f5f9',
              border: '0.5px solid #e2e8f0',
              borderRadius: 20,
              fontSize: 12,
              color: '#475569',
              fontWeight: 500,
            }}>
              📍 {location ? cleanLocName(location) : 'All Locations'}
            </span>
            <span style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              padding: '4px 10px',
              background: '#f1f5f9',
              border: '0.5px solid #e2e8f0',
              borderRadius: 20,
              fontSize: 12,
              color: '#475569',
              fontWeight: 500,
            }}>
              📅 {periodKey}
            </span>
          </div>
          <div style={{ fontSize: 12, color: '#94a3b8', marginTop: 6 }}>
            {invoices.length} total invoice{invoices.length !== 1 ? 's' : ''} · {invoices.filter(i => i.status === 'Pending').length} pending approval · {fmt$(totalOwed)} outstanding
          </div>
        </div>
        <div className={styles.actions}>
          <div className={styles.viewToggle}>
            <button className={`${styles.viewBtn} ${view === 'list' ? styles.viewActive : ''}`} onClick={() => setView('list')}>List</button>
            <button className={`${styles.viewBtn} ${view === 'kanban' ? styles.viewActive : ''}`} onClick={() => setView('kanban')}>Board</button>
          </div>
          <button className={styles.btnIcon} onClick={exportCSV} title="Export CSV"><Download size={15} /></button>
          <label className={styles.btnSecondary}>
            <Upload size={13} /> Import
            <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" style={{ display: 'none' }} onChange={handleImport} />
          </label>
          {isAdmin && (
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: '#6b7280', cursor: 'pointer', padding: '0 8px' }} title="Admin only: preserve original statuses from CSV (for historical backfill). When off, all imports are forced to Pending.">
              <input type="checkbox" checked={backfillMode} onChange={e => setBackfillMode(e.target.checked)} style={{ width: 13, height: 13 }} />
              Backfill mode
            </label>
          )}
          <button className={styles.btnPrimary} onClick={() => { setForm({ ...EMPTY_FORM, location: location || '', periodKey }); setEditId(null); setShowForm(v => !v) }}>
            <Plus size={15} /> Add Invoice
          </button>
        </div>
      </div>

      {/* ── KPI bar ── */}
      <div className={styles.kpiBar}>
        <div className={`${styles.kpi} ${styles.kpiDark}`}>
          <div className={styles.kpiL}>Period Spend</div>
          <div className={styles.kpiV}>{fmt$(periodSpend)}</div>
          {spendPct != null && (
            <div className={`${styles.kpiBadge} ${spendPct > 1 ? styles.kpiBadgeOver : styles.kpiBadgeOk}`}>
              {spendPct > 1 ? '▲ Over' : '▼ Under'} budget {(Math.abs(spendPct - 1) * 100).toFixed(0)}%
            </div>
          )}
        </div>
        <div className={styles.kpi}>
          <div className={styles.kpiL}>Outstanding</div>
          <div className={styles.kpiV} style={{ color: '#dc2626' }}>{fmt$(totalOwed)}</div>
        </div>
        <div className={styles.kpi}>
          <div className={styles.kpiL}>Paid (period)</div>
          <div className={styles.kpiV} style={{ color: '#059669' }}>{fmt$(totalPaid)}</div>
        </div>
        <div className={styles.kpi}>
          <div className={styles.kpiL}>Past Due</div>
          <div className={styles.kpiV} style={{ color: overdueAmt > 0 ? '#dc2626' : undefined }}>{fmt$(overdueAmt)}</div>
          {overdueAmt > 0 && <div className={styles.kpiAlert}>Needs attention</div>}
        </div>
        <div className={styles.kpi}>
          <div className={styles.kpiL}>Invoices</div>
          <div className={styles.kpiV}>{filtered.length}</div>
          <div className={styles.kpiSub}>{invoices.filter(i => i.status === 'Pending').length} pending approval</div>
        </div>
      </div>

      {/* ── Visual aging bar ── */}
      <div className={styles.agingCard}>
        <div className={styles.agingTitle}>A/P Aging</div>
        <div className={styles.agingBuckets}>
          {[
            { key: 'current', label: 'Current',    color: '#059669' },
            { key: '1-30',    label: '1–30 days',  color: '#d97706' },
            { key: '31-60',   label: '31–60 days', color: '#ea580c' },
            { key: '61-90',   label: '61–90 days', color: '#dc2626' },
            { key: '90+',     label: '90+ days',   color: '#7f1d1d' },
          ].map(b => (
            <div key={b.key} className={styles.agingBucket}>
              <div className={styles.agingBarWrap}>
                <div className={styles.agingBarFill} style={{ height: `${(aging[b.key] / agingMax) * 52}px`, background: b.color, opacity: aging[b.key] > 0 ? 1 : 0.15 }} />
              </div>
              <div className={styles.agingAmt} style={{ color: aging[b.key] > 0 ? b.color : '#ccc' }}>{fmt$(aging[b.key])}</div>
              <div className={styles.agingLbl}>{b.label}</div>
            </div>
          ))}
        </div>
        {/* Vendor spend breakdown */}
        {vendorSpend.length > 0 && (
          <div className={styles.vendorSpend}>
            <div className={styles.vendorSpendTitle}>Top vendors this period</div>
            {vendorSpend.map(([vendor, amt]) => (
              <div key={vendor} className={styles.vendorSpendRow}>
                <span className={styles.vendorSpendName}>{vendor}</span>
                <div className={styles.vendorSpendBar}>
                  <div className={styles.vendorSpendFill} style={{ width: `${(amt / vendorSpend[0][1]) * 100}%` }} />
                </div>
                <span className={styles.vendorSpendAmt}>{fmt$(amt)}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── Duplicate warning ── */}
      {dupWarning && (
        <div className={styles.dupWarning}>
          <AlertCircle size={14} />
          <span>{dupWarning}</span>
          <button className={styles.btnDupConfirm} onClick={() => { setDupWarning(null); handleSave({ preventDefault: () => {} }, true) }}>Save Anyway</button>
          <button className={styles.btnDupCancel} onClick={() => setDupWarning(null)}>Cancel</button>
        </div>
      )}

      {/* ── Invoice form ── */}
      {showForm && (
        <div className={styles.formCard}>
          <div className={styles.formTitle}>{editId ? 'Edit Invoice' : 'New Invoice'}</div>
          <form onSubmit={handleSave}>
            <div className={styles.grid}>
              <div className={styles.field}>
                <label>Vendor</label>
                <select value={form.vendorId} onChange={e => handleVendorChange(e.target.value)}>
                  {vendors.map(v => <option key={v.id} value={v.id}>{v.label}</option>)}
                </select>
              </div>
              <div className={styles.field}>
                <label>Invoice #</label>
                <input value={form.invoiceNum} onChange={e => setForm(f => ({ ...f, invoiceNum: e.target.value }))} placeholder="INV-001" autoFocus />
              </div>
              <div className={styles.field}>
                <label>PO Number</label>
                <input value={form.poNumber || ''} onChange={e => setForm(f => ({ ...f, poNumber: e.target.value }))} placeholder="PO-001 (optional)" />
              </div>
              <div className={styles.field}>
                <label>Invoice Date</label>
                <input type="date" value={form.invoiceDate} onChange={e => setForm(f => ({ ...f, invoiceDate: e.target.value }))} required />
              </div>
              <div className={styles.field}>
                <label>Due Date</label>
                <input type="date" value={form.dueDate} onChange={e => setForm(f => ({ ...f, dueDate: e.target.value }))} />
              </div>
              <div className={styles.field}>
                <label>Amount ($)</label>
                <input type="number" min="0" step="0.01" value={form.amount} onChange={e => setForm(f => ({ ...f, amount: e.target.value }))} required />
              </div>
              <div className={styles.field}>
                <label>Amount Paid ($)</label>
                <input type="number" min="0" step="0.01" value={form.amountPaid} onChange={e => setForm(f => ({ ...f, amountPaid: e.target.value }))} />
              </div>
              <div className={styles.field}>
                <label>GL Code <span className={styles.autoTag}>auto</span></label>
                <input value={form.glCode} onChange={e => setForm(f => ({ ...f, glCode: e.target.value }))} placeholder="e.g. 50410" />
              </div>
              <div className={styles.field}>
                <label>Location</label>
                <select value={form.location} onChange={e => setForm(f => ({ ...f, location: e.target.value }))}>
                  <option value="">All Locations</option>
                  {Object.keys(visibleLocations).map(l => <option key={l} value={l}>{cleanLocName(l)}</option>)}
                </select>
              </div>
              <div className={styles.field}>
                <label>Period</label>
                <input value={form.periodKey || periodKey} onChange={e => setForm(f => ({ ...f, periodKey: e.target.value }))} placeholder={periodKey} />
              </div>
              <div className={styles.field}>
                <label>Status</label>
                <select value={form.status} onChange={e => setForm(f => ({ ...f, status: e.target.value }))}>
                  {STATUSES.map(s => <option key={s}>{s}</option>)}
                </select>
              </div>
              <div className={styles.field} style={{ gridColumn: 'span 2' }}>
                <label>Notes</label>
                <input value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} placeholder="Optional notes" />
              </div>
            </div>
            {parseFloat(form.amount) >= APPROVAL_THRESHOLD && (
              <div className={styles.thresholdNote}>
                <AlertCircle size={13} /> Invoices ≥ {fmt$(APPROVAL_THRESHOLD)} require director approval before payment.
              </div>
            )}
            <div className={styles.formActions}>
              <button type="button" className={styles.btnCancel} onClick={() => { setShowForm(false); setForm(EMPTY_FORM); setEditId(null); setDupWarning(null) }}>Cancel</button>
              <button type="submit" className={styles.btnPrimary} disabled={saving}>{saving ? 'Saving...' : 'Save Invoice'}</button>
            </div>
          </form>
        </div>
      )}

      {/* ── Toolbar ── */}
      <div className={styles.toolbar}>
        <div className={styles.searchWrap}>
          <Search size={14} className={styles.searchIcon} />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search invoice #, vendor, GL, PO..." className={styles.search} />
        </div>
        <select value={filterStatus} onChange={e => setFilterStatus(e.target.value)} className={styles.filter}>
          <option value="">All Statuses</option>
          {STATUSES.map(s => <option key={s}>{s}</option>)}
        </select>
        <select value={filterVendor} onChange={e => setFilterVendor(e.target.value)} className={styles.filter}>
          <option value="">All Vendors</option>
          {vendors.map(v => <option key={v.id} value={v.id}>{v.label}</option>)}
        </select>
        <select value={filterPeriod} onChange={e => setFilterPeriod(e.target.value)} className={styles.filter}>
          <option value="all">All Periods</option>
          {periods.map(p => <option key={p} value={p}>{p}</option>)}
        </select>
      </div>

      {loading ? <div className={styles.loading}>Loading...</div> : view === 'kanban' ? (

        /* ── Kanban board view ── */
        <div className={styles.kanban}>
          {['Pending', 'Approved', 'Paid', 'Overdue', 'Disputed'].map(status => {
            const meta = STATUS_META[status]
            const cards = kanbanCols[status] || []
            const colTotal = cards.reduce((s, i) => s + (i.amount || 0), 0)
            return (
              <div key={status} className={styles.kanbanCol}>
                <div className={styles.kanbanColHeader} style={{ borderTopColor: meta.color }}>
                  <span className={styles.kanbanColTitle} style={{ color: meta.color }}>{status}</span>
                  <span className={styles.kanbanColCount}>{cards.length} · {fmt$(colTotal)}</span>
                </div>
                <div className={styles.kanbanCards}>
                  {cards.map(inv => {
                    const balance     = (inv.amount || 0) - (inv.amountPaid || 0)
                    const daysOverdue = inv.dueDate ? Math.floor((new Date() - new Date(inv.dueDate)) / 86400000) : 0
                    const initial     = (inv.vendor || '?')[0].toUpperCase()
                    return (
                      <div key={inv.id} className={styles.kanbanCard} onClick={() => handleEdit(inv)}>
                        <div className={styles.kanbanCardHeader}>
                          <div className={styles.vendorInitial} style={{ background: meta.bg, color: meta.color }}>{initial}</div>
                          <div>
                            <div className={styles.kanbanVendor}>{inv.vendor}</div>
                            <div className={styles.kanbanInvNum}>{inv.invoiceNum || '—'}</div>
                          </div>
                          <div className={styles.kanbanAmt}>{fmt$(inv.amount)}</div>
                        </div>
                        {inv.glCode && <div className={styles.kanbanGL}>GL {inv.glCode}</div>}
                        {inv.dueDate && (
                          <div className={styles.kanbanDue} style={{
                            fontSize: 10,
                            color: daysOverdue > 0 && status !== 'Paid' ? '#dc2626' : daysOverdue >= -3 && status !== 'Paid' ? '#d97706' : '#6b7280',
                            marginTop: 4,
                            display: 'flex',
                            alignItems: 'center',
                            gap: 4,
                          }}>
                            <span>Due {new Date(inv.dueDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</span>
                            {status !== 'Paid' && daysOverdue > 0 && (
                              <span style={{ fontWeight: 600 }}>· +{daysOverdue}d overdue</span>
                            )}
                            {status !== 'Paid' && daysOverdue <= 0 && daysOverdue >= -3 && (
                              <span style={{ fontWeight: 600 }}>· due in {Math.abs(daysOverdue)}d</span>
                            )}
                          </div>
                        )}
                        <div className={styles.kanbanCardFooter}>
                          {status === 'Pending' && isDirector && (
                            <button className={styles.btnKanbanApprove} onClick={e => { e.stopPropagation(); approve(inv.id) }}>
                              <CheckCircle size={11} /> Approve
                            </button>
                          )}
                          {status === 'Approved' && isDirector && (
                            <button className={styles.btnKanbanPay} onClick={e => { e.stopPropagation(); markPaid(inv.id) }}>
                              <CheckCircle size={11} /> Mark Paid
                            </button>
                          )}
                        </div>
                      </div>
                    )
                  })}
                  {cards.length === 0 && <div className={styles.kanbanEmpty}>No invoices</div>}
                </div>
              </div>
            )
          })}
        </div>

      ) : (

        /* ── List view (vendor grouped) ── */
        <div className={styles.tableWrap}>
          {Object.entries(
            filtered.reduce((g, i) => {
              const k = i.vendor || 'Other'
              if (!g[k]) g[k] = { invoices: [], outstanding: 0, paid: 0 }
              g[k].invoices.push(i)
              if (i.status !== 'Paid' && i.status !== 'Void') g[k].outstanding += (i.amount - (i.amountPaid || 0))
              if (i.status === 'Paid') g[k].paid += i.amount
              return g
            }, {})
          ).map(([vendor, group]) => (
            <div key={vendor} className={styles.vendorGroup}>
              <div className={styles.vendorHeader} onClick={() => setExpandVendor(p => ({ ...p, [vendor]: !p[vendor] }))}>
                <div className={styles.vendorHeaderLeft}>
                  <div className={styles.vendorInitialSm}>{vendor[0].toUpperCase()}</div>
                  <span className={styles.vendorName}>{vendor}</span>
                  <span className={styles.vendorCount}>{group.invoices.length} invoice{group.invoices.length !== 1 ? 's' : ''}</span>
                </div>
                <div className={styles.vendorMeta}>
                  {group.outstanding > 0 && <span className={styles.vendorOwed}>{fmt$(group.outstanding)} owed</span>}
                  {group.paid > 0 && <span className={styles.vendorPaid}>{fmt$(group.paid)} paid</span>}
                  <span className={styles.vendorToggle}>{expandVendor[vendor] === false ? '▼' : '▲'}</span>
                </div>
              </div>

              {expandVendor[vendor] !== false && (
                <table className={styles.table}>
                  <thead>
                    <tr>
                      <th>Invoice #</th><th>Date</th><th>Due</th><th>Amount</th>
                      <th>Paid</th><th>Balance</th><th>GL</th><th>PO #</th><th>Status</th><th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {group.invoices.map(inv => {
                      const balance     = (inv.amount || 0) - (inv.amountPaid || 0)
                      const meta        = STATUS_META[inv.status] || STATUS_META.Pending
                      const daysOverdue = inv.dueDate ? Math.floor((new Date() - new Date(inv.dueDate)) / 86400000) : 0
                      const needsDirector = inv.amount >= APPROVAL_THRESHOLD
                      return (
                        <tr key={inv.id}>
                          <td className={styles.invNum}>{inv.invoiceNum || '—'}</td>
                          <td className={styles.muted}>{inv.invoiceDate}</td>
                          <td>
                            <span style={{ color: daysOverdue > 0 && inv.status !== 'Paid' ? '#dc2626' : 'inherit' }}>
                              {inv.dueDate || '—'}
                              {daysOverdue > 0 && inv.status !== 'Paid' && <span className={styles.overdueBadge}>+{daysOverdue}d</span>}
                            </span>
                          </td>
                          <td className={styles.amtCell}>{fmt$(inv.amount || 0)}</td>
                          <td style={{ color: '#059669' }}>{fmt$(inv.amountPaid || 0)}</td>
                          <td style={{ fontWeight: 700, color: balance > 0 ? '#dc2626' : '#059669' }}>{fmt$(balance)}</td>
                          <td className={styles.glCell}>{inv.glCode || '—'}</td>
                          <td className={styles.muted}>{inv.poNumber || '—'}</td>
                          <td>
                            <span className={styles.statusBadge} style={{ background: meta.bg, color: meta.color, border: `1px solid ${meta.border}` }}>
                              {inv.status}
                            </span>
                          </td>
                          <td>
                            <div className={styles.actionRow}>
                              {inv.status === 'Pending' && isDirector && (
                                <button className={styles.btnApprove} onClick={() => approve(inv.id)}>
                                  <CheckCircle size={12} /> Approve
                                </button>
                              )}
                              {inv.status === 'Pending' && !isDirector && needsDirector && (
                                <span className={styles.awaitingTag}>Awaiting director</span>
                              )}
                              {inv.status === 'Approved' && (
                                <button className={styles.btnPay} onClick={() => markPaid(inv.id)}>
                                  <CheckCircle size={12} /> Pay
                                </button>
                              )}
                              <button className={styles.btnEdit} onClick={() => handleEdit(inv)}>Edit</button>
                            </div>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              )}
            </div>
          ))}
          {filtered.length === 0 && (
            <div className={styles.empty}>
              <div className={styles.emptyIcon}>📄</div>
              <p className={styles.emptyTitle}>No invoices found</p>
              <p className={styles.emptySub}>Add an invoice or import from a CSV/Excel file</p>
            </div>
          )}
        </div>
      )}

      {isDragging && (
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
              Drop invoice file here
            </div>
            <div style={{fontSize:14,color:'#6b7280'}}>
              Accepts .xlsx, .xls, or .csv
            </div>
          </div>
        </div>
      )}
    </div>
  )
}