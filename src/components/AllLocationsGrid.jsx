import { useLocations, cleanLocName } from '@/store/LocationContext'

export default function AllLocationsGrid({ title, subtitle, onSelectLocation, statusLabel }) {
  const { visibleLocations, groupedLocations } = useLocations()

  return (
    <div style={{ padding: '1.5rem', maxWidth: 1400, margin: '0 auto' }}>
      <div style={{ marginBottom: 20 }}>
        <h1 style={{ fontSize: '1.5rem', fontWeight: 700, color: '#0f172a', margin: 0 }}>{title}</h1>
        {subtitle && <p style={{ fontSize: 13, color: '#64748b', margin: '4px 0 0' }}>{subtitle}</p>}
      </div>
      {Object.entries(groupedLocations).map(([regionName, regionLocs]) => {
        if (regionLocs.length === 0) return null
        return (
          <div key={regionName} style={{ marginBottom: 24 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 10, paddingBottom: 6, borderBottom: '1px solid #e2e8f0' }}>
              <div style={{ fontSize: 14, fontWeight: 600, color: '#0f172a' }}>{regionName}</div>
              <div style={{ fontSize: 12, color: '#64748b' }}>{regionLocs.length} locations</div>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 12 }}>
              {regionLocs.map(loc => (
                <div
                  key={loc.name}
                  onClick={() => onSelectLocation(loc.name)}
                  style={{
                    padding: '16px 18px',
                    background: '#fff',
                    border: '1px solid #e5e7eb',
                    borderRadius: 12,
                    borderLeft: '3px solid #e2e8f0',
                    cursor: 'pointer',
                    transition: 'all 0.15s',
                  }}
                  onMouseEnter={e => { e.currentTarget.style.transform = 'translateY(-2px)'; e.currentTarget.style.boxShadow = '0 4px 12px rgba(0,0,0,0.06)' }}
                  onMouseLeave={e => { e.currentTarget.style.transform = 'translateY(0)'; e.currentTarget.style.boxShadow = 'none' }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: '#0f172a', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '75%' }}>
                      {cleanLocName(loc.name)}
                    </div>
                    <span style={{ fontSize: 9, padding: '2px 6px', background: '#f1f5f9', color: '#64748b', borderRadius: 10, fontWeight: 600 }}>○</span>
                  </div>
                  <div style={{ fontSize: 22, fontWeight: 700, color: '#cbd5e1' }}>—</div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 10 }}>
                    <span style={{ fontSize: 11, color: '#94a3b8' }}>{statusLabel || 'No data'}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )
      })}
    </div>
  )
}
