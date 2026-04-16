import { useState, useMemo, useEffect } from 'react'
import { useToast } from '@/components/ui/Toast'
import { Upload, Download, CheckCircle, Clock, AlertCircle, RefreshCw, Plus } from 'lucide-react'
import { useLocations } from '@/store/LocationContext'
import { useAuthStore } from '@/store/authStore'
import { usePeriod } from '@/store/PeriodContext'
import { writeLaborPnL } from '@/lib/pnl'
import { db } from '@/lib/firebase'
import {
  doc, getDoc, collection, addDoc, updateDoc,
  query, where, orderBy, limit, getDocs, serverTimestamp
} from 'firebase/firestore'
import styles from './LaborPlanner.module.css'

const PERIOD_OPTS = ['Weekly', 'Monthly', 'Period to date']

const INTEGRATIONS = [
  { key: '7shifts', label: '7shifts' },
  { key: 'adp',     label: 'ADP'    },
  { key: 'gusto',   label: 'Gusto'  },
]

const DEFAULT_GL_MAP = {
  '50410': { label: 'Onsite Labor (Fooda)', section: 'Location Costs' },
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
  const orgId = user?.tenantId || 'fooda'
  const { selectedLocation } = useLocations()
  const location = selectedLocation === 'all' ? null : selectedLocation

  // ── Fix 1: use periodKey from PeriodContext ──────────────────
  const { periodKey } = usePeriod()

  const [periodView, setPeriodView]   = useState('Weekly')
  const [rows, setRows]               = useState([])
  const [source, setSource]           = useState('')
  const [importedAt, setImportedAt]   = useState(null)
  const [importedBy, setImportedBy]   = useState('')
  const [approvalStatus, setApproval] = useState(null)
  const [submissionId, setSubmissionId] = useState(null)
  const [rejectedReason, setRejectedReason] = useState('')
  const [glMap, setGlMap]             = useState(DEFAULT_GL_MAP)
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
      try {
        const snap = await getDoc(doc(db, 'tenants', orgId, 'budgets', `labor_${periodKey}`))
        if (snap.exists()) setBudgets(snap.data().glBudgets || {})
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
          where('status', 'in', ['pending', 'approved', 'rejected']),
          orderBy('createdAt', 'desc'),
          limit(1)
        )
        const snap = await getDocs(q)
        if (!snap.empty) {
          const d = snap.docs[0].data()
          setSubmissionId(snap.docs[0].id)
          setRows(d.glRows || [])
          setSource(d.fileName || '')
          setImportedBy(d.importedBy || '')
          setImportedAt(d.createdAt?.toDate() || null)
          setApproval(d.status)
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
      const ws   = wb.Sheets[wb.SheetNames[0]]
      const data = XLSX.utils.sheet_to_json(ws, { raw: false })

      const parsed = []
      data.forEach(row => {
        const glRaw = String(row['GL Code'] || row['GL'] || row['Account'] || row['gl_code'] || '').trim()
        const gl    = Object.keys(glMap).find(k => glRaw.includes(k))
        const amount = parseFloat(row['Amount'] || row['amount'] || row['Value'] || row['value'] || 0)
        const desc   = row['Description'] || row['description'] || row['Desc'] || glMap[gl]?.label || glRaw
        if (glRaw || amount) {
          parsed.push({ gl: gl || glRaw, label: desc, amount, section: glMap[gl]?.section || 'Other' })
        }
      })

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

      toast.success(`Imported ${parsed.length} GL lines — pending director approval`)
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
      toast.success('Labor approved and posted to P&L')
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

  const sections = useMemo(() => {
    const s = {}
    rows.forEach(r => {
      if (!s[r.section]) s[r.section] = []
      s[r.section].push(r)
    })
    return s
  }, [rows])

  const totalOnsite   = rows.filter(r => r.gl?.startsWith('504') && r.gl !== '50420').reduce((s, r) => s + r.amount, 0)
  const total3rd      = rows.find(r => r.gl === '50420')?.amount || 0
  const totalBenTax   = rows.filter(r => r.gl?.startsWith('68')).reduce((s, r) => s + r.amount, 0)
  const grandTotal    = rows.reduce((s, r) => s + r.amount, 0)
  const budgetTotal   = rows.reduce((s, r) => s + (budgets[r.gl] || 0), 0)
  const grandVariance = grandTotal - budgetTotal

  const importedAtStr = importedAt
    ? importedAt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) +
      ' at ' + importedAt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
    : null

  const isDirector = /^(admin|director)$/i.test(user?.role || '')

  return (
    <div className={styles.page}>

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
          {approvalStatus !== 'approved' && (
            <label className={styles.btnImport}>
              <Upload size={14} /> Import Labor Report
              <input type="file" accept=".csv,.xlsx,.xls" style={{ display: 'none' }} onChange={handleImport} />
            </label>
          )}
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
              {approvalStatus === 'pending'  && 'Pending director approval before posting to P&L'}
              {approvalStatus === 'approved' && 'Approved and posted to P&L'}
              {approvalStatus === 'rejected' && `Rejected${rejectedReason ? ` — "${rejectedReason}"` : ''} · Re-import to resubmit`}
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
        <div className={`${styles.kpi} ${styles.kpiPrimary}`}>
          <div className={styles.kpiL}>Total Labor</div>
          <div className={styles.kpiV}>{rows.length ? `$${fmt(grandTotal)}` : '—'}</div>
          <div className={styles.kpiSub}>{rows.length ? pct(grandTotal, gfsSales) : '—'} of GFS</div>
          {budgetTotal > 0 && (
            <div className={`${styles.kpiBadge} ${grandVariance > 0 ? styles.kpiBadgeOver : styles.kpiBadgeUnder}`}>
              {grandVariance > 0 ? '▲ Over' : '▼ Under'} budget ${fmt(Math.abs(grandVariance))}
            </div>
          )}
        </div>
        <div className={styles.kpi}>
          <div className={styles.kpiL}>Onsite Labor</div>
          <div className={styles.kpiV}>{rows.length ? `$${fmt(totalOnsite)}` : '—'}</div>
          <div className={styles.kpiSub}>{rows.length ? pct(totalOnsite, gfsSales) : '—'} of GFS</div>
        </div>
        <div className={styles.kpi}>
          <div className={styles.kpiL}>3rd Party Labor</div>
          <div className={styles.kpiV}>{rows.length ? `$${fmt(total3rd)}` : '—'}</div>
          <div className={styles.kpiSub}>{rows.length ? pct(total3rd, gfsSales) : '—'} of GFS</div>
        </div>
        <div className={styles.kpi}>
          <div className={styles.kpiL}>Benefits &amp; Tax</div>
          <div className={styles.kpiV}>{rows.length ? `$${fmt(totalBenTax)}` : '—'}</div>
          <div className={styles.kpiSub}>{rows.length ? pct(totalBenTax, gfsSales) : '—'} of GFS</div>
        </div>
        <div className={styles.kpi}>
          <div className={styles.kpiL}>GL Lines</div>
          <div className={styles.kpiV} style={{ color: '#7c3aed' }}>{rows.length || '—'}</div>
          <div className={styles.kpiSub}>{Object.keys(sections).length || '—'} sections</div>
        </div>
      </div>

      {/* ── GL structure shell (no data) or populated table ── */}
      {rows.length === 0 ? (
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
                      return (
                        <tr key={i}>
                          <td className={styles.glCode}>{r.gl || '—'}</td>
                          <td className={styles.desc}>{r.label}</td>
                          <td style={{ textAlign: 'right', fontWeight: 700 }}>${fmt(r.amount)}</td>
                          <td style={{ textAlign: 'right', color: '#999' }}>{bud ? `$${fmt(bud)}` : '—'}</td>
                          <td style={{ textAlign: 'right' }}>
                            {bud ? <span className={varianceCls(v)}>{varianceArrow(v)}</span> : <span style={{ color: '#ccc' }}>—</span>}
                          </td>
                          <td style={{ textAlign: 'right', color: '#999' }}>{pct(r.amount, gfsSales)}</td>
                        </tr>
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
                <button className={styles.btnApprove} onClick={handleApprove}>Approve &amp; Post to P&L</button>
                <button className={styles.btnReject} onClick={() => setShowRejectModal(true)}>Reject</button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}