import { GripVertical } from 'lucide-react'
import { useDragReorder } from '@/hooks/useDragReorder'

// Stage 2b: LIVE drag-to-reorder arrange view. Renders the same `displayGroups`
// the count table uses (shelf-sorted, because arrange mode forces
// sortMode='shelf') as a plain div list — a grip handle + item name + current
// shelf position per row, NO counting inputs. All drag mechanics live in
// useDragReorder; this file is pure presentation. Within-group drag only
// (grouped view); flat view reorders across the single flat group. On drop the
// hook calls onReorder(groupKey, orderedIds), which the parent persists.
//
// Kept in its own file and wrapped by an ErrorBoundary in the parent so the
// drag logic can never take down the counting page.
//
// Props:
//   groups    — displayGroups (each: {key, label, color, bg, isFlat?, items[]})
//   viewMode  — 'grouped' | 'flat'; selects which shelf field to display
//   onReorder — (groupKey, orderedIds) => void|Promise, fired once on drop
export default function ArrangeList({ groups, viewMode, onReorder }) {
  const field = viewMode === 'flat' ? 'flatShelfOrder' : 'catShelfOrder'
  const { groups: liveGroups, getHandleProps, registerRow, draggingId } =
    useDragReorder({ groups, onReorder })

  if (!liveGroups || liveGroups.length === 0) {
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
          ? 'Drag items into one flat shelf order across all items.'
          : 'Drag items into shelf order within each category group.'}{' '}
        Order saves automatically when you drop.
      </div>

      {liveGroups.map(g => (
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
              const isDragging = draggingId === item.id
              return (
                <div
                  key={item.id}
                  ref={el => registerRow(g.key, item.id, el)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 10,
                    padding: '10px 12px',
                    borderTop: idx === 0 ? 'none' : '1px solid #f1f5f9',
                    background: isDragging ? '#ecfdf5' : '#fff',
                    boxShadow: isDragging ? '0 6px 16px rgba(15,23,42,0.12)' : 'none',
                    borderRadius: isDragging ? 6 : 0,
                    position: 'relative',
                    zIndex: isDragging ? 2 : 1,
                    opacity: isDragging ? 0.95 : 1,
                    transition: isDragging ? 'none' : 'background 0.12s',
                  }}
                >
                  <span
                    {...getHandleProps(g.key, item.id)}
                    title="Drag to reorder"
                  >
                    <GripVertical size={16} color={isDragging ? '#1D9E75' : '#cbd5e1'} style={{ display: 'block' }} />
                  </span>
                  <span style={{
                    flex: 1, fontSize: 13, color: '#0f172a', minWidth: 0,
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    userSelect: 'none',
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
