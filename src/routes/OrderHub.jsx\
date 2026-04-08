import { useState, useMemo } from 'react'
import { useLocations, cleanLocName } from '@/store/LocationContext'
import { useToast } from '@/components/ui/Toast'
import { Search, Download, Minus, Plus, X, Clock } from 'lucide-react'
import { db } from '@/lib/firebase'
import { collection, addDoc, getDocs, query, orderBy, limit, serverTimestamp } from 'firebase/firestore'
import { writePurchasingPnL, weekPeriod } from '@/lib/pnl'
import { useAuthStore } from '@/store/authStore'
import styles from './OrderHub.module.css'

const VENDORS = [
  { id:'sysco',       label:'Sysco',           url:'https://shop.sysco.com' },
  { id:'nassau',      label:'Nassau',           url:'https://www.nassaucandy.com' },
  { id:'vistar',      label:'Vistar',           url:'https://www.vistar.com' },
  { id:'cafemoto',    label:'Café Moto',        url:'https://www.cafemoto.com' },
  { id:'davidrio',    label:'David Rio',        url:'https://www.davidrio.com' },
  { id:'amazon',      label:'Amazon Business',  url:'https://business.amazon.com' },
  { id:'webstaurant', label:'Webstaurant',      url:'https://www.webstaurantstore.com' },
  { id:'bluecart',    label:'Blue Cart',        url:'https://www.bluecart.com' },
  { id:'rtzn',        label:'RTZN',             url:'https://www.rtznbrands.com' },
]

const ITEMS = [
  // Sysco
  { id:'s1',  vendor:'sysco',    cat:'Beverages', name:'Red Bull 12 oz',              sku:'SYS-1234567', pack:'case/24',   unitCost:1.98,  par:2, onHand:0 },
  { id:'s2',  vendor:'sysco',    cat:'Beverages', name:'Celsius tropical vibe 12 oz', sku:'SYS-5541209', pack:'case/12',   unitCost:1.98,  par:2, onHand:2 },
  { id:'s3',  vendor:'sysco',    cat:'Beverages', name:'Smart Water 20 oz',           sku:'SYS-8892341', pack:'case/24',   unitCost:1.63,  par:3, onHand:1 },
  { id:'s4',  vendor:'sysco',    cat:'Beverages', name:'Gatorade lemon lime 20 oz',   sku:'SYS-4421890', pack:'case/24',   unitCost:1.04,  par:2, onHand:0 },
  { id:'s5',  vendor:'sysco',    cat:'Beverages', name:'Diet Coke',                   sku:'SYS-3312091', pack:'case/24',   unitCost:0.84,  par:1, onHand:1 },
  { id:'s6',  vendor:'sysco',    cat:'Dairy',     name:'Greek yogurt vanilla 5.3oz',  sku:'SYS-7123450', pack:'cs/12',     unitCost:1.14,  par:1, onHand:0 },
  { id:'s7',  vendor:'sysco',    cat:'Dairy',     name:'Whole milk gallon',            sku:'SYS-4412890', pack:'case/2',    unitCost:4.76,  par:2, onHand:1 },
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
const CATS = ['All', 'Beverages', 'Dairy', 'Snacks', 'Barista', 'Supplies']

export default function OrderHub() {
  const { selectedLocation } = useLocations()
  const toast = useToast()
  const [vendor, setVendor]       = useState('sysco')
  const [cat, setCat]             = useState('All')
  const [search, setSearch]       = useState('')
  const [filterBelowPar, setFilterBelowPar] = useState(false)
  const [filterInCart, setFilterInCart]     = useState(false)
  const [qty, setQty]             = useState({})
  const [deliveryDate, setDeliveryDate] = useState('')
  const [note, setNote]           = useState('')
  const [submitted, setSubmitted] = useState(false)
  const [pastOrders, setPastOrders] = useState([])
  const [showPast, setShowPast] = useState(false)
  const { user } = useAuthStore()

  const location = selectedLocation === 'all' ? null : selectedLocation
  const currentVendor = VENDORS.find(v => v.id === vendor)

  function setItemQty(id, val) {
    const n = Math.max(0, parseInt(val) || 0)
    setQty(prev => n === 0 ? (({ [id]: _, ...rest }) => rest)(prev) : { ...prev, [id]: n })
  }

  function adj(id, delta) {
    setItemQty(id, (qty[id] || 0) + delta)
  }

  function addAllBelowPar() {
    const updates = {}
    vendorItems.filter(i => i.onHand < i.par).forEach(i => {
      updates[i.id] = i.par - i.onHand
    })
    setQty(prev => ({ ...prev, ...updates }))
    toast.success(`Added ${Object.keys(updates).length} below-par items to order`)
  }

  async function loadPastOrders() {
    try {
      const snap = await getDocs(query(collection(db,'tenants','fooda','orders'), orderBy('createdAt','desc'), limit(20)))
      setPastOrders(snap.docs.map(d => ({ id:d.id, ...d.data() })))
    } catch(e) {}
  }

  async function submitOrder() {
    const items = cartItems
    if (!items.length) { toast.warning('Order is empty'); return }
    const orderTotal = items.reduce((s, i) => s + i.qty * i.unitCost, 0)
    const now = new Date()
    const orderNum = `ORD-${now.getFullYear()}${String(now.getMonth()+1).padStart(2,'0')}${String(now.getDate()).padStart(2,'0')}-${Math.floor(Math.random()*9000+1000)}`

    const orderDoc = {
      orderNum,
      vendor: currentVendor?.label,
      vendorId: vendor,
      location: location || 'All Locations',
      deliveryDate: deliveryDate || null,
      note,
      items: items.map(i => ({ id:i.id, name:i.name, sku:i.sku, pack:i.pack, unitCost:i.unitCost, qty:i.qty, subtotal:+(i.qty*i.unitCost).toFixed(2) })),
      total: +orderTotal.toFixed(2),
      status: 'Submitted',
      createdBy: user?.email || 'unknown',
      createdAt: serverTimestamp(),
    }

    // Auto-create invoice in Purchasing/AP
    const invoiceDoc = {
      invoiceNum: orderNum,
      vendor: currentVendor?.label,
      invoiceDate: now.toISOString().slice(0,10),
      dueDate: deliveryDate || '',
      amount: +orderTotal.toFixed(2),
      amountPaid: 0,
      location: location || '',
      glCode: '12000',
      notes: `Auto-created from Order Hub — ${items.length} line items`,
      status: 'Pending',
      source: 'order_hub',
      createdBy: user?.email || 'unknown',
      createdAt: serverTimestamp(),
    }

    try {
      await Promise.all([
        addDoc(collection(db,'tenants','fooda','orders'), orderDoc),
        addDoc(collection(db,'tenants','fooda','invoices'), invoiceDoc),
      ])
      // Write to P&L COGS
      if (location) {
        await writePurchasingPnL(location, weekPeriod(), {
          invoiceTotal: +orderTotal.toFixed(2),
          paidTotal: 0,
          pendingTotal: +orderTotal.toFixed(2),
        })
      }
      toast.success(`Order ${orderNum} submitted — invoice created in Purchasing`)
      setSubmitted(true)
      setTimeout(() => { setQty({}); setSubmitted(false); setNote('') }, 3000)
    } catch(e) {
      toast.error('Failed to submit order. Please try again.')
    }
  }

  function exportCSV() {
    const rows = [['SKU','Product','Pack','Unit Cost','Qty','Subtotal'],
      ...cartItems.map(i => [i.sku, i.name, i.pack, i.unitCost, i.qty, (i.qty*i.unitCost).toFixed(2)])]
    const csv = rows.map(r => r.map(v => `"${v}"`).join(',')).join('\n')
    const blob = new Blob([csv], { type:'text/csv' })
    const url = URL.createObjectURL(blob)
    Object.assign(document.createElement('a'), { href:url, download:`order-${vendor}-${new Date().toISOString().slice(0,10)}.csv` }).click()
    URL.revokeObjectURL(url)
  }

  const vendorItems = ITEMS.filter(i => i.vendor === vendor)

  const filtered = useMemo(() => vendorItems.filter(i => {
    if (cat !== 'All' && i.cat !== cat) return false
    if (filterBelowPar && i.onHand >= i.par) return false
    if (filterInCart && !qty[i.id]) return false
    if (search && !i.name.toLowerCase().includes(search.toLowerCase()) && !i.sku.toLowerCase().includes(search.toLowerCase())) return false
    return true
  }), [vendorItems, cat, filterBelowPar, filterInCart, search, qty])

  const grouped = useMemo(() => {
    const g = {}
    filtered.forEach(i => {
      if (!g[i.cat]) g[i.cat] = []
      g[i.cat].push(i)
    })
    return g
  }, [filtered])

  const cartItems = Object.entries(qty).map(([id, q]) => {
    const item = ITEMS.find(i => i.id === id)
    return item ? { ...item, qty: q } : null
  }).filter(Boolean)

  const cartTotal   = cartItems.reduce((s, i) => s + i.qty * i.unitCost, 0)
  const cartLines   = cartItems.length
  const belowParCnt = vendorItems.filter(i => i.onHand < i.par).length

  return (
    <div className={styles.page}>
      {/* Toolbar */}
      <div className={styles.toolbar}>
        <div className={styles.toolGroup}>
          <span className={styles.toolLabel}>Vendor</span>
          <select value={vendor} onChange={e => { setVendor(e.target.value); setQty({}) }} className={styles.sel}>
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
          <a href={currentVendor?.url} target="_blank" rel="noopener noreferrer" className={styles.portalLink}>
            {currentVendor?.label} portal ↗
          </a>
        </div>
      </div>

      {showPast && (
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
                    <td><span className={styles.statusBadge}>{o.status}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      <div className={styles.layout}>
        {/* Sidebar */}
        <div className={styles.sidebar}>
          <div className={styles.sideSection}>
            <div className={styles.sideLabel}>Category</div>
            {CATS.map(c => {
              const count = c === 'All' ? vendorItems.length : vendorItems.filter(i => i.cat === c).length
              return (
                <button key={c}
                  className={`${styles.sideItem} ${cat === c ? styles.sideActive : ''}`}
                  onClick={() => setCat(c)}
                  style={cat === c && CAT_COLORS[c] ? {background: CAT_COLORS[c].light, color: CAT_COLORS[c].color, borderLeft: `3px solid ${CAT_COLORS[c].color}`} : {}}>
                  <span>{c}</span>
                  <span className={styles.sideCount}
                    style={cat === c && CAT_COLORS[c] ? {background: CAT_COLORS[c].bg, color: CAT_COLORS[c].color} : {}}>
                    {count}
                  </span>
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
                    <td colSpan={8} className={styles.catLabel}
                      style={{background: CAT_COLORS[catName]?.bg, color: CAT_COLORS[catName]?.color, borderTopColor: CAT_COLORS[catName]?.color+'40'}}>
                      {catName}
                    </td>
                  </tr>
                  {items.map(item => {
                    const q = qty[item.id] || 0
                    const belowPar = item.onHand < item.par
                    const subtotal = q * item.unitCost
                    return (
                      <tr key={item.id} className={`${styles.row} ${q > 0 ? styles.rowOrdered : ''}`}
                        style={q > 0 ? {} : {borderLeft: `3px solid ${CAT_COLORS[item.cat]?.color || 'transparent'}33`}}>
                        <td className={styles.tdProduct}>
                          <div className={styles.itemName}>{item.name}</div>
                        </td>
                        <td className={styles.tdSku}>{item.sku}</td>
                        <td><span className={styles.packBadge}>{item.pack}</span></td>
                        <td className={`${styles.td} ${styles.r}`}>${item.unitCost.toFixed(2)}</td>
                        <td className={`${styles.td} ${styles.r}`} style={{color: belowPar ? '#854F0B' : undefined}}>{item.par}</td>
                        <td className={`${styles.td} ${styles.r}`} style={{fontWeight: belowPar ? 600 : 400, color: item.onHand === 0 ? '#A32D2D' : belowPar ? '#854F0B' : undefined}}>
                          {item.onHand}
                        </td>
                        <td className={styles.tdQty}>
                          <div className={`${styles.qtyWrap} ${q > 0 ? styles.qtyActive : ''}`}>
                            <button className={styles.qtyBtn} onClick={() => adj(item.id, -1)}>−</button>
                            <input type="number" min="0" value={q || ''} onChange={e => setItemQty(item.id, e.target.value)}
                              className={styles.qtyInput} placeholder="0"/>
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
                <tr><td colSpan={8} className={styles.emptyRow}>No products match your filter</td></tr>
              )}
            </tbody>
          </table>
        </div>

        {/* Order summary */}
        <div className={styles.summary}>
          <div className={styles.sumHeader}>
            Order summary
            {cartLines > 0 && <span className={styles.sumBadge}>{cartLines} lines</span>}
          </div>

          {cartLines === 0 ? (
            <div className={styles.sumEmpty}>
              <div style={{fontSize:13,color:'var(--text-muted)'}}>No items added yet</div>
              <div style={{fontSize:11,color:'var(--text-muted)',marginTop:4}}>Set quantities in the table</div>
            </div>
          ) : (
            <div className={styles.sumItems}>
              {cartItems.map(item => (
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
          )}

          {cartLines > 0 && (
            <div className={styles.sumTotals}>
              <div className={styles.sumRow}><span>Subtotal</span><span>${cartTotal.toFixed(2)}</span></div>
              <div className={styles.sumRow} style={{color:'var(--text-muted)',fontSize:12}}><span>Est. tax</span><span>$0.00</span></div>
              <div className={styles.sumGrand}><span>Order total</span><span>${cartTotal.toFixed(2)}</span></div>
            </div>
          )}

          <div className={styles.sumFooter}>
            <div className={styles.sumField}>
              <label className={styles.sumLabel}>Notes</label>
              <textarea value={note} onChange={e => setNote(e.target.value)}
                placeholder="Delivery instructions, special requests..." className={styles.sumTextarea} rows={3}/>
            </div>
            <div className={styles.sumActions}>
              {cartLines > 0 && <button className={styles.exportBtn} onClick={exportCSV}><Download size={13}/> Export</button>}
              <button className={styles.submitBtn} onClick={submitOrder} disabled={submitted || cartLines === 0}>
                {submitted ? '✓ Submitted' : `Submit to ${currentVendor?.label}`}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
