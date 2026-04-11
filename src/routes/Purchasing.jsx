import { useState, useEffect, useMemo, useRef, Fragment } from 'react'
import { useAuthStore } from '@/store/authStore'
import { useLocations, cleanLocName } from '@/store/LocationContext'
import { useToast } from '@/components/ui/Toast'
import { usePeriod } from '@/store/PeriodContext'
import { db, storage } from '@/lib/firebase'
import {
  collection, query, orderBy, getDocs, addDoc, updateDoc,
  doc, getDoc, serverTimestamp, where, arrayUnion, arrayRemove
} from 'firebase/firestore'
import { ref as storageRef, uploadBytes, getDownloadURL, deleteObject } from 'firebase/storage'
import { Plus, Download, Search, CheckCircle, AlertCircle, Upload, TrendingUp, TrendingDown, Paperclip, FileText, Image as ImageIcon, Trash2 } from 'lucide-react'
import { writePurchasingPnL } from '@/lib/pnl'
import Breadcrumb from '@/components/ui/Breadcrumb'
import { useDragDropUpload } from '@/hooks/useDragDropUpload'
import DropZoneOverlay from '@/components/ui/DropZoneOverlay'
import { canApproveInvoices, canAdministerSystem } from '@/lib/permissions'
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
  const [backfillMode,  setBackfillMode]  = useState(false)
  const [expandedInvoice, setExpandedInvoice] = useState(null)
  const [showImportModal, setShowImportModal] = useState(false)
  const [pendingImportFile, setPendingImportFile] = useState(null)
  const [selectedIds, setSelectedIds] = useState(new Set())
  const [detailInvoice, setDetailInvoice] = useState(null)
  const [uploadingAttachment, setUploadingAttachment] = useState(false)
  const [previewAttachment, setPreviewAttachment] = useState(null)
  const [detailVendor, setDetailVendor] = useState(null)
  const [editingVendor, setEditingVendor] = useState(false)
  const [vendorForm, setVendorForm] = useState(null)
  const [schedulingInvoice, setSchedulingInvoice] = useState(null)
  const [scheduleDate, setScheduleDate] = useState('')
  const [recurringInvoice, setRecurringInvoice] = useState(null)
  const [recurrenceForm, setRecurrenceForm] = useState({ frequency: 'monthly', endDate: '' })
  const fileRef = useRef()

  const location   = selectedLocation === 'all' ? null : selectedLocation
  const isDirector = canApproveInvoices(user)  // directors, VPs, and admins can approve invoices
  const isAdmin    = canAdministerSystem(user)  // admin powers only

  // Drag-and-drop file upload (shared hook handles enter/leave counting,
  // escape-to-dismiss, and drag-end cleanup)
  const { isDragging, dragHandlers, dismiss: dismissDropZone } = useDragDropUpload({
    acceptedExtensions: ['.xlsx', '.xls', '.csv'],
    onFile: async (file) => { await processInvoiceFile(file, false) },
    onInvalidFile: () => toast.error('Please drop a .xlsx, .xls, or .csv file'),
  })

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
  async function processInvoiceFile(file, useBackfill = false) {
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
          status:      (isAdmin && useBackfill && row['Status']) ? row['Status'] : 'Pending',
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
    e.target.value = ''  // reset so the same file can be re-picked if needed
    if (!file) return
    if (isAdmin) {
      // Admins get the mode-picker modal to choose between Standard and Backfill
      setPendingImportFile(file)
      setShowImportModal(true)
    } else {
      // Non-admins can only do Standard imports (all invoices forced to Pending)
      await processInvoiceFile(file, false)
    }
  }

  async function confirmImport(useBackfillMode) {
    setShowImportModal(false)
    const file = pendingImportFile
    setPendingImportFile(null)
    if (file) await processInvoiceFile(file, useBackfillMode)
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

  // ── Bulk selection helpers ──────────────────────────────────
  function toggleSelect(id) {
    setSelectedIds(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  function toggleSelectAll() {
    if (selectedIds.size === filtered.length) {
      setSelectedIds(new Set())
    } else {
      setSelectedIds(new Set(filtered.map(i => i.id)))
    }
  }

  async function bulkApprove() {
    const ids = [...selectedIds].filter(id => {
      const inv = invoices.find(i => i.id === id)
      return inv && inv.status === 'Pending'
    })
    if (ids.length === 0) { toast.error('No pending invoices selected'); return }
    if (!window.confirm(`Approve ${ids.length} invoice${ids.length !== 1 ? 's' : ''}?`)) return
    for (const id of ids) {
      await updateDoc(doc(db, 'tenants', orgId, 'invoices', id), {
        status: 'Approved', approvedBy: user?.name || user?.email, approvedAt: serverTimestamp(), updatedAt: serverTimestamp()
      })
    }
    setInvoices(prev => prev.map(i => ids.includes(i.id) ? { ...i, status: 'Approved' } : i))
    setSelectedIds(new Set())
    toast.success(`${ids.length} invoice${ids.length !== 1 ? 's' : ''} approved`)
  }

  async function bulkMarkPaid() {
    const ids = [...selectedIds].filter(id => {
      const inv = invoices.find(i => i.id === id)
      return inv && inv.status === 'Approved'
    })
    if (ids.length === 0) { toast.error('No approved invoices selected'); return }
    if (!window.confirm(`Mark ${ids.length} invoice${ids.length !== 1 ? 's' : ''} as paid?`)) return
    for (const id of ids) {
      await markPaid(id)
    }
    setSelectedIds(new Set())
  }

  function bulkExport() {
    const selected = filtered.filter(i => selectedIds.has(i.id))
    if (selected.length === 0) { toast.error('No invoices selected'); return }
    const rows = [
      ['Invoice #', 'Vendor', 'Date', 'Due Date', 'Amount', 'Paid', 'Balance', 'Status', 'Location', 'GL Code', 'PO #', 'Period'],
      ...selected.map(i => [
        i.invoiceNum, i.vendor, i.invoiceDate, i.dueDate || '',
        i.amount, i.amountPaid || 0, (i.amount - (i.amountPaid || 0)).toFixed(2),
        i.status, i.location || '', i.glCode || '', i.poNumber || '', i.periodKey || '',
      ])
    ]
    const csv  = rows.map(r => r.map(v => `"${v ?? ''}"`).join(',')).join('\n')
    const blob = new Blob([csv], { type: 'text/csv' })
    const url  = URL.createObjectURL(blob)
    Object.assign(document.createElement('a'), { href: url, download: `invoices-selected-${periodKey}.csv` }).click()
    URL.revokeObjectURL(url)
    toast.success(`Exported ${selected.length} invoices`)
  }

  // ── Attachment handlers ────────────────────────────────────
  async function uploadAttachment(invoiceId, file) {
    if (!file) return
    const MAX_SIZE = 10 * 1024 * 1024
    if (file.size > MAX_SIZE) {
      toast.error('File too large — max 10MB')
      return
    }
    const allowedTypes = ['application/pdf', 'image/jpeg', 'image/png', 'image/gif', 'image/webp']
    if (!allowedTypes.includes(file.type)) {
      toast.error('Only PDF and image files are allowed')
      return
    }
    setUploadingAttachment(true)
    try {
      const safeFilename = `${Date.now()}_${file.name.replace(/[^a-zA-Z0-9._-]/g, '_')}`
      const path = `tenants/${orgId}/invoices/${invoiceId}/${safeFilename}`
      const fileRef = storageRef(storage, path)
      await uploadBytes(fileRef, file, { contentType: file.type })
      const url = await getDownloadURL(fileRef)
      const attachment = {
        name: file.name,
        path,
        url,
        size: file.size,
        contentType: file.type,
        uploadedBy: user?.name || user?.email || 'unknown',
        uploadedAt: new Date().toISOString(),
      }
      await updateDoc(doc(db, 'tenants', orgId, 'invoices', invoiceId), {
        attachments: arrayUnion(attachment),
        updatedAt: serverTimestamp(),
      })
      setInvoices(prev => prev.map(i => i.id === invoiceId ? { ...i, attachments: [...(i.attachments || []), attachment] } : i))
      toast.success('File attached')
    } catch (e) {
      console.error(e)
      toast.error('Upload failed: ' + (e.message || 'unknown error'))
    } finally {
      setUploadingAttachment(false)
    }
  }

  async function deleteAttachment(invoiceId, attachment) {
    if (!window.confirm(`Delete "${attachment.name}"? This cannot be undone.`)) return
    try {
      await deleteObject(storageRef(storage, attachment.path))
      await updateDoc(doc(db, 'tenants', orgId, 'invoices', invoiceId), {
        attachments: arrayRemove(attachment),
        updatedAt: serverTimestamp(),
      })
      setInvoices(prev => prev.map(i => i.id === invoiceId ? { ...i, attachments: (i.attachments || []).filter(a => a.path !== attachment.path) } : i))
      toast.success('Attachment removed')
    } catch (e) {
      console.error(e)
      toast.error('Delete failed: ' + (e.message || 'unknown error'))
    }
  }

  function fmtFileSize(bytes) {
    if (!bytes) return '0 B'
    if (bytes < 1024) return bytes + ' B'
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
  }

  // ── Vendor detail handlers ──────────────────────────────────
  // NOTE: Vendors are stored as an array inside a single Firestore doc
  // (tenants/{orgId}/config/vendors). This is fine for ~100 vendors.
  // Post-pilot, migrate to a proper subcollection at tenants/{orgId}/vendors/.
  function openVendorDetail(vendorName) {
    const v = vendors.find(x => x.label === vendorName || x.id === vendorName)
    if (!v) {
      toast.error('Vendor not found')
      return
    }
    setDetailVendor(v)
    setVendorForm({
      id: v.id,
      label: v.label,
      glCode: v.glCode || '',
      contactName: v.contactName || '',
      contactEmail: v.contactEmail || '',
      contactPhone: v.contactPhone || '',
      street: v.street || '',
      city: v.city || '',
      state: v.state || '',
      zip: v.zip || '',
      taxId: v.taxId || '',
      paymentTerms: v.paymentTerms || 'Net 30',
      w9OnFile: v.w9OnFile || false,
      notes: v.notes || '',
    })
    setEditingVendor(false)
  }

  async function saveVendor() {
    if (!vendorForm || !isAdmin) return
    try {
      const nextVendors = vendors.map(v => v.id === vendorForm.id ? { ...v, ...vendorForm } : v)
      await updateDoc(doc(db, 'tenants', orgId, 'config', 'vendors'), {
        list: nextVendors,
        updatedAt: serverTimestamp(),
      })
      setVendors(nextVendors)
      setDetailVendor(nextVendors.find(v => v.id === vendorForm.id))
      setEditingVendor(false)
      toast.success('Vendor updated')
    } catch (e) {
      console.error(e)
      toast.error('Failed to save vendor: ' + (e.message || 'unknown error'))
    }
  }

  function getVendorStats(vendorLabel) {
    const vendorInvoices = invoices.filter(i => i.vendor === vendorLabel)
    const ytd = vendorInvoices
      .filter(i => i.invoiceDate && new Date(i.invoiceDate).getFullYear() === new Date().getFullYear())
      .reduce((s, i) => s + (i.amount || 0), 0)
    const outstanding = vendorInvoices
      .filter(i => i.status !== 'Paid' && i.status !== 'Void')
      .reduce((s, i) => s + (i.amount - (i.amountPaid || 0)), 0)
    const paidInvoices = vendorInvoices.filter(i => i.status === 'Paid' && i.paidAt && i.invoiceDate)
    const avgDaysToPay = paidInvoices.length > 0
      ? Math.round(paidInvoices.reduce((s, i) => {
          const paidDate = i.paidAt?.toDate ? i.paidAt.toDate() : new Date(i.paidAt)
          const invDate = new Date(i.invoiceDate)
          return s + Math.max(0, Math.floor((paidDate - invDate) / 86400000))
        }, 0) / paidInvoices.length)
      : null
    return {
      totalCount: vendorInvoices.length,
      ytd,
      outstanding,
      paidCount: paidInvoices.length,
      pendingCount: vendorInvoices.filter(i => i.status === 'Pending').length,
      avgDaysToPay,
      recentInvoices: [...vendorInvoices].sort((a, b) => (b.invoiceDate || '').localeCompare(a.invoiceDate || '')).slice(0, 5),
    }
  }

  // ── Scheduled payment handlers ──────────────────────────────
  function openScheduleModal(invoiceId) {
    const inv = invoices.find(i => i.id === invoiceId)
    if (!inv) return
    if (inv.status !== 'Approved') {
      toast.error('Only approved invoices can be scheduled for payment')
      return
    }
    setSchedulingInvoice(inv)
    // Default to 7 days from today
    const defaultDate = new Date()
    defaultDate.setDate(defaultDate.getDate() + 7)
    setScheduleDate(inv.scheduledPaymentDate || defaultDate.toISOString().slice(0, 10))
  }

  async function confirmScheduledPayment() {
    if (!schedulingInvoice || !scheduleDate) return
    const today = new Date().toISOString().slice(0, 10)
    if (scheduleDate < today) {
      toast.error('Scheduled date must be today or in the future')
      return
    }
    try {
      await updateDoc(doc(db, 'tenants', orgId, 'invoices', schedulingInvoice.id), {
        scheduledPaymentDate: scheduleDate,
        scheduledBy: user?.name || user?.email || 'unknown',
        scheduledAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      })
      setInvoices(prev => prev.map(i =>
        i.id === schedulingInvoice.id
          ? { ...i, scheduledPaymentDate: scheduleDate, scheduledBy: user?.name || user?.email }
          : i
      ))
      setSchedulingInvoice(null)
      setScheduleDate('')
      const friendlyDate = new Date(scheduleDate + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
      toast.success(`Payment scheduled for ${friendlyDate}`)
    } catch (e) {
      console.error(e)
      toast.error('Failed to schedule payment: ' + (e.message || 'unknown error'))
    }
  }

  async function cancelScheduledPayment(invoiceId) {
    if (!window.confirm('Cancel scheduled payment? The invoice will remain Approved.')) return
    try {
      // Use a dummy delete sentinel value — we'll use null to unset the field
      const { deleteField } = await import('firebase/firestore')
      await updateDoc(doc(db, 'tenants', orgId, 'invoices', invoiceId), {
        scheduledPaymentDate: deleteField(),
        scheduledBy: deleteField(),
        scheduledAt: deleteField(),
        updatedAt: serverTimestamp(),
      })
      setInvoices(prev => prev.map(i =>
        i.id === invoiceId
          ? { ...i, scheduledPaymentDate: null, scheduledBy: null, scheduledAt: null }
          : i
      ))
      toast.success('Scheduled payment cancelled')
    } catch (e) {
      console.error(e)
      toast.error('Failed to cancel: ' + (e.message || 'unknown error'))
    }
  }

  // ── Recurring invoice handlers ──────────────────────────────
  function openRecurrenceModal(invoiceId) {
    const inv = invoices.find(i => i.id === invoiceId)
    if (!inv) return
    setRecurringInvoice(inv)
    setRecurrenceForm({
      frequency: inv.recurrence?.frequency || 'monthly',
      endDate: inv.recurrence?.endDate || '',
    })
  }

  async function confirmRecurrence() {
    if (!recurringInvoice) return
    try {
      // Compute the first next date based on the invoice's own date + frequency
      const baseDate = recurringInvoice.invoiceDate || new Date().toISOString().slice(0, 10)
      const d = new Date(baseDate + 'T00:00:00')
      switch (recurrenceForm.frequency) {
        case 'weekly':    d.setDate(d.getDate() + 7); break
        case 'biweekly':  d.setDate(d.getDate() + 14); break
        case 'monthly':   d.setMonth(d.getMonth() + 1); break
        case 'quarterly': d.setMonth(d.getMonth() + 3); break
        case 'yearly':    d.setFullYear(d.getFullYear() + 1); break
        default:          d.setMonth(d.getMonth() + 1)
      }
      const nextDate = d.toISOString().slice(0, 10)

      const recurrence = {
        active: true,
        frequency: recurrenceForm.frequency,
        nextDate,
        endDate: recurrenceForm.endDate || null,
        startedBy: user?.name || user?.email || 'unknown',
        startedAt: new Date().toISOString(),
      }

      await updateDoc(doc(db, 'tenants', orgId, 'invoices', recurringInvoice.id), {
        recurrence,
        updatedAt: serverTimestamp(),
      })
      setInvoices(prev => prev.map(i =>
        i.id === recurringInvoice.id ? { ...i, recurrence } : i
      ))
      setRecurringInvoice(null)
      setRecurrenceForm({ frequency: 'monthly', endDate: '' })
      toast.success(`Recurrence set — next invoice on ${nextDate}`)
    } catch (e) {
      console.error(e)
      toast.error('Failed to set recurrence: ' + (e.message || 'unknown error'))
    }
  }

  async function cancelRecurrence(invoiceId) {
    if (!window.confirm('Stop this recurrence? Existing invoices will remain but no new copies will be generated.')) return
    try {
      const { deleteField } = await import('firebase/firestore')
      await updateDoc(doc(db, 'tenants', orgId, 'invoices', invoiceId), {
        'recurrence.active': false,
        'recurrence.endedAt': new Date().toISOString(),
        'recurrence.endReason': 'cancelled by user',
        updatedAt: serverTimestamp(),
      })
      setInvoices(prev => prev.map(i =>
        i.id === invoiceId
          ? { ...i, recurrence: i.recurrence ? { ...i.recurrence, active: false } : null }
          : i
      ))
      toast.success('Recurrence cancelled')
    } catch (e) {
      console.error(e)
      toast.error('Failed to cancel recurrence: ' + (e.message || 'unknown error'))
    }
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
      {...dragHandlers}
    >
      {isDragging && (
        <DropZoneOverlay
          title="Drop invoice file here"
          subtitle="Accepts .xlsx, .xls, or .csv"
          onClose={dismissDropZone}
        />
      )}

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
                  {visibleLocations.map(l => <option key={l.name} value={l.name}>{cleanLocName(l.name)}</option>)}
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

      {/* ── Bulk action bar ── */}
      {selectedIds.size > 0 && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 12, padding: '10px 16px',
          background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 10,
          marginBottom: 12, fontSize: 13,
        }}>
          <span style={{ fontWeight: 600, color: '#1e40af' }}>
            {selectedIds.size} invoice{selectedIds.size !== 1 ? 's' : ''} selected
          </span>
          <div style={{ flex: 1 }} />
          {isDirector && (
            <button onClick={bulkApprove} style={{
              display: 'flex', alignItems: 'center', gap: 4, padding: '6px 14px',
              fontSize: 12, fontWeight: 500, borderRadius: 6,
              background: '#fff', border: '1px solid #bfdbfe', color: '#1e40af',
              cursor: 'pointer', fontFamily: 'inherit',
            }}>
              <CheckCircle size={12} /> Approve selected
            </button>
          )}
          {isDirector && (
            <button onClick={bulkMarkPaid} style={{
              display: 'flex', alignItems: 'center', gap: 4, padding: '6px 14px',
              fontSize: 12, fontWeight: 500, borderRadius: 6,
              background: '#fff', border: '1px solid #bbf7d0', color: '#166534',
              cursor: 'pointer', fontFamily: 'inherit',
            }}>
              <CheckCircle size={12} /> Mark paid
            </button>
          )}
          <button onClick={bulkExport} style={{
            display: 'flex', alignItems: 'center', gap: 4, padding: '6px 14px',
            fontSize: 12, fontWeight: 500, borderRadius: 6,
            background: '#fff', border: '1px solid #e2e8f0', color: '#475569',
            cursor: 'pointer', fontFamily: 'inherit',
          }}>
            <Download size={12} /> Export selected
          </button>
          <button onClick={() => setSelectedIds(new Set())} style={{
            padding: '6px 10px', fontSize: 12, borderRadius: 6,
            background: 'none', border: 'none', color: '#64748b',
            cursor: 'pointer', fontFamily: 'inherit',
          }}>
            Clear
          </button>
        </div>
      )}

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
                      <div key={inv.id} className={styles.kanbanCard} onClick={() => setDetailInvoice(inv.id)}>
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
                  <span
                    className={styles.vendorName}
                    onClick={e => { e.stopPropagation(); openVendorDetail(vendor) }}
                    style={{ cursor: 'pointer', textDecoration: 'none' }}
                    title="View vendor details"
                    onMouseEnter={e => e.currentTarget.style.textDecoration = 'underline'}
                    onMouseLeave={e => e.currentTarget.style.textDecoration = 'none'}
                  >
                    {vendor}
                  </span>
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
                      <th style={{ width: 32 }}>
                        <input type="checkbox"
                          checked={selectedIds.size > 0 && group.invoices.every(i => selectedIds.has(i.id))}
                          onChange={() => {
                            const allSelected = group.invoices.every(i => selectedIds.has(i.id))
                            setSelectedIds(prev => {
                              const next = new Set(prev)
                              group.invoices.forEach(i => allSelected ? next.delete(i.id) : next.add(i.id))
                              return next
                            })
                          }}
                          style={{ width: 14, height: 14, accentColor: '#1D9E75' }}
                        />
                      </th>
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
                      const isExpanded = expandedInvoice === inv.id
                      const fmtTs = (ts) => {
                        if (!ts) return null
                        const d = ts.toDate ? ts.toDate() : new Date(ts)
                        return d.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })
                      }
                      return (
                        <Fragment key={inv.id}>
                          <tr>
                            <td>
                              <input type="checkbox"
                                checked={selectedIds.has(inv.id)}
                                onChange={() => toggleSelect(inv.id)}
                                onClick={e => e.stopPropagation()}
                                style={{ width: 14, height: 14, accentColor: '#1D9E75' }}
                              />
                            </td>
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
                                {inv.status === 'Approved' && !inv.scheduledPaymentDate && (
                                  <button className={styles.btnPay} onClick={() => markPaid(inv.id)}>
                                    <CheckCircle size={12} /> Pay
                                  </button>
                                )}
                                {inv.status === 'Approved' && !inv.scheduledPaymentDate && isDirector && (
                                  <button className={styles.btnEdit} onClick={() => openScheduleModal(inv.id)} title="Schedule payment for a future date">
                                    Schedule
                                  </button>
                                )}
                                {inv.scheduledPaymentDate && (
                                  <button
                                    className={styles.btnEdit}
                                    onClick={() => cancelScheduledPayment(inv.id)}
                                    title={`Scheduled for ${inv.scheduledPaymentDate} · click to cancel`}
                                    style={{ background: '#fef3c7', borderColor: '#fcd34d', color: '#854d0e' }}
                                  >
                                    📅 {new Date(inv.scheduledPaymentDate + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                                  </button>
                                )}
                                <button className={styles.btnEdit} onClick={() => setDetailInvoice(inv.id)} title="View full details">View</button>
                                <button className={styles.btnEdit} onClick={() => handleEdit(inv)}>Edit</button>
                                <button
                                  className={styles.btnEdit}
                                  onClick={() => setExpandedInvoice(p => p === inv.id ? null : inv.id)}
                                  title="Toggle approval chain"
                                  style={{ padding: '4px 8px' }}
                                >
                                  {isExpanded ? '▲' : '▼'}
                                </button>
                              </div>
                            </td>
                          </tr>
                          {isExpanded && (
                            <tr>
                              <td colSpan={11} style={{ background: '#f8fafc', padding: '16px 20px', borderBottom: '1px solid #e2e8f0' }}>
                                <div style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', color: '#64748b', marginBottom: 12 }}>
                                  Approval Chain
                                </div>
                                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                                  {inv.createdBy && (
                                    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, fontSize: 12 }}>
                                      <div style={{ width: 22, height: 22, borderRadius: '50%', background: '#dbeafe', color: '#1e40af', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, fontWeight: 600, flexShrink: 0 }}>1</div>
                                      <div style={{ flex: 1 }}>
                                        <div style={{ color: '#0f172a', fontWeight: 500 }}>Submitted by {inv.createdBy}</div>
                                        <div style={{ color: '#64748b', fontSize: 11, marginTop: 2 }}>{fmtTs(inv.createdAt) || '—'}</div>
                                      </div>
                                    </div>
                                  )}
                                  {inv.approvedBy ? (
                                    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, fontSize: 12 }}>
                                      <div style={{ width: 22, height: 22, borderRadius: '50%', background: '#dcfce7', color: '#166534', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, fontWeight: 600, flexShrink: 0 }}>2</div>
                                      <div style={{ flex: 1 }}>
                                        <div style={{ color: '#0f172a', fontWeight: 500 }}>Approved by {inv.approvedBy}</div>
                                        <div style={{ color: '#64748b', fontSize: 11, marginTop: 2 }}>{fmtTs(inv.approvedAt) || '—'}</div>
                                      </div>
                                    </div>
                                  ) : inv.status === 'Pending' && (
                                    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, fontSize: 12 }}>
                                      <div style={{ width: 22, height: 22, borderRadius: '50%', background: '#fef3c7', color: '#854d0e', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, fontWeight: 600, flexShrink: 0 }}>2</div>
                                      <div style={{ flex: 1 }}>
                                        <div style={{ color: '#64748b', fontStyle: 'italic' }}>Awaiting approval{needsDirector ? ' (director required)' : ''}</div>
                                      </div>
                                    </div>
                                  )}
                                  {inv.paidBy ? (
                                    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, fontSize: 12 }}>
                                      <div style={{ width: 22, height: 22, borderRadius: '50%', background: '#dcfce7', color: '#166534', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, fontWeight: 600, flexShrink: 0 }}>3</div>
                                      <div style={{ flex: 1 }}>
                                        <div style={{ color: '#0f172a', fontWeight: 500 }}>Paid by {inv.paidBy}</div>
                                        <div style={{ color: '#64748b', fontSize: 11, marginTop: 2 }}>{fmtTs(inv.paidAt) || '—'}</div>
                                      </div>
                                    </div>
                                  ) : inv.status === 'Approved' && (
                                    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, fontSize: 12 }}>
                                      <div style={{ width: 22, height: 22, borderRadius: '50%', background: '#fef3c7', color: '#854d0e', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, fontWeight: 600, flexShrink: 0 }}>3</div>
                                      <div style={{ flex: 1 }}>
                                        <div style={{ color: '#64748b', fontStyle: 'italic' }}>Awaiting payment</div>
                                      </div>
                                    </div>
                                  )}
                                  {inv.updatedBy && inv.updatedBy !== inv.createdBy && (
                                    <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 4, paddingTop: 8, borderTop: '1px solid #e2e8f0' }}>
                                      Last edited by {inv.updatedBy} · {fmtTs(inv.updatedAt) || '—'}
                                    </div>
                                  )}
                                </div>
                              </td>
                            </tr>
                          )}
                        </Fragment>
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

      {/* ── Vendor detail panel (slide-out from right) ── */}
      {detailVendor && vendorForm && (() => {
        const stats = getVendorStats(detailVendor.label)
        const PAYMENT_TERMS = ['Due on receipt', 'Net 15', 'Net 30', 'Net 45', 'Net 60', 'Net 90']
        return (
          <>
            <div
              onClick={() => { setDetailVendor(null); setEditingVendor(false); setVendorForm(null) }}
              style={{
                position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.3)',
                zIndex: 990, animation: 'fadeIn 0.2s',
              }}
            />
            <div style={{
              position: 'fixed', top: 0, right: 0, bottom: 0, width: 520,
              background: '#fff', boxShadow: '-8px 0 32px rgba(0,0,0,.12)',
              zIndex: 991, display: 'flex', flexDirection: 'column',
              animation: 'slideIn 0.25s ease-out',
            }}>
              {/* Header */}
              <div style={{ padding: '20px 24px', borderBottom: '1px solid #e5e5e5', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
                <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 14 }}>
                  <div style={{ width: 48, height: 48, borderRadius: 10, background: '#e0f2fe', color: '#0369a1', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 20, fontWeight: 600, flexShrink: 0 }}>
                    {detailVendor.label[0].toUpperCase()}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 11, color: '#94a3b8', fontWeight: 500, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Vendor</div>
                    <div style={{ fontSize: 18, fontWeight: 600, color: '#0f172a' }}>{detailVendor.label}</div>
                  </div>
                </div>
                <button onClick={() => { setDetailVendor(null); setEditingVendor(false); setVendorForm(null) }} style={{ background: 'none', border: 'none', fontSize: 20, color: '#94a3b8', cursor: 'pointer', padding: 4, lineHeight: 1 }}>✕</button>
              </div>

              {/* Body */}
              <div style={{ flex: 1, overflowY: 'auto', padding: '20px 24px' }}>
                {/* Stats grid */}
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 24 }}>
                  <div style={{ padding: '14px 16px', background: '#f8fafc', borderRadius: 10, border: '1px solid #e2e8f0' }}>
                    <div style={{ fontSize: 10, color: '#94a3b8', textTransform: 'uppercase', fontWeight: 500, letterSpacing: '0.05em', marginBottom: 4 }}>YTD Spend</div>
                    <div style={{ fontSize: 18, fontWeight: 700, color: '#0f172a' }}>{fmt$(stats.ytd)}</div>
                  </div>
                  <div style={{ padding: '14px 16px', background: '#f8fafc', borderRadius: 10, border: '1px solid #e2e8f0' }}>
                    <div style={{ fontSize: 10, color: '#94a3b8', textTransform: 'uppercase', fontWeight: 500, letterSpacing: '0.05em', marginBottom: 4 }}>Outstanding</div>
                    <div style={{ fontSize: 18, fontWeight: 700, color: stats.outstanding > 0 ? '#dc2626' : '#0f172a' }}>{fmt$(stats.outstanding)}</div>
                  </div>
                  <div style={{ padding: '14px 16px', background: '#f8fafc', borderRadius: 10, border: '1px solid #e2e8f0' }}>
                    <div style={{ fontSize: 10, color: '#94a3b8', textTransform: 'uppercase', fontWeight: 500, letterSpacing: '0.05em', marginBottom: 4 }}>Total Invoices</div>
                    <div style={{ fontSize: 18, fontWeight: 700, color: '#0f172a' }}>{stats.totalCount}</div>
                    <div style={{ fontSize: 11, color: '#64748b', marginTop: 2 }}>{stats.paidCount} paid · {stats.pendingCount} pending</div>
                  </div>
                  <div style={{ padding: '14px 16px', background: '#f8fafc', borderRadius: 10, border: '1px solid #e2e8f0' }}>
                    <div style={{ fontSize: 10, color: '#94a3b8', textTransform: 'uppercase', fontWeight: 500, letterSpacing: '0.05em', marginBottom: 4 }}>Avg Days to Pay</div>
                    <div style={{ fontSize: 18, fontWeight: 700, color: '#0f172a' }}>{stats.avgDaysToPay != null ? `${stats.avgDaysToPay}d` : '—'}</div>
                  </div>
                </div>

                {/* Contact & metadata — edit mode or view mode */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                  <div style={{ fontSize: 11, color: '#94a3b8', textTransform: 'uppercase', fontWeight: 500, letterSpacing: '0.05em' }}>Contact & Details</div>
                  {isAdmin && !editingVendor && (
                    <button onClick={() => setEditingVendor(true)} style={{ fontSize: 11, padding: '4px 10px', background: 'none', border: '1px solid #e2e8f0', borderRadius: 6, color: '#475569', cursor: 'pointer' }}>Edit</button>
                  )}
                </div>

                {editingVendor ? (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 24 }}>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                      <div>
                        <label style={{ fontSize: 11, color: '#64748b', fontWeight: 500 }}>Contact name</label>
                        <input value={vendorForm.contactName} onChange={e => setVendorForm(f => ({ ...f, contactName: e.target.value }))} style={{ width: '100%', padding: '7px 10px', fontSize: 13, border: '1px solid #e2e8f0', borderRadius: 6, marginTop: 4 }} />
                      </div>
                      <div>
                        <label style={{ fontSize: 11, color: '#64748b', fontWeight: 500 }}>Phone</label>
                        <input value={vendorForm.contactPhone} onChange={e => setVendorForm(f => ({ ...f, contactPhone: e.target.value }))} style={{ width: '100%', padding: '7px 10px', fontSize: 13, border: '1px solid #e2e8f0', borderRadius: 6, marginTop: 4 }} />
                      </div>
                    </div>
                    <div>
                      <label style={{ fontSize: 11, color: '#64748b', fontWeight: 500 }}>Email</label>
                      <input type="email" value={vendorForm.contactEmail} onChange={e => setVendorForm(f => ({ ...f, contactEmail: e.target.value }))} style={{ width: '100%', padding: '7px 10px', fontSize: 13, border: '1px solid #e2e8f0', borderRadius: 6, marginTop: 4 }} />
                    </div>
                    <div>
                      <label style={{ fontSize: 11, color: '#64748b', fontWeight: 500 }}>Street address</label>
                      <input value={vendorForm.street} onChange={e => setVendorForm(f => ({ ...f, street: e.target.value }))} style={{ width: '100%', padding: '7px 10px', fontSize: 13, border: '1px solid #e2e8f0', borderRadius: 6, marginTop: 4 }} />
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: 10 }}>
                      <div>
                        <label style={{ fontSize: 11, color: '#64748b', fontWeight: 500 }}>City</label>
                        <input value={vendorForm.city} onChange={e => setVendorForm(f => ({ ...f, city: e.target.value }))} style={{ width: '100%', padding: '7px 10px', fontSize: 13, border: '1px solid #e2e8f0', borderRadius: 6, marginTop: 4 }} />
                      </div>
                      <div>
                        <label style={{ fontSize: 11, color: '#64748b', fontWeight: 500 }}>State</label>
                        <input value={vendorForm.state} maxLength={2} onChange={e => setVendorForm(f => ({ ...f, state: e.target.value.toUpperCase() }))} style={{ width: '100%', padding: '7px 10px', fontSize: 13, border: '1px solid #e2e8f0', borderRadius: 6, marginTop: 4 }} />
                      </div>
                      <div>
                        <label style={{ fontSize: 11, color: '#64748b', fontWeight: 500 }}>ZIP</label>
                        <input value={vendorForm.zip} onChange={e => setVendorForm(f => ({ ...f, zip: e.target.value }))} style={{ width: '100%', padding: '7px 10px', fontSize: 13, border: '1px solid #e2e8f0', borderRadius: 6, marginTop: 4 }} />
                      </div>
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                      <div>
                        <label style={{ fontSize: 11, color: '#64748b', fontWeight: 500 }}>Tax ID / EIN</label>
                        <input value={vendorForm.taxId} onChange={e => setVendorForm(f => ({ ...f, taxId: e.target.value }))} style={{ width: '100%', padding: '7px 10px', fontSize: 13, border: '1px solid #e2e8f0', borderRadius: 6, marginTop: 4 }} />
                      </div>
                      <div>
                        <label style={{ fontSize: 11, color: '#64748b', fontWeight: 500 }}>Payment terms</label>
                        <select value={vendorForm.paymentTerms} onChange={e => setVendorForm(f => ({ ...f, paymentTerms: e.target.value }))} style={{ width: '100%', padding: '7px 10px', fontSize: 13, border: '1px solid #e2e8f0', borderRadius: 6, marginTop: 4, background: '#fff' }}>
                          {PAYMENT_TERMS.map(t => <option key={t}>{t}</option>)}
                        </select>
                      </div>
                    </div>
                    <div>
                      <label style={{ fontSize: 11, color: '#64748b', fontWeight: 500 }}>GL Code</label>
                      <input value={vendorForm.glCode} onChange={e => setVendorForm(f => ({ ...f, glCode: e.target.value }))} style={{ width: '100%', padding: '7px 10px', fontSize: 13, border: '1px solid #e2e8f0', borderRadius: 6, marginTop: 4 }} />
                    </div>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: '#475569', cursor: 'pointer', marginTop: 4 }}>
                      <input type="checkbox" checked={vendorForm.w9OnFile} onChange={e => setVendorForm(f => ({ ...f, w9OnFile: e.target.checked }))} style={{ accentColor: '#1D9E75' }} />
                      W-9 on file
                    </label>
                    <div>
                      <label style={{ fontSize: 11, color: '#64748b', fontWeight: 500 }}>Notes</label>
                      <textarea rows={3} value={vendorForm.notes} onChange={e => setVendorForm(f => ({ ...f, notes: e.target.value }))} style={{ width: '100%', padding: '7px 10px', fontSize: 13, border: '1px solid #e2e8f0', borderRadius: 6, marginTop: 4, fontFamily: 'inherit', resize: 'vertical' }} />
                    </div>
                    <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                      <button onClick={saveVendor} style={{ flex: 1, padding: '9px 16px', fontSize: 13, fontWeight: 500, background: '#1D9E75', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer' }}>Save changes</button>
                      <button onClick={() => { setEditingVendor(false); openVendorDetail(detailVendor.label) }} style={{ padding: '9px 16px', fontSize: 13, background: '#fff', border: '1px solid #e2e8f0', borderRadius: 8, cursor: 'pointer', color: '#475569' }}>Cancel</button>
                    </div>
                  </div>
                ) : (
                  <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '10px 16px', fontSize: 13, marginBottom: 24 }}>
                    <div style={{ color: '#94a3b8' }}>Contact</div>
                    <div style={{ color: '#0f172a' }}>{detailVendor.contactName || <em style={{ color: '#cbd5e1' }}>Not set</em>}</div>
                    <div style={{ color: '#94a3b8' }}>Email</div>
                    <div style={{ color: '#0f172a' }}>{detailVendor.contactEmail ? <a href={`mailto:${detailVendor.contactEmail}`} style={{ color: '#1D9E75', textDecoration: 'none' }}>{detailVendor.contactEmail}</a> : <em style={{ color: '#cbd5e1' }}>Not set</em>}</div>
                    <div style={{ color: '#94a3b8' }}>Phone</div>
                    <div style={{ color: '#0f172a' }}>{detailVendor.contactPhone || <em style={{ color: '#cbd5e1' }}>Not set</em>}</div>
                    <div style={{ color: '#94a3b8' }}>Address</div>
                    <div style={{ color: '#0f172a' }}>
                      {detailVendor.street || detailVendor.city ? (
                        <>
                          {detailVendor.street && <div>{detailVendor.street}</div>}
                          <div>{[detailVendor.city, detailVendor.state, detailVendor.zip].filter(Boolean).join(', ')}</div>
                        </>
                      ) : <em style={{ color: '#cbd5e1' }}>Not set</em>}
                    </div>
                    <div style={{ color: '#94a3b8' }}>Tax ID</div>
                    <div style={{ color: '#0f172a', fontFamily: 'monospace', fontSize: 12 }}>{detailVendor.taxId || <em style={{ color: '#cbd5e1', fontFamily: 'inherit' }}>Not set</em>}</div>
                    <div style={{ color: '#94a3b8' }}>Payment terms</div>
                    <div style={{ color: '#0f172a' }}>{detailVendor.paymentTerms || 'Net 30'}</div>
                    <div style={{ color: '#94a3b8' }}>GL Code</div>
                    <div style={{ color: '#0f172a', fontFamily: 'monospace', fontSize: 12 }}>{detailVendor.glCode || '—'}</div>
                    <div style={{ color: '#94a3b8' }}>W-9</div>
                    <div>{detailVendor.w9OnFile ? <span style={{ color: '#166534', fontSize: 11, background: '#dcfce7', padding: '2px 8px', borderRadius: 20, fontWeight: 500 }}>On file</span> : <span style={{ color: '#854d0e', fontSize: 11, background: '#fef3c7', padding: '2px 8px', borderRadius: 20, fontWeight: 500 }}>Missing</span>}</div>
                    {detailVendor.notes && (
                      <>
                        <div style={{ color: '#94a3b8' }}>Notes</div>
                        <div style={{ color: '#475569', fontSize: 12, lineHeight: 1.5 }}>{detailVendor.notes}</div>
                      </>
                    )}
                  </div>
                )}

                {/* Recent invoices */}
                {stats.recentInvoices.length > 0 && (
                  <>
                    <div style={{ fontSize: 11, color: '#94a3b8', textTransform: 'uppercase', fontWeight: 500, letterSpacing: '0.05em', marginBottom: 12 }}>Recent invoices</div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                      {stats.recentInvoices.map(rInv => {
                        const rMeta = STATUS_META[rInv.status] || STATUS_META.Pending
                        return (
                          <div
                            key={rInv.id}
                            onClick={() => { setDetailVendor(null); setEditingVendor(false); setVendorForm(null); setDetailInvoice(rInv.id) }}
                            style={{
                              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                              padding: '10px 12px', border: '1px solid #e2e8f0', borderRadius: 8,
                              cursor: 'pointer', background: '#fff',
                            }}
                          >
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={{ fontSize: 13, fontWeight: 500, color: '#0f172a' }}>{rInv.invoiceNum || 'Untitled'}</div>
                              <div style={{ fontSize: 11, color: '#94a3b8' }}>{rInv.invoiceDate}</div>
                            </div>
                            <div style={{ fontSize: 13, fontWeight: 600, color: '#0f172a', marginRight: 10 }}>{fmt$(rInv.amount)}</div>
                            <span style={{ background: rMeta.bg, color: rMeta.color, border: `1px solid ${rMeta.border}`, padding: '2px 10px', borderRadius: 20, fontSize: 10, fontWeight: 500 }}>
                              {rInv.status}
                            </span>
                          </div>
                        )
                      })}
                    </div>
                  </>
                )}
              </div>
            </div>
          </>
        )
      })()}

      {/* ── Invoice detail panel (slide-out from right) ── */}
      {detailInvoice && (() => {
        const inv = invoices.find(i => i.id === detailInvoice) || detailInvoice
        const balance = (inv.amount || 0) - (inv.amountPaid || 0)
        const meta = STATUS_META[inv.status] || STATUS_META.Pending
        const daysOverdue = inv.dueDate ? Math.floor((new Date() - new Date(inv.dueDate)) / 86400000) : 0
        const fmtTs = (ts) => {
          if (!ts) return '—'
          const d = ts.toDate ? ts.toDate() : new Date(ts)
          return d.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })
        }
        return (
          <>
            <div
              onClick={() => setDetailInvoice(null)}
              style={{
                position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.3)',
                zIndex: 990, animation: 'fadeIn 0.2s',
              }}
            />
            <div style={{
              position: 'fixed', top: 0, right: 0, bottom: 0, width: 480,
              background: '#fff', boxShadow: '-8px 0 32px rgba(0,0,0,.12)',
              zIndex: 991, display: 'flex', flexDirection: 'column',
              animation: 'slideIn 0.25s ease-out',
            }}>
              {/* Header */}
              <div style={{ padding: '20px 24px', borderBottom: '1px solid #e5e5e5', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 11, color: '#94a3b8', fontWeight: 500, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>Invoice</div>
                  <div style={{ fontSize: 18, fontWeight: 600, color: '#0f172a', marginBottom: 4 }}>{inv.invoiceNum || 'Untitled'}</div>
                  <div style={{ fontSize: 13, color: '#64748b' }}>{inv.vendor}</div>
                </div>
                <button onClick={() => setDetailInvoice(null)} style={{ background: 'none', border: 'none', fontSize: 20, color: '#94a3b8', cursor: 'pointer', padding: 4, lineHeight: 1 }}>✕</button>
              </div>

              {/* Body */}
              <div style={{ flex: 1, overflowY: 'auto', padding: '20px 24px' }}>
                {/* Recurring badge */}
                {inv.recurrence && inv.recurrence.active && (
                  <div style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    padding: '10px 14px', background: '#eff6ff', border: '1px solid #bfdbfe',
                    borderRadius: 10, marginBottom: 16, fontSize: 12,
                  }}>
                    <div>
                      <div style={{ fontWeight: 600, color: '#1e40af', display: 'flex', alignItems: 'center', gap: 6 }}>
                        🔁 Recurring {inv.recurrence.frequency}
                      </div>
                      <div style={{ color: '#64748b', fontSize: 11, marginTop: 2 }}>
                        Next: {new Date(inv.recurrence.nextDate + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                        {inv.recurrence.endDate && ` · ends ${new Date(inv.recurrence.endDate + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`}
                      </div>
                    </div>
                    {isDirector && (
                      <button
                        onClick={() => cancelRecurrence(inv.id)}
                        style={{ fontSize: 11, padding: '4px 10px', background: '#fff', border: '1px solid #bfdbfe', borderRadius: 6, color: '#1e40af', cursor: 'pointer' }}
                      >
                        Stop
                      </button>
                    )}
                  </div>
                )}
                {inv.parentRecurringId && (
                  <div style={{
                    padding: '10px 14px', background: '#f1f5f9', border: '1px solid #e2e8f0',
                    borderRadius: 10, marginBottom: 16, fontSize: 12, color: '#64748b',
                    display: 'flex', alignItems: 'center', gap: 6,
                  }}>
                    🔁 Auto-generated from recurring invoice
                  </div>
                )}

                {/* Status + Amount block */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20, paddingBottom: 20, borderBottom: '1px solid #f1f5f9' }}>
                  <div>
                    <div style={{ fontSize: 11, color: '#94a3b8', textTransform: 'uppercase', fontWeight: 500, letterSpacing: '0.05em', marginBottom: 4 }}>Total</div>
                    <div style={{ fontSize: 28, fontWeight: 700, color: '#0f172a' }}>{fmt$(inv.amount)}</div>
                    {balance > 0 && <div style={{ fontSize: 12, color: '#dc2626', marginTop: 2 }}>{fmt$(balance)} outstanding</div>}
                  </div>
                  <span style={{ background: meta.bg, color: meta.color, border: `1px solid ${meta.border}`, padding: '6px 14px', borderRadius: 20, fontSize: 12, fontWeight: 500 }}>
                    {inv.status}
                  </span>
                </div>

                {/* Details grid */}
                <div style={{ fontSize: 11, color: '#94a3b8', textTransform: 'uppercase', fontWeight: 500, letterSpacing: '0.05em', marginBottom: 12 }}>Details</div>
                <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '10px 16px', fontSize: 13, marginBottom: 24 }}>
                  <div style={{ color: '#94a3b8' }}>Invoice date</div><div style={{ color: '#0f172a' }}>{inv.invoiceDate || '—'}</div>
                  <div style={{ color: '#94a3b8' }}>Due date</div>
                  <div style={{ color: daysOverdue > 0 && inv.status !== 'Paid' ? '#dc2626' : '#0f172a' }}>
                    {inv.dueDate || '—'}
                    {daysOverdue > 0 && inv.status !== 'Paid' && <span style={{ marginLeft: 6, fontWeight: 600 }}>+{daysOverdue}d overdue</span>}
                  </div>
                  <div style={{ color: '#94a3b8' }}>Amount paid</div><div style={{ color: '#059669' }}>{fmt$(inv.amountPaid || 0)}</div>
                  <div style={{ color: '#94a3b8' }}>GL code</div><div style={{ color: '#0f172a', fontFamily: 'monospace', fontSize: 12 }}>{inv.glCode || '—'}</div>
                  <div style={{ color: '#94a3b8' }}>PO number</div><div style={{ color: '#0f172a', fontFamily: 'monospace', fontSize: 12 }}>{inv.poNumber || '—'}</div>
                  <div style={{ color: '#94a3b8' }}>Location</div><div style={{ color: '#0f172a' }}>{inv.location ? cleanLocName(inv.location) : 'All'}</div>
                  <div style={{ color: '#94a3b8' }}>Period</div><div style={{ color: '#0f172a', fontFamily: 'monospace', fontSize: 12 }}>{inv.periodKey || '—'}</div>
                </div>

                {/* Notes */}
                {inv.notes && (
                  <>
                    <div style={{ fontSize: 11, color: '#94a3b8', textTransform: 'uppercase', fontWeight: 500, letterSpacing: '0.05em', marginBottom: 8 }}>Notes</div>
                    <div style={{ fontSize: 13, color: '#475569', background: '#f8fafc', padding: '10px 12px', borderRadius: 8, marginBottom: 24, lineHeight: 1.5 }}>{inv.notes}</div>
                  </>
                )}

                {/* Attachments */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                  <div style={{ fontSize: 11, color: '#94a3b8', textTransform: 'uppercase', fontWeight: 500, letterSpacing: '0.05em' }}>Attachments</div>
                  <label style={{
                    display: 'flex', alignItems: 'center', gap: 4,
                    fontSize: 11, color: '#1D9E75', fontWeight: 500,
                    cursor: uploadingAttachment ? 'wait' : 'pointer',
                    padding: '4px 10px', borderRadius: 6,
                    border: '1px solid #1D9E75', background: '#f0fdf4',
                  }}>
                    <Paperclip size={11} />
                    {uploadingAttachment ? 'Uploading...' : 'Attach file'}
                    <input
                      type="file"
                      accept=".pdf,image/*"
                      disabled={uploadingAttachment}
                      onChange={e => {
                        const file = e.target.files?.[0]
                        if (file) uploadAttachment(inv.id, file)
                        e.target.value = ''
                      }}
                      style={{ display: 'none' }}
                    />
                  </label>
                </div>
                <div style={{ marginBottom: 24 }}>
                  {(!inv.attachments || inv.attachments.length === 0) ? (
                    <div style={{ fontSize: 12, color: '#94a3b8', fontStyle: 'italic', padding: '12px', background: '#f8fafc', borderRadius: 8, textAlign: 'center', border: '1px dashed #e2e8f0' }}>
                      No attachments yet
                    </div>
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                      {inv.attachments.map(att => {
                        const isImage = att.contentType?.startsWith('image/')
                        const isPdf = att.contentType === 'application/pdf'
                        return (
                          <div key={att.path} style={{
                            display: 'flex', alignItems: 'center', gap: 10,
                            padding: '10px 12px', border: '1px solid #e2e8f0',
                            borderRadius: 8, background: '#fff',
                          }}>
                            {isImage ? (
                              <img
                                src={att.url}
                                alt={att.name}
                                onClick={() => setPreviewAttachment(att)}
                                style={{ width: 40, height: 40, borderRadius: 6, objectFit: 'cover', cursor: 'pointer', border: '1px solid #e2e8f0' }}
                              />
                            ) : (
                              <div
                                onClick={() => isPdf && setPreviewAttachment(att)}
                                style={{
                                  width: 40, height: 40, borderRadius: 6,
                                  background: isPdf ? '#fef2f2' : '#f1f5f9',
                                  color: isPdf ? '#dc2626' : '#64748b',
                                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                                  cursor: isPdf ? 'pointer' : 'default',
                                  flexShrink: 0,
                                }}
                              >
                                <FileText size={18} />
                              </div>
                            )}
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={{ fontSize: 13, fontWeight: 500, color: '#0f172a', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{att.name}</div>
                              <div style={{ fontSize: 11, color: '#94a3b8' }}>{fmtFileSize(att.size)} · by {att.uploadedBy}</div>
                            </div>
                            <a href={att.url} target="_blank" rel="noopener noreferrer" title="Download" style={{ color: '#64748b', padding: 6, borderRadius: 4, textDecoration: 'none' }}>
                              <Download size={14} />
                            </a>
                            <button onClick={() => deleteAttachment(inv.id, att)} title="Delete" style={{ background: 'none', border: 'none', color: '#dc2626', cursor: 'pointer', padding: 6, borderRadius: 4 }}>
                              <Trash2 size={14} />
                            </button>
                          </div>
                        )
                      })}
                    </div>
                  )}
                </div>

                {/* Approval chain */}
                <div style={{ fontSize: 11, color: '#94a3b8', textTransform: 'uppercase', fontWeight: 500, letterSpacing: '0.05em', marginBottom: 12 }}>Approval chain</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 24 }}>
                  {inv.createdBy && (
                    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, fontSize: 12 }}>
                      <div style={{ width: 24, height: 24, borderRadius: '50%', background: '#dbeafe', color: '#1e40af', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, fontWeight: 600, flexShrink: 0 }}>1</div>
                      <div style={{ flex: 1 }}>
                        <div style={{ color: '#0f172a', fontWeight: 500 }}>Submitted by {inv.createdBy}</div>
                        <div style={{ color: '#64748b', fontSize: 11 }}>{fmtTs(inv.createdAt)}</div>
                      </div>
                    </div>
                  )}
                  {inv.approvedBy ? (
                    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, fontSize: 12 }}>
                      <div style={{ width: 24, height: 24, borderRadius: '50%', background: '#dcfce7', color: '#166534', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, fontWeight: 600, flexShrink: 0 }}>2</div>
                      <div style={{ flex: 1 }}>
                        <div style={{ color: '#0f172a', fontWeight: 500 }}>Approved by {inv.approvedBy}</div>
                        <div style={{ color: '#64748b', fontSize: 11 }}>{fmtTs(inv.approvedAt)}</div>
                      </div>
                    </div>
                  ) : inv.status === 'Pending' && (
                    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, fontSize: 12 }}>
                      <div style={{ width: 24, height: 24, borderRadius: '50%', background: '#fef3c7', color: '#854d0e', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, fontWeight: 600, flexShrink: 0 }}>2</div>
                      <div style={{ flex: 1, color: '#64748b', fontStyle: 'italic' }}>Awaiting approval{inv.amount >= APPROVAL_THRESHOLD ? ' (director required)' : ''}</div>
                    </div>
                  )}
                  {inv.paidBy ? (
                    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, fontSize: 12 }}>
                      <div style={{ width: 24, height: 24, borderRadius: '50%', background: '#dcfce7', color: '#166534', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, fontWeight: 600, flexShrink: 0 }}>3</div>
                      <div style={{ flex: 1 }}>
                        <div style={{ color: '#0f172a', fontWeight: 500 }}>Paid by {inv.paidBy}</div>
                        <div style={{ color: '#64748b', fontSize: 11 }}>{fmtTs(inv.paidAt)}</div>
                      </div>
                    </div>
                  ) : inv.status === 'Approved' && (
                    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, fontSize: 12 }}>
                      <div style={{ width: 24, height: 24, borderRadius: '50%', background: '#fef3c7', color: '#854d0e', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, fontWeight: 600, flexShrink: 0 }}>3</div>
                      <div style={{ flex: 1, color: '#64748b', fontStyle: 'italic' }}>Awaiting payment</div>
                    </div>
                  )}
                </div>
              </div>

              {/* Footer actions */}
              <div style={{ padding: '16px 24px', borderTop: '1px solid #e5e5e5', display: 'flex', gap: 8, background: '#f8fafc' }}>
                {inv.status === 'Pending' && isDirector && (
                  <button onClick={() => { approve(inv.id); setDetailInvoice(null) }} style={{ flex: 1, padding: '10px 16px', fontSize: 13, fontWeight: 500, background: '#1D9E75', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontFamily: 'inherit' }}>
                    Approve
                  </button>
                )}
                {inv.status === 'Approved' && isDirector && !inv.scheduledPaymentDate && (
                  <>
                    <button onClick={() => { markPaid(inv.id); setDetailInvoice(null) }} style={{ flex: 1, padding: '10px 16px', fontSize: 13, fontWeight: 500, background: '#1D9E75', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontFamily: 'inherit' }}>
                      Mark paid
                    </button>
                    <button onClick={() => { setDetailInvoice(null); openScheduleModal(inv.id) }} style={{ padding: '10px 16px', fontSize: 13, fontWeight: 500, background: '#fff', color: '#0f172a', border: '1px solid #e2e8f0', borderRadius: 8, cursor: 'pointer', fontFamily: 'inherit' }}>
                      Schedule
                    </button>
                  </>
                )}
                {inv.status === 'Approved' && inv.scheduledPaymentDate && (
                  <div style={{ flex: 1, padding: '10px 16px', fontSize: 13, background: '#fef3c7', color: '#854d0e', border: '1px solid #fcd34d', borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <span>📅 Scheduled for {new Date(inv.scheduledPaymentDate + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</span>
                    <button onClick={() => { cancelScheduledPayment(inv.id); setDetailInvoice(null) }} style={{ fontSize: 11, padding: '4px 10px', background: '#fff', border: '1px solid #fcd34d', borderRadius: 6, color: '#854d0e', cursor: 'pointer' }}>Cancel</button>
                  </div>
                )}
                <button onClick={() => { handleEdit(inv); setDetailInvoice(null) }} style={{ padding: '10px 16px', fontSize: 13, fontWeight: 500, background: '#fff', color: '#0f172a', border: '1px solid #e2e8f0', borderRadius: 8, cursor: 'pointer', fontFamily: 'inherit' }}>
                  Edit
                </button>
                {isDirector && (!inv.recurrence || !inv.recurrence.active) && !inv.parentRecurringId && (
                  <button onClick={() => { setDetailInvoice(null); openRecurrenceModal(inv.id) }} style={{ padding: '10px 16px', fontSize: 13, fontWeight: 500, background: '#fff', color: '#0f172a', border: '1px solid #e2e8f0', borderRadius: 8, cursor: 'pointer', fontFamily: 'inherit' }} title="Set up recurring invoice">
                    🔁 Recurring
                  </button>
                )}
              </div>
            </div>
            <style>{`
              @keyframes fadeIn { from { opacity: 0 } to { opacity: 1 } }
              @keyframes slideIn { from { transform: translateX(100%) } to { transform: translateX(0) } }
            `}</style>
          </>
        )
      })()}

      {/* ── Attachment preview modal ── */}
      {previewAttachment && (
        <div
          onClick={() => setPreviewAttachment(null)}
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.85)',
            zIndex: 2000, display: 'flex', flexDirection: 'column',
            alignItems: 'center', justifyContent: 'center', padding: 40,
            animation: 'fadeIn 0.2s',
          }}
        >
          <div style={{ position: 'absolute', top: 20, right: 20, display: 'flex', gap: 10 }}>
            <a
              href={previewAttachment.url}
              target="_blank"
              rel="noopener noreferrer"
              onClick={e => e.stopPropagation()}
              style={{
                padding: '8px 16px', fontSize: 13, fontWeight: 500,
                background: 'rgba(255,255,255,0.1)', color: '#fff',
                border: '1px solid rgba(255,255,255,0.2)', borderRadius: 8,
                cursor: 'pointer', textDecoration: 'none',
                display: 'flex', alignItems: 'center', gap: 6,
              }}
            >
              <Download size={13} /> Download
            </a>
            <button
              onClick={() => setPreviewAttachment(null)}
              style={{
                padding: '8px 16px', fontSize: 13, fontWeight: 500,
                background: 'rgba(255,255,255,0.1)', color: '#fff',
                border: '1px solid rgba(255,255,255,0.2)', borderRadius: 8,
                cursor: 'pointer',
              }}
            >
              ✕ Close
            </button>
          </div>
          <div
            onClick={e => e.stopPropagation()}
            style={{
              background: '#fff', borderRadius: 12,
              width: previewAttachment.contentType === 'application/pdf' ? '90vw' : 'auto',
              maxWidth: previewAttachment.contentType === 'application/pdf' ? 1000 : '90vw',
              height: previewAttachment.contentType === 'application/pdf' ? '90vh' : 'auto',
              maxHeight: '90vh',
              overflow: 'hidden', display: 'flex', flexDirection: 'column',
            }}
          >
            <div style={{ padding: '12px 20px', borderBottom: '1px solid #e5e5e5', fontSize: 13, fontWeight: 500, color: '#0f172a' }}>
              {previewAttachment.name}
            </div>
            {previewAttachment.contentType?.startsWith('image/') ? (
              <img
                src={previewAttachment.url}
                alt={previewAttachment.name}
                style={{ maxWidth: '100%', maxHeight: 'calc(90vh - 60px)', objectFit: 'contain', display: 'block' }}
              />
            ) : previewAttachment.contentType === 'application/pdf' ? (
              <iframe
                src={previewAttachment.url}
                title={previewAttachment.name}
                style={{ width: '100%', flex: 1, border: 'none' }}
              />
            ) : (
              <div style={{ padding: 40, textAlign: 'center', color: '#64748b' }}>
                Preview not available for this file type.
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Recurrence modal ── */}
      {recurringInvoice && (
        <div
          onClick={() => { setRecurringInvoice(null); setRecurrenceForm({ frequency: 'monthly', endDate: '' }) }}
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            zIndex: 1000, padding: '1rem',
          }}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{
              background: '#fff', borderRadius: 12, width: '100%', maxWidth: 480,
              boxShadow: '0 8px 32px rgba(0,0,0,.12)', overflow: 'hidden',
            }}
          >
            <div style={{ padding: '20px 24px', borderBottom: '0.5px solid #e5e5e5', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <h2 style={{ fontSize: 16, fontWeight: 500, margin: 0 }}>Set up recurring invoice</h2>
              <button onClick={() => { setRecurringInvoice(null); setRecurrenceForm({ frequency: 'monthly', endDate: '' }) }} style={{ background: 'none', border: 'none', fontSize: 16, color: '#999', cursor: 'pointer' }}>✕</button>
            </div>
            <div style={{ padding: '24px' }}>
              <div style={{ padding: '14px 16px', background: '#f8fafc', borderRadius: 10, marginBottom: 20 }}>
                <div style={{ fontSize: 11, color: '#94a3b8', textTransform: 'uppercase', fontWeight: 500, marginBottom: 4 }}>Template invoice</div>
                <div style={{ fontSize: 14, fontWeight: 600, color: '#0f172a' }}>{recurringInvoice.vendor}</div>
                <div style={{ fontSize: 12, color: '#64748b', marginTop: 2 }}>
                  {recurringInvoice.invoiceNum || 'Untitled'} · {fmt$(recurringInvoice.amount)}
                </div>
              </div>

              <label style={{ display: 'block', fontSize: 13, fontWeight: 500, color: '#475569', marginBottom: 6 }}>Frequency</label>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 6, marginBottom: 16 }}>
                {['weekly', 'biweekly', 'monthly', 'quarterly', 'yearly'].map(f => (
                  <button
                    key={f}
                    onClick={() => setRecurrenceForm(p => ({ ...p, frequency: f }))}
                    style={{
                      padding: '10px 12px', fontSize: 12, fontWeight: 500,
                      background: recurrenceForm.frequency === f ? '#1D9E75' : '#fff',
                      color: recurrenceForm.frequency === f ? '#fff' : '#475569',
                      border: `1px solid ${recurrenceForm.frequency === f ? '#1D9E75' : '#e2e8f0'}`,
                      borderRadius: 8, cursor: 'pointer', fontFamily: 'inherit',
                      textTransform: 'capitalize',
                    }}
                  >
                    {f}
                  </button>
                ))}
              </div>

              <label style={{ display: 'block', fontSize: 13, fontWeight: 500, color: '#475569', marginBottom: 6 }}>End date <span style={{ fontWeight: 400, color: '#94a3b8' }}>(optional)</span></label>
              <input
                type="date"
                value={recurrenceForm.endDate}
                min={new Date().toISOString().slice(0, 10)}
                onChange={e => setRecurrenceForm(p => ({ ...p, endDate: e.target.value }))}
                style={{
                  width: '100%', padding: '10px 12px', fontSize: 14,
                  border: '1px solid #e2e8f0', borderRadius: 8, fontFamily: 'inherit',
                }}
              />
              <div style={{ fontSize: 11, color: '#64748b', marginTop: 8, lineHeight: 1.5 }}>
                A new invoice copy will be created automatically on each recurrence date. New copies start as "Pending" and must go through the normal approval workflow. Leave end date empty for open-ended recurrence.
              </div>
            </div>
            <div style={{ padding: '16px 24px', borderTop: '0.5px solid #e5e5e5', display: 'flex', gap: 8, justifyContent: 'flex-end', background: '#f8fafc' }}>
              <button onClick={() => { setRecurringInvoice(null); setRecurrenceForm({ frequency: 'monthly', endDate: '' }) }} style={{ padding: '9px 16px', fontSize: 13, background: '#fff', border: '1px solid #e2e8f0', borderRadius: 8, cursor: 'pointer', color: '#475569', fontFamily: 'inherit' }}>
                Cancel
              </button>
              <button onClick={confirmRecurrence} style={{ padding: '9px 20px', fontSize: 13, fontWeight: 500, background: '#1D9E75', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontFamily: 'inherit' }}>
                Set recurrence
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Schedule payment modal ── */}
      {schedulingInvoice && (
        <div
          onClick={() => { setSchedulingInvoice(null); setScheduleDate('') }}
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            zIndex: 1000, padding: '1rem',
          }}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{
              background: '#fff', borderRadius: 12, width: '100%', maxWidth: 440,
              boxShadow: '0 8px 32px rgba(0,0,0,.12)', overflow: 'hidden',
            }}
          >
            <div style={{ padding: '20px 24px', borderBottom: '0.5px solid #e5e5e5', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <h2 style={{ fontSize: 16, fontWeight: 500, margin: 0 }}>Schedule Payment</h2>
              <button onClick={() => { setSchedulingInvoice(null); setScheduleDate('') }} style={{ background: 'none', border: 'none', fontSize: 16, color: '#999', cursor: 'pointer' }}>✕</button>
            </div>
            <div style={{ padding: '24px' }}>
              <div style={{ padding: '14px 16px', background: '#f8fafc', borderRadius: 10, marginBottom: 20 }}>
                <div style={{ fontSize: 11, color: '#94a3b8', textTransform: 'uppercase', fontWeight: 500, marginBottom: 4 }}>Invoice</div>
                <div style={{ fontSize: 14, fontWeight: 600, color: '#0f172a' }}>{schedulingInvoice.vendor}</div>
                <div style={{ fontSize: 12, color: '#64748b', marginTop: 2 }}>
                  {schedulingInvoice.invoiceNum || 'Untitled'} · {fmt$(schedulingInvoice.amount)}
                </div>
              </div>
              <label style={{ display: 'block', fontSize: 13, fontWeight: 500, color: '#475569', marginBottom: 6 }}>Payment date</label>
              <input
                type="date"
                value={scheduleDate}
                min={new Date().toISOString().slice(0, 10)}
                onChange={e => setScheduleDate(e.target.value)}
                style={{
                  width: '100%', padding: '10px 12px', fontSize: 14,
                  border: '1px solid #e2e8f0', borderRadius: 8, fontFamily: 'inherit',
                }}
              />
              <div style={{ fontSize: 11, color: '#64748b', marginTop: 8, lineHeight: 1.5 }}>
                On this date, the invoice will automatically be marked as Paid and posted to the P&L. You can cancel the schedule at any time before then.
              </div>
            </div>
            <div style={{ padding: '16px 24px', borderTop: '0.5px solid #e5e5e5', display: 'flex', gap: 8, justifyContent: 'flex-end', background: '#f8fafc' }}>
              <button onClick={() => { setSchedulingInvoice(null); setScheduleDate('') }} style={{ padding: '9px 16px', fontSize: 13, background: '#fff', border: '1px solid #e2e8f0', borderRadius: 8, cursor: 'pointer', color: '#475569', fontFamily: 'inherit' }}>
                Cancel
              </button>
              <button onClick={confirmScheduledPayment} disabled={!scheduleDate} style={{ padding: '9px 20px', fontSize: 13, fontWeight: 500, background: '#1D9E75', color: '#fff', border: 'none', borderRadius: 8, cursor: scheduleDate ? 'pointer' : 'not-allowed', opacity: scheduleDate ? 1 : 0.5, fontFamily: 'inherit' }}>
                Schedule payment
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Schedule payment modal ── */}
      {schedulingInvoice && (
        <div
          onClick={() => { setSchedulingInvoice(null); setScheduleDate('') }}
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            zIndex: 1000, padding: '1rem',
          }}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{
              background: '#fff', borderRadius: 12, width: '100%', maxWidth: 440,
              boxShadow: '0 8px 32px rgba(0,0,0,.12)', overflow: 'hidden',
            }}
          >
            <div style={{ padding: '20px 24px', borderBottom: '0.5px solid #e5e5e5', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <h2 style={{ fontSize: 16, fontWeight: 500, margin: 0 }}>Schedule Payment</h2>
              <button onClick={() => { setSchedulingInvoice(null); setScheduleDate('') }} style={{ background: 'none', border: 'none', fontSize: 16, color: '#999', cursor: 'pointer' }}>✕</button>
            </div>
            <div style={{ padding: '24px' }}>
              <div style={{ padding: '14px 16px', background: '#f8fafc', borderRadius: 10, marginBottom: 20 }}>
                <div style={{ fontSize: 11, color: '#94a3b8', textTransform: 'uppercase', fontWeight: 500, marginBottom: 4 }}>Invoice</div>
                <div style={{ fontSize: 14, fontWeight: 600, color: '#0f172a' }}>{schedulingInvoice.vendor}</div>
                <div style={{ fontSize: 12, color: '#64748b', marginTop: 2 }}>
                  {schedulingInvoice.invoiceNum || 'Untitled'} · {fmt$(schedulingInvoice.amount)}
                </div>
              </div>
              <label style={{ display: 'block', fontSize: 13, fontWeight: 500, color: '#475569', marginBottom: 6 }}>Payment date</label>
              <input
                type="date"
                value={scheduleDate}
                min={new Date().toISOString().slice(0, 10)}
                onChange={e => setScheduleDate(e.target.value)}
                style={{
                  width: '100%', padding: '10px 12px', fontSize: 14,
                  border: '1px solid #e2e8f0', borderRadius: 8, fontFamily: 'inherit',
                }}
              />
              <div style={{ fontSize: 11, color: '#64748b', marginTop: 8, lineHeight: 1.5 }}>
                On this date, the invoice will automatically be marked as Paid and posted to the P&L. You can cancel the schedule at any time before then.
              </div>
            </div>
            <div style={{ padding: '16px 24px', borderTop: '0.5px solid #e5e5e5', display: 'flex', gap: 8, justifyContent: 'flex-end', background: '#f8fafc' }}>
              <button onClick={() => { setSchedulingInvoice(null); setScheduleDate('') }} style={{ padding: '9px 16px', fontSize: 13, background: '#fff', border: '1px solid #e2e8f0', borderRadius: 8, cursor: 'pointer', color: '#475569', fontFamily: 'inherit' }}>
                Cancel
              </button>
              <button onClick={confirmScheduledPayment} disabled={!scheduleDate} style={{ padding: '9px 20px', fontSize: 13, fontWeight: 500, background: '#1D9E75', color: '#fff', border: 'none', borderRadius: 8, cursor: scheduleDate ? 'pointer' : 'not-allowed', opacity: scheduleDate ? 1 : 0.5, fontFamily: 'inherit' }}>
                Schedule payment
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Import mode modal (admin only) ── */}
      {showImportModal && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          zIndex: 1000, padding: '1rem',
        }} onClick={() => { setShowImportModal(false); setPendingImportFile(null) }}>
          <div style={{
            background: '#fff', borderRadius: 12, width: '100%', maxWidth: 480,
            boxShadow: '0 8px 32px rgba(0,0,0,.12)', overflow: 'hidden',
          }} onClick={e => e.stopPropagation()}>
            <div style={{ padding: '20px 24px', borderBottom: '0.5px solid #e5e5e5', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <h2 style={{ fontSize: 16, fontWeight: 500, margin: 0 }}>Import Invoices</h2>
              <button onClick={() => { setShowImportModal(false); setPendingImportFile(null) }} style={{ background: 'none', border: 'none', fontSize: 16, color: '#999', cursor: 'pointer' }}>✕</button>
            </div>
            <div style={{ padding: '24px' }}>
              <div style={{ fontSize: 13, color: '#64748b', marginBottom: 20 }}>
                <strong>{pendingImportFile?.name}</strong> — How should these invoices be imported?
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <button
                  onClick={() => confirmImport(false)}
                  style={{
                    display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 4,
                    padding: '16px 20px', borderRadius: 10,
                    border: '1.5px solid #1D9E75', background: '#f0fdf4',
                    cursor: 'pointer', textAlign: 'left', fontFamily: 'inherit',
                  }}
                >
                  <div style={{ fontSize: 14, fontWeight: 600, color: '#0f172a' }}>Standard import</div>
                  <div style={{ fontSize: 12, color: '#64748b' }}>All invoices enter as "Pending" and go through the normal approval workflow. This is the default for day-to-day operations.</div>
                </button>
                <button
                  onClick={() => confirmImport(true)}
                  style={{
                    display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 4,
                    padding: '16px 20px', borderRadius: 10,
                    border: '1.5px solid #e2e8f0', background: '#fff',
                    cursor: 'pointer', textAlign: 'left', fontFamily: 'inherit',
                  }}
                >
                  <div style={{ fontSize: 14, fontWeight: 600, color: '#0f172a', display: 'flex', alignItems: 'center', gap: 8 }}>
                    Historical backfill
                    <span style={{ fontSize: 10, padding: '2px 8px', borderRadius: 20, background: '#fef3c7', color: '#854d0e', fontWeight: 500 }}>Admin only</span>
                  </div>
                  <div style={{ fontSize: 12, color: '#64748b' }}>Preserve original statuses from the CSV (Pending, Approved, Paid, etc.). Use this for migrating historical data from another system.</div>
                </button>
              </div>
            </div>
          </div>
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