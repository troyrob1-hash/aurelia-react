import { createContext, useContext, useState, useEffect, useMemo } from 'react'
import { useAuthStore } from '@/store/authStore'
import { db } from '@/lib/firebase'
import { collection, onSnapshot } from 'firebase/firestore'
import {
  getVisibleLocationsForUser,
  canSeeAllLocations,
  getUserRoles,
} from '@/lib/permissions'

const LocationContext = createContext(null)

export function LocationProvider({ children }) {
  const { user } = useAuthStore()

  // allLocations is an array of location objects:
  //   [{ id, name, director, shortCode, timezone, address, active, ... }, ...]
  const [allLocations,    setAllLocations]    = useState([])
  const [regionsById,     setRegionsById]     = useState({})
  const [selectedLocation, setSelectedLocation] = useState('all')  // still a name string
  const [autoSelected,    setAutoSelected]    = useState(false)
  const [loadingLocations, setLoadingLocations] = useState(true)
  const [loadingRegions,  setLoadingRegions]  = useState(true)

  // Subscribe to the locations collection (canonical source).
  // Only active locations flow through to consumers.
  useEffect(() => {
    if (!user?.tenantId) return
    const ref = collection(db, 'orgs', user.tenantId, 'locations')
    const unsub = onSnapshot(
      ref,
      snap => {
        const next = []
        snap.forEach(d => {
          const data = d.data()
          if (data.active === false) return
          if (!data.name) return
          next.push({ id: d.id, ...data })
        })
        next.sort((a, b) => (a.name || '').localeCompare(b.name || ''))
        setAllLocations(next)
        setLoadingLocations(false)
      },
      err => {
        console.error('Failed to load locations:', err)
        setLoadingLocations(false)
      }
    )
    return unsub
  }, [user?.tenantId])

  // Subscribe to the regions collection
  useEffect(() => {
    if (!user?.tenantId) return
    const ref = collection(db, 'tenants', user.tenantId, 'regions')
    const unsub = onSnapshot(
      ref,
      snap => {
        const next = {}
        snap.forEach(d => {
          next[d.id] = { id: d.id, ...d.data() }
        })
        setRegionsById(next)
        setLoadingRegions(false)
      },
      err => {
        console.error('Failed to load regions:', err)
        setLoadingRegions(false)
      }
    )
    return unsub
  }, [user?.tenantId])

  // Resolve the user's visible locations as an array
  const visibleLocations = useMemo(
    () => getVisibleLocationsForUser(user, allLocations, regionsById),
    [user, allLocations, regionsById]
  )

  // Build a name → location lookup for fast access by name
  const locationsByName = useMemo(() => {
    const map = {}
    allLocations.forEach(loc => {
      if (loc?.name) map[loc.name] = loc
    })
    return map
  }, [allLocations])

  // Grouped locations by region name.
  // Shape: { [regionName]: Location[] }
  // A location is "visible" here if it's in visibleLocations.
  const groupedLocations = useMemo(() => {
    const visibleNames = new Set(visibleLocations.map(l => l.name))
    const grouped = {}

    if (canSeeAllLocations(user)) {
      // Admins and VPs: group all visible locations by region name
      Object.values(regionsById).forEach(region => {
        const bucket = region.name || 'Unnamed region'
        if (!grouped[bucket]) grouped[bucket] = []
        ;(region.locations || []).forEach(name => {
          if (visibleNames.has(name) && locationsByName[name]) {
            grouped[bucket].push(locationsByName[name])
          }
        })
      })

      // Catch any visible locations not covered by any region
      const covered = new Set()
      Object.values(grouped).forEach(arr => arr.forEach(l => covered.add(l.name)))
      visibleLocations.forEach(loc => {
        if (!covered.has(loc.name)) {
          if (!grouped['Other']) grouped['Other'] = []
          grouped['Other'].push(loc)
        }
      })
    } else {
      // Directors and Managers: group by the regions they're assigned to
      const regionIds = Array.isArray(user?.managedRegionIds) ? user.managedRegionIds : []
      regionIds.forEach(regionId => {
        const region = regionsById[regionId]
        if (!region) return
        const bucket = region.name || 'Unnamed region'
        if (!grouped[bucket]) grouped[bucket] = []
        ;(region.locations || []).forEach(name => {
          if (visibleNames.has(name) && locationsByName[name]) {
            grouped[bucket].push(locationsByName[name])
          }
        })
      })

      // Ad-hoc individually-assigned locations
      const adHoc = Array.isArray(user?.assignedLocations) ? user.assignedLocations : []
      if (adHoc.length > 0) {
        const bucket = 'Ad-hoc assignments'
        adHoc.forEach(name => {
          if (visibleNames.has(name) && locationsByName[name]) {
            if (!grouped[bucket]) grouped[bucket] = []
            grouped[bucket].push(locationsByName[name])
          }
        })
      }
    }

    // Dedupe by name within each bucket, sort alphabetically, drop empty buckets
    const cleaned = {}
    Object.keys(grouped).forEach(k => {
      const seen = new Set()
      const deduped = grouped[k].filter(loc => {
        if (seen.has(loc.name)) return false
        seen.add(loc.name)
        return true
      })
      deduped.sort((a, b) => (a.name || '').localeCompare(b.name || ''))
      if (deduped.length > 0) cleaned[k] = deduped
    })
    return cleaned
  }, [user, regionsById, visibleLocations, locationsByName])

  // Auto-select first visible location for directors/managers
  useEffect(() => {
    if (autoSelected) return
    const roles = getUserRoles(user)
    const shouldAutoSelect = roles.includes('director') || roles.includes('manager')
    if (shouldAutoSelect && visibleLocations.length > 0) {
      setSelectedLocation(visibleLocations[0].name)
      setAutoSelected(true)
    }
  }, [user, visibleLocations, autoSelected])

  // currentLocation resolves the selected name string to the full object
  const currentLocation = useMemo(() => {
    if (selectedLocation === 'all') return null
    return locationsByName[selectedLocation] || null
  }, [selectedLocation, locationsByName])

  const loading = loadingLocations || loadingRegions

  return (
    <LocationContext.Provider value={{
      allLocations,
      visibleLocations,
      groupedLocations,
      regionsById,
      regionsList: Object.values(regionsById),
      locationsByName,  // new — handy for name → object lookups in consumers
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

// ── Display helper ──────────────────────────────────────────
/**
 * Cleans a raw location name for display (strips legacy prefixes and
 * replaces underscores with spaces).
 */
export function cleanLocName(name) {
  return (name || '').replace(/^CR_|^SO_/, '').replace(/_/g, ' ')
}
