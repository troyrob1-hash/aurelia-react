import { useState, useEffect, useMemo } from 'react'
import { useAuthStore } from '@/store/authStore'
import { useLocations, cleanLocName } from '@/store/LocationContext'
import { useToast } from '@/components/ui/Toast'
import { db } from '@/lib/firebase'
import { collection, query, orderBy, getDocs, addDoc, deleteDoc, doc, serverTimestamp } from 'firebase/firestore'
import { Plus, Trash2, Download } from 'lucide-react'
import styles from './Transfers.module.css'

const EMPTY = { date: new Date().toISOString().slice(0,10), item:'', units:'', unitCost:'', from:'', to:'', notes:'' }

export default function Transfers() {
  const { user } = useAuthStore()
  const { groupedLocations } = useLocations()
  const toast = useToast()
  const [entries, setEntries] = useState([])
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState(EMPTY)
  const [deleteId, setDeleteId] = useState(null)
  const [search, setSearch] = useState('')

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
    setSaving(true)
    try {
      const total = (parseFloat(form.units)||0) * (parseFloat(form.unitCost)||0)
      const entry = { ...form, units:parseFloat(form.units)||0, unitCost:parseFloat(form.unitCost)||0, total, createdBy:user?.email||'unknown', createdAt:serverTimestamp() }
      const ref = await addDoc(collection(db,'tenants','fooda','transfers'), entry)
      setEntries(prev => [{ id:ref.id, ...entry, createdAt:new Date().toISOString() }, ...prev])
      toast.success('Transfer logged!')
      setForm(EMPTY); setShowForm(false)
    } catch(e) { toast.error('Failed to save transfer.') }
    setSaving(false)
  }

  async function handleDelete(id) {
    await deleteDoc(doc(db,'tenants','fooda','transfers',id))
    setEntries(prev => prev.filter(e => e.id !== id))
    setDeleteId(null)
  }

  function exportCSV() {
    const rows = [['Date','Item','Units','Unit Cost','Total','From','To','Notes'],
      ...filtered.map(e => [e.date,e.item,e.units,e.unitCost,(e.total||0).toFixed(2),e.from,e.to,e.notes||''])]
    const csv = rows.map(r=>r.map(v=>`"${v??''}"`).join(',')).join('\n')
    const blob = new Blob([csv],{type:'text/csv'})
    const url = URL.createObjectURL(blob)
    Object.assign(document.createElement('a'),{href:url,download:`transfers-${new Date().toISOString().slice(0,10)}.csv`}).click()
    URL.revokeObjectURL(url)
  }

  const filtered = entries.filter(e => !search || e.item?.toLowerCase().includes(search.toLowerCase()) || e.from?.toLowerCase().includes(search.toLowerCase()) || e.to?.toLowerCase().includes(search.toLowerCase()))
  const totalValue = filtered.reduce((s,e) => s+(e.total||0), 0)

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <div>
          <h1 className={styles.title}>Transfer Log</h1>
          <p className={styles.subtitle}>Track inventory transfers between locations</p>
        </div>
        <div className={styles.actions}>
          <button className={styles.btnIcon} onClick={exportCSV}><Download size={15}/></button>
          <button className={styles.btnPrimary} onClick={()=>setShowForm(v=>!v)}><Plus size={15}/> Log Transfer</button>
        </div>
      </div>

      <div className={styles.kpiBar}>
        <div className={styles.kpi}><div className={styles.kpiL}>Total Transfers</div><div className={styles.kpiV}>{filtered.length}</div></div>
        <div className={styles.kpi}><div className={styles.kpiL}>Total Value</div><div className={styles.kpiV}>${totalValue.toLocaleString('en-US',{minimumFractionDigits:2})}</div></div>
      </div>

      {showForm && (
        <div className={styles.formCard}>
          <div className={styles.formTitle}>New Transfer</div>
          <form onSubmit={handleSave} className={styles.form}>
            <div className={styles.grid}>
              <div className={styles.field}><label>Date</label><input type="date" value={form.date} onChange={e=>setForm(f=>({...f,date:e.target.value}))} required/></div>
              <div className={styles.field} style={{gridColumn:'span 2'}}><label>Item</label><input type="text" value={form.item} onChange={e=>setForm(f=>({...f,item:e.target.value}))} placeholder="Item name" required autoFocus/></div>
              <div className={styles.field}><label>Units</label><input type="number" min="0" step="0.1" value={form.units} onChange={e=>setForm(f=>({...f,units:e.target.value}))} placeholder="0"/></div>
              <div className={styles.field}><label>Unit Cost ($)</label><input type="number" min="0" step="0.01" value={form.unitCost} onChange={e=>setForm(f=>({...f,unitCost:e.target.value}))} placeholder="0.00"/></div>
              <div className={styles.field}><label>Total</label><div className={styles.total}>${((parseFloat(form.units)||0)*(parseFloat(form.unitCost)||0)).toFixed(2)}</div></div>
              <div className={styles.field}><label>From Location</label>
                <select value={form.from} onChange={e=>setForm(f=>({...f,from:e.target.value}))} required>
                  <option value="">Select...</option>
                  {allLocs.map(l=><option key={l} value={l}>{cleanLocName(l)}</option>)}
                </select>
              </div>
              <div className={styles.field}><label>To Location</label>
                <select value={form.to} onChange={e=>setForm(f=>({...f,to:e.target.value}))} required>
                  <option value="">Select...</option>
                  {allLocs.map(l=><option key={l} value={l}>{cleanLocName(l)}</option>)}
                </select>
              </div>
              <div className={styles.field}><label>Notes</label><input type="text" value={form.notes} onChange={e=>setForm(f=>({...f,notes:e.target.value}))} placeholder="Optional"/></div>
            </div>
            <div className={styles.formActions}>
              <button type="button" className={styles.btnCancel} onClick={()=>{setShowForm(false);setForm(EMPTY)}}>Cancel</button>
              <button type="submit" className={styles.btnPrimary} disabled={saving}>{saving?'Saving...':'Save Transfer'}</button>
            </div>
          </form>
        </div>
      )}

      <div className={styles.toolbar}>
        <input type="text" value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search item, location..." className={styles.search}/>
      </div>

      {loading ? <div className={styles.loading}>Loading...</div> : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead><tr>
              <th>#</th><th>Date</th><th>Item</th><th>Units</th><th>Unit Cost</th><th>Total</th><th>From</th><th>To</th><th>Notes</th><th></th>
            </tr></thead>
            <tbody>
              {filtered.map((e,i) => (
                <tr key={e.id}>
                  <td>{i+1}</td>
                  <td>{e.date}</td>
                  <td style={{fontWeight:600}}>{e.item}</td>
                  <td>{e.units}</td>
                  <td>${(e.unitCost||0).toFixed(2)}</td>
                  <td style={{fontWeight:700,color:'#2563eb'}}>${(e.total||0).toFixed(2)}</td>
                  <td>{cleanLocName(e.from)}</td>
                  <td>{cleanLocName(e.to)}</td>
                  <td style={{color:'#999'}}>{e.notes||'—'}</td>
                  <td>
                    {deleteId===e.id ? (
                      <span style={{display:'flex',gap:4}}>
                        <button className={styles.btnConfirm} onClick={()=>handleDelete(e.id)}>Confirm</button>
                        <button className={styles.btnCancelSm} onClick={()=>setDeleteId(null)}>Cancel</button>
                      </span>
                    ) : <button className={styles.btnDelete} onClick={()=>setDeleteId(e.id)}><Trash2 size={13}/></button>}
                  </td>
                </tr>
              ))}
              {filtered.length===0 && <tr><td colSpan={10} style={{textAlign:'center',padding:32,color:'#999'}}>No transfers yet</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
