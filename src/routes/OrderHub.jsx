import { useState, useMemo, useEffect } from 'react'
import { useLocations, cleanLocName } from '@/store/LocationContext'
import { useToast } from '@/components/ui/Toast'
import { Search, Download, X, Clock, LayoutGrid, List, TrendingUp, Package, CheckCircle, AlertTriangle, Truck } from 'lucide-react'
import { db } from '@/lib/firebase'
import { collection, addDoc, getDocs, query, orderBy, limit, serverTimestamp, where } from 'firebase/firestore'
import { writePurchasingPnL, weekPeriod } from '@/lib/pnl'
import { useAuthStore } from '@/store/authStore'
import { submitToVendor } from '@/services/vendors'
import styles from './OrderHub.module.css'

const VENDORS = [
  { id:'sysco',       label:'Sysco',           url:'https://shop.sysco.com' },
  { id:'nassau',      label:'Nassau',          url:'https://www.nassaucandy.com' },
  { id:'vistar',      label:'Vistar',          url:'https://www.vistar.com' },
  { id:'cafemoto',    label:'Café Moto',       url:'https://www.cafemoto.com' },
  { id:'davidrio',    label:'David Rio',       url:'https://www.davidrio.com' },
  { id:'amazon',      label:'Amazon Business', url:'https://business.amazon.com' },
  { id:'webstaurant', label:'Webstaurant',     url:'https://www.webstaurantstore.com' },
  { id:'bluecart',    label:'Blue Cart',       url:'https://www.bluecart.com' },
  { id:'rtzn',        label:'RTZN',            url:'https://www.rtznbrands.com' },
]

const ITEMS = [
  // Sysco
  { id:'s1',  vendor:'sysco',    cat:'Beverages', name:'Red Bull 12 oz',              sku:'SYS-1234567', pack:'case/24',   unitCost:1.98,  par:2, onHand:0 },
  { id:'s2',  vendor:'sysco',    cat:'Beverages', name:'Celsius tropical vibe 12 oz', sku:'SYS-5541209', pack:'case/12',   unitCost:1.98,  par:2, onHand:2 },
  { id:'s3',  vendor:'sysco',    cat:'Beverages', name:'Smart Water 20 oz',           sku:'SYS-8892341', pack:'case/24',   unitCost:1.63,  par:3, onHand:1 },
  { id:'s4',  vendor:'sysco',    cat:'Beverages', name:'Gatorade lemon lime 20 oz',   sku:'SYS-4421890', pack:'case/24',   unitCost:1.04,  par:2, onHand:0 },
  { id:'s5',  vendor:'sysco',    cat:'Beverages', name:'Diet Coke',                   sku:'SYS-3312091', pack:'case/24',   unitCost:0.84,  par:1, onHand:1 },
  { id:'s6',  vendor:'sysco',    cat:'Dairy',     name:'Greek yogurt vanilla 5.3oz',  sku:'SYS-7123450', pack:'cs/12',     unitCost:1.14,  par:1, onHand:0 },
  { id:'s7',  vendor:'sysco',    cat:'Dairy',     name:'Whole milk gallon',           sku:'SYS-4412890', pack:'case/2',    unitCost:4.76,  par:2, onHand:1 },
  { id:'s8',  vendor:'sysco',    cat:'Dairy',     name:'2% milk gallon',              sku:'SYS-4412891', pack:'case/2',    unitCost:8.93,  par:1, onHand:0 },
  { id:'s9',  vendor:'sysco',    cat:'Dairy',     name:'Oat milk Pacific',            sku:'SYS-9921034', pack:'case/12',   unitCost:2.78,  par:1, onHand:1 },
  { id:'s10', vendor:'sysco',    cat:'Snacks',    name:'M&M peanuts',                 sku:'SYS-2219034', pack:'case/48',   unitCost:1.25,  par:1, onHand:0 },
  { id:'s11', vendor:'sysco',    cat:'Snacks',    name:'Snickers',                    sku:'SYS-2219035', pack:'case/48',   unitCost:1.41,  par:1, onHand:0 },
  { id:'s12', vendor:'sysco',    cat:'Snacks',    name:'Haribo goldbears',            sku:'SYS-8812398', pack:'case/12',   unitCost:1.81,  par:1, onHand:1 },
  { id:'s13', vendor:'sysco',    cat:'Snacks',    name:'Uglies sea salt',             sku:'SYS-3312108', pack:'case/24',   unitCost:1.19,  par:1, onHand:0 },
  { id:'s14', vendor:'sysco',    cat:'Snacks',    name:'Clif bar blueberry almond',   sku:'SYS-1109342', pack:'cs/12',     unitCost:2.45,  par:1, onHand:2 },
  { id:'s15', vendor:'sysco',    cat:'Supplies',  name:'Ketchup packets',             sku:'SYS-0023411', pack:'case/1000', unitCost:0.04,  par:2, onHand:0 },
  { id:'s16', vendor:'sysco',    cat:'Supplies',  name:'Mayonnaise packets',          sku:'SYS-0023412', pack:'case/500',  unitCost:0.13,  par:1, onHand:1 },
  { id:'s17', vendor:'sysco',    cat:'Barista',   name:'Ghirardelli chocolate sauce', sku:'SYS-5512093', pack:'cs/6',      unitCost:21.34, par:1, onHand:0 },
  { id:'s18', vendor:'sysco',    cat:'Barista',   name:'Agave organic Monin',         sku:'SYS-6612034', pack:'cs/6',      unitCost:6.87,  par:1, onHand:1 },
  { id:'s19', vendor:'sysco',    cat:'Barista',   name:'Heavy cream',                 sku:'SYS-7712091', pack:'cs/12',     unitCost:4.17,  par:1, onHand:0 },
  // Nassau
  { id:'n1',  vendor:'nassau',   cat:'Beverages', name:'Joe strawberry lemonade',     sku:'NAS-1122334', pack:'case/12',   unitCost:1.88,  par:1, onHand:0 },
  { id:'n2',  vendor:'nassau',   cat:'Snacks',    name:'North fork original',         sku:'NAS-2233445', pack:'case/24',   unitCost:1.23,  par:1, onHand:1 },
  { id:'n3',  vendor:'nassau',   cat:'Snacks',    name:'Sahale fruit and nut',        sku:'NAS-3344556', pack:'case/9',    unitCost:2.43,  par:1, onHand:0 },
  { id:'n4',  vendor:'nassau',   cat:'Snacks',    name:'Barebell cookies caramel',    sku:'NAS-4455667', pack:'cs/12',     unitCost:2.84,  par:1, onHand:0 },
  // Cafe Moto
  { id:'cm1', vendor:'cafemoto', cat:'Barista',   name:'Espresso moto 5lb',           sku:'CM-10001',    pack:'each',      unitCost:74.79, par:1, onHand:0 },
  { id:'cm2', vendor:'cafemoto', cat:'Barista',   name:'Cafe moto brew 5lb',          sku:'CM-10002',    pack:'each',      unitCost:73.05, par:1, onHand:1 },
  { id:'cm3', vendor:'cafemoto', cat:'Barista',   name:'Decaf moto brew 5lb',         sku:'CM-10003',    pack:'each',      unitCost:87.28, par:1, onHand:0 },
  // David Rio
  { id:'dr1', vendor:'davidrio', cat:'Barista',   name:'Tiger spice chai 4lb',        sku:'DR-20001',    pack:'case/4',    unitCost:11.75, par:1, onHand:0 },
  { id:'dr2', vendor:'davidrio', cat:'Barista',   name:'Elephant vanilla chai 4lb',   sku:'DR-20002',    pack:'case/4',    unitCost:11.75, par:1, onHand:0 },
  { id:'dr3', vendor:'davidrio', cat:'Barista',   name:'Masala chai concentrate',     sku:'DR-20003',    pack:'case/4',    unitCost:6.75,  par:1, onHand:1 },
]

const CAT_COLORS = {
  Beverages: { color:'#1e40af', bg:'#dbeafe', light:'#eff6ff' },
  Dairy:     { color:'#0369a1', bg:'#e0f2fe', light:'#f0f9ff' },
  Snacks:    { color:'#92400e', bg:'#fef3c7', light:'#fffbeb' },
  Barista:   { color:'#7c3aed', bg:'#ede9fe', light:'#f5f3ff' },
  Supplies:  { color:'#374151', bg:'#f3f4f6', light:'#f9fafb' },
}

const STATUS_CONFIG = {
  Submitted:  { color:'#1e40af', bg:'#dbeafe', icon: Package },
  Approved:   { color:'#065f46', bg:'#d1fae5', icon: CheckCircle },
  Receiving:  { color:'#0369a1', bg:'#e0f2fe', icon: Truck },
  Received:   { color:'#065f46', bg:'#d1fae5', icon: CheckCircle },
  Rejected:   { color:'#991b1b', bg:'#fee2e2', icon: X },
  Pending:    { color:'#92400e', bg:'#fef3c7', icon: AlertTriangle },
}

const CATS = ['All', 'Beverages', 'Dairy', 'Snacks', 'Barista', 'Supplies']

// Mock weekly budget data (replace with real data from Firestore)
const WEEKLY_BUDGET = { cogs: 3500, spent: 1847.50 }

export default function OrderHub() {
  const { selectedLocation } = useLocations()
  const toast = useToast()
  const { user } = useAuthStore()
  
  // View state
  const [view, setView] = useState('order') // 'order' | 'kanban'
  
  // Filter state
  const [vendorFilter, setVendorFilter] = useState('all') // 'all' = multi-vendor mode
  const [cat, setCat] = useState('All')
  const [search, setSearch] = useState('')
  const [filterBelowPar, setFilterBelowPar] = useState(false)
  const [filterInCart, setFilterInCart] = useState(false)
  
  // Cart state (persists across vendors in multi-vendor mode)
  const [qty, setQty] = useState({})
  const [deliveryDate, setDeliveryDate] = useState('')
  const [note, setNote] = useState('')
  const [submitted, setSubmitted] = useState(false)
  const [showBudgetPreview, setShowBudgetPreview] = useState(false)
  
  // Past orders
  const [pastOrders, setPastOrders] = useState([])
  const [showPast, setShowPast] = useState(false)

  const location = selectedLocation === 'all' ? null : selectedLocation

  // Get items based on vendor filter
  const visibleItems = useMemo(() => {
    if (vendorFilter === 'all') return ITEMS
    return ITEMS.filter(i => i.vendor === vendorFilter)
  }, [vendorFilter])

  // Cart items from ALL vendors (multi-vendor cart)
  const cartItems = useMemo(() => {
    return Object.entries(qty).map(([id, q]) => {
      const item = ITEMS.find(i => i.id === id)
      return item ? { ...item, qty: q } : null
    }).filter(Boolean)
  }, [qty])

  // Group cart by vendor for submission
  const cartByVendor = useMemo(() => {
    const grouped = {}
    cartItems.forEach(item => {
      if (!grouped[item.vendor]) grouped[item.vendor] = []
      grouped[item.vendor].push(item)
    })
    return grouped
  }, [cartItems])

  const cartTotal = cartItems.reduce((s, i) => s + i.qty * i.unitCost, 0)
  const cartLines = cartItems.length
  const vendorCount = Object.keys(cartByVendor).length

  // Filtered products for display
  const filtered = useMemo(() => visibleItems.filter(i => {
    if (cat !== 'All' && i.cat !== cat) return false
    if (filterBelowPar && i.onHand >= i.par) return false
    if (filterInCart && !qty[i.id]) return false
    if (search && !i.name.toLowerCase().includes(search.toLowerCase()) && !i.sku.toLowerCase().includes(search.toLowerCase())) return false
    return true
  }), [visibleItems, cat, filterBelowPar, filterInCart, search, qty])

  const grouped = useMemo(() => {
    const g = {}
    filtered.forEach(i => {
      if (!g[i.cat]) g[i.cat] = []
      g[i.cat].push(i)
    })
    return g
  }, [filtered])

  const belowParCnt = visibleItems.filter(i => i.onHand < i.par).length

  function setItemQty(id, val) {
    const n = Math.max(0, parseInt(val) || 0)
    setQty(prev => n === 0 ? (({ [id]: _, ...rest }) => rest)(prev) : { ...prev, [id]: n })
  }

  function adj(id, delta) {
    setItemQty(id, (qty[id] || 0) + delta)
  }

  function addAllBelowPar() {
    const updates = {}
    visibleItems.filter(i => i.onHand < i.par).forEach(i => {
      updates[i.id] = i.par - i.onHand
    })
    setQty(prev => ({ ...prev, ...updates }))
    toast.success(`Added ${Object.keys(updates).length} below-par items to order`)
  }

  async function loadPastOrders() {
    try {
      const snap = await getDocs(query(collection(db,'tenants','fooda','orders'), orderBy('createdAt','desc'), limit(20)))
      setPastOrders(snap.docs.map(d => ({ id:d.id, ...d.data() })))
    } catch(e) { console.error(e) }
  }

  // Submit orders - creates separate PO for each vendor
  async function submitOrders() {
    if (!cartLines) { toast.warning('Cart is empty'); return }
    
    setSubmitted(true)
    const now = new Date()
    const results = []

    try {
      // Create separate order for each vendor
      for (const [vendorId, items] of Object.entries(cartByVendor)) {
        const vendor = VENDORS.find(v => v.id === vendorId)
        const vendorTotal = items.reduce((s, i) => s + i.qty * i.unitCost, 0)
        const orderNum = `ORD-${now.getFullYear()}${String(now.getMonth()+1).padStart(2,'0')}${String(now.getDate()).padStart(2,'0')}-${vendorId.toUpperCase().slice(0,3)}-${Math.floor(Math.random()*9000+1000)}`

        const orderDoc = {
          orderNum,
          vendor: vendor?.label,
          vendorId,
          location: location || 'All Locations',
          deliveryDate: deliveryDate || null,
          note,
          items: items.map(i => ({ id:i.id, name:i.name, sku:i.sku, pack:i.pack, unitCost:i.unitCost, qty:i.qty, subtotal:+(i.qty*i.unitCost).toFixed(2) })),
          total: +vendorTotal.toFixed(2),
          status: 'Submitted',
          createdBy: user?.email || 'unknown',
          createdAt: serverTimestamp(),
        }

        // Save to Firestore
        await addDoc(collection(db,'tenants','fooda','orders'), orderDoc)

        // Auto-create invoice
        await addDoc(collection(db,'tenants','fooda','invoices'), {
          invoiceNum: orderNum,
          vendor: vendor?.label,
          invoiceDate: now.toISOString().slice(0,10),
          dueDate: deliveryDate || '',
          amount: +vendorTotal.toFixed(2),
          amountPaid: 0,
          location: location || '',
          glCode: '12000',
          notes: `Auto-created from Order Hub — ${items.length} line items`,
          status: 'Pending',
          source: 'order_hub',
          createdBy: user?.email || 'unknown',
          createdAt: serverTimestamp(),
        })

        // Try to submit to vendor API (will fallback gracefully)
        const apiResult = await submitToVendor(vendorId, orderDoc)
        results.push({ vendor: vendor?.label, orderNum, total: vendorTotal, apiResult })
      }

      // Write to P&L
      if (location) {
        await writePurchasingPnL(location, weekPeriod(), {
          invoiceTotal: +cartTotal.toFixed(2),
          paidTotal: 0,
          pendingTotal: +cartTotal.toFixed(2),
        })
      }

      toast.success(`${vendorCount} order${vendorCount > 1 ? 's' : ''} submitted — $${cartTotal.toFixed(2)} total`)
      setTimeout(() => { setQty({}); setSubmitted(false); setNote(''); setDeliveryDate('') }, 2000)
    } catch(e) {
      console.error(e)
      toast.error('Failed to submit orders')
      setSubmitted(false)
    }
  }

  function exportCSV() {
    const rows = [['Vendor','SKU','Product','Pack','Unit Cost','Qty','Subtotal'],
      ...cartItems.map(i => {
        const v = VENDORS.find(v => v.id === i.vendor)
        return [v?.label, i.sku, i.name, i.pack, i.unitCost, i.qty, (i.qty*i.unitCost).toFixed(2)]
      })]
    const csv = rows.map(r => r.map(v => `"${v}"`).join(',')).join('\n')
    const blob = new Blob([csv], { type:'text/csv' })
    const url = URL.createObjectURL(blob)
    Object.assign(document.createElement('a'), { href:url, download:`order-multi-${new Date().toISOString().slice(0,10)}.csv` }).click()
    URL.revokeObjectURL(url)
  }

  // Kanban data
  const ordersByStatus = useMemo(() => {
    const grouped = { Submitted: [], Approved: [], Receiving: [], Received: [] }
    pastOrders.forEach(o => {
      if (grouped[o.status]) grouped[o.status].push(o)
    })
    return grouped
  }, [pastOrders])

  // Load past orders on mount for kanban
  useEffect(() => { loadPastOrders() }, [])

  return (
    <div className={styles.page}>
      {/* View Toggle + Toolbar */}
      <div className={styles.toolbar}>
        <div className={styles.viewToggle}>
          <button className={`${styles.viewBtn} ${view === 'order' ? styles.viewActive : ''}`} onClick={() => setView('order')}>
            <List size={14}/> Order
          </button>
          <button className={`${styles.viewBtn} ${view === 'kanban' ? styles.viewActive : ''}`} onClick={() => setView('kanban')}>
            <LayoutGrid size={14}/> Board
          </button>
        </div>

        {view === 'order' && (
          <>
            <div className={styles.toolGroup}>
              <span className={styles.toolLabel}>Vendor</span>
              <select value={vendorFilter} onChange={e => setVendorFilter(e.target.value)} className={styles.sel}>
                <option value="all">All Vendors (Multi-Cart)</option>
                {VENDORS.map(v => <option key={v.id} value={v.id}>{v.label}</option>)}
              </select>
            </div>
            <div className={styles.toolDivider}/>
            <div className={styles.toolGroup}>
              <span className={styles.toolLabel}>Delivery date</span>
              <input type="date" value={deliveryDate} onChange={e => setDeliveryDate(e.target.value)} className={styles.dateInput}/>
            </div>
            <div className={styles.toolDivider}/>
            <div className={styles.searchWrap}>
              <Search size={13} className={styles.searchIcon}/>
              <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search products or SKU..." className={styles.searchInput}/>
            </div>
            <div className={styles.toolRight}>
              {belowParCnt > 0 && (
                <button className={styles.belowParBtn} onClick={addAllBelowPar}>
                  ⚠ {belowParCnt} below par — add all
                </button>
              )}
              <button className={styles.pastOrdersBtn} onClick={() => { setShowPast(v=>!v); loadPastOrders() }}>
                <Clock size={13}/> Past Orders
              </button>
            </div>
          </>
        )}
      </div>

      {/* Past Orders Panel */}
      {showPast && view === 'order' && (
        <div className={styles.pastPanel}>
          <div className={styles.pastHeader}>
            <span>Past Orders</span>
            <button className={styles.pastClose} onClick={()=>setShowPast(false)}>✕</button>
          </div>
          {pastOrders.length === 0 ? (
            <div className={styles.pastEmpty}>No orders submitted yet</div>
          ) : (
            <table className={styles.pastTable}>
              <thead><tr><th>Order #</th><th>Vendor</th><th>Location</th><th>Date</th><th>Items</th><th>Total</th><th>Status</th></tr></thead>
              <tbody>
                {pastOrders.map(o => (
                  <tr key={o.id}>
                    <td style={{fontWeight:600,fontFamily:'monospace'}}>{o.orderNum}</td>
                    <td>{o.vendor}</td>
                    <td>{cleanLocName(o.location||'')}</td>
                    <td>{o.createdAt?.toDate?.()?.toLocaleDateString?.() || '—'}</td>
                    <td>{o.items?.length || 0} lines</td>
                    <td style={{fontWeight:700,color:'#185FA5'}}>${(o.total||0).toFixed(2)}</td>
                    <td><span className={styles.statusBadge} style={{background: STATUS_CONFIG[o.status]?.bg, color: STATUS_CONFIG[o.status]?.color}}>{o.status}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* KANBAN VIEW */}
      {view === 'kanban' && (
        <div className={styles.kanban}>
          {Object.entries(ordersByStatus).map(([status, orders]) => {
            const config = STATUS_CONFIG[status] || {}
            const Icon = config.icon || Package
            return (
              <div key={status} className={styles.kanbanCol}>
                <div className={styles.kanbanHeader} style={{borderBottomColor: config.color}}>
                  <Icon size={14} style={{color: config.color}}/>
                  <span>{status}</span>
                  <span className={styles.kanbanCount} style={{background: config.bg, color: config.color}}>{orders.length}</span>
                </div>
                <div className={styles.kanbanCards}>
                  {orders.map(order => (
                    <div key={order.id} className={styles.kanbanCard}>
                      <div className={styles.kanbanCardHeader}>
                        <span className={styles.kanbanOrderNum}>{order.orderNum}</span>
                        <span className={styles.kanbanTotal}>${(order.total||0).toFixed(2)}</span>
                      </div>
                      <div className={styles.kanbanCardMeta}>
                        <span>{order.vendor}</span>
                        <span>{order.items?.length || 0} items</span>
                      </div>
                      <div className={styles.kanbanCardDate}>
                        {order.createdAt?.toDate?.()?.toLocaleDateString?.() || '—'}
                      </div>
                    </div>
                  ))}
                  {orders.length === 0 && <div className={styles.kanbanEmpty}>No orders</div>}
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* ORDER VIEW */}
      {view === 'order' && (
        <div className={styles.layout}>
          {/* Sidebar */}
          <div className={styles.sidebar}>
            <div className={styles.sideSection}>
              <div className={styles.sideLabel}>Category</div>
              {CATS.map(c => {
                const count = c === 'All' ? visibleItems.length : visibleItems.filter(i => i.cat === c).length
                return (
                  <button key={c}
                    className={`${styles.sideItem} ${cat === c ? styles.sideActive : ''}`}
                    onClick={() => setCat(c)}
                    style={cat === c && CAT_COLORS[c] ? {background: CAT_COLORS[c].light, color: CAT_COLORS[c].color, borderLeft: `3px solid ${CAT_COLORS[c].color}`} : {}}>
                    <span>{c}</span>
                    <span className={styles.sideCount} style={cat === c && CAT_COLORS[c] ? {background: CAT_COLORS[c].bg, color: CAT_COLORS[c].color} : {}}>{count}</span>
                  </button>
                )
              })}
            </div>
            <div className={styles.sideSection}>
              <div className={styles.sideLabel}>Filter</div>
              <button className={`${styles.sideItem} ${filterBelowPar ? styles.sideActive : ''}`} onClick={() => setFilterBelowPar(v => !v)}>
                <span>Below par</span>
                <span className={`${styles.sideCount} ${filterBelowPar ? styles.sideCountActive : ''}`}>{belowParCnt}</span>
              </button>
              <button className={`${styles.sideItem} ${filterInCart ? styles.sideActive : ''}`} onClick={() => setFilterInCart(v => !v)}>
                <span>In order</span>
                <span className={`${styles.sideCount} ${filterInCart ? styles.sideCountActive : ''}`}>{cartLines}</span>
              </button>
            </div>
          </div>

          {/* Product table */}
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  {vendorFilter === 'all' && <th className={styles.th}>Vendor</th>}
                  <th className={styles.thProduct}>Product</th>
                  <th className={styles.th}>SKU</th>
                  <th className={styles.th}>Pack</th>
                  <th className={`${styles.th} ${styles.r}`}>Unit cost</th>
                  <th className={`${styles.th} ${styles.r}`}>Par</th>
                  <th className={`${styles.th} ${styles.r}`}>On hand</th>
                  <th className={`${styles.th} ${styles.r}`} style={{width:120}}>Order qty</th>
                  <th className={`${styles.th} ${styles.r}`}>Subtotal</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(grouped).map(([catName, items]) => (
                  <>
                    <tr key={catName} className={styles.catRow}>
                      <td colSpan={vendorFilter === 'all' ? 9 : 8} className={styles.catLabel}
                        style={{background: CAT_COLORS[catName]?.bg, color: CAT_COLORS[catName]?.color}}>
                        {catName}
                      </td>
                    </tr>
                    {items.map(item => {
                      const q = qty[item.id] || 0
                      const belowPar = item.onHand < item.par
                      const subtotal = q * item.unitCost
                      const vendor = VENDORS.find(v => v.id === item.vendor)
                      return (
                        <tr key={item.id} className={`${styles.row} ${q > 0 ? styles.rowOrdered : ''}`}>
                          {vendorFilter === 'all' && <td className={styles.tdVendor}>{vendor?.label}</td>}
                          <td className={styles.tdProduct}><div className={styles.itemName}>{item.name}</div></td>
                          <td className={styles.tdSku}>{item.sku}</td>
                          <td><span className={styles.packBadge}>{item.pack}</span></td>
                          <td className={`${styles.td} ${styles.r}`}>${item.unitCost.toFixed(2)}</td>
                          <td className={`${styles.td} ${styles.r}`} style={{color: belowPar ? '#854F0B' : undefined}}>{item.par}</td>
                          <td className={`${styles.td} ${styles.r}`} style={{fontWeight: belowPar ? 600 : 400, color: item.onHand === 0 ? '#A32D2D' : belowPar ? '#854F0B' : undefined}}>{item.onHand}</td>
                          <td className={styles.tdQty}>
                            <div className={`${styles.qtyWrap} ${q > 0 ? styles.qtyActive : ''}`}>
                              <button className={styles.qtyBtn} onClick={() => adj(item.id, -1)}>−</button>
                              <input type="number" min="0" value={q || ''} onChange={e => setItemQty(item.id, e.target.value)} className={styles.qtyInput} placeholder="0"/>
                              <button className={styles.qtyBtn} onClick={() => adj(item.id, 1)}>+</button>
                            </div>
                          </td>
                          <td className={`${styles.td} ${styles.r}`} style={{fontWeight: q > 0 ? 600 : 400, color: q > 0 ? '#185FA5' : '#ccc'}}>
                            {q > 0 ? `$${subtotal.toFixed(2)}` : '—'}
                          </td>
                        </tr>
                      )
                    })}
                  </>
                ))}
                {Object.keys(grouped).length === 0 && (
                  <tr><td colSpan={vendorFilter === 'all' ? 9 : 8} className={styles.emptyRow}>No products match your filter</td></tr>
                )}
              </tbody>
            </table>
          </div>

          {/* Order summary */}
          <div className={styles.summary}>
            <div className={styles.sumHeader}>
              Order summary
              {cartLines > 0 && <span className={styles.sumBadge}>{cartLines} lines</span>}
              {vendorCount > 1 && <span className={styles.sumBadgeVendor}>{vendorCount} vendors</span>}
            </div>

            {cartLines === 0 ? (
              <div className={styles.sumEmpty}>
                <div style={{fontSize:13,color:'var(--text-muted)'}}>No items added yet</div>
                <div style={{fontSize:11,color:'var(--text-muted)',marginTop:4}}>Set quantities in the table</div>
              </div>
            ) : (
              <div className={styles.sumItems}>
                {/* Group by vendor in summary */}
                {Object.entries(cartByVendor).map(([vendorId, items]) => {
                  const vendor = VENDORS.find(v => v.id === vendorId)
                  const vendorTotal = items.reduce((s, i) => s + i.qty * i.unitCost, 0)
                  return (
                    <div key={vendorId} className={styles.sumVendorGroup}>
                      <div className={styles.sumVendorHeader}>
                        <span>{vendor?.label}</span>
                        <span>${vendorTotal.toFixed(2)}</span>
                      </div>
                      {items.map(item => (
                        <div key={item.id} className={styles.sumItem}>
                          <div style={{flex:1}}>
                            <div className={styles.sumItemName}>{item.name}</div>
                            <div className={styles.sumItemSub}>{item.qty} × ${item.unitCost.toFixed(2)}</div>
                          </div>
                          <div className={styles.sumItemPrice}>${(item.qty * item.unitCost).toFixed(2)}</div>
                          <button className={styles.removeBtn} onClick={() => setItemQty(item.id, 0)}><X size={12}/></button>
                        </div>
                      ))}
                    </div>
                  )
                })}
              </div>
            )}

            {cartLines > 0 && (
              <div className={styles.sumTotals}>
                <div className={styles.sumRow}><span>Subtotal</span><span>${cartTotal.toFixed(2)}</span></div>
                <div className={styles.sumGrand}><span>Order total</span><span>${cartTotal.toFixed(2)}</span></div>
              </div>
            )}

            {/* Budget Impact Preview */}
            {cartLines > 0 && (
              <div className={styles.budgetPreview}>
                <button className={styles.budgetToggle} onClick={() => setShowBudgetPreview(v => !v)}>
                  <TrendingUp size={13}/> Budget Impact {showBudgetPreview ? '▲' : '▼'}
                </button>
                {showBudgetPreview && (
                  <div className={styles.budgetDetails}>
                    <div className={styles.budgetRow}>
                      <span>Weekly COGS budget</span>
                      <span>${WEEKLY_BUDGET.cogs.toFixed(2)}</span>
                    </div>
                    <div className={styles.budgetRow}>
                      <span>Already spent</span>
                      <span>${WEEKLY_BUDGET.spent.toFixed(2)}</span>
                    </div>
                    <div className={styles.budgetRow} style={{color:'#1e40af', fontWeight:600}}>
                      <span>This order</span>
                      <span>+${cartTotal.toFixed(2)}</span>
                    </div>
                    <div className={styles.budgetBar}>
                      <div className={styles.budgetBarFill} style={{width: `${Math.min(100, ((WEEKLY_BUDGET.spent + cartTotal) / WEEKLY_BUDGET.cogs) * 100)}%`}}/>
                    </div>
                    <div className={styles.budgetRow} style={{fontWeight:700}}>
                      <span>Remaining</span>
                      <span style={{color: (WEEKLY_BUDGET.cogs - WEEKLY_BUDGET.spent - cartTotal) < 0 ? '#991b1b' : '#065f46'}}>
                        ${(WEEKLY_BUDGET.cogs - WEEKLY_BUDGET.spent - cartTotal).toFixed(2)}
                      </span>
                    </div>
                  </div>
                )}
              </div>
            )}

            <div className={styles.sumFooter}>
              <div className={styles.sumField}>
                <label className={styles.sumLabel}>Notes</label>
                <textarea value={note} onChange={e => setNote(e.target.value)} placeholder="Delivery instructions, special requests..." className={styles.sumTextarea} rows={2}/>
              </div>
              <div className={styles.sumActions}>
                {cartLines > 0 && <button className={styles.exportBtn} onClick={exportCSV}><Download size={13}/> Export</button>}
                <button className={styles.submitBtn} onClick={submitOrders} disabled={submitted || cartLines === 0}>
                  {submitted ? '✓ Submitted' : vendorCount > 1 ? `Submit ${vendorCount} Orders` : 'Submit Order'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}