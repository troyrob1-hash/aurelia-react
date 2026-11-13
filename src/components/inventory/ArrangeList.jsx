import { useEffect, useState } from 'react'
import { GripVertical } from 'lucide-react'
import { useDragReorder } from '@/hooks/useDragReorder'
import { parsePositionInput } from '@/lib/shelfOrder'
import { isSplitItem } from '@/lib/buckets'

// Stage 2b: LIVE drag-to-reorder arrange view. Renders the same `displayGroups`
// the count table uses (always shelf-order-sorted by default) as a plain div
// list — a grip handle + item name + current shelf position per row, NO
// counting inputs. All drag mechanics live in
// useDragReorder; this file is pure presentation. Within-group drag only
// (grouped view); flat view reorders across the single flat group. On drop the
// hook calls onReorder(groupKey, orderedIds), which the parent persists.
//
// Grouped view only: each row's place on its sheet (1..N, NOT the stored
// catShelfOrder — upload positions are file-wide, e.g. #37/#52/#90) is an
// editable box. Typing a place calls the hook's moveTo — the same optimistic
// order + the same onReorder as a drop — so a typed move IS a drag to that
// slot. Flat view keeps the read-only number: its place means something
// different (whole list, no category).
//
// Kept in its own file and wrapped by an ErrorBoundary in the parent so the
// drag logic can never take down the counting page.
//
// Props:
//   groups    — displayGroups (each: {key, label, color, bg, isFlat?, items[]})
//   viewMode  — 'grouped' | 'flat'; selects which shelf field to display
//   onReorder — (groupKey, orderedIds) => void|Promise, fired once on drop
//   filtersActive — search / a non-Full count mode is on (they don't apply here)
export default function ArrangeList({ groups, viewMode, onReorder, filtersActive = false }) {
  const field = viewMode === 'flat' ? 'flatShelfOrder' : 'catShelfOrder'
  const { groups: liveGroups, getHandleProps, registerRow, draggingId, moveTo } =
    useDragReorder({ groups, onReorder })

  if (!liveGroups || liveGroups.length === 0) {
    return (
      <div style={{ padding: 24, textAlign: 'center', color: '#94a3b8', fontSize: 13 }}>
        No items to arrange.
      </div>
    )
  }

  const hasSplit = liveGroups.some(g => g.items.some(isSplitItem))

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
        {viewMode === 'flat' ? '' : 'Or type a position number and press Enter. '}
        Order saves automatically.
        {filtersActive && (
          <div style={{ marginTop: 4 }}>
            Search and the Quick / Section count filters don't apply while arranging — you're ordering {viewMode === 'flat' ? 'the full item list' : 'every item on each sheet'}.
          </div>
        )}
        {viewMode !== 'flat' && hasSplit && (
          <div style={{ marginTop: 4 }}>
            Items marked ⇄ are counted on more than one sheet and share one position — moving one here moves it on its other sheets too.
          </div>
        )}
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
                    {!g.isFlat && isSplitItem(item) && (
                      <span title="Counted on more than one sheet — shares one position across them" style={{ marginLeft: 6, color: '#b45309' }}>⇄</span>
                    )}
                  </span>
                  {g.isFlat ? (
                    <span style={{ fontSize: 12, color: '#94a3b8', fontVariantNumeric: 'tabular-nums' }}>
                      {pos != null ? `#${pos}` : '—'}
                    </span>
                  ) : (
                    <PositionBox
                      place={idx + 1}
                      label={`Position of ${item.name} on ${g.label}`}
                      onCommit={n => moveTo(g.key, item.id, n)}
                    />
                  )}
                </div>
              )
            })}
          </div>
        </div>
      ))}
    </div>
  )
}

// The editable sheet place. Commits on Enter or blur; Escape reverts. Anything
// that isn't a whole number (blank, 2.5, "abc") reverts and writes nothing.
// Re-syncs to `place` whenever the row's place changes (its own move or a
// neighbour's), so the box always shows the real 1..N after a move.
function PositionBox({ place, label, onCommit }) {
  const [draft, setDraft] = useState(String(place))
  useEffect(() => { setDraft(String(place)) }, [place])

  const commit = () => {
    const n = parsePositionInput(draft)
    if (n == null || n === place) { setDraft(String(place)); return }
    onCommit(n)
    setDraft(String(place))   // the real new place arrives via `place`
  }

  return (
    <input
      type="text"
      inputMode="numeric"
      pattern="[0-9]*"
      aria-label={label}
      value={draft}
      onChange={e => setDraft(e.target.value)}
      onFocus={e => e.target.select()}
      onKeyDown={e => {
        if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur() }
        else if (e.key === 'Escape') { e.preventDefault(); setDraft(String(place)); e.currentTarget.dataset.cancel = '1'; e.currentTarget.blur() }
      }}
      onBlur={e => {
        if (e.currentTarget.dataset.cancel) { delete e.currentTarget.dataset.cancel; return }
        commit()
      }}
      style={{
        width: 48, padding: '4px 6px', fontSize: 12, textAlign: 'center',
        border: '1px solid #e2e8f0', borderRadius: 6, color: '#0f172a',
        fontVariantNumeric: 'tabular-nums', background: '#fff',
      }}
    />
  )
}
