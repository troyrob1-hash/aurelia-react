import { useState, useEffect, useMemo } from 'react'
import { useAuthStore } from '@/store/authStore'
import { useLocations } from '@/store/LocationContext'
import { db } from '@/lib/firebase'
import { collection, query, where, orderBy, getDocs, addDoc, deleteDoc, doc, serverTimestamp } from 'firebase/firestore'
import { Plus, Trash2, Download } from 'lucide-react'
import styles from './WasteLog.module.css'

const REASONS = ['Spoilage','Overproduction','Expired','Damaged','Prep Waste','Catering Surplus','Other']
const GL_CODES = ['12000 - Inventory - Cafeteria','12002 - Inventory - Barista','12003 - Inventory - Catering']

function locationId(name) { return name.replace(/[^a-zA-Z0-9]/g, '_') }

const EMPTY_FORM = { date: new Date().toISOString().slice(0,10), item:'', units:'', unitCost:'', glCode:'', reason:'' }

export default function WasteLog() {
  const { user }             = useAuthStore()
  const { selectedLocation } = useLocations()
  const [entries, setEntries] = useState([])
  const [loading, setLoading] = useState(false)
  const [saving, setSaving]   = useState(false)
  const [showForm, setShowForm] = useState(false)
  const [form, setForm]       = useState(EMPTY_FORM)
  const [deleteId, setDeleteId] = useState(null)

  const location = selectedLocation === 'all' ? null : selectedLocation

  useEffect(() => {
    if (!location) { setEntries([]); return }
    load()
  }, [location])

  async function load() {
    setLoading(true)
    try {
      const locId = locationId(location)
      const ref   = collection(db, 'tenants','fooda','locations',locId,'waste')
      const q     = query(ref, orderBy('date','desc'))
      const snap  = await getDocs(q)
      setEntries(snap.docs.map(d => ({ id: d.id, ...d.data() })))
    } catch(e) { console.error(e) }
    setLoading(false)
  }

  async function handleSave(e) {
    e.preventDefault()
    if (!form.item.trim()) return
    setSaving(true)
    try {
      const locId = locationId(location)
      const total = (parseFloat(form.units)||0) * (parseFloat(form.unitCost)||0)
      const entry = {
        date:      form.date,
        item:      form.item.trim(),
        units:     parseFloat(form.units) || 0,
        unitCost:  parseFloat(form.unitCost) || 0,
        total,
        glCode:    form.glCode,
        reason:    form.reason,
        location,
        createdBy: user?.email || 'unknown',
        createdAt: serverTimestamp(),
      }
      const ref  = collection(db,'tenants','fooda','locations',locId,'waste')
      const docRef = await addDoc(ref, entry)
      setEntries(prev => [{ id: docRef.id, ...entry, createdAt: new Date().toISOString() }, ...prev])
      setForm(EMPTY_FORM)
      setShowForm(false)
    } catch(e) { console.error(e) }
    setSaving(false)
  }

  async function handleDelete(id) {
    const locId = locationId(location)
    await deleteDoc(doc(db,'tenants','fooda','locations',locId,'waste',id))
    setEntries(prev => prev.filter(e => e.id !== id))
    setDeleteId(null)
  }

  function exportCSV() {
    const rows = [['Date','Item','Units','Unit Cost','Total','GL Code','Reason'],
      ...entries.map(e => [e.date, e.item, e.units, e.unitCost, e.total.toFixed(2), e.glCode, e.reason])]
    const csv  = rows.map(r => r.map(v=>`"${v??''}"`).join(',')).join('\n')
    const blob = new Blob([csv],{type:'text/csv'})
    const url  = URL.createObjectURL(blob)
    Object.assign(document.createElement('a'),{href:url,download:`waste-${location}-${new Date().toISOString().slice(0,10)}.csv`}).click()
    URL.revokeObjectURL(url)
  }

  const totalWaste = useMemo(() => entries.reduce((s,e) => s+(e.total||0), 0), [entries])
  const thisWeek   = useMemo(() => {
    const now = new Date()
    const weekAgo = new Date(now - 7*24*60*60*1000)
    return entries.filter(e => new Date(e.date) >= weekAgo).reduce((s,e) => s+(e.total||0), 0)
  }, [entries])

  if (!location) return (
    <div className={styles.empty}>
      <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#d1d5db" strokeWidth="1.5" strokeLinecap="round">
        <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/>
      </svg>
      <p className={styles.emptyTitle}>Select a location</p>
      <p className={styles.emptySub}>Choose a location from the dropdown to log waste</p>
    </div>
  )

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <div>
          <h1 className={styles.title}>Waste Log</h1>
          <p className={styles.subtitle}>{location.replace(/^CR_|^SO_/,'')}</p>
        </div>
        <div className={styles.headerActions}>
          <button className={styles.btnIcon} onClick={exportCSV}><Download size={15}/></button>
          <button className={styles.btnPrimary} onClick={()=>setShowForm(v=>!v)}>
            <Plus size={15}/> Log Waste
          </button>
        </div>
      </div>

      {/* KPIs */}
      <div className={styles.kpiBar}>
        <div className={styles.kpi}>
          <div className={styles.kpiLabel}>Total Entries</div>
          <div className={styles.kpiValue}>{entries.length}</div>
        </div>
        <div className={styles.kpi}>
          <div className={styles.kpiLabel}>This Week</div>
          <div className={styles.kpiValue} style={{color:'#dc2626'}}>${thisWeek.toFixed(2)}</div>
        </div>
        <div className={styles.kpi}>
          <div className={styles.kpiLabel}>Total Waste Value</div>
          <div className={styles.kpiValue} style={{color:'#dc2626'}}>${totalWaste.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}</div>
        </div>
      </div>

      {/* Add form */}
      {showForm && (
        <div className={styles.formCard}>
          <div className={styles.formTitle}>New Waste Entry</div>
          <form onSubmit={handleSave} className={styles.form}>
            <div className={styles.formGrid}>
              <div className={styles.field}>
                <label className={styles.label}>Date</label>
                <input type="date" value={form.date} onChange={e=>setForm(f=>({...f,date:e.target.value}))} className={styles.input} required/>
              </div>
              <div className={styles.field} style={{gridColumn:'span 2'}}>
                <label className={styles.label}>Item Name</label>
                <input type="text" value={form.item} onChange={e=>setForm(f=>({...f,item:e.target.value}))}
                  placeholder="e.g. Chicken breast, Milk gallon" className={styles.input} required autoFocus/>
              </div>
              <div className={styles.field}>
                <label className={styles.label}>Units / Qty</label>
                <input type="number" min="0" step="0.1" value={form.units} onChange={e=>setForm(f=>({...f,units:e.target.value}))}
                  placeholder="0" className={styles.input}/>
              </div>
              <div className={styles.field}>
                <label className={styles.label}>Unit Cost ($)</label>
                <input type="number" min="0" step="0.01" value={form.unitCost} onChange={e=>setForm(f=>({...f,unitCost:e.target.value}))}
                  placeholder="0.00" className={styles.input}/>
              </div>
              <div className={styles.field}>
                <label className={styles.label}>Total Value</label>
                <div className={styles.totalDisplay}>
                  ${((parseFloat(form.units)||0)*(parseFloat(form.unitCost)||0)).toFixed(2)}
                </div>
              </div>
              <div className={styles.field}>
                <label className={styles.label}>GL Code</label>
                <select value={form.glCode} onChange={e=>setForm(f=>({...f,glCode:e.target.value}))} className={styles.input}>
                  <option value="">Select...</option>
                  {GL_CODES.map(g => <option key={g} value={g}>{g}</option>)}
                </select>
              </div>
              <div className={styles.field}>
                <label className={styles.label}>Reason</label>
                <select value={form.reason} onChange={e=>setForm(f=>({...f,reason:e.target.value}))} className={styles.input}>
                  <option value="">Select...</option>
                  {REASONS.map(r => <option key={r} value={r}>{r}</option>)}
                </select>
              </div>
            </div>
            <div className={styles.formActions}>
              <button type="button" className={styles.btnCancel} onClick={()=>{setShowForm(false);setForm(EMPTY_FORM)}}>Cancel</button>
              <button type="submit" className={styles.btnPrimary} disabled={saving}>{saving?'Saving...':'Save Entry'}</button>
            </div>
          </form>
        </div>
      )}

      {/* Table */}
      {loading ? (
        <div className={styles.loading}>Loading waste log...</div>
      ) : entries.length === 0 ? (
        <div className={styles.loading}>No waste entries yet. Click "Log Waste" to add one.</div>
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr className={styles.thead}>
                <th className={styles.th}>#</th>
                <th className={styles.th}>Date</th>
                <th className={styles.th}>Item</th>
                <th className={styles.thRight}>Units</th>
                <th className={styles.thRight}>Unit Cost</th>
                <th className={styles.thRight}>Total</th>
                <th className={styles.th}>GL Code</th>
                <th className={styles.th}>Reason</th>
                <th className={styles.th}></th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry, idx) => (
                <tr key={entry.id} className={`${styles.row} ${idx%2===0?'':styles.rowAlt}`}>
                  <td className={styles.tdNum}>{idx+1}</td>
                  <td className={styles.td}>{entry.date}</td>
                  <td className={styles.tdName}>{entry.item}</td>
                  <td className={styles.tdRight}>{entry.units}</td>
                  <td className={styles.tdRight}>${(entry.unitCost||0).toFixed(2)}</td>
                  <td className={styles.tdRight} style={{color:'#dc2626',fontWeight:700}}>${(entry.total||0).toFixed(2)}</td>
                  <td className={styles.td}><span className={styles.badge}>{entry.glCode?.replace('12000 - Inventory - ','').replace('12002 - Inventory - ','') || '—'}</span></td>
                  <td className={styles.td}>{entry.reason || '—'}</td>
                  <td className={styles.td}>
                    {deleteId === entry.id ? (
                      <div style={{display:'flex',gap:4}}>
                        <button className={styles.btnConfirm} onClick={()=>handleDelete(entry.id)}>Confirm</button>
                        <button className={styles.btnCancelSm} onClick={()=>setDeleteId(null)}>Cancel</button>
                      </div>
                    ) : (
                      <button className={styles.btnDelete} onClick={()=>setDeleteId(entry.id)}>
                        <Trash2 size={13}/>
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              <tr className={styles.totalRow}>
                <td colSpan={5} style={{textAlign:'right',padding:'10px 14px',fontWeight:700,color:'var(--text-secondary)'}}>TOTAL WASTE</td>
                <td className={styles.tdRight} style={{color:'#dc2626',fontWeight:800,fontSize:15}}>${totalWaste.toFixed(2)}</td>
                <td colSpan={3}></td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
