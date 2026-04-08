import { useState, useEffect, useCallback, useMemo } from 'react'
import { doc, getDoc, setDoc, collection, query, where, getDocs, serverTimestamp } from 'firebase/firestore'
import { db } from '@/lib/firebase'

// ═══════════════════════════════════════════════════════════════════════════
// useInventory - Core inventory management hook for Aurelia FMS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Compute prior period key from current
 * Format: YYYY-P##-W#
 */
function getPriorKey(key) {
  const parts = key?.match(/(\d+)-P(\d+)-W(\d+)/)
  if (!parts) return null
  let [, yr, p, w] = parts.map(Number)
  if (w > 1) return `${yr}-P${String(p).padStart(2, '0')}-W${w - 1}`
  if (p > 1) return `${yr}-P${String(p - 1).padStart(2, '0')}-W4`
  return `${yr - 1}-P12-W4`
}

/**
 * Sanitize location ID for Firestore document paths
 */
export const sanitizeDocId = (str) => str?.replace(/[^a-zA-Z0-9]/g, '_') || ''

/**
 * Format currency
 */
export const fmt$ = (v) => '$' + Number(v || 0).toLocaleString('en-US', { 
  minimumFractionDigits: 2, 
  maximumFractionDigits: 2 
})

/**
 * Variance classification for heatmap
 */
function getVarianceClass(curr, prior) {
  if (curr == null || !prior || prior === 0) return 'neutral'
  const pct = Math.abs((curr - prior) / prior)
  if (pct <= 0.10) return 'good'
  if (pct <= 0.25) return 'warn'
  return 'alert'
}

/**
 * Calculate days on hand based on average daily usage
 */
function calcDaysOnHand(qty, avgDailyUsage) {
  if (!avgDailyUsage || avgDailyUsage <= 0) return null
  return Math.round((qty / avgDailyUsage) * 10) / 10
}

// ═══════════════════════════════════════════════════════════════════════════
// Main Hook
// ═══════════════════════════════════════════════════════════════════════════

export function useInventory(orgId, locationId, periodKey, user) {
  // ─── State ─────────────────────────────────────────────────────────────────
  const [items, setItems] = useState([])
  const [priorItems, setPriorItems] = useState([])
  const [openingValue, setOpeningValue] = useState(0)
  const [purchases, setPurchases] = useState(0)
  const [categories, setCategories] = useState([])
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [session, setSession] = useState(null)
  const [error, setError] = useState(null)

  const priorKey = getPriorKey(periodKey)
  const locId = sanitizeDocId(locationId)

  // ─── Load All Data (Batched) ───────────────────────────────────────────────
  const load = useCallback(async () => {
    if (!locationId || !periodKey || !orgId) {
      setItems([])
      setPriorItems([])
      setOpeningValue(0)
      setPurchases(0)
      return
    }

    setLoading(true)
    setError(null)

    try {
      // Batch all reads with Promise.all for speed
      const [
        inventorySnap,
        priorInventorySnap,
        priorPnlSnap,
        currentPnlSnap,
        settingsSnap,
        sessionSnap
      ] = await Promise.all([
        // Current period inventory
        getDocs(collection(db, 'tenants', orgId, 'inventory', locId, 'items')),
        // Prior period inventory (for variance)
        priorKey ? getDocs(collection(db, 'tenants', orgId, 'inventory', locId, 'items')) : Promise.resolve(null),
        // Prior period P&L (for opening value)
        priorKey ? getDoc(doc(db, 'tenants', orgId, 'pnl', locId, 'periods', priorKey)) : Promise.resolve(null),
        // Current period P&L (for purchases)
        getDoc(doc(db, 'tenants', orgId, 'pnl', locId, 'periods', periodKey)),
        // Tenant settings (for categories)
        getDoc(doc(db, 'tenants', orgId, 'settings', 'inventory')),
        // Active count session
        getDoc(doc(db, 'tenants', orgId, 'inventorySessions', `${locId}_${periodKey}`))
      ])

      // Process inventory items
      const inventoryItems = []
      inventorySnap.forEach(doc => {
        inventoryItems.push({ id: doc.id, ...doc.data() })
      })
      setItems(inventoryItems)

      // Process prior items
      const priorItemsData = []
      if (priorInventorySnap) {
        priorInventorySnap.forEach(doc => {
          priorItemsData.push({ id: doc.id, ...doc.data() })
        })
      }
      setPriorItems(priorItemsData)

      // Opening value from prior period closing
      if (priorPnlSnap?.exists()) {
        setOpeningValue(priorPnlSnap.data().closingValue || 0)
      } else {
        setOpeningValue(0)
      }

      // Current period purchases
      if (currentPnlSnap?.exists()) {
        setPurchases(currentPnlSnap.data().cogs_purchases || 0)
      } else {
        setPurchases(0)
      }

      // Load categories from settings or use defaults
      if (settingsSnap?.exists() && settingsSnap.data().categories?.length) {
        setCategories(settingsSnap.data().categories)
      } else {
        setCategories(getDefaultCategories())
      }

      // Load or create session
      if (sessionSnap?.exists()) {
        setSession(sessionSnap.data())
      } else {
        // Create new session
        const newSession = {
          startedAt: serverTimestamp(),
          startedBy: user?.email || 'unknown',
          startedByName: user?.name || user?.email || 'Unknown',
          status: 'in_progress',
          sectionsCompleted: [],
          counters: [{
            uid: user?.uid || 'unknown',
            name: user?.name || user?.email || 'Unknown',
            itemsCounted: 0,
            startedAt: new Date().toISOString()
          }]
        }
        setSession(newSession)
        // Persist new session
        await setDoc(
          doc(db, 'tenants', orgId, 'inventorySessions', `${locId}_${periodKey}`),
          newSession
        )
      }

      setDirty(false)
    } catch (err) {
      console.error('Failed to load inventory:', err)
      setError('Failed to load inventory data')
    } finally {
      setLoading(false)
    }
  }, [orgId, locationId, locId, periodKey, priorKey, user])

  // ─── Auto-load on mount and when dependencies change ──────────────────────
  useEffect(() => {
    load()
  }, [load])

  // ─── Adjust quantity by delta ──────────────────────────────────────────────
  const adjust = useCallback((itemId, delta) => {
    setItems(prev => prev.map(item => {
      if (item.id !== itemId) return item
      const next = Math.max(0, parseFloat(((item.qty || 0) + delta).toFixed(2)))
      return { ...item, qty: next, lastCountedAt: new Date().toISOString(), lastCountedBy: user?.email }
    }))
    setDirty(true)
  }, [user])

  // ─── Set quantity directly ─────────────────────────────────────────────────
  const setQty = useCallback((itemId, value) => {
    setItems(prev => prev.map(item => {
      if (item.id !== itemId) return item
      const qty = value === '' ? null : Math.max(0, parseFloat(value) || 0)
      return { ...item, qty, lastCountedAt: new Date().toISOString(), lastCountedBy: user?.email }
    }))
    setDirty(true)
  }, [user])

  // ─── Copy prior count ──────────────────────────────────────────────────────
  const copyPrior = useCallback((itemId) => {
    const priorItem = priorItems.find(p => p.id === itemId)
    if (priorItem?.qty != null) {
      setQty(itemId, priorItem.qty)
    }
  }, [priorItems, setQty])

  // ─── Mark section complete ─────────────────────────────────────────────────
  const markSectionComplete = useCallback(async (sectionKey) => {
    if (!session) return
    
    const updatedSections = session.sectionsCompleted.includes(sectionKey)
      ? session.sectionsCompleted
      : [...session.sectionsCompleted, sectionKey]
    
    const updatedSession = { ...session, sectionsCompleted: updatedSections }
    setSession(updatedSession)

    // Persist to Firestore
    try {
      await setDoc(
        doc(db, 'tenants', orgId, 'inventorySessions', `${locId}_${periodKey}`),
        updatedSession,
        { merge: true }
      )
    } catch (err) {
      console.error('Failed to update session:', err)
    }
  }, [session, orgId, locId, periodKey])

  // ─── Save inventory and post to P&L ────────────────────────────────────────
  const save = useCallback(async () => {
    if (!locationId || !periodKey) return false

    setSaving(true)
    setError(null)

    try {
      // Save each item
      const batch = []
      for (const item of items) {
        batch.push(
          setDoc(
            doc(db, 'tenants', orgId, 'inventory', locId, 'items', item.id),
            {
              ...item,
              updatedAt: serverTimestamp(),
              updatedBy: user?.email
            },
            { merge: true }
          )
        )
      }
      await Promise.all(batch)

      // Calculate closing value
      const closingValue = items.reduce((sum, item) => {
        return sum + ((item.qty || 0) * (item.unitCost || 0))
      }, 0)

      // Calculate COGS
      const cogs = Math.max(0, openingValue + purchases - closingValue)

      // Write to P&L
      await setDoc(
        doc(db, 'tenants', orgId, 'pnl', locId, 'periods', periodKey),
        {
          closingValue,
          openingValue,
          cogs_inventory: cogs,
          inventoryCountedAt: serverTimestamp(),
          inventoryCountedBy: user?.email
        },
        { merge: true }
      )

      // Update session status
      if (session) {
        await setDoc(
          doc(db, 'tenants', orgId, 'inventorySessions', `${locId}_${periodKey}`),
          {
            ...session,
            status: 'completed',
            completedAt: serverTimestamp(),
            completedBy: user?.email
          },
          { merge: true }
        )
      }

      setDirty(false)
      return true
    } catch (err) {
      console.error('Failed to save inventory:', err)
      setError('Failed to save inventory')
      return false
    } finally {
      setSaving(false)
    }
  }, [items, locationId, locId, periodKey, orgId, openingValue, purchases, user, session])

  // ─── Computed: Items with variance and category data ───────────────────────
  const itemsWithMeta = useMemo(() => {
    return items.map(item => {
      const prior = priorItems.find(p => p.id === item.id)
      const priorQty = prior?.qty || 0
      const variance = (item.qty || 0) - priorQty
      const varClass = getVarianceClass(item.qty, priorQty)
      const cat = assignCategory(item, categories)
      const daysOnHand = calcDaysOnHand(item.qty, item.avgDailyUsage)
      const belowPar = item.parLevel && item.qty != null && item.qty < item.parLevel
      const atReorder = item.reorderPoint && item.qty != null && item.qty <= item.reorderPoint

      return {
        ...item,
        _cat: cat,
        _priorQty: priorQty,
        _variance: variance,
        _varClass: varClass,
        _daysOnHand: daysOnHand,
        _belowPar: belowPar,
        _atReorder: atReorder,
        _value: (item.qty || 0) * (item.unitCost || 0)
      }
    })
  }, [items, priorItems, categories])

  // ─── Computed: Category counts and values ──────────────────────────────────
  const catStats = useMemo(() => {
    const stats = {}
    categories.forEach(cat => {
      const catItems = itemsWithMeta.filter(i => i._cat === cat.key)
      stats[cat.key] = {
        total: catItems.length,
        counted: catItems.filter(i => i.qty != null && i.qty > 0).length,
        value: catItems.reduce((sum, i) => sum + i._value, 0)
      }
    })
    return stats
  }, [itemsWithMeta, categories])

  // ─── Computed: Totals ──────────────────────────────────────────────────────
  const totals = useMemo(() => {
    const closingValue = itemsWithMeta.reduce((sum, i) => sum + i._value, 0)
    const counted = itemsWithMeta.filter(i => i.qty != null && i.qty > 0).length
    const liveCOGS = Math.max(0, openingValue + purchases - closingValue)
    const belowPar = itemsWithMeta.filter(i => i._belowPar).length
    const atReorder = itemsWithMeta.filter(i => i._atReorder).length

    return {
      closingValue,
      openingValue,
      purchases,
      liveCOGS,
      counted,
      total: items.length,
      progress: items.length ? Math.round((counted / items.length) * 100) : 0,
      belowPar,
      atReorder,
      wellStocked: items.length - belowPar - atReorder
    }
  }, [itemsWithMeta, openingValue, purchases, items.length])

  // ─── Computed: Variance alerts (top issues) ────────────────────────────────
  const varianceAlerts = useMemo(() => {
    return itemsWithMeta
      .filter(i => i._varClass === 'alert' || i._varClass === 'warn')
      .sort((a, b) => Math.abs(b._variance * b.unitCost) - Math.abs(a._variance * a.unitCost))
      .slice(0, 5)
  }, [itemsWithMeta])

  // ─── Computed: Items below par ─────────────────────────────────────────────
  const itemsBelowPar = useMemo(() => {
    return itemsWithMeta
      .filter(i => i._belowPar || i._atReorder)
      .sort((a, b) => (a._daysOnHand || 999) - (b._daysOnHand || 999))
  }, [itemsWithMeta])

  // ─── Return ────────────────────────────────────────────────────────────────
  return {
    // Data
    items: itemsWithMeta,
    categories,
    catStats,
    totals,
    varianceAlerts,
    itemsBelowPar,
    session,
    
    // State
    loading,
    saving,
    dirty,
    error,

    // Actions
    load,
    adjust,
    setQty,
    copyPrior,
    markSectionComplete,
    save
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Helper: Assign category to item
// ═══════════════════════════════════════════════════════════════════════════

function assignCategory(item, categories) {
  for (const cat of categories) {
    if (cat.rx && new RegExp(cat.rx, 'i').test(item.name || '')) {
      return cat.key
    }
    if (cat.keywords?.some(kw => (item.name || '').toLowerCase().includes(kw.toLowerCase()))) {
      return cat.key
    }
  }
  return 'general'
}

// ═══════════════════════════════════════════════════════════════════════════
// Default Categories (fallback if tenant hasn't configured)
// ═══════════════════════════════════════════════════════════════════════════

function getDefaultCategories() {
  return [
    { 
      key: 'beverages', 
      label: 'Beverages', 
      color: '#1e40af', 
      bg: '#dbeafe',
      keywords: ['red bull', 'celsius', 'coke', 'sprite', 'juice', 'water', 'tea', 'coffee', 'lemonade', 'gatorade']
    },
    { 
      key: 'bar_items', 
      label: 'Bar / Barista', 
      color: '#7c3aed', 
      bg: '#ede9fe',
      keywords: ['espresso', 'syrup', 'chai', 'matcha', 'cold brew', 'latte']
    },
    { 
      key: 'pantry', 
      label: 'Pantry / Snacks', 
      color: '#92400e', 
      bg: '#fef3c7',
      keywords: ['chip', 'bar', 'snack', 'cookie', 'candy', 'nuts', 'pretzel', 'popcorn']
    },
    { 
      key: 'dairy', 
      label: 'Dairy', 
      color: '#0369a1', 
      bg: '#e0f2fe',
      keywords: ['milk', 'cream', 'yogurt', 'cheese', 'butter']
    },
    { 
      key: 'frozen', 
      label: 'Frozen', 
      color: '#1d4ed8', 
      bg: '#dbeafe',
      keywords: ['ice cream', 'frozen', 'popsicle']
    },
    { 
      key: 'proteins', 
      label: 'Proteins', 
      color: '#b91c1c', 
      bg: '#fee2e2',
      keywords: ['chicken', 'beef', 'steak', 'salmon', 'fish', 'pork', 'turkey', 'shrimp']
    },
    { 
      key: 'produce', 
      label: 'Produce', 
      color: '#15803d', 
      bg: '#dcfce7',
      keywords: ['lettuce', 'tomato', 'onion', 'pepper', 'carrot', 'fruit', 'apple', 'banana']
    },
    { 
      key: 'general', 
      label: 'General', 
      color: '#374151', 
      bg: '#f3f4f6',
      keywords: []
    }
  ]
}

export default useInventory