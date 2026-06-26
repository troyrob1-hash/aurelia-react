import { useState, useMemo, useCallback } from 'react'
import { GripVertical, Pencil, Plus, AlertTriangle, X } from 'lucide-react'
import { db } from '@/lib/firebase'
import { doc, setDoc } from 'firebase/firestore'
import { sanitizeDocId } from '@/hooks/useInventory'
import { useDragReorder } from '@/hooks/useDragReorder'
import { PALETTE, slugify, uniqueKey, collidesWithKeyMap } from '@/lib/categoryHelpers'

// Lean, LOCATION-SCOPED inventory category editor (Phase B). Handles the SAFE
// operations only — add / reorder / color / safe-label-edit (session-new
// categories). The populated-category RENAME migration and DELETE are Phase C
// (single-location versions) and deliberately absent here.
//
// Writes the per-location doc tenants/{orgId}/inventory/{locId}/settings/categories
// (locId = sanitizeDocId(locationId)). The FIRST write materializes the doc —
// "lazy seed" — from the passed-in `categories`, which the caller already
// resolved (Phase A) to locCats || global || defaults, so nothing is lost.
//
// Props:
//   orgId, locationId — scope (locationId is the RAW selected location name)
//   categories        — current in-memory list (the seed/initial state)
//   onSaved(nextArray)— called after each successful write so the parent can
//                       refresh in-memory categories WITHOUT a reload
//   onClose           — dismiss
export default function CategoryManagerModal({ orgId, locationId, categories, onSaved, onClose }) {
  const [cats, setCats] = useState(() => (Array.isArray(categories) ? categories : []))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)

  // Keys added in THIS session — the only categories whose label is editable
  // here (guaranteed empty; no item can already carry a just-invented label).
  // Pre-existing categories' labels are locked (populated rename = Phase C).
  const newKeys = useState(() => new Set())[0]

  const [addLabel, setAddLabel] = useState('')
  const [addColorIdx, setAddColorIdx] = useState(0)
  const [editingKey, setEditingKey] = useState(null)
  const [draftLabel, setDraftLabel] = useState('')
  const [draftColorIdx, setDraftColorIdx] = useState(0)
  const [editError, setEditError] = useState(null)

  // Persist the full array to the per-location doc, then bubble up on success.
  const persist = useCallback(async (nextArray) => {
    setError(null)
    setSaving(true)
    const prev = cats
    setCats(nextArray) // optimistic
    try {
      const locId = sanitizeDocId(locationId)
      await setDoc(
        doc(db, 'tenants', orgId, 'inventory', locId, 'settings', 'categories'),
        { categories: nextArray }, // full array; spreads at call sites keep keywords + rx
        { merge: true }
      )
      onSaved?.(nextArray)
    } catch (e) {
      setError('Save failed: ' + (e.message || 'unknown error'))
      setCats(prev) // revert
    } finally {
      setSaving(false)
    }
  }, [cats, orgId, locationId, onSaved])

  // ── Drag reorder (reuse the shelf-to-sheet hook) ────────────────────────────
  const dragGroups = useMemo(
    () => [{ key: '__cats__', items: cats.map(c => ({ ...c, id: c.key })) }],
    [cats]
  )
  const handleReorder = useCallback((_g, orderedIds) => {
    const byKey = new Map(cats.map(c => [c.key, c]))
    const next = orderedIds.map(id => byKey.get(id)).filter(Boolean)
    for (const c of cats) if (!orderedIds.includes(c.key)) next.push(c)
    if (next.length === cats.length) persist(next)
  }, [cats, persist])
  const { groups: liveGroups, getHandleProps, registerRow, draggingId } =
    useDragReorder({ groups: dragGroups, onReorder: handleReorder })

  const addCollision = collidesWithKeyMap(addLabel) || collidesWithKeyMap(slugify(addLabel))
  const draftCollision = collidesWithKeyMap(draftLabel) || collidesWithKeyMap(slugify(draftLabel))

  const handleAdd = () => {
    const label = addLabel.trim()
    if (!label) return
    const key = uniqueKey(slugify(label), cats.map(c => c.key))
    const { color, bg } = PALETTE[addColorIdx % PALETTE.length]
    newKeys.add(key)
    persist([...cats, { key, label, color, bg, keywords: [] }])
    setAddLabel('')
    setAddColorIdx(i => (i + 1) % PALETTE.length)
  }

  const startEdit = (cat) => {
    setEditingKey(cat.key)
    setDraftLabel(cat.label || '')
    setEditError(null)
    const idx = PALETTE.findIndex(p => p.color === cat.color)
    setDraftColorIdx(idx >= 0 ? idx : 0)
  }
  const cancelEdit = () => { setEditingKey(null); setEditError(null) }
  const saveEdit = (cat) => {
    const { color, bg } = PALETTE[draftColorIdx % PALETTE.length]
    const newLabel = draftLabel.trim()
    const labelChanged = newLabel && newLabel !== cat.label

    // Color-only / unchanged label → direct write.
    if (!labelChanged) {
      persist(cats.map(c => c.key === cat.key ? { ...c, color, bg } : c))
      setEditingKey(null)
      return
    }
    // Block renaming onto an existing label (case-insensitive).
    if (cats.some(c => c.key !== cat.key && (c.label || '').toLowerCase() === newLabel.toLowerCase())) {
      setEditError(`A category named “${newLabel}” already exists.`)
      return
    }
    // Only session-new categories may be label-edited here (no items can carry a
    // just-invented label). Populated rename = Phase C.
    if (!newKeys.has(cat.key)) {
      setEditError('Renaming an existing category re-tags its items — coming soon.')
      return
    }
    persist(cats.map(c => c.key === cat.key ? { ...c, label: newLabel, color, bg } : c))
    setEditingKey(null)
  }

  const rows = liveGroups[0]?.items || []

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.45)', zIndex: 4000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
      <div style={{ background: '#fff', borderRadius: 12, boxShadow: '0 20px 60px rgba(15,23,42,0.25)', width: 640, maxWidth: '100%', maxHeight: '85vh', display: 'flex', flexDirection: 'column' }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', padding: '18px 20px 12px', borderBottom: '1px solid #e5e7eb' }}>
          <div>
            <h3 style={{ fontSize: 16, fontWeight: 600, color: '#0f172a', margin: 0 }}>Manage categories</h3>
            <div style={{ fontSize: 12, color: '#64748b', marginTop: 2 }}>{locationId} · these groupings apply to this location only</div>
          </div>
          <button onClick={onClose} title="Close" style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#94a3b8', padding: 2, lineHeight: 1 }}>
            <X size={20} />
          </button>
        </div>

        {/* Body */}
        <div style={{ padding: '14px 20px', overflowY: 'auto' }}>
          {error && (
            <div style={{ marginBottom: 12, padding: '8px 12px', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, color: '#b91c1c', fontSize: 13 }}>{error}</div>
          )}

          {/* Add form */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, padding: 12, background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 10 }}>
            <input
              value={addLabel}
              onChange={e => setAddLabel(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') handleAdd() }}
              placeholder="New category name"
              style={{ flex: 1, padding: '7px 10px', fontSize: 13, border: '1px solid #cbd5e1', borderRadius: 6 }}
            />
            <div style={{ display: 'flex', gap: 4 }}>
              {PALETTE.map((p, i) => (
                <button key={p.color} onClick={() => setAddColorIdx(i)} title={p.color}
                  style={{ width: 20, height: 20, borderRadius: 5, cursor: 'pointer', background: p.bg, border: `2px solid ${p.color}`, outline: addColorIdx === i ? '2px solid #0f172a' : 'none', outlineOffset: 1 }} />
              ))}
            </div>
            <button onClick={handleAdd} disabled={!addLabel.trim() || saving}
              style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '7px 12px', fontSize: 13, fontWeight: 600, border: 'none', borderRadius: 6, cursor: addLabel.trim() && !saving ? 'pointer' : 'not-allowed', background: addLabel.trim() && !saving ? '#1D9E75' : '#e2e8f0', color: addLabel.trim() && !saving ? '#fff' : '#94a3b8' }}>
              <Plus size={14} /> Add
            </button>
          </div>
          {addCollision && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, margin: '0 2px 10px', fontSize: 12, color: '#b45309' }}>
              <AlertTriangle size={13} /> “{addLabel.trim()}” matches a built-in categorization name — items could group unexpectedly. You can still add it.
            </div>
          )}

          {/* List */}
          <div style={{ border: '1px solid #e2e8f0', borderRadius: 10, overflow: 'hidden', marginTop: 8 }}>
            {rows.map((cat, idx) => {
              const isEditing = editingKey === cat.key
              const canLabel = newKeys.has(cat.key)
              const isDragging = draggingId === cat.key
              return (
                <div key={cat.key} ref={el => registerRow('__cats__', cat.key, el)}
                  style={{ padding: '10px 12px', borderTop: idx === 0 ? 'none' : '1px solid #f1f5f9', background: isDragging ? '#ecfdf5' : '#fff', boxShadow: isDragging ? '0 6px 16px rgba(15,23,42,0.12)' : 'none', position: 'relative', zIndex: isDragging ? 2 : 1 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <span {...getHandleProps('__cats__', cat.key)} title="Drag to reorder">
                      <GripVertical size={16} color={isDragging ? '#1D9E75' : '#cbd5e1'} style={{ display: 'block' }} />
                    </span>
                    <span style={{ width: 22, height: 22, borderRadius: 6, flexShrink: 0, background: cat.bg || '#f3f4f6', border: `2px solid ${cat.color || '#cbd5e1'}` }} />

                    {isEditing ? (
                      <input
                        value={draftLabel}
                        onChange={e => { setDraftLabel(e.target.value); setEditError(null) }}
                        onKeyDown={e => { if (e.key === 'Enter') saveEdit(cat) }}
                        disabled={!canLabel}
                        title={canLabel ? '' : 'Renaming an existing category re-tags its items — coming soon'}
                        style={{ flex: 1, padding: '5px 8px', fontSize: 13, borderRadius: 6, border: '1px solid #cbd5e1', background: canLabel ? '#fff' : '#f1f5f9', color: canLabel ? '#0f172a' : '#94a3b8' }}
                      />
                    ) : (
                      <span style={{ flex: 1, fontSize: 14, fontWeight: 500, color: cat.color || '#0f172a', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {cat.label || <span style={{ color: '#cbd5e1' }}>(no label)</span>}
                      </span>
                    )}

                    <span style={{ fontSize: 12, color: '#64748b', fontFamily: 'ui-monospace, Menlo, monospace', minWidth: 90, textAlign: 'right' }}>{cat.key}</span>

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
                          <button key={p.color} onClick={() => setDraftColorIdx(i)} title={p.color}
                            style={{ width: 20, height: 20, borderRadius: 5, cursor: 'pointer', background: p.bg, border: `2px solid ${p.color}`, outline: draftColorIdx === i ? '2px solid #0f172a' : 'none', outlineOffset: 1 }} />
                        ))}
                      </div>
                      {!canLabel && (
                        <div style={{ fontSize: 12, color: '#94a3b8' }}>
                          Color is editable. Renaming a category that already has items re-tags them across this location — coming soon.
                        </div>
                      )}
                      {draftCollision && (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#b45309' }}>
                          <AlertTriangle size={13} /> Matches a built-in categorization name — items could group unexpectedly.
                        </div>
                      )}
                      {editError && (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#b91c1c' }}>
                          <AlertTriangle size={13} /> {editError}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>

          <p style={{ fontSize: 12, color: '#94a3b8', margin: '10px 2px 0' }}>
            {cats.length} categor{cats.length === 1 ? 'y' : 'ies'} for this location. Drag to reorder; pencil to recolor.
            Renaming a category that already has items, and deleting, arrive in a later update.
          </p>
        </div>

        {/* Footer */}
        <div style={{ padding: '12px 20px', borderTop: '1px solid #e5e7eb', display: 'flex', justifyContent: 'flex-end' }}>
          <button onClick={onClose} style={{ padding: '8px 16px', fontSize: 13, fontWeight: 600, border: 'none', borderRadius: 8, background: '#1D9E75', color: '#fff', cursor: 'pointer' }}>Done</button>
        </div>
      </div>
    </div>
  )
}
