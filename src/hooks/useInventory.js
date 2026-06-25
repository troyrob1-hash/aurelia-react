import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
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

function inferCategory(glCode, itemType, itemName) {
  const gl = String(glCode || '').toLowerCase()
  const t = String(itemType || '').toLowerCase()
  const n = String(itemName || '').toLowerCase()
  if (gl.includes('12002')) return 'Barista'
  if (t.includes('barista')) return 'Barista'
  if (t.includes('beverage') || t.includes('bev')) return 'Beverages'
  if (t.includes('snack') || t.includes('snac')) return 'Snacks'
  if (t.includes('condiment') || t.includes('cond')) return 'Condiments'
  const bevWords = ['juice','water','soda','kombucha','tea ','lemonade','coffee','frappuccino','cola','coke','sprite','gatorade','celsius','red bull','rockstar','yerba','milk','almond milk','oat milk','soy milk','coconut milk','half and half','half & half','cream','protein shake','naked','illy','tractor','aura bora','boylan','virgil','joe ','eclipse','boxed water','smart water','topochico','perrier','pelegrino','pellegrino','diet coke','coke zero','coconut water','cold brew']
  if (bevWords.some(w => n.includes(w))) return 'Beverages'
  const barWords = ['cafe moto','espresso','chai','syrup','ghirardelli','david rio','matcha','teavana','starbucks','cream charger','agave','caramel sauce','chocolate sauce','white chocolate sauce','pumpkin spice','caramel brulee','freeze dried','dragonfruit','strawberry acai','mango dragonfruit','cinnamon','heavy cream','decaf moto','charger','latte']
  if (barWords.some(w => n.includes(w))) return 'Barista'
  const condWords = ['sauce','sriracha','cholula','tapatio','tabasco','ketchup','mustard','mayonnaise','soy sauce','salt packet','pepper packet','sugar','sweetener','packet','cracker','saltine']
  if (condWords.some(w => n.includes(w))) return 'Condiments'
  const snackWords = ['bar','chip','cookie','candy','chocolate','gummy','gummi','bears','jerky','pretzel','popcorn','puffcorn','nut ','nuts','almond','cashew','granola','oatmeal','yogurt','cheese','string cheese','salami','hummus','guacamole','pickle','olive','seaweed','mints','mint','gum','fruit','wafel','waffle','uncrustable','pop tart','oreo','ice cream','frozen','soup','cheesecake','brownie','blondie','marshmallow','rice crisp','snickers','twix','kit kat','reese','m&m','skittles','starburst','haribo','kind ','clif','rxbar','rx bar','builder','luna','88 acres','lenka','shameless','love corn','lovecorn','hippeas','popchips','uglies','north fork','sahale','ferris','poshi','bean vivo','gimme','quinn','solely','soley','chimes','vegobear','rip van','awake','justin','righteous','legally addictive','sabra','unreal','k protein','special k','nature valley','nut harvest','barebell','kopper','peeled','blue bunny','sweet street','sweet craft','dibs','haagen','ice cream cone','soft frozen','core power','oikos','block & barrel','marish','orchard valley','blobs','apple','fuji','banana','grand','frito']
  if (snackWords.some(w => n.includes(w))) return 'Snacks'
  if (gl.includes('12000')) return 'Snacks'
  return 'Other'
}

/**
 * Predicate: does this item carry a count worth persisting?
 * True if EITHER qty is set (incl. 0 — a legitimate "I counted zero of these")
 * OR eaches is a positive number (the loose-units count). False if both fields
 * are absent / zero. Used to:
 *   - decide which items to include in newCounts (the save list)
 *   - decide which touched items are "explicitly cleared" (the deletion list)
 * Before this predicate existed, the filter was `i.qty != null` alone, which
 * silently dropped items where the user only filled in the eaches input
 * (qty stays null, eaches gets the value) — those items would contribute to
 * closingValue but never land on the counts doc.
 */
export function hasCount(item) {
  if (!item) return false
  if (item.qty != null) return true
  if (typeof item.eaches === 'number' && item.eaches > 0) return true
  return false
}

/**
 * Merge a fresh batch of counted items into the existing Firestore items list,
 * applying explicit deletions for items the user cleared in this session.
 *
 * Three classes of input behavior:
 *   - `newCounts` entries OVERRIDE existing entries with the same id (the
 *     normal "user updated this item" case).
 *   - `deletions` ids are REMOVED from the result. Without this signal a
 *     cleared item would fall through to the existing Firestore value and
 *     silently survive — that's the W1 $61K-reappear bug from 2026-06-18.
 *   - Existing entries that are NOT in `newCounts` and NOT in `deletions`
 *     are PRESERVED — the "Tracy protection": a partial save must never
 *     wipe items the user didn't touch this session.
 *
 * Pure function — no Firestore access. Exported for unit testing.
 */
export function mergeCountsWithDeletions(existing, newCounts, deletions) {
  const byId = {}
  for (const it of existing || []) {
    if (it && it.id != null) byId[String(it.id)] = it
  }
  for (const it of newCounts || []) {
    if (it && it.id != null) byId[String(it.id)] = it
  }
  for (const id of deletions || []) {
    delete byId[String(id)]
  }
  return Object.values(byId)
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
        sessionSnap,
        countsSnap
      ] = await Promise.all([
        getDocs(collection(db, 'tenants', orgId, 'inventoryCatalog')),
        getDocs(collection(db, 'tenants', orgId, 'inventory', locId, 'items')),
        priorKey ? getDoc(doc(db, 'tenants', orgId, 'pnl', locId, 'periods', priorKey)) : Promise.resolve(null),
        getDoc(doc(db, 'tenants', orgId, 'pnl', locId, 'periods', periodKey)),
        getDoc(doc(db, 'tenants', orgId, 'settings', 'inventory')),
        getDoc(doc(db, 'tenants', orgId, 'inventorySessions', `${locId}_${periodKey}`)),
        // Per-week counts — the canonical count store. Item DEFINITIONS live on
        // the shared items docs; COUNTS (qty/eaches) live here, keyed by period,
        // so a new week starts blank by design and never inherits last week's
        // numbers.
        getDoc(doc(db, 'tenants', orgId, 'inventory', locId, 'counts', periodKey))
      ])

      // Read master items from the per-tenant inventoryCatalog collection.
      // Fall back to the legacy global aurelia/inv_items doc if the new
      // collection is empty (safety net during the migration window).
      let masterItems = []
      if (!masterItemsSnap.empty) {
        masterItems = masterItemsSnap.docs.map(d => d.data())
        console.log('masterItems loaded from inventoryCatalog:', masterItems.length)
      } else {
        // Fallback: read the legacy global catalog
        try {
          const legacySnap = await getDoc(doc(db, 'aurelia', 'inv_items'))
          if (legacySnap.exists()) {
            const data = legacySnap.data()
            let rawValue = data.value
            if (typeof rawValue === 'string') {
              try { rawValue = JSON.parse(rawValue) } catch(e) { rawValue = [] }
            }
            masterItems = Array.isArray(rawValue) ? rawValue : []
            console.warn('masterItems loaded from LEGACY aurelia/inv_items:', masterItems.length, '— per-tenant collection is empty')
          }
        } catch (e) {
          console.error('Legacy catalog fallback failed:', e)
        }
      }

      const locationOverrides = {}
      const locationHasOwnCatalog = !locationItemsSnap.empty && locationItemsSnap.docs.some(d => d.data().isCatalogItem)
      locationItemsSnap.forEach(d => {
        locationOverrides[d.id] = d.data()
      })

      // If location has its own catalog (uploaded by manager), use that instead of master
      let inventoryItems
      if (locationHasOwnCatalog) {
        inventoryItems = locationItemsSnap.docs
          .filter(d => !d.data().removed && !d.data().custom)
          .map(d => {
            const item = d.data()
            return {
              id: d.id,
              name: item.name || '',
              unitCost: item.unitCost || 0,
              packSize: item.packSize,
              qtyPerPack: item.qtyPerPack,
              packPrice: item.packPrice,
              vendor: item.vendor,
              glCode: item.glCode,
              sellingPrice: item.sellingPrice,
              itemType: item.itemType,
              qty: item.qty ?? null,
              eaches: item.eaches ?? 0,
              qtyPerPack: item.qtyPerPack,
              parLevel: item.parLevel,
              reorderPoint: item.reorderPoint,
              avgDailyUsage: item.avgDailyUsage,
              lastCountedAt: item.lastCountedAt || null,
              isCatalogItem: true,
              category: (item.category && item.category !== 'General' && item.category !== 'Other') ? item.category : inferCategory(item.glCode, item.itemType, item.name),
              // Shelf-to-sheet ordering (Stage 1). Location-own catalog doc IS
              // the per-location record, so read directly off item.X (no
              // override layer here).
              catShelfOrder:  item.catShelfOrder  ?? null,
              flatShelfOrder: item.flatShelfOrder ?? null,
            }
          })
        console.log('Using location-specific catalog:', inventoryItems.length, 'items')
      } else {
        // Fall back to master catalog with overrides
        inventoryItems = masterItems
          .filter(item => {
            const override = locationOverrides[String(item.id)]
            return !override?.removed
          })
          .map(item => {
            const override = locationOverrides[String(item.id)] || {}
            return {
              id: String(item.id),
              name: override.name ?? item.name,
              // Edit-panel writes for these 6 fields land on the per-location
              // override doc — prefer them over the catalog so edits stick on
              // reload. ?? respects an explicit override of 0 / "" while
              // falling back to catalog when the override field is absent.
              unitCost: override.unitCost ?? item.unitCost ?? 0,
              packSize: override.packSize ?? item.packSize,
              qtyPerPack: override.qtyPerPack ?? item.qtyPerPack,
              packPrice: override.packPrice ?? item.packPrice,
              vendor: override.vendor ?? item.vendor,
              glCode: override.glCode ?? item.glCode,
              sellingPrice: item.sellingPrice,
              itemType: item.itemType,
              qty: override.qty ?? null,
              parLevel: override.parLevel,
              reorderPoint: override.reorderPoint,
              avgDailyUsage: override.avgDailyUsage,
              lastCountedAt: override.lastCountedAt,
            lastCountedBy: override.lastCountedBy,
            isKey: override.isKey || false,
            category: override.category || inferCategory(item.glCode, item.itemType, item.name),
            // Shelf-to-sheet ordering (Stage 1) — per-location physical order.
            // catShelfOrder sorts within the category group; flatShelfOrder
            // sorts all items in the location. Same override.X ?? item.X ?? null
            // pattern as the other edit-panel fields so values stick on reload.
            catShelfOrder:  override.catShelfOrder  ?? item.catShelfOrder  ?? null,
            flatShelfOrder: override.flatShelfOrder ?? item.flatShelfOrder ?? null,
          }
        })
      }

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
            qtyPerPack: data.qtyPerPack || 1,
            packPrice: data.packPrice || (data.unitCost || 0),
            vendor: data.vendor || null,
            glCode: data.glCode || null,
            category: data.category || inferCategory(data.glCode, null, data.name),
            qty: data.qty ?? null,
            parLevel: data.parLevel || null,
            reorderPoint: data.reorderPoint || null,
            avgDailyUsage: data.avgDailyUsage || null,
            lastCountedAt: data.lastCountedAt || null,
            lastCountedBy: data.lastCountedBy || null,
            isKey: data.isKey || false,
            // Shelf-to-sheet ordering (Stage 1). Custom items are fully
            // self-contained in the location-items doc, so read off data.X.
            catShelfOrder:  data.catShelfOrder  ?? null,
            flatShelfOrder: data.flatShelfOrder ?? null,
            custom: true,
          })
        }
      })

      // ── Current-week snapshot hydration ───────────────────────────────
      // The live items collection (inventory/{loc}/items) is period-agnostic
      // and is cleared (qty: null) when a new week's count begins. The real
      // entered counts for any week live in that week's Path B snapshot at
      // locations/{loc}/inventory/{periodKey}. Without reading it back, a
      // previously-counted week renders blank even though its data is intact.
      // Overlay the current week's snapshot qty/eaches onto the built rows so
      // any counted week displays exactly what was entered. Live docs remain
      // the scratchpad for the active, never-counted week (no snapshot -> noop).
      // ── Per-week counts merge ─────────────────────────────────────────
      // Item DEFINITIONS come from the shared items docs (above). COUNTS for
      // THIS week come solely from inventory/{loc}/counts/{periodKey}. If that
      // doc does not exist, the week has not been counted yet and every cell
      // is blank — no carry-over from prior weeks. This makes counts truly
      // period-scoped at the source.
      let hydratedItems = [...inventoryItems, ...customItems].map(row => ({
        ...row, qty: null, eaches: 0
      }))
      let countsArr = countsSnap?.exists() && Array.isArray(countsSnap.data().items)
        ? countsSnap.data().items
        : []

      // ── Legacy snapshot fallback ──────────────────────────────────────
      // Weeks counted before the per-week counts refactor have no counts doc;
      // their data lives in the old snapshot at
      // locations/{loc}/inventory/{periodKey}. If the new counts doc is empty,
      // fall back to that snapshot so previously-counted weeks still display.
      // New saves always write the new counts doc, so this only ever serves
      // pre-refactor weeks.
      if (!countsArr.length) {
        try {
          const legacySnap = await getDoc(doc(db, 'tenants', orgId, 'locations', locId, 'inventory', periodKey))
          if (legacySnap.exists() && Array.isArray(legacySnap.data().items)) {
            countsArr = legacySnap.data().items
          }
        } catch (e) {
          console.warn('Legacy snapshot fallback failed:', e)
        }
      }

      if (countsArr.length) {
        const byId = new Map(countsArr.map(c => [String(c.id), c]))
        hydratedItems = hydratedItems.map(row => {
          const c = byId.get(String(row.id))
          if (!c) return row
          return {
            ...row,
            qty: c.qty ?? null,
            eaches: c.eaches ?? 0,
            lastCountedAt: c.countedAt ?? row.lastCountedAt ?? null,
            lastCountedBy: c.countedBy ?? row.lastCountedBy ?? null,
          }
        })
      }

      // ── Dedupe by id ──────────────────────────────────────────────────
      // Custom items stored in a location-specific catalog are picked up twice:
      // once in inventoryItems (catalog branch maps all location docs) and again
      // in customItems (data.custom === true). Same id, two entries. The save and
      // snapshot key documents by id, so duplicates collapse to one document —
      // quantities on the dropped entry are omitted while closingValue (summed
      // over the full array) still looks correct. Collapse duplicates here,
      // preferring the entry that actually has a count.
      const _seen = new Map()
      for (const it of hydratedItems) {
        const key = String(it.id)
        const existing = _seen.get(key)
        if (!existing) { _seen.set(key, it); continue }
        if (existing.qty == null && it.qty != null) _seen.set(key, it)
        else if (existing.qty != null && it.qty != null) _seen.set(key, it)
      }
      const dedupedItems = Array.from(_seen.values())
      if (dedupedItems.length !== hydratedItems.length) {
        console.warn('[DEDUPE] collapsed', hydratedItems.length - dedupedItems.length,
                     'duplicate item id(s) on load')
      }
      setItems(dedupedItems)

      // Load prior period items from Path B snapshot for variance + copyPrior.
      // Best-effort: if no prior snapshot exists, priorItems stays empty.
      try {
        if (priorKey) {
          // Prefer the prior week's COUNTS doc (carries qty AND eaches). Fall
          // back to the legacy snapshot for pre-refactor weeks (qty only).
          let priorArr = []
          const priorCountsRef = doc(db, 'tenants', orgId, 'inventory', locId, 'counts', priorKey)
          const priorCounts = await getDoc(priorCountsRef)
          if (priorCounts.exists() && Array.isArray(priorCounts.data().items) && priorCounts.data().items.length) {
            priorArr = priorCounts.data().items
          } else {
            const priorSnap = await getDoc(doc(db, 'tenants', orgId, 'locations', locId, 'inventory', priorKey))
            if (priorSnap.exists() && Array.isArray(priorSnap.data().items)) {
              priorArr = priorSnap.data().items
            }
          }
          setPriorItems(priorArr)
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
  }, [orgId, locationId, locId, periodKey, priorKey])

  useEffect(() => {
    load()
  }, [load])

  // Tracks item ids the user has explicitly mutated in THIS session (any of
  // setQty/setEaches/adjust/adjustEaches/copyPrior/mergeDraft adds to it).
  // saveCounts and save use this set to distinguish:
  //   - "qty=null because the user never counted this item"  → preserve
  //     existing Firestore value (Tracy protection)
  //   - "qty=null because the user explicitly cleared it"    → delete from
  //     the counts doc (the W1 $61K-reappear fix)
  // Cleared per-save (only the just-persisted ids) and on context change.
  const touchedItemsRef = useRef(new Set())

  // Reset the touched-items tracker when location/period changes — otherwise
  // a cleared id from W1 would carry into W2 and could falsely trigger a
  // deletion on a different period's save.
  useEffect(() => {
    touchedItemsRef.current = new Set()
  }, [locationId, periodKey])

  const adjust = useCallback((itemId, delta) => {
    touchedItemsRef.current.add(String(itemId))
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

  const adjustEaches = useCallback((itemId, delta) => {
    touchedItemsRef.current.add(String(itemId))
    setItems(prev => prev.map(item => {
      if (item.id !== itemId) return item
      const next = Math.max(0, parseFloat(((item.eaches || 0) + delta).toFixed(2)))
      return { ...item, eaches: next, lastCountedAt: new Date().toISOString(), lastCountedBy: user?.email || 'unknown' }
    }))
    setDirty(true)
  }, [user])

  const setEaches = useCallback((itemId, value) => {
    touchedItemsRef.current.add(String(itemId))
    setItems(prev => prev.map(item => {
      if (item.id !== itemId) return item
      // Mirror setQty: preserve the raw typed string in _eachesRaw so the
      // controlled input doesn't wipe in-progress decimals ('1.' → 1 → display
      // shows '1' → next keystroke produces '10', not '1.0'). The number form
      // (eaches) drives math; the raw form drives display.
      const raw = value
      const eaches = value === '' ? 0 : Math.max(0, parseFloat(value) || 0)
      return { ...item, eaches, _eachesRaw: raw, lastCountedAt: new Date().toISOString(), lastCountedBy: user?.email || 'unknown' }
    }))
    setDirty(true)
  }, [user])

  const setQty = useCallback((itemId, value) => {
    touchedItemsRef.current.add(String(itemId))
    setItems(prev => prev.map(item => {
      if (item.id !== itemId) return item
      // Keep the raw typed string so in-progress decimals ('.', '0.', '.5')
      // are not wiped by parseFloat while the user is still typing.
      const raw = value
      const parsed = value === '' ? null : Math.max(0, parseFloat(value))
      const qty = (parsed === null || isNaN(parsed)) ? (value === '' ? null : 0) : parsed
      const attribution = buddyMode && buddyNames.caller && buddyNames.marker
        ? `${buddyNames.caller} + ${buddyNames.marker}`
        : (user?.email || 'unknown')
      return {
        ...item,
        qty,
        _qtyRaw: raw,
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
      if (priorItem.eaches != null) setEaches(itemId, priorItem.eaches)
    }
  }, [priorItems, setQty, setEaches])

  // Merge a draft of counts (from useAutosave's localStorage backstop) into
  // the currently-loaded items. Returns true if any items were updated.
  // Used by Inventory.jsx after load completes to restore counts the user
  // typed before navigating away.
  const itemsRef = useRef(items)
  useEffect(() => { itemsRef.current = items }, [items])

  const mergeDraft = useCallback((draftItems) => {
    if (!Array.isArray(draftItems) || draftItems.length === 0) return false
    const current = itemsRef.current
    if (!Array.isArray(current) || current.length === 0) return false

    const byId = new Map(current.map(i => [String(i.id), i]))
    let changed = 0
    draftItems.forEach(d => {
      const id = String(d.id)
      const existing = byId.get(id)
      if (existing) {
        // The draft represents user edits from a prior session that may not
        // have made it to Firestore. Treat each restored id as "touched" so a
        // subsequent save can also persist a clear via the deletion path.
        touchedItemsRef.current.add(id)
        byId.set(id, {
          ...existing,
          qty: d.qty,
          eaches: d.eaches ?? 0,
          lastCountedAt: d.lastCountedAt || existing.lastCountedAt || null,
          lastCountedBy: d.lastCountedBy || existing.lastCountedBy || null,
        })
        changed++
      }
    })

    if (changed === 0) return false
    setItems(Array.from(byId.values()))
    setDirty(true)
    return true
  }, [])

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
      // Persist in-progress counts before the reload below, so restoring an
      // item mid-count never wipes unsaved counts. Use hasCount so eaches-only
      // entries persist too.
      const countsItems = items
        .filter(hasCount)
        .map(i => ({ id: i.id, qty: i.qty, eaches: i.eaches || 0,
          countedAt: i.lastCountedAt || null, countedBy: i.lastCountedBy || null }))
      if (countsItems.length) {
        await setDoc(
          doc(db, 'tenants', orgId, 'inventory', locId, 'counts', periodKey),
          { items: countsItems, period: periodKey, updatedAt: serverTimestamp(), updatedBy: user?.email || 'unknown' },
          { merge: false }
        )
      }
      await setDoc(
        doc(db, 'tenants', orgId, 'inventory', locId, 'items', itemId),
        {
          removed:    false,
          restoredAt: serverTimestamp(),
          restoredBy: user?.email || 'unknown',
        },
        { merge: true }
      )
      await load()
    } catch (e) {
      console.error('Failed to restore item:', e)
    }
  }, [items, orgId, locId, periodKey, user, load])

  // Add a custom item that exists only at this location.
  const addCustomItem = useCallback(async (data) => {
    if (!data.name) return
    const customId = `custom_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
    const newItem = {
      name:     data.name,
      unitCost: parseFloat(data.unitCost) || 0,
      packSize: data.packSize || null,
      qtyPerPack: parseFloat(data.qtyPerPack) || 1,
      // Path (a): if user enters unitCost + qtyPerPack but no packPrice,
      // derive packPrice = unitCost × qtyPerPack so the case valuation is
      // correct (not just one unit at unit cost — which would undercount
      // by qtyPerPack times).
      packPrice: parseFloat(data.packPrice) || ((parseFloat(data.unitCost) || 0) * (parseFloat(data.qtyPerPack) || 1)),
      vendor:   data.vendor || null,
      glCode:   (data.glCode || '').trim() || null,
      category: data.category || null,
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
      // Persist any in-progress counts to the per-week counts doc BEFORE the
      // optimistic insert, so adding an item can never discard unsaved counts
      // (a reload would otherwise rebuild items blank and wipe them). Use
      // hasCount so eaches-only entries persist too.
      try {
        const countsItems = items
          .filter(hasCount)
          .map(i => ({
            id: i.id,
            qty: i.qty,
            eaches: i.eaches || 0,
            countedAt: i.lastCountedAt || null,
            countedBy: i.lastCountedBy || null,
          }))
        if (countsItems.length) {
          await setDoc(
            doc(db, 'tenants', orgId, 'inventory', locId, 'counts', periodKey),
            {
              items:     countsItems,
              period:    periodKey,
              updatedAt: serverTimestamp(),
              updatedBy: user?.email || 'unknown',
            },
            { merge: false }
          )
        }
      } catch (persistErr) {
        console.error('Failed to persist counts before adding item:', persistErr)
      }

      // Optimistic local insert (preserves all current in-progress counts)
      setItems(prev => [...prev, {
        id: customId,
        ...newItem,
        qty: null,
        eaches: 0,
        isKey: false,
      }])
    } catch (e) {
      console.error('Failed to add custom item:', e)
    }
  }, [orgId, locId, periodKey, items, user])

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

  // Lightweight autosave: persist counts (qty/eaches) to the per-week counts
  // doc and refresh the live PnL closingValue, WITHOUT marking the session
  // completed or closing the period. Safe to call repeatedly (debounced).
  const saveCounts = useCallback(async () => {
    if (!locationId || !periodKey) return false
    // Guard: if items haven't loaded yet (transition / reload), do NOT write —
    // saving an empty/partial set here would clobber real counts.
    if (!Array.isArray(items) || items.length === 0) return false
    try {
      const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0 }
      // Include any item with EITHER qty OR positive eaches — see hasCount.
      // Pre-fix this filtered on qty != null alone, so eaches-only entries
      // never landed on the counts doc even though they contributed to
      // closingValue (W1 $3.83 divergence, 2026-06-18).
      const newCounts = items
        .filter(hasCount)
        .map(i => ({
          id: i.id,
          qty: i.qty == null ? null : num(i.qty),
          eaches: num(i.eaches),
          countedAt: i.lastCountedAt || null,
          countedBy: i.lastCountedBy || null,
        }))
      // Deletions: items the user explicitly cleared (no qty, no eaches) AND
      // touched in this session. Excluding hasCount items here is critical —
      // an item with qty=null and eaches=1.08 must NOT be deleted just
      // because qty is null; the eaches counts as a real count.
      // Snapshot the set first so items touched DURING the async writes remain
      // pending for the next save.
      const touchedSnapshot = new Set(touchedItemsRef.current)
      const deletions = items
        .filter(i => !hasCount(i) && touchedSnapshot.has(String(i.id)))
        .map(i => String(i.id))
      // Merge new counts OVER existing saved counts by id, so a partial save
      // never wipes counts already saved (Tracy's 'enter 5-6 times' bug:
      // merge:false overwrote the whole array with a subset). Deletions
      // remove cleared ids from the result. See mergeCountsWithDeletions.
      const countsRef = doc(db, 'tenants', orgId, 'inventory', locId, 'counts', periodKey)
      let existing = []
      try { const snap = await getDoc(countsRef); if (snap.exists()) existing = snap.data().items || [] } catch (e) {}
      const countsItems = mergeCountsWithDeletions(existing, newCounts, deletions)
      await setDoc(
        countsRef,
        { items: countsItems, period: periodKey, updatedAt: serverTimestamp(), updatedBy: user?.email || 'unknown' },
        { merge: false }
      )
      const closingValue = items.reduce((sum, item) => {
        const pp = item.packPrice || ((item.qtyPerPack || 1) * (item.unitCost || 0))
        const packVal = (item.qty || 0) * pp
        const eachPrice = (item.qtyPerPack || 1) > 0 ? pp / (item.qtyPerPack || 1) : (item.unitCost || 0)
        const eachVal = (item.eaches || 0) * eachPrice
        return sum + packVal + eachVal
      }, 0)
      // Refresh opening from prior week's CURRENT closingValue at write time.
      // The state var is a load-time snapshot and goes stale once the prior
      // week is re-saved. UI reads opening live and is unaffected; this
      // protects downstream consumers that read the stored field.
      let freshOpening = openingValue
      if (priorKey) {
        try {
          const priorPnlSnap = await getDoc(doc(db, 'tenants', orgId, 'pnl', locId, 'periods', priorKey))
          freshOpening = priorPnlSnap.exists() ? (priorPnlSnap.data().closingValue || 0) : 0
          if (freshOpening !== openingValue) setOpeningValue(freshOpening)
        } catch (e) {
          console.warn('Failed to refresh opening from prior week at save; using cached value', e)
        }
      }
      const cogs = Math.max(0, freshOpening + purchases - closingValue)
      await setDoc(
        doc(db, 'tenants', orgId, 'pnl', locId, 'periods', periodKey),
        { closingValue, openingValue: freshOpening, cogs_inventory: cogs, inventoryCountedAt: serverTimestamp(), inventoryCountedBy: user?.email },
        { merge: true }
      )
      // Remove just-persisted ids from the touched set. Items touched DURING
      // the async writes (rare) stay so the next save can act on them.
      touchedSnapshot.forEach(id => touchedItemsRef.current.delete(id))
      setDirty(false)
      return true
    } catch (err) {
      console.error('Autosave (counts) failed:', err)
      setError('Count save failed: ' + (err?.message || 'unknown error'))
      return false
    }
  }, [items, locationId, locId, periodKey, orgId, openingValue, purchases, user])

  const save = useCallback(async () => {
    if (!locationId || !periodKey) return false

    setSaving(true)
    setError(null)

    try {
      // Item DEFINITION fields only (par/reorder/usage) go to the shared items
      // docs. COUNTS (qty/eaches) are NOT written here — they go to the
      // per-week counts doc below, so they stay period-scoped.
      // Write definition fields (par/reorder/usage) for every item that has
      // any of them set — NOT just counted items — so par levels on uncounted
      // items are never silently dropped.
      const batch = []
      for (const item of items) {
        if (item.parLevel != null || item.reorderPoint != null || item.avgDailyUsage != null) {
          batch.push(
            setDoc(
              doc(db, 'tenants', orgId, 'inventory', locId, 'items', item.id),
              {
                parLevel: item.parLevel ?? null,
                reorderPoint: item.reorderPoint ?? null,
                avgDailyUsage: item.avgDailyUsage ?? null,
                updatedAt: serverTimestamp(),
                updatedBy: user?.email
              },
              { merge: true }
            )
          )
        }
      }
      await Promise.all(batch)

      // ── Per-week counts doc — canonical count store ───────────────────
      const num2 = (v) => { const x = Number(v); return Number.isFinite(x) ? x : 0 }
      // Same hasCount predicate as saveCounts — include eaches-only entries.
      const newCounts2 = items
        .filter(hasCount)
        .map(i => ({
          id: i.id,
          qty: i.qty == null ? null : num2(i.qty),
          eaches: num2(i.eaches),
          countedAt: i.lastCountedAt || null,
          countedBy: i.lastCountedBy || null,
        }))
      // Deletions: only items with NEITHER qty NOR eaches that the user
      // touched. Same rationale as saveCounts.
      const touchedSnapshot2 = new Set(touchedItemsRef.current)
      const deletions2 = items
        .filter(i => !hasCount(i) && touchedSnapshot2.has(String(i.id)))
        .map(i => String(i.id))
      // Merge over existing saved counts by id (no clobber), with deletions.
      const countsRef2 = doc(db, 'tenants', orgId, 'inventory', locId, 'counts', periodKey)
      let existing2 = []
      try { const snap2 = await getDoc(countsRef2); if (snap2.exists()) existing2 = snap2.data().items || [] } catch (e) {}
      const countsItems = mergeCountsWithDeletions(existing2, newCounts2, deletions2)
      await setDoc(
        countsRef2,
        {
          items:     countsItems,
          period:    periodKey,
          updatedAt: serverTimestamp(),
          updatedBy: user?.email || 'unknown',
        },
        { merge: false }
      )

      const closingValue = items.reduce((sum, item) => {
        const pp = item.packPrice || ((item.qtyPerPack || 1) * (item.unitCost || 0))
        const packVal = (item.qty || 0) * pp
        const eachPrice = (item.qtyPerPack || 1) > 0 ? pp / (item.qtyPerPack || 1) : (item.unitCost || 0)
        const eachVal = (item.eaches || 0) * eachPrice
        return sum + packVal + eachVal
      }, 0)

      // See saveCounts — refresh opening from prior week's CURRENT closingValue
      // so the stored field doesn't go stale relative to live reads.
      let freshOpening = openingValue
      if (priorKey) {
        try {
          const priorPnlSnap = await getDoc(doc(db, 'tenants', orgId, 'pnl', locId, 'periods', priorKey))
          freshOpening = priorPnlSnap.exists() ? (priorPnlSnap.data().closingValue || 0) : 0
          if (freshOpening !== openingValue) setOpeningValue(freshOpening)
        } catch (e) {
          console.warn('Failed to refresh opening from prior week at save; using cached value', e)
        }
      }
      const cogs = Math.max(0, freshOpening + purchases - closingValue)

      await setDoc(
        doc(db, 'tenants', orgId, 'pnl', locId, 'periods', periodKey),
        {
          closingValue,
          openingValue: freshOpening,
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
          eaches: i.eaches || 0,
          qtyPerPack: i.qtyPerPack || 1,
          packPrice: i.packPrice || null,
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

      // Remove just-persisted ids from the touched set (parallels saveCounts).
      touchedSnapshot2.forEach(id => touchedItemsRef.current.delete(id))
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
      const priorEaches = prior?.eaches || 0
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
        _priorEaches: priorEaches,
        _variance: variance,
        _varClass: varClass,
        _daysOnHand: daysOnHand,
        _belowPar: belowPar,
        _atReorder: atReorder,
        _value: (() => {
          const pp = item.packPrice || ((item.qtyPerPack || 1) * (item.unitCost || 0))
          const ep = (item.qtyPerPack || 1) > 0 ? pp / (item.qtyPerPack || 1) : (item.unitCost || 0)
          return ((item.qty || 0) * pp) + ((item.eaches || 0) * ep)
        })()
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
    adjustEaches,
    setEaches,
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
    save,
    saveCounts,
    mergeDraft,
  }
}

function assignCategory(item, categories) {
  // Use the item's own category first (set by inferCategory or upload)
  if (item.category && item.category !== 'Other' && item.category !== 'General') {
    const catName = item.category.toLowerCase()
    // Map common names to category keys
    const keyMap = {
      'barista': 'bar_items',
      'snacks': 'pantry',
      'beverages': 'beverages',
      'condiments': 'condiments',
      'cafeteria': 'pantry',
      'dairy': 'dairy',
      'frozen': 'frozen',
      'proteins': 'proteins',
      'produce': 'produce',
    }
    if (keyMap[catName]) return keyMap[catName]
    const match = categories.find(c => c.key === catName || c.label.toLowerCase() === catName)
    if (match) return match.key
    return catName
  }

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
    { key: 'condiments', label: 'Condiments', color: '#64748b', bg: '#f1f5f9', keywords: ['sauce', 'ketchup', 'mustard', 'mayo', 'salt', 'pepper', 'sugar', 'sweetener', 'packet', 'sriracha', 'cholula', 'tabasco', 'tapatio', 'soy sauce', 'cracker'] },
    { key: 'general', label: 'General', color: '#374151', bg: '#f3f4f6', keywords: [] }
  ]
}

export default useInventory