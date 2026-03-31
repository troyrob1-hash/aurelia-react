import { db } from '@/lib/firebase'
import {
  doc, getDoc, setDoc, collection, query,
  orderBy, limit, getDocs, serverTimestamp
} from 'firebase/firestore'

const TENANT_ID = 'fooda'

function weekKey() {
  const now = new Date()
  const year = now.getFullYear()
  const start = new Date(year, 0, 1)
  const week = Math.ceil(((now - start) / 86400000 + start.getDay() + 1) / 7)
  return `${year}-W${String(week).padStart(2, '0')}`
}

function locationId(name) {
  return name.replace(/[^a-zA-Z0-9]/g, '_')
}

export async function getInventory(locationName) {
  try {
    const locId = locationId(locationName)
    const week  = weekKey()
    const ref   = doc(db, 'tenants', TENANT_ID, 'locations', locId, 'inventory', week)
    const snap  = await getDoc(ref)
    if (snap.exists()) return snap.data().items || []

    // Fall back to most recent week
    const q = query(
      collection(db, 'tenants', TENANT_ID, 'locations', locId, 'inventory'),
      orderBy('updatedAt', 'desc'),
      limit(1)
    )
    const recent = await getDocs(q)
    if (!recent.empty) return recent.docs[0].data().items || []
    return []
  } catch (e) {
    console.error('getInventory error:', e)
    return []
  }
}

export async function saveInventory(locationName, items, user) {
  try {
    const locId = locationId(locationName)
    const week  = weekKey()
    const ref   = doc(db, 'tenants', TENANT_ID, 'locations', locId, 'inventory', week)
    await setDoc(ref, {
      items,
      week,
      updatedAt:  serverTimestamp(),
      updatedBy:  user?.email || 'unknown',
      locationName,
    }, { merge: true })
    return true
  } catch (e) {
    console.error('saveInventory error:', e)
    return false
  }
}

export async function patchInventoryItem(locationName, itemId, changes, user) {
  const items = await getInventory(locationName)
  const idx   = items.findIndex(i => i.id === itemId)
  if (idx === -1) return false
  items[idx] = { ...items[idx], ...changes }
  return saveInventory(locationName, items, user)
}

export { weekKey, locationId }
