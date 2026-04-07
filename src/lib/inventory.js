import { db } from '@/lib/firebase'
import {
  doc, getDoc, setDoc, collection, query,
  orderBy, limit, getDocs, serverTimestamp
} from 'firebase/firestore'

// ── Multi-tenant: orgId passed in from caller ─────────────────
function locationId(name) {
  return (name || '').replace(/[^a-zA-Z0-9]/g, '_')
}

// Get inventory for a specific period key
export async function getInventory(orgId, locationName, periodKey) {
  try {
    const locId = locationId(locationName)
    const ref   = doc(db, 'tenants', orgId, 'locations', locId, 'inventory', periodKey)
    const snap  = await getDoc(ref)
    if (snap.exists()) return snap.data().items || []

    // Fall back to most recent count — carry forward item list with qty zeroed
    const q = query(
      collection(db, 'tenants', orgId, 'locations', locId, 'inventory'),
      orderBy('updatedAt', 'desc'),
      limit(1)
    )
    const recent = await getDocs(q)
    if (!recent.empty) {
      const items = recent.docs[0].data().items || []
      // Return items with qty cleared — fresh count
      return items.map(i => ({ ...i, qty: null }))
    }
    return []
  } catch (e) {
    console.error('getInventory error:', e)
    return []
  }
}

// Get prior period closing value for opening inventory
export async function getPriorClosingValue(orgId, locationName, priorPeriodKey) {
  try {
    if (!priorPeriodKey) return 0
    const locId = locationId(locationName)
    const ref   = doc(db, 'tenants', orgId, 'locations', locId, 'inventory', priorPeriodKey)
    const snap  = await getDoc(ref)
    if (!snap.exists()) return 0
    const items = snap.data().items || []
    return items.reduce((s, i) => s + ((i.qty || 0) * (i.unitCost || 0)), 0)
  } catch { return 0 }
}

// Get prior period items for variance calculation
export async function getPriorItems(orgId, locationName, priorPeriodKey) {
  try {
    if (!priorPeriodKey) return []
    const locId = locationId(locationName)
    const ref   = doc(db, 'tenants', orgId, 'locations', locId, 'inventory', priorPeriodKey)
    const snap  = await getDoc(ref)
    return snap.exists() ? snap.data().items || [] : []
  } catch { return [] }
}

// Get count history for an item — last 4 periods
export async function getItemHistory(orgId, locationName, itemId) {
  try {
    const locId = locationId(locationName)
    const q = query(
      collection(db, 'tenants', orgId, 'locations', locId, 'inventory'),
      orderBy('updatedAt', 'desc'),
      limit(4)
    )
    const snap = await getDocs(q)
    return snap.docs.map(d => {
      const items = d.data().items || []
      const item  = items.find(i => i.id === itemId)
      return { period: d.id, qty: item?.qty || 0 }
    }).reverse()
  } catch { return [] }
}

export async function saveInventory(orgId, locationName, items, user, periodKey) {
  try {
    const locId = locationId(locationName)
    const ref   = doc(db, 'tenants', orgId, 'locations', locId, 'inventory', periodKey)
    await setDoc(ref, {
      items,
      period:       periodKey,
      updatedAt:    serverTimestamp(),
      updatedBy:    user?.name || user?.email || 'unknown',
      locationName,
    }, { merge: true })
    return true
  } catch (e) {
    console.error('saveInventory error:', e)
    return false
  }
}

export { locationId }