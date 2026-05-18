import { useState, useEffect } from 'react'
import { readPnL } from '@/lib/pnl'
import { rollupPnL } from '@/lib/pnlRollup'
import { useLocations } from '@/store/LocationContext'

// Hook that reads P&L data for a location.
// If the location is a parent, automatically loads and sums all sub-cafe P&Ls.
// Every tab can use this instead of calling readPnL directly.
export function usePnL(location, periodKey) {
  const [pnl, setPnl] = useState({})
  const [loading, setLoading] = useState(true)
  const [isRollup, setIsRollup] = useState(false)
  const { allLocations, getSubCafes, isParentLocation } = useLocations()

  useEffect(() => {
    if (!location || !periodKey) {
      setPnl({})
      setLoading(false)
      return
    }

    let cancelled = false
    setLoading(true)

    async function load() {
      try {
        if (isParentLocation(location)) {
          // Parent location — load all sub-cafe P&Ls and sum
          const subs = getSubCafes(location)
          if (subs.length === 0) {
            // Parent with no sub-cafes yet — read parent directly
            const data = await readPnL(location, periodKey).catch(() => ({}))
            if (!cancelled) { setPnl(data); setIsRollup(false); setLoading(false) }
            return
          }

          const subPnls = await Promise.all(
            subs.map(sub => readPnL(sub.name, periodKey).catch(() => ({})))
          )

          // Also try to read the parent's own P&L (might have direct entries)
          const parentPnl = await readPnL(location, periodKey).catch(() => ({}))

          // Combine: parent's own data + all sub-cafe data
          const allPnls = [parentPnl, ...subPnls].filter(p => Object.keys(p).length > 0)
          const rolled = rollupPnL(allPnls)
          rolled._isRollup = true
          rolled._subCafeCount = subs.length
          rolled._subCafesLoaded = subPnls.filter(p => Object.keys(p).length > 0).length

          // Preserve budget from parent (budgets live at parent level)
          if (parentPnl) {
            Object.keys(parentPnl).forEach(key => {
              if (key.startsWith('budget_') && parentPnl[key]) {
                rolled[key] = parentPnl[key]
              }
            })
          }

          if (!cancelled) { setPnl(rolled); setIsRollup(true); setLoading(false) }
        } else {
          // Regular location or sub-cafe — read directly
          const data = await readPnL(location, periodKey).catch(() => ({}))
          if (!cancelled) { setPnl(data); setIsRollup(false); setLoading(false) }
        }
      } catch (err) {
        console.error('usePnL error:', err)
        if (!cancelled) { setPnl({}); setLoading(false) }
      }
    }

    load()
    return () => { cancelled = true }
  }, [location, periodKey, allLocations])

  return { pnl, loading, isRollup }
}
