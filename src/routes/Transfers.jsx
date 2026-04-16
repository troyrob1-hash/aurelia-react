import { useState, useEffect, useMemo } from 'react'
import { useAuthStore } from '@/store/authStore'
import { useLocations, cleanLocName } from '@/store/LocationContext'
import { useToast } from '@/components/ui/Toast'
import { usePeriod } from '@/store/PeriodContext'
import { db } from '@/lib/firebase'
import {
  collection, query, orderBy, getDocs, addDoc,
  updateDoc, doc, getDoc, setDoc, serverTimestamp
} from 'firebase/firestore'
import { Plus, Download, Search, CheckCircle, XCircle, Upload, AlertTriangle } from 'lucide-react'
import { getInventory, saveInventory } from '@/lib/inventory'
import styles from './Transfers.module.css'

const STATUSES = ['Pending', 'Approved', 'Received', 'Rejected']

const STATUS_META = {
  Pending:  { color: '#d97706', bg: '#fef3c7', border: '#fcd34d', step: 0 },
  Approved: { color: '#2563eb', bg: '#eff6ff', border: '#bfdbfe', step: 1 },
  Received: { color: '#059669', bg: '#f0fdf4', border: '#bbf7d0', step: 2 },
  Rejected: { color: '#dc2626', bg: '#fef2f2', border: '#fca5a5', step: -1 },
}

const STAGE_LABELS = ['Pending', 'Approved', 'Received']

function locId(n) { return (n || '').replace(/[^a-zA-Z0-9]/g, '_') }
const fmt$ = v => '$' + Number(v || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

function daysSince(dateStr) {
  if (!dateStr) return 0
  const d = typeof dateStr === 'string' ? new Date(dateStr) : dateStr.toDate?.() || new Date(dateStr)
  return Math.floor((Date.now() - d.getTime()) / 86400000)
}

const EMPTY = {
  date: new Date().toISOString().slice(0, 10),
  item: '', units: '', unitCost: '', from: '', to: '', notes: '', category: '',
}

export default function Transfers() {
  const { user }             = useAuthStore()
  const orgId                = user?.tenantId || 'fooda'
  const { selectedLocation, groupedLocations, visibleLocations } = useLocations()
  const { periodKey }        = usePeriod()
  const toast                = useToast()
  const isDirector           = /^(admin|director)$/i.test(user?.role || '')

  const [entries,      setEntries]      = useState([])
  const [loading,      setLoading]      = useState(false)
  const [saving,       setSaving]       = useState(false)
  const [showForm,     setShowForm]     = useState(false)
  const [form,         setForm]         = useState(EMPTY)
  const [search,       setSearch]       = useState('')
  const [filterStatus, setFilterStatus] = useState('')
  const [filterFrom,   setFilterFrom]   = useState('')
  const [filterTo,     setFilterTo]     = useState('')
  const [view,         setView]         = useState('board') // 'board' | 'timeline' | 'list'
  const [invItems,     setInvItems]     = useState([])

  const allLocs = useMemo(() => visibleLocations.map(l => l.name), [visibleLocations])
  const myLocation = selectedLocation === 'all' ? null : selectedLocation

  useEffect(() => { load() }, [periodKey])
  useEffect(() => {
    if (form.from) loadInvItems(form.from)
  }, [form.from])

  async function load() {
    setLoading(true)
    try {
      const snap = await getDocs(query(
        collection(db, 'tenants', orgId, 'transfers'),
        orderBy('date', 'desc')
      ))
      let all = snap.docs.map(d => ({ id: d.id, ...d.data() }))
      // Location isolation — managers see only their location's transfers
      if (!isDirector && myLocation) {
        all = all.filter(e => e.from === myLocation || e.to === myLocation)
      }
      setEntries(all)
    } catch { toast.error('Failed to load transfers.') }
    setLoading(false)
  }

  async function loadInvItems(location) {
    try {
      const items = await getInventory(orgId, location, periodKey)
      setInvItems(items.map(i => i.name).filter(Boolean))
    } catch { setInvItems([]) }
  }

  async function handleSave(e) {
    e.preventDefault()
    if (!form.item.trim() || !form.from || !form.to) return
    if (form.from === form.to) { toast.error('From and To locations must be different.'); return }
    setSaving(true)
    try {
      const total = (parseFloat(form.units) || 0) * (parseFloat(form.unitCost) || 0)
      const entry = {
        ...form,
        units:     parseFloat(form.units) || 0,
        unitCost:  parseFloat(form.unitCost) || 0,
        total,
        status:    'Pending',
        periodKey,
        createdBy: user?.name || user?.email || 'unknown',
        createdAt: serverTimestamp(),
        timeline:  { pending: new Date().toISOString() },
      }
      const ref = await addDoc(collection(db, 'tenants', orgId, 'transfers'), entry)
      setEntries(prev => [{ id: ref.id, ...entry }, ...prev])
      toast.success('Transfer logged — pending director approval')
      setForm(EMPTY)
      setShowForm(false)
    } catch { toast.error('Failed to save transfer.') }
    setSaving(false)
  }

  async function updateStatus(id, status) {
    if (!isDirector && status === 'Approved') {
      toast.error('Only directors can approve transfers')
      return
    }
    const now = new Date().toISOString()
    const entry = entries.find(e => e.id === id)
    const timelineUpdate = { ...(entry?.timeline || {}), [status.toLowerCase()]: now }

    await updateDoc(doc(db, 'tenants', orgId, 'transfers', id), {
      status,
      updatedAt: serverTimestamp(),
      updatedBy: user?.name || user?.email,
      timeline: timelineUpdate,
      ...(status === 'Approved'  ? { approvedBy:  user?.name || user?.email } : {}),
      ...(status === 'Received'  ? { receivedBy:  user?.name || user?.email } : {}),
      ...(status === 'Rejected'  ? { rejectedBy:  user?.name || user?.email } : {}),
    })

    // On Received — adjust inventory at both locations
    if (status === 'Received' && entry) {
      await adjustInventory(entry)
    }

    setEntries(prev => prev.map(e => e.id === id ? { ...e, status, timeline: timelineUpdate } : e))
    toast.success(`Transfer ${status.toLowerCase()}`)
  }

  async function adjustInventory(transfer) {
    try {
      // Deduct from sending location
      const fromItems = await getInventory(orgId, transfer.from, periodKey)
      const fromIdx   = fromItems.findIndex(i => i.name?.toLowerCase() === transfer.item?.toLowerCase())
      if (fromIdx !== -1) {
        fromItems[fromIdx] = { ...fromItems[fromIdx], qty: Math.max(0, (fromItems[fromIdx].qty || 0) - transfer.units) }
        await saveInventory(orgId, transfer.from, fromItems, user, periodKey)
      }

      // Add to receiving location
      const toItems = await getInventory(orgId, transfer.to, periodKey)
      const toIdx   = toItems.findIndex(i => i.name?.toLowerCase() === transfer.item?.toLowerCase())
      if (toIdx !== -1) {
        toItems[toIdx] = { ...toItems[toIdx], qty: (toItems[toIdx].qty || 0) + transfer.units }
        await saveInventory(orgId, transfer.to, toItems, user, periodKey)
      }
    } catch { /* non-critical — inventory adjustment failed silently */ }
  }

  async function handleImport(e) {
    const file = e.target.files[0]
    if (!file) return
    try {
      const XLSX = await import('xlsx')
      const ab   = await file.arrayBuffer()
      const wb   = XLSX.read(new Uint8Array(ab), { type: 'array' })
      const ws   = wb.Sheets[wb.SheetNames[0]]
      const rows = XLSX.utils.sheet_to_json(ws, { raw: false })
      let imported = 0
      for (const row of rows) {
        const item = row['Item'] || row['item'] || ''
        const from = row['From'] || row['from'] || ''
        const to   = row['To']   || row['to']   || ''
        if (!item || !from || !to) continue
        const units    = parseFloat(row['Units'] || row['units'] || 0)
        const unitCost = parseFloat(row['Unit Cost'] || row['unit_cost'] || 0)
        const entry = {
          date: row['Date'] || new Date().toISOString().slice(0, 10),
          item, from, to, units, unitCost,
          total: units * unitCost,
          notes: row['Notes'] || '',
          status: 'Pending', periodKey,
          createdBy: user?.name || user?.email,
          createdAt: serverTimestamp(),
          timeline: { pending: new Date().toISOString() },
        }
        const ref = await addDoc(collection(db, 'tenants', orgId, 'transfers'), entry)
        setEntries(prev => [{ id: ref.id, ...entry }, ...prev])
        imported++
      }
      toast.success(`Imported ${imported} transfers`)
    } catch { toast.error('Import failed — check file format') }
    e.target.value = ''
  }

  function exportCSV() {
    const rows = [
      ['Date', 'Item', 'Units', 'Unit Cost', 'Total', 'From', 'To', 'Status', 'Notes', 'Period'],
      ...filtered.map(e => [e.date, e.item, e.units, e.unitCost, (e.total||0).toFixed(2), e.from, e.to, e.status, e.notes||'', e.periodKey||''])
    ]
    const csv  = rows.map(r => r.map(v => `"${v ?? ''}"`).join(',')).join('\n')
    const blob = new Blob([csv], { type: 'text/csv' })
    const url  = URL.createObjectURL(blob)
    Object.assign(document.createElement('a'), { href: url, download: `transfers-${periodKey}.csv` }).click()
    URL.revokeObjectURL(url)
  }

  // ── Derived ──────────────────────────────────────────────────
  const filtered = useMemo(() => entries.filter(e => {
    if (filterStatus && e.status !== filterStatus) return false
    if (filterFrom   && e.from  !== filterFrom)    return false
    if (filterTo     && e.to    !== filterTo)       return false
    if (search && !e.item?.toLowerCase().includes(search.toLowerCase()) &&
        !e.from?.toLowerCase().includes(search.toLowerCase()) &&
        !e.to?.toLowerCase().includes(search.toLowerCase())) return false
    return true
  }), [entries, filterStatus, filterFrom, filterTo, search])

  const totalValue    = filtered.reduce((s, e) => s + (e.total || 0), 0)
  const pendingCount  = filtered.filter(e => e.status === 'Pending').length
  const approvedCount = filtered.filter(e => e.status === 'Approved').length

  // Transfer aging — approved but not received after 2 days
  const aging = filtered.filter(e => {
    if (e.status !== 'Approved') return false
    const approvedAt = e.timeline?.approved
    return approvedAt && daysSince(approvedAt) >= 2
  })

  // Location balance — net send/receive value per location
  const locationBalance = useMemo(() => {
    const balance = {}
    entries.filter(e => e.status === 'Received').forEach(e => {
      if (!balance[e.from]) balance[e.from] = { sent: 0, received: 0 }
      if (!balance[e.to])   balance[e.to]   = { sent: 0, received: 0 }
      balance[e.from].sent     += e.total || 0
      balance[e.to].received   += e.total || 0
    })
    return Object.entries(balance).map(([loc, b]) => ({
      loc, net: b.received - b.sent, sent: b.sent, received: b.received,
    })).sort((a, b) => b.net - a.net)
  }, [entries])

  // Kanban columns
  const kanbanCols = useMemo(() => {
    const cols = { Pending: [], Approved: [], Received: [] }
    filtered.forEach(e => { if (cols[e.status]) cols[e.status].push(e) })
    return cols
  }, [filtered])

  return (
    <div className={styles.page}>

      {/* ── Header ── */}
      <div className={styles.header}>
        <div>
          <h1 className={styles.title}>Transfer Log</h1>
          <p className={styles.subtitle}>
            Inventory transfers between locations · {periodKey}
          </p>
        </div>
        <div className={styles.actions}>
          <div className={styles.viewToggle}>
            <button className={`${styles.viewBtn} ${view==='board'?styles.viewActive:''}`} onClick={()=>setView('board')}>Board</button>
            <button className={`${styles.viewBtn} ${view==='timeline'?styles.viewActive:''}`} onClick={()=>setView('timeline')}>Timeline</button>
            <button className={`${styles.viewBtn} ${view==='list'?styles.viewActive:''}`} onClick={()=>setView('list')}>List</button>
          </div>
          <button className={styles.btnIcon} onClick={exportCSV} title="Export CSV"><Download size={15}/></button>
          <label className={styles.btnSecondary}>
            <Upload size={13}/> Import
            <input type="file" accept=".xlsx,.xls,.csv" style={{display:'none'}} onChange={handleImport}/>
          </label>
          <button className={styles.btnPrimary} onClick={()=>setShowForm(v=>!v)}>
            <Plus size={15}/> Log Transfer
          </button>
        </div>
      </div>

      {/* ── Aging alert ── */}
      {aging.length > 0 && (
        <div className={styles.agingAlert}>
          <AlertTriangle size={14}/>
          <span><strong>{aging.length} transfer{aging.length>1?'s':''}</strong> approved but not received in 2+ days: {aging.map(e => e.item).join(', ')}</span>
        </div>
      )}

      {/* ── KPI bar ── */}
      <div className={styles.kpiBar}>
        <div className={`${styles.kpi} ${styles.kpiDark}`}>
          <div className={styles.kpiL}>Total Value</div>
          <div className={styles.kpiV}>{fmt$(totalValue)}</div>
          <div className={styles.kpiSub}>{filtered.length} transfers this period</div>
        </div>
        <div className={styles.kpi}>
          <div className={styles.kpiL}>Pending Approval</div>
          <div className={styles.kpiV} style={{color: pendingCount > 0 ? '#d97706' : undefined}}>{pendingCount}</div>
          {!isDirector && pendingCount > 0 && <div className={styles.kpiSub}>Awaiting director</div>}
        </div>
        <div className={styles.kpi}>
          <div className={styles.kpiL}>Approved</div>
          <div className={styles.kpiV} style={{color: '#2563eb'}}>{approvedCount}</div>
          <div className={styles.kpiSub}>Ready to receive</div>
        </div>
        <div className={styles.kpi}>
          <div className={styles.kpiL}>Received</div>
          <div className={styles.kpiV} style={{color: '#059669'}}>{filtered.filter(e=>e.status==='Received').length}</div>
          <div className={styles.kpiSub}>Inventory adjusted</div>
        </div>
      </div>

      {/* ── Form ── */}
      {showForm && (
        <div className={styles.formCard}>
          <div className={styles.formTitle}>Log Transfer</div>
          <form onSubmit={handleSave}>
            <div className={styles.grid}>
              <div className={styles.field}>
                <label>Date</label>
                <input type="date" value={form.date} onChange={e=>setForm(f=>({...f,date:e.target.value}))} required/>
              </div>
              <div className={styles.field} style={{gridColumn:'span 2'}}>
                <label>Item</label>
                <input type="text" value={form.item} onChange={e=>setForm(f=>({...f,item:e.target.value}))}
                  placeholder="Item name" required autoFocus list="inv-items"/>
                <datalist id="inv-items">
                  {invItems.map(i => <option key={i} value={i}/>)}
                </datalist>
              </div>
              <div className={styles.field}>
                <label>Units</label>
                <input type="number" min="0" step="0.1" value={form.units} onChange={e=>setForm(f=>({...f,units:e.target.value}))} placeholder="0"/>
              </div>
              <div className={styles.field}>
                <label>Unit Cost ($)</label>
                <input type="number" min="0" step="0.01" value={form.unitCost} onChange={e=>setForm(f=>({...f,unitCost:e.target.value}))} placeholder="0.00"/>
              </div>
              <div className={styles.field}>
                <label>Total</label>
                <div className={styles.totalDisplay}>{fmt$((parseFloat(form.units)||0)*(parseFloat(form.unitCost)||0))}</div>
              </div>
              <div className={styles.field}>
                <label>From Location</label>
                <select value={form.from} onChange={e=>setForm(f=>({...f,from:e.target.value}))} required>
                  <option value="">Select...</option>
                  {allLocs.map(l=><option key={l} value={l}>{cleanLocName(l)}</option>)}
                </select>
              </div>
              <div className={styles.field}>
                <label>To Location</label>
                <select value={form.to} onChange={e=>setForm(f=>({...f,to:e.target.value}))} required>
                  <option value="">Select...</option>
                  {allLocs.filter(l=>l!==form.from).map(l=><option key={l} value={l}>{cleanLocName(l)}</option>)}
                </select>
              </div>
              <div className={styles.field}>
                <label>Notes</label>
                <input type="text" value={form.notes} onChange={e=>setForm(f=>({...f,notes:e.target.value}))} placeholder="Optional"/>
              </div>
            </div>
            <div className={styles.formActions}>
              <button type="button" className={styles.btnCancel} onClick={()=>{setShowForm(false);setForm(EMPTY)}}>Cancel</button>
              <button type="submit" className={styles.btnPrimary} disabled={saving}>{saving?'Saving...':'Log Transfer'}</button>
            </div>
          </form>
        </div>
      )}

      {/* ── Toolbar ── */}
      <div className={styles.toolbar}>
        <div className={styles.searchWrap}>
          <Search size={14} className={styles.searchIcon}/>
          <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search item, location..." className={styles.search}/>
        </div>
        <select value={filterStatus} onChange={e=>setFilterStatus(e.target.value)} className={styles.filter}>
          <option value="">All Statuses</option>
          {STATUSES.map(s=><option key={s}>{s}</option>)}
        </select>
        <select value={filterFrom} onChange={e=>setFilterFrom(e.target.value)} className={styles.filter}>
          <option value="">From: All</option>
          {allLocs.map(l=><option key={l} value={l}>{cleanLocName(l)}</option>)}
        </select>
        <select value={filterTo} onChange={e=>setFilterTo(e.target.value)} className={styles.filter}>
          <option value="">To: All</option>
          {allLocs.map(l=><option key={l} value={l}>{cleanLocName(l)}</option>)}
        </select>
      </div>

      {loading ? <div className={styles.loading}>Loading...</div> : (
        <>
          {/* ── BOARD VIEW ── */}
          {view === 'board' && (
            <div className={styles.board}>
              {['Pending', 'Approved', 'Received'].map(status => {
                const meta  = STATUS_META[status]
                const cards = kanbanCols[status] || []
                const colTotal = cards.reduce((s, e) => s + (e.total || 0), 0)
                return (
                  <div key={status} className={styles.boardCol}>
                    <div className={styles.boardColHeader} style={{borderTopColor: meta.color}}>
                      <span className={styles.boardColTitle} style={{color: meta.color}}>{status}</span>
                      <span className={styles.boardColMeta}>{cards.length} · {fmt$(colTotal)}</span>
                    </div>
                    <div className={styles.boardCards}>
                      {cards.map(e => {
                        const isAging = status === 'Approved' && e.timeline?.approved && daysSince(e.timeline.approved) >= 2
                        return (
                          <div key={e.id} className={`${styles.card} ${isAging ? styles.cardAging : ''}`}>
                            <div className={styles.cardHeader}>
                              <span className={styles.cardItem}>{e.item}</span>
                              <span className={styles.cardTotal}>{fmt$(e.total || 0)}</span>
                            </div>
                            <div className={styles.cardRoute}>
                              <span className={styles.cardFrom}>{cleanLocName(e.from)}</span>
                              <span className={styles.cardArrow}>→</span>
                              <span className={styles.cardTo}>{cleanLocName(e.to)}</span>
                            </div>
                            <div className={styles.cardMeta}>
                              <span>{e.units} units · {e.date}</span>
                              {isAging && <span className={styles.cardAgingBadge}>⚠ {daysSince(e.timeline?.approved)}d waiting</span>}
                            </div>
                            {e.notes && <div className={styles.cardNotes}>{e.notes}</div>}
                            <div className={styles.cardActions}>
                              {status === 'Pending' && isDirector && (
                                <>
                                  <button className={styles.btnApprove} onClick={()=>updateStatus(e.id,'Approved')}><CheckCircle size={12}/> Approve</button>
                                  <button className={styles.btnReject}  onClick={()=>updateStatus(e.id,'Rejected')}><XCircle size={12}/> Reject</button>
                                </>
                              )}
                              {status === 'Approved' && (
                                <button className={styles.btnReceive} onClick={()=>updateStatus(e.id,'Received')}><CheckCircle size={12}/> Mark Received</button>
                              )}
                            </div>
                          </div>
                        )
                      })}
                      {cards.length === 0 && <div className={styles.boardEmpty}>No transfers</div>}
                    </div>
                  </div>
                )
              })}
            </div>
          )}

          {/* ── TIMELINE VIEW ── */}
          {view === 'timeline' && (
            <div className={styles.timelineWrap}>
              {filtered.length === 0 && <div className={styles.loading}>No transfers found</div>}
              {filtered.map(e => {
                const meta     = STATUS_META[e.status] || STATUS_META.Pending
                const isRej    = e.status === 'Rejected'
                const curStep  = isRej ? -1 : meta.step
                const isAging  = e.status === 'Approved' && e.timeline?.approved && daysSince(e.timeline.approved) >= 2

                return (
                  <div key={e.id} className={`${styles.timelineCard} ${isAging ? styles.timelineCardAging : ''}`}>
                    {/* Left — item info */}
                    <div className={styles.tlLeft}>
                      <div className={styles.tlItem}>{e.item}</div>
                      <div className={styles.tlRoute}>
                        <span className={styles.tlFrom}>{cleanLocName(e.from)}</span>
                        <span className={styles.tlArrow}>→</span>
                        <span className={styles.tlTo}>{cleanLocName(e.to)}</span>
                      </div>
                      <div className={styles.tlMeta}>{e.units} units · {fmt$(e.total || 0)} · {e.date}</div>
                      {e.notes && <div className={styles.tlNotes}>{e.notes}</div>}
                    </div>

                    {/* Center — journey pipeline */}
                    <div className={styles.tlPipeline}>
                      {isRej ? (
                        <div className={styles.tlRejected}>
                          <span className={styles.tlRejBadge}>✕ Rejected</span>
                          {e.timeline?.rejected && <span className={styles.tlStageTime}>{new Date(e.timeline.rejected).toLocaleDateString('en-US',{month:'short',day:'numeric'})}</span>}
                        </div>
                      ) : (
                        STAGE_LABELS.map((stage, idx) => {
                          const done    = curStep >= idx
                          const current = curStep === idx
                          const tsKey   = stage.toLowerCase()
                          const ts      = e.timeline?.[tsKey]
                          return (
                            <div key={stage} className={styles.tlStage}>
                              {idx > 0 && <div className={`${styles.tlConnector} ${curStep >= idx ? styles.tlConnectorDone : ''}`}/>}
                              <div className={`${styles.tlDot} ${done ? styles.tlDotDone : ''} ${current ? styles.tlDotCurrent : ''}`}
                                style={done ? {background: STATUS_META[stage]?.color, borderColor: STATUS_META[stage]?.color} : {}}>
                                {done && <CheckCircle size={10} color="white"/>}
                              </div>
                              <div className={styles.tlStageLabel} style={{color: done ? STATUS_META[stage]?.color : '#bbb'}}>{stage}</div>
                              {ts && <div className={styles.tlStageTime}>{new Date(ts).toLocaleDateString('en-US',{month:'short',day:'numeric'})}</div>}
                            </div>
                          )
                        })
                      )}
                    </div>

                    {/* Right — actions */}
                    <div className={styles.tlRight}>
                      <span className={styles.tlBadge} style={{background: meta.bg, color: meta.color, border: `1px solid ${meta.border}`}}>
                        {e.status}
                      </span>
                      {isAging && <span className={styles.tlAgingTag}>⚠ {daysSince(e.timeline?.approved)}d</span>}
                      <div className={styles.tlActions}>
                        {e.status === 'Pending' && isDirector && (
                          <>
                            <button className={styles.btnApprove} onClick={()=>updateStatus(e.id,'Approved')}><CheckCircle size={11}/> Approve</button>
                            <button className={styles.btnReject}  onClick={()=>updateStatus(e.id,'Rejected')}><XCircle size={11}/> Reject</button>
                          </>
                        )}
                        {e.status === 'Approved' && (
                          <button className={styles.btnReceive} onClick={()=>updateStatus(e.id,'Received')}><CheckCircle size={11}/> Received</button>
                        )}
                      </div>
                    </div>
                  </div>
                )
              })}

              {/* Location balance */}
              {locationBalance.length > 0 && (
                <div className={styles.balanceCard}>
                  <div className={styles.balanceTitle}>Location Net Balance (Received transfers)</div>
                  <div className={styles.balanceGrid}>
                    {locationBalance.map(b => (
                      <div key={b.loc} className={styles.balanceRow}>
                        <span className={styles.balanceLoc}>{cleanLocName(b.loc)}</span>
                        <div className={styles.balanceBars}>
                          <div className={styles.balanceSent}>↑ {fmt$(b.sent)} sent</div>
                          <div className={styles.balanceReceived}>↓ {fmt$(b.received)} received</div>
                        </div>
                        <span className={`${styles.balanceNet} ${b.net >= 0 ? styles.balancePos : styles.balanceNeg}`}>
                          {b.net >= 0 ? '+' : ''}{fmt$(b.net)}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ── LIST VIEW ── */}
          {view === 'list' && (
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>#</th><th>Date</th><th>Item</th><th>Units</th><th>Total</th>
                    <th>From</th><th>To</th><th>Status</th><th>Notes</th><th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((e, i) => {
                    const meta    = STATUS_META[e.status] || STATUS_META.Pending
                    const isAging = e.status === 'Approved' && e.timeline?.approved && daysSince(e.timeline.approved) >= 2
                    return (
                      <tr key={e.id} className={isAging ? styles.rowAging : ''}>
                        <td className={styles.rowNum}>{i + 1}</td>
                        <td className={styles.muted}>{e.date}</td>
                        <td className={styles.itemCell}>{e.item}</td>
                        <td>{e.units}</td>
                        <td className={styles.totalCell}>{fmt$(e.total || 0)}</td>
                        <td><span className={styles.pillFrom}>{cleanLocName(e.from)}</span></td>
                        <td><span className={styles.pillTo}>{cleanLocName(e.to)}</span></td>
                        <td>
                          <span className={styles.statusBadge} style={{background: meta.bg, color: meta.color, border: `1px solid ${meta.border}`}}>
                            {e.status}
                          </span>
                          {isAging && <span className={styles.agingTag}>⚠ {daysSince(e.timeline?.approved)}d</span>}
                        </td>
                        <td className={styles.muted}>{e.notes || '—'}</td>
                        <td>
                          <div className={styles.actionRow}>
                            {e.status === 'Pending' && isDirector && (
                              <>
                                <button className={styles.btnApprove} onClick={()=>updateStatus(e.id,'Approved')}><CheckCircle size={12}/></button>
                                <button className={styles.btnReject}  onClick={()=>updateStatus(e.id,'Rejected')}><XCircle size={12}/></button>
                              </>
                            )}
                            {e.status === 'Approved' && (
                              <button className={styles.btnReceive} onClick={()=>updateStatus(e.id,'Received')}><CheckCircle size={12}/></button>
                            )}
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                  {filtered.length === 0 && (
                    <tr><td colSpan={10} className={styles.emptyRow}>No transfers found</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  )
}