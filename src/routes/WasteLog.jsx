import { useState, useEffect, useMemo } from 'react'
import { useAuthStore } from '@/store/authStore'
import { useLocations, cleanLocName } from '@/store/LocationContext'
import { db } from '@/lib/firebase'
import { collection, query, orderBy, getDocs, addDoc, deleteDoc, doc, serverTimestamp } from 'firebase/firestore'
import { useToast } from '@/components/ui/Toast'
import { writeWastePnL, weekPeriod } from '@/lib/pnl'
import styles from './WasteLog.module.css'

const CATS = {
  landfill: { label:'Landfill',  color:'#7a4a2e', bg:'#f5ece6', icon:'🗑️', desc:'Non-recyclable waste' },
  compost:  { label:'Compost',   color:'#4a7c3f', bg:'#eaf3e6', icon:'🌱', desc:'Food scraps & organics' },
  recycle:  { label:'Recycling', color:'#2c5f8a', bg:'#e4eef7', icon:'♻️', desc:'Bottles, cans & paper' },
  donate:   { label:'Donation',  color:'#8a6c2c', bg:'#f7f0e0', icon:'🤝', desc:'Surplus food donations' },
}
const STEP = 8
const VIEWS = ['Dashboard','Log','Weekly','Partners']

function locationId(name) { return name.replace(/[^a-zA-Z0-9]/g, '_') }
function fmt(oz) { return oz >= 160 ? (oz/16).toFixed(1)+' lbs' : oz.toFixed(1)+' oz' }
function fmtDate(ds) { const d = new Date(ds+'T12:00:00'); return d.toLocaleDateString('en-US',{month:'short',day:'numeric'}) }
function totals(rows) {
  const t = {landfill:0,compost:0,recycle:0,donate:0}
  rows.forEach(r => t[r.cat] = +(t[r.cat] + (r.oz||0)).toFixed(1))
  return t
}

const EMPTY_QTY = {landfill:0,compost:0,recycle:0,donate:0}

export default function WasteLog() {
  const toast = useToast()
  const { user }             = useAuthStore()
  const { selectedLocation } = useLocations()
  const [entries, setEntries] = useState([])
  const [loading, setLoading] = useState(false)
  const [view, setView]       = useState('Dashboard')
  const [showModal, setShowModal] = useState(false)
  const [qty, setQty]         = useState({...EMPTY_QTY})
  const [form, setForm]       = useState({ date: new Date().toISOString().slice(0,10), partner:'', notes:'' })
  const [saving, setSaving]   = useState(false)
  const [partnerFilter, setPartnerFilter] = useState('all')

  const location = selectedLocation === 'all' ? null : selectedLocation

  useEffect(() => {
    if (!location) { setEntries([]); return }
    load()
  }, [location])

  async function load() {
    setLoading(true)
    try {
      const ref  = collection(db,'tenants','fooda','locations',locationId(location),'waste')
      const snap = await getDocs(query(ref, orderBy('date','desc')))
      setEntries(snap.docs.map(d => ({ id:d.id, ...d.data() })))
    } catch(e) { toast.error('Something went wrong. Please try again.') }
    setLoading(false)
  }

  async function handleSave() {
    const totalOz = Object.values(qty).reduce((s,v) => s+v, 0)
    if (!form.partner || totalOz === 0) return
    setSaving(true)
    try {
      const ref = collection(db,'tenants','fooda','locations',locationId(location),'waste')
      // Save one entry per category with oz > 0
      const promises = Object.entries(qty).filter(([,v]) => v > 0).map(([cat,oz]) =>
        addDoc(ref, {
          date: form.date, partner: form.partner, notes: form.notes,
          cat, oz, location, createdBy: user?.email||'unknown', createdAt: serverTimestamp()
        })
      )
      const docs = await Promise.all(promises)
      const newEntries = Object.entries(qty).filter(([,v]) => v>0).map(([cat,oz],i) => ({
        id: docs[i].id, date: form.date, partner: form.partner, notes: form.notes,
        cat, oz, location
      }))
      setEntries(prev => [...newEntries, ...prev])
      setQty({...EMPTY_QTY})
      setForm({ date: new Date().toISOString().slice(0,10), partner:'', notes:'' })
      // Write to P&L
      if (location) {
        const allWaste = [...entries, { ...form, total: formTotal }]
        const now = new Date(), weekAgo = new Date(now - 7*24*60*60*1000)
        const weekWaste = allWaste.filter(e => new Date(e.date) >= weekAgo)
        const wasteCost = weekWaste.reduce((s,e)=>s+(e.total||0),0)
        const wasteOz   = weekWaste.reduce((s,e)=>s+(e.oz||0),0)
        await writeWastePnL(location, weekPeriod(), { wasteCost, wasteOz })
      }
      toast.success('Waste entry logged!')
      setShowModal(false)
    } catch(e) { toast.error('Something went wrong. Please try again.') }
    setSaving(false)
  }

  async function handleDelete(id) {
    await deleteDoc(doc(db,'tenants','fooda','locations',locationId(location),'waste',id))
    setEntries(prev => prev.filter(e => e.id !== id))
  }

  function adjQty(cat, dir) {
    setQty(prev => ({ ...prev, [cat]: Math.max(0, +(prev[cat] + dir*STEP).toFixed(1)) }))
  }

  const filtered = useMemo(() => {
    if (partnerFilter === 'all') return entries
    return entries.filter(e => e.partner === partnerFilter)
  }, [entries, partnerFilter])

  const t = useMemo(() => totals(filtered), [filtered])
  const total = Object.values(t).reduce((s,v) => s+v, 0)
  const divPct = total > 0 ? Math.round((t.compost+t.recycle+t.donate)/total*100) : 0

  const partners = useMemo(() => [...new Set(entries.map(e => e.partner))].filter(Boolean), [entries])

  // Last 7 days for bar chart
  const last7 = useMemo(() => {
    const days = []
    for (let i=6; i>=0; i--) {
      const d = new Date(); d.setDate(d.getDate()-i)
      days.push(d.toISOString().slice(0,10))
    }
    return days
  }, [])

  if (!location) return (
    <div className={styles.empty}>
      <div style={{fontSize:40}}>🌱</div>
      <p className={styles.emptyTitle}>Select a location</p>
      <p className={styles.emptySub}>Choose a location from the dropdown to track waste</p>
    </div>
  )

  return (
    <div className={styles.wrap}>
      {/* Header */}
      <div className={styles.header}>
        <nav className={styles.nav}>
          {VIEWS.map(v => (
            <button key={v} className={`${styles.navBtn} ${view===v?styles.navActive:''}`} onClick={()=>setView(v)}>{v}</button>
          ))}
        </nav>
        <div className={styles.headerRight}>
          <select className={styles.filterSel} value={partnerFilter} onChange={e=>setPartnerFilter(e.target.value)}>
            <option value="all">All Partners</option>
            {partners.map(p => <option key={p} value={p}>{p}</option>)}
          </select>
          <button className={styles.addBtn} onClick={()=>setShowModal(true)}>+ Log Entry</button>
        </div>
      </div>

      {/* MODAL */}
      {showModal && (
        <div className={styles.overlay} onClick={e=>e.target===e.currentTarget&&setShowModal(false)}>
          <div className={styles.modal}>
            <div className={styles.modalTitle}>Log <em>food waste</em></div>
            <div className={styles.modalSub}>Record what's going where — every ounce counts.</div>
            <div className={styles.formRow}>
              <div className={styles.formGroup}>
                <label className={styles.formLabel}>Date</label>
                <input className={styles.formInput} type="date" value={form.date} onChange={e=>setForm(f=>({...f,date:e.target.value}))}/>
              </div>
              <div className={styles.formGroup}>
                <label className={styles.formLabel}>Restaurant Partner</label>
                <input className={styles.formInput} type="text" value={form.partner}
                  onChange={e=>setForm(f=>({...f,partner:e.target.value}))} placeholder="e.g. Bonehead Grill"/>
              </div>
            </div>
            <div className={styles.formRowSingle}>
              <div className={styles.formGroup}>
                <label className={styles.formLabel}>Notes (optional)</label>
                <input className={styles.formInput} type="text" value={form.notes}
                  onChange={e=>setForm(f=>({...f,notes:e.target.value}))} placeholder="e.g. Lunch prep scraps, expired produce…"/>
              </div>
            </div>
            <hr className={styles.divider}/>
            <div className={styles.qtyHeading}>How much waste?</div>
            <div className={styles.qtySub}>Tap + / − to add ounces · each dot = 8 oz</div>
            <div className={styles.qtyGrid}>
              {Object.entries(CATS).map(([k,c]) => {
                const v = qty[k]
                const dots = Math.min(Math.round(v/STEP), 24)
                return (
                  <div key={k} className={styles.qtyCard} style={{borderColor: v>0?c.color:''}}>
                    <div className={styles.qtyTop}>
                      <div className={styles.qtyIcon} style={{background:c.bg}}>{c.icon}</div>
                      <div><div className={styles.qtyName}>{c.label}</div><div className={styles.qtyDesc}>{c.desc}</div></div>
                    </div>
                    <div className={styles.qtyStepper}>
                      <button className={styles.qtyBtn} onClick={()=>adjQty(k,-1)}>−</button>
                      <input className={styles.qtyInput} type="number" min="0" step="0.1" value={v||''}
                        onChange={e=>setQty(prev=>({...prev,[k]:Math.max(0,parseFloat(e.target.value)||0)}))}
                        placeholder="0"/>
                      <button className={styles.qtyBtn} onClick={()=>adjQty(k,1)}>+</button>
                    </div>
                    {v > 0 && <div className={styles.qtyLbs}>{v} oz · {(v/16).toFixed(2)} lbs</div>}
                    <div className={styles.tallyDots}>
                      {Array.from({length:dots}).map((_,i) => (
                        <div key={i} className={styles.tDot} style={{background:c.color}} onClick={()=>adjQty(k,-1)}/>
                      ))}
                      {dots < 24 && <div className={styles.tPlus} style={{borderColor:c.color,color:c.color}} onClick={()=>adjQty(k,1)}>+</div>}
                    </div>
                  </div>
                )
              })}
            </div>
            <div className={styles.formActions}>
              <button className={styles.btnCancel} onClick={()=>setShowModal(false)}>Cancel</button>
              <button className={styles.btnSave} onClick={handleSave} disabled={saving}>{saving?'Saving...':'Save Entry'}</button>
            </div>
          </div>
        </div>
      )}

      {loading ? <div className={styles.loading}>Loading...</div> : (

        view === 'Dashboard' ? (
          <div className={styles.page}>
            <div className={styles.pageTitle}>Peel <em>Back</em> Waste</div>
            <div className={styles.pageSub}>{cleanLocName(location)} · Last 14 days</div>

            {/* KPI grid */}
            <div className={styles.kpiGrid}>
              {Object.entries(CATS).map(([k,c]) => {
                const pct = total > 0 ? Math.round(t[k]/total*100) : 0
                return (
                  <div key={k} className={styles.kpiCard} style={{borderTopColor:c.color}}>
                    <div className={styles.kpiLabel}>{c.icon} {c.label}</div>
                    <div className={styles.kpiValue} style={{color:c.color}}>{fmt(t[k])}</div>
                    <div className={styles.kpiPct} style={{color:c.color}}>{pct}% of total</div>
                  </div>
                )
              })}
            </div>

            <div className={styles.mainGrid}>
              {/* Stacked bar — last 7 days */}
              <div className={styles.card}>
                <div className={styles.cardTitle}>Daily breakdown <span>oz by category, last 7 days</span></div>
                <div className={styles.simpleBarWrap}>
                  {last7.map(ds => {
                    const dayRows = filtered.filter(e => e.date === ds)
                    const dt = totals(dayRows)
                    const dayTotal = Object.values(dt).reduce((s,v)=>s+v,0)
                    const d = new Date(ds+'T12:00:00')
                    const dayLabel = ['Su','Mo','Tu','We','Th','Fr','Sa'][d.getDay()]
                    return (
                      <div key={ds} className={styles.barCol}>
                        <div className={styles.stackBar}>
                          {Object.entries(CATS).map(([k,c]) => (
                            dt[k] > 0 && <div key={k} style={{height: `${dayTotal>0?(dt[k]/dayTotal*100):0}%`, background:c.color, borderRadius:2}} title={`${c.label}: ${dt[k]}oz`}/>
                          ))}
                        </div>
                        <div className={styles.barLabel}>{dayLabel}</div>
                        {dayTotal > 0 && <div className={styles.barVal}>{dayTotal}oz</div>}
                      </div>
                    )
                  })}
                </div>
                <div className={styles.chartLegend}>
                  {Object.entries(CATS).map(([k,c]) => (
                    <div key={k} className={styles.legendItem}><div className={styles.legendDot} style={{background:c.color}}/>{c.label}</div>
                  ))}
                </div>
              </div>

              {/* Diversion */}
              <div className={styles.card}>
                <div className={styles.cardTitle}>Diversion split</div>
                <div className={styles.donutLabels}>
                  {Object.entries(CATS).map(([k,c]) => {
                    const pct = total > 0 ? Math.round(t[k]/total*100) : 0
                    return (
                      <div key={k} className={styles.donutRow}>
                        <div className={styles.donutSwatch} style={{background:c.color}}/>
                        <span className={styles.donutName}>{c.label}</span>
                        <span className={styles.donutVal}>{fmt(t[k])}</span>
                        <span className={styles.donutPct}>{pct}%</span>
                      </div>
                    )
                  })}
                </div>
                <hr className={styles.orangeRule}/>
                <div className={styles.cardTitle} style={{marginBottom:8}}>Landfill diversion <span>{divPct}%</span></div>
                <div className={styles.goalRow}>
                  <span>Progress toward 70% goal</span>
                  <span style={{fontWeight:700,color:divPct>=70?'#4a7c3f':divPct>=50?'#8a6c2c':'#E8593C'}}>{divPct}%</span>
                </div>
                <div className={styles.goalTrack}>
                  <div className={styles.goalFill} style={{width:`${Math.min(divPct,100)}%`, background:divPct>=70?'#4a7c3f':divPct>=50?'#8a6c2c':'#E8593C'}}/>
                </div>
                <div className={styles.goalNote}>
                  {divPct >= 70 ? '🎉 Goal reached! Great work diverting waste from landfill.' : `${70-divPct}% more to reach the 70% diversion goal.`}
                </div>
              </div>
            </div>

            {/* Recent entries */}
            <div className={styles.bottomGrid}>
              <div className={styles.card}>
                <div className={styles.cardTitle}>Recent entries</div>
                <table className={styles.logTable}>
                  <thead><tr><th>Date</th><th>Partner</th><th>Category</th><th>Weight</th></tr></thead>
                  <tbody>
                    {[...filtered].sort((a,b)=>b.date.localeCompare(a.date)).slice(0,6).map(r => (
                      <tr key={r.id}>
                        <td>{fmtDate(r.date)}</td>
                        <td>{r.partner}</td>
                        <td><span className={styles.badge} style={{background:CATS[r.cat]?.bg,color:CATS[r.cat]?.color}}>{CATS[r.cat]?.icon} {CATS[r.cat]?.label}</span></td>
                        <td>{r.oz} oz</td>
                      </tr>
                    ))}
                    {filtered.length === 0 && <tr><td colSpan={4} style={{textAlign:'center',color:'#999',padding:20}}>No entries yet</td></tr>}
                  </tbody>
                </table>
              </div>
              <div className={styles.card}>
                <div className={styles.cardTitle}>By restaurant partner</div>
                {partners.slice(0,6).map(p => {
                  const pRows = filtered.filter(e => e.partner === p)
                  const pt = totals(pRows)
                  const pTotal = Object.values(pt).reduce((s,v)=>s+v,0)
                  return (
                    <div key={p} className={styles.deptRow}>
                      <div className={styles.deptHeader}>
                        <span className={styles.deptName}>{p}</span>
                        <span className={styles.deptStat}>{fmt(pTotal)}</span>
                      </div>
                      <div className={styles.stackedBar}>
                        {Object.entries(CATS).map(([k,c]) => (
                          pt[k] > 0 && <div key={k} className={styles.stackedSeg} style={{width:`${pTotal>0?(pt[k]/pTotal*100):0}%`,background:c.color+'bb'}}/>
                        ))}
                      </div>
                    </div>
                  )
                })}
                {partners.length === 0 && <p style={{color:'#999',fontSize:13}}>No entries yet</p>}
              </div>
            </div>
          </div>
        )

        : view === 'Log' ? (
          <div className={styles.page}>
            <div className={styles.pageTitle}>Entry <em>Log</em></div>
            <div className={styles.pageSub}>All recorded waste entries</div>
            <div className={styles.card}>
              <table className={styles.logTable}>
                <thead><tr><th>Date</th><th>Partner</th><th>Category</th><th>Weight (oz)</th><th>Notes</th><th></th></tr></thead>
                <tbody>
                  {filtered.map(r => (
                    <tr key={r.id}>
                      <td>{fmtDate(r.date)}</td>
                      <td>{r.partner}</td>
                      <td><span className={styles.badge} style={{background:CATS[r.cat]?.bg,color:CATS[r.cat]?.color}}>{CATS[r.cat]?.icon} {CATS[r.cat]?.label}</span></td>
                      <td>{r.oz}</td>
                      <td style={{color:'#6b6560'}}>{r.notes||'—'}</td>
                      <td><button className={styles.delBtn} onClick={()=>handleDelete(r.id)}>🗑</button></td>
                    </tr>
                  ))}
                  {filtered.length === 0 && <tr><td colSpan={6} style={{textAlign:'center',color:'#999',padding:24}}>No entries yet</td></tr>}
                </tbody>
              </table>
            </div>
          </div>
        )

        : view === 'Weekly' ? (
          <div className={styles.page}>
            <div className={styles.pageTitle}>Weekly <em>Summary</em></div>
            <div className={styles.pageSub}>Totals by week</div>
            <div className={styles.card}>
              {/* Group by week */}
              {(() => {
                const weeks = {}
                filtered.forEach(e => {
                  const d = new Date(e.date+'T12:00:00')
                  const y = d.getFullYear()
                  const wk = Math.ceil(((d - new Date(y,0,1))/86400000 + new Date(y,0,1).getDay()+1)/7)
                  const key = `${y}-W${String(wk).padStart(2,'0')}`
                  if (!weeks[key]) weeks[key] = []
                  weeks[key].push(e)
                })
                return Object.entries(weeks).sort((a,b)=>b[0].localeCompare(a[0])).map(([wk,rows]) => {
                  const wt = totals(rows)
                  const wTotal = Object.values(wt).reduce((s,v)=>s+v,0)
                  return (
                    <div key={wk} className={styles.deptRow}>
                      <div className={styles.deptHeader}>
                        <span className={styles.deptName}>{wk}</span>
                        <span className={styles.deptStat}>{fmt(wTotal)}</span>
                      </div>
                      <div className={styles.stackedBar}>
                        {Object.entries(CATS).map(([k,c]) => (
                          wt[k] > 0 && <div key={k} className={styles.stackedSeg} style={{width:`${wTotal>0?(wt[k]/wTotal*100):0}%`,background:c.color+'bb'}}/>
                        ))}
                      </div>
                      <div style={{display:'flex',gap:12,marginTop:4,flexWrap:'wrap'}}>
                        {Object.entries(CATS).map(([k,c]) => wt[k]>0 && (
                          <span key={k} style={{fontSize:11,color:c.color}}>{c.icon} {fmt(wt[k])}</span>
                        ))}
                      </div>
                    </div>
                  )
                })
              })()}
            </div>
          </div>
        )

        : (
          <div className={styles.page}>
            <div className={styles.pageTitle}>Partner <em>Breakdown</em></div>
            <div className={styles.pageSub}>Waste composition by restaurant partner</div>
            <div className={styles.card}>
              {partners.map(p => {
                const pRows = filtered.filter(e => e.partner === p)
                const pt = totals(pRows)
                const pTotal = Object.values(pt).reduce((s,v)=>s+v,0)
                return (
                  <div key={p} className={styles.deptRow}>
                    <div className={styles.deptHeader}>
                      <span className={styles.deptName}>{p}</span>
                      <span className={styles.deptStat}>{fmt(pTotal)} · {pRows.length} entries</span>
                    </div>
                    <div className={styles.stackedBar}>
                      {Object.entries(CATS).map(([k,c]) => (
                        pt[k] > 0 && <div key={k} className={styles.stackedSeg} style={{width:`${pTotal>0?(pt[k]/pTotal*100):0}%`,background:c.color+'bb'}}/>
                      ))}
                    </div>
                    <div style={{display:'flex',gap:12,marginTop:6,flexWrap:'wrap'}}>
                      {Object.entries(CATS).map(([k,c]) => pt[k]>0 && (
                        <span key={k} className={styles.badge} style={{background:c.bg,color:c.color}}>{c.icon} {fmt(pt[k])}</span>
                      ))}
                    </div>
                  </div>
                )
              })}
              {partners.length === 0 && <p style={{color:'#999',fontSize:13}}>No entries yet</p>}
            </div>
          </div>
        )
      )}
      {/* Mobile FAB */}
      <button className={styles.fab} onClick={()=>setShowModal(true)}>+</button>
    </div>
  )
}
