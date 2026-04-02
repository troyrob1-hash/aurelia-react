import { useState, useMemo } from 'react'
import { useLocations, cleanLocName } from '@/store/LocationContext'
import { useToast } from '@/components/ui/Toast'
import { ShoppingCart, Plus, Minus, Trash2, ExternalLink } from 'lucide-react'
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
]

// Items from BASE_ITEMS grouped by vendor
const SUGGESTED = {
  sysco: [
    { id:'s1', name:'Red Bull 12 oz', pack:'case/24', unitCost:1.98 },
    { id:'s2', name:'Celsius tropical vibe', pack:'case/12', unitCost:1.98 },
    { id:'s3', name:'Smart Water 20 oz', pack:'case/24', unitCost:1.63 },
    { id:'s4', name:'Boxed water 16.9 oz', pack:'case/24', unitCost:1.21 },
    { id:'s5', name:'Gatorade lemon lime', pack:'case/24', unitCost:1.04 },
    { id:'s6', name:'Greek yogurt vanilla 5.3oz', pack:'cs/12', unitCost:1.14 },
    { id:'s7', name:'Uncrustables PB strawberry', pack:'case/72', unitCost:0.92 },
    { id:'s8', name:'M&M peanuts', pack:'case/48', unitCost:1.25 },
    { id:'s9', name:'Snickers', pack:'case/48', unitCost:1.41 },
    { id:'s10', name:'Haribo goldbears', pack:'case/12', unitCost:1.81 },
    { id:'s11', name:'Hippeas chickpea puffs', pack:'case/12', unitCost:1.67 },
    { id:'s12', name:'Uglies sea salt', pack:'case/24', unitCost:1.19 },
    { id:'s13', name:'Ketchup packets', pack:'case/1000', unitCost:0.04 },
    { id:'s14', name:'Whole milk gallon', pack:'case/2', unitCost:4.76 },
    { id:'s15', name:'2% milk gallon', pack:'case/2', unitCost:8.93 },
  ],
  nassau: [
    { id:'n1', name:'Joe strawberry lemonade', pack:'case/12', unitCost:1.88 },
    { id:'n2', name:'North fork original', pack:'case/24', unitCost:1.23 },
    { id:'n3', name:'Sahale fruit and nut', pack:'case/9', unitCost:2.43 },
    { id:'n4', name:'Clif bar blueberry almond', pack:'cs/12', unitCost:2.45 },
    { id:'n5', name:'Barebell cookies and caramel', pack:'cs/12', unitCost:2.84 },
    { id:'n6', name:'Hippeas blazing hot', pack:'case/12', unitCost:1.67 },
  ],
  cafemoto: [
    { id:'cm1', name:'Cafe moto espresso moto 5lb', pack:'each', unitCost:74.79 },
    { id:'cm2', name:'Cafe moto brew 5lb', pack:'each', unitCost:73.05 },
    { id:'cm3', name:'Cafe moto guatemala 5lb', pack:'each', unitCost:82.61 },
    { id:'cm4', name:'Decaf moto brew 5lb', pack:'each', unitCost:87.28 },
  ],
  davidrio: [
    { id:'dr1', name:'Tiger spice chai 4lb', pack:'case/4', unitCost:11.75 },
    { id:'dr2', name:'Elephant vanilla chai 4lb', pack:'case/4', unitCost:11.75 },
    { id:'dr3', name:'Masala chai cart concentrate', pack:'case/4', unitCost:6.75 },
    { id:'dr4', name:'David rio tumeric latte', pack:'each', unitCost:32.00 },
  ],
}

export default function OrderHub() {
  const { selectedLocation } = useLocations()
  const toast = useToast()
  const [vendor, setVendor]   = useState('sysco')
  const [cart, setCart]       = useState({})
  const [orderNote, setOrderNote] = useState('')
  const [submitted, setSubmitted] = useState(false)

  const location = selectedLocation==='all' ? null : selectedLocation
  const items = SUGGESTED[vendor] || []

  function addToCart(item, qty=1) {
    setCart(prev => ({ ...prev, [item.id]: { ...item, qty: (prev[item.id]?.qty||0) + qty } }))
  }

  function setQty(id, qty) {
    if (qty <= 0) { setCart(prev => { const n={...prev}; delete n[id]; return n }); return }
    setCart(prev => ({ ...prev, [id]: { ...prev[id], qty } }))
  }

  function clearCart() { setCart({}) }

  async function submitOrder() {
    const cartItems = Object.values(cart)
    if (cartItems.length === 0) { toast.warning('Cart is empty'); return }
    const v = VENDORS.find(v=>v.id===vendor)
    const total = cartItems.reduce((s,i)=>s+(i.qty*i.unitCost),0)
    toast.success(`Order submitted to ${v.label} — ${cartItems.length} items, $${total.toFixed(2)}`)
    setSubmitted(true)
    setTimeout(() => { setCart({}); setSubmitted(false) }, 3000)
  }

  const cartItems   = Object.values(cart)
  const cartTotal   = cartItems.reduce((s,i)=>s+(i.qty*(i.unitCost||0)),0)
  const cartCount   = cartItems.reduce((s,i)=>s+i.qty,0)
  const currentVendor = VENDORS.find(v=>v.id===vendor)

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <div>
          <h1 className={styles.title}>Order Hub</h1>
          <p className={styles.subtitle}>{location ? cleanLocName(location) : 'Select a location'} · Place orders with your distributors</p>
        </div>
      </div>

      {/* Vendor links banner */}
      <div className={styles.vendorBanner}>
        <div className={styles.bannerLeft}>
          <div className={styles.bannerTitle}>🔌 Order Online</div>
          <div className={styles.vendorLinks}>
            {VENDORS.map(v => (
              <a key={v.id} href={v.url} target="_blank" rel="noopener noreferrer" className={styles.vendorLink}>
                {v.emoji} {v.label} <ExternalLink size={11}/>
              </a>
            ))}
          </div>
        </div>
      </div>

      <div className={styles.layout}>
        {/* Left: Product list */}
        <div className={styles.products}>
          <div className={styles.vendorTabs}>
            {VENDORS.map(v => (
              <button key={v.id} className={`${styles.vendorTab} ${vendor===v.id?styles.vendorTabActive:''}`}
                onClick={()=>setVendor(v.id)}>
                {v.emoji} {v.label}
              </button>
            ))}
          </div>

          <div className={styles.productList}>
            {items.length === 0 ? (
              <div className={styles.noItems}>
                <p>No suggested items for {currentVendor?.label}.</p>
                <a href={currentVendor?.url} target="_blank" rel="noopener noreferrer" className={styles.orderDirectBtn}>
                  Order directly on {currentVendor?.label} ↗
                </a>
              </div>
            ) : items.map(item => {
              const inCart = cart[item.id]
              return (
                <div key={item.id} className={`${styles.productCard} ${inCart?styles.productInCart:''}`}>
                  <div className={styles.productInfo}>
                    <div className={styles.productName}>{item.name}</div>
                    <div className={styles.productMeta}>{item.pack} · ${item.unitCost.toFixed(2)}/unit</div>
                  </div>
                  <div className={styles.productActions}>
                    {inCart ? (
                      <div className={styles.qtyControl}>
                        <button onClick={()=>setQty(item.id,inCart.qty-1)}><Minus size={12}/></button>
                        <span>{inCart.qty}</span>
                        <button onClick={()=>setQty(item.id,inCart.qty+1)}><Plus size={12}/></button>
                      </div>
                    ) : (
                      <button className={styles.addBtn} onClick={()=>addToCart(item)}><Plus size={14}/> Add</button>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </div>

        {/* Right: Cart */}
        <div className={styles.cartPanel}>
          <div className={styles.cartHeader}>
            <ShoppingCart size={16}/>
            <span>Order Cart</span>
            {cartCount > 0 && <span className={styles.cartBadge}>{cartCount}</span>}
          </div>

          {cartItems.length === 0 ? (
            <div className={styles.cartEmpty}>
              <ShoppingCart size={32} color="#d1d5db"/>
              <p>Your cart is empty</p>
              <p style={{fontSize:12,color:'#999'}}>Add items from the product list</p>
            </div>
          ) : (
            <>
              <div className={styles.cartItems}>
                {cartItems.map(item => (
                  <div key={item.id} className={styles.cartItem}>
                    <div className={styles.cartItemName}>{item.name}</div>
                    <div className={styles.cartItemMeta}>
                      <span>{item.qty} × ${item.unitCost.toFixed(2)}</span>
                      <span style={{fontWeight:700}}>${(item.qty*item.unitCost).toFixed(2)}</span>
                      <button onClick={()=>setQty(item.id,0)} className={styles.removeBtn}><Trash2 size={12}/></button>
                    </div>
                  </div>
                ))}
              </div>
              <div className={styles.cartFooter}>
                <div className={styles.cartTotal}>
                  <span>Total ({cartCount} items)</span>
                  <span>${cartTotal.toFixed(2)}</span>
                </div>
                <textarea value={orderNote} onChange={e=>setOrderNote(e.target.value)}
                  placeholder="Order notes (delivery date, special instructions...)"
                  className={styles.noteInput} rows={2}/>
                <div style={{display:'flex',gap:8}}>
                  <button className={styles.clearBtn} onClick={clearCart}>Clear</button>
                  <button className={styles.submitBtn} onClick={submitOrder} disabled={submitted}>
                    {submitted ? '✓ Submitted!' : `Submit to ${currentVendor?.label}`}
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
