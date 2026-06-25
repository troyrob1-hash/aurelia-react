import { GripVertical } from 'lucide-react'

// Stage 2a: STATIC arrange view. Renders the same `displayGroups` the count
// table uses (shelf-sorted, because arrange mode forces sortMode='shelf') as a
// plain div list — a grip handle + item name + current shelf position per row,
// and NO counting inputs. The handles are inert affordances for now; pointer
// dragging (useDragReorder) and persist-on-drop land in Stage 2b.
//
// Kept in its own file and wrapped by an ErrorBoundary in the parent so the
// upcoming drag logic can never take down the counting page.
//
// Props:
//   groups   — displayGroups (each: {key, label, color, bg, isFlat?, items[]})
//   viewMode — 'grouped' | 'flat'; selects which shelf field to display
export default function ArrangeList({ groups, viewMode }) {
  const field = viewMode === 'flat' ? 'flatShelfOrder' : 'catShelfOrder'

  if (!groups || groups.length === 0) {
    return (
      <div style={{ padding: 24, textAlign: 'center', color: '#94a3b8', fontSize: 13 }}>
        No items to arrange.
      </div>
    )
  }

  return (
    <div>
      <div style={{
        padding: '8px 14px', fontSize: 12, color: '#92400e',
        background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 8,
        margin: '0 0 12px',
      }}>
        Arrange mode — counting is paused.{' '}
        {viewMode === 'flat'
          ? 'Set one flat shelf order across all items.'
          : 'Set shelf order within each category group.'}{' '}
        Drag-to-reorder arrives next; positions below reflect saved shelf order.
      </div>

      {groups.map(g => (
        <div key={g.key} style={{ marginBottom: 16 }}>
          <div style={{
            padding: '8px 14px', fontSize: 13, fontWeight: 600,
            color: g.isFlat ? '#0f172a' : g.color,
            background: g.isFlat ? '#f8fafc' : g.bg,
            borderRadius: '8px 8px 0 0', border: '1px solid #e2e8f0', borderBottom: 'none',
          }}>
            {g.isFlat ? 'All Items' : g.label}
            <span style={{ marginLeft: 8, fontWeight: 500, color: '#64748b' }}>{g.items.length}</span>
          </div>

          <div style={{ border: '1px solid #e2e8f0', borderRadius: '0 0 8px 8px' }}>
            {g.items.map((item, idx) => {
              const pos = item[field]
              return (
                <div
                  key={item.id}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 10,
                    padding: '10px 12px',
                    borderTop: idx === 0 ? 'none' : '1px solid #f1f5f9',
                    background: '#fff',
                  }}
                >
                  <span
                    // Static handle (no drag in 2a). touchAction:'none' is set
                    // now so Stage 2b's pointer drag won't be hijacked by touch
                    // scrolling once the handlers are wired here.
                    style={{ display: 'flex', color: '#cbd5e1', cursor: 'grab', touchAction: 'none' }}
                    title="Drag to reorder (coming soon)"
                    aria-hidden="true"
                  >
                    <GripVertical size={16} />
                  </span>
                  <span style={{
                    flex: 1, fontSize: 13, color: '#0f172a', minWidth: 0,
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }}>
                    {item.name}
                  </span>
                  <span style={{ fontSize: 12, color: '#94a3b8', fontVariantNumeric: 'tabular-nums' }}>
                    {pos != null ? `#${pos}` : '—'}
                  </span>
                </div>
              )
            })}
          </div>
        </div>
      ))}
    </div>
  )
}
