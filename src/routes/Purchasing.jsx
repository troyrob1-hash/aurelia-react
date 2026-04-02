import { useState, useEffect, useMemo } from 'react'
import { useAuthStore } from '@/store/authStore'
import { useToast } from '@/components/ui/Toast'
import { db } from '@/lib/firebase'
import { collection, query, orderBy, getDocs, addDoc, updateDoc, doc, serverTimestamp } from 'firebase/firestore'
import { Plus, Download, Search, CheckCircle, XCircle } from 'lucide-react'
import styles from './Purchasing.module.css'

const STATUSES = ['Pending','Approved','Paid','Overdue','Disputed','Void']
const VENDORS  = ['Sysco','Nassau','Vistar','Cafe Moto','David Rio','Amazon','Webstaurant','Blue Cart','RTZN','Don Edwards','Other']

const STATUS_META = {
  Pending:  { color:'#d97706', bg:'#fef3c7' },
  Approved: { color:'#2563eb', bg:'#eff6ff' },
  Paid:     { color:'#059669', bg:'#f0fdf4' },
  Overdue:  { color:'#dc2626', bg:'#fef2f2' },
  Disputed: { color:'#7c3aed', bg:'#faf5ff' },
  Void:     { color:'#6b7280', bg:'#f9fafb' },
}

const EMPTY = {
  invoiceNum:'', vendor:'Sysco', invoiceDate: new Date().toISOString().slice(0,10),
  dueDate:'', amount:'', amountPaid:'0', location:'', glCode:'', notes:'', status:'Pending'
}

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

export default function Purchasing() {
  const { user } = useAuthStore()
  const toast    = useToast()
  const [invoices,     setInvoices]     = useState([])
  const [loading,      setLoading]      = useState(false)
  const [saving,       setSaving]       = useState(false)
  const [showForm,     setShowForm]     = useState(false)
  const [form,         setForm]         = useState(EMPTY)
  const [search,       setSearch]       = useState('')
  const [filterStatus, setFilterStatus] = useState('')
  const [filterVendor, setFilterVendor] = useState('')
  const [editId,       setEditId]       = useState(null)
  const [expandVendor, setExpandVendor] = useState({})

  useEffect(() => { load() }, [])

  async function load() {
    setLoading(true)
    try {
      const snap = await getDocs(query(collection(db,'tenants','fooda','invoices'), orderBy('invoiceDate','desc')))
      setInvoices(snap.docs.map(d => ({ id:d.id, ...d.data() })))
    } catch(e) { toast.error('Failed to load invoices.') }
    setLoading(false)
  }

  async function handleSave(e) {
    e.preventDefault()
    setSaving(true)
    try {
      const entry = {
        ...form,
        amount:     parseFloat(form.amount) || 0,
        amountPaid: parseFloat(form.amountPaid) || 0,
        updatedBy:  user?.email || 'unknown',
        updatedAt:  serverTimestamp()
      }
      if (editId) {
        await updateDoc(doc(db,'tenants','fooda','invoices',editId), entry)
        setInvoices(prev => prev.map(i => i.id===editId ? {...i,...entry} : i))
        toast.success('Invoice updated!')
      } else {
        entry.createdBy = user?.email || 'unknown'
        entry.createdAt = serverTimestamp()
        const ref = await addDoc(collection(db,'tenants','fooda','invoices'), entry)
        setInvoices(prev => [{ id:ref.id, ...entry }, ...prev])
        toast.success('Invoice added!')
      }
      setForm(EMPTY); setShowForm(false); setEditId(null)
    } catch(e) { toast.error('Failed to save invoice.') }
    setSaving(false)
  }

  async function approve(id) {
    await updateDoc(doc(db,'tenants','fooda','invoices',id), { status:'Approved', updatedAt:serverTimestamp() })
    setInvoices(prev => prev.map(i => i.id===id ? {...i,status:'Approved'} : i))
    toast.success('Invoice approved')
  }

  async function markPaid(id) {
    const inv = invoices.find(i => i.id===id)
    await updateDoc(doc(db,'tenants','fooda','invoices',id), { status:'Paid', amountPaid:inv.amount, updatedAt:serverTimestamp() })
    setInvoices(prev => prev.map(i => i.id===id ? {...i,status:'Paid',amountPaid:i.amount} : i))
    toast.success('Marked as paid')
  }

  async function updateStatus(id, status) {
    await updateDoc(doc(db,'tenants','fooda','invoices',id), { status, updatedAt:serverTimestamp() })
    setInvoices(prev => prev.map(i => i.id===id ? {...i,status} : i))
  }

  function handleEdit(inv) {
    setForm({...inv, amount:String(inv.amount), amountPaid:String(inv.amountPaid||0)})
    setEditId(inv.id); setShowForm(true)
    window.scrollTo({top:0,behavior:'smooth'})
  }

  function exportCSV() {
    const rows = [
      ['Invoice #','Vendor','Date','Due Date','Amount','Paid','Balance','Status','Location','GL Code'],
      ...filtered.map(i => [i.invoiceNum,i.vendor,i.invoiceDate,i.dueDate||'',i.amount,(i.amountPaid||0),(i.amount-(i.amountPaid||0)).toFixed(2),i.status,i.location||'',i.glCode||''])
    ]
    const csv  = rows.map(r => r.map(v=>`"${v??''}"`).join(',')).join('\n')
    const blob = new Blob([csv],{type:'text/csv'})
    const url  = URL.createObjectURL(blob)
    Object.assign(document.createElement('a'),{href:url,download:`invoices-${new Date().toISOString().slice(0,10)}.csv`}).click()
    URL.revokeObjectURL(url)
  }

  const filtered = useMemo(() => invoices.filter(i => {
    if (filterStatus && i.status !== filterStatus) return false
    if (filterVendor && i.vendor !== filterVendor) return false
    if (search && !i.invoiceNum?.toLowerCase().includes(search.toLowerCase()) &&
        !i.vendor?.toLowerCase().includes(search.toLowerCase())) return false
    return true
  }), [invoices, filterStatus, filterVendor, search])

  const aging = useMemo(() => {
    const b = { current:0, '1-30':0, '31-60':0, '61-90':0, '90+':0 }
    invoices.filter(i=>i.status!=='Paid'&&i.status!=='Void').forEach(i => {
      const bucket = agingBucket(i)
      if (bucket) b[bucket] += (i.amount-(i.amountPaid||0))
    })
    return b
  }, [invoices])

  const vendorGroups = useMemo(() => {
    const g = {}
    filtered.forEach(i => {
      if (!g[i.vendor]) g[i.vendor] = { invoices:[], outstanding:0, paid:0 }
      g[i.vendor].invoices.push(i)
      if (i.status!=='Paid'&&i.status!=='Void') g[i.vendor].outstanding += (i.amount-(i.amountPaid||0))
      if (i.status==='Paid') g[i.vendor].paid += i.amount
    })
    return g
  }, [filtered])

  const totalOwed  = filtered.filter(i=>i.status!=='Paid'&&i.status!=='Void').reduce((s,i)=>s+(i.amount-(i.amountPaid||0)),0)
  const totalPaid  = filtered.filter(i=>i.status==='Paid').reduce((s,i)=>s+i.amount,0)
  const overdueAmt = aging['1-30']+aging['31-60']+aging['61-90']+aging['90+']
  const fmt$ = v => '$'+v.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <div>
          <h1 className={styles.title}>Purchasing / AP</h1>
          <p className={styles.subtitle}>Accounts payable & invoice tracking</p>
        </div>
        <div className={styles.actions}>
          <button className={styles.btnIcon} onClick={exportCSV} title="Export CSV"><Download size={15}/></button>
          <button className={styles.btnPrimary} onClick={()=>{setForm(EMPTY);setEditId(null);setShowForm(v=>!v)}}>
            <Plus size={15}/> Add Invoice
          </button>
        </div>
      </div>

      <div className={styles.kpiBar}>
        <div className={styles.kpi}><div className={styles.kpiL}>Outstanding</div><div className={styles.kpiV} style={{color:'#dc2626'}}>{fmt$(totalOwed)}</div></div>
        <div className={styles.kpi}><div className={styles.kpiL}>Paid (filtered)</div><div className={styles.kpiV} style={{color:'#059669'}}>{fmt$(totalPaid)}</div></div>
        <div className={styles.kpi}><div className={styles.kpiL}>Past due</div><div className={styles.kpiV} style={{color:overdueAmt>0?'#dc2626':undefined}}>{fmt$(overdueAmt)}</div></div>
        <div className={styles.kpi}><div className={styles.kpiL}>Total invoices</div><div className={styles.kpiV}>{filtered.length}</div></div>
      </div>

      <div className={styles.agingBar}>
        <div className={styles.agingLabel}>A/P aging</div>
        {[
          { key:'current', label:'Current',   color:'#059669' },
          { key:'1-30',    label:'1–30 days', color:'#d97706' },
          { key:'31-60',   label:'31–60 days',color:'#ea580c' },
          { key:'61-90',   label:'61–90 days',color:'#dc2626' },
          { key:'90+',     label:'90+ days',  color:'#7f1d1d' },
        ].map(b => (
          <div key={b.key} className={styles.agingBucket} style={{borderTopColor:b.color}}>
            <div className={styles.agingAmt} style={{color:aging[b.key]>0?b.color:undefined}}>{fmt$(aging[b.key])}</div>
            <div className={styles.agingLbl}>{b.label}</div>
          </div>
        ))}
      </div>

      {showForm && (
        <div className={styles.formCard}>
          <div className={styles.formTitle}>{editId ? 'Edit Invoice' : 'New Invoice'}</div>
          <form onSubmit={handleSave}>
            <div className={styles.grid}>
              <div className={styles.field}><label>Invoice #</label><input value={form.invoiceNum} onChange={e=>setForm(f=>({...f,invoiceNum:e.target.value}))} placeholder="INV-001" autoFocus/></div>
              <div className={styles.field}><label>Vendor</label>
                <select value={form.vendor} onChange={e=>setForm(f=>({...f,vendor:e.target.value}))}>
                  {VENDORS.map(v=><option key={v}>{v}</option>)}
                </select>
              </div>
              <div className={styles.field}><label>Status</label>
                <select value={form.status} onChange={e=>setForm(f=>({...f,status:e.target.value}))}>
                  {STATUSES.map(s=><option key={s}>{s}</option>)}
                </select>
              </div>
              <div className={styles.field}><label>Invoice Date</label><input type="date" value={form.invoiceDate} onChange={e=>setForm(f=>({...f,invoiceDate:e.target.value}))} required/></div>
              <div className={styles.field}><label>Due Date</label><input type="date" value={form.dueDate} onChange={e=>setForm(f=>({...f,dueDate:e.target.value}))}/></div>
              <div className={styles.field}><label>Amount ($)</label><input type="number" min="0" step="0.01" value={form.amount} onChange={e=>setForm(f=>({...f,amount:e.target.value}))} required/></div>
              <div className={styles.field}><label>Amount Paid ($)</label><input type="number" min="0" step="0.01" value={form.amountPaid} onChange={e=>setForm(f=>({...f,amountPaid:e.target.value}))}/></div>
              <div className={styles.field}><label>Location</label><input value={form.location} onChange={e=>setForm(f=>({...f,location:e.target.value}))} placeholder="e.g. 1200 Enclave"/></div>
              <div className={styles.field}><label>GL Code</label><input value={form.glCode} onChange={e=>setForm(f=>({...f,glCode:e.target.value}))} placeholder="e.g. 50410"/></div>
              <div className={styles.field} style={{gridColumn:'span 3'}}><label>Notes</label><input value={form.notes} onChange={e=>setForm(f=>({...f,notes:e.target.value}))} placeholder="Optional notes"/></div>
            </div>
            <div className={styles.formActions}>
              <button type="button" className={styles.btnCancel} onClick={()=>{setShowForm(false);setForm(EMPTY);setEditId(null)}}>Cancel</button>
              <button type="submit" className={styles.btnPrimary} disabled={saving}>{saving?'Saving...':'Save Invoice'}</button>
            </div>
          </form>
        </div>
      )}

      <div className={styles.toolbar}>
        <div className={styles.searchWrap}>
          <Search size={14} className={styles.searchIcon}/>
          <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search invoice #, vendor..." className={styles.search}/>
        </div>
        <select value={filterStatus} onChange={e=>setFilterStatus(e.target.value)} className={styles.filter}>
          <option value="">All Statuses</option>
          {STATUSES.map(s=><option key={s}>{s}</option>)}
        </select>
        <select value={filterVendor} onChange={e=>setFilterVendor(e.target.value)} className={styles.filter}>
          <option value="">All Vendors</option>
          {VENDORS.map(v=><option key={v}>{v}</option>)}
        </select>
      </div>

      {loading ? <div className={styles.loading}>Loading...</div> : (
        <div className={styles.tableWrap}>
          {Object.entries(vendorGroups).map(([vendor, group]) => (
            <div key={vendor} className={styles.vendorGroup}>
              <div className={styles.vendorHeader} onClick={()=>setExpandVendor(p=>({...p,[vendor]:!p[vendor]}))}>
                <span className={styles.vendorName}>{vendor}</span>
                <div className={styles.vendorMeta}>
                  <span>{group.invoices.length} invoice{group.invoices.length!==1?'s':''}</span>
                  {group.outstanding > 0 && <span style={{color:'#dc2626'}}>Outstanding: {fmt$(group.outstanding)}</span>}
                  {group.paid > 0 && <span style={{color:'#059669'}}>Paid: {fmt$(group.paid)}</span>}
                  <span className={styles.vendorToggle}>{expandVendor[vendor]===false?'▼':'▲'}</span>
                </div>
              </div>

              {expandVendor[vendor]!==false && (
                <table className={styles.table}>
                  <thead>
                    <tr><th>Invoice #</th><th>Date</th><th>Due</th><th>Amount</th><th>Paid</th><th>Balance</th><th>GL</th><th>Status</th><th>Actions</th></tr>
                  </thead>
                  <tbody>
                    {group.invoices.map(inv => {
                      const balance     = (inv.amount||0)-(inv.amountPaid||0)
                      const meta        = STATUS_META[inv.status] || STATUS_META.Pending
                      const daysOverdue = inv.dueDate ? Math.floor((new Date()-new Date(inv.dueDate))/86400000) : 0
                      return (
                        <tr key={inv.id}>
                          <td style={{fontWeight:600}}>{inv.invoiceNum||'—'}</td>
                          <td style={{color:'#888'}}>{inv.invoiceDate}</td>
                          <td>
                            <span style={{color:daysOverdue>0&&inv.status!=='Paid'?'#dc2626':'inherit'}}>
                              {inv.dueDate||'—'}
                              {daysOverdue>0&&inv.status!=='Paid'&&<span style={{fontSize:11,marginLeft:4,color:'#dc2626'}}>+{daysOverdue}d</span>}
                            </span>
                          </td>
                          <td>{fmt$(inv.amount||0)}</td>
                          <td style={{color:'#059669'}}>{fmt$(inv.amountPaid||0)}</td>
                          <td style={{fontWeight:700,color:balance>0?'#dc2626':'#059669'}}>{fmt$(balance)}</td>
                          <td style={{fontFamily:'monospace',fontSize:11,color:'#888'}}>{inv.glCode||'—'}</td>
                          <td>
                            <span style={{display:'inline-block',padding:'3px 10px',borderRadius:20,fontSize:11,fontWeight:600,background:meta.bg,color:meta.color}}>
                              {inv.status}
                            </span>
                          </td>
                          <td>
                            <div style={{display:'flex',gap:4}}>
                              {inv.status==='Pending' && <button className={styles.btnApprove} onClick={()=>approve(inv.id)}><CheckCircle size={13}/> Approve</button>}
                              {inv.status==='Approved' && <button className={styles.btnPay} onClick={()=>markPaid(inv.id)}><CheckCircle size={13}/> Pay</button>}
                              <button className={styles.btnEdit} onClick={()=>handleEdit(inv)}>Edit</button>
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
          {filtered.length===0 && <div style={{textAlign:'center',padding:48,color:'#999'}}>No invoices found</div>}
        </div>
      )}
    </div>
  )
}