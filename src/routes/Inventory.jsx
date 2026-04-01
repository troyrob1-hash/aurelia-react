import { useState, useEffect, useMemo } from 'react'
import { useAuthStore } from '@/store/authStore'
import { useLocations, cleanLocName } from '@/store/LocationContext'
import { getInventory, saveInventory } from '@/lib/inventory'
import { Search, Download, RefreshCw } from 'lucide-react'
import styles from './Inventory.module.css'

const INV_CATS = [
  { key: 'beverages',  label: 'Beverages',            color: '#1e40af', bg: '#dbeafe',
    rx: /red bull|celsius|coke(?! power)|diet coke|sprite|boylan|virgil|perrier|topochico|pelegrino|ginger ale|root beer|sparkling water|smart water|boxed water|eclipse water|juice|lemonade|tractor bev|joe.*(tea|sweet|lemon|kiwi|pine|black|ginseng|half)|naked (green|mango|straw|trraw|coconut)|simply orange|tropicana|orange juice|apple juice|kombucha|yerba mate|babe.*(kombucha|yerba)|aura bora|auro bora|frappuccino|illy cold|la colombe|gatorade|coconut water|core power|starbucks.*frapp/i },
  { key: 'bar_items',  label: 'Bar / Barista',        color: '#7c3aed', bg: '#ede9fe',
    rx: /coffee|espresso|decaf|cafe moto|starbucks.*(blend|roast|pike|verona|veranda|holiday)|syrup.*1883|1883.*syrup|ghirardelli|caramel brulee|pumpkin spice.*sauce|white chocolate sauce|bitter.*chocolate sauce|caramel sauce.*oz|strawberry puree|cold brew powder|starbucks.*lemonade.*concentrate|teavana|tevana|chai.*latte|chai.*concentrate|david rio|tiger spice|elephant.*chai|masala chai|matcha|tumeric latte|agave organic|cream charger|freeze dried|dragon fruit|hazelnut.*syrup|peppermint syrup|gingerbread syrup|brown sugar syrup|pecan syrup|sugar cookie syrup|vanilla syrup|caramel.*(1 L|4.cs)|iced.*coffee.*package|mango dragon|strawberry acai.*concentrate/i },
  { key: 'storeroom',  label: 'Pantry / Snacks',      color: '#92400e', bg: '#fef3c7',
    rx: /chip|cheeto|dorito|lays|tostito|popchips|uglies|puffcorn|popcorn|pretzel|sun chip|smartfood|north fork|miss vickie|hippeas|block.*barrel|frito corn|m&m|snicker|twix|kit kat|reese|hershey|skittles|starburst|haribo|awake.*bite|unreal.*choc|blobs|vegobear|gummy bear|chimes ginger|airhead|trident|altoid|pur mint|icebreaker|pure mint|eclipse gum|kind.*(bar|dark choc|peanut butter dark|caramel almond|cherry cashew|cluster)|clif bar|builder.*bar|rx bar|rxbar|kate.*real food|lenka|luna.*bar|88 acres|special k.*bar|protein bar|barebell|sahale|nut harvest|ferris roasted|righteous felon|wenzel|beef jerky|beef stick|meat stick|teriyaki.*balboa|venison.*pork|honey ham stick|pepperoni meat|grandma.*(cookie|brownie)|oatmeal raisin|pop tart|caramel rice crisp|rip van|oreo|solely fruit|fruit jerky|poshi|olive.*chili|olive.*lemon|pickle|hummus|sabra|seaweed|veggie straw|bean vivo|love corn|quinn.*salt|quinn.*pb|cono hazelnut|marish|maestri|mylk labs|awake.*almond/i },
  { key: 'dairy',      label: 'Dairy',                color: '#0369a1', bg: '#e0f2fe',
    rx: /\bmilk\b|yogurt|chobani|mozzarella string|half.*half|heavy cream|salami fontina|genoa.*salami|uncrustables|horizon.*milk|oat milk|soy milk|coconut milk.*pacific|almond milk.*pacific|2 % milk|whole milk gallon|non fat milk|almond milk califia/i },
  { key: 'frozen',     label: 'Frozen / Ice Cream',   color: '#1d4ed8', bg: '#dbeafe',
    rx: /ice cream|blue bunny|haagen|dibs.*crunch|soft frozen lemonade|ice cream bar|ice cream cone|chips galore sandwich|vanilla sandwhich|strawberry shortcake.*bar|chocolate brownie.*bar|loadd sundae/i },
  { key: 'prepared',   label: 'Prepared Foods',       color: '#065f46', bg: '#d1fae5',
    rx: /soup|chicken noodle|wedding meatball|enchilada soup|broccoli cheddar|fresh.*apple.*5lb|apple.*bag.*5lb/i },
  { key: 'condiments', label: 'Condiments & Supplies', color: '#374151', bg: '#f3f4f6',
    rx: /ketchup packet|mustard.*packet|mayo.*packet|pepper packet|salt packet|tapatio|cholula|sriracha|tabasco|soy sauce packet|sugar.*organic|sugar.*turbinado|sugar.*sucralose|sugar.*stevia|saltine.*saladitas|sugar.*sweetener|mayonnaise packet/i },
]

function assignCat(item) {
  for (const cat of INV_CATS) {
    if (cat.rx.test(item.name || '')) return cat.key
  }
  const gl = item.glCode || ''
  if (gl.includes('12002') || gl.includes('411079')) return 'bar_items'
  return 'storeroom'
}

export default function Inventory() {
  const { user }                           = useAuthStore()
  const { selectedLocation }               = useLocations()
  const [items, setItems]                  = useState([])
  const [loading, setLoading]              = useState(false)
  const [saving, setSaving]                = useState(false)
  const [search, setSearch]                = useState('')
  const [activeCat, setActiveCat]          = useState('all')
  const [collapsed, setCollapsed]          = useState({})

  function toggleCollapse(key) {
    setCollapsed(prev => ({ ...prev, [key]: !prev[key] }))
  }
  const [dirty, setDirty]                  = useState(false)

  // On mobile, if admin has 'all' selected, show prompt. Directors auto-filtered.
  const location = (!selectedLocation || selectedLocation === 'all') ? null : selectedLocation

  useEffect(() => {
    if (!location) { setItems([]); return }
    load()
  }, [location])

  async function load() {
    setLoading(true)
    const data = await getInventory(location)
    setItems(data)
    setLoading(false)
    setDirty(false)
  }

  async function handleSave() {
    setSaving(true)
    await saveInventory(location, items, user)
    setSaving(false)
    setDirty(false)
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
      i.id === id ? { ...i, qty: val === '' ? null : parseFloat(val) || 0 } : i
    ))
    setDirty(true)
  }

  function exportCSV() {
    const rows = [
      ['Item','Vendor','Category','Pack','Unit Cost','Count','Total Value'],
      ...items.map(i => [i.name, i.vendor, assignCat(i), i.packSize,
        i.unitCost, i.qty||0, ((i.qty||0)*(i.unitCost||0)).toFixed(2)])
    ]
    const csv  = rows.map(r => r.map(v => `"${v??''}"`).join(',')).join('\n')
    const blob = new Blob([csv], { type: 'text/csv' })
    const url  = URL.createObjectURL(blob)
    Object.assign(document.createElement('a'), {
      href: url, download: `inventory-${location}-${new Date().toISOString().slice(0,10)}.csv`
    }).click()
    URL.revokeObjectURL(url)
  }

  const totalValue = useMemo(() =>
    items.reduce((sum, i) => sum + ((i.qty||0) * (i.unitCost||0)), 0), [items])
  const counted = items.filter(i => i.qty != null && i.qty > 0).length

  // Assign categories to items
  const itemsWithCat = useMemo(() => items.map(i => ({ ...i, _cat: assignCat(i) })), [items])

  // Build sidebar counts per category
  const catCounts = useMemo(() => {
    const counts = {}
    INV_CATS.forEach(c => {
      const catItems = itemsWithCat.filter(i => i._cat === c.key)
      counts[c.key] = { total: catItems.length, counted: catItems.filter(i => i.qty > 0).length }
    })
    return counts
  }, [itemsWithCat])

  // Filter items for display
  const q = search.toLowerCase()
  const displayItems = useMemo(() => {
    return itemsWithCat.filter(i => {
      const matchCat = activeCat === 'all' || i._cat === activeCat
      const matchSearch = !q || i.name?.toLowerCase().includes(q) || i.vendor?.toLowerCase().includes(q)
      return matchCat && matchSearch
    })
  }, [itemsWithCat, activeCat, q])

  // Group display items by category for rendering
  const displayGroups = useMemo(() => {
    const cats = activeCat === 'all' ? INV_CATS : INV_CATS.filter(c => c.key === activeCat)
    return cats.map(cat => ({
      ...cat,
      items: displayItems.filter(i => i._cat === cat.key)
    })).filter(g => g.items.length > 0)
  }, [displayItems, activeCat])

  return (
    <div className={styles.pageWrap}>

      {/* ── Category chip bar ── */}
      <div className={styles.chipBar}>
        <button
          className={`${styles.chip} ${activeCat === 'all' ? styles.chipActive : ''}`}
          onClick={() => setActiveCat('all')}
        >
          All Items
          <span className={styles.chipBadge}>{counted}/{items.length}</span>
        </button>
        {INV_CATS.map(cat => {
          const cc = catCounts[cat.key] || { total: 0, counted: 0 }
          const done = cc.counted === cc.total && cc.total > 0
          return (
            <button
              key={cat.key}
              className={`${styles.chip} ${activeCat === cat.key ? styles.chipActive : ''}`}
              onClick={() => setActiveCat(cat.key)}
              style={activeCat === cat.key ? { borderColor: cat.color, color: cat.color, background: cat.bg } : {}}
            >
              {cat.label}
              <span className={styles.chipBadge} style={{ background: done ? '#10b981' : '#9ca3af' }}>
                {cc.counted}/{cc.total}
              </span>
            </button>
          )
        })}
      </div>

      {/* ── Content ── */}
      <div className={styles.invContent}>
        {!location ? (
          <div className={styles.empty}>
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#d1d5db" strokeWidth="1.5" strokeLinecap="round">
              <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/>
            </svg>
            <p className={styles.emptyTitle}>Select a location</p>
            <p className={styles.emptySub}>Tap the location dropdown at the top to begin counting</p>
          </div>
        ) : (
          <>
            <div className={styles.header}>
              <div>
                <h1 className={styles.title}>{cleanLocName(location)}</h1>
                <p className={styles.subtitle}>Inventory Count &middot; {new Date().toLocaleDateString('en-US',{month:'long',day:'numeric',year:'numeric'})}</p>
              </div>
              <div className={styles.headerActions}>
                {dirty && <button className={styles.btnSave} onClick={handleSave} disabled={saving}>{saving?'Saving...':'Save Changes'}</button>}
                <button className={styles.btnIcon} onClick={exportCSV} title="Export"><Download size={15}/></button>
                <button className={styles.btnIcon} onClick={load} title="Refresh"><RefreshCw size={15}/></button>
              </div>
            </div>

            <div className={styles.kpiBar}>
              <div className={styles.kpi}><div className={styles.kpiLabel}>Total Items</div><div className={styles.kpiValue}>{items.length}</div></div>
              <div className={styles.kpi}><div className={styles.kpiLabel}>Counted</div><div className={styles.kpiValue}>{counted} <span className={styles.kpiOf}>of {items.length}</span></div></div>
              <div className={styles.kpi}><div className={styles.kpiLabel}>Inventory Value</div><div className={styles.kpiValue}>${totalValue.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}</div></div>
              <div className={styles.kpi}>
                <div className={styles.kpiLabel}>Progress</div>
                <div className={styles.kpiValue}>
                  <div className={styles.progressBar}><div className={styles.progressFill} style={{width:items.length?(counted/items.length*100)+'%':'0%'}}/></div>
                  <span className={styles.kpiPct}>{items.length?Math.round(counted/items.length*100):0}%</span>
                </div>
              </div>
            </div>

            <div className={styles.toolbar}>
              <div className={styles.searchWrap}>
                <Search size={14} className={styles.searchIcon}/>
                <input type="text" value={search} onChange={e=>setSearch(e.target.value)}
                  placeholder="Search items or vendor..." className={styles.searchInput}/>
              </div>
            </div>

            {loading ? (
              <div className={styles.loading}>Loading inventory...</div>
            ) : displayGroups.length === 0 ? (
              <div className={styles.loading}>No items found.</div>
            ) : displayGroups.map(cat => (
              <div key={cat.key} className={styles.section}>
                <div className={styles.catHeader} style={{background:cat.bg, borderBottomColor:cat.color+'40', cursor:'pointer'}}
                  onClick={() => toggleCollapse(cat.key)}>
                  <div className={styles.catTitle} style={{color:cat.color}}>
                    {cat.label}
                    <span className={styles.catCount} style={{background:cat.color}}>{cat.items.length}</span>
                    <span className={styles.catCounted} style={{color:cat.color}}>{cat.items.filter(i=>i.qty>0).length} counted</span>
                  </div>
                  <div style={{display:'flex',alignItems:'center',gap:8}}>
                    <div className={styles.catTotal} style={{color:cat.color}}>
                      ${cat.items.reduce((s,i)=>s+((i.qty||0)*(i.unitCost||0)),0).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}
                    </div>
                    <span style={{color:cat.color,fontSize:12}}>{collapsed[cat.key] ? '▶' : '▼'}</span>
                  </div>
                </div>
                {!collapsed[cat.key] && (
                <table className={styles.table}>
                  <thead>
                    <tr className={styles.thead}>
                      <th className={styles.thNum}>#</th>
                      <th className={styles.th}>Item Description</th>
                      <th className={styles.thCenter}>Pack</th>
                      <th className={styles.thRight}>Unit Cost</th>
                      <th className={styles.thCenter} style={{width:160}}>Count</th>
                      <th className={styles.thRight}>Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {cat.items.map((item, idx) => {
                      const isCounted = item.qty != null && item.qty > 0
                      const total = (item.qty||0)*(item.unitCost||0)
                      return (
                        <tr key={item.id} className={`${styles.row} ${idx%2===0?'':styles.rowAlt}`}>
                          <td className={styles.tdNum}>{idx+1}</td>
                          <td className={styles.tdName}>
                            <div className={styles.nameRow}>
                              <span className={styles.dot} style={{background:isCounted?'#10b981':'#d1d5db'}}/>
                              <div>
                                <div className={styles.name}>{item.name}</div>
                                {item.vendor && <div className={styles.vendor}>{item.vendor}</div>}
                              </div>
                            </div>
                          </td>
                          <td className={styles.tdCenter}>{item.packSize&&<span className={styles.badge}>{item.packSize}</span>}</td>
                          <td className={styles.tdRight}>${(item.unitCost||0).toFixed(2)}</td>
                          <td className={styles.tdCount}>
                            <div className={styles.countRow}>
                              <button className={styles.adjBtn} onClick={()=>adjust(item.id,-1)}>−</button>
                              <input type="number" min="0" step="0.5"
                                value={item.qty??''} onChange={e=>setQty(item.id,e.target.value)}
                                className={`${styles.countInput}${isCounted?' '+styles.counted:''}`}
                                placeholder="0"/>
                              <button className={styles.adjBtn} onClick={()=>adjust(item.id,1)}>+</button>
                            </div>
                          </td>
                          <td className={styles.tdRight} style={{fontWeight:700,color:total>0?'#059669':'#bbb'}}>
                            {total>0?'$'+total.toFixed(2):'—'}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
                )}
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  )
}
