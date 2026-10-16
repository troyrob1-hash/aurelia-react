import { useState, useMemo, useCallback } from 'react'
import { GripVertical, Pencil, Plus, AlertTriangle, X, Trash2 } from 'lucide-react'
import { db } from '@/lib/firebase'
import { doc, setDoc } from 'firebase/firestore'
import { sanitizeDocId } from '@/hooks/useInventory'
import { useDragReorder } from '@/hooks/useDragReorder'
import { PALETTE, slugifyZone, uniqueKey, resolveZones } from '@/lib/zoneHelpers'
import { scanZoneUsageInLocation, reassignZoneInLocation } from '@/lib/inventoryZones'

// Lean, LOCATION-SCOPED inventory ZONE editor — a direct sibling of
// CategoryManagerModal. Handles add / reorder / color / label edit / delete.
//
// Writes the per-location doc tenants/{orgId}/inventory/{locId}/settings/zones
// (locId = sanitizeDocId(locationId)) as { zones: [...] }. The FIRST write
// materializes the doc — "lazy seed" — from the resolved list the caller passes
// (resolveZones(locZones) === the single default zone until configured), so a
// location with no zones doc is left untouched until a manager edits here.
//
// BACK-COMPAT: the default set is EXACTLY ONE zone. Zone-aware UI elsewhere
// stays hidden until a SECOND zone exists (isSingleDefaultZone). This modal is
// the only zone surface a one-zone location ever shows, and only because a
// manager explicitly opened it.
//
// CRITICAL SAFETY (mirrors CategoryManagerModal):
//   • Deleting a zone that holds counts MERGES those counts into a surviving
//     zone (reassignZoneInLocation) BEFORE the zone is removed — never a silent
//     drop. Dry-run (scan) → confirm → reassign → commit. Phase 0 has no
//     counts-in-zones yet, so the scan returns 0 and the reassign is a no-op,
//     but the path is built correct for Phase 1.
//   • The last zone is NOT deletable — there is always ≥1 zone (the implicit
//     "everything" bucket). The trash control is hidden when only one remains.
//
// Props:
//   orgId, locationId — scope (locationId is the RAW selected location name)
//   zones             — current in-memory list (the seed/initial state); may be
//                       absent/empty, in which case it resolves to one zone
//   onSaved(nextArray)— called after each successful write so the parent can
//                       refresh in-memory zones WITHOUT a reload
//   onClose           — dismiss
export default function ZoneManagerModal({ orgId, locationId, zones, onSaved, onClose }) {
  // Seed from the resolved list so an absent/empty doc still shows the single
  // default zone to edit (and the first write materializes exactly that).
  const [zs, setZs] = useState(() => resolveZones(zones))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)

  // Keys added in THIS session — the only zones whose label is editable here
  // (guaranteed empty; no item can already carry a just-invented zone key).
  const newKeys = useState(() => new Set())[0]

  const [addLabel, setAddLabel] = useState('')
  const [addColorIdx, setAddColorIdx] = useState(0)
  const [editingKey, setEditingKey] = useState(null)
  const [draftLabel, setDraftLabel] = useState('')
  const [draftColorIdx, setDraftColorIdx] = useState(0)
  const [editError, setEditError] = useState(null)

  // Single-location migration flow (delete/merge). null when idle; otherwise:
  //   { phase:'scanning'|'confirm'|'running'|'error', zone, toKey, toLabel,
  //     count, progress, error }
  const [migration, setMigration] = useState(null)

  // Persist the full array to the per-location zones doc, then bubble up.
  const persist = useCallback(async (nextArray) => {
    setError(null)
    setSaving(true)
    const prev = zs
    setZs(nextArray) // optimistic
    try {
      const locId = sanitizeDocId(locationId)
      await setDoc(
        doc(db, 'tenants', orgId, 'inventory', locId, 'settings', 'zones'),
        { zones: nextArray },
        { merge: true }
      )
      onSaved?.(nextArray)
    } catch (e) {
      setError('Save failed: ' + (e.message || 'unknown error'))
      setZs(prev) // revert
    } finally {
      setSaving(false)
    }
  }, [zs, orgId, locationId, onSaved])

  // Non-optimistic commit for the delete flow: write the doc, THEN update local
  // + bubble up. Throws on failure so the caller keeps the doc un-flipped and
  // offers Retry (the commit point — only AFTER the item reassign).
  const commitArray = useCallback(async (nextArray) => {
    const locId = sanitizeDocId(locationId)
    await setDoc(
      doc(db, 'tenants', orgId, 'inventory', locId, 'settings', 'zones'),
      { zones: nextArray },
      { merge: true }
    )
    setZs(nextArray)
    onSaved?.(nextArray)
  }, [orgId, locationId, onSaved])

  // ── Drag reorder (reuse the shelf-to-sheet hook) ────────────────────────────
  const dragGroups = useMemo(
    () => [{ key: '__zones__', items: zs.map(z => ({ ...z, id: z.key })) }],
    [zs]
  )
  const handleReorder = useCallback((_g, orderedIds) => {
    const byKey = new Map(zs.map(z => [z.key, z]))
    const next = orderedIds.map(id => byKey.get(id)).filter(Boolean)
    for (const z of zs) if (!orderedIds.includes(z.key)) next.push(z)
    if (next.length === zs.length) persist(next)
  }, [zs, persist])
  const { groups: liveGroups, getHandleProps, registerRow, draggingId } =
    useDragReorder({ groups: dragGroups, onReorder: handleReorder })

  const handleAdd = () => {
    const label = addLabel.trim()
    if (!label) return
    const key = uniqueKey(slugifyZone(label), zs.map(z => z.key))
    const { color, bg } = PALETTE[addColorIdx % PALETTE.length]
    newKeys.add(key)
    persist([...zs, { key, label, color, bg }])
    setAddLabel('')
    setAddColorIdx(i => (i + 1) % PALETTE.length)
  }

  const startEdit = (zone) => {
    setEditingKey(zone.key)
    setDraftLabel(zone.label || '')
    setEditError(null)
    const idx = PALETTE.findIndex(p => p.color === zone.color)
    setDraftColorIdx(idx >= 0 ? idx : 0)
  }
  const cancelEdit = () => { setEditingKey(null); setEditError(null) }
  const saveEdit = (zone) => {
    const { color, bg } = PALETTE[draftColorIdx % PALETTE.length]
    const newLabel = draftLabel.trim()
    const labelChanged = newLabel && newLabel !== zone.label

    // Color-only / unchanged label → direct write. A zone's label is display
    // text only (items key off zone.key, which never changes on rename), so a
    // rename is ALWAYS a pure array write — no item re-tag is ever needed.
    if (!labelChanged) {
      persist(zs.map(z => z.key === zone.key ? { ...z, color, bg } : z))
      setEditingKey(null)
      return
    }
    // Block renaming onto an existing label (case-insensitive).
    if (zs.some(z => z.key !== zone.key && (z.label || '').toLowerCase() === newLabel.toLowerCase())) {
      setEditError(`A zone named “${newLabel}” already exists.`)
      return
    }
    persist(zs.map(z => z.key === zone.key ? { ...z, label: newLabel, color, bg } : z))
    setEditingKey(null)
  }

  // Delete a zone → merge its items into a surviving zone. Guard (can't delete
  // the last zone) is enforced at the trash control. Dry-run, then confirm.
  const beginDelete = (zone) => {
    // The merge sink: the first OTHER zone in order. There is always one because
    // the trash control is hidden when only a single zone remains.
    const sink = zs.find(z => z.key !== zone.key)
    if (!sink) return // defensive — should never happen (guarded at the control)
    setMigration({ phase: 'scanning', zone, toKey: sink.key, toLabel: sink.label })
    scanZoneUsageInLocation(orgId, locationId, zone.key)
      .then(count => setMigration(m => m ? { ...m, phase: 'confirm', count } : m))
      .catch(e => setMigration(m => m ? { ...m, phase: 'error', error: 'Scan failed: ' + (e.message || 'unknown error') } : m))
  }

  // Run (or retry) the delete: merge THIS zone's items into the sink zone, then
  // flip the per-location zones doc as the commit point. Convergence — the doc
  // flip ALWAYS happens after the reassign resolves (even if the re-scan finds
  // 0: a prior partial run already merged, or Phase 0 has no zone-tagged items).
  // A failure leaves the doc un-flipped → Retry. Items are NEVER dropped: the
  // reassign runs before the zone is removed.
  const runMigration = async () => {
    const m = migration
    if (!m) return
    setMigration({ ...m, phase: 'running', progress: { done: 0, total: m.count || 0 }, error: null })
    const onProg = (p) => setMigration(prev => (prev ? { ...prev, progress: p } : prev))
    try {
      // (a) Merge the deleted zone's items into the sink zone (skip if none).
      if (m.count > 0) {
        await reassignZoneInLocation(orgId, locationId, m.zone.key, m.toKey, onProg)
      }
      // (b) Commit point — remove the deleted zone (sink already present).
      await commitArray(zs.filter(z => z.key !== m.zone.key))
      setMigration(null)
      setEditingKey(null)
    } catch (e) {
      setMigration(prev => (prev ? { ...prev, phase: 'error', error: e.message || 'Delete failed' } : prev))
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
            <h3 style={{ fontSize: 16, fontWeight: 600, color: '#0f172a', margin: 0 }}>Manage zones</h3>
            <div style={{ fontSize: 12, color: '#64748b', marginTop: 2 }}>{locationId} · counting zones apply to this location only</div>
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
              placeholder="New zone name"
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

          {/* List */}
          <div style={{ border: '1px solid #e2e8f0', borderRadius: 10, overflow: 'hidden', marginTop: 8 }}>
            {rows.map((zone, idx) => {
              const isEditing = editingKey === zone.key
              const isDragging = draggingId === zone.key
              return (
                <div key={zone.key} ref={el => registerRow('__zones__', zone.key, el)}
                  style={{ padding: '10px 12px', borderTop: idx === 0 ? 'none' : '1px solid #f1f5f9', background: isDragging ? '#ecfdf5' : '#fff', boxShadow: isDragging ? '0 6px 16px rgba(15,23,42,0.12)' : 'none', position: 'relative', zIndex: isDragging ? 2 : 1 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <span {...getHandleProps('__zones__', zone.key)} title="Drag to reorder">
                      <GripVertical size={16} color={isDragging ? '#1D9E75' : '#cbd5e1'} style={{ display: 'block' }} />
                    </span>
                    <span style={{ width: 22, height: 22, borderRadius: 6, flexShrink: 0, background: zone.bg || '#f3f4f6', border: `2px solid ${zone.color || '#cbd5e1'}` }} />

                    {isEditing ? (
                      <input
                        value={draftLabel}
                        onChange={e => { setDraftLabel(e.target.value); setEditError(null) }}
                        onKeyDown={e => { if (e.key === 'Enter') saveEdit(zone) }}
                        style={{ flex: 1, padding: '5px 8px', fontSize: 13, borderRadius: 6, border: '1px solid #cbd5e1', background: '#fff', color: '#0f172a' }}
                      />
                    ) : (
                      <span style={{ flex: 1, fontSize: 14, fontWeight: 500, color: zone.color || '#0f172a', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {zone.label || <span style={{ color: '#cbd5e1' }}>(no label)</span>}
                      </span>
                    )}

                    <span style={{ fontSize: 12, color: '#64748b', fontFamily: 'ui-monospace, Menlo, monospace', minWidth: 90, textAlign: 'right' }}>{zone.key}</span>

                    {isEditing ? (
                      <div style={{ display: 'flex', gap: 6 }}>
                        <button onClick={() => saveEdit(zone)} disabled={saving} style={{ padding: '5px 10px', fontSize: 12, fontWeight: 600, border: 'none', borderRadius: 6, background: '#1D9E75', color: '#fff', cursor: 'pointer' }}>Save</button>
                        <button onClick={cancelEdit} style={{ padding: '5px 10px', fontSize: 12, fontWeight: 500, border: '1px solid #cbd5e1', borderRadius: 6, background: '#fff', color: '#475569', cursor: 'pointer' }}>Cancel</button>
                      </div>
                    ) : (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                        <button onClick={() => startEdit(zone)} title="Edit color / label" style={{ display: 'flex', alignItems: 'center', background: 'none', border: 'none', cursor: 'pointer', color: '#94a3b8', padding: 4 }}>
                          <Pencil size={14} />
                        </button>
                        {/* Delete — hidden when only one zone remains (there must
                            always be ≥1 zone: the implicit "everything" bucket). */}
                        {zs.length > 1 && (
                          <button onClick={() => beginDelete(zone)} title="Delete zone (items merge into another zone)" style={{ display: 'flex', alignItems: 'center', background: 'none', border: 'none', cursor: 'pointer', color: '#cbd5e1', padding: 4 }}>
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
            {zs.length} zone{zs.length === 1 ? '' : 's'} for this location. Drag to reorder; pencil to recolor or rename.
            {zs.length === 1 ? ' Add a second zone to split counting by area.' : ''}
          </p>
        </div>

        {/* Footer */}
        <div style={{ padding: '12px 20px', borderTop: '1px solid #e5e7eb', display: 'flex', justifyContent: 'flex-end' }}>
          <button onClick={onClose} style={{ padding: '8px 16px', fontSize: 13, fontWeight: 600, border: 'none', borderRadius: 8, background: '#1D9E75', color: '#fff', cursor: 'pointer' }}>Done</button>
        </div>
      </div>

      {/* ── Delete / merge overlay (above the editor) ── */}
      {migration && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.45)', zIndex: 4100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
          <div style={{ background: '#fff', borderRadius: 12, boxShadow: '0 20px 60px rgba(15,23,42,0.25)', width: 440, maxWidth: '100%', padding: 22 }}>
            <h3 style={{ fontSize: 16, fontWeight: 600, color: '#0f172a', margin: '0 0 10px' }}>Delete zone</h3>
            <div style={{ fontSize: 14, color: '#334155', marginBottom: 16, lineHeight: 1.5 }}>
              <span style={{ fontWeight: 600 }}>“{migration.zone?.label}”</span>
            </div>

            {migration.phase === 'scanning' && (
              <div style={{ fontSize: 13, color: '#64748b' }}>Scanning items at this location…</div>
            )}

            {migration.phase === 'confirm' && (
              <>
                <div style={{ fontSize: 13, color: '#475569', marginBottom: 18, lineHeight: 1.5 }}>
                  {migration.count > 0 ? (
                    <><strong>{migration.count}</strong> counted item{migration.count === 1 ? '' : 's'} move to <strong>“{migration.toLabel}”</strong> at <strong>{locationId}</strong>. Counts are never dropped. This can’t be undone in bulk.</>
                  ) : (
                    <>No counts are tagged to this zone here — it will just be removed.</>
                  )}
                </div>
                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                  <button onClick={cancelMigration} style={{ padding: '8px 14px', fontSize: 13, fontWeight: 500, border: '1px solid #cbd5e1', borderRadius: 8, background: '#fff', color: '#475569', cursor: 'pointer' }}>Cancel</button>
                  <button onClick={runMigration} style={{ padding: '8px 14px', fontSize: 13, fontWeight: 600, border: 'none', borderRadius: 8, background: '#dc2626', color: '#fff', cursor: 'pointer' }}>Delete</button>
                </div>
              </>
            )}

            {migration.phase === 'running' && (
              <div style={{ fontSize: 13, color: '#475569' }}>
                Moving {migration.progress?.done ?? 0} of {migration.progress?.total ?? 0} item{(migration.progress?.total ?? 0) === 1 ? '' : 's'} to “{migration.toLabel}”…
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
                  The zone was not deleted. Retry moves only what’s left to “{migration.toLabel}”, then removes it. Safe to run again.
                </div>
                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                  <button onClick={cancelMigration} style={{ padding: '8px 14px', fontSize: 13, fontWeight: 500, border: '1px solid #cbd5e1', borderRadius: 8, background: '#fff', color: '#475569', cursor: 'pointer' }}>Cancel</button>
                  <button onClick={runMigration} style={{ padding: '8px 14px', fontSize: 13, fontWeight: 600, border: 'none', borderRadius: 8, background: '#1D9E75', color: '#fff', cursor: 'pointer' }}>Retry</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
