import { useState, useEffect, useMemo } from 'react'
import { useAuthStore } from '@/store/authStore'
import { useLocations, cleanLocName } from '@/store/LocationContext'
import { usePeriod } from '@/store/PeriodContext'
import { readPeriodClose } from '@/lib/pnl'
import { db } from '@/lib/firebase'
import {
  collection, query, orderBy, getDocs, addDoc, deleteDoc,
  doc, getDoc, serverTimestamp, updateDoc
} from 'firebase/firestore'
import { useToast } from '@/components/ui/Toast'
import { Download, Leaf, Droplets, Wind } from 'lucide-react'
import styles from './WasteLog.module.css'

const CATS = {
  landfill: { label: 'Landfill',  color: '#7a4a2e', bg: '#f5ece6', icon: '🗑️', desc: 'Non-recyclable waste' },
  compost:  { label: 'Compost',   color: '#4a7c3f', bg: '#eaf3e6', icon: '🌱', desc: 'Food scraps & organics' },
  recycle:  { label: 'Recycling', color: '#2c5f8a', bg: '#e4eef7', icon: '♻️', desc: 'Bottles, cans & paper' },
  donate:   { label: 'Donation',  color: '#8a6c2c', bg: '#f7f0e0', icon: '🤝', desc: 'Surplus food donations' },
}

const STEP  = 8
const VIEWS = ['Dashboard', 'Log', 'Weekly', 'Partners', 'ESG']

// ESG conversion factors
const CO2_PER_LB   = 3.8   // lbs CO2 per lb food waste diverted
const WATER_PER_LB = 100   // gallons water per lb food
const MEALS_PER_LB = 0.8   // meals per lb donated

function locationId(name) { return (name || '').replace(/[^a-zA-Z0-9]/g, '_') }
function fmt(oz) { return oz >= 160 ? (oz / 16).toFixed(1) + ' lbs' : oz.toFixed(1) + ' oz' }
function fmtLbs(oz) { return (oz / 16).toFixed(1) + ' lbs' }
function fmtDate(ds) { const d = new Date(ds + 'T12:00:00'); return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) }
function fmt$(v) { return '$' + Number(v || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) }

function totals(rows) {
  const t = { landfill: 0, compost: 0, recycle: 0, donate: 0 }
  rows.forEach(r => { t[r.cat] = +((t[r.cat] || 0) + (r.oz || 0)).toFixed(1) })
  return t
}

function totalCost(rows) {
  return rows.reduce((s, r) => s + (r.estimatedCost || 0), 0)
}

const EMPTY_QTY = { landfill: 0, compost: 0, recycle: 0, donate: 0 }

export default function WasteLog() {
  const toast = useToast()
  const { user }             = useAuthStore()
  const orgId                = user?.tenantId || 'fooda'
  const { selectedLocation } = useLocations()
  const { periodKey }        = usePeriod()
  const isDirector           = /^(admin|director)$/i.test(user?.role || '')

  const [entries,       setEntries]       = useState([])
  const [priorEntries,  setPriorEntries]  = useState([])
  const [inventoryMap,  setInventoryMap]  = useState({}) // item name → unit cost
  const [gfsSales,      setGfsSales]      = useState(0)
  const [loading,       setLoading]       = useState(false)
  const [view,          setView]          = useState('Dashboard')
  const [showModal,     setShowModal]     = useState(false)
  const [qty,           setQty]           = useState({ ...EMPTY_QTY })
  const [form,          setForm]          = useState({ date: new Date().toISOString().slice(0, 10), partner: '', item: '', notes: '' })
  const [saving,        setSaving]        = useState(false)

  const [periodClosed, setPeriodClosed] = useState(false)
  useEffect(() => {
    if (!selectedLocation || selectedLocation === 'all' || !periodKey) return
    (async () => {
      try {
        const close = await readPeriodClose(selectedLocation, periodKey)
        setPeriodClosed(close.periodStatus === 'closed')
      } catch {}
    })()
  }, [selectedLocation, periodKey])
  const [partnerFilter, setPartnerFilter] = useState('all')
  const location = selectedLocation === 'all' ? null : selectedLocation

  // Derive prior period key
  function getPriorKey(key) {
    const parts = key.match(/(\d+)-P(\d+)-W(\d+)/)
    if (!parts) return null
    let [, yr, p, w] = parts.map(Number)
    if (w > 1) return `${yr}-P${String(p).padStart(2,'0')}-W${w-1}`
    if (p > 1) return `${yr}-P${String(p-1).padStart(2,'0')}-W4`
    return `${yr-1}-P12-W4`
  }
  const priorKey = getPriorKey(periodKey)

  useEffect(() => {
    if (!location) { setEntries([]); return }
    load()
  }, [location, periodKey])

  const [tabClosed, setTabClosed] = useState(false)
  useEffect(() => {
    if (!location || location === 'all' || !periodKey) return
    (async () => {
      try {
        const { getDoc, doc: fbDoc } = await import('firebase/firestore')
        const oid = user?.tenantId || 'fooda'
        const ref = fbDoc(db, 'tenants', oid, 'wasteClose', `${(location||'').replace(/[^a-zA-Z0-9]/g,'_')}-${periodKey}`)
        const snap = await getDoc(ref)
        if (snap.exists()) setTabClosed(true)
      } catch {}
    })()
  }, [location, periodKey])

  async function handleCloseTab() {
    if (!location || location === 'all') return
    if (!window.confirm(`Close Waste for ${periodKey}?`)) return
    try {
      const { setDoc, doc: fbDoc, serverTimestamp } = await import('firebase/firestore')
      const oid = user?.tenantId || 'fooda'
      await setDoc(fbDoc(db, 'tenants', oid, 'wasteClose', `${(location||'').replace(/[^a-zA-Z0-9]/g,'_')}-${periodKey}`), {
        location: location, period: periodKey,
        closedBy: user?.name || user?.email, closedAt: serverTimestamp(),
      })
      const { writePnL: wp } = await import('@/lib/pnl')
      await wp(location, periodKey, { source_waste: 'closed' })
      setTabClosed(true)
      toast.success('Waste closed for ' + periodKey)
    } catch (err) {
      toast.error('Failed: ' + (err.message || ''))
    }
  }

  async function load() {
    setLoading(true)
    try {
      // Load waste entries for current period
      const ref  = collection(db, 'tenants', orgId, 'locations', locationId(location), 'waste')
      const snap = await getDocs(query(ref, orderBy('date', 'desc')))
      const all  = snap.docs.map(d => ({ id: d.id, ...d.data() }))
      // Filter to current period — entries within this period's date range
      setEntries(all)

      // Load prior period entries for variance
      if (priorKey) {
        const priorRef  = collection(db, 'tenants', orgId, 'locations', locationId(location), 'waste')
        const priorSnap = await getDocs(query(priorRef, orderBy('date', 'desc')))
        setPriorEntries(priorSnap.docs.map(d => ({ id: d.id, ...d.data() })).filter(e => e.periodKey === priorKey))
      }

      // Load inventory unit costs for dollar value calculation
      try {
        const invSnap = await getDoc(doc(db, 'tenants', orgId, 'locations', locationId(location), 'inventory', periodKey))
        if (invSnap.exists()) {
          const items = invSnap.data().items || []
          const map = {}
          items.forEach(i => { if (i.name) map[i.name.toLowerCase()] = i.unitCost || 0 })
          setInventoryMap(map)
        }
      } catch { /* no inventory yet */ }

      // Load GFS for shrinkage rate
      try {
        const pnlSnap = await getDoc(doc(db, 'tenants', orgId, 'pnl', locationId(location), 'periods', periodKey))
        if (pnlSnap.exists()) setGfsSales(pnlSnap.data().gfs_total || 0)
      } catch { /* no sales yet */ }

    } catch { toast.error('Something went wrong loading waste data.') }
    setLoading(false)
  }

  // Estimate dollar value from inventory map or default cost per oz
  function estimateCost(item, oz) {
    if (item) {
      const cost = inventoryMap[item.toLowerCase()]
      if (cost) return (oz / 16) * cost // rough oz-to-unit estimate
    }
    return (oz / 16) * 2.50 // default $2.50/lb if no item match
  }

  async function handleSave() {
    const totalOz = Object.values(qty).reduce((s, v) => s + v, 0)
    if (totalOz === 0) { toast.error('Please enter at least one waste amount'); return }
    setSaving(true)
    try {
      const ref = collection(db, 'tenants', orgId, 'locations', locationId(location), 'waste')
      const newEntries = []

      for (const [cat, oz] of Object.entries(qty)) {
        if (oz <= 0) continue
        const estimatedCost = estimateCost(form.item, oz)
        const entry = {
          date: form.date, partner: form.partner || '', item: form.item || '',
          notes: form.notes, cat, oz, estimatedCost,
          location, periodKey,
          createdBy: user?.name || user?.email || 'unknown',
          createdAt: serverTimestamp(),
        }
        const d = await addDoc(ref, entry)
        newEntries.push({ id: d.id, ...entry })
      }

      setEntries(prev => [...newEntries, ...prev])

      setQty({ ...EMPTY_QTY })
      setForm({ date: new Date().toISOString().slice(0, 10), partner: '', item: '', notes: '' })
      setShowModal(false)
      toast.success('Waste logged')
    } catch { toast.error('Something went wrong. Please try again.') }
    setSaving(false)
  }


  async function handleDelete(id) {
    await deleteDoc(doc(db, 'tenants', orgId, 'locations', locationId(location), 'waste', id))
    setEntries(prev => prev.filter(e => e.id !== id))
  }

  function generateDonationReceipt(entry) {
    const lbs = (entry.oz / 16).toFixed(2)
    const val = fmt$(entry.estimatedCost)
    const text = `FOOD DONATION RECEIPT\n\nDate: ${entry.date}\nPartner: ${entry.partner || 'N/A'}\nItem: ${entry.item || 'Assorted food items'}\nWeight: ${lbs} lbs\nEstimated Value: ${val}\nLocation: ${cleanLocName(location)}\n\nThis receipt may be used for tax purposes.\nGenerated by Aurelia FMS`
    const blob = new Blob([text], { type: 'text/plain' })
    const url  = URL.createObjectURL(blob)
    Object.assign(document.createElement('a'), { href: url, download: `donation-receipt-${entry.date}.txt` }).click()
    URL.revokeObjectURL(url)
  }

  function exportCSV() {
    const rows = [
      ['Date', 'Partner', 'Item', 'Category', 'Weight (oz)', 'Weight (lbs)', 'Est. Cost', 'Period', 'Notes'],
      ...filtered.map(r => [r.date, r.partner || '', r.item || '', CATS[r.cat]?.label || r.cat,
        r.oz, (r.oz / 16).toFixed(2), (r.estimatedCost || 0).toFixed(2), r.periodKey || '', r.notes || ''])
    ]
    const csv  = rows.map(r => r.map(v => `"${v}"`).join(',')).join('\n')
    const blob = new Blob([csv], { type: 'text/csv' })
    const url  = URL.createObjectURL(blob)
    Object.assign(document.createElement('a'), { href: url, download: `waste-${periodKey}.csv` }).click()
    URL.revokeObjectURL(url)
  }

  function adjQty(cat, dir) {
    setQty(prev => ({ ...prev, [cat]: Math.max(0, +(prev[cat] + dir * STEP).toFixed(1)) }))
  }

  // ── Derived ──────────────────────────────────────────────────
  const periodEntries = useMemo(() => entries.filter(e => e.periodKey === periodKey), [entries, periodKey])
  const filtered = useMemo(() => {
    let base = periodEntries
    if (partnerFilter !== 'all') base = base.filter(e => e.partner === partnerFilter)
    return base
  }, [periodEntries, partnerFilter])

  const t         = useMemo(() => totals(filtered), [filtered])
  const total     = Object.values(t).reduce((s, v) => s + v, 0)
  const totalCostAmt = useMemo(() => totalCost(filtered), [filtered])
  const divPct    = total > 0 ? Math.round((t.compost + t.recycle + t.donate) / total * 100) : 0
  const priorT    = useMemo(() => totals(priorEntries), [priorEntries])
  const priorTotal = Object.values(priorT).reduce((s, v) => s + v, 0)
  const shrinkRate = gfsSales > 0 ? (totalCostAmt / gfsSales) * 100 : null

  // ESG metrics
  const lbsDiverted   = (t.compost + t.recycle + t.donate) / 16
  const co2Saved      = lbsDiverted * CO2_PER_LB
  const waterSaved    = lbsDiverted * WATER_PER_LB
  const mealsDonated  = (t.donate / 16) * MEALS_PER_LB
  const costSaved     = totalCostAmt  // estimated dollar value of diverted waste

  const partners = useMemo(() => [...new Set(entries.map(e => e.partner))].filter(Boolean), [entries])
  const last7    = useMemo(() => {
    const days = []
    for (let i = 6; i >= 0; i--) {
      const d = new Date(); d.setDate(d.getDate() - i)
      days.push(d.toISOString().slice(0, 10))
    }
    return days
  }, [])

  if (!location) return (
    <div className={styles.empty}>
      <div style={{ fontSize: 40 }}>🌱</div>
      <p className={styles.emptyTitle}>Select a location</p>
      <p className={styles.emptySub}>Choose a location from the dropdown to track waste</p>
    </div>
  )

  return (
    <div className={styles.wrap}>

      {/* ── Header ── */}
      <div className={styles.header}>
        <nav className={styles.nav}>
          {VIEWS.map(v => (
            <button key={v} className={`${styles.navBtn} ${view === v ? styles.navActive : ''}`} onClick={() => setView(v)}>{v}</button>
          ))}
        </nav>
        <div className={styles.headerRight}>
          <button className={styles.btnExport} onClick={exportCSV}><Download size={13} /></button>
          <select className={styles.filterSel} value={partnerFilter} onChange={e => setPartnerFilter(e.target.value)}>
            <option value="all">All Partners</option>
            {partners.map(p => <option key={p} value={p}>{p}</option>)}
          </select>
          <button className={styles.addBtn} onClick={() => setShowModal(true)}>+ Log Entry</button>
        </div>
      </div>


      {/* ── Log entry modal ── */}
      {showModal && (
        <div className={styles.overlay} onClick={e => e.target === e.currentTarget && setShowModal(false)}>
          <div className={styles.modal}>
            <div className={styles.modalTitle}>Log <em>food waste</em></div>
            <div className={styles.modalSub}>Record what's going where — every ounce counts.</div>
            <div className={styles.formRow}>
              <div className={styles.formGroup}>
                <label className={styles.formLabel}>Date</label>
                <input className={styles.formInput} type="date" value={form.date} onChange={e => setForm(f => ({ ...f, date: e.target.value }))} />
              </div>
              <div className={styles.formGroup}>
                <label className={styles.formLabel}>Restaurant Partner</label>
                <input className={styles.formInput} type="text" value={form.partner}
                  onChange={e => setForm(f => ({ ...f, partner: e.target.value }))} placeholder="e.g. Bonehead Grill" />
              </div>
            </div>
            <div className={styles.formRow}>
              <div className={styles.formGroup}>
                <label className={styles.formLabel}>Item (optional)</label>
                <input className={styles.formInput} type="text" value={form.item}
                  onChange={e => setForm(f => ({ ...f, item: e.target.value }))} placeholder="e.g. Red Bull, Greek Yogurt" list="inv-items" />
                <datalist id="inv-items">
                  {Object.keys(inventoryMap).slice(0, 20).map(k => <option key={k} value={k} />)}
                </datalist>
              </div>
              <div className={styles.formGroup}>
                <label className={styles.formLabel}>Notes (optional)</label>
                <input className={styles.formInput} type="text" value={form.notes}
                  onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} placeholder="e.g. Expired, overstock..." />
              </div>
            </div>
            <hr className={styles.divider} />
            <div className={styles.qtyHeading}>How much waste?</div>
            <div className={styles.qtySub}>Tap + / − to add ounces · each dot = 8 oz</div>
            <div className={styles.qtyGrid}>
              {Object.entries(CATS).map(([k, c]) => {
                const v    = qty[k]
                const dots = Math.min(Math.round(v / STEP), 24)
                const est  = estimateCost(form.item, v)
                return (
                  <div key={k} className={styles.qtyCard} style={{ borderColor: v > 0 ? c.color : '' }}>
                    <div className={styles.qtyTop}>
                      <div className={styles.qtyIcon} style={{ background: c.bg }}>{c.icon}</div>
                      <div>
                        <div className={styles.qtyName}>{c.label}</div>
                        <div className={styles.qtyDesc}>{c.desc}</div>
                      </div>
                    </div>
                    <div className={styles.qtyStepper}>
                      <button className={styles.qtyBtn} onClick={() => adjQty(k, -1)}>−</button>
                      <input className={styles.qtyInput} type="number" min="0" step="0.1" value={v || ''}
                        onChange={e => setQty(prev => ({ ...prev, [k]: Math.max(0, parseFloat(e.target.value) || 0) }))}
                        placeholder="0" />
                      <button className={styles.qtyBtn} onClick={() => adjQty(k, 1)}>+</button>
                    </div>
                    {v > 0 && (
                      <div className={styles.qtyMeta}>
                        <span>{v} oz · {(v / 16).toFixed(2)} lbs</span>
                        <span className={styles.qtyEst}>≈ {fmt$(est)} value</span>
                      </div>
                    )}
                    <div className={styles.tallyDots}>
                      {Array.from({ length: dots }).map((_, i) => (
                        <div key={i} className={styles.tDot} style={{ background: c.color }} onClick={() => adjQty(k, -1)} />
                      ))}
                      {dots < 24 && <div className={styles.tPlus} style={{ borderColor: c.color, color: c.color }} onClick={() => adjQty(k, 1)}>+</div>}
                    </div>
                  </div>
                )
              })}
            </div>
            {/* Total cost estimate */}
            {Object.values(qty).some(v => v > 0) && (
              <div className={styles.costEstimate}>
                <span>Estimated waste value</span>
                <span className={styles.costEstAmt}>{fmt$(Object.entries(qty).reduce((s, [k, v]) => s + estimateCost(form.item, v), 0))}</span>
              </div>
            )}
            <div className={styles.formActions}>
              <button className={styles.btnCancel} onClick={() => setShowModal(false)}>Cancel</button>
              <button className={styles.btnSave} onClick={handleSave} disabled={saving}>{saving ? 'Saving...' : 'Log Entry'}</button>
            </div>
          </div>
        </div>
      )}

      {loading ? <div className={styles.loading}>Loading...</div> : (
        <>
          {/* ── DASHBOARD VIEW ── */}
          {view === 'Dashboard' && (
            <div className={styles.page}>
              <div className={styles.pageTitle}>Waste Log</div>
              <div className={styles.pageSub}>Shrinkage tracking, diversion targets, and ESG reporting · {cleanLocName(location)} · {periodKey}</div>

              {/* Hero metric — diversion rate (primary), waste value (supporting) */}
              <div className={styles.heroCard}>
                <div className={styles.heroLeft}>
                  <div className={styles.heroLabel}>Landfill Diversion Rate</div>
                  <div
                    className={styles.heroValue}
                    style={{ color: divPct >= 70 ? '#4a7c3f' : divPct >= 40 ? '#c77a1a' : '#E8593C' }}
                  >
                    {divPct}%
                  </div>
                  <div className={styles.heroSub}>
                    {priorTotal > 0 && (
                      <span style={{ color: total <= priorTotal ? '#4a7c3f' : '#E8593C' }}>
                        {total <= priorTotal ? '▼' : '▲'} {Math.abs(((total - priorTotal) / priorTotal) * 100).toFixed(1)}% total waste vs prior period
                      </span>
                    )}
                    {shrinkRate != null && <span className={styles.shrinkRate}>Shrinkage: {shrinkRate.toFixed(2)}% of GFS</span>}
                  </div>
                </div>
                <div className={styles.heroRight}>
                  <div className={styles.heroStat}>
                    <div className={styles.heroStatV}>{fmt$(totalCostAmt)}</div>
                    <div className={styles.heroStatL}>Waste value</div>
                  </div>
                  <div className={styles.heroStat}>
                    <div className={styles.heroStatV}>{fmt(total)}</div>
                    <div className={styles.heroStatL}>Total waste</div>
                  </div>
                  <div className={styles.heroStat}>
                    <div className={styles.heroStatV}>{filtered.length}</div>
                    <div className={styles.heroStatL}>Entries</div>
                  </div>
                </div>
              </div>

              {/* KPI grid */}
              <div className={styles.kpiGrid}>
                {Object.entries(CATS).map(([k, c]) => {
                  const pct      = total > 0 ? Math.round(t[k] / total * 100) : 0
                  const priorOz  = priorT[k] || 0
                  const trend    = priorOz > 0 ? ((t[k] - priorOz) / priorOz * 100) : null
                  const landfillAlert = k === 'landfill' && pct > 50 ? '#E8593C' : k === 'landfill' && pct > 30 ? '#c77a1a' : null
                  return (
                    <div
                      key={k}
                      className={styles.kpiCard}
                      style={{
                        borderTopColor: c.color,
                        ...(landfillAlert ? { outline: `2px solid ${landfillAlert}`, outlineOffset: '-2px' } : {})
                      }}
                    >
                      <div className={styles.kpiLabel}>{c.icon} {c.label}</div>
                      <div className={styles.kpiValue} style={{ color: c.color }}>{fmt(t[k])}</div>
                      <div className={styles.kpiPct} style={{ color: c.color }}>{pct}% of total</div>
                      {trend != null && (
                        <div className={styles.kpiTrend} style={{ color: (k === 'landfill' ? trend < 0 : trend > 0) ? '#4a7c3f' : '#E8593C' }}>
                          {trend >= 0 ? '▲' : '▼'} {Math.abs(trend).toFixed(1)}% vs prior
                        </div>
                      )}
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
                      const dt      = totals(dayRows)
                      const dayTot  = Object.values(dt).reduce((s, v) => s + v, 0)
                      const d       = new Date(ds + 'T12:00:00')
                      const dayLabel = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'][d.getDay()]
                      return (
                        <div key={ds} className={styles.barCol}>
                          <div className={styles.stackBar}>
                            {Object.entries(CATS).map(([k, c]) => (
                              dt[k] > 0 && <div key={k} style={{ height: `${dayTot > 0 ? (dt[k] / dayTot * 100) : 0}%`, background: c.color, borderRadius: 2 }} title={`${c.label}: ${dt[k]}oz`} />
                            ))}
                          </div>
                          <div className={styles.barLabel}>{dayLabel}</div>
                          {dayTot > 0 && <div className={styles.barVal}>{dayTot}oz</div>}
                        </div>
                      )
                    })}
                  </div>
                  <div className={styles.chartLegend}>
                    {Object.entries(CATS).map(([k, c]) => (
                      <div key={k} className={styles.legendItem}><div className={styles.legendDot} style={{ background: c.color }} />{c.label}</div>
                    ))}
                  </div>
                </div>

                {/* Diversion + shrinkage */}
                <div className={styles.card}>
                  <div className={styles.cardTitle}>Diversion split</div>
                  <div className={styles.donutLabels}>
                    {Object.entries(CATS).map(([k, c]) => {
                      const pct = total > 0 ? Math.round(t[k] / total * 100) : 0
                      return (
                        <div key={k} className={styles.donutRow}>
                          <div className={styles.donutSwatch} style={{ background: c.color }} />
                          <span className={styles.donutName}>{c.label}</span>
                          <span className={styles.donutVal}>{fmt(t[k])}</span>
                          <span className={styles.donutPct}>{pct}%</span>
                        </div>
                      )
                    })}
                  </div>
                  <hr className={styles.orangeRule} />
                  <div className={styles.goalRow}>
                    <span>Landfill diversion goal</span>
                    <span style={{ fontWeight: 700, color: divPct >= 70 ? '#4a7c3f' : divPct >= 50 ? '#8a6c2c' : '#E8593C' }}>{divPct}% / 70%</span>
                  </div>
                  <div className={styles.goalTrack}>
                    <div className={styles.goalFill} style={{ width: `${Math.min(divPct / 70 * 100, 100)}%`, background: divPct >= 70 ? '#4a7c3f' : divPct >= 50 ? '#8a6c2c' : '#E8593C' }} />
                  </div>
                  {shrinkRate != null && (
                    <div className={styles.shrinkCard}>
                      <span className={styles.shrinkLabel}>Shrinkage rate</span>
                      <span className={styles.shrinkVal} style={{ color: shrinkRate > 3 ? '#E8593C' : '#4a7c3f' }}>{shrinkRate.toFixed(2)}% of GFS</span>
                    </div>
                  )}
                </div>
              </div>

              {/* Bottom grid */}
              <div className={styles.bottomGrid}>
                <div className={styles.card}>
                  <div className={styles.cardTitle}>Recent entries</div>
                  <table className={styles.logTable}>
                    <thead><tr><th>Date</th><th>Partner</th><th>Item</th><th>Category</th><th>Weight</th><th>Value</th></tr></thead>
                    <tbody>
                      {[...filtered].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 6).map(r => (
                        <tr key={r.id}>
                          <td>{fmtDate(r.date)}</td>
                          <td>{r.partner || '—'}</td>
                          <td style={{ color: '#888' }}>{r.item || '—'}</td>
                          <td><span className={styles.badge} style={{ background: CATS[r.cat]?.bg, color: CATS[r.cat]?.color }}>{CATS[r.cat]?.icon} {CATS[r.cat]?.label}</span></td>
                          <td>{r.oz} oz</td>
                          <td style={{ color: '#E8593C' }}>{fmt$(r.estimatedCost || 0)}</td>
                        </tr>
                      ))}
                      {filtered.length === 0 && <tr><td colSpan={6} style={{ textAlign: 'center', color: '#999', padding: 20 }}>No entries yet</td></tr>}
                    </tbody>
                  </table>
                </div>
                <div className={styles.card}>
                  <div className={styles.cardTitle}>By restaurant partner</div>
                  {partners.slice(0, 5).map(p => {
                    const pRows = filtered.filter(e => e.partner === p)
                    const pt    = totals(pRows)
                    const pTot  = Object.values(pt).reduce((s, v) => s + v, 0)
                    const pCost = totalCost(pRows)
                    return (
                      <div key={p} className={styles.deptRow}>
                        <div className={styles.deptHeader}>
                          <span className={styles.deptName}>{p}</span>
                          <span className={styles.deptStat}>{fmt(pTot)} · {fmt$(pCost)}</span>
                        </div>
                        <div className={styles.stackedBar}>
                          {Object.entries(CATS).map(([k, c]) => (
                            pt[k] > 0 && <div key={k} className={styles.stackedSeg} style={{ width: `${pTot > 0 ? (pt[k] / pTot * 100) : 0}%`, background: c.color + 'bb' }} />
                          ))}
                        </div>
                      </div>
                    )
                  })}
                  {partners.length === 0 && <p style={{ color: '#999', fontSize: 13 }}>No entries yet</p>}
                </div>
              </div>
            </div>
          )}

          {/* ── LOG VIEW ── */}
          {view === 'Log' && (
            <div className={styles.page}>
              <div className={styles.pageTitle}>Entry <em>Log</em></div>
              <div className={styles.pageSub}>{periodKey} · {filtered.length} entries</div>
              <div className={styles.card}>
                <table className={styles.logTable}>
                  <thead><tr><th>Date</th><th>Partner</th><th>Item</th><th>Category</th><th>oz</th><th>Est. Value</th><th>Notes</th><th></th></tr></thead>
                  <tbody>
                    {filtered.map(r => (
                      <tr key={r.id}>
                        <td>{fmtDate(r.date)}</td>
                        <td>{r.partner || '—'}</td>
                        <td style={{ color: '#888' }}>{r.item || '—'}</td>
                        <td><span className={styles.badge} style={{ background: CATS[r.cat]?.bg, color: CATS[r.cat]?.color }}>{CATS[r.cat]?.icon} {CATS[r.cat]?.label}</span></td>
                        <td>{r.oz}</td>
                        <td style={{ color: '#E8593C', fontWeight: 600 }}>{fmt$(r.estimatedCost || 0)}</td>
                        <td style={{ color: '#6b6560' }}>{r.notes || '—'}</td>
                        <td>
                          <div style={{ display: 'flex', gap: 4 }}>
                            {r.cat === 'donate' && r.partner && (
                              <button className={styles.receiptBtn} onClick={() => generateDonationReceipt(r)} title="Download receipt">🧾</button>
                            )}
                            <button className={styles.delBtn} onClick={() => handleDelete(r.id)}>🗑</button>
                          </div>
                        </td>
                      </tr>
                    ))}
                    {filtered.length === 0 && <tr><td colSpan={8} style={{ textAlign: 'center', color: '#999', padding: 24 }}>No entries for this period</td></tr>}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* ── WEEKLY VIEW ── */}
          {view === 'Weekly' && (
            <div className={styles.page}>
              <div className={styles.pageTitle}>Weekly <em>Summary</em></div>
              <div className={styles.pageSub}>Totals by period</div>
              <div className={styles.card}>
                {(() => {
                  const periods = {}
                  entries.forEach(e => {
                    const key = e.periodKey || 'unknown'
                    if (!periods[key]) periods[key] = []
                    periods[key].push(e)
                  })
                  return Object.entries(periods).sort((a, b) => b[0].localeCompare(a[0])).map(([pk, rows]) => {
                    const wt    = totals(rows)
                    const wTot  = Object.values(wt).reduce((s, v) => s + v, 0)
                    const wCost = totalCost(rows)
                    return (
                      <div key={pk} className={styles.deptRow}>
                        <div className={styles.deptHeader}>
                          <span className={styles.deptName}>{pk}</span>
                          <span className={styles.deptStat}>{fmt(wTot)} · {fmt$(wCost)}</span>
                        </div>
                        <div className={styles.stackedBar}>
                          {Object.entries(CATS).map(([k, c]) => (
                            wt[k] > 0 && <div key={k} className={styles.stackedSeg} style={{ width: `${wTot > 0 ? (wt[k] / wTot * 100) : 0}%`, background: c.color + 'bb' }} />
                          ))}
                        </div>
                        <div style={{ display: 'flex', gap: 12, marginTop: 4, flexWrap: 'wrap' }}>
                          {Object.entries(CATS).map(([k, c]) => wt[k] > 0 && (
                            <span key={k} style={{ fontSize: 11, color: c.color }}>{c.icon} {fmt(wt[k])}</span>
                          ))}
                        </div>
                      </div>
                    )
                  })
                })()}
              </div>
            </div>
          )}

          {/* ── PARTNERS VIEW ── */}
          {view === 'Partners' && (
            <div className={styles.page}>
              <div className={styles.pageTitle}>Partner <em>Breakdown</em></div>
              <div className={styles.pageSub}>Waste composition by restaurant partner</div>
              <div className={styles.card}>
                {partners.map(p => {
                  const pRows = filtered.filter(e => e.partner === p)
                  const pt    = totals(pRows)
                  const pTot  = Object.values(pt).reduce((s, v) => s + v, 0)
                  const pCost = totalCost(pRows)
                  const donations = pRows.filter(e => e.cat === 'donate')
                  return (
                    <div key={p} className={styles.deptRow}>
                      <div className={styles.deptHeader}>
                        <span className={styles.deptName}>{p}</span>
                        <span className={styles.deptStat}>{fmt(pTot)} · {pRows.length} entries · {fmt$(pCost)}</span>
                      </div>
                      <div className={styles.stackedBar}>
                        {Object.entries(CATS).map(([k, c]) => (
                          pt[k] > 0 && <div key={k} className={styles.stackedSeg} style={{ width: `${pTot > 0 ? (pt[k] / pTot * 100) : 0}%`, background: c.color + 'bb' }} />
                        ))}
                      </div>
                      <div style={{ display: 'flex', gap: 12, marginTop: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                        {Object.entries(CATS).map(([k, c]) => pt[k] > 0 && (
                          <span key={k} className={styles.badge} style={{ background: c.bg, color: c.color }}>{c.icon} {fmt(pt[k])}</span>
                        ))}
                        {donations.length > 0 && (
                          <button className={styles.receiptBtn} onClick={() => generateDonationReceipt(donations[0])}>🧾 Receipt</button>
                        )}
                      </div>
                    </div>
                  )
                })}
                {partners.length === 0 && <p style={{ color: '#999', fontSize: 13 }}>No entries yet</p>}
              </div>
            </div>
          )}

          {/* ── ESG VIEW ── */}
          {view === 'ESG' && (
            <div className={styles.page}>
              <div className={styles.pageTitle}>ESG <em>Scorecard</em></div>
              <div className={styles.pageSub}>{cleanLocName(location)} · {periodKey} · Environmental impact of waste diversion</div>

              <div className={styles.esgGrid}>
                <div className={styles.esgCard} style={{ borderTopColor: '#4a7c3f' }}>
                  <Leaf size={24} color="#4a7c3f" />
                  <div className={styles.esgValue}>{co2Saved.toFixed(1)} lbs</div>
                  <div className={styles.esgLabel}>CO₂ equivalent saved</div>
                  <div className={styles.esgSub}>Based on {lbsDiverted.toFixed(1)} lbs diverted × 3.8 lbs CO₂/lb</div>
                </div>
                <div className={styles.esgCard} style={{ borderTopColor: '#2c5f8a' }}>
                  <Droplets size={24} color="#2c5f8a" />
                  <div className={styles.esgValue}>{waterSaved.toLocaleString()} gal</div>
                  <div className={styles.esgLabel}>Water saved</div>
                  <div className={styles.esgSub}>Based on 100 gallons per lb of food diverted</div>
                </div>
                <div className={styles.esgCard} style={{ borderTopColor: '#8a6c2c' }}>
                  <span style={{ fontSize: 24 }}>🤝</span>
                  <div className={styles.esgValue}>{mealsDonated.toFixed(0)}</div>
                  <div className={styles.esgLabel}>Meals donated</div>
                  <div className={styles.esgSub}>Estimated from {(t.donate / 16).toFixed(1)} lbs donated</div>
                </div>
                <div className={styles.esgCard} style={{ borderTopColor: '#E8593C' }}>
                  <Wind size={24} color="#E8593C" />
                  <div className={styles.esgValue}>{fmt$(costSaved)}</div>
                  <div className={styles.esgLabel}>Waste value diverted</div>
                  <div className={styles.esgSub}>Estimated dollar value of non-landfill waste</div>
                </div>
              </div>

              <div className={styles.card} style={{ marginTop: 16 }}>
                <div className={styles.cardTitle}>Diversion breakdown</div>
                <div className={styles.donutLabels}>
                  {Object.entries(CATS).map(([k, c]) => {
                    const pct = total > 0 ? Math.round(t[k] / total * 100) : 0
                    return (
                      <div key={k} className={styles.donutRow}>
                        <div className={styles.donutSwatch} style={{ background: c.color }} />
                        <span className={styles.donutName}>{c.icon} {c.label}</span>
                        <span className={styles.donutVal}>{fmtLbs(t[k])}</span>
                        <span className={styles.donutPct}>{pct}%</span>
                      </div>
                    )
                  })}
                </div>
                <hr className={styles.orangeRule} />
                <div className={styles.goalRow}>
                  <span>Overall diversion rate</span>
                  <span style={{ fontWeight: 700, color: divPct >= 70 ? '#4a7c3f' : '#E8593C' }}>{divPct}%</span>
                </div>
                <div className={styles.goalTrack}>
                  <div className={styles.goalFill} style={{ width: `${Math.min(divPct / 70 * 100, 100)}%`, background: divPct >= 70 ? '#4a7c3f' : '#E8593C' }} />
                </div>
                <div className={styles.goalNote}>
                  {divPct >= 70 ? '🎉 70% diversion goal achieved — excellent sustainability performance.' : `${70 - divPct}% more needed to reach the 70% diversion goal.`}
                </div>
              </div>
            </div>
          )}
        </>
      )}

      <button className={styles.fab} onClick={() => setShowModal(true)}>+</button>
    </div>
  )
}