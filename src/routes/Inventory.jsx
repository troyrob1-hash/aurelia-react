import { useState, useEffect, useMemo, useCallback } from 'react'
import { useAuthStore } from '@/store/authStore'
import { useLocations, cleanLocName } from '@/store/LocationContext'
import { usePeriod } from '@/store/PeriodContext'
import { getInventory, saveInventory, getPriorClosingValue, getPriorItems } from '@/lib/inventory'
import { writeInventoryPnL } from '@/lib/pnl'
import { Search, Download, RefreshCw, Eye, EyeOff, TrendingUp, TrendingDown, Minus } from 'lucide-react'
import { useToast } from '@/components/ui/Toast'
import { doc, getDoc } from 'firebase/firestore'
import { db } from '@/lib/firebase'
import styles from './Inventory.module.css'

const INV_CATS = [
  { key: 'beverages',  label: 'Beverages',             color: '#1e40af', bg: '#dbeafe',
    rx: /red bull|celsius|coke(?! power)|diet coke|sprite|boylan|virgil|perrier|topochico|pelegrino|ginger ale|root beer|sparkling water|smart water|boxed water|eclipse water|juice|lemonade|tractor bev|joe.*(tea|sweet|lemon|kiwi|pine|black|ginseng|half)|naked (green|mango|straw|trraw|coconut)|simply orange|tropicana|orange juice|apple juice|kombucha|yerba mate|babe.*(kombucha|yerba)|aura bora|auro bora|frappuccino|illy cold|la colombe|gatorade|coconut water|core power|starbucks.*frapp/i },
  { key: 'bar_items',  label: 'Bar / Barista',         color: '#7c3aed', bg: '#ede9fe',
    rx: /coffee|espresso|decaf|cafe moto|starbucks.*(blend|roast|pike|verona|veranda|holiday)|syrup.*1883|1883.*syrup|ghirardelli|caramel brulee|pumpkin spice.*sauce|white chocolate sauce|bitter.*chocolate sauce|caramel sauce.*oz|strawberry puree|cold brew powder|starbucks.*lemonade.*concentrate|teavana|tevana|chai.*latte|chai.*concentrate|david rio|tiger spice|elephant.*chai|masala chai|matcha|tumeric latte|agave organic|cream charger|freeze dried|dragon fruit|hazelnut.*syrup|peppermint syrup|gingerbread syrup|brown sugar syrup|pecan syrup|sugar cookie syrup|vanilla syrup|caramel.*(1 L|4.cs)|iced.*coffee.*package|mango dragon|strawberry acai.*concentrate/i },
  { key: 'storeroom',  label: 'Pantry / Snacks',       color: '#92400e', bg: '#fef3c7',
    rx: /chip|cheeto|dorito|lays|tostito|popchips|uglies|puffcorn|popcorn|pretzel|sun chip|smartfood|north fork|miss vickie|hippeas|block.*barrel|frito corn|m&m|snicker|twix|kit kat|reese|hershey|skittles|starburst|haribo|awake.*bite|unreal.*choc|blobs|vegobear|gummy bear|chimes ginger|airhead|trident|altoid|pur mint|icebreaker|pure mint|eclipse gum|kind.*(bar|dark choc|peanut butter dark|caramel almond|cherry cashew|cluster)|clif bar|builder.*bar|rx bar|rxbar|kate.*real food|lenka|luna.*bar|88 acres|special k.*bar|protein bar|barebell|sahale|nut harvest|ferris roasted|righteous felon|wenzel|beef jerky|beef stick|meat stick|teriyaki.*balboa|venison.*pork|honey ham stick|pepperoni meat|grandma.*(cookie|brownie)|oatmeal raisin|pop tart|caramel rice crisp|rip van|oreo|solely fruit|fruit jerky|poshi|olive.*chili|olive.*lemon|pickle|hummus|sabra|seaweed|veggie straw|bean vivo|love corn|quinn.*salt|quinn.*pb|cono hazelnut|marish|maestri|mylk labs|awake.*almond/i },
  { key: 'dairy',      label: 'Dairy',                 color: '#0369a1', bg: '#e0f2fe',
    rx: /\bmilk\b|yogurt|chobani|mozzarella string|half.*half|heavy cream|salami fontina|genoa.*salami|uncrustables|horizon.*milk|oat milk|soy milk|coconut milk.*pacific|almond milk.*pacific|2 % milk|whole milk gallon|non fat milk|almond milk califia/i },
  { key: 'frozen',     label: 'Frozen / Ice Cream',    color: '#1d4ed8', bg: '#dbeafe',
    rx: /ice cream|blue bunny|haagen|dibs.*crunch|soft frozen lemonade|ice cream bar|ice cream cone|chips galore sandwich|vanilla sandwhich|strawberry shortcake.*bar|chocolate brownie.*bar|loadd sundae/i },
  { key: 'prepared',   label: 'Prepared Foods',        color: '#065f46', bg: '#d1fae5',
    rx: /soup|chicken noodle|wedding meatball|enchilada soup|broccoli cheddar|fresh.*apple.*5lb|apple.*bag.*5lb/i },
  { key: 'condiments', label: 'Condiments & Supplies', color: '#374151', bg: '#f3f4f6',
    rx: /ketchup packet|mustard.*packet|mayo.*packet|pepper packet|salt packet|tapatio|cholula|sriracha|tabasco|soy sauce packet|sugar.*organic|sugar.*turbinado|sugar.*sucralose|sugar.*stevia|saltine.*saladitas|sugar.*sweetener|mayonnaise packet/i },
]

function assignCat(item) {
  for (const cat of INV_CATS) {
    if (cat.rx.test(item.name || '')) return cat.key
  }
  return 'storeroom'
}

// Compute prior period key from current
function getPriorKey(key) {
  const parts = key.match(/(\d+)-P(\d+)-W(\d+)/)
  if (!parts) return null
  let [, yr, p, w] = parts.map(Number)
  if (w > 1) return `${yr}-P${String(p).padStart(2,'0')}-W${w-1}`
  if (p > 1) return `${yr}-P${String(p-1).padStart(2,'0')}-W4`
  return `${yr-1}-P12-W4`
}

// Variance classification for heatmap
function varianceClass(curr, prior) {
  if (!prior || prior === 0) return 'neutral'
  const pct = Math.abs((curr - prior) / prior)
  if (pct <= 0.10) return 'good'
  if (pct <= 0.25) return 'warn'
  return 'alert'
}

const fmt$ = v => '$' + Number(v || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

export default function Inventory() {
  const toast = useToast()
  const { user }             = useAuthStore()
  const orgId                = user?.tenantId || 'fooda'
  const { selectedLocation } = useLocations()
  const { periodKey }        = usePeriod()

  const [items,        setItems]        = useState([])
  const [priorItems,   setPriorItems]   = useState([])
  const [openingValue, setOpeningValue] = useState(0)
  const [purchases,    setPurchases]    = useState(0)
  const [loading,      setLoading]      = useState(false)
  const [saving,       setSaving]       = useState(false)
  const [dirty,        setDirty]        = useState(false)
  const [search,       setSearch]       = useState('')
  const [activeCat,    setActiveCat]    = useState('all')
  const [collapsed,    setCollapsed]    = useState({})
  const [blindMode,    setBlindMode]    = useState(false)
  const [showVariance, setShowVariance] = useState(true)
  const [countSession, setCountSession] = useState(null)

  const location = selectedLocation === 'all' ? null : selectedLocation
  const priorKey = getPriorKey(periodKey)

  useEffect(() => {
    if (!location) { setItems([]); setPriorItems([]); setOpeningValue(0); return }
    load()
  }, [location, periodKey])

  async function load() {
    setLoading(true)
    try {
      // Load current period inventory
      const data = await getInventory(orgId, location, periodKey)
      setItems(data)

      // Load prior period items for variance
      const prior = await getPriorItems(orgId, location, priorKey)
      setPriorItems(prior)

      // Load opening value (prior week's closing)
      const opening = await getPriorClosingValue(orgId, location, priorKey)
      setOpeningValue(opening)

      // Load period purchases from P&L
      try {
        const pnlSnap = await getDoc(doc(db, 'tenants', orgId, 'pnl', location.replace(/[^a-zA-Z0-9]/g, '_'), 'periods', periodKey))
        if (pnlSnap.exists()) setPurchases(pnlSnap.data().cogs_purchases || 0)
      } catch { /* no purchases yet */ }

      // Start count session if not already started
      if (!countSession) {
        setCountSession({ startedAt: new Date(), startedBy: user?.name || user?.email, sectionsCompleted: [] })
      }
    } catch { toast.error('Failed to load inventory.') }
    setLoading(false)
    setDirty(false)
  }

  async function handleSave() {
    setSaving(true)
    try {
      await saveInventory(orgId, location, items, user, periodKey)
      const closingValue = items.reduce((s, i) => s + ((i.qty || 0) * (i.unitCost || 0)), 0)
      await writeInventoryPnL(location, periodKey, { closingValue, openingValue, purchases })
      toast.success('Inventory saved & COGS posted to P&L')
      setDirty(false)
    } catch { toast.error('Save failed. Please try again.') }
    setSaving(false)
  }

  function adjust(id, delta) {
    setItems(prev => prev.map(i => {
      if (i.id !== id) return i
      const next = Math.max(0, parseFloat(((i.qty || 0) + delta).toFixed(2)))
      return { ...i, qty: next }
    }))
    setDirty(true)
  }

  function setQty(id, val) {
    setItems(prev => prev.map(i =>
      i.id === id ? { ...i, qty: val === '' ? null : Math.max(0, parseFloat(val) || 0) } : i
    ))
    setDirty(true)
  }

  function toggleCollapse(key) {
    setCollapsed(prev => ({ ...prev, [key]: !prev[key] }))
    // Track section completion in session
    const cat = INV_CATS.find(c => c.key === key)
    if (cat && countSession) {
      setCountSession(prev => ({
        ...prev,
        sectionsCompleted: prev.sectionsCompleted.includes(key)
          ? prev.sectionsCompleted
          : [...prev.sectionsCompleted, key]
      }))
    }
  }

  async function exportExcel() {
    try {
      const XLSX = await import('xlsx')
      const wb   = XLSX.utils.book_new()
      const closingValue = items.reduce((s, i) => s + ((i.qty || 0) * (i.unitCost || 0)), 0)
      const cogs = Math.max(0, openingValue + purchases - closingValue)

      const summaryRows = [
        ['Aurelia FMS — Inventory Count Report'],
        ['Location:', cleanLocName(location)],
        ['Period:', periodKey],
        ['Date:', new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })],
        [],
        ['COGS CALCULATION'],
        ['Opening Inventory', openingValue.toFixed(2)],
        ['+ Purchases', purchases.toFixed(2)],
        ['- Closing Inventory', closingValue.toFixed(2)],
        ['= COGS (Inventory Usage)', cogs.toFixed(2)],
        [],
        ['SUMMARY'],
        ['Total Items', items.length],
        ['Items Counted', counted],
        ['Inventory Value', closingValue.toFixed(2)],
        ['Progress', items.length ? Math.round(counted / items.length * 100) + '%' : '0%'],
      ]
      const wsSummary = XLSX.utils.aoa_to_sheet(summaryRows)
      XLSX.utils.book_append_sheet(wb, wsSummary, 'Summary')

      const header = ['#', 'Item', 'Vendor', 'Category', 'Pack Size', 'Unit Cost', 'Count', 'Prior Count', 'Variance', 'Total Value', 'GL Code']
      const detailRows = items.map((item, idx) => {
        const prior = priorItems.find(p => p.id === item.id)?.qty || 0
        const variance = (item.qty || 0) - prior
        return [
          idx + 1, item.name, item.vendor || '',
          INV_CATS.find(c => c.key === assignCat(item))?.label || 'General',
          item.packSize || '', item.unitCost || 0, item.qty || 0,
          prior, variance, +((item.qty || 0) * (item.unitCost || 0)).toFixed(2), item.glCode || ''
        ]
      })
      const wsDetail = XLSX.utils.aoa_to_sheet([header, ...detailRows])
      wsDetail['!cols'] = [{ wch: 4 }, { wch: 40 }, { wch: 15 }, { wch: 20 }, { wch: 10 }, { wch: 10 }, { wch: 8 }, { wch: 10 }, { wch: 10 }, { wch: 12 }, { wch: 12 }]
      XLSX.utils.book_append_sheet(wb, wsDetail, 'All Items')

      INV_CATS.forEach(cat => {
        const catItems = items.filter(i => assignCat(i) === cat.key)
        if (!catItems.length) return
        const catRows = catItems.map((item, idx) => {
          const prior = priorItems.find(p => p.id === item.id)?.qty || 0
          return [idx + 1, item.name, item.vendor || '', item.packSize || '', item.unitCost || 0, item.qty || 0, prior, (item.qty || 0) - prior, +((item.qty || 0) * (item.unitCost || 0)).toFixed(2)]
        })
        catRows.push(['', '', '', '', '', 'TOTAL', '', '', +catItems.reduce((s, i) => s + ((i.qty || 0) * (i.unitCost || 0)), 0).toFixed(2)])
        const ws = XLSX.utils.aoa_to_sheet([['#', 'Item', 'Vendor', 'Pack', 'Unit Cost', 'Count', 'Prior', 'Variance', 'Value'], ...catRows])
        XLSX.utils.book_append_sheet(wb, ws, cat.label.slice(0, 31))
      })

      XLSX.writeFile(wb, `inventory-${cleanLocName(location)}-${periodKey}.xlsx`)
      toast.success('Exported to Excel')
    } catch { toast.error('Export failed.') }
  }

  // ── Derived values ────────────────────────────────────────────
  const totalValue   = useMemo(() => items.reduce((s, i) => s + ((i.qty || 0) * (i.unitCost || 0)), 0), [items])
  const counted      = items.filter(i => i.qty != null && i.qty > 0).length
  const liveCOGS     = Math.max(0, openingValue + purchases - totalValue)

  const itemsWithCat = useMemo(() => items.map(i => {
    const cat   = assignCat(i)
    const prior = priorItems.find(p => p.id === i.id)
    const priorQty = prior?.qty || 0
    const variance = (i.qty || 0) - priorQty
    const varClass = i.qty != null ? varianceClass(i.qty, priorQty) : 'neutral'
    return { ...i, _cat: cat, _priorQty: priorQty, _variance: variance, _varClass: varClass }
  }), [items, priorItems])

  const catCounts = useMemo(() => {
    const counts = {}
    INV_CATS.forEach(c => {
      const catItems = itemsWithCat.filter(i => i._cat === c.key)
      counts[c.key] = {
        total:   catItems.length,
        counted: catItems.filter(i => i.qty != null && i.qty > 0).length,
        value:   catItems.reduce((s, i) => s + ((i.qty || 0) * (i.unitCost || 0)), 0),
      }
    })
    return counts
  }, [itemsWithCat])

  const q = search.toLowerCase()
  const displayItems = useMemo(() => itemsWithCat.filter(i => {
    const matchCat    = activeCat === 'all' || i._cat === activeCat
    const matchSearch = !q || i.name?.toLowerCase().includes(q) || i.vendor?.toLowerCase().includes(q)
    return matchCat && matchSearch
  }), [itemsWithCat, activeCat, q])

  const displayGroups = useMemo(() => {
    const cats = activeCat === 'all' ? INV_CATS : INV_CATS.filter(c => c.key === activeCat)
    return cats.map(cat => ({
      ...cat,
      items: displayItems.filter(i => i._cat === cat.key),
    })).filter(g => g.items.length > 0)
  }, [displayItems, activeCat])

  if (!location) return (
    <div className={styles.empty}>
      <div className={styles.emptyIcon}>📦</div>
      <p className={styles.emptyTitle}>Select a location to begin counting</p>
      <p className={styles.emptySub}>Choose a location from the dropdown above</p>
    </div>
  )

  return (
    <div className={styles.pageWrap}>

      {/* ── Category chip bar ── */}
      <div className={styles.chipBar}>
        <button className={`${styles.chip} ${activeCat === 'all' ? styles.chipActive : ''}`} onClick={() => setActiveCat('all')}>
          All Items
          <span className={styles.chipBadge}>{counted}/{items.length}</span>
        </button>
        {INV_CATS.map(cat => {
          const cc   = catCounts[cat.key] || { total: 0, counted: 0 }
          const done = cc.counted === cc.total && cc.total > 0
          const pct  = cc.total > 0 ? cc.counted / cc.total : 0
          return (
            <button key={cat.key}
              className={`${styles.chip} ${activeCat === cat.key ? styles.chipActive : ''}`}
              onClick={() => setActiveCat(cat.key)}
              style={activeCat === cat.key ? { borderColor: cat.color, color: cat.color, background: cat.bg } : { borderColor: cat.color + '40', color: cat.color }}
            >
              {/* Completion ring */}
              <svg width="16" height="16" viewBox="0 0 16 16" style={{ flexShrink: 0 }}>
                <circle cx="8" cy="8" r="6" fill="none" stroke={cat.color + '30'} strokeWidth="2" />
                <circle cx="8" cy="8" r="6" fill="none" stroke={done ? '#10b981' : cat.color} strokeWidth="2"
                  strokeDasharray={`${pct * 37.7} 37.7`} strokeLinecap="round"
                  transform="rotate(-90 8 8)" style={{ transition: 'stroke-dasharray .4s' }} />
              </svg>
              {cat.label}
              <span className={styles.chipBadge} style={{ background: done ? '#10b981' : cat.color + '99' }}>
                {cc.counted}/{cc.total}
              </span>
            </button>
          )
        })}
      </div>

      {/* ── Main content ── */}
      <div className={styles.invContent}>

        {/* ── Header ── */}
        <div className={styles.header}>
          <div>
            <h1 className={styles.title}>{cleanLocName(location)}</h1>
            <p className={styles.subtitle}>
              Inventory Count · {periodKey}
              {countSession && <span className={styles.sessionBadge}>Session active · {countSession.sectionsCompleted.length}/{INV_CATS.length} sections</span>}
            </p>
          </div>
          <div className={styles.headerActions}>
            <button className={`${styles.btnMode} ${blindMode ? styles.btnModeActive : ''}`} onClick={() => setBlindMode(v => !v)} title="Blind count mode">
              {blindMode ? <EyeOff size={14} /> : <Eye size={14} />}
              {blindMode ? 'Blind' : 'Show prior'}
            </button>
            {dirty && (
              <button className={styles.btnSave} onClick={handleSave} disabled={saving}>
                {saving ? 'Saving...' : 'Save & Post to P&L'}
              </button>
            )}
            <button className={styles.btnIcon} onClick={exportExcel} title="Export Excel"><Download size={15} /></button>
            <button className={styles.btnIcon} onClick={load} title="Refresh"><RefreshCw size={15} /></button>
          </div>
        </div>

        {/* ── KPI bar with live COGS ── */}
        <div className={styles.kpiBar}>
          <div className={`${styles.kpi} ${styles.kpiDark}`}>
            <div className={styles.kpiLabel}>Live COGS Estimate</div>
            <div className={styles.kpiValue} style={{ color: '#6ee7b7' }}>{fmt$(liveCOGS)}</div>
            <div className={styles.cogsFormula}>
              {fmt$(openingValue)} + {fmt$(purchases)} − {fmt$(totalValue)}
            </div>
          </div>
          <div className={styles.kpi}>
            <div className={styles.kpiLabel}>Closing Value</div>
            <div className={styles.kpiValue}>{fmt$(totalValue)}</div>
            <div className={styles.kpiSub}>Current count</div>
          </div>
          <div className={styles.kpi}>
            <div className={styles.kpiLabel}>Opening Value</div>
            <div className={styles.kpiValue} style={{ color: '#888' }}>{fmt$(openingValue)}</div>
            <div className={styles.kpiSub}>Prior week closing</div>
          </div>
          <div className={styles.kpi}>
            <div className={styles.kpiLabel}>Counted</div>
            <div className={styles.kpiValue}>{counted} <span className={styles.kpiOf}>of {items.length}</span></div>
            <div className={styles.progressWrap}>
              <div className={styles.progressBar}>
                <div className={styles.progressFill} style={{ width: items.length ? (counted / items.length * 100) + '%' : '0%' }} />
              </div>
              <span className={styles.kpiPct}>{items.length ? Math.round(counted / items.length * 100) : 0}%</span>
            </div>
          </div>
          <div className={styles.kpi}>
            <div className={styles.kpiLabel}>Purchases</div>
            <div className={styles.kpiValue} style={{ color: '#888' }}>{fmt$(purchases)}</div>
            <div className={styles.kpiSub}>From AP this period</div>
          </div>
        </div>

        {/* ── Toolbar ── */}
        <div className={styles.toolbar}>
          <div className={styles.searchWrap}>
            <Search size={14} className={styles.searchIcon} />
            <input type="text" value={search} onChange={e => setSearch(e.target.value)}
              placeholder="Search items or vendor..." className={styles.searchInput} />
          </div>
          <button className={`${styles.btnVariance} ${showVariance ? styles.btnVarianceActive : ''}`}
            onClick={() => setShowVariance(v => !v)}>
            {showVariance ? <TrendingDown size={13} /> : <TrendingUp size={13} />}
            Variance
          </button>
        </div>

        {loading ? (
          <div className={styles.loading}>Loading inventory...</div>
        ) : displayGroups.map(cat => (
          <div key={cat.key} className={styles.section}>
            <div className={styles.catHeader} style={{ background: cat.bg, borderBottomColor: cat.color + '40', cursor: 'pointer' }}
              onClick={() => toggleCollapse(cat.key)}>
              <div className={styles.catTitle} style={{ color: cat.color }}>
                {cat.label}
                <span className={styles.catCount} style={{ background: cat.color }}>{cat.items.length}</span>
                <span className={styles.catCounted}>{cat.items.filter(i => i.qty != null && i.qty > 0).length} counted</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <div className={styles.catTotal} style={{ color: cat.color }}>
                  {fmt$(cat.items.reduce((s, i) => s + ((i.qty || 0) * (i.unitCost || 0)), 0))}
                </div>
                <span style={{ color: cat.color, fontSize: 11 }}>{collapsed[cat.key] ? '▶' : '▼'}</span>
              </div>
            </div>

            {!collapsed[cat.key] && (
              <table className={styles.table}>
                <thead>
                  <tr className={styles.thead}>
                    <th className={styles.thNum}>#</th>
                    <th className={styles.th}>Item</th>
                    <th className={styles.thCenter}>Pack</th>
                    <th className={styles.thRight}>Unit Cost</th>
                    {!blindMode && showVariance && <th className={styles.thCenter}>Prior</th>}
                    <th className={styles.thCenter} style={{ width: 160 }}>Count</th>
                    {showVariance && !blindMode && <th className={styles.thCenter}>△ Variance</th>}
                    <th className={styles.thRight}>Value</th>
                  </tr>
                </thead>
                <tbody>
                  {cat.items.map((item, idx) => {
                    const isCounted = item.qty != null && item.qty > 0
                    const total     = (item.qty || 0) * (item.unitCost || 0)
                    const varDir    = item._variance > 0 ? 'up' : item._variance < 0 ? 'down' : 'neutral'

                    return (
                      <tr key={item.id} className={`${styles.row} ${idx % 2 === 0 ? '' : styles.rowAlt}`}>
                        <td className={styles.tdNum}>{idx + 1}</td>
                        <td className={styles.tdName}>
                          <div className={styles.nameRow}>
                            {/* Variance heatmap dot */}
                            <div className={`${styles.heatDot} ${isCounted ? styles['heat_' + item._varClass] : styles.heat_empty}`} title={
                              isCounted ? `${item._varClass === 'good' ? 'Within 10% of last week' : item._varClass === 'warn' ? '10-25% variance' : '>25% variance'}` : 'Not counted'
                            } />
                            <div>
                              <div className={styles.name}>{item.name}</div>
                              {item.vendor && <div className={styles.vendor}>{item.vendor}</div>}
                            </div>
                          </div>
                        </td>
                        <td className={styles.tdCenter}>
                          {item.packSize && <span className={styles.badge}>{item.packSize}</span>}
                        </td>
                        <td className={styles.tdRight}>${(item.unitCost || 0).toFixed(2)}</td>
                        {!blindMode && showVariance && (
                          <td className={styles.tdCenter} style={{ color: '#bbb', fontSize: 12 }}>
                            {item._priorQty > 0 ? item._priorQty : '—'}
                          </td>
                        )}
                        <td className={styles.tdCount}>
                          <div className={styles.countRow}>
                            <button className={styles.adjBtn} onClick={() => adjust(item.id, -1)}>−</button>
                            <input type="number" min="0" step="0.5"
                              value={item.qty ?? ''}
                              onChange={e => setQty(item.id, e.target.value)}
                              className={`${styles.countInput} ${isCounted ? styles.counted : ''}`}
                              placeholder={blindMode ? '0' : item._priorQty > 0 ? String(item._priorQty) : '0'}
                            />
                            <button className={styles.adjBtn} onClick={() => adjust(item.id, 1)}>+</button>
                          </div>
                        </td>
                        {showVariance && !blindMode && (
                          <td className={styles.tdCenter}>
                            {isCounted && item._priorQty > 0 ? (
                              <span className={`${styles.varBadge} ${styles['var_' + varDir]}`}>
                                {varDir === 'up' ? <TrendingUp size={10} /> : varDir === 'down' ? <TrendingDown size={10} /> : <Minus size={10} />}
                                {item._variance > 0 ? '+' : ''}{item._variance.toFixed(1)}
                              </span>
                            ) : <span style={{ color: '#ddd' }}>—</span>}
                          </td>
                        )}
                        <td className={styles.tdRight} style={{ fontWeight: 700, color: total > 0 ? '#059669' : '#bbb' }}>
                          {total > 0 ? fmt$(total) : '—'}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            )}
          </div>
        ))}

        {/* ── Sticky COGS footer ── */}
        {dirty && (
          <div className={styles.cogsFooter}>
            <div className={styles.cogsFooterLeft}>
              <span className={styles.cogsLabel}>Live COGS</span>
              <span className={styles.cogsValue}>{fmt$(liveCOGS)}</span>
              <span className={styles.cogsBreakdown}>{fmt$(openingValue)} opening + {fmt$(purchases)} purchases − {fmt$(totalValue)} closing</span>
            </div>
            <button className={styles.btnSaveFooter} onClick={handleSave} disabled={saving}>
              {saving ? 'Saving...' : 'Save & Post to P&L'}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}