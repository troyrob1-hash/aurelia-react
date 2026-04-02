import { useState, useMemo } from 'react'
import { useLocations, cleanLocName } from '@/store/LocationContext'
import { useToast } from '@/components/ui/Toast'
import { ShoppingCart, Search, ExternalLink, Trash2, Plus, Minus, Clock, CreditCard, BookOpen, AlertTriangle } from 'lucide-react'
import styles from './OrderHub.module.css'

const VENDORS = [
  { id:'sysco',       label:'Sysco',          url:'https://shop.sysco.com',           emoji:'🚚' },
  { id:'nassau',      label:'Nassau',          url:'https://www.nassaucandy.com',      emoji:'🚚' },
  { id:'vistar',      label:'Vistar',          url:'https://www.vistar.com',           emoji:'🚚' },
  { id:'cafemoto',    label:'Café Moto',       url:'https://www.cafemoto.com',         emoji:'☕' },
  { id:'davidrio',    label:'David Rio',       url:'https://www.davidrio.com',         emoji:'🍵' },
  { id:'amazon',      label:'Amazon Business', url:'https://business.amazon.com',      emoji:'📦' },
  { id:'webstaurant', label:'Webstaurant',     url:'https://www.webstaurantstore.com', emoji:'🌐' },
  { id:'bluecart',    label:'Blue Cart',       url:'https://www.bluecart.com',         emoji:'🛒' },
  { id:'rtzn',        label:'RTZN',            url:'https://www.rtznbrands.com',       emoji:'🚚' },
]

const ALL_ITEMS = [
  // Sysco
  { id:'s1',  vendor:'sysco',    name:'Red Bull 12 oz',               pack:'case/24',  unitCost:1.98,  cat:'Beverages',   par:2 },
  { id:'s2',  vendor:'sysco',    name:'Celsius tropical vibe 12 oz',  pack:'case/12',  unitCost:1.98,  cat:'Beverages',   par:2 },
  { id:'s3',  vendor:'sysco',    name:'Smart Water 20 oz',            pack:'case/24',  unitCost:1.63,  cat:'Beverages',   par:3 },
  { id:'s4',  vendor:'sysco',    name:'Boxed water 16.9 oz',          pack:'case/24',  unitCost:1.21,  cat:'Beverages',   par:2 },
  { id:'s5',  vendor:'sysco',    name:'Gatorade lemon lime 20 oz',    pack:'case/24',  unitCost:1.04,  cat:'Beverages',   par:1 },
  { id:'s6',  vendor:'sysco',    name:'Greek yogurt vanilla 5.3oz',   pack:'cs/12',    unitCost:1.14,  cat:'Dairy',       par:1 },
  { id:'s7',  vendor:'sysco',    name:'Uncrustables PB strawberry',   pack:'case/72',  unitCost:0.92,  cat:'Dairy',       par:1 },
  { id:'s8',  vendor:'sysco',    name:'M&M peanuts',                  pack:'case/48',  unitCost:1.25,  cat:'Snacks',      par:1 },
  { id:'s9',  vendor:'sysco',    name:'Snickers',                     pack:'case/48',  unitCost:1.41,  cat:'Snacks',      par:1 },
  { id:'s10', vendor:'sysco',    name:'Haribo goldbears',             pack:'case/12',  unitCost:1.81,  cat:'Snacks',      par:1 },
  { id:'s11', vendor:'sysco',    name:'Hippeas chickpea puffs',       pack:'case/12',  unitCost:1.67,  cat:'Snacks',      par:1 },
  { id:'s12', vendor:'sysco',    name:'Uglies sea salt',              pack:'case/24',  unitCost:1.19,  cat:'Snacks',      par:1 },
  { id:'s13', vendor:'sysco',    name:'Ketchup packets',              pack:'case/1000',unitCost:0.04,  cat:'Supplies',    par:2 },
  { id:'s14', vendor:'sysco',    name:'Whole milk gallon',            pack:'case/2',   unitCost:4.76,  cat:'Dairy',       par:2 },
  { id:'s15', vendor:'sysco',    name:'2% milk gallon',               pack:'case/2',   unitCost:8.93,  cat:'Dairy',       par:1 },
  { id:'s16', vendor:'sysco',    name:'Oat milk Pacific',             pack:'case/12',  unitCost:2.78,  cat:'Dairy',       par:1 },
  { id:'s17', vendor:'sysco',    name:'Clif bar blueberry almond',    pack:'cs/12',    unitCost:2.45,  cat:'Snacks',      par:1 },
  { id:'s18', vendor:'sysco',    name:'Ghirardelli chocolate sauce',  pack:'cs/6',     unitCost:21.34, cat:'Barista',     par:1 },
  { id:'s19', vendor:'sysco',    name:'Agave organic Monin',          pack:'cs/6',     unitCost:6.87,  cat:'Barista',     par:1 },
  { id:'s20', vendor:'sysco',    name:'Heavy cream',                  pack:'cs/12',    unitCost:4.17,  cat:'Barista',     par:1 },
  // Nassau
  { id:'n1',  vendor:'nassau',   name:'Joe strawberry lemonade',      pack:'case/12',  unitCost:1.88,  cat:'Beverages',   par:1 },
  { id:'n2',  vendor:'nassau',   name:'North fork original',          pack:'case/24',  unitCost:1.23,  cat:'Snacks',      par:1 },
  { id:'n3',  vendor:'nassau',   name:'Sahale fruit and nut',         pack:'case/9',   unitCost:2.43,  cat:'Snacks',      par:1 },
  { id:'n4',  vendor:'nassau',   name:'Clif bar chocolate brownie',   pack:'cs/12',    unitCost:2.67,  cat:'Snacks',      par:1 },
  { id:'n5',  vendor:'nassau',   name:'Barebell cookies and caramel', pack:'cs/12',    unitCost:2.84,  cat:'Snacks',      par:1 },
  { id:'n6',  vendor:'nassau',   name:'Airheads Gum Blue Raspberry',  pack:'cs/12',    unitCost:1.47,  cat:'Snacks',      par:1 },
  // Cafe Moto
  { id:'cm1', vendor:'cafemoto', name:'Cafe moto espresso moto 5lb',  pack:'each',     unitCost:74.79, cat:'Barista',     par:1 },
  { id:'cm2', vendor:'cafemoto', name:'Cafe moto brew 5lb',           pack:'each',     unitCost:73.05, cat:'Barista',     par:1 },
  { id:'cm3', vendor:'cafemoto', name:'Decaf moto brew 5lb',          pack:'each',     unitCost:87.28, cat:'Barista',     par:1 },
  // David Rio
  { id:'dr1', vendor:'davidrio', name:'Tiger spice chai 4lb',         pack:'case/4',   unitCost:11.75, cat:'Barista',     par:1 },
  { id:'dr2', vendor:'davidrio', name:'Elephant vanilla chai 4lb',    pack:'case/4',   unitCost:11.75, cat:'Barista',     par:1 },
  { id:'dr3', vendor:'davidrio', name:'Masala chai concentrate',       pack:'case/4',   unitCost:6.75,  cat:'Barista',     par:1 },
  { id:'dr4', vendor:'davidrio', name:'David Rio tumeric latte',       pack:'each',     unitCost:32.00, cat:'Barista',     par:1 },
]

const CATS = ['All','Beverages','Snacks','Dairy','Barista','Supplies']

export default function OrderHub() {
  const { selectedLocation } = useLocations()
  const toast = useToast()
  const [vendor, setVendor]       = useState('sysco')
  const [subTab, setSubTab]       = useState('suggest')
  const [cart, setCart]           = useState({})
  const [deliveryDate, setDeliveryDate] = useState('')
  const [orderNote, setOrderNote] = useState('')
  const [searchQ, setSearchQ]     = useState('')
  const [catFilter, setCatFilter] = useState('All')
  const [submitted, setSubmitted] = useState(false)

  const location = selectedLocation === 'all' ? null : selectedLocation
  const currentVendor = VENDORS.find(v => v.id === vendor)

  const vendorItems = ALL_ITEMS.filter(i => i.vendor === vendor)

  // Suggested = items at/below par (simulate with random for demo)
  const suggested = vendorItems.filter((_, i) => i % 3 === 0)

  // Catalog search
  const catalogResults = useMemo(() => {
    if (!searchQ && catFilter === 'All') return vendorItems
    return ALL_ITEMS.filter(i => {
      const matchCat = catFilter === 'All' || i.cat === catFilter
      const matchQ   = !searchQ || i.name.toLowerCase().includes(searchQ.toLowerCase())
      return matchCat && matchQ
    })
  }, [searchQ, catFilter, vendorItems])

  function addToCart(item, qty = 1) {
    setCart(prev => ({ ...prev, [item.id]: { ...item, qty: (prev[item.id]?.qty || 0) + qty } }))
  }

  function setQty(id, qty) {
    if (qty <= 0) { setCart(prev => { const n = { ...prev }; delete n[id]; return n }); return }
    setCart(prev => ({ ...prev, [id]: { ...prev[id], qty } }))
  }

  function addAll(items) {
    const updates = {}
    items.forEach(item => { updates[item.id] = { ...item, qty: (cart[item.id]?.qty || 0) + item.par } })
    setCart(prev => ({ ...prev, ...updates }))
    toast.success(`Added ${items.length} items to cart`)
  }

  function submitOrder() {
    const items = Object.values(cart)
    if (!items.length) { toast.warning('Cart is empty'); return }
    const total = items.reduce((s, i) => s + i.qty * i.unitCost, 0)
    toast.success(`Order submitted to ${currentVendor?.label} — ${items.length} items · $${total.toFixed(2)}`)
    setSubmitted(true)
    setTimeout(() => { setCart({}); setSubmitted(false) }, 3000)
  }

  const cartItems = Object.values(cart)
  const cartTotal = cartItems.reduce((s, i) => s + i.qty * (i.unitCost || 0), 0)
  const cartCount = cartItems.reduce((s, i) => s + i.qty, 0)

  const ItemRow = ({ item }) => {
    const inCart = cart[item.id]
    return (
      <div className={`${styles.itemRow} ${inCart ? styles.itemInCart : ''}`}>
        <div className={styles.itemInfo}>
          <div className={styles.itemName}>{item.name}</div>
          <div className={styles.itemMeta}>{item.cat} · {item.pack} · <strong>${item.unitCost.toFixed(2)}</strong>/unit</div>
        </div>
        <div className={styles.itemActions}>
          {inCart ? (
            <div className={styles.qtyCtrl}>
              <button onClick={() => setQty(item.id, inCart.qty - 1)}><Minus size={11}/></button>
              <span>{inCart.qty}</span>
              <button onClick={() => setQty(item.id, inCart.qty + 1)}><Plus size={11}/></button>
            </div>
          ) : (
            <button className={styles.addBtn} onClick={() => addToCart(item, item.par)}>
              <Plus size={12}/> Add
            </button>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className={styles.page}>
      {/* Header */}
      <div className={styles.header}>
        <div>
          <h1 className={styles.title}>Order Hub</h1>
          <p className={styles.subtitle}>{location ? cleanLocName(location) : 'All Locations'} · Place orders with distributors</p>
        </div>
      </div>

      {/* Vendor links */}
      <div className={styles.vendorBanner}>
        <span className={styles.bannerLabel}>🔌 Order Online:</span>
        {VENDORS.map(v => (
          <a key={v.id} href={v.url} target="_blank" rel="noopener noreferrer"
            className={`${styles.vendorChip} ${vendor===v.id?styles.vendorChipActive:''}`}
            onClick={e => { e.preventDefault(); setVendor(v.id) }}>
            {v.emoji} {v.label}
          </a>
        ))}
        <a href={currentVendor?.url} target="_blank" rel="noopener noreferrer" className={styles.orderDirectLink}>
          Order on {currentVendor?.label} ↗ <ExternalLink size={11}/>
        </a>
      </div>

      <div className={styles.layout}>
        {/* Left panel */}
        <div className={styles.left}>
          {/* Sub-tabs */}
          <div className={styles.subTabs}>
            <button className={`${styles.subTab} ${subTab==='suggest'?styles.subTabActive:''}`} onClick={()=>setSubTab('suggest')}>
              <AlertTriangle size={13}/> Suggested Order
            </button>
            <button className={`${styles.subTab} ${subTab==='guide'?styles.subTabActive:''}`} onClick={()=>setSubTab('guide')}>
              <BookOpen size={13}/> Order Guide
            </button>
            <button className={`${styles.subTab} ${subTab==='catalog'?styles.subTabActive:''}`} onClick={()=>setSubTab('catalog')}>
              <Search size={13}/> Catalog Search
            </button>
            <button className={`${styles.subTab} ${subTab==='history'?styles.subTabActive:''}`} onClick={()=>setSubTab('history')}>
              <Clock size={13}/> Past Orders
            </button>
            <button className={`${styles.subTab} ${subTab==='terms'?styles.subTabActive:''}`} onClick={()=>setSubTab('terms')}>
              <CreditCard size={13}/> Payment Terms
            </button>
          </div>

          {/* Panel content */}
          <div className={styles.panel}>
            {/* Suggested */}
            {subTab === 'suggest' && (
              <>
                <div className={styles.panelHeader}>
                  <AlertTriangle size={15} color="#d97706"/>
                  <span>Suggested Order — Items Below Par</span>
                  <button className={styles.addAllBtn} onClick={()=>addAll(suggested)}>Add All to Cart</button>
                </div>
                <div className={styles.panelBody}>
                  {suggested.length === 0
                    ? <div className={styles.empty}>✅ All items are at par level</div>
                    : suggested.map(item => <ItemRow key={item.id} item={item}/>)
                  }
                </div>
              </>
            )}

            {/* Order Guide */}
            {subTab === 'guide' && (
              <>
                <div className={styles.panelHeader}>
                  <BookOpen size={15}/>
                  <span>Order Guide — {currentVendor?.label} Items</span>
                  <button className={styles.addAllBtn} onClick={()=>addAll(vendorItems)}>Add All to Cart</button>
                </div>
                <div className={styles.panelBody}>
                  {vendorItems.map(item => <ItemRow key={item.id} item={item}/>)}
                  {vendorItems.length === 0 && <div className={styles.empty}>No items for {currentVendor?.label} yet.</div>}
                </div>
              </>
            )}

            {/* Catalog Search */}
            {subTab === 'catalog' && (
              <>
                <div className={styles.panelHeader}>
                  <Search size={15}/>
                  <span>Catalog Search</span>
                </div>
                <div className={styles.catalogSearch}>
                  <div className={styles.searchWrap}>
                    <Search size={14} className={styles.searchIcon}/>
                    <input value={searchQ} onChange={e=>setSearchQ(e.target.value)}
                      placeholder="Search products..." className={styles.searchInput}/>
                  </div>
                  <div className={styles.catChips}>
                    {CATS.map(c => (
                      <button key={c} className={`${styles.catChip} ${catFilter===c?styles.catChipActive:''}`}
                        onClick={()=>setCatFilter(c)}>{c}</button>
                    ))}
                  </div>
                </div>
                <div className={styles.panelBody}>
                  {catalogResults.map(item => <ItemRow key={item.id} item={item}/>)}
                  {catalogResults.length === 0 && <div className={styles.empty}>No items found</div>}
                </div>
              </>
            )}

            {/* Past Orders */}
            {subTab === 'history' && (
              <>
                <div className={styles.panelHeader}><Clock size={15}/><span>Past Orders</span></div>
                <div className={styles.empty} style={{padding:48}}>
                  <Clock size={32} color="#d1d5db"/>
                  <p style={{marginTop:12,fontWeight:600}}>No past orders yet</p>
                  <p style={{fontSize:12,color:'#999',marginTop:4}}>Order history will appear here after your first submission</p>
                </div>
              </>
            )}

            {/* Payment Terms */}
            {subTab === 'terms' && (
              <>
                <div className={styles.panelHeader}><CreditCard size={15}/><span>Payment Terms & Outstanding Balances</span></div>
                <div className={styles.termsBody}>
                  {VENDORS.map(v => (
                    <div key={v.id} className={styles.termRow}>
                      <div className={styles.termVendor}>{v.emoji} {v.label}</div>
                      <div className={styles.termInfo}>
                        <span className={styles.termBadge}>Net 30</span>
                        <span style={{color:'#999',fontSize:12}}>Balance: —</span>
                        <a href={v.url} target="_blank" rel="noopener noreferrer" className={styles.termLink}>Portal ↗</a>
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>

        {/* Cart */}
        <div className={styles.cart}>
          <div className={styles.cartHeader}>
            <ShoppingCart size={15}/>
            <span>Current Order · {currentVendor?.label}</span>
            {cartCount > 0 && <span className={styles.cartBadge}>{cartCount}</span>}
          </div>
          <div className={styles.cartBody}>
            {cartItems.length === 0 ? (
              <div className={styles.cartEmpty}>
                <ShoppingCart size={28} color="#d1d5db"/>
                <p>Your cart is empty</p>
                <p style={{fontSize:11,color:'#999'}}>Add items from any panel on the left</p>
              </div>
            ) : (
              <>
                {cartItems.map(item => (
                  <div key={item.id} className={styles.cartItem}>
                    <div>
                      <div className={styles.cartItemName}>{item.name}</div>
                      <div className={styles.cartItemMeta}>{item.qty} × ${item.unitCost.toFixed(2)} = <strong>${(item.qty*item.unitCost).toFixed(2)}</strong></div>
                    </div>
                    <button className={styles.removeBtn} onClick={()=>setQty(item.id,0)}><Trash2 size={12}/></button>
                  </div>
                ))}
                <div className={styles.cartTotals}>
                  <div className={styles.cartTotalRow}><span>Subtotal</span><span>${cartTotal.toFixed(2)}</span></div>
                  <div className={styles.cartTotalRow} style={{color:'#999',fontSize:12}}><span>Est. Tax (0%)</span><span>$0.00</span></div>
                  <div className={`${styles.cartTotalRow} ${styles.cartGrand}`}><span>Order Total</span><span>${cartTotal.toFixed(2)}</span></div>
                </div>
              </>
            )}
          </div>
          <div className={styles.cartFooter}>
            <div className={styles.cartField}>
              <label>Delivery Date (Requested)</label>
              <input type="date" value={deliveryDate} onChange={e=>setDeliveryDate(e.target.value)} className={styles.cartInput}/>
            </div>
            <div className={styles.cartField}>
              <label>Order Notes</label>
              <textarea value={orderNote} onChange={e=>setOrderNote(e.target.value)}
                placeholder="Special instructions, delivery notes..." className={styles.cartTextarea} rows={2}/>
            </div>
            <button className={styles.submitBtn} onClick={submitOrder} disabled={submitted || cartItems.length===0}>
              {submitted ? '✓ Order Submitted!' : `📤 Submit to ${currentVendor?.label}`}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
