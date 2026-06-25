import { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import { GripVertical, Pencil, Plus, AlertTriangle } from 'lucide-react'
import { useAuthStore } from '@/store/authStore'
import { db } from '@/lib/firebase'
import { doc, getDoc, setDoc } from 'firebase/firestore'
import { getDefaultCategories } from '@/hooks/useInventory'
import { useDragReorder } from '@/hooks/useDragReorder'

// Category manager — Step 2: ADD + REORDER + color/label editing. PURE settings
// writes to tenants/{orgId}/settings/inventory.categories[] — never touches item
// docs. Renaming a category that may carry items (the migration case) is Step 3;
// here label editing is allowed ONLY on categories added in the current session
// (guaranteed empty — their label didn't exist a moment ago), and locked on all
// pre-existing categories. Counts (the all-locations scan) are deferred to Step 3.

// Fixed palette of {color, bg} pairs — avoids per-color bg math and matches the
// default categories' aesthetic. Add auto-picks the next entry; edit lets the
// user choose any.
const PALETTE = [
  { color: '#1e40af', bg: '#dbeafe' },
  { color: '#7c3aed', bg: '#ede9fe' },
  { color: '#92400e', bg: '#fef3c7' },
  { color: '#0369a1', bg: '#e0f2fe' },
  { color: '#b91c1c', bg: '#fee2e2' },
  { color: '#15803d', bg: '#dcfce7' },
  { color: '#be185d', bg: '#fce7f3' },
  { color: '#0f766e', bg: '#ccfbf1' },
  { color: '#64748b', bg: '#f1f5f9' },
  { color: '#374151', bg: '#f3f4f6' },
]

// Lowercased labels/keys the hardcoded assignCategory keyMap intercepts BEFORE
// the settings match — naming a category one of these can route its items to a
// built-in category instead. We warn (not block) on collision.
const KEYMAP_KEYS = ['barista', 'snacks', 'beverages', 'condiments', 'cafeteria', 'dairy', 'frozen', 'proteins', 'produce']

function slugify(label) {
  return (label || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'category'
}
function uniqueKey(base, existingKeys) {
  const taken = new Set(existingKeys)
  if (!taken.has(base)) return base
  let n = 2
  while (taken.has(`${base}_${n}`)) n++
  return `${base}_${n}`
}
function collidesWithKeyMap(str) {
  return KEYMAP_KEYS.includes((str || '').toLowerCase())
}

export default function InventoryCategoriesTab() {
  const user = useAuthStore(s => s.user)
  const orgId = user?.tenantId

  const [categories, setCategories] = useState([])
  const [isCustom, setIsCustom] = useState(false)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(null)
  const [saveError, setSaveError] = useState(null)
  const [saving, setSaving] = useState(false)

  // Keys added in THIS session — the only categories whose label is editable
  // here (guaranteed empty; no item can already carry a just-invented label).
  const newKeys = useRef(new Set())

  // Add-form + per-row edit state
  const [addLabel, setAddLabel] = useState('')
  const [addColorIdx, setAddColorIdx] = useState(0)
  const [editingKey, setEditingKey] = useState(null)
  const [draftLabel, setDraftLabel] = useState('')
  const [draftColorIdx, setDraftColorIdx] = useState(0)

  useEffect(() => {
    if (!orgId) return
    let cancelled = false
    setLoading(true)
    setLoadError(null)
    getDoc(doc(db, 'tenants', orgId, 'settings', 'inventory'))
      .then(snap => {
        if (cancelled) return
        const arr = snap.exists() ? snap.data().categories : null
        if (Array.isArray(arr) && arr.length) {
          setCategories(arr)
          setIsCustom(true)
        } else {
          setCategories(getDefaultCategories())
          setIsCustom(false)
        }
      })
      .catch(e => { if (!cancelled) setLoadError(e.message || 'Failed to load categories') })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [orgId])

  // Optimistic write of the COMPLETE array; reverts on failure. Spreads at the
  // call sites preserve each category's keywords + rx.
  const saveCategories = useCallback(async (nextArray) => {
    setSaveError(null)
    setSaving(true)
    let prev
    setCategories(p => { prev = p; return nextArray })
    try {
      await setDoc(doc(db, 'tenants', orgId, 'settings', 'inventory'), { categories: nextArray }, { merge: true })
      setIsCustom(true)
    } catch (e) {
      setSaveError('Save failed: ' + (e.message || 'unknown error'))
      setCategories(prev) // revert
    } finally {
      setSaving(false)
    }
  }, [orgId])

  // ── Drag reorder (reuse the shelf-to-sheet hook) ────────────────────────────
  const dragGroups = useMemo(
    () => [{ key: '__cats__', items: categories.map(c => ({ ...c, id: c.key })) }],
    [categories]
  )
  const handleReorder = useCallback((_groupKey, orderedIds) => {
    const byKey = new Map(categories.map(c => [c.key, c]))
    const next = orderedIds.map(id => byKey.get(id)).filter(Boolean)
    // Safety: append any not present in orderedIds (shouldn't happen).
    for (const c of categories) if (!orderedIds.includes(c.key)) next.push(c)
    if (next.length === categories.length) saveCategories(next)
  }, [categories, saveCategories])
  const { groups: liveGroups, getHandleProps, registerRow, draggingId } =
    useDragReorder({ groups: dragGroups, onReorder: handleReorder })

  const addCollision = collidesWithKeyMap(addLabel) || collidesWithKeyMap(slugify(addLabel))
  const draftCollision = collidesWithKeyMap(draftLabel) || collidesWithKeyMap(slugify(draftLabel))

  const handleAdd = () => {
    const label = addLabel.trim()
    if (!label) return
    const key = uniqueKey(slugify(label), categories.map(c => c.key))
    const { color, bg } = PALETTE[addColorIdx % PALETTE.length]
    newKeys.current.add(key)
    saveCategories([...categories, { key, label, color, bg, keywords: [] }])
    setAddLabel('')
    setAddColorIdx(i => (i + 1) % PALETTE.length)
  }

  const startEdit = (cat) => {
    setEditingKey(cat.key)
    setDraftLabel(cat.label || '')
    const idx = PALETTE.findIndex(p => p.color === cat.color)
    setDraftColorIdx(idx >= 0 ? idx : 0)
  }
  const cancelEdit = () => { setEditingKey(null); setSaveError(null) }
  const saveEdit = (cat) => {
    const canLabel = newKeys.current.has(cat.key)
    const { color, bg } = PALETTE[draftColorIdx % PALETTE.length]
    const nextLabel = canLabel ? (draftLabel.trim() || cat.label) : cat.label
    const next = categories.map(c =>
      c.key === cat.key ? { ...c, label: nextLabel, color, bg } : c // spread preserves keywords + rx
    )
    saveCategories(next)
    setEditingKey(null)
  }

  if (loading) return <div style={{ padding: 24, color: '#64748b', fontSize: 14 }}>Loading categories…</div>
  if (loadError) return <div style={{ padding: 24, color: '#b91c1c', fontSize: 14 }}>Couldn’t load categories: {loadError}</div>

  const rows = liveGroups[0]?.items || []

  return (
    <div style={{ padding: '8px 4px', maxWidth: 760 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
        <h2 style={{ fontSize: 16, fontWeight: 600, color: '#0f172a', margin: 0 }}>Inventory categories</h2>
        <span style={{
          fontSize: 11, fontWeight: 600, padding: '3px 8px', borderRadius: 999,
          background: isCustom ? '#dcfce7' : '#f1f5f9', color: isCustom ? '#166534' : '#64748b',
        }}>
          {isCustom ? 'Customized' : 'Defaults (not yet customized)'}
        </span>
      </div>
      <p style={{ fontSize: 13, color: '#64748b', margin: '0 0 16px', lineHeight: 1.5 }}>
        These groupings organize the inventory count sheet and the category KPI bubbles. Drag to reorder; click the
        pencil to recolor. Renaming a category that already has items, and deleting categories, arrive in a later update.
      </p>

      {saveError && (
        <div style={{ marginBottom: 12, padding: '8px 12px', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, color: '#b91c1c', fontSize: 13 }}>
          {saveError}
        </div>
      )}

      {/* ── Add form ── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14, padding: 12, background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 10 }}>
        <input
          value={addLabel}
          onChange={e => setAddLabel(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') handleAdd() }}
          placeholder="New category name"
          style={{ flex: 1, padding: '7px 10px', fontSize: 13, border: '1px solid #cbd5e1', borderRadius: 6 }}
        />
        <div style={{ display: 'flex', gap: 4 }}>
          {PALETTE.map((p, i) => (
            <button
              key={p.color}
              onClick={() => setAddColorIdx(i)}
              title={p.color}
              style={{
                width: 20, height: 20, borderRadius: 5, cursor: 'pointer', background: p.bg,
                border: `2px solid ${p.color}`, outline: addColorIdx === i ? '2px solid #0f172a' : 'none', outlineOffset: 1,
              }}
            />
          ))}
        </div>
        <button
          onClick={handleAdd}
          disabled={!addLabel.trim() || saving}
          style={{
            display: 'flex', alignItems: 'center', gap: 4, padding: '7px 12px', fontSize: 13, fontWeight: 600,
            border: 'none', borderRadius: 6, cursor: addLabel.trim() && !saving ? 'pointer' : 'not-allowed',
            background: addLabel.trim() && !saving ? '#1D9E75' : '#e2e8f0', color: addLabel.trim() && !saving ? '#fff' : '#94a3b8',
          }}
        >
          <Plus size={14} /> Add
        </button>
      </div>
      {addCollision && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, margin: '-6px 2px 14px', fontSize: 12, color: '#b45309' }}>
          <AlertTriangle size={13} /> “{addLabel.trim()}” matches a built-in categorization name — items could group unexpectedly. You can still add it.
        </div>
      )}

      {/* ── List ── */}
      <div style={{ border: '1px solid #e2e8f0', borderRadius: 10, overflow: 'hidden' }}>
        {rows.map((cat, idx) => {
          const isEditing = editingKey === cat.key
          const canLabel = newKeys.current.has(cat.key)
          const isDragging = draggingId === cat.key
          return (
            <div
              key={cat.key}
              ref={el => registerRow('__cats__', cat.key, el)}
              style={{
                padding: '10px 12px', borderTop: idx === 0 ? 'none' : '1px solid #f1f5f9',
                background: isDragging ? '#ecfdf5' : '#fff',
                boxShadow: isDragging ? '0 6px 16px rgba(15,23,42,0.12)' : 'none',
                position: 'relative', zIndex: isDragging ? 2 : 1,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span {...getHandleProps('__cats__', cat.key)} title="Drag to reorder">
                  <GripVertical size={16} color={isDragging ? '#1D9E75' : '#cbd5e1'} style={{ display: 'block' }} />
                </span>
                <span style={{ width: 22, height: 22, borderRadius: 6, flexShrink: 0, background: cat.bg || '#f3f4f6', border: `2px solid ${cat.color || '#cbd5e1'}` }} />

                {isEditing ? (
                  <input
                    value={draftLabel}
                    onChange={e => setDraftLabel(e.target.value)}
                    disabled={!canLabel}
                    title={canLabel ? '' : 'Renaming re-tags existing items — coming in a later update'}
                    style={{
                      flex: 1, padding: '5px 8px', fontSize: 13, borderRadius: 6,
                      border: '1px solid #cbd5e1', background: canLabel ? '#fff' : '#f1f5f9', color: canLabel ? '#0f172a' : '#94a3b8',
                    }}
                  />
                ) : (
                  <span style={{ flex: 1, fontSize: 14, fontWeight: 500, color: cat.color || '#0f172a', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {cat.label || <span style={{ color: '#cbd5e1' }}>(no label)</span>}
                  </span>
                )}

                <span style={{ fontSize: 12, color: '#64748b', fontFamily: 'ui-monospace, Menlo, monospace', minWidth: 90, textAlign: 'right' }}>{cat.key}</span>
                <span title="Item usage counts arrive with category editing (requires an all-locations scan)" style={{ fontSize: 13, color: '#cbd5e1', minWidth: 28, textAlign: 'right' }}>—</span>

                {isEditing ? (
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button onClick={() => saveEdit(cat)} disabled={saving} style={{ padding: '5px 10px', fontSize: 12, fontWeight: 600, border: 'none', borderRadius: 6, background: '#1D9E75', color: '#fff', cursor: 'pointer' }}>Save</button>
                    <button onClick={cancelEdit} style={{ padding: '5px 10px', fontSize: 12, fontWeight: 500, border: '1px solid #cbd5e1', borderRadius: 6, background: '#fff', color: '#475569', cursor: 'pointer' }}>Cancel</button>
                  </div>
                ) : (
                  <button onClick={() => startEdit(cat)} title="Edit color / label" style={{ display: 'flex', alignItems: 'center', background: 'none', border: 'none', cursor: 'pointer', color: '#94a3b8', padding: 4 }}>
                    <Pencil size={14} />
                  </button>
                )}
              </div>

              {isEditing && (
                <div style={{ marginTop: 10, paddingLeft: 48 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 6 }}>
                    {PALETTE.map((p, i) => (
                      <button
                        key={p.color}
                        onClick={() => setDraftColorIdx(i)}
                        title={p.color}
                        style={{
                          width: 20, height: 20, borderRadius: 5, cursor: 'pointer', background: p.bg,
                          border: `2px solid ${p.color}`, outline: draftColorIdx === i ? '2px solid #0f172a' : 'none', outlineOffset: 1,
                        }}
                      />
                    ))}
                  </div>
                  {!canLabel && (
                    <div style={{ fontSize: 12, color: '#94a3b8' }}>
                      Color is editable. Renaming re-tags existing items across all locations — coming in a later update.
                    </div>
                  )}
                  {canLabel && draftCollision && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#b45309' }}>
                      <AlertTriangle size={13} /> Matches a built-in categorization name — items could group unexpectedly.
                    </div>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>

      <p style={{ fontSize: 12, color: '#94a3b8', margin: '10px 2px 0' }}>
        {categories.length} categor{categories.length === 1 ? 'y' : 'ies'}. Items are tagged by category <em>label</em>; the <code>key</code> is the stable id used for grouping.
      </p>
    </div>
  )
}
