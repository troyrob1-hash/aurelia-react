import { useState, useMemo, useCallback } from 'react'
import { GripVertical, Pencil, Plus, AlertTriangle, X, Trash2 } from 'lucide-react'
import { db } from '@/lib/firebase'
import { doc, setDoc } from 'firebase/firestore'
import { sanitizeDocId, getDefaultCategories } from '@/hooks/useInventory'
import { useDragReorder } from '@/hooks/useDragReorder'
import { PALETTE, slugify, uniqueKey, collidesWithKeyMap } from '@/lib/categoryHelpers'
import { scanCategoryUsageInLocation, renameCategoryInLocation } from '@/lib/inventoryCategories'

// Lean, LOCATION-SCOPED inventory category editor. Handles add / reorder /
// color / label edit. Renaming a category that already has items re-tags THIS
// location's items (single-location migration, Phase C) then flips this
// location's category doc as the commit point. DELETE is Phase C step 3.
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

  // Single-location migration flow (populated rename + delete). null when idle;
  // otherwise: { kind:'rename'|'delete', phase:'scanning'|'confirm'|'running'|
  //   'error', cat, oldLabel, newLabel?, color?, bg?, count, progress, error }
  const [migration, setMigration] = useState(null)

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

  // Non-optimistic commit for the rename flow: write the doc, THEN update local
  // + bubble up. Throws on failure so the caller keeps the doc un-flipped and
  // offers Retry (the convergence commit point — only AFTER the item re-tag).
  const commitArray = useCallback(async (nextArray) => {
    const locId = sanitizeDocId(locationId)
    await setDoc(
      doc(db, 'tenants', orgId, 'inventory', locId, 'settings', 'categories'),
      { categories: nextArray },
      { merge: true }
    )
    setCats(nextArray)
    onSaved?.(nextArray)
  }, [orgId, locationId, onSaved])

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
    // Session-new category → no item can carry this just-invented label, so a
    // rename is a pure array write (no migration).
    if (newKeys.has(cat.key)) {
      persist(cats.map(c => c.key === cat.key ? { ...c, label: newLabel, color, bg } : c))
      setEditingKey(null)
      return
    }

    // Pre-existing category → single-location migration: dry-run, then confirm.
    setEditError(null)
    setMigration({ kind: 'rename', phase: 'scanning', cat, oldLabel: cat.label, newLabel, color, bg })
    scanCategoryUsageInLocation(orgId, locationId, cat.label)
      .then(count => setMigration(m => m ? { ...m, phase: 'confirm', count } : m))
      .catch(e => setMigration(m => m ? { ...m, phase: 'error', error: 'Scan failed: ' + (e.message || 'unknown error') } : m))
  }

  // Delete a category → reassign its items to General. Guards (can't delete
  // General or the last category) are enforced at the trash control. Dry-run,
  // then confirm.
  const beginDelete = (cat) => {
    setMigration({ kind: 'delete', phase: 'scanning', cat, oldLabel: cat.label })
    scanCategoryUsageInLocation(orgId, locationId, cat.label)
      .then(count => setMigration(m => m ? { ...m, phase: 'confirm', count } : m))
      .catch(e => setMigration(m => m ? { ...m, phase: 'error', error: 'Scan failed: ' + (e.message || 'unknown error') } : m))
  }

  // Run (or retry) the migration: re-tag THIS location's items, then flip the
  // per-location doc as the commit point. Convergence — the doc flip ALWAYS
  // happens after the re-tag resolves (even if the re-scan finds 0: a prior
  // partial run already migrated). A failure leaves the doc un-flipped → Retry.
  const runMigration = async () => {
    const m = migration
    if (!m) return
    setMigration({ ...m, phase: 'running', progress: { done: 0, total: m.count || 0 }, error: null })
    const onProg = (p) => setMigration(prev => (prev ? { ...prev, progress: p } : prev))
    try {
      if (m.kind === 'delete') {
        // (a) Ensure General exists in the doc BEFORE reassigning, so re-tagged
        //     items never orphan (only needed when items will actually move).
        let working = cats
        if (m.count > 0 && !cats.some(c => (c.label || '').toLowerCase() === 'general')) {
          const general = getDefaultCategories().find(c => c.key === 'general')
            || { key: 'general', label: 'General', color: '#374151', bg: '#f3f4f6', keywords: [] }
          working = [...cats, { ...general }]
          await commitArray(working)
        }
        // (b) Re-tag the deleted category's items → General (skip if none).
        if (m.count > 0) {
          await renameCategoryInLocation(orgId, locationId, m.oldLabel, 'General', onProg)
        }
        // (c) Commit point — remove the deleted category (General now present).
        await commitArray(working.filter(c => c.key !== m.cat.key))
      } else {
        await renameCategoryInLocation(orgId, locationId, m.oldLabel, m.newLabel, onProg)
        // Commit point — flip the per-location categories doc AFTER the re-tag.
        await commitArray(cats.map(c => c.key === m.cat.key ? { ...c, label: m.newLabel, color: m.color, bg: m.bg } : c))
      }
      setMigration(null)
      setEditingKey(null)
    } catch (e) {
      setMigration(prev => (prev ? { ...prev, phase: 'error', error: e.message || 'Migration failed' } : prev))
    }
  }
  const cancelMigration = () => setMigration(null)

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
                        style={{ flex: 1, padding: '5px 8px', fontSize: 13, borderRadius: 6, border: '1px solid #cbd5e1', background: '#fff', color: '#0f172a' }}
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
                      <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                        <button onClick={() => startEdit(cat)} title="Edit color / label" style={{ display: 'flex', alignItems: 'center', background: 'none', border: 'none', cursor: 'pointer', color: '#94a3b8', padding: 4 }}>
                          <Pencil size={14} />
                        </button>
                        {/* Delete — hidden for General (the reassignment sink) and
                            when only one category remains. */}
                        {(cat.label || '').toLowerCase() !== 'general' && cats.length > 1 && (
                          <button onClick={() => beginDelete(cat)} title="Delete category (items move to General)" style={{ display: 'flex', alignItems: 'center', background: 'none', border: 'none', cursor: 'pointer', color: '#cbd5e1', padding: 4 }}>
                            <Trash2 size={14} />
                          </button>
                        )}
                      </div>
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
                      {!newKeys.has(cat.key) && (
                        <div style={{ fontSize: 12, color: '#94a3b8' }}>
                          Renaming re-tags every item carrying “{cat.label}” at this location — you’ll see a count to confirm before anything is written.
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
            {cats.length} categor{cats.length === 1 ? 'y' : 'ies'} for this location. Drag to reorder; pencil to recolor or rename.
            Deleting categories arrives in a later update.
          </p>
        </div>

        {/* Footer */}
        <div style={{ padding: '12px 20px', borderTop: '1px solid #e5e7eb', display: 'flex', justifyContent: 'flex-end' }}>
          <button onClick={onClose} style={{ padding: '8px 16px', fontSize: 13, fontWeight: 600, border: 'none', borderRadius: 8, background: '#1D9E75', color: '#fff', cursor: 'pointer' }}>Done</button>
        </div>
      </div>

      {/* ── Migration overlay (rename / delete, above the editor) ── */}
      {migration && (() => {
        const isDelete = migration.kind === 'delete'
        return (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.45)', zIndex: 4100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
          <div style={{ background: '#fff', borderRadius: 12, boxShadow: '0 20px 60px rgba(15,23,42,0.25)', width: 440, maxWidth: '100%', padding: 22 }}>
            <h3 style={{ fontSize: 16, fontWeight: 600, color: '#0f172a', margin: '0 0 10px' }}>
              {isDelete ? 'Delete category' : 'Rename category'}
            </h3>
            <div style={{ fontSize: 14, color: '#334155', marginBottom: 16, lineHeight: 1.5 }}>
              {isDelete ? (
                <span style={{ fontWeight: 600 }}>“{migration.oldLabel}”</span>
              ) : (
                <>
                  <span style={{ fontWeight: 600 }}>“{migration.oldLabel}”</span> →{' '}
                  <span style={{ fontWeight: 600 }}>“{migration.newLabel}”</span>
                </>
              )}
            </div>

            {migration.phase === 'scanning' && (
              <div style={{ fontSize: 13, color: '#64748b' }}>Scanning items at this location…</div>
            )}

            {migration.phase === 'confirm' && (
              <>
                <div style={{ fontSize: 13, color: '#475569', marginBottom: 18, lineHeight: 1.5 }}>
                  {migration.count > 0 ? (
                    isDelete ? (
                      <><strong>{migration.count}</strong> item{migration.count === 1 ? '' : 's'} move to <strong>General</strong> at <strong>{locationId}</strong>. This can’t be undone in bulk.</>
                    ) : (
                      <>This re-tags <strong>{migration.count}</strong> item{migration.count === 1 ? '' : 's'} at <strong>{locationId}</strong>. This can’t be undone in bulk.</>
                    )
                  ) : (
                    isDelete ? (
                      <>No items carry this label here — the category will just be removed.</>
                    ) : (
                      <>No items carry this label here — this is a <strong>name-only</strong> change.</>
                    )
                  )}
                </div>
                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                  <button onClick={cancelMigration} style={{ padding: '8px 14px', fontSize: 13, fontWeight: 500, border: '1px solid #cbd5e1', borderRadius: 8, background: '#fff', color: '#475569', cursor: 'pointer' }}>Cancel</button>
                  <button onClick={runMigration} style={{ padding: '8px 14px', fontSize: 13, fontWeight: 600, border: 'none', borderRadius: 8, background: isDelete ? '#dc2626' : '#1D9E75', color: '#fff', cursor: 'pointer' }}>{isDelete ? 'Delete' : 'Rename'}</button>
                </div>
              </>
            )}

            {migration.phase === 'running' && (
              <div style={{ fontSize: 13, color: '#475569' }}>
                {isDelete ? 'Moving' : 'Re-tagging'} {migration.progress?.done ?? 0} of {migration.progress?.total ?? 0} item{(migration.progress?.total ?? 0) === 1 ? '' : 's'}{isDelete ? ' to General' : ''}…
                <div style={{ marginTop: 10, height: 6, borderRadius: 3, background: '#e2e8f0', overflow: 'hidden' }}>
                  <div style={{ height: '100%', background: '#1D9E75', width: `${migration.progress?.total ? Math.round((migration.progress.done / migration.progress.total) * 100) : 0}%`, transition: 'width 0.2s' }} />
                </div>
                <div style={{ marginTop: 8, fontSize: 12, color: '#94a3b8' }}>Don’t close this until it finishes.</div>
              </div>
            )}

            {migration.phase === 'error' && (
              <>
                <div style={{ fontSize: 13, color: '#b91c1c', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
                  <AlertTriangle size={14} /> {migration.error}
                </div>
                <div style={{ fontSize: 12, color: '#64748b', marginBottom: 16, lineHeight: 1.5 }}>
                  {isDelete
                    ? 'The category was not deleted. Retry moves only what’s left to General, then removes it. Safe to run again.'
                    : 'The category name was not changed. Retry re-tags only what’s left, then applies the rename. Safe to run again.'}
                </div>
                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                  <button onClick={cancelMigration} style={{ padding: '8px 14px', fontSize: 13, fontWeight: 500, border: '1px solid #cbd5e1', borderRadius: 8, background: '#fff', color: '#475569', cursor: 'pointer' }}>Cancel</button>
                  <button onClick={runMigration} style={{ padding: '8px 14px', fontSize: 13, fontWeight: 600, border: 'none', borderRadius: 8, background: '#1D9E75', color: '#fff', cursor: 'pointer' }}>Retry</button>
                </div>
              </>
            )}
          </div>
        </div>
        )
      })()}
    </div>
  )
}
