import { useState, useEffect, useMemo } from 'react'
import { useAuthStore } from '@/store/authStore'
import { useLocations, cleanLocName } from '@/store/LocationContext'
import { useToast } from '@/components/ui/Toast'
import { db } from '@/lib/firebase'
import { collection, query, orderBy, getDocs, addDoc, updateDoc, doc, serverTimestamp } from 'firebase/firestore'
import { Plus, Download, Search, CheckCircle, XCircle, Truck } from 'lucide-react'
import styles from './Transfers.module.css'

const STATUSES = ['Pending','Approved','In Transit','Received','Rejected']

const STATUS_META = {
  Pending:     { color:'#d97706', bg:'#fef3c7' },
  Approved:    { color:'#2563eb', bg:'#eff6ff' },
  'In Transit':{ color:'#7c3aed', bg:'#faf5ff' },
  Received:    { color:'#059669', bg:'#f0fdf4' },
  Rejected:    { color:'#dc2626', bg:'#fef2f2' },
}

const EMPTY = {
  date: new Date().toISOString().slice(0,10),
  item:'', units:'', unitCost:'', from:'', to:'', notes:'', status:'Pending'
}

export default function Transfers() {
  const { user }             = useAuthStore()
  const { groupedLocations } = useLocations()
  const toast                = useToast()
  const [entries,      setEntries]      = useState([])
  const [loading,      setLoading]      = useState(false)
  const [saving,       setSaving]       = useState(false)
  const [showForm,     setShowForm]     = useState(false)
  const [form,         setForm]         = useState(EMPTY)
  const [search,       setSearch]       = useState('')
  const [filterStatus, setFilterStatus] = useState('')
  const [filterFrom,   setFilterFrom]   = useState('')
  const [filterTo,     setFilterTo]     = useState('')
  const [dateFrom,     setDateFrom]     = useState('')
  const [dateTo,       setDateTo]       = useState('')

  const allLocs = useMemo(() => Object.values(groupedLocations).flat(), [groupedLocations])

  useEffect(() => { load() }, [])

  async function load() {
    setLoading(true)
    try {
      const snap = await getDocs(query(collection(db,'tenants','fooda','transfers'), orderBy('date','desc')))
      setEntries(snap.docs.map(d => ({ id:d.id, ...d.data() })))
    } catch(e) { toast.error('Failed to load transfers.') }
    setLoading(false)
  }

  async function handleSave(e) {
    e.preventDefault()
    if (!form.item.trim() || !form.from || !form.to) return
    if (form.from === form.to) { toast.error('From and To locations must be different.'); return }
    setSaving(true)
    try {
      const total = (parseFloat(form.units)||0) * (parseFloat(form.unitCost)||0)
      const entry = {
        ...form,
        units:     parseFloat(form.units) || 0,
        unitCost:  parseFloat(form.unitCost) || 0,
        total, status: 'Pending',
        createdBy: user?.email || 'unknown',
        createdAt: serverTimestamp()
      }
      const ref = await addDoc(collection(db,'tenants','fooda','transfers'), entry)
      setEntries(prev => [{ id:ref.id, ...entry, createdAt:new Date().toISOString() }, ...prev])
      toast.success('Transfer logged!')
      setForm(EMPTY); setShowForm(false)
    } catch(e) { toast.error('Failed to save transfer.') }
    setSaving(false)
  }

  async function updateStatus(id, status) {
    await updateDoc(doc(db,'tenants','fooda','transfers',id), {
      status, updatedAt:serverTimestamp(), updatedBy:user?.email||'unknown'
    })
    setEntries(prev => prev.map(e => e.id===id ? {...e,status} : e))
    toast.success(`Transfer ${status.toLowerCase()}`)
  }

  function exportCSV() {
    const rows = [
      ['Date','Item','Units','Unit Cost','Total','From','To','Status','Notes'],
      ...filtered.map(e => [e.date,e.item,e.units,e.unitCost,(e.total||0).toFixed(2),e.from,e.to,e.status,e.notes||''])
    ]
    const csv  = rows.map(r => r.map(v=>`"${v??''}"`).join(',')).join('\n')
    const blob = new Blob([csv],{type:'text/csv'})
    const url  = URL.createObjectURL(blob)
    Object.assign(document.createElement('a'),{href:url,download:`transfers-${new Date().toISOString().slice(0,10)}.csv`}).click()
    URL.revokeObjectURL(url)
  }

  const filtered = useMemo(() => entries.filter(e => {
    if (filterStatus && e.status !== filterStatus) return false
    if (filterFrom   && e.from  !== filterFrom)    return false
    if (filterTo     && e.to    !== filterTo)       return false
    if (dateFrom     && e.date  <  dateFrom)        return false
    if (dateTo       && e.date  >  dateTo)          return false
    if (search && !e.item?.toLowerCase().includes(search.toLowerCase()) &&
        !e.from?.toLowerCase().includes(search.toLowerCase()) &&
        !e.to?.toLowerCase().includes(search.toLowerCase())) return false
    return true
  }), [entries, filterStatus, filterFrom, filterTo, dateFrom, dateTo, search])

  const totalValue   = filtered.reduce((s,e) => s+(e.total||0), 0)
  const pendingCount = filtered.filter(e=>e.status==='Pending').length
  const fmt$         = v => '$'+v.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <div>
          <h1 className={styles.title}>Transfer Log</h1>
          <p className={styles.subtitle}>Inventory transfers between locations</p>
        </div>
        <div className={styles.actions}>
          <button className={styles.btnIcon} onClick={exportCSV} title="Export CSV"><Download size={15}/></button>
          <button className={styles.btnPrimary} onClick={()=>setShowForm(v=>!v)}>
            <Plus size={15}/> Log Transfer
          </button>
        </div>
      </div>

      <div className={styles.kpiBar}>
        <div className={styles.kpi}><div className={styles.kpiL}>Total transfers</div><div className={styles.kpiV}>{filtered.length}</div></div>
        <div className={styles.kpi}><div className={styles.kpiL}>Total value</div><div className={styles.kpiV}>{fmt$(totalValue)}</div></div>
        <div className={styles.kpi}><div className={styles.kpiL}>Pending approval</div><div className={styles.kpiV} style={{color:pendingCount>0?'#d97706':undefined}}>{pendingCount}</div></div>
        <div className={styles.kpi}><div className={styles.kpiL}>In transit</div><div className={styles.kpiV} style={{color:'#7c3aed'}}>{filtered.filter(e=>e.status==='In Transit').length}</div></div>
      </div>

      {showForm && (
        <div className={styles.formCard}>
          <div className={styles.formTitle}>New Transfer</div>
          <form onSubmit={handleSave} className={styles.form}>
            <div className={styles.grid}>
              <div className={styles.field}><label>Date</label><input type="date" value={form.date} onChange={e=>setForm(f=>({...f,date:e.target.value}))} required/></div>
              <div className={styles.field} style={{gridColumn:'span 2'}}>
                <label>Item</label>
                <input type="text" value={form.item} onChange={e=>setForm(f=>({...f,item:e.target.value}))} placeholder="Item name" required autoFocus/>
              </div>
              <div className={styles.field}><label>Units</label><input type="number" min="0" step="0.1" value={form.units} onChange={e=>setForm(f=>({...f,units:e.target.value}))} placeholder="0"/></div>
              <div className={styles.field}><label>Unit Cost ($)</label><input type="number" min="0" step="0.01" value={form.unitCost} onChange={e=>setForm(f=>({...f,unitCost:e.target.value}))} placeholder="0.00"/></div>
              <div className={styles.field}>
                <label>Total</label>
                <div className={styles.total}>{fmt$((parseFloat(form.units)||0)*(parseFloat(form.unitCost)||0))}</div>
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
              <div className={styles.field}><label>Notes</label><input type="text" value={form.notes} onChange={e=>setForm(f=>({...f,notes:e.target.value}))} placeholder="Optional"/></div>
            </div>
            <div className={styles.formActions}>
              <button type="button" className={styles.btnCancel} onClick={()=>{setShowForm(false);setForm(EMPTY)}}>Cancel</button>
              <button type="submit" className={styles.btnPrimary} disabled={saving}>{saving?'Saving...':'Log Transfer'}</button>
            </div>
          </form>
        </div>
      )}

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
        <input type="date" value={dateFrom} onChange={e=>setDateFrom(e.target.value)} className={styles.filter} title="From date"/>
        <input type="date" value={dateTo}   onChange={e=>setDateTo(e.target.value)}   className={styles.filter} title="To date"/>
      </div>

      {loading ? <div className={styles.loading}>Loading...</div> : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>#</th><th>Date</th><th>Item</th><th>Units</th><th>Total</th>
                <th>From</th><th>To</th><th>Status</th><th>Notes</th><th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((e,i) => {
                const meta = STATUS_META[e.status] || STATUS_META.Pending
                return (
                  <tr key={e.id}>
                    <td style={{color:'#999',fontSize:11}}>{i+1}</td>
                    <td style={{color:'#888'}}>{e.date}</td>
                    <td style={{fontWeight:600,color:'var(--text-primary)'}}>{e.item}</td>
                    <td>{e.units}</td>
                    <td style={{fontWeight:700,color:'#2563eb'}}>{fmt$(e.total||0)}</td>
                    <td><span className={styles.pillFrom}>{cleanLocName(e.from)}</span></td>
                    <td><span className={styles.pillTo}>{cleanLocName(e.to)}</span></td>
                    <td>
                      <span style={{display:'inline-block',padding:'3px 10px',borderRadius:20,fontSize:11,fontWeight:600,background:meta.bg,color:meta.color}}>
                        {e.status}
                      </span>
                    </td>
                    <td style={{color:'#999',fontSize:12}}>{e.notes||'—'}</td>
                    <td>
                      <div style={{display:'flex',gap:4}}>
                        {e.status==='Pending' && <>
                          <button className={styles.btnApprove} onClick={()=>updateStatus(e.id,'Approved')} title="Approve"><CheckCircle size={12}/></button>
                          <button className={styles.btnReject}  onClick={()=>updateStatus(e.id,'Rejected')} title="Reject"><XCircle size={12}/></button>
                        </>}
                        {e.status==='Approved' && <button className={styles.btnTransit} onClick={()=>updateStatus(e.id,'In Transit')} title="In transit"><Truck size={12}/></button>}
                        {e.status==='In Transit' && <button className={styles.btnReceive} onClick={()=>updateStatus(e.id,'Received')} title="Received"><CheckCircle size={12}/></button>}
                      </div>
                    </td>
                  </tr>
                )
              })}
              {filtered.length===0 && <tr><td colSpan={10} style={{textAlign:'center',padding:48,color:'#999'}}>No transfers found</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}