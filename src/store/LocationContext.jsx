import { createContext, useContext, useState, useEffect } from 'react'
import { useAuthStore } from '@/store/authStore'
import { db, doc, onSnapshot } from '@/lib/firebase'

const LocationContext = createContext(null)

export function LocationProvider({ children }) {
  const { user } = useAuthStore()
  const [allLocations, setAllLocations]       = useState({}) // { name: { director, region } }
  const [selectedLocation, setSelectedLocation] = useState('all')
  const [loading, setLoading]                 = useState(true)

  useEffect(() => {
    if (!user?.tenantId) return
    const ref = doc(db, 'tenants', user.tenantId, 'legacy', 'inv_locs')
    const unsub = onSnapshot(ref, snap => {
      if (snap.exists()) {
        setAllLocations(snap.data().value || {})
      }
      setLoading(false)
    })
    return unsub
  }, [user?.tenantId])

  // Filter locations based on role
  const visibleLocations = getVisibleLocations(allLocations, user)

  // Locations grouped by director for dropdown
  const groupedLocations = groupByDirector(visibleLocations)

  // Currently selected location data
  const currentLocation = selectedLocation === 'all'
    ? null
    : allLocations[selectedLocation] || null

  return (
    <LocationContext.Provider value={{
      allLocations,
      visibleLocations,
      groupedLocations,
      selectedLocation,
      setSelectedLocation,
      currentLocation,
      loading,
      isAllLocations: selectedLocation === 'all',
    }}>
      {children}
    </LocationContext.Provider>
  )
}

export function useLocations() {
  const ctx = useContext(LocationContext)
  if (!ctx) throw new Error('useLocations must be used within LocationProvider')
  return ctx
}

// ── Helpers ───────────────────────────────────────────────────

function getVisibleLocations(allLocations, user) {
  if (!user) return {}

  // Admins see everything
  if (user.role === 'admin') return allLocations

  // Directors see only their region
  if (user.role === 'director') {
    const directorName = user.name
    const filtered = {}
    Object.entries(allLocations).forEach(([name, data]) => {
      if (data.director === directorName) {
        filtered[name] = data
      }
    })
    return filtered
  }

  // Area managers see locations assigned to them (stored in user profile)
  // For now, fall back to showing all — Phase 3 will refine this
  return allLocations
}

function groupByDirector(locations) {
  const grouped = {}
  Object.values(locations).forEach(loc => {
    const region = loc.director || 'Other'
    if (!grouped[region]) grouped[region] = []
    grouped[region].push(loc.name)
  })
  Object.keys(grouped).forEach(r => grouped[r].sort())
  return grouped
}
