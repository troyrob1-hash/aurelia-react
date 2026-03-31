import { useState, useEffect, useMemo } from 'react'
import { useAuthStore } from '@/store/authStore'
import { useLocations } from '@/store/LocationContext'
import { getInventory, saveInventory } from '@/lib/inventory'
import { Search, Download, RefreshCw, ChevronUp, ChevronDown } from 'lucide-react'
import styles from './Inventory.module.css'

const GL_LABELS = {
  '12000': 'Cafeteria',
  '12002': 'Barista',
  '12003': 'Catering',
}

function glLabel(code) {
  if (!code) return 'General'
  const match = Object.keys(GL_LABELS).find(k => code.includes(k))
  return match ? GL_LABELS[match] : 'General'
}

export default function Inventory() {
  const { user }                               = useAuthStore()
  const { selectedLocation }                   = useLocations()
  const [items, setItems]                      = useState([])
  const [loading, setLoading]                  = useState(false)
  const [saving, setSaving]                    = useState(false)
  const [search, setSearch]                    = useState('')
  const [filter, setFilter]                    = useState('all')
  const [sortBy, setSortBy]                    = useState('name')
  const [sortDir, setSortDir]                  = useState('asc')
  const [dirty, setDirty]                      = useState(false)

  const location = selectedLocation === 'all' ? null : selectedLocation

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

  function updateQty(id, val) {
    setItems(prev => prev.map(i => i.id === id ? { ...i, qty: parseFloat(val) || 0 } : i))
    setDirty(true)
  }

  function handleSort(col) {
    if (sortBy === col) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortBy(col); setSortDir('asc') }
  }

  const categories = useMemo(() => {
    const cats = new Set(items.map(i => glLabel(i.glCode)))
    return ['all', ...Array.from(cats).sort()]
  }, [items])

  const filtered = useMemo(() => {
    let list = items
    if (search) {
      const q = search.toLowerCase()
      list = list.filter(i => i.name?.toLowerCase().includes(q) || i.vendor?.toLowerCase().includes(q))
    }
    if (filter !== 'all') list = list.filter(i => glLabel(i.glCode) === filter)
    return [...list].sort((a, b) => {
      let va = a[sortBy] ?? '', vb = b[sortBy] ?? ''
      if (typeof va === 'string') va = va.toLowerCase()
      if (typeof vb === 'string') vb = vb.toLowerCase()
      if (va < vb) return sortDir === 'asc' ? -1 : 1
      if (va > vb) return sortDir === 'asc' ? 1 : -1
      return 0
    })
  }, [items, search, filter, sortBy, sortDir])

  const totalValue = useMemo(() =>
    items.reduce((sum, i) => sum + ((i.qty || 0) * (i.unitCost || 0)), 0), [items])

  function exportCSV() {
    const rows = [
      ['Name','Vendor','Category','Pack Size','Unit Cost','Count','Total Value'],
      ...filtered.map(i => [i.name, i.vendor, glLabel(i.glCode), i.packSize,
        i.unitCost, i.qty || 0, ((i.qty||0)*(i.unitCost||0)).toFixed(2)])
    ]
    const csv  = rows.map(r => r.map(v => `"${v??''}"`).join(',')).join('\n')
    const blob = new Blob([csv], { type: 'text/csv' })
    const url  = URL.createObjectURL(blob)
    const a    = Object.assign(document.createElement('a'), { href: url, download: `inventory-${location}-${new Date().toISOString().slice(0,10)}.csv` })
    a.click(); URL.revokeObjectURL(url)
  }

  if (!location) return (
    <div className={styles.empty}>
      <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#d1d5db" strokeWidth="1.5" strokeLinecap="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/></svg>
      <p className={styles.emptyTitle}>Select a location</p>
      <p className={styles.emptySub}>Choose a location from the dropdown above to view and count inventory</p>
    </div>
  )

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <div>
          <h1 className={styles.title}>Inventory</h1>
          <p className={styles.subtitle}>{location.replace(/^CR_|^SO_/,'')} · {new Date().toLocaleDateString('en-US',{month:'long',day:'numeric',year:'numeric'})}</p>
        </div>
        <div className={styles.headerActions}>
          {dirty && <button className={styles.btnSave} onClick={handleSave} disabled={saving}>{saving?'Saving...':'Save Changes'}</button>}
          <button className={styles.btnIcon} onClick={exportCSV} title="Export CSV"><Download size={15}/></button>
          <button className={styles.btnIcon} onClick={load} title="Refresh"><RefreshCw size={15}/></button>
        </div>
      </div>

      <div className={styles.stats}>
        {[
          { label: 'Total Items',  value: items.length },
          { label: 'Counted',      value: items.filter(i => i.qty != null && i.qty > 0).length },
          { label: 'Total Value',  value: '$' + totalValue.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}) },
          { label: 'Status',       value: dirty ? 'Unsaved' : 'Saved' },
        ].map(s => (
          <div key={s.label} className={styles.stat}>
            <div className={styles.statLabel}>{s.label}</div>
            <div className={styles.statValue}>{s.value}</div>
          </div>
        ))}
      </div>

      <div className={styles.toolbar}>
        <div className={styles.searchWrap}>
          <Search size={14} className={styles.searchIcon}/>
          <input type="text" value={search} onChange={e=>setSearch(e.target.value)}
            placeholder="Search items or vendor..." className={styles.searchInput}/>
        </div>
        <div className={styles.filterTabs}>
          {categories.map(cat => (
            <button key={cat} className={`${styles.filterTab}${filter===cat?' '+styles.active:''}`} onClick={()=>setFilter(cat)}>
              {cat==='all'?'All':cat}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div className={styles.loading}>Loading inventory...</div>
      ) : filtered.length === 0 ? (
        <div className={styles.loading}>{items.length===0?'No inventory data for this location yet.':'No items match your search.'}</div>
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                {[['name','Item'],['vendor','Vendor'],['glCode','Category'],['packSize','Pack'],['unitCost','Unit Cost']].map(([col,label])=>(
                  <th key={col} className={`${styles.th} ${styles.sortable}`} onClick={()=>handleSort(col)}>
                    <span style={{display:'flex',alignItems:'center',gap:4}}>
                      {label}
                      {sortBy===col?(sortDir==='asc'?<ChevronUp size={12}/>:<ChevronDown size={12}/>):<ChevronUp size={12} style={{opacity:.2}}/>}
                    </span>
                  </th>
                ))}
                <th className={styles.th}>Count</th>
                <th className={styles.th}>Value</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(item => (
                <tr key={item.id} className={styles.row}>
                  <td className={styles.tdName}>{item.name}</td>
                  <td className={styles.td}>{item.vendor||'—'}</td>
                  <td className={styles.td}><span className={styles.badge}>{glLabel(item.glCode)}</span></td>
                  <td className={styles.td}>{item.packSize||'—'}</td>
                  <td className={styles.td}>${(item.unitCost||0).toFixed(2)}</td>
                  <td className={styles.tdCount}>
                    <input type="number" min="0" step="0.5"
                      value={item.qty??''} onChange={e=>updateQty(item.id,e.target.value)}
                      className={styles.countInput} placeholder="0"/>
                  </td>
                  <td className={styles.tdValue}>${((item.qty||0)*(item.unitCost||0)).toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
