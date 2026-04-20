import { useState, useMemo, useEffect, Fragment, useCallback, useRef } from 'react'
import { useLocations, cleanLocName } from '@/store/LocationContext'
import { useToast } from '@/components/ui/Toast'
import { useVendors } from '@/hooks/useVendorsProducts'
import { APPROVAL_THRESHOLDS } from '@/hooks/useOrders'
import VendorImportModal from './components/VendorImportModal'
import OrderItemWhyPanel from './components/OrderItemWhyPanel'
import ReceivingModal from './components/ReceivingModal'
import { Search, Download, X, Clock, LayoutGrid, List, TrendingUp, Package, CheckCircle, AlertTriangle, Truck, RefreshCw, Upload } from 'lucide-react'
import { db, auth } from '@/lib/firebase'
import { collection, addDoc, getDocs, query, orderBy, limit, serverTimestamp, doc, getDoc, where, writeBatch, setDoc, onSnapshot } from 'firebase/firestore'
import { writePurchasingPnL, weekPeriod } from '@/lib/pnl'
import { useAuthStore } from '@/store/authStore'
import { submitToVendor } from '@/services/vendors'
import AllLocationsGrid from '@/components/AllLocationsGrid'
import styles from './OrderHub.module.css'

// ═══════════════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════════════

// Category set aligned with Inventory's 8-category taxonomy
const CATS = ['All', 'Frequent', 'Beverages', 'Bar/Barista', 'Pantry/Snacks', 'Dairy', 'Frozen', 'Proteins', 'Produce', 'General']

// Category colors — extends Inventory's color palette
const CAT_COLORS = {
  'Frequent':      { color:'#d97706', bg:'#fef3c7', light:'#fffbeb' },
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


const SPEND_CATEGORIES = [
  { key: 'cogs_equipment',  label: 'Onsite Equipment',               pctGFS: 0.010 },
  { key: 'cogs_supplies',   label: 'Onsite Supplies',                pctGFS: 0.001 },
  { key: 'cogs_cleaning',   label: 'Cleaning Supplies & Chemicals',  pctGFS: 0.005 },
  { key: 'cogs_paper',      label: 'Paper Products',                 pctGFS: 0.025 },
  { key: 'cogs_ec_other',   label: 'Other Equipment & Consumables',  pctGFS: 0.003 },
  { key: 'cogs_maintenance',label: 'Onsite Other',                   pctGFS: 0.005 },
]
const TOTAL_SPEND_PCT = SPEND_CATEGORIES.reduce((s, c) => s + c.pctGFS, 0) // 4.9%

export default function OrderHub() {
  const { selectedLocation, setSelectedLocation } = useLocations()
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
  
  // Past orders
  const [pastOrders, setPastOrders] = useState([])
  const [orderGuide, setOrderGuide] = useState(null) // null = no guide (full catalog), [] = empty guide
  const [showGuideManager, setShowGuideManager] = useState(false)
  const [pastOrdersLoading, setPastOrdersLoading] = useState(false)
  const [showPast, setShowPast] = useState(false)

  // Budget data from Firestore
  const [weeklyBudget, setWeeklyBudget] = useState({ cogs: 3500, spent: 0 })

  // Vendor import modal
  const [showImportModal, setShowImportModal] = useState(false)
  const [whyPanelItem, setWhyPanelItem] = useState(null)
  const [receivingOrder, setReceivingOrder] = useState(null)

  // Cross-device cart sync — the cart state (qty, note, deliveryDate) is
  // persisted to tenants/{orgId}/orderDrafts/{userId}__{locationId} and
  // synced live via onSnapshot. Guards against infinite write-loops using
  // a ref to track whether the current state change came from a remote
  // snapshot vs a local edit.
  const [draftSyncStatus, setDraftSyncStatus] = useState('idle') // idle | saving | saved | error
  const skipNextWriteRef = useRef(false)
  // Bumped after each successful import — forces catalog reload
  const [importNonce, setImportNonce] = useState(0)

  // Master catalog + per-location inventory overrides merged into a single
  // shopping catalog. Replaces the previous hardcoded ITEMS const.
  const [items, setItems] = useState([])
  const [itemsLoading, setItemsLoading] = useState(true)

  // Vendors from the live tenants/{orgId}/vendors collection
  const { vendors: firestoreVendors } = useVendors()

  const location = selectedLocation === 'all' ? null : selectedLocation

  // Draft doc ID — depends on `location` which is declared above.
  // Uses Firebase Auth uid (from the Cognito bridge) since that's what
  // request.auth.uid will be in the Firestore security rules.
  const firebaseUid = auth?.currentUser?.uid || null
  const draftDocId = orgId && location && firebaseUid ? `${firebaseUid}__${location}` : null

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
        // Read GFS from all 4 weeks of the current period and sum
        const period = weekPeriod()
        const basePeriod = period.replace(/-W\d+$/, '')
        let combinedData = {}
        for (let w = 1; w <= 4; w++) {
          const wk = `${basePeriod}-W${w}`
          const wkRef = doc(db, 'tenants', orgId, 'pnl', location, 'periods', wk)
          const wkSnap = await getDoc(wkRef)
          if (wkSnap.exists()) {
            const wkData = wkSnap.data()
            for (const [k, v] of Object.entries(wkData)) {
              if (typeof v === 'number') {
                combinedData[k] = (combinedData[k] || 0) + v
              }
            }
          }
        }
        const data = combinedData
        if (Object.keys(data).length > 0) {
          const actualGFS = data.gfs_total || 0
          // Budget = % of actual GFS per category
          const catBudgets = {}
          let totalBudget = 0
          let totalSpent = 0
          for (const cat of SPEND_CATEGORIES) {
            const budget = Math.round(actualGFS * cat.pctGFS * 100) / 100
            const spent = data[cat.key] || 0
            catBudgets[cat.key] = { budget, spent, remaining: budget - spent, label: cat.label, pct: cat.pctGFS }
            totalBudget += budget
            totalSpent += spent
          }
          setWeeklyBudget({
            cogs: totalBudget,
            spent: totalSpent,
            gfs: actualGFS,
            categories: catBudgets,
          })
        }  // end if combinedData has data
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

  // ─── Cross-device cart sync ─────────────────────────────────────────────
  // Subscribe to the draft doc on the server. When it changes remotely,
  // update local state (skipping the next write to avoid an echo).
  useEffect(() => {
    if (!draftDocId || !orgId) return
    const ref = doc(db, 'tenants', orgId, 'orderDrafts', draftDocId)
    const unsub = onSnapshot(
      ref,
      (snap) => {
        if (!snap.exists()) return
        const remote = snap.data()
        // Only apply if the remote is newer than whatever we last saved locally
        skipNextWriteRef.current = true
        if (remote.qty !== undefined) setQty(remote.qty || {})
        if (remote.note !== undefined) setNote(remote.note || '')
        if (remote.deliveryDate !== undefined && remote.deliveryDate) {
          setDeliveryDate(remote.deliveryDate)
        }
      },
      (err) => {
        console.warn('Cart draft subscription error:', err)
      }
    )
    return unsub
  }, [orgId, draftDocId])

  // Debounced write to the draft doc whenever local cart state changes.
  useEffect(() => {
    if (!draftDocId || !orgId) return
    // Skip the write that was triggered by a remote snapshot update
    if (skipNextWriteRef.current) {
      skipNextWriteRef.current = false
      return
    }
    setDraftSyncStatus('saving')
    const timer = setTimeout(async () => {
      try {
        const ref = doc(db, 'tenants', orgId, 'orderDrafts', draftDocId)
        await setDoc(ref, {
          qty,
          note,
          deliveryDate,
          userId: firebaseUid,
          userEmail: user?.email || null,
          locationId: location,
          updatedAt: serverTimestamp(),
        }, { merge: true })
        setDraftSyncStatus('saved')
        // Clear saved status after 1.5s
        setTimeout(() => setDraftSyncStatus('idle'), 1500)
      } catch (e) {
        console.error('[DRAFT WRITE] FAILED', draftDocId, e.code, e.message)
        setDraftSyncStatus('error')
      }
    }, 800)
    return () => clearTimeout(timer)
  }, [qty, note, deliveryDate, orgId, draftDocId, user, location])

  // Get items based on vendor filter. vendorFilter holds a vendor id (slug).
  const visibleItems = useMemo(() => {
    if (vendorFilter === 'all') return items
    return items.filter(i => vendorSlug(i.vendor) === vendorFilter)
  }, [items, vendorFilter])

  // Apply order guide restriction — if a guide exists, only show guided items
  const guidedItems = useMemo(() => {
    if (!orderGuide) return visibleItems // no guide = full catalog
    const guideIds = new Set(orderGuide.map(g => g.id || g.sku || g.name))
    return visibleItems.filter(i => guideIds.has(i.id) || guideIds.has(i.sku) || guideIds.has(i.name))
  }, [visibleItems, orderGuide])


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
  const frequentItems = useMemo(() => {
    const freq = {}
    pastOrders.forEach(o => {
      (o.lineItems || []).forEach(li => {
        const id = li.id || li.sku || li.name
        if (!id) return
        if (!freq[id]) freq[id] = { id, name: li.name, vendor: li.vendor, count: 0, lastQty: li.qty || 1, sku: li.sku, unitCost: li.unitCost || 0, packSize: li.packSize }
        freq[id].count++
        freq[id].lastQty = li.qty || freq[id].lastQty
      })
    })
    return Object.values(freq).sort((a, b) => b.count - a.count).slice(0, 20)
  }, [pastOrders])

  const frequentIds = useMemo(() => new Set(frequentItems.map(f => f.id)), [frequentItems])
  const filtered = useMemo(() => guidedItems.filter(i => {
    if (cat === 'Frequent' && !frequentIds.has(i.id)) return false
    else if (cat !== 'All' && cat !== 'Frequent' && i.cat !== cat) return false
    if (filterBelowPar && i.onHand >= i.par) return false
    if (filterInCart && !qty[i.id]) return false
    if (search && !i.name.toLowerCase().includes(search.toLowerCase()) && !i.sku.toLowerCase().includes(search.toLowerCase())) return false
    return true
  }), [guidedItems, cat, filterBelowPar, filterInCart, search, qty, frequentIds])

  const grouped = useMemo(() => {
    const g = {}
    filtered.forEach(i => {
      if (!g[i.cat]) g[i.cat] = []
      g[i.cat].push(i)
    })
    return g
  }, [filtered])

  const belowParCnt = guidedItems.filter(i => i.onHand < i.par).length

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

  // Reorder from a past order: load its line items into the current cart.
  // Matches by item ID first, then falls back to SKU match if catalog has
  // changed since the original order was placed.
  const reorderFromPastOrder = useCallback((pastOrder) => {
    if (!pastOrder?.items?.length) {
      toast.warning('This order has no line items to reorder')
      return
    }

    const newQty = { ...qty }
    let matched = 0
    let missing = 0

    const normalize = (s) => (s || '').toString().trim().toLowerCase()

    for (const lineItem of pastOrder.items) {
      // First try ID match (exact)
      let catalogItem = items.find(i => i.id === lineItem.id)
      // Fall back to SKU match (normalized)
      if (!catalogItem && lineItem.sku) {
        const targetSku = normalize(lineItem.sku)
        catalogItem = items.find(i => normalize(i.sku) === targetSku)
      }
      // Fall back to normalized name match (trimmed, case-insensitive)
      if (!catalogItem && lineItem.name) {
        const targetName = normalize(lineItem.name)
        catalogItem = items.find(i => normalize(i.name) === targetName)
      }

      if (catalogItem) {
        newQty[catalogItem.id] = (newQty[catalogItem.id] || 0) + (lineItem.qty || 0)
        matched++
      } else {
        console.warn('[reorder] No match for:', { id: lineItem.id, sku: lineItem.sku, name: lineItem.name })
        missing++
      }
    }

    if (matched === 0) {
      toast.error('None of the items from this order are in the current catalog')
      return
    }

    setQty(newQty)
    setShowPast(false)  // close the past orders panel

    const msg = missing > 0
      ? `Loaded ${matched} items from ${pastOrder.orderNum}. ${missing} items no longer in catalog.`
      : `Loaded ${matched} items from ${pastOrder.orderNum}`
    toast.success(msg)
  }, [items, qty, toast])


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

  // Frequently ordered items — count how often each item appears in past orders

  // Load past orders on mount for kanban
  useEffect(() => {
    if (orgId) loadPastOrders()
    // Load order guide for this location
    if (orgId && location) {
      (async () => {
        try {
          const guideRef = doc(db, 'tenants', orgId, 'orderGuides', location)
          const guideSnap = await getDoc(guideRef)
          if (guideSnap.exists()) {
            setOrderGuide(guideSnap.data().items || [])
          } else {
            setOrderGuide(null) // no guide = full catalog
          }
        } catch { setOrderGuide(null) }
      })()
    }
  }, [orgId, loadPastOrders, location])

  // ─── Render ────────────────────────────────────────────────────────────────

  if (!selectedLocation || selectedLocation === 'all') return (
    <AllLocationsGrid
      title="Order Hub"
      subtitle="Select a location to place orders"
      onSelectLocation={name => setSelectedLocation(name)}
    />
  )

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
          <button 
            className={`${styles.viewBtn} ${view === 'guide' ? styles.viewActive : ''}`}
            onClick={() => setView('guide')}
          >
            <Package size={14}/> Guide
          </button>
        </div>

        {view === 'order' && (
          <>
            <div className={styles.toolGroup}>
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

        {view === 'guide' && (
          <div style={{ padding: 20 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <div>
                <h2 style={{ fontSize: 18, fontWeight: 600, margin: 0, color: '#0f172a' }}>Order Guide</h2>
                <p style={{ fontSize: 13, color: '#64748b', margin: '4px 0 0' }}>
                  {orderGuide ? `${orderGuide.length} approved items` : 'No guide set — full catalog available'}
                  {location ? ` · ${cleanLocName(location)}` : ''}
                </p>
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                {!orderGuide && (
                  <button onClick={() => {
                    // Create guide from current catalog
                    const guide = visibleItems.map(i => ({ id: i.id, sku: i.sku, name: i.name, vendor: i.vendor, cat: i.cat }))
                    setOrderGuide(guide)
                    setDoc(doc(db, 'tenants', orgId, 'orderGuides', location), { items: guide, updatedAt: serverTimestamp(), updatedBy: user?.name || user?.email }, { merge: true })
                    toast.success(`Order guide created with ${guide.length} items`)
                  }} style={{ padding: '8px 16px', fontSize: 13, fontWeight: 500, background: '#059669', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer' }}>
                    Create from catalog
                  </button>
                )}
                {orderGuide && (
                  <>
                    <button onClick={() => {
                      setOrderGuide(null)
                      setDoc(doc(db, 'tenants', orgId, 'orderGuides', location), { items: null, updatedAt: serverTimestamp() }, { merge: true })
                      toast.success('Order guide removed — full catalog available')
                    }} style={{ padding: '8px 16px', fontSize: 13, background: '#fff', color: '#dc2626', border: '1px solid #fecaca', borderRadius: 8, cursor: 'pointer' }}>
                      Remove guide
                    </button>
                  </>
                )}
              </div>
            </div>
            {orderGuide && (
              <div style={{ border: '1px solid #e2e8f0', borderRadius: 10, overflow: 'hidden' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                  <thead>
                    <tr style={{ background: '#f8fafc' }}>
                      <th style={{ textAlign: 'left', padding: '8px 12px', fontWeight: 600, fontSize: 11, color: '#475569', textTransform: 'uppercase' }}>Item</th>
                      <th style={{ textAlign: 'left', padding: '8px 12px', fontWeight: 600, fontSize: 11, color: '#475569', textTransform: 'uppercase' }}>Vendor</th>
                      <th style={{ textAlign: 'left', padding: '8px 12px', fontWeight: 600, fontSize: 11, color: '#475569', textTransform: 'uppercase' }}>Category</th>
                      <th style={{ textAlign: 'center', padding: '8px 12px', fontWeight: 600, fontSize: 11, color: '#475569', textTransform: 'uppercase' }}>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {orderGuide.map((item, idx) => (
                      <tr key={item.id || idx} style={{ borderTop: '1px solid #f1f5f9' }}>
                        <td style={{ padding: '8px 12px', fontWeight: 500 }}>{item.name}</td>
                        <td style={{ padding: '8px 12px', color: '#64748b' }}>{item.vendor || '—'}</td>
                        <td style={{ padding: '8px 12px', color: '#64748b' }}>{item.cat || '—'}</td>
                        <td style={{ padding: '8px 12px', textAlign: 'center' }}>
                          <button onClick={() => {
                            const updated = orderGuide.filter((_, i) => i !== idx)
                            setOrderGuide(updated)
                            setDoc(doc(db, 'tenants', orgId, 'orderGuides', location), { items: updated, updatedAt: serverTimestamp() }, { merge: true })
                          }} style={{ fontSize: 11, padding: '2px 8px', color: '#dc2626', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 4, cursor: 'pointer' }}>
                            Remove
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
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

      {/* Past Orders side drawer (Block D Phase 1 rebuild) */}
      {showPast && view === 'order' && (
        <>
          <div className={styles.pastDrawerBackdrop} onClick={() => setShowPast(false)}/>
          <div className={styles.pastDrawer}>
            <div className={styles.pastDrawerHeader}>
              <div>
                <div className={styles.pastDrawerLabel}>Past orders</div>
                <h2 className={styles.pastDrawerTitle}>
                  {pastOrders.length} {pastOrders.length === 1 ? 'order' : 'orders'}
                </h2>
              </div>
              <button className={styles.pastDrawerClose} onClick={() => setShowPast(false)}>
                <X size={18}/>
              </button>
            </div>
            <div className={styles.pastDrawerBody}>
              {pastOrdersLoading ? (
                <div className={styles.pastDrawerEmpty}>
                  <RefreshCw size={20} className={styles.spin}/>
                  <span>Loading orders…</span>
                </div>
              ) : pastOrders.length === 0 ? (
                <div className={styles.pastDrawerEmpty}>
                  <Package size={28}/>
                  <strong>No orders yet</strong>
                  <span>Orders you submit will appear here</span>
                </div>
              ) : (
                pastOrders.map(o => {
                  const statusConfig = STATUS_CONFIG[o.status] || {}
                  const StatusIcon = statusConfig.icon
                  const dateStr = o.createdAt?.toDate?.()?.toLocaleDateString?.('en-US', {
                    month: 'short', day: 'numeric', year: 'numeric'
                  }) || '—'
                  const canReceive = ['Submitted','Approved','Ordered','Receiving'].includes(o.status)
                  return (
                    <div key={o.id} className={styles.pastCard}>
                      <div className={styles.pastCardHeader}>
                        <div className={styles.pastCardOrderNum}>{o.orderNum}</div>
                        <div className={styles.pastCardStatus} style={{
                          background: statusConfig.bg,
                          color: statusConfig.color,
                        }}>
                          {StatusIcon && <StatusIcon size={11}/>}
                          {o.status}
                        </div>
                      </div>
                      <div className={styles.pastCardBody}>
                        <div className={styles.pastCardVendor}>{o.vendor}</div>
                        <div className={styles.pastCardMeta}>
                          {cleanLocName(o.location || '')} · {dateStr} · {o.items?.length || 0} lines
                        </div>
                      </div>
                      <div className={styles.pastCardFooter}>
                        <div className={styles.pastCardTotal}>${(o.total || 0).toFixed(2)}</div>
                        <div className={styles.pastCardActions}>
                          {canReceive && (
                            <button
                              className={styles.receiveBtn}
                              onClick={() => setReceivingOrder(o)}
                              title={`Record receiving for ${o.orderNum}`}
                            >
                              <Truck size={12}/> Receive
                            </button>
                          )}
                          <button
                            className={styles.reorderBtn}
                            onClick={() => reorderFromPastOrder(o)}
                            title={`Reorder ${o.items?.length || 0} items`}
                          >
                            <RefreshCw size={12}/> Reorder
                          </button>
                        </div>
                      </div>
                    </div>
                  )
                })
              )}
            </div>
          </div>
        </>
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
                const count = c === 'All' ? guidedItems.length : c === 'Frequent' ? frequentItems.length : guidedItems.filter(i => i.cat === c).length
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
                        <tr
                          key={item.id}
                          className={`${styles.row} ${q > 0 ? styles.rowOrdered : ''} ${styles.rowClickable}`}
                          onClick={(e) => {
                            // Don't trigger on button/input clicks (qty controls)
                            const tag = e.target.tagName
                            if (tag === 'BUTTON' || tag === 'INPUT' || e.target.closest('button') || e.target.closest('input')) return
                            setWhyPanelItem(item)
                          }}
                        >
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
              {draftDocId && draftSyncStatus !== 'idle' && (
                <span className={`${styles.syncStatus} ${styles['syncStatus_' + draftSyncStatus]}`}>
                  {draftSyncStatus === 'saving' && '○ Saving…'}
                  {draftSyncStatus === 'saved'  && '✓ Saved'}
                  {draftSyncStatus === 'error'  && '⚠ Sync error'}
                </span>
              )}
</div>

            {/* Budget burndown — always visible, live-updating as cart changes */}
            {location && (() => {
              const budget = weeklyBudget.cogs
              const spent = weeklyBudget.spent
              const inCart = cartTotal
              const committed = spent
              const projected = committed + inCart
              const remaining = budget - projected
              const percentUsed = budget > 0 ? (projected / budget) * 100 : 0
              const percentCommitted = budget > 0 ? (committed / budget) * 100 : 0

              let status = 'safe'
              if (projected > budget) status = 'over'
              else if (projected > budget * 0.85) status = 'caution'

              const statusColors = {
                safe:    { bar: '#10b981', text: '#065f46', bg: '#f0fdf4', border: '#a7f3d0' },
                caution: { bar: '#f59e0b', text: '#92400e', bg: '#fffbeb', border: '#fde68a' },
                over:    { bar: '#dc2626', text: '#991b1b', bg: '#fef2f2', border: '#fecaca' },
              }
              const c = statusColors[status]

              return (
                <div className={styles.budgetLive} style={{ background: c.bg, borderColor: c.border }}>
                  <div className={styles.budgetLiveHeader}>
                    <div className={styles.budgetLiveLabel}>
                      <TrendingUp size={12}/> Weekly budget
                    </div>
                    <div className={styles.budgetLiveRemaining} style={{ color: c.text }}>
                      ${Math.abs(remaining).toFixed(0)} {remaining < 0 ? 'over' : 'left'}
                    </div>
                  </div>
                  <div className={styles.budgetLiveBar}>
                    <div className={styles.budgetLiveBarCommitted} style={{ width: `${Math.min(100, percentCommitted)}%` }}/>
                    {inCart > 0 && (
                      <div
                        className={styles.budgetLiveBarCart}
                        style={{
                          left: `${Math.min(100, percentCommitted)}%`,
                          width: `${Math.min(100 - percentCommitted, (inCart / budget) * 100)}%`,
                          background: c.bar,
                        }}
                      />
                    )}
                    {percentUsed > 100 && (
                      <div className={styles.budgetLiveBarOver} style={{ background: c.bar }}/>
                    )}
                  </div>
                  <div className={styles.budgetLiveStats}>
                    <span>${spent.toFixed(0)} spent</span>
                    {inCart > 0 && <span style={{ color: c.text, fontWeight: 600 }}>+ ${inCart.toFixed(0)} cart</span>}
                    <span>of ${budget.toFixed(0)} ({weeklyBudget.gfs ? (TOTAL_SPEND_PCT * 100).toFixed(1) + '% of $' + weeklyBudget.gfs.toLocaleString() + ' GFS' : ''})</span>
                  </div>
                  {weeklyBudget.categories && (
                    <div style={{ marginTop: 8, fontSize: 11, display: 'grid', gridTemplateColumns: '1fr auto auto auto', gap: '3px 10px', color: '#64748b' }}>
                      {SPEND_CATEGORIES.map(cat => {
                        const cd = weeklyBudget.categories[cat.key] || {}
                        const pctUsed = cd.budget > 0 ? cd.spent / cd.budget : 0
                        return [
                          <span key={cat.key+'l'} style={{ fontWeight: 500 }}>{cat.label}</span>,
                          <span key={cat.key+'s'} style={{ textAlign: 'right', fontFamily: 'ui-monospace, monospace' }}>${(cd.spent||0).toFixed(0)}</span>,
                          <span key={cat.key+'b'} style={{ textAlign: 'right', color: '#94a3b8' }}>/ ${(cd.budget||0).toFixed(0)}</span>,
                          <span key={cat.key+'r'} style={{ textAlign: 'right', fontWeight: 600, color: pctUsed > 1 ? '#dc2626' : pctUsed > 0.85 ? '#d97706' : '#059669' }}>
                            ${Math.abs(cd.remaining||0).toFixed(0)} {(cd.remaining||0) < 0 ? 'over' : 'left'}
                          </span>,
                        ]
                      })}
                    </div>
                  )}
                  {status === 'caution' && (
                    <div className={styles.budgetLiveWarn} style={{ color: c.text }}>
                      <AlertTriangle size={11}/> Approaching weekly limit
                    </div>
                  )}
                  {status === 'over' && (
                    <div className={styles.budgetLiveWarn} style={{ color: c.text }}>
                      <AlertTriangle size={11}/> This cart would exceed weekly budget by ${Math.abs(remaining).toFixed(0)}
                    </div>
                  )}
                </div>
              )
            })()}

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
              {/* Approval routing preview — shows the user BEFORE submit what level
                  of approval this cart will need, not after. */}
              {cartLines > 0 && (() => {
                // Highest tier wins if any single vendor sub-total crosses a threshold
                let needsDirector = false
                let needsManager = false
                for (const items of Object.values(cartByVendor)) {
                  const subtotal = items.reduce((s, i) => s + i.qty * i.unitCost, 0)
                  if (subtotal > APPROVAL_THRESHOLDS.DIRECTOR_REQUIRED) needsDirector = true
                  else if (subtotal > APPROVAL_THRESHOLDS.AUTO_APPROVE) needsManager = true
                }
                if (needsDirector) {
                  return (
                    <div className={styles.approvalPill} style={{
                      background: '#fef2f2', borderColor: '#fecaca', color: '#991b1b',
                    }}>
                      <AlertTriangle size={12}/>
                      <span><strong>Director approval required.</strong> Any single vendor order over ${APPROVAL_THRESHOLDS.DIRECTOR_REQUIRED.toLocaleString()} needs director sign-off before it submits to the vendor.</span>
                    </div>
                  )
                }
                if (needsManager) {
                  return (
                    <div className={styles.approvalPill} style={{
                      background: '#fffbeb', borderColor: '#fde68a', color: '#92400e',
                    }}>
                      <AlertTriangle size={12}/>
                      <span><strong>Manager approval required.</strong> Vendor orders over ${APPROVAL_THRESHOLDS.AUTO_APPROVE} route to a manager queue before vendor submission.</span>
                    </div>
                  )
                }
                return (
                  <div className={styles.approvalPill} style={{
                    background: '#f0fdf4', borderColor: '#a7f3d0', color: '#065f46',
                  }}>
                    <CheckCircle size={12}/>
                    <span><strong>Auto-approved.</strong> Orders under ${APPROVAL_THRESHOLDS.AUTO_APPROVE} per vendor submit directly.</span>
                  </div>
                )
              })()}

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
                      : (() => {
                          // Dynamic label based on approval requirements
                          let needsApproval = false
                          for (const items of Object.values(cartByVendor)) {
                            const subtotal = items.reduce((s, i) => s + i.qty * i.unitCost, 0)
                            if (subtotal > APPROVAL_THRESHOLDS.AUTO_APPROVE) { needsApproval = true; break }
                          }
                          if (needsApproval) return 'Request Approval'
                          return vendorCount > 1 ? `Submit ${vendorCount} Orders` : 'Submit Order'
                        })()
                  }
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Receiving modal */}
      {receivingOrder && (
        <ReceivingModal
          order={receivingOrder}
          orgId={orgId}
          user={user}
          toast={toast}
          onClose={() => setReceivingOrder(null)}
          onSuccess={() => {
            setReceivingOrder(null)
            loadPastOrders()  // refresh past orders so status updates
          }}
        />
      )}

      {/* Item why panel */}
      {whyPanelItem && (
        <OrderItemWhyPanel
          item={whyPanelItem}
          qty={qty}
          items={items}
          pastOrders={pastOrders}
          onClose={() => setWhyPanelItem(null)}
        />
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