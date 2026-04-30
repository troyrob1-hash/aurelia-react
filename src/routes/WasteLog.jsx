import { useState, useEffect, useMemo } from 'react'
import { useAuthStore } from '@/store/authStore'
import { useLocations, cleanLocName } from '@/store/LocationContext'
import { usePeriod } from '@/store/PeriodContext'
import { db } from '@/lib/firebase'
import { collection, getDocs, doc, getDoc, addDoc, serverTimestamp } from 'firebase/firestore'
import { useToast } from '@/components/ui/Toast'
import { Download, Upload, AlertTriangle, TrendingDown, TrendingUp, Search } from 'lucide-react'
import AllLocationsGrid from '@/components/AllLocationsGrid'
import styles from './WasteLog.module.css'

function locId(n) { return (n || '').replace(/[^a-zA-Z0-9]/g, '_') }
const fmt$ = v => '$' + Number(v || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const fmtN = v => Number(v || 0).toLocaleString('en-US', { maximumFractionDigits: 1 })

export default function WasteLog() {
  const user = useAuthStore(s => s.user)
  const orgId = user?.tenantId || 'fooda'
  const { selectedLocation, setSelectedLocation, visibleLocations } = useLocations()
  const { periodKey, year, period, week } = usePeriod()
  const toast = useToast()

  const location = selectedLocation === 'all' ? null : selectedLocation

  const [catalogItems, setCatalogItems] = useState([])
  const [posData, setPosData] = useState({})       // { skuId: { sold: N } }
  const [inventoryData, setInventoryData] = useState({ opening: {}, closing: {} })
  const [purchaseData, setPurchaseData] = useState({})  // { skuId: { received: N } }
  const [search, setSearch] = useState('')
  const [sortBy, setSortBy] = useState('shrinkage')  // shrinkage, name, value
  const [loading, setLoading] = useState(false)
  const [view, setView] = useState('sku')  // sku, summary, import

  // Load catalog + inventory + purchasing data
  useEffect(() => {
    if (!location || !orgId) return
    setLoading(true)
    ;(async () => {
      try {
        // Load catalog
        const catSnap = await getDocs(collection(db, 'tenants', orgId, 'inventoryCatalog'))
        const items = catSnap.docs.map(d => ({ id: d.id, ...d.data() }))
        setCatalogItems(items)

        // Load inventory data — opening (prior period closing) and current counts
        const lk = locId(location)
        const { getPriorKey } = await import('@/lib/pnl')
        const priorPK = getPriorKey(periodKey)

        const opening = {}
        const closing = {}

        if (priorPK) {
          const priorSnap = await getDoc(doc(db, 'tenants', orgId, 'locations', lk, 'inventory', priorPK))
          if (priorSnap.exists()) {
            const priorItems = priorSnap.data().items || []
            priorItems.forEach(i => { opening[i.id] = i.qty || 0 })
          }
        }

        const currentSnap = await getDoc(doc(db, 'tenants', orgId, 'locations', lk, 'inventory', periodKey))
        if (currentSnap.exists()) {
          const currentItems = currentSnap.data().items || []
          currentItems.forEach(i => { closing[i.id] = i.qty || 0 })
        }
        setInventoryData({ opening, closing })

        // Load POS data (if uploaded)
        const posSnap = await getDoc(doc(db, 'tenants', orgId, 'posData', lk + '_' + periodKey))
        if (posSnap.exists()) {
          setPosData(posSnap.data().items || {})
        } else {
          setPosData({})
        }

        // Load purchase data from orders/invoices
        const purchases = {}
        const orderSnap = await getDocs(collection(db, 'tenants', orgId, 'orders'))
        orderSnap.docs.forEach(d => {
          const order = d.data()
          if (order.location !== location || order.periodKey !== periodKey) return
          ;(order.lineItems || []).forEach(li => {
            const id = li.id || li.sku
            if (id) purchases[id] = (purchases[id] || 0) + (li.qty || 0)
          })
        })
        setPurchaseData(purchases)

      } catch (err) {
        console.error('Shrinkage load failed:', err)
      }
      setLoading(false)
    })()
  }, [location, periodKey, orgId])

  // Compute shrinkage per SKU
  const shrinkageData = useMemo(() => {
    return catalogItems.map(item => {
      const open = inventoryData.opening[item.id] || 0
      const close = inventoryData.closing[item.id] || 0
      const purchased = purchaseData[item.id] || 0
      const sold = posData[item.id]?.sold || posData[item.id] || 0
      const expected = open + purchased - (typeof sold === 'number' ? sold : 0)
      const shrinkage = expected - close
      const shrinkageValue = shrinkage * (item.unitCost || 0)
      const shrinkagePct = expected > 0 ? (shrinkage / expected) * 100 : 0

      return {
        ...item,
        open, close, purchased, sold: typeof sold === 'number' ? sold : 0,
        expected, shrinkage, shrinkageValue, shrinkagePct,
        hasPosData: typeof sold === 'number' && sold > 0,
        hasInventory: close > 0 || open > 0,
      }
    }).filter(item => item.hasInventory || item.hasPosData || item.purchased > 0)
  }, [catalogItems, inventoryData, purchaseData, posData])

  // Filter and sort
  const filtered = useMemo(() => {
    let items = shrinkageData
    if (search) {
      const s = search.toLowerCase()
      items = items.filter(i => i.name?.toLowerCase().includes(s) || i.sku?.toLowerCase().includes(s))
    }
    if (sortBy === 'shrinkage') items = [...items].sort((a, b) => b.shrinkageValue - a.shrinkageValue)
    else if (sortBy === 'name') items = [...items].sort((a, b) => (a.name || '').localeCompare(b.name || ''))
    else if (sortBy === 'value') items = [...items].sort((a, b) => b.shrinkageValue - a.shrinkageValue)
    return items
  }, [shrinkageData, search, sortBy])

  // Summary stats
  const totalShrinkageValue = shrinkageData.reduce((s, i) => s + Math.max(0, i.shrinkageValue), 0)
  const totalShrinkageUnits = shrinkageData.reduce((s, i) => s + Math.max(0, i.shrinkage), 0)
  const itemsWithShrinkage = shrinkageData.filter(i => i.shrinkage > 0.5).length
  const topShrinkageItems = [...shrinkageData].sort((a, b) => b.shrinkageValue - a.shrinkageValue).slice(0, 5)

  // POS data import
  async function handlePosImport(e) {
    const file = e.target.files[0]
    if (!file) return
    e.target.value = ''
    try {
      const XLSX = await import('xlsx')
      const ab = await file.arrayBuffer()
      const wb = XLSX.read(new Uint8Array(ab), { type: 'array' })
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { raw: false })

      const posItems = {}
      rows.forEach(row => {
        const sku = row['SKU'] || row['sku'] || row['Item Code'] || row['UPC'] || ''
        const name = row['Item'] || row['Name'] || row['Description'] || ''
        const qty = parseFloat(row['Qty Sold'] || row['Quantity'] || row['Units'] || row['Count'] || 0)
        if (!sku && !name) return

        // Match to catalog
        const match = catalogItems.find(ci =>
          (sku && (ci.sku === sku || ci.id === sku)) ||
          (name && ci.name?.toLowerCase() === name.toLowerCase())
        )
        if (match) {
          posItems[match.id] = (posItems[match.id] || 0) + qty
        }
      })

      // Save to Firestore
      const lk = locId(location)
      const { setDoc } = await import('firebase/firestore')
      await setDoc(doc(db, 'tenants', orgId, 'posData', lk + '_' + periodKey), {
        items: posItems,
        fileName: file.name,
        uploadedBy: user?.name || user?.email,
        uploadedAt: serverTimestamp(),
        location, periodKey,
      })
      setPosData(posItems)
      toast.success('POS data imported: ' + Object.keys(posItems).length + ' SKUs matched')
    } catch (err) {
      toast.error('POS import failed: ' + (err.message || ''))
    }
  }

  if (!location) return (
    <AllLocationsGrid
      title="Shrinkage"
      subtitle="Select a location to view shrinkage analysis"
      onSelectLocation={name => setSelectedLocation(name)}
      statusLabel="No data"
    />
  )

  return (
    <div style={{ padding: '1.5rem', maxWidth: 1400, margin: '0 auto' }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20 }}>
        <div>
          <h1 style={{ fontSize: '1.5rem', fontWeight: 700, color: '#0f172a', margin: 0 }}>Shrinkage Analysis</h1>
          <p style={{ fontSize: 13, color: '#64748b', margin: '4px 0 0' }}>{cleanLocName(location)} · {periodKey}</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <label style={{
            padding: '8px 14px', fontSize: 12, fontWeight: 600,
            background: '#0f172a', color: '#fff', borderRadius: 8,
            cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6,
          }}>
            <Upload size={14} /> Import POS Data
            <input type="file" accept=".xlsx,.xls,.csv" onChange={handlePosImport} style={{ display: 'none' }} />
          </label>
        </div>
      </div>

      {/* KPIs */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 24 }}>
        <div style={{ background: totalShrinkageValue > 500 ? '#fef2f2' : '#f0fdf4', borderRadius: 10, padding: '14px 18px' }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: totalShrinkageValue > 500 ? '#dc2626' : '#059669', textTransform: 'uppercase', marginBottom: 4 }}>Total shrinkage</div>
          <div style={{ fontSize: 24, fontWeight: 700, color: '#0f172a' }}>{fmt$(totalShrinkageValue)}</div>
        </div>
        <div style={{ background: '#f8fafc', borderRadius: 10, padding: '14px 18px' }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: '#64748b', textTransform: 'uppercase', marginBottom: 4 }}>Units lost</div>
          <div style={{ fontSize: 24, fontWeight: 700, color: '#0f172a' }}>{fmtN(totalShrinkageUnits)}</div>
        </div>
        <div style={{ background: '#f8fafc', borderRadius: 10, padding: '14px 18px' }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: '#64748b', textTransform: 'uppercase', marginBottom: 4 }}>Items affected</div>
          <div style={{ fontSize: 24, fontWeight: 700, color: '#0f172a' }}>{itemsWithShrinkage}</div>
        </div>
        <div style={{ background: Object.keys(posData).length > 0 ? '#f0fdf4' : '#fffbeb', borderRadius: 10, padding: '14px 18px' }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: Object.keys(posData).length > 0 ? '#059669' : '#d97706', textTransform: 'uppercase', marginBottom: 4 }}>POS data</div>
          <div style={{ fontSize: 24, fontWeight: 700, color: '#0f172a' }}>{Object.keys(posData).length > 0 ? Object.keys(posData).length + ' SKUs' : 'Not loaded'}</div>
        </div>
      </div>

      {/* Top shrinkage items */}
      {topShrinkageItems.some(i => i.shrinkageValue > 0) && (
        <div style={{ marginBottom: 24, padding: '16px 18px', background: '#fef2f2', borderRadius: 12, border: '1px solid #fecaca' }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: '#dc2626', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
            <AlertTriangle size={14} /> Top shrinkage items
          </div>
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
            {topShrinkageItems.filter(i => i.shrinkageValue > 0).map(item => (
              <div key={item.id} style={{ fontSize: 12, color: '#7f1d1d' }}>
                <span style={{ fontWeight: 600 }}>{item.name}</span>: {fmtN(item.shrinkage)} units ({fmt$(item.shrinkageValue)})
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Search + Sort */}
      <div style={{ display: 'flex', gap: 12, marginBottom: 16, alignItems: 'center' }}>
        <div style={{ position: 'relative', flex: 1 }}>
          <Search size={14} style={{ position: 'absolute', left: 12, top: 10, color: '#94a3b8' }} />
          <input
            value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Search by item or SKU..."
            style={{ width: '100%', padding: '8px 12px 8px 34px', fontSize: 13, border: '1px solid #e2e8f0', borderRadius: 8, outline: 'none' }}
          />
        </div>
        <select value={sortBy} onChange={e => setSortBy(e.target.value)} style={{ padding: '8px 12px', fontSize: 12, border: '1px solid #e2e8f0', borderRadius: 8 }}>
          <option value="shrinkage">Sort by shrinkage $</option>
          <option value="name">Sort by name</option>
        </select>
      </div>

      {/* SKU Table */}
      {loading ? (
        <div style={{ textAlign: 'center', padding: 60, color: '#94a3b8' }}>Loading shrinkage data...</div>
      ) : filtered.length === 0 ? (
        <div style={{ textAlign: 'center', padding: 60, color: '#94a3b8' }}>
          {catalogItems.length === 0 ? 'No catalog items found' : 'No inventory data for this period. Count inventory to see shrinkage analysis.'}
        </div>
      ) : (
        <div style={{ border: '1px solid #e2e8f0', borderRadius: 12, overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ background: '#f8fafc' }}>
                <th style={{ textAlign: 'left', padding: '10px 14px', fontWeight: 600, fontSize: 11, color: '#475569', textTransform: 'uppercase' }}>Item</th>
                <th style={{ textAlign: 'right', padding: '10px 10px', fontWeight: 600, fontSize: 11, color: '#475569', textTransform: 'uppercase' }}>Opening</th>
                <th style={{ textAlign: 'right', padding: '10px 10px', fontWeight: 600, fontSize: 11, color: '#475569', textTransform: 'uppercase' }}>Purchased</th>
                <th style={{ textAlign: 'right', padding: '10px 10px', fontWeight: 600, fontSize: 11, color: '#475569', textTransform: 'uppercase' }}>Sold</th>
                <th style={{ textAlign: 'right', padding: '10px 10px', fontWeight: 600, fontSize: 11, color: '#475569', textTransform: 'uppercase' }}>Expected</th>
                <th style={{ textAlign: 'right', padding: '10px 10px', fontWeight: 600, fontSize: 11, color: '#475569', textTransform: 'uppercase' }}>Closing</th>
                <th style={{ textAlign: 'right', padding: '10px 10px', fontWeight: 600, fontSize: 11, color: '#475569', textTransform: 'uppercase' }}>Shrinkage</th>
                <th style={{ textAlign: 'right', padding: '10px 14px', fontWeight: 600, fontSize: 11, color: '#475569', textTransform: 'uppercase' }}>$ Lost</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(item => {
                const isHigh = item.shrinkage > 0.5
                const isNeg = item.shrinkage < -0.5
                return (
                  <tr key={item.id} style={{ borderTop: '1px solid #f1f5f9', background: isHigh ? '#fef2f2' : 'transparent' }}>
                    <td style={{ padding: '10px 14px' }}>
                      <div style={{ fontWeight: 500, color: '#0f172a' }}>{item.name}</div>
                      <div style={{ fontSize: 11, color: '#94a3b8' }}>{item.vendor || ''}{item.sku ? ' · ' + item.sku : ''}</div>
                    </td>
                    <td style={{ textAlign: 'right', padding: '10px 10px', color: '#64748b' }}>{fmtN(item.open)}</td>
                    <td style={{ textAlign: 'right', padding: '10px 10px', color: '#2563eb' }}>{item.purchased > 0 ? '+' + fmtN(item.purchased) : '—'}</td>
                    <td style={{ textAlign: 'right', padding: '10px 10px', color: item.hasPosData ? '#7c3aed' : '#cbd5e1' }}>{item.hasPosData ? '-' + fmtN(item.sold) : '—'}</td>
                    <td style={{ textAlign: 'right', padding: '10px 10px', color: '#64748b', fontWeight: 500 }}>{fmtN(item.expected)}</td>
                    <td style={{ textAlign: 'right', padding: '10px 10px', color: '#0f172a', fontWeight: 600 }}>{fmtN(item.close)}</td>
                    <td style={{ textAlign: 'right', padding: '10px 10px', fontWeight: 600, color: isHigh ? '#dc2626' : isNeg ? '#2563eb' : '#059669' }}>
                      {isHigh ? fmtN(item.shrinkage) : isNeg ? fmtN(item.shrinkage) : '0'}
                    </td>
                    <td style={{ textAlign: 'right', padding: '10px 14px', fontWeight: 600, color: isHigh ? '#dc2626' : '#059669' }}>
                      {item.shrinkageValue > 0.5 ? fmt$(item.shrinkageValue) : '—'}
                    </td>
                  </tr>
                )
              })}
            </tbody>
            <tfoot>
              <tr style={{ borderTop: '2px solid #e2e8f0', background: '#f8fafc' }}>
                <td style={{ padding: '12px 14px', fontWeight: 700 }}>Total</td>
                <td colSpan={5}></td>
                <td style={{ textAlign: 'right', padding: '12px 10px', fontWeight: 700, color: '#dc2626' }}>{fmtN(totalShrinkageUnits)}</td>
                <td style={{ textAlign: 'right', padding: '12px 14px', fontWeight: 700, color: '#dc2626' }}>{fmt$(totalShrinkageValue)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      {/* Info */}
      <div style={{ marginTop: 16, fontSize: 11, color: '#94a3b8', lineHeight: 1.6 }}>
        Shrinkage = Opening + Purchased - Sold - Closing. Positive values indicate unaccounted loss (theft, waste, spoilage, miscounts).
        Import POS data from your register system to see sold quantities. Without POS data, shrinkage = inventory consumption (opening + purchased - closing).
      </div>
    </div>
  )
}
