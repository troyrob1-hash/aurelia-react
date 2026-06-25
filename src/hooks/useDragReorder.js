import { useCallback, useEffect, useRef, useState } from 'react'

// Self-contained pointer-events drag-reorder hook (mouse + touch; NOT HTML5
// DnD). All drag logic lives here so a bug stays inside the ArrangeList subtree
// (wrapped by an ErrorBoundary) and can never crash the counting page.
//
// Model: items are partitioned into GROUPS (category groups, or one synthetic
// flat group). Dragging reorders WITHIN the dragged item's group only — a
// cross-group move would be a category change, which is out of scope. On drop,
// onReorder(groupKey, orderedIds) fires once so the caller can persist.
//
// Returns:
//   groups        — the input groups with each group's items live-reordered to
//                    reflect the in-progress (and post-drop optimistic) order
//   getHandleProps(groupKey, itemId) — spread onto the grip handle element
//   registerRow(groupKey, itemId, el) — ref callback for each row (for rects)
//   draggingId    — id of the row currently being dragged (for styling), or null

const EDGE = 64        // px from the scroll edge where auto-scroll engages
const MAX_SPEED = 16   // px/frame at the very edge, scaled down toward EDGE

// Order-independent signature of the group shape: which groups exist and which
// item ids each contains. We re-seed local order only when THIS changes, so an
// optimistic post-drop reorder isn't clobbered by a props recompute that
// carries the same membership in the old order (props only catch up on reload).
function shapeSignature(groups) {
  return (groups || [])
    .map(g => g.key + ':' + g.items.map(i => i.id).slice().sort().join(','))
    .join('|')
}

// Nearest scrollable ancestor (the real scroll container — here AppShell's
// .main, not window). Falls back to null so the caller uses window.
function getScrollParent(el) {
  let node = el?.parentElement
  while (node) {
    const { overflowY } = window.getComputedStyle(node)
    if ((overflowY === 'auto' || overflowY === 'scroll') && node.scrollHeight > node.clientHeight) {
      return node
    }
    node = node.parentElement
  }
  return null
}

function arrayMove(arr, from, to) {
  const next = arr.slice()
  const [moved] = next.splice(from, 1)
  next.splice(to, 0, moved)
  return next
}

export function useDragReorder({ groups, onReorder }) {
  // order: { [groupKey]: [itemId, ...] } — the live/optimistic order per group.
  const [order, setOrder] = useState({})
  const orderRef = useRef(order)
  orderRef.current = order

  const sig = shapeSignature(groups)
  useEffect(() => {
    const next = {}
    for (const g of groups || []) next[g.key] = g.items.map(i => i.id)
    setOrder(next)
    // Re-seed only when the group/membership shape changes (sig), never on a
    // mere order change — keeps optimistic post-drop order until a real reload.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig])

  // Row element refs for rect math: rowEls.current[groupKey][itemId] = element
  const rowEls = useRef({})
  const registerRow = useCallback((groupKey, itemId, el) => {
    if (!rowEls.current[groupKey]) rowEls.current[groupKey] = {}
    if (el) rowEls.current[groupKey][itemId] = el
    else delete rowEls.current[groupKey][itemId]
  }, [])

  const drag = useRef(null) // { groupKey, itemId, pointerId }
  const [draggingId, setDraggingId] = useState(null)

  // ── Auto-scroll loop ──────────────────────────────────────────────────────
  const scroll = useRef({ raf: 0, vy: 0, target: null })
  const stopAutoScroll = useCallback(() => {
    if (scroll.current.raf) cancelAnimationFrame(scroll.current.raf)
    scroll.current.raf = 0
    scroll.current.vy = 0
  }, [])
  const tick = useCallback(() => {
    const s = scroll.current
    if (s.vy) {
      if (s.target && s.target !== window) s.target.scrollTop += s.vy
      else window.scrollBy(0, s.vy)
    }
    s.raf = requestAnimationFrame(tick)
  }, [])

  // First row whose vertical midpoint is below the pointer → insertion index.
  const overIndex = useCallback((groupKey, pointerY) => {
    const ids = orderRef.current[groupKey] || []
    const els = rowEls.current[groupKey] || {}
    for (let i = 0; i < ids.length; i++) {
      const el = els[ids[i]]
      if (!el) continue
      const r = el.getBoundingClientRect()
      if (pointerY < r.top + r.height / 2) return i
    }
    return ids.length - 1
  }, [])

  const handlePointerMove = useCallback((e) => {
    const d = drag.current
    if (!d) return
    e.preventDefault()
    const y = e.clientY

    // Live reorder within the dragged item's group.
    const ids = orderRef.current[d.groupKey] || []
    const from = ids.indexOf(d.itemId)
    const to = overIndex(d.groupKey, y)
    if (from !== -1 && to !== -1 && to !== from) {
      setOrder(o => ({ ...o, [d.groupKey]: arrayMove(o[d.groupKey] || ids, from, to) }))
    }

    // Edge auto-scroll against the resolved scroll container (or window).
    const tgt = scroll.current.target
    let top, bottom
    if (tgt && tgt !== window) {
      const rr = tgt.getBoundingClientRect()
      top = rr.top; bottom = rr.bottom
    } else {
      top = 0; bottom = window.innerHeight
    }
    let vy = 0
    if (y < top + EDGE) vy = -Math.ceil(MAX_SPEED * Math.min(1, (top + EDGE - y) / EDGE))
    else if (y > bottom - EDGE) vy = Math.ceil(MAX_SPEED * Math.min(1, (y - (bottom - EDGE)) / EDGE))
    scroll.current.vy = vy
  }, [overIndex])

  const endDrag = useCallback((e) => {
    const d = drag.current
    if (!d) return
    const handleEl = e?.currentTarget
    if (handleEl?.releasePointerCapture && d.pointerId != null) {
      try { handleEl.releasePointerCapture(d.pointerId) } catch { /* already released */ }
    }
    stopAutoScroll()
    drag.current = null
    setDraggingId(null)
    const ids = orderRef.current[d.groupKey] || []
    onReorder?.(d.groupKey, ids)
  }, [onReorder, stopAutoScroll])

  const startDrag = useCallback((e, groupKey, itemId) => {
    // Primary button / touch / pen only.
    if (e.button != null && e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    const handleEl = e.currentTarget
    // Pointer capture routes all subsequent move/up events for this pointer to
    // the handle, so React's onPointerMove/onPointerUp on the handle keep firing
    // even as the pointer leaves it — no manual window listeners needed.
    try { handleEl.setPointerCapture(e.pointerId) } catch { /* unsupported */ }
    drag.current = { groupKey, itemId, pointerId: e.pointerId }
    setDraggingId(itemId)

    const rowEl = (rowEls.current[groupKey] || {})[itemId]
    scroll.current.target = getScrollParent(rowEl) || window
    stopAutoScroll()
    scroll.current.raf = requestAnimationFrame(tick)
  }, [stopAutoScroll, tick])

  // Cleanup on unmount (e.g. leaving arrange mode mid-drag).
  useEffect(() => () => stopAutoScroll(), [stopAutoScroll])

  const getHandleProps = useCallback((groupKey, itemId) => ({
    onPointerDown: (e) => startDrag(e, groupKey, itemId),
    onPointerMove: handlePointerMove,
    onPointerUp: endDrag,
    onPointerCancel: endDrag,
    style: { touchAction: 'none', cursor: draggingId === itemId ? 'grabbing' : 'grab' },
  }), [startDrag, handlePointerMove, endDrag, draggingId])

  // Apply the live order to the groups handed back for rendering.
  const orderedGroups = (groups || []).map(g => {
    const ord = order[g.key]
    if (!ord) return g
    const byId = new Map(g.items.map(i => [i.id, i]))
    const items = ord.map(id => byId.get(id)).filter(Boolean)
    // Safety: append any members missing from `ord` (shouldn't happen).
    for (const i of g.items) if (!ord.includes(i.id)) items.push(i)
    return { ...g, items }
  })

  return { groups: orderedGroups, getHandleProps, registerRow, draggingId }
}
