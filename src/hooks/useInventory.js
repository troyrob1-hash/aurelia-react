import { useState, useEffect, useCallback, useMemo } from 'react'
import { doc, getDoc, setDoc, collection, getDocs, serverTimestamp } from 'firebase/firestore'
import { db } from '@/lib/firebase'
import { getPriorKey as getPriorKeyLib, locId as locIdLib } from '@/lib/pnl'

// getPriorKey + sanitizeDocId moved to @/lib/pnl as the canonical source.
// Re-exported here so existing call sites (Inventory.jsx imports sanitizeDocId
// from this module) keep working without churn.
const getPriorKey = getPriorKeyLib
export const sanitizeDocId = locIdLib

export const fmt$ = (v) => '$' + Number(v || 0).toLocaleString('en-US', { 
  minimumFractionDigits: 2, 
  maximumFractionDigits: 2 
})

function getVarianceClass(curr, prior) {
  if (curr == null || !prior || prior === 0) return 'neutral'
  const pct = Math.abs((curr - prior) / prior)
  if (pct <= 0.10) return 'good'
  if (pct <= 0.25) return 'warn'
  return 'alert'
}

function calcDaysOnHand(qty, avgDailyUsage) {
  if (!avgDailyUsage || avgDailyUsage <= 0) return null
  return Math.round((qty / avgDailyUsage) * 10) / 10
}

export function useInventory(orgId, locationId, periodKey, user) {
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
  // Buddy mode: dual attribution for team counts. Counts taken in buddy mode
  // get both names persisted to lastCountedBy + counterNames.
  const [buddyMode, setBuddyMode] = useState(false)
  const [buddyNames, setBuddyNames] = useState({ caller: '', marker: '' })

  const priorKey = getPriorKey(periodKey)
  const locId = sanitizeDocId(locationId)

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
      const [
        masterItemsSnap,
        locationItemsSnap,
        priorPnlSnap,
        currentPnlSnap,
        settingsSnap,
        sessionSnap
      ] = await Promise.all([
        getDoc(doc(db, 'aurelia', 'inv_items')),
        getDocs(collection(db, 'tenants', orgId, 'inventory', locId, 'items')),
        priorKey ? getDoc(doc(db, 'tenants', orgId, 'pnl', locId, 'periods', priorKey)) : Promise.resolve(null),
        getDoc(doc(db, 'tenants', orgId, 'pnl', locId, 'periods', periodKey)),
        getDoc(doc(db, 'tenants', orgId, 'settings', 'inventory')),
        getDoc(doc(db, 'tenants', orgId, 'inventorySessions', `${locId}_${periodKey}`))
      ])

      // FIXED: Handle both string and array formats for masterItems
      let masterItems = []
      if (masterItemsSnap?.exists()) {
        const data = masterItemsSnap.data()
        let rawValue = data.value
        if (typeof rawValue === 'string') {
          try { rawValue = JSON.parse(rawValue) } catch(e) { rawValue = [] }
        }
        masterItems = Array.isArray(rawValue) ? rawValue : []
        console.log('masterItems loaded:', masterItems.length)
      }

      const locationOverrides = {}
      locationItemsSnap.forEach(d => {
        locationOverrides[d.id] = d.data()
      })

      const inventoryItems = masterItems
        .filter(item => {
          const override = locationOverrides[String(item.id)]
          return !override?.removed
        })
        .map(item => {
          const override = locationOverrides[String(item.id)] || {}
          return {
            id: String(item.id),
            name: item.name,
            unitCost: item.unitCost || 0,
            packSize: item.packSize,
            qtyPerPack: item.qtyPerPack,
            packPrice: item.packPrice,
            vendor: item.vendor,
            glCode: item.glCode,
            sellingPrice: item.sellingPrice,
            itemType: item.itemType,
            qty: override.qty ?? null,
            parLevel: override.parLevel,
            reorderPoint: override.reorderPoint,
            avgDailyUsage: override.avgDailyUsage,
            lastCountedAt: override.lastCountedAt,
            lastCountedBy: override.lastCountedBy,
            isKey: override.isKey || false,
          }
        })

      // Pick up custom items — overrides that aren't tied to a master item.
      // These have id starting with 'custom_' and the data is fully self-contained.
      const customItems = []
      locationItemsSnap.forEach(d => {
        const data = d.data()
        if (data.custom && !data.removed) {
          customItems.push({
            id: d.id,
            name: data.name || 'Untitled item',
            unitCost: data.unitCost || 0,
            packSize: data.packSize || null,
            vendor: data.vendor || null,
            qty: data.qty ?? null,
            parLevel: data.parLevel || null,
            reorderPoint: data.reorderPoint || null,
            avgDailyUsage: data.avgDailyUsage || null,
            lastCountedAt: data.lastCountedAt || null,
            lastCountedBy: data.lastCountedBy || null,
            isKey: data.isKey || false,
            custom: true,
          })
        }
      })

      setItems([...inventoryItems, ...customItems])

      // Load prior period items from Path B snapshot for variance + copyPrior.
      // Best-effort: if no prior snapshot exists, priorItems stays empty.
      try {
        if (priorKey) {
          const priorSnapRef = doc(db, 'tenants', orgId, 'locations', locId, 'inventory', priorKey)
          const priorSnap = await getDoc(priorSnapRef)
          if (priorSnap.exists()) {
            const priorData = priorSnap.data()
            setPriorItems(Array.isArray(priorData.items) ? priorData.items : [])
          } else {
            setPriorItems([])
          }
        } else {
          setPriorItems([])
        }
      } catch (e) {
        console.warn('Failed to load prior period items:', e)
        setPriorItems([])
      }

      if (priorPnlSnap?.exists()) {
        setOpeningValue(priorPnlSnap.data().closingValue || 0)
      } else {
        setOpeningValue(0)
      }

      if (currentPnlSnap?.exists()) {
        setPurchases(currentPnlSnap.data().cogs_purchases || 0)
      } else {
        setPurchases(0)
      }

      if (settingsSnap?.exists() && settingsSnap.data().categories?.length) {
        setCategories(settingsSnap.data().categories)
      } else {
        setCategories(getDefaultCategories())
      }

      if (sessionSnap?.exists()) {
        setSession(sessionSnap.data())
      } else {
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

  useEffect(() => {
    load()
  }, [load])

  const adjust = useCallback((itemId, delta) => {
    setItems(prev => prev.map(item => {
      if (item.id !== itemId) return item
      const next = Math.max(0, parseFloat(((item.qty || 0) + delta).toFixed(2)))
      const attribution = buddyMode && buddyNames.caller && buddyNames.marker
        ? `${buddyNames.caller} + ${buddyNames.marker}`
        : (user?.email || 'unknown')
      return {
        ...item,
        qty: next,
        lastCountedAt: new Date().toISOString(),
        lastCountedBy: attribution,
        countedInBuddyMode: buddyMode,
      }
    }))
    setDirty(true)
  }, [user, buddyMode, buddyNames])

  const setQty = useCallback((itemId, value) => {
    setItems(prev => prev.map(item => {
      if (item.id !== itemId) return item
      const qty = value === '' ? null : Math.max(0, parseFloat(value) || 0)
      const attribution = buddyMode && buddyNames.caller && buddyNames.marker
        ? `${buddyNames.caller} + ${buddyNames.marker}`
        : (user?.email || 'unknown')
      return {
        ...item,
        qty,
        lastCountedAt: new Date().toISOString(),
        lastCountedBy: attribution,
        countedInBuddyMode: buddyMode,
      }
    }))
    setDirty(true)
  }, [user, buddyMode, buddyNames])

  const copyPrior = useCallback((itemId) => {
    const priorItem = priorItems.find(p => p.id === itemId)
    if (priorItem?.qty != null) {
      setQty(itemId, priorItem.qty)
    }
  }, [priorItems, setQty])

  // Toggle whether an item is marked as "key" — surfaces in Quick count mode.
  // Persists immediately so the flag survives a reload even if the user
  // hasn't clicked Save yet.
  const toggleKey = useCallback(async (itemId) => {
    const target = items.find(i => i.id === itemId)
    if (!target) return
    const nextValue = !target.isKey
    // Optimistic local update
    setItems(prev => prev.map(i => i.id === itemId ? { ...i, isKey: nextValue } : i))
    // Persist immediately to the per-item override doc
    try {
      await setDoc(
        doc(db, 'tenants', orgId, 'inventory', locId, 'items', itemId),
        { isKey: nextValue, updatedAt: serverTimestamp() },
        { merge: true }
      )
    } catch (e) {
      console.error('Failed to toggle isKey:', e)
      // Revert on failure
      setItems(prev => prev.map(i => i.id === itemId ? { ...i, isKey: !nextValue } : i))
    }
  }, [items, orgId, locId])

  // Hide an item from this location. For master items this sets removed: true
  // on the override doc. For custom items it also sets removed: true (we don't
  // hard-delete, so it can be restored).
  const removeItem = useCallback(async (itemId) => {
    const target = items.find(i => i.id === itemId)
    if (!target) return
    // Optimistic: remove from local state immediately
    setItems(prev => prev.filter(i => i.id !== itemId))
    try {
      await setDoc(
        doc(db, 'tenants', orgId, 'inventory', locId, 'items', itemId),
        {
          removed:   true,
          removedAt: serverTimestamp(),
          removedBy: user?.email || 'unknown',
          // For custom items, preserve the data fields so we can restore
          ...(target.custom ? {
            custom:   true,
            name:     target.name,
            unitCost: target.unitCost,
            packSize: target.packSize,
            vendor:   target.vendor,
          } : {}),
        },
        { merge: true }
      )
    } catch (e) {
      console.error('Failed to remove item:', e)
      setItems(prev => [...prev, target])  // revert
    }
  }, [items, orgId, locId, user])

  // Restore a previously removed item.
  const restoreItem = useCallback(async (itemId) => {
    try {
      await setDoc(
        doc(db, 'tenants', orgId, 'inventory', locId, 'items', itemId),
        {
          removed:    false,
          restoredAt: serverTimestamp(),
          restoredBy: user?.email || 'unknown',
        },
        { merge: true }
      )
      // Reload to pick up the restored item from master + overrides
      await load()
    } catch (e) {
      console.error('Failed to restore item:', e)
    }
  }, [orgId, locId, user, load])

  // Add a custom item that exists only at this location.
  const addCustomItem = useCallback(async (data) => {
    if (!data.name) return
    const customId = `custom_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
    const newItem = {
      name:     data.name,
      unitCost: parseFloat(data.unitCost) || 0,
      packSize: data.packSize || null,
      vendor:   data.vendor || null,
      custom:   true,
      removed:  false,
      createdAt: serverTimestamp(),
      createdBy: user?.email || 'unknown',
    }
    try {
      await setDoc(
        doc(db, 'tenants', orgId, 'inventory', locId, 'items', customId),
        newItem
      )
      // Optimistic local insert
      setItems(prev => [...prev, {
        id: customId,
        ...newItem,
        qty: null,
        isKey: false,
      }])
    } catch (e) {
      console.error('Failed to add custom item:', e)
    }
  }, [orgId, locId, user])

  // List of removed items for the manage drawer. We need to query the
  // override collection separately because removed items are filtered out
  // of the main items list during load.
  const [removedItems, setRemovedItems] = useState([])
  const loadRemovedItems = useCallback(async () => {
    if (!orgId || !locId) return
    try {
      const snap = await getDocs(collection(db, 'tenants', orgId, 'inventory', locId, 'items'))
      const removed = []
      snap.forEach(d => {
        const data = d.data()
        if (data.removed) {
          removed.push({
            id:       d.id,
            name:     data.name || (data.custom ? 'Untitled custom item' : `Master item ${d.id}`),
            vendor:   data.vendor || null,
            custom:   data.custom || false,
            removedAt: data.removedAt || null,
          })
        }
      })
      setRemovedItems(removed)
    } catch (e) {
      console.error('Failed to load removed items:', e)
    }
  }, [orgId, locId])

  const markSectionComplete = useCallback(async (sectionKey) => {
    if (!session) return
    
    const updatedSections = session.sectionsCompleted.includes(sectionKey)
      ? session.sectionsCompleted
      : [...session.sectionsCompleted, sectionKey]
    
    const updatedSession = { ...session, sectionsCompleted: updatedSections }
    setSession(updatedSession)

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

  const save = useCallback(async () => {
    if (!locationId || !periodKey) return false

    setSaving(true)
    setError(null)

    try {
      const batch = []
      for (const item of items) {
        if (item.qty != null) {
          batch.push(
            setDoc(
              doc(db, 'tenants', orgId, 'inventory', locId, 'items', item.id),
              {
                qty: item.qty,
                parLevel: item.parLevel || null,
                reorderPoint: item.reorderPoint || null,
                avgDailyUsage: item.avgDailyUsage || null,
                lastCountedAt: item.lastCountedAt,
                lastCountedBy: item.lastCountedBy,
                updatedAt: serverTimestamp(),
                updatedBy: user?.email
              },
              { merge: true }
            )
          )
        }
      }
      await Promise.all(batch)

      const closingValue = items.reduce((sum, item) => {
        return sum + ((item.qty || 0) * (item.unitCost || 0))
      }, 0)

      const cogs = Math.max(0, openingValue + purchases - closingValue)

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

      // Path B snapshot — period-keyed items array at
      // tenants/{orgId}/locations/{locId}/inventory/{periodKey}.
      // This is the canonical inventory location-period snapshot that Waste
      // and the P&L Why panel inventory engine read from. Without this write,
      // those consumers see no data for any period.
      const snapshotItems = items
        .filter(i => i.qty != null)
        .map(i => ({
          id: i.id,
          name: i.name,
          qty: i.qty,
          unitCost: i.unitCost || 0,
          category: i._cat || null,
          vendor: i.vendor || null,
        }))
      await setDoc(
        doc(db, 'tenants', orgId, 'locations', locId, 'inventory', periodKey),
        {
          items:        snapshotItems,
          closingValue,
          period:       periodKey,
          locationName: locationId,
          updatedAt:    serverTimestamp(),
          updatedBy:    user?.email || 'unknown',
        },
        { merge: true }
      )

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

  const varianceAlerts = useMemo(() => {
    return itemsWithMeta
      .filter(i => i._varClass === 'alert' || i._varClass === 'warn')
      .sort((a, b) => Math.abs(b._variance * b.unitCost) - Math.abs(a._variance * a.unitCost))
      .slice(0, 5)
  }, [itemsWithMeta])

  const itemsBelowPar = useMemo(() => {
    return itemsWithMeta
      .filter(i => i._belowPar || i._atReorder)
      .sort((a, b) => (a._daysOnHand || 999) - (b._daysOnHand || 999))
  }, [itemsWithMeta])

  return {
    items: itemsWithMeta,
    categories,
    catStats,
    totals,
    varianceAlerts,
    itemsBelowPar,
    session,
    loading,
    saving,
    dirty,
    error,
    load,
    adjust,
    setQty,
    copyPrior,
    toggleKey,
    removeItem,
    restoreItem,
    addCustomItem,
    removedItems,
    loadRemovedItems,
    buddyMode,
    setBuddyMode,
    buddyNames,
    setBuddyNames,
    markSectionComplete,
    save
  }
}

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

function getDefaultCategories() {
  return [
    { key: 'beverages', label: 'Beverages', color: '#1e40af', bg: '#dbeafe', keywords: ['red bull', 'celsius', 'coke', 'sprite', 'juice', 'water', 'tea', 'coffee', 'lemonade', 'gatorade'] },
    { key: 'bar_items', label: 'Bar / Barista', color: '#7c3aed', bg: '#ede9fe', keywords: ['espresso', 'syrup', 'chai', 'matcha', 'cold brew', 'latte'] },
    { key: 'pantry', label: 'Pantry / Snacks', color: '#92400e', bg: '#fef3c7', keywords: ['chip', 'bar', 'snack', 'cookie', 'candy', 'nuts', 'pretzel', 'popcorn'] },
    { key: 'dairy', label: 'Dairy', color: '#0369a1', bg: '#e0f2fe', keywords: ['milk', 'cream', 'yogurt', 'cheese', 'butter'] },
    { key: 'frozen', label: 'Frozen', color: '#1d4ed8', bg: '#dbeafe', keywords: ['ice cream', 'frozen', 'popsicle'] },
    { key: 'proteins', label: 'Proteins', color: '#b91c1c', bg: '#fee2e2', keywords: ['chicken', 'beef', 'steak', 'salmon', 'fish', 'pork', 'turkey', 'shrimp'] },
    { key: 'produce', label: 'Produce', color: '#15803d', bg: '#dcfce7', keywords: ['lettuce', 'tomato', 'onion', 'pepper', 'carrot', 'fruit', 'apple', 'banana'] },
    { key: 'general', label: 'General', color: '#374151', bg: '#f3f4f6', keywords: [] }
  ]
}

export default useInventory