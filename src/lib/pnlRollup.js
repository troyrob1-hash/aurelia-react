// P&L rollup — aggregates sub-cafe P&L data into parent totals
import { db } from './firebase'
import { collection, getDocs } from 'firebase/firestore'

// Sum P&L docs from multiple sub-cafes into one rolled-up object
export function rollupPnL(subPnls) {
  if (!subPnls || subPnls.length === 0) return {}
  
  const result = {}
  
  for (const pnl of subPnls) {
    for (const [key, val] of Object.entries(pnl)) {
      if (typeof val === 'number') {
        result[key] = (result[key] || 0) + val
      } else if (key === 'location' || key === 'periodKey') {
        // Keep first value for metadata
        if (!result[key]) result[key] = val
      }
    }
  }
  
  return result
}

// Load P&L for a parent location by summing all sub-cafe P&Ls
export async function loadParentPnL(orgId, parentLocId, subLocIds, periodKey) {
  const subPnls = []
  
  for (const locId of subLocIds) {
    try {
      const ref = collection(db, 'tenants', orgId, 'pnl', locId, 'periods')
      const snap = await getDocs(ref)
      
      snap.forEach(doc => {
        if (doc.id === periodKey) {
          subPnls.push(doc.data())
        }
      })
    } catch (err) {
      console.warn('Failed to load sub-cafe P&L:', locId, err)
    }
  }
  
  const rolled = rollupPnL(subPnls)
  rolled._isRollup = true
  rolled._subCafeCount = subLocIds.length
  rolled._subCafesLoaded = subPnls.length
  
  return rolled
}

// Rollup inventory values from sub-cafes
export function rollupInventory(subInventories) {
  if (!subInventories || subInventories.length === 0) return []
  
  const itemMap = new Map()
  
  for (const inv of subInventories) {
    for (const item of inv) {
      const existing = itemMap.get(item.id || item.name)
      if (existing) {
        existing.qty = (existing.qty || 0) + (item.qty || 0)
        existing._value = (existing._value || 0) + (item._value || 0)
        existing._subCafes = (existing._subCafes || []).concat(item._fromCafe || item.location || '')
      } else {
        itemMap.set(item.id || item.name, { ...item, _subCafes: [item._fromCafe || item.location || ''] })
      }
    }
  }
  
  return Array.from(itemMap.values())
}
