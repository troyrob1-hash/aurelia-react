import { useState, useEffect, useMemo } from 'react'
import { useAuthStore } from '@/store/authStore'
import { useToast } from '@/components/ui/Toast'
import { db } from '@/lib/firebase'
import { collection, query, orderBy, getDocs, addDoc, updateDoc, deleteDoc, doc, serverTimestamp } from 'firebase/firestore'
import { Plus, Download, Search } from 'lucide-react'
import styles from './Purchasing.module.css'

const STATUSES = ['Pending','Approved','Paid','Overdue','Disputed','Void']
const VENDORS  = ['Sysco','Nassau','Vistar','Cafe Moto','David Rio','Amazon','Webstaurant','Blue Cart','RTZN','Don Edwards','Other']
const STATUS_COLORS = { Pending:'#d97706',Approved:'#2563eb',Paid:'#059669',Overdue:'#dc2626',Disputed:'#7c3aed',Void:'#6b7280' }

const EMPTY = { invoiceNum:'', vendor:'Sysco', invoiceDate:new Date().toISOString().slice(0,10), dueDate:'', amount:'', amountPaid:'0', location:'', glCode:'', notes:'', status:'Pending' }

export default function Purchasing() {
  const { user } = useAuthStore()
  const toast = useToast()
  const [invoices, setInvoices] = useState([])
  const [loading, setLoading]   = useState(false)
  const [saving, setSaving]     = useState(false)
  const [showForm, setShowForm] = useState(false)
  const [form, setForm]         = useState(EMPTY)
  const [search, setSearch]     = useState('')
  const [filterStatus, setFilterStatus] = useState('')
  const [filterVendor, setFilterVendor] = useState('')
  const [editId, setEditId]     = useState(null)

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
      const entry = { ...form, amount:parseFloat(form.amount)||0, amountPaid:parseFloat(form.amountPaid)||0, updatedBy:user?.email||'unknown', updatedAt:serverTimestamp() }
      if (editId) {
        await updateDoc(doc(db,'tenants','fooda','invoices',editId), entry)
        setInvoices(prev => prev.map(i => i.id===editId ? {...i,...entry} : i))
        toast.success('Invoice updated!')
      } else {
        entry.createdBy = user?.email||'unknown'; entry.createdAt = serverTimestamp()
        const ref = await addDoc(collection(db,'tenants','fooda','invoices'), entry)
        setInvoices(prev => [{ id:ref.id, ...entry }, ...prev])
        toast.success('Invoice added!')
      }
      setForm(EMPTY); setShowForm(false); setEditId(null)
    } catch(e) { toast.error('Failed to save invoice.') }
    setSaving(false)
  }

  function handleEdit(inv) {
    setForm({...inv, amount:String(inv.amount), amountPaid:String(inv.amountPaid||0)})
    setEditId(inv.id); setShowForm(true)
  }

  async function updateStatus(id, status) {
    await updateDoc(doc(db,'tenants','fooda','invoices',id), { status, updatedAt:serverTimestamp() })
    setInvoices(prev => prev.map(i => i.id===id ? {...i,status} : i))
    toast.success(`Marked as ${status}`)
  }

  function exportCSV() {
    const rows = [['Invoice #','Vendor','Date','Due Date','Amount','Paid','Balance','Status','Location','GL Code'],
      ...filtered.map(i => [i.invoiceNum,i.vendor,i.invoiceDate,i.dueDate||'',i.amount,(i.amountPaid||0),(i.amount-(i.amountPaid||0)).toFixed(2),i.status,i.location||'',i.glCode||''])]
    const csv = rows.map(r=>r.map(v=>`"${v??''}"`).join(',')).join('\n')
    const blob = new Blob([csv],{type:'text/csv'})
    const url = URL.createObjectURL(blob)
    Object.assign(document.createElement('a'),{href:url,download:`invoices-${new Date().toISOString().slice(0,10)}.csv`}).click()
    URL.revokeObjectURL(url)
  }

  const filtered = useMemo(() => invoices.filter(i => {
    if (filterStatus && i.status !== filterStatus) return false
    if (filterVendor && i.vendor !== filterVendor) return false
    if (search && !i.invoiceNum?.toLowerCase().includes(search.toLowerCase()) && !i.vendor?.toLowerCase().includes(search.toLowerCase())) return false
    return true
  }), [invoices, filterStatus, filterVendor, search])

  const totalOwed = filtered.filter(i=>i.status!=='Paid'&&i.status!=='Void').reduce((s,i)=>s+(i.amount-(i.amountPaid||0)),0)
  const totalPaid  = filtered.filter(i=>i.status==='Paid').reduce((s,i)=>s+i.amount,0)
  const overdue    = filtered.filter(i=>i.status==='Overdue').length

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <div>
          <h1 className={styles.title}>Purchasing / AP</h1>
          <p className={styles.subtitle}>Accounts payable & invoice tracking</p>
        </div>
        <div className={styles.actions}>
          <button className={styles.btnIcon} onClick={exportCSV}><Download size={15}/></button>
          <button className={styles.btnPrimary} onClick={()=>{setForm(EMPTY);setEditId(null);setShowForm(v=>!v)}}><Plus size={15}/> Add Invoice</button>
        </div>
      </div>

      <div className={styles.kpiBar}>
        <div className={styles.kpi}><div className={styles.kpiL}>Outstanding</div><div className={styles.kpiV} style={{color:'#dc2626'}}>${totalOwed.toLocaleString('en-US',{minimumFractionDigits:2})}</div></div>
        <div className={styles.kpi}><div className={styles.kpiL}>Paid (filtered)</div><div className={styles.kpiV} style={{color:'#059669'}}>${totalPaid.toLocaleString('en-US',{minimumFractionDigits:2})}</div></div>
        <div className={styles.kpi}><div className={styles.kpiL}>Overdue</div><div className={styles.kpiV} style={{color:overdue>0?'#dc2626':undefined}}>{overdue}</div></div>
        <div className={styles.kpi}><div className={styles.kpiL}>Total Invoices</div><div className={styles.kpiV}>{filtered.length}</div></div>
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
              <div className={styles.field}><label>GL Code</label><input value={form.glCode} onChange={e=>setForm(f=>({...f,glCode:e.target.value}))} placeholder="e.g. 12000"/></div>
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
        <div className={styles.searchWrap}><Search size={14} className={styles.searchIcon}/><input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search invoice #, vendor..." className={styles.search}/></div>
        <select value={filterStatus} onChange={e=>setFilterStatus(e.target.value)} className={styles.filter}><option value="">All Statuses</option>{STATUSES.map(s=><option key={s}>{s}</option>)}</select>
        <select value={filterVendor} onChange={e=>setFilterVendor(e.target.value)} className={styles.filter}><option value="">All Vendors</option>{VENDORS.map(v=><option key={v}>{v}</option>)}</select>
      </div>

      {loading ? <div className={styles.loading}>Loading...</div> : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead><tr>
              <th>Invoice #</th><th>Vendor</th><th>Date</th><th>Due</th><th>Amount</th><th>Paid</th><th>Balance</th><th>Status</th><th>Actions</th>
            </tr></thead>
            <tbody>
              {filtered.map(inv => {
                const balance = (inv.amount||0) - (inv.amountPaid||0)
                return (
                  <tr key={inv.id}>
                    <td style={{fontWeight:600}}>{inv.invoiceNum||'—'}</td>
                    <td>{inv.vendor}</td>
                    <td>{inv.invoiceDate}</td>
                    <td style={{color:inv.status==='Overdue'?'#dc2626':undefined}}>{inv.dueDate||'—'}</td>
                    <td>${(inv.amount||0).toLocaleString('en-US',{minimumFractionDigits:2})}</td>
                    <td style={{color:'#059669'}}>${(inv.amountPaid||0).toLocaleString('en-US',{minimumFractionDigits:2})}</td>
                    <td style={{fontWeight:700,color:balance>0?'#dc2626':'#059669'}}>${balance.toLocaleString('en-US',{minimumFractionDigits:2})}</td>
                    <td>
                      <select value={inv.status} onChange={e=>updateStatus(inv.id,e.target.value)}
                        className={styles.statusSelect} style={{color:STATUS_COLORS[inv.status],borderColor:STATUS_COLORS[inv.status]+'60'}}>
                        {STATUSES.map(s=><option key={s}>{s}</option>)}
                      </select>
                    </td>
                    <td><button className={styles.btnEdit} onClick={()=>handleEdit(inv)}>Edit</button></td>
                  </tr>
                )
              })}
              {filtered.length===0 && <tr><td colSpan={9} style={{textAlign:'center',padding:32,color:'#999'}}>No invoices found</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
