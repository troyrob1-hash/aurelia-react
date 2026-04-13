import { useState, useMemo, useEffect, Fragment, useCallback } from 'react'
import { useLocations, cleanLocName } from '@/store/LocationContext'
import { useToast } from '@/components/ui/Toast'
import { useVendors } from '@/hooks/useVendorsProducts'
import VendorImportModal from './components/VendorImportModal'
import { Search, Download, X, Clock, LayoutGrid, List, TrendingUp, Package, CheckCircle, AlertTriangle, Truck, RefreshCw, Upload } from 'lucide-react'
import { db } from '@/lib/firebase'
import { collection, addDoc, getDocs, query, orderBy, limit, serverTimestamp, doc, getDoc, where, writeBatch } from 'firebase/firestore'
import { writePurchasingPnL, weekPeriod } from '@/lib/pnl'
import { useAuthStore } from '@/store/authStore'
import { submitToVendor } from '@/services/vendors'
import styles from './OrderHub.module.css'

// ═══════════════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════════════

// Category set aligned with Inventory's 8-category taxonomy
const CATS = ['All', 'Beverages', 'Bar/Barista', 'Pantry/Snacks', 'Dairy', 'Frozen', 'Proteins', 'Produce', 'General']

// Category colors — extends Inventory's color palette
const CAT_COLORS = {
  'Beverages':     { color:'#1e40af', bg:'#dbeafe', light:'#eff6ff' },
  'Bar/Barista':   { color:'#7c3aed', bg:'#ede9fe', light:'#f5f3ff' },
  'Pantry/Snacks': { color:'#92400e', bg:'#fef3c7', light:'#fffbeb' },
  'Dairy':         { color:'#0369a1', bg:'#e0f2fe', light:'#f0f9ff' },
  'Frozen':        { color:'#1d4ed8', bg:'#dbeafe', light:'#eff6ff' },
  'Proteins':      { color:'#b91c1c', bg:'#fee2e2', light:'#fef2f2' },
  'Produce':       { color:'#15803d', bg:'#dcfce7', light:'#f0fdf4' },
  'General':       { color:'#374151', bg:'#f3f4f6', light:'#f9fafb' },
}

// Auto-categorize master items from their name. Matches Inventory's
// default category rules in src/hooks/useInventory.js so counts align.
function categorizeItem(item) {
  const name = (item.name || '').toLowerCase()
  const pairs = [
    ['Beverages',     /(red bull|celsius|coke|sprite|juice|water|tea|coffee drink|lemonade|gatorade|smartwater|diet)/],
    ['Bar/Barista',   /(espresso|syrup|chai|matcha|cold brew|latte|bean|ghirardelli|monin|moto|david rio)/],
    ['Pantry/Snacks', /(chip|bar |snack|cookie|candy|nut|pretzel|popcorn|clif|m&m|snicker|haribo|uglies|sahale|barebell)/],
    ['Dairy',         /(milk|cream|yogurt|cheese|butter|oat)/],
    ['Frozen',        /(ice cream|frozen|popsicle)/],
    ['Proteins',      /(chicken|beef|steak|salmon|fish|pork|turkey|shrimp|wenzel|jerky|meat stick)/],
    ['Produce',       /(lettuce|tomato|onion|pepper|carrot|fruit|apple|banana|berry)/],
  ]
  for (const [cat, rx] of pairs) {
    if (rx.test(name)) return cat
  }
  return 'General'
}

const STATUS_CONFIG = {
  Submitted:  { color:'#1e40af', bg:'#dbeafe', icon: Package },
  Approved:   { color:'#065f46', bg:'#d1fae5', icon: CheckCircle },
  Receiving:  { color:'#0369a1', bg:'#e0f2fe', icon: Truck },
  Received:   { color:'#065f46', bg:'#d1fae5', icon: CheckCircle },
  Rejected:   { color:'#991b1b', bg:'#fee2e2', icon: X },
  Pending:    { color:'#92400e', bg:'#fef3c7', icon: AlertTriangle },
}

// ═══════════════════════════════════════════════════════════════════════════
// OrderHub Component
// ═══════════════════════════════════════════════════════════════════════════

export default function OrderHub() {
  const { selectedLocation } = useLocations()
  const toast = useToast()
  const { user } = useAuthStore()
  
  // FIXED: Derive orgId from user consistently
  const orgId = user?.tenantId || null
  
  // View state
  const [view, setView] = useState('order')
  
  // Filter state
  const [vendorFilter, setVendorFilter] = useState('all')
  const [cat, setCat] = useState('All')
  const [search, setSearch] = useState('')
  const [filterBelowPar, setFilterBelowPar] = useState(false)
  const [filterInCart, setFilterInCart] = useState(false)
  
  // Cart state
  const [qty, setQty] = useState({})
  // Default delivery date: 2 business days from today (gives vendors ~48hr
  // notice and skips Saturday/Sunday automatically).
  const defaultDeliveryDate = (() => {
    const d = new Date()
    let added = 0
    while (added < 2) {
      d.setDate(d.getDate() + 1)
      const dow = d.getDay() // 0=Sun, 6=Sat
      if (dow !== 0 && dow !== 6) added++
    }
    return d.toISOString().slice(0, 10) // yyyy-mm-dd for <input type="date">
  })()
  const [deliveryDate, setDeliveryDate] = useState(defaultDeliveryDate)
  const [note, setNote] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [submitted, setSubmitted] = useState(false)
  const [showBudgetPreview, setShowBudgetPreview] = useState(false)
  
  // Past orders
  const [pastOrders, setPastOrders] = useState([])
  const [pastOrdersLoading, setPastOrdersLoading] = useState(false)
  const [showPast, setShowPast] = useState(false)

  // Budget data from Firestore
  const [weeklyBudget, setWeeklyBudget] = useState({ cogs: 3500, spent: 0 })

  // Vendor import modal
  const [showImportModal, setShowImportModal] = useState(false)
  // Bumped after each successful import — forces catalog reload
  const [importNonce, setImportNonce] = useState(0)

  // Master catalog + per-location inventory overrides merged into a single
  // shopping catalog. Replaces the previous hardcoded ITEMS const.
  const [items, setItems] = useState([])
  const [itemsLoading, setItemsLoading] = useState(true)

  // Vendors from the live tenants/{orgId}/vendors collection
  const { vendors: firestoreVendors } = useVendors()

  const location = selectedLocation === 'all' ? null : selectedLocation

  // Build the vendor list: prefer firestoreVendors if any exist, otherwise
  // derive from distinct vendor strings in the catalog items themselves.
  // Each vendor entry needs: { id, label, url }
  const VENDORS = useMemo(() => {
    if (firestoreVendors && firestoreVendors.length > 0) {
      return firestoreVendors.map(v => ({
        id: v.id,
        label: v.name || v.label || 'Unknown',
        url:   v.url || v.orderingUrl || null,
      }))
    }
    // Fallback: derive from catalog. Dedupe by slug so vendor string
    // variants ("David Rio" vs "david rio" vs "David Rio ") collapse to one.
    const distinct = new Map()
    items.forEach(i => {
      if (!i.vendor) return
      const label = i.vendor.trim()
      if (!label) return
      const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')
      if (!slug) return
      if (!distinct.has(slug)) {
        // Prefer Title Case for display
        const pretty = label.split(/\s+/).map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ')
        distinct.set(slug, { id: slug, label: pretty, url: null })
      }
    })
    return Array.from(distinct.values()).sort((a, b) => a.label.localeCompare(b.label))
  }, [firestoreVendors, items])

  // Load weekly budget from Firestore
  useEffect(() => {
    if (!orgId || !location) return
    
    const loadBudget = async () => {
      try {
        const period = weekPeriod()
        const pnlRef = doc(db, 'tenants', orgId, 'pnl', location, 'periods', period)
        const pnlSnap = await getDoc(pnlRef)
        
        if (pnlSnap.exists()) {
          const data = pnlSnap.data()
          setWeeklyBudget({
            cogs: data.cogs_budget || 3500,
            spent: data.cogs_purchases || 0
          })
        }
      } catch (err) {
        console.error('Failed to load budget:', err)
      }
    }
    
    loadBudget()
  }, [orgId, location])

  // Load master catalog from tenants/{orgId}/inventoryCatalog
  // and merge with per-location inventory overrides for par + onHand.
  useEffect(() => {
    if (!orgId) {
      setItems([])
      setItemsLoading(false)
      return
    }
    let cancelled = false
    const loadCatalog = async () => {
      setItemsLoading(true)
      try {
        // Master catalog — 428 items for Fooda after the Apr 12 migration.
        const catalogSnap = await getDocs(collection(db, 'tenants', orgId, 'inventoryCatalog'))
        const masterItems = catalogSnap.docs.map(d => {
          const data = d.data()
          return {
            id:       d.id,
            name:     data.name || '',
            unitCost: data.unitCost || 0,
            pack:     data.packSize || data.pack || '',
            sku:      data.glCode || data.sku || '',
            vendor:   data.vendor || 'Unknown',
            cat:      categorizeItem(data),
            par:      0,   // filled in from per-location overrides below
            onHand:   0,   // filled in from per-location overrides below
          }
        })

        // Per-location overrides — par, reorder, latest qty counted
        // Only load if a specific location is selected. For 'all', par/onHand
        // are left at 0 (OrderHub's below-par filter requires a location anyway).
        let overrides = {}
        if (location) {
          const locId = (location || '').replace(/[^a-zA-Z0-9]/g, '_')
          try {
            const overrideSnap = await getDocs(collection(db, 'tenants', orgId, 'inventory', locId, 'items'))
            overrideSnap.forEach(d => {
              const od = d.data()
              if (od.removed) return
              overrides[d.id] = {
                par:    od.parLevel || 0,
                onHand: od.qty ?? 0,
              }
            })
          } catch (e) {
            console.warn('Failed to load per-location inventory overrides:', e)
          }
        }

        // Merge
        const merged = masterItems.map(mi => ({
          ...mi,
          par:    overrides[mi.id]?.par ?? mi.par,
          onHand: overrides[mi.id]?.onHand ?? mi.onHand,
        }))

        if (!cancelled) {
          setItems(merged)
          setItemsLoading(false)
          console.log('OrderHub: loaded ' + merged.length + ' items (catalog merged with ' + Object.keys(overrides).length + ' location overrides)')
        }
      } catch (err) {
        console.error('Failed to load OrderHub catalog:', err)
        if (!cancelled) {
          setItems([])
          setItemsLoading(false)
        }
      }
    }
    loadCatalog()
    return () => { cancelled = true }
  }, [orgId, location, importNonce])

  // Slugify a vendor name the same way the VENDORS memo does so filtering works.
  const vendorSlug = (name) => (name || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')

  // Get items based on vendor filter. vendorFilter holds a vendor id (slug).
  const visibleItems = useMemo(() => {
    if (vendorFilter === 'all') return items
    return items.filter(i => vendorSlug(i.vendor) === vendorFilter)
  }, [items, vendorFilter])

  // Cart items from ALL vendors
  const cartItems = useMemo(() => {
    return Object.entries(qty).map(([id, q]) => {
      const item = items.find(i => i.id === id)
      return item ? { ...item, qty: q } : null
    }).filter(Boolean)
  }, [qty, items])

  // Group cart by vendor (keyed by vendor id slug, not the raw vendor name)
  const cartByVendor = useMemo(() => {
    const grouped = {}
    cartItems.forEach(item => {
      const slug = vendorSlug(item.vendor) || 'unknown'
      if (!grouped[slug]) grouped[slug] = []
      grouped[slug].push(item)
    })
    return grouped
  }, [cartItems])

  const cartTotal = cartItems.reduce((s, i) => s + i.qty * i.unitCost, 0)
  const cartLines = cartItems.length
  const vendorCount = Object.keys(cartByVendor).length

  // Filtered products
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

  // ─── Handlers ──────────────────────────────────────────────────────────────

  const setItemQty = useCallback((id, val) => {
    const n = Math.max(0, parseInt(val) || 0)
    setQty(prev => n === 0 ? (({ [id]: _, ...rest }) => rest)(prev) : { ...prev, [id]: n })
  }, [])

  const adj = useCallback((id, delta) => {
    setItemQty(id, (qty[id] || 0) + delta)
  }, [qty, setItemQty])

  const addAllBelowPar = useCallback(() => {
    const updates = {}
    visibleItems.filter(i => i.onHand < i.par).forEach(i => {
      updates[i.id] = i.par - i.onHand
    })
    setQty(prev => ({ ...prev, ...updates }))
    toast.success(`Added ${Object.keys(updates).length} below-par items to order`)
  }, [visibleItems, toast])

  const loadPastOrders = useCallback(async () => {
    if (!orgId) {
      toast.error('No organization found')
      return
    }

    setPastOrdersLoading(true)
    try {
      const snap = await getDocs(
        query(
          collection(db, 'tenants', orgId, 'orders'),
          orderBy('createdAt', 'desc'),
          limit(20)
        )
      )
      setPastOrders(snap.docs.map(d => ({ id: d.id, ...d.data() })))
    } catch (e) {
      console.error('Failed to load past orders:', e)
      toast.error('Failed to load past orders')
    } finally {
      setPastOrdersLoading(false)
    }
  }, [orgId, toast])

  // Submit orders
  const submitOrders = useCallback(async () => {
    if (!cartLines) {
      toast.warning('Cart is empty')
      return
    }
    
    if (!orgId) {
      toast.error('No organization found. Please log in again.')
      return
    }

    // Delivery date is required
    if (!deliveryDate) {
      toast.error('Please select a delivery date before submitting')
      return
    }

    // Delivery date must be today or later
    const todayStr = new Date().toISOString().slice(0, 10)
    if (deliveryDate < todayStr) {
      toast.error('Delivery date cannot be in the past')
      return
    }

    setSubmitting(true)
    const now = new Date()

    try {
      // Create separate order for each vendor
      for (const [vendorId, items] of Object.entries(cartByVendor)) {
        const vendor = VENDORS.find(v => v.id === vendorId)
        const vendorTotal = items.reduce((s, i) => s + i.qty * i.unitCost, 0)
        const orderNum = `ORD-${now.getFullYear()}${String(now.getMonth()+1).padStart(2,'0')}${String(now.getDate()).padStart(2,'0')}-${vendorId.toUpperCase().slice(0,3)}-${Math.floor(Math.random()*9000+1000)}`

        const orderDoc = {
          orderNum,
          vendor: vendor?.label || vendorId,
          vendorId,
          location: location || 'All Locations',
          locationId: location,
          deliveryDate: deliveryDate || null,
          note,
          items: items.map(i => ({
            id: i.id,
            name: i.name,
            sku: i.sku,
            pack: i.pack,
            unitCost: i.unitCost,
            qty: i.qty,
            subtotal: +(i.qty * i.unitCost).toFixed(2)
          })),
          total: +vendorTotal.toFixed(2),
          status: 'Submitted',
          createdBy: user?.email || 'unknown',
          createdAt: serverTimestamp(),
        }

        // FIXED: Use dynamic orgId
        await addDoc(collection(db, 'tenants', orgId, 'orders'), orderDoc)

        // Auto-create invoice
        await addDoc(collection(db, 'tenants', orgId, 'invoices'), {
          invoiceNum: orderNum,
          vendor: vendor?.label || vendorId,
          invoiceDate: now.toISOString().slice(0, 10),
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

        // Try to submit to vendor API
        try {
          await submitToVendor(vendorId, orderDoc)
        } catch (apiErr) {
          console.warn(`Vendor API submission failed for ${vendorId}:`, apiErr)
        }
      }

      // Write to P&L
      if (location) {
        await writePurchasingPnL(location, weekPeriod(), {
          invoiceTotal: +cartTotal.toFixed(2),
          paidTotal: 0,
          pendingTotal: +cartTotal.toFixed(2),
        })
      }

      setSubmitted(true)
      toast.success(`${vendorCount} order${vendorCount > 1 ? 's' : ''} submitted — $${cartTotal.toFixed(2)} total`)
      
      // Reset after success
      setTimeout(() => {
        setQty({})
        setSubmitted(false)
        setNote('')
        // Reset delivery date back to the 2-business-days-out default,
        // not empty — next order is ready to submit immediately.
        const d = new Date()
        let added = 0
        while (added < 2) {
          d.setDate(d.getDate() + 1)
          const dow = d.getDay()
          if (dow !== 0 && dow !== 6) added++
        }
        setDeliveryDate(d.toISOString().slice(0, 10))
      }, 2000)

    } catch (e) {
      console.error('Order submission failed:', e)
      toast.error('Failed to submit orders: ' + e.message)
    } finally {
      setSubmitting(false)
    }
  }, [cartLines, cartByVendor, cartTotal, vendorCount, orgId, location, deliveryDate, note, user, toast])

  const exportCSV = useCallback(() => {
    const rows = [
      ['Vendor', 'SKU', 'Product', 'Pack', 'Unit Cost', 'Qty', 'Subtotal'],
      ...cartItems.map(i => {
        const v = VENDORS.find(v => v.id === i.vendor)
        return [v?.label, i.sku, i.name, i.pack, i.unitCost, i.qty, (i.qty * i.unitCost).toFixed(2)]
      })
    ]
    const csv = rows.map(r => r.map(v => `"${v}"`).join(',')).join('\n')
    const blob = new Blob([csv], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    Object.assign(document.createElement('a'), {
      href: url,
      download: `order-multi-${new Date().toISOString().slice(0, 10)}.csv`
    }).click()
    URL.revokeObjectURL(url)
  }, [cartItems])

  // Kanban data
  const ordersByStatus = useMemo(() => {
    const grouped = { Submitted: [], Approved: [], Receiving: [], Received: [] }
    pastOrders.forEach(o => {
      if (grouped[o.status]) grouped[o.status].push(o)
    })
    return grouped
  }, [pastOrders])

  // Load past orders on mount for kanban
  useEffect(() => {
    if (orgId) loadPastOrders()
  }, [orgId, loadPastOrders])

  // ─── Render ────────────────────────────────────────────────────────────────

  return (
    <div className={styles.page}>
      {/* View Toggle + Toolbar */}
      <div className={styles.toolbar}>
        <div className={styles.viewToggle}>
          <button 
            className={`${styles.viewBtn} ${view === 'order' ? styles.viewActive : ''}`} 
            onClick={() => setView('order')}
          >
            <List size={14}/> Order
          </button>
          <button 
            className={`${styles.viewBtn} ${view === 'kanban' ? styles.viewActive : ''}`} 
            onClick={() => setView('kanban')}
          >
            <LayoutGrid size={14}/> Board
          </button>
        </div>

        {view === 'order' && (
          <>
            <div className={styles.toolGroup}>
              <span className={styles.toolLabel}>Vendor</span>
              <select 
                value={vendorFilter} 
                onChange={e => setVendorFilter(e.target.value)} 
                className={styles.sel}
              >
                <option value="all">All Vendors (Multi-Cart)</option>
                {VENDORS.map(v => <option key={v.id} value={v.id}>{v.label}</option>)}
              </select>
            </div>
            <div className={styles.toolDivider}/>
            <div className={styles.toolGroup}>
              <span className={styles.toolLabel}>
                Delivery date <span style={{color:'#dc2626'}}>*</span>
              </span>
              <input 
                type="date" 
                value={deliveryDate} 
                onChange={e => setDeliveryDate(e.target.value)} 
                min={new Date().toISOString().slice(0, 10)}
                className={styles.dateInput}
                required
              />
            </div>
            <div className={styles.toolDivider}/>
            <div className={styles.searchWrap}>
              <Search size={13} className={styles.searchIcon}/>
              <input 
                value={search} 
                onChange={e => setSearch(e.target.value)} 
                placeholder="Search products..." 
                className={styles.searchInput}
              />
            </div>
            <div className={styles.toolRight}>
              {belowParCnt > 0 && (
                <button className={styles.belowParBtn} onClick={addAllBelowPar}>
                  ⚠ {belowParCnt} below par — add all
                </button>
              )}
              <button
                className={styles.pastOrdersBtn}
                onClick={() => setShowImportModal(true)}
                title="Import a vendor catalog from CSV/Excel"
              >
                <Upload size={13}/> Import catalog
              </button>
              <button 
                className={styles.pastOrdersBtn} 
                onClick={() => { setShowPast(v => !v); loadPastOrders() }}
              >
                <Clock size={13}/> Past Orders
              </button>
            </div>
          </>
        )}

        {view === 'kanban' && (
          <button 
            className={styles.pastOrdersBtn} 
            onClick={loadPastOrders}
            disabled={pastOrdersLoading}
          >
            <RefreshCw size={13} className={pastOrdersLoading ? styles.spin : ''}/> Refresh
          </button>
        )}
      </div>

      {/* Past Orders Panel */}
      {showPast && view === 'order' && (
        <div className={styles.pastPanel}>
          <div className={styles.pastHeader}>
            <span>Past Orders</span>
            <button className={styles.pastClose} onClick={() => setShowPast(false)}>✕</button>
          </div>
          {pastOrdersLoading ? (
            <div className={styles.pastEmpty}>Loading orders...</div>
          ) : pastOrders.length === 0 ? (
            <div className={styles.pastEmpty}>No orders submitted yet</div>
          ) : (
            <table className={styles.pastTable}>
              <thead>
                <tr>
                  <th>Order #</th>
                  <th>Vendor</th>
                  <th>Location</th>
                  <th>Date</th>
                  <th>Items</th>
                  <th>Total</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {pastOrders.map(o => (
                  <tr key={o.id}>
                    <td style={{ fontWeight: 600, fontFamily: 'monospace' }}>{o.orderNum}</td>
                    <td>{o.vendor}</td>
                    <td>{cleanLocName(o.location || '')}</td>
                    <td>{o.createdAt?.toDate?.()?.toLocaleDateString?.() || '—'}</td>
                    <td>{o.items?.length || 0} lines</td>
                    <td style={{ fontWeight: 700, color: '#185FA5' }}>${(o.total || 0).toFixed(2)}</td>
                    <td>
                      <span 
                        className={styles.statusBadge} 
                        style={{ 
                          background: STATUS_CONFIG[o.status]?.bg, 
                          color: STATUS_CONFIG[o.status]?.color 
                        }}
                      >
                        {o.status}
                      </span>
                    </td>
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
          {pastOrdersLoading && (
            <div className={styles.kanbanLoading}>Loading orders...</div>
          )}
          {Object.entries(ordersByStatus).map(([status, orders]) => {
            const config = STATUS_CONFIG[status] || {}
            const Icon = config.icon || Package
            return (
              <div key={status} className={styles.kanbanCol}>
                <div className={styles.kanbanHeader} style={{ borderBottomColor: config.color }}>
                  <Icon size={14} style={{ color: config.color }}/>
                  <span>{status}</span>
                  <span 
                    className={styles.kanbanCount} 
                    style={{ background: config.bg, color: config.color }}
                  >
                    {orders.length}
                  </span>
                </div>
                <div className={styles.kanbanCards}>
                  {orders.map(order => (
                    <div key={order.id} className={styles.kanbanCard}>
                      <div className={styles.kanbanCardHeader}>
                        <span className={styles.kanbanOrderNum}>{order.orderNum}</span>
                        <span className={styles.kanbanTotal}>${(order.total || 0).toFixed(2)}</span>
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
                  {orders.length === 0 && !pastOrdersLoading && (
                    <div className={styles.kanbanEmpty}>No orders</div>
                  )}
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
                  <button 
                    key={c}
                    className={`${styles.sideItem} ${cat === c ? styles.sideActive : ''}`}
                    onClick={() => setCat(c)}
                    style={cat === c && CAT_COLORS[c] ? {
                      background: CAT_COLORS[c].light, 
                      color: CAT_COLORS[c].color, 
                      borderLeft: `3px solid ${CAT_COLORS[c].color}`
                    } : {}}
                  >
                    <span>{c}</span>
                    <span 
                      className={styles.sideCount} 
                      style={cat === c && CAT_COLORS[c] ? {
                        background: CAT_COLORS[c].bg, 
                        color: CAT_COLORS[c].color
                      } : {}}
                    >
                      {count}
                    </span>
                  </button>
                )
              })}
            </div>
            <div className={styles.sideSection}>
              <div className={styles.sideLabel}>Filter</div>
              <button 
                className={`${styles.sideItem} ${filterBelowPar ? styles.sideActive : ''}`} 
                onClick={() => setFilterBelowPar(v => !v)}
              >
                <span>Below par</span>
                <span className={`${styles.sideCount} ${filterBelowPar ? styles.sideCountActive : ''}`}>
                  {belowParCnt}
                </span>
              </button>
              <button 
                className={`${styles.sideItem} ${filterInCart ? styles.sideActive : ''}`} 
                onClick={() => setFilterInCart(v => !v)}
              >
                <span>In order</span>
                <span className={`${styles.sideCount} ${filterInCart ? styles.sideCountActive : ''}`}>
                  {cartLines}
                </span>
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
                  <th className={styles.th}>Pack</th>
                  <th className={`${styles.th} ${styles.r}`}>Unit cost</th>
                  <th className={`${styles.th} ${styles.r}`}>Par</th>
                  <th className={`${styles.th} ${styles.r}`}>On hand</th>
                  <th className={`${styles.th} ${styles.r}`} style={{ width: 120 }}>Order qty</th>
                  <th className={`${styles.th} ${styles.r}`}>Subtotal</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(grouped).map(([catName, items]) => (
                  <Fragment key={catName}>
                    <tr className={styles.catRow}>
                      <td 
                        colSpan={vendorFilter === 'all' ? 9 : 8} 
                        className={styles.catLabel}
                        style={{ background: CAT_COLORS[catName]?.bg, color: CAT_COLORS[catName]?.color }}
                      >
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
                          <td className={styles.tdProduct}>
                            <div className={styles.itemName}>{item.name}</div>
                          </td>
                          <td><span className={styles.packBadge}>{item.pack}</span></td>
                          <td className={`${styles.td} ${styles.r}`}>${item.unitCost.toFixed(2)}</td>
                          <td 
                            className={`${styles.td} ${styles.r}`} 
                            style={{ color: belowPar ? '#854F0B' : undefined }}
                          >
                            {item.par}
                          </td>
                          <td 
                            className={`${styles.td} ${styles.r}`} 
                            style={{ 
                              fontWeight: belowPar ? 600 : 400, 
                              color: item.onHand === 0 ? '#A32D2D' : belowPar ? '#854F0B' : undefined 
                            }}
                          >
                            {item.onHand}
                          </td>
                          <td className={styles.tdQty}>
                            <div className={`${styles.qtyWrap} ${q > 0 ? styles.qtyActive : ''}`}>
                              <button className={styles.qtyBtn} onClick={() => adj(item.id, -1)}>−</button>
                              <input 
                                type="number" 
                                min="0" 
                                value={q || ''} 
                                onChange={e => setItemQty(item.id, e.target.value)} 
                                className={styles.qtyInput} 
                                placeholder="0"
                              />
                              <button className={styles.qtyBtn} onClick={() => adj(item.id, 1)}>+</button>
                            </div>
                          </td>
                          <td 
                            className={`${styles.td} ${styles.r}`} 
                            style={{ fontWeight: q > 0 ? 600 : 400, color: q > 0 ? '#185FA5' : '#ccc' }}
                          >
                            {q > 0 ? `$${subtotal.toFixed(2)}` : '—'}
                          </td>
                        </tr>
                      )
                    })}
                  </Fragment>
                ))}
                {Object.keys(grouped).length === 0 && (
                  <tr>
                    <td colSpan={vendorFilter === 'all' ? 9 : 8} className={styles.emptyRow}>
                      No products match your filter
                    </td>
                  </tr>
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
                <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>No items added yet</div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
                  Set quantities in the table
                </div>
              </div>
            ) : (
              <div className={styles.sumItems}>
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
                          <div style={{ flex: 1 }}>
                            <div className={styles.sumItemName}>{item.name}</div>
                            <div className={styles.sumItemSub}>{item.qty} × ${item.unitCost.toFixed(2)}</div>
                          </div>
                          <div className={styles.sumItemPrice}>${(item.qty * item.unitCost).toFixed(2)}</div>
                          <button 
                            className={styles.removeBtn} 
                            onClick={() => setItemQty(item.id, 0)}
                          >
                            <X size={12}/>
                          </button>
                        </div>
                      ))}
                    </div>
                  )
                })}
              </div>
            )}

            {cartLines > 0 && (
              <div className={styles.sumTotals}>
                <div className={styles.sumRow}>
                  <span>Subtotal</span>
                  <span>${cartTotal.toFixed(2)}</span>
                </div>
                <div className={styles.sumGrand}>
                  <span>Order total</span>
                  <span>${cartTotal.toFixed(2)}</span>
                </div>
              </div>
            )}

            {/* Budget Impact Preview */}
            {cartLines > 0 && (
              <div className={styles.budgetPreview}>
                <button 
                  className={styles.budgetToggle} 
                  onClick={() => setShowBudgetPreview(v => !v)}
                >
                  <TrendingUp size={13}/> Budget Impact {showBudgetPreview ? '▲' : '▼'}
                </button>
                {showBudgetPreview && (
                  <div className={styles.budgetDetails}>
                    <div className={styles.budgetRow}>
                      <span>Weekly COGS budget</span>
                      <span>${weeklyBudget.cogs.toFixed(2)}</span>
                    </div>
                    <div className={styles.budgetRow}>
                      <span>Already spent</span>
                      <span>${weeklyBudget.spent.toFixed(2)}</span>
                    </div>
                    <div className={styles.budgetRow} style={{ color: '#1e40af', fontWeight: 600 }}>
                      <span>This order</span>
                      <span>+${cartTotal.toFixed(2)}</span>
                    </div>
                    <div className={styles.budgetBar}>
                      <div 
                        className={styles.budgetBarFill} 
                        style={{ 
                          width: `${Math.min(100, ((weeklyBudget.spent + cartTotal) / weeklyBudget.cogs) * 100)}%` 
                        }}
                      />
                    </div>
                    <div className={styles.budgetRow} style={{ fontWeight: 700 }}>
                      <span>Remaining</span>
                      <span 
                        style={{ 
                          color: (weeklyBudget.cogs - weeklyBudget.spent - cartTotal) < 0 ? '#991b1b' : '#065f46' 
                        }}
                      >
                        ${(weeklyBudget.cogs - weeklyBudget.spent - cartTotal).toFixed(2)}
                      </span>
                    </div>
                  </div>
                )}
              </div>
            )}

            <div className={styles.sumFooter}>
              <div className={styles.sumField}>
                <label className={styles.sumLabel}>Notes</label>
                <textarea 
                  value={note} 
                  onChange={e => setNote(e.target.value)} 
                  placeholder="Delivery instructions, special requests..." 
                  className={styles.sumTextarea} 
                  rows={2}
                />
              </div>
              <div className={styles.sumActions}>
                {cartLines > 0 && (
                  <button className={styles.exportBtn} onClick={exportCSV}>
                    <Download size={13}/> Export
                  </button>
                )}
                <button 
                  className={styles.submitBtn} 
                  onClick={submitOrders} 
                  disabled={submitting || submitted || cartLines === 0}
                >
                  {submitted 
                    ? '✓ Submitted' 
                    : submitting 
                      ? 'Submitting...' 
                      : vendorCount > 1 
                        ? `Submit ${vendorCount} Orders` 
                        : 'Submit Order'
                  }
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Vendor catalog import modal */}
      {showImportModal && (
        <VendorImportModal
          orgId={orgId}
          onClose={() => setShowImportModal(false)}
          onSuccess={() => {
            // Import succeeded. Bump the nonce to force the catalog useEffect
            // to reload so new items appear in the background. DO NOT close
            // the modal here — the modal shows its own success screen and the
            // user dismisses it with the Done button (which calls onClose).
            setImportNonce(n => n + 1)
          }}
        />
      )}
    </div>
  )
}