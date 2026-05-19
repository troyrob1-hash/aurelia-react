import { useLocations, cleanLocName } from '@/store/LocationContext'

export default function SubCafeBar({ parentName, activeSubCafe }) {
  const { allLocations, setSelectedLocation } = useLocations()

  const parent = allLocations.find(l => l.name === parentName)
  const subCafes = allLocations.filter(l =>
    l.parentLocationId === (parent?.locationId || parent?.id) ||
    l.parentLocation === parentName
  )

  if (subCafes.length === 0) return null

  const isActive = (name) => name === null ? !activeSubCafe : activeSubCafe === name

  return (
    <div style={{
      display: 'inline-flex', alignItems: 'center', gap: 0,
      background: '#f1f5f9', borderRadius: 8, padding: 3,
    }}>
      <button
        onClick={() => setSelectedLocation(parentName)}
        style={{
          padding: '6px 16px', fontSize: 12, fontWeight: 500, borderRadius: 6,
          border: 'none', cursor: 'pointer',
          background: isActive(null) ? '#fff' : 'transparent',
          boxShadow: isActive(null) ? '0 1px 2px rgba(0,0,0,0.06)' : 'none',
          color: isActive(null) ? '#0f172a' : '#64748b',
        }}
      >
        All
      </button>
      {subCafes.map(sub => (
        <button
          key={sub.id || sub.locationId}
          onClick={() => setSelectedLocation(sub.name)}
          style={{
            padding: '6px 16px', fontSize: 12, fontWeight: 500, borderRadius: 6,
            border: 'none', cursor: 'pointer',
            background: isActive(sub.name) ? '#fff' : 'transparent',
            boxShadow: isActive(sub.name) ? '0 1px 2px rgba(0,0,0,0.06)' : 'none',
            color: isActive(sub.name) ? '#0f172a' : '#64748b',
          }}
        >
          {cleanLocName(sub.name)}
        </button>
      ))}
    </div>
  )
}
