import { useState, useEffect } from 'react'
import { useAuthStore } from '@/store/authStore'
import { useLocations, cleanLocName } from '@/store/LocationContext'
import { usePeriod } from '@/store/PeriodContext'
import { db } from '@/lib/firebase'
import { useToast } from '@/components/ui/Toast'
import AllLocationsGrid from '@/components/AllLocationsGrid'

// Waste Log — manual logging of KNOWN, explained waste (landfill/compost/recycle/donate).
// The computed sold-vs-counted variance ("shrinkage") now lives on /shrinkage; this page
// is only the waste diary. (Nav: "Waste Log".)

export default function WasteLog() {
  const user = useAuthStore(s => s.user)
  const orgId = user?.tenantId
  const { selectedLocation, setSelectedLocation } = useLocations()
  const { periodKey } = usePeriod()
  const toast = useToast()

  const location = selectedLocation === 'all' ? null : selectedLocation

  const [wasteEntries, setWasteEntries] = useState([])
  const [showWasteModal, setShowWasteModal] = useState(false)
  const [wasteForm, setWasteForm] = useState({ item: '', category: 'landfill', qty: 0, unit: 'oz', reason: '', notes: '' })
  const [wasteLoading, setWasteLoading] = useState(false)

  // ESC key closes modal
  useEffect(() => {
    function handleEsc(e) { if (e.key === 'Escape') setShowWasteModal(false) }
    window.addEventListener('keydown', handleEsc)
    return () => window.removeEventListener('keydown', handleEsc)
  }, [])

  const WASTE_CATS = {
    landfill: { label: 'Landfill', color: '#7a4a2e', bg: '#f5ece6' },
    compost: { label: 'Compost', color: '#4a7c3f', bg: '#eaf3e6' },
    recycle: { label: 'Recycling', color: '#2c5f8a', bg: '#e4eef7' },
    donate: { label: 'Donation', color: '#8a6c2c', bg: '#f7f0e0' },
  }
  const WASTE_REASONS = ['Expired', 'Overproduction', 'Prep waste', 'Spoilage', 'Damaged', 'Quality issue', 'Other']

  // Load waste log entries
  useEffect(() => {
    if (!orgId || !location || !periodKey) return
    const loadWaste = async () => {
      setWasteLoading(true)
      try {
        const { collection: col, getDocs, query: q, where } = await import('firebase/firestore')
        const snap = await getDocs(
          q(col(db, 'tenants', orgId, 'wasteLog'),
            where('location', '==', location),
            where('periodKey', '==', periodKey))
        )
        const entries = snap.docs.map(d => ({ id: d.id, ...d.data() }))
        entries.sort((a, b) => (b.date || '').localeCompare(a.date || ''))
        setWasteEntries(entries)
      } catch (err) { console.error('Failed to load waste log:', err) }
      setWasteLoading(false)
    }
    loadWaste()
  }, [orgId, location, periodKey])

  async function saveWasteEntry() {
    if (!wasteForm.item.trim() || wasteForm.qty <= 0) {
      toast.error('Enter item name and quantity')
      return
    }
    try {
      const { addDoc, collection: col, serverTimestamp } = await import('firebase/firestore')
      const entry = {
        item: wasteForm.item.trim(),
        category: wasteForm.category,
        qty: parseFloat(wasteForm.qty) || 0,
        unit: wasteForm.unit,
        reason: wasteForm.reason,
        notes: wasteForm.notes.trim(),
        location: location,
        periodKey: periodKey,
        date: new Date().toISOString().slice(0, 10),
        loggedBy: user?.name || user?.email || '',
        createdAt: serverTimestamp(),
      }
      const ref = await addDoc(col(db, 'tenants', orgId, 'wasteLog'), entry)
      setWasteEntries(prev => [{ id: ref.id, ...entry }, ...prev])
      setWasteForm({ item: '', category: 'landfill', qty: 0, unit: 'oz', reason: '', notes: '' })
      setShowWasteModal(false)
      toast.success('Waste entry logged')
    } catch (err) {
      toast.error('Failed to save: ' + (err.message || ''))
    }
  }

  const wasteTotals = wasteEntries.reduce((acc, e) => {
    const ozQty = e.unit === 'lbs' ? e.qty * 16 : e.qty
    acc[e.category] = (acc[e.category] || 0) + ozQty
    acc.total = (acc.total || 0) + ozQty
    return acc
  }, { landfill: 0, compost: 0, recycle: 0, donate: 0, total: 0 })

  const diversionPct = wasteTotals.total > 0
    ? Math.round(((wasteTotals.compost + wasteTotals.recycle + wasteTotals.donate) / wasteTotals.total) * 100)
    : 0

  if (!location) return (
    <AllLocationsGrid
      title="Waste Log"
      subtitle="Select a location to log waste"
      onSelectLocation={name => setSelectedLocation(name)}
      statusLabel="No data"
    />
  )

  return (
    <div style={{ padding: '1.5rem', maxWidth: 1400, margin: '0 auto' }}>
      {/* Waste Log Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20 }}>
        <div>
          <h1 style={{ fontSize: '1.5rem', fontWeight: 700, color: '#0f172a', margin: 0 }}>Waste log</h1>
          <p style={{ fontSize: 13, color: '#64748b', margin: '4px 0 0' }}>{cleanLocName(location)} · {periodKey}</p>
        </div>
        <button onClick={() => setShowWasteModal(true)} style={{
          padding: '8px 18px', fontSize: 13, fontWeight: 600,
          background: '#0f172a', color: '#fff', borderRadius: 8,
          border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6,
        }}>+ Log waste</button>
      </div>

      {/* Waste KPIs */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 12, marginBottom: 20 }}>
        {Object.entries(WASTE_CATS).map(([key, cat]) => (
          <div key={key} style={{ background: cat.bg, borderRadius: 10, padding: '14px 16px', borderTop: '3px solid ' + cat.color }}>
            <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.05em', textTransform: 'uppercase', color: cat.color, marginBottom: 4 }}>{cat.label}</div>
            <div style={{ fontSize: 22, fontWeight: 700, color: cat.color }}>{wasteTotals[key] >= 160 ? (wasteTotals[key] / 16).toFixed(1) + ' lbs' : Math.round(wasteTotals[key]) + ' oz'}</div>
            <div style={{ fontSize: 12, color: cat.color, marginTop: 2 }}>{wasteTotals.total > 0 ? Math.round(wasteTotals[key] / wasteTotals.total * 100) : 0}%</div>
          </div>
        ))}
        <div style={{ background: '#f1f5f9', borderRadius: 10, padding: '14px 16px' }}>
          <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.05em', textTransform: 'uppercase', color: '#64748b', marginBottom: 4 }}>Diversion</div>
          <div style={{ fontSize: 22, fontWeight: 700, color: '#0f172a' }}>{diversionPct}%</div>
          <div style={{ fontSize: 12, color: '#64748b', marginTop: 2 }}>Diverted (compost / recycle / donate)</div>
        </div>
      </div>

      {/* Waste Entries Table */}
      <div style={{ background: '#fff', border: '0.5px solid #e2e8f0', borderRadius: 12, overflow: 'hidden' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ background: '#f8fafc' }}>
              <th style={{ textAlign: 'left', padding: '10px 14px', fontWeight: 500, color: '#64748b', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Date</th>
              <th style={{ textAlign: 'left', padding: '10px 14px', fontWeight: 500, color: '#64748b', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Item</th>
              <th style={{ textAlign: 'left', padding: '10px 14px', fontWeight: 500, color: '#64748b', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Category</th>
              <th style={{ textAlign: 'right', padding: '10px 14px', fontWeight: 500, color: '#64748b', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Qty</th>
              <th style={{ textAlign: 'left', padding: '10px 14px', fontWeight: 500, color: '#64748b', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Reason</th>
              <th style={{ textAlign: 'left', padding: '10px 14px', fontWeight: 500, color: '#64748b', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Logged by</th>
            </tr>
          </thead>
          <tbody>
            {wasteLoading ? (
              <tr><td colSpan={6} style={{ padding: 40, textAlign: 'center', color: '#94a3b8' }}>Loading…</td></tr>
            ) : wasteEntries.length === 0 ? (
              <tr><td colSpan={6} style={{ padding: 40, textAlign: 'center', color: '#94a3b8' }}>No waste entries for this period. Click "+ Log waste" to start tracking.</td></tr>
            ) : wasteEntries.map(e => (
              <tr key={e.id} style={{ borderTop: '0.5px solid #f1f5f9' }}>
                <td style={{ padding: '10px 14px', color: '#64748b' }}>{e.date}</td>
                <td style={{ padding: '10px 14px', fontWeight: 500 }}>{e.item}</td>
                <td style={{ padding: '10px 14px' }}>
                  <span style={{
                    display: 'inline-block', padding: '3px 10px', borderRadius: 20, fontSize: 11, fontWeight: 600,
                    background: WASTE_CATS[e.category]?.bg || '#f1f5f9',
                    color: WASTE_CATS[e.category]?.color || '#64748b',
                  }}>{WASTE_CATS[e.category]?.label || e.category}</span>
                </td>
                <td style={{ padding: '10px 14px', textAlign: 'right', fontWeight: 500 }}>{e.qty} {e.unit}</td>
                <td style={{ padding: '10px 14px', color: '#64748b' }}>{e.reason || '—'}</td>
                <td style={{ padding: '10px 14px', color: '#94a3b8', fontSize: 12 }}>{e.loggedBy}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Waste Entry Modal */}
      {showWasteModal && (
        <>
          <div onClick={() => setShowWasteModal(false)} style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.4)', zIndex: 2900 }} />
          <div style={{
            position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%, -50%)',
            background: '#fff', borderRadius: 16, width: 520, maxWidth: '94vw', zIndex: 3000,
            boxShadow: '0 20px 60px rgba(15,23,42,0.15)', borderTop: '4px solid #F15D3B',
          }}>
            <div style={{ padding: '24px 28px' }}>
              <h2 style={{ fontSize: 20, fontWeight: 700, margin: '0 0 4px' }}>Log waste</h2>
              <p style={{ fontSize: 13, color: '#64748b', margin: '0 0 20px' }}>Record what was wasted and where it went.</p>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginBottom: 14 }}>
                <div>
                  <label style={{ fontSize: 11, fontWeight: 600, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.05em', display: 'block', marginBottom: 6 }}>Item</label>
                  <input type="text" value={wasteForm.item} onChange={e => setWasteForm(f => ({ ...f, item: e.target.value }))}
                    placeholder="e.g. Whole milk, chicken breast..." style={{ width: '100%', padding: '10px 12px', fontSize: 14, border: '1px solid #e2e8f0', borderRadius: 8 }} />
                </div>
                <div>
                  <label style={{ fontSize: 11, fontWeight: 600, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.05em', display: 'block', marginBottom: 6 }}>Reason</label>
                  <select value={wasteForm.reason} onChange={e => setWasteForm(f => ({ ...f, reason: e.target.value }))}
                    style={{ width: '100%', padding: '10px 12px', fontSize: 14, border: '1px solid #e2e8f0', borderRadius: 8, background: '#fff' }}>
                    <option value="">Select reason</option>
                    {WASTE_REASONS.map(r => <option key={r} value={r}>{r}</option>)}
                  </select>
                </div>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginBottom: 14 }}>
                <div>
                  <label style={{ fontSize: 11, fontWeight: 600, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.05em', display: 'block', marginBottom: 6 }}>Quantity</label>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <input type="number" min="0" step="0.5" value={wasteForm.qty || ''} onChange={e => setWasteForm(f => ({ ...f, qty: e.target.value }))}
                      placeholder="0" style={{ flex: 1, padding: '10px 12px', fontSize: 14, border: '1px solid #e2e8f0', borderRadius: 8 }} />
                    <select value={wasteForm.unit} onChange={e => setWasteForm(f => ({ ...f, unit: e.target.value }))}
                      style={{ width: 80, padding: '10px 8px', fontSize: 14, border: '1px solid #e2e8f0', borderRadius: 8, background: '#fff' }}>
                      <option value="oz">oz</option>
                      <option value="lbs">lbs</option>
                      <option value="each">each</option>
                      <option value="gal">gal</option>
                    </select>
                  </div>
                </div>
                <div>
                  <label style={{ fontSize: 11, fontWeight: 600, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.05em', display: 'block', marginBottom: 6 }}>Where did it go?</label>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 6 }}>
                    {Object.entries(WASTE_CATS).map(([key, cat]) => (
                      <button key={key} onClick={() => setWasteForm(f => ({ ...f, category: key }))}
                        style={{
                          padding: '8px 10px', fontSize: 12, fontWeight: 600, borderRadius: 8, cursor: 'pointer',
                          border: wasteForm.category === key ? '2px solid ' + cat.color : '1px solid #e2e8f0',
                          background: wasteForm.category === key ? cat.bg : '#fff',
                          color: wasteForm.category === key ? cat.color : '#64748b',
                        }}>{cat.label}</button>
                    ))}
                  </div>
                </div>
              </div>

              <div style={{ marginBottom: 14 }}>
                <label style={{ fontSize: 11, fontWeight: 600, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.05em', display: 'block', marginBottom: 6 }}>Notes (optional)</label>
                <input type="text" value={wasteForm.notes} onChange={e => setWasteForm(f => ({ ...f, notes: e.target.value }))}
                  placeholder="e.g. Left out overnight, prep scraps..." style={{ width: '100%', padding: '10px 12px', fontSize: 14, border: '1px solid #e2e8f0', borderRadius: 8 }} />
              </div>

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 20 }}>
                <button onClick={() => setShowWasteModal(false)} style={{
                  padding: '9px 18px', fontSize: 13, fontWeight: 500, border: '1px solid #e2e8f0', borderRadius: 8, background: '#fff', cursor: 'pointer', color: '#64748b',
                }}>Cancel</button>
                <button onClick={saveWasteEntry} style={{
                  padding: '9px 24px', fontSize: 13, fontWeight: 600, border: 'none', borderRadius: 8, background: '#F15D3B', color: '#fff', cursor: 'pointer',
                }}>Save entry</button>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
