import { useState, useEffect, useMemo } from 'react'
import { useLocations, cleanLocName } from '@/store/LocationContext'
import { useToast } from '@/components/ui/Toast'
import { db } from '@/lib/firebase'
import { collection, getDocs, query, orderBy, limit } from 'firebase/firestore'
import { TrendingUp, TrendingDown, DollarSign, ShoppingBag, Trash2, Package } from 'lucide-react'
import styles from './Dashboard.module.css'

function locationId(name) { return name.replace(/[^a-zA-Z0-9]/g, '_') }

function weekKey(offset = 0) {
  const d = new Date()
  d.setDate(d.getDate() + offset * 7)
  const year = d.getFullYear()
  const start = new Date(year, 0, 1)
  const week = Math.ceil(((d - start) / 86400000 + start.getDay() + 1) / 7)
  return `${year}-W${String(week).padStart(2, '0')}`
}

const DAYS = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday']
const CATS = { retail: '#059669', catering: '#7c3aed', popup: '#2563eb' }

export default function Dashboard() {
  const toast                              = useToast()
  const { selectedLocation, groupedLocations, visibleLocations } = useLocations()
  const [salesData, setSalesData]          = useState({})
  const [wasteData, setWasteData]          = useState([])
  const [inventoryData, setInventoryData]  = useState({})
  const [loading, setLoading]              = useState(true)
  const [period, setPeriod]                = useState('week') // week | month

  const location = selectedLocation === 'all' ? null : selectedLocation
  const locations = location ? [location] : Object.values(visibleLocations).map(l => l.name).filter(Boolean)

  useEffect(() => { loadAll() }, [selectedLocation])

  async function loadAll() {
    setLoading(true)
    try {
      await Promise.all([loadSales(), loadWaste(), loadInventory()])
    } catch(e) {
      toast.error('Failed to load dashboard data.')
    }
    setLoading(false)
  }

  async function loadSales() {
    const week = weekKey()
    const prevWeek = weekKey(-1)
    const result = {}
    const locs = location ? [location] : Object.values(visibleLocations).map(l => l.name).filter(Boolean).slice(0, 20)
    await Promise.all(locs.map(async loc => {
      try {
        const ref  = collection(db, 'tenants', 'fooda', 'locations', locationId(loc), 'sales')
        const snap = await getDocs(query(ref, orderBy('__name__', 'desc'), limit(4)))
        result[loc] = snap.docs.map(d => ({ week: d.id, ...d.data() }))
      } catch(e) {}
    }))
    setSalesData(result)
  }

  async function loadWaste() {
    const locs = location ? [location] : Object.values(visibleLocations).map(l => l.name).filter(Boolean).slice(0, 20)
    const all = []
    await Promise.all(locs.map(async loc => {
      try {
        const ref  = collection(db, 'tenants', 'fooda', 'locations', locationId(loc), 'waste')
        const snap = await getDocs(query(ref, orderBy('date', 'desc'), limit(50)))
        snap.docs.forEach(d => all.push({ loc, ...d.data() }))
      } catch(e) {}
    }))
    setWasteData(all)
  }

  async function loadInventory() {
    const week = weekKey()
    const locs = location ? [location] : Object.values(visibleLocations).map(l => l.name).filter(Boolean).slice(0, 20)
    const result = {}
    await Promise.all(locs.map(async loc => {
      try {
        const ref  = collection(db, 'tenants', 'fooda', 'locations', locationId(loc), 'inventory')
        const snap = await getDocs(query(ref, orderBy('__name__', 'desc'), limit(1)))
        if (!snap.empty) result[loc] = snap.docs[0].data()
      } catch(e) {}
    }))
    setInventoryData(result)
  }

  // Aggregate sales for current week
  const currentWeek = weekKey()
  const salesThisWeek = useMemo(() => {
    let retail = 0, catering = 0, popup = 0
    Object.values(salesData).forEach(weeks => {
      const thisWeekData = weeks.find(w => w.week === currentWeek)
      if (!thisWeekData?.days) return
      DAYS.forEach(day => {
        retail   += parseFloat(thisWeekData.days[day]?.retail   || 0)
        catering += parseFloat(thisWeekData.days[day]?.catering || 0)
        popup    += parseFloat(thisWeekData.days[day]?.popup    || 0)
      })
    })
    return { retail, catering, popup, total: retail + catering + popup }
  }, [salesData, currentWeek])

  const salesLastWeek = useMemo(() => {
    const lw = weekKey(-1)
    let total = 0
    Object.values(salesData).forEach(weeks => {
      const lwData = weeks.find(w => w.week === lw)
      if (!lwData?.days) return
      DAYS.forEach(day => {
        total += parseFloat(lwData.days[day]?.retail   || 0)
        total += parseFloat(lwData.days[day]?.catering || 0)
        total += parseFloat(lwData.days[day]?.popup    || 0)
      })
    })
    return total
  }, [salesData])

  const salesVar = salesLastWeek > 0 ? ((salesThisWeek.total - salesLastWeek) / salesLastWeek * 100) : null

  // Waste this week
  const now = new Date()
  const weekAgo = new Date(now - 7 * 24 * 60 * 60 * 1000)
  const wasteThisWeek = wasteData.filter(e => new Date(e.date) >= weekAgo)
  const wasteCost = wasteThisWeek.reduce((s, e) => s + (e.total || 0), 0)
  const wasteOz   = wasteThisWeek.reduce((s, e) => s + (e.oz   || 0), 0)

  // Inventory value
  const invValue = Object.values(inventoryData).reduce((s, inv) => {
    return s + (inv.items || []).reduce((ss, i) => ss + ((i.qty || 0) * (i.unitCost || 0)), 0)
  }, 0)
  const invCounted = Object.values(inventoryData).reduce((s, inv) => {
    return s + (inv.items || []).filter(i => i.qty > 0).length
  }, 0)
  const invTotal = Object.values(inventoryData).reduce((s, inv) => {
    return s + (inv.items || []).length
  }, 0)

  // Daily sales chart data (last 7 days)
  const last7 = useMemo(() => {
    const days = []
    for (let i = 6; i >= 0; i--) {
      const d = new Date(); d.setDate(d.getDate() - i)
      const dayName = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][d.getDay()]
      const label = ['Su','Mo','Tu','We','Th','Fr','Sa'][d.getDay()]
      let total = 0
      Object.values(salesData).forEach(weeks => {
        weeks.forEach(w => {
          if (w.days?.[dayName]) {
            total += parseFloat(w.days[dayName].retail   || 0)
            total += parseFloat(w.days[dayName].catering || 0)
            total += parseFloat(w.days[dayName].popup    || 0)
          }
        })
      })
      days.push({ label, total, date: d.toISOString().slice(0,10) })
    }
    return days
  }, [salesData])

  const maxDay = Math.max(...last7.map(d => d.total), 1)

  const fmt$ = (v) => '$' + (v || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <div>
          <h1 className={styles.title}>P&L Dashboard</h1>
          <p className={styles.subtitle}>
            {location ? cleanLocName(location) : `${Object.keys(visibleLocations).length} locations`} · Week {currentWeek}
          </p>
        </div>
      </div>

      {loading ? (
        <div className={styles.loading}>Loading dashboard...</div>
      ) : (
        <>
          {/* KPI Row */}
          <div className={styles.kpiGrid}>
            <div className={styles.kpiCard}>
              <div className={styles.kpiHeader}>
                <span className={styles.kpiLabel}>Weekly Sales</span>
                <TrendingUp size={16} color="#059669"/>
              </div>
              <div className={styles.kpiValue}>{fmt$(salesThisWeek.total)}</div>
              {salesVar !== null && (
                <div className={`${styles.kpiVar} ${salesVar >= 0 ? styles.pos : styles.neg}`}>
                  {salesVar >= 0 ? '▲' : '▼'} {Math.abs(salesVar).toFixed(1)}% vs last week
                </div>
              )}
              <div className={styles.kpiSubs}>
                <span style={{color:'#059669'}}>Retail {fmt$(salesThisWeek.retail)}</span>
                <span style={{color:'#7c3aed'}}>Catering {fmt$(salesThisWeek.catering)}</span>
                <span style={{color:'#2563eb'}}>Pop-up {fmt$(salesThisWeek.popup)}</span>
              </div>
            </div>

            <div className={styles.kpiCard}>
              <div className={styles.kpiHeader}>
                <span className={styles.kpiLabel}>Waste Cost</span>
                <Trash2 size={16} color="#dc2626"/>
              </div>
              <div className={styles.kpiValue} style={{color:'#dc2626'}}>{fmt$(wasteCost)}</div>
              <div className={styles.kpiSub}>{wasteThisWeek.length} entries this week</div>
              {wasteOz > 0 && <div className={styles.kpiSub}>{wasteOz.toFixed(1)} oz total</div>}
            </div>

            <div className={styles.kpiCard}>
              <div className={styles.kpiHeader}>
                <span className={styles.kpiLabel}>Inventory Value</span>
                <Package size={16} color="#2563eb"/>
              </div>
              <div className={styles.kpiValue}>{fmt$(invValue)}</div>
              <div className={styles.kpiSub}>{invCounted}/{invTotal} items counted</div>
            </div>

            <div className={styles.kpiCard}>
              <div className={styles.kpiHeader}>
                <span className={styles.kpiLabel}>Active Locations</span>
                <ShoppingBag size={16} color="#d97706"/>
              </div>
              <div className={styles.kpiValue}>{Object.keys(visibleLocations).length}</div>
              <div className={styles.kpiSub}>{Object.keys(salesData).filter(l => salesData[l]?.length > 0).length} with sales data</div>
            </div>
          </div>

          {/* Sales chart + P&L breakdown */}
          <div className={styles.mainGrid}>
            {/* Daily bar chart */}
            <div className={styles.card}>
              <div className={styles.cardTitle}>Daily Sales <span>last 7 days</span></div>
              <div className={styles.barChart}>
                {last7.map((d, i) => (
                  <div key={i} className={styles.barCol}>
                    <div className={styles.barWrap}>
                      <div className={styles.bar} style={{height: `${(d.total/maxDay)*100}%`, background: d.total > 0 ? '#059669' : '#e5e7eb'}}/>
                    </div>
                    <div className={styles.barLabel}>{d.label}</div>
                    {d.total > 0 && <div className={styles.barVal}>${(d.total/1000).toFixed(1)}k</div>}
                  </div>
                ))}
              </div>
            </div>

            {/* P&L Summary */}
            <div className={styles.card}>
              <div className={styles.cardTitle}>P&L Summary <span>this week</span></div>
              <table className={styles.plTable}>
                <tbody>
                  <tr className={styles.plSection}><td colSpan={2}>Gross Food Sales</td></tr>
                  <tr><td className={styles.plLabel}>Retail</td><td className={styles.plVal}>{fmt$(salesThisWeek.retail)}</td></tr>
                  <tr><td className={styles.plLabel}>Catering</td><td className={styles.plVal}>{fmt$(salesThisWeek.catering)}</td></tr>
                  <tr><td className={styles.plLabel}>Pop-up</td><td className={styles.plVal}>{fmt$(salesThisWeek.popup)}</td></tr>
                  <tr className={styles.plTotal}><td>Total GFS</td><td>{fmt$(salesThisWeek.total)}</td></tr>

                  <tr className={styles.plSection}><td colSpan={2}>COGS</td></tr>
                  <tr><td className={styles.plLabel}>Retail COGS (48%)</td><td className={styles.plVal}>{fmt$(salesThisWeek.retail * 0.48)}</td></tr>
                  <tr><td className={styles.plLabel}>Catering COGS (25%)</td><td className={styles.plVal}>{fmt$(salesThisWeek.catering * 0.25)}</td></tr>
                  <tr><td className={styles.plLabel}>Waste</td><td className={styles.plVal} style={{color:'#dc2626'}}>{fmt$(wasteCost)}</td></tr>
                  <tr className={styles.plTotal}><td>Total COGS</td><td>{fmt$(salesThisWeek.retail * 0.48 + salesThisWeek.catering * 0.25 + wasteCost)}</td></tr>

                  <tr className={styles.plSection}><td colSpan={2}>Gross Margin</td></tr>
                  {(() => {
                    const gm = salesThisWeek.total - (salesThisWeek.retail * 0.48 + salesThisWeek.catering * 0.25 + wasteCost)
                    const gmPct = salesThisWeek.total > 0 ? (gm / salesThisWeek.total * 100).toFixed(1) : 0
                    return (
                      <tr className={styles.plTotal} style={{color: gm >= 0 ? '#059669' : '#dc2626'}}>
                        <td>Gross Margin ({gmPct}%)</td>
                        <td>{fmt$(gm)}</td>
                      </tr>
                    )
                  })()}
                </tbody>
              </table>
            </div>
          </div>

          {/* Location breakdown */}
          {!location && (
            <div className={styles.card}>
              <div className={styles.cardTitle}>Sales by Location <span>this week</span></div>
              <table className={styles.locTable}>
                <thead>
                  <tr>
                    <th>Location</th>
                    <th>Retail</th>
                    <th>Catering</th>
                    <th>Pop-up</th>
                    <th>Total</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(salesData)
                    .map(([loc, weeks]) => {
                      const tw = weeks.find(w => w.week === currentWeek)
                      if (!tw?.days) return null
                      let retail = 0, catering = 0, popup = 0
                      DAYS.forEach(day => {
                        retail   += parseFloat(tw.days[day]?.retail   || 0)
                        catering += parseFloat(tw.days[day]?.catering || 0)
                        popup    += parseFloat(tw.days[day]?.popup    || 0)
                      })
                      const total = retail + catering + popup
                      if (total === 0) return null
                      return { loc, retail, catering, popup, total }
                    })
                    .filter(Boolean)
                    .sort((a, b) => b.total - a.total)
                    .map(({ loc, retail, catering, popup, total }) => (
                      <tr key={loc}>
                        <td>{cleanLocName(loc)}</td>
                        <td>{fmt$(retail)}</td>
                        <td>{fmt$(catering)}</td>
                        <td>{fmt$(popup)}</td>
                        <td className={styles.locTotal}>{fmt$(total)}</td>
                      </tr>
                    ))
                  }
                  {Object.keys(salesData).length === 0 && (
                    <tr><td colSpan={5} style={{textAlign:'center',color:'#999',padding:24}}>No sales data yet — log weekly sales to see P&L</td></tr>
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
