import { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import { GripVertical, Pencil, Plus, AlertTriangle } from 'lucide-react'
import { useAuthStore } from '@/store/authStore'
import { db } from '@/lib/firebase'
import { doc, getDoc, setDoc } from 'firebase/firestore'
import { getDefaultCategories } from '@/hooks/useInventory'
import { useDragReorder } from '@/hooks/useDragReorder'
import { scanCategoryUsage, scanAllCategoryCounts, renameCategoryAcrossLocations } from '@/lib/inventoryCategories'
import { PALETTE, slugify, uniqueKey, collidesWithKeyMap } from '@/lib/categoryHelpers'

// Category manager — Steps 2 + 3: ADD, REORDER, color/label editing, and the
// populated-category RENAME migration. Pure settings writes go to
// tenants/{orgId}/settings/inventory.categories[]. A rename that touches a
// pre-existing category also re-tags every item carrying the old label across
// ALL locations (src/lib/inventoryCategories.js): items first, then flip the
// settings label LAST as the single commit point (convergence). Item counts
// load on demand only (the all-locations scan is expensive).
//
// PALETTE / slugify / uniqueKey / collidesWithKeyMap now live in
// @/lib/categoryHelpers so the inline per-location editor shares them verbatim.

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
  const [editError, setEditError] = useState(null)   // inline (e.g. duplicate label)
  const [successMsg, setSuccessMsg] = useState(null)  // post-rename banner

  // Rename migration flow. null when idle; otherwise a small state machine:
  //   { phase: 'scanning'|'confirm'|'running'|'error', cat, oldLabel, newLabel,
  //     color, bg, dryRun?, progress?, error? }
  const [renameState, setRenameState] = useState(null)

  // On-demand item counts ({ label: count } | null) for the usage column.
  const [usageCounts, setUsageCounts] = useState(null)
  const [countsLoading, setCountsLoading] = useState(false)

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
    setEditError(null)
    setSuccessMsg(null)
    const idx = PALETTE.findIndex(p => p.color === cat.color)
    setDraftColorIdx(idx >= 0 ? idx : 0)
  }
  const cancelEdit = () => { setEditingKey(null); setSaveError(null); setEditError(null) }

  // Plain settings write used for the rename commit point — applies locally only
  // AFTER the write confirms (NOT optimistic), and throws on failure so the
  // rename flow can keep settings un-flipped and offer Retry.
  const flipSettings = async (nextArray) => {
    await setDoc(doc(db, 'tenants', orgId, 'settings', 'inventory'), { categories: nextArray }, { merge: true })
    setCategories(nextArray)
    setIsCustom(true)
  }

  const saveEdit = (cat) => {
    const { color, bg } = PALETTE[draftColorIdx % PALETTE.length]
    const newLabel = draftLabel.trim()
    const labelChanged = newLabel && newLabel !== cat.label

    // Color-only change (or empty/unchanged label) → direct settings write.
    if (!labelChanged) {
      const next = categories.map(c => c.key === cat.key ? { ...c, color, bg } : c) // spread preserves keywords + rx
      saveCategories(next)
      setEditingKey(null)
      return
    }

    // Block renaming onto an existing label (case-insensitive) — merging two
    // categories is a separate feature, not a rename.
    const dup = categories.some(c => c.key !== cat.key && (c.label || '').toLowerCase() === newLabel.toLowerCase())
    if (dup) { setEditError(`A category named “${newLabel}” already exists.`); return }

    // Session-new category → no item can carry this just-invented label, so a
    // rename is a pure settings write (no migration).
    if (newKeys.current.has(cat.key)) {
      const next = categories.map(c => c.key === cat.key ? { ...c, label: newLabel, color, bg } : c)
      saveCategories(next)
      setEditingKey(null)
      return
    }

    // Pre-existing category → migration path: dry-run, then confirm.
    setEditError(null)
    setRenameState({ phase: 'scanning', cat, oldLabel: cat.label, newLabel, color, bg })
    scanCategoryUsage(orgId, cat.label)
      .then(dry => setRenameState(rs => rs ? { ...rs, phase: 'confirm', dryRun: dry } : rs))
      .catch(e => setRenameState(rs => rs ? { ...rs, phase: 'error', error: 'Scan failed: ' + (e.message || 'unknown error') } : rs))
  }

  // Run (or retry) the rename migration, then flip settings as the commit point.
  // Convergence: we ALWAYS flip settings after the re-tag resolves — even if the
  // re-scan finds 0 (a prior partial run already migrated every item, or the
  // category was empty). A failure leaves settings un-flipped and offers Retry.
  const runRename = async () => {
    const rs = renameState
    if (!rs) return
    setRenameState({ ...rs, phase: 'running', progress: { done: 0, total: rs.dryRun?.totalItems || 0, location: null }, error: null })
    try {
      const result = await renameCategoryAcrossLocations(orgId, rs.oldLabel, rs.newLabel, (p) => {
        setRenameState(prev => (prev ? { ...prev, progress: p } : prev))
      })
      // Commit point — flip the settings label AFTER item re-tags resolve.
      const next = categories.map(c => c.key === rs.cat.key ? { ...c, label: rs.newLabel, color: rs.color, bg: rs.bg } : c)
      await flipSettings(next)
      const locN = rs.dryRun?.locationsAffected?.length || 0
      setRenameState(null)
      setEditingKey(null)
      setSuccessMsg(
        `Renamed “${rs.oldLabel}” → “${rs.newLabel}”` +
        (result.updated
          ? ` · re-tagged ${result.updated} item${result.updated === 1 ? '' : 's'} across ${locN} location${locN === 1 ? '' : 's'}.`
          : ' (name-only — no items carried the old label).')
      )
      if (usageCounts) refreshCountsAfterRename(rs.oldLabel, rs.newLabel, result.updated)
    } catch (e) {
      setRenameState(prev => (prev ? { ...prev, phase: 'error', error: e.message || 'Migration failed' } : prev))
    }
  }
  const cancelRename = () => setRenameState(null)

  // Keep the on-demand counts coherent after a rename without a full re-scan.
  const refreshCountsAfterRename = (oldLabel, newLabel, moved) => {
    setUsageCounts(prev => {
      if (!prev) return prev
      const next = { ...prev }
      const n = moved || prev[oldLabel] || 0
      delete next[oldLabel]
      next[newLabel] = (next[newLabel] || 0) + n
      return next
    })
  }

  const loadCounts = async () => {
    if (!orgId) return
    setCountsLoading(true)
    try {
      setUsageCounts(await scanAllCategoryCounts(orgId))
    } catch (e) {
      setSaveError('Failed to load item counts: ' + (e.message || 'unknown error'))
    } finally {
      setCountsLoading(false)
    }
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
        pencil to recolor or rename. Renaming a category that already has items re-tags every matching item across all
        locations. Deleting categories arrives in a later update.
      </p>

      {saveError && (
        <div style={{ marginBottom: 12, padding: '8px 12px', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, color: '#b91c1c', fontSize: 13 }}>
          {saveError}
        </div>
      )}
      {successMsg && (
        <div style={{ marginBottom: 12, padding: '8px 12px', background: '#ecfdf5', border: '1px solid #a7f3d0', borderRadius: 8, color: '#166534', fontSize: 13 }}>
          {successMsg}
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

      {/* ── Usage counts toolbar ── */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', marginBottom: 8 }}>
        <button
          onClick={loadCounts}
          disabled={countsLoading}
          title="Scan all locations and tally how many items carry each category label"
          style={{
            fontSize: 12, fontWeight: 600, padding: '5px 10px', borderRadius: 6, cursor: countsLoading ? 'wait' : 'pointer',
            border: '1px solid #cbd5e1', background: '#fff', color: '#475569',
          }}
        >
          {countsLoading ? 'Counting…' : usageCounts ? 'Refresh item counts' : 'Load item counts'}
        </button>
      </div>

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
                    onChange={e => { setDraftLabel(e.target.value); setEditError(null) }}
                    onKeyDown={e => { if (e.key === 'Enter') saveEdit(cat) }}
                    style={{
                      flex: 1, padding: '5px 8px', fontSize: 13, borderRadius: 6,
                      border: '1px solid #cbd5e1', background: '#fff', color: '#0f172a',
                    }}
                  />
                ) : (
                  <span style={{ flex: 1, fontSize: 14, fontWeight: 500, color: cat.color || '#0f172a', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {cat.label || <span style={{ color: '#cbd5e1' }}>(no label)</span>}
                  </span>
                )}

                <span style={{ fontSize: 12, color: '#64748b', fontFamily: 'ui-monospace, Menlo, monospace', minWidth: 90, textAlign: 'right' }}>{cat.key}</span>
                <span
                  title={usageCounts ? `${usageCounts[cat.label] ?? 0} item(s) tagged "${cat.label}"` : 'Click “Load item counts” to tally items'}
                  style={{ fontSize: 13, color: usageCounts ? '#475569' : '#cbd5e1', minWidth: 28, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}
                >
                  {usageCounts ? (usageCounts[cat.label] ?? 0) : '—'}
                </span>

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
                      Renaming re-tags every item carrying “{cat.label}” across all locations — you’ll see a count to confirm before anything is written.
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
        {categories.length} categor{categories.length === 1 ? 'y' : 'ies'}. Items are tagged by category <em>label</em>; the <code>key</code> is the stable id used for grouping.
      </p>

      {/* ── Rename migration modal ── */}
      {renameState && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.45)', zIndex: 4000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
          <div style={{ background: '#fff', borderRadius: 12, boxShadow: '0 20px 60px rgba(15,23,42,0.25)', width: 460, maxWidth: '100%', padding: 22 }}>
            <h3 style={{ fontSize: 16, fontWeight: 600, color: '#0f172a', margin: '0 0 10px' }}>
              Rename category
            </h3>
            <div style={{ fontSize: 14, color: '#334155', marginBottom: 16, lineHeight: 1.5 }}>
              <span style={{ fontWeight: 600 }}>“{renameState.oldLabel}”</span> →{' '}
              <span style={{ fontWeight: 600 }}>“{renameState.newLabel}”</span>
            </div>

            {renameState.phase === 'scanning' && (
              <div style={{ fontSize: 13, color: '#64748b' }}>Scanning items across all locations…</div>
            )}

            {renameState.phase === 'confirm' && (
              <>
                <div style={{ fontSize: 13, color: '#475569', marginBottom: 18, lineHeight: 1.5 }}>
                  {renameState.dryRun?.totalItems > 0 ? (
                    <>This re-tags <strong>{renameState.dryRun.totalItems}</strong> item
                      {renameState.dryRun.totalItems === 1 ? '' : 's'} across{' '}
                      <strong>{renameState.dryRun.locationsAffected.length}</strong> location
                      {renameState.dryRun.locationsAffected.length === 1 ? '' : 's'}. This can’t be undone in bulk.</>
                  ) : (
                    <>No items carry this label — this is a <strong>name-only</strong> change.</>
                  )}
                </div>
                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                  <button onClick={cancelRename} style={{ padding: '8px 14px', fontSize: 13, fontWeight: 500, border: '1px solid #cbd5e1', borderRadius: 8, background: '#fff', color: '#475569', cursor: 'pointer' }}>Cancel</button>
                  <button onClick={runRename} style={{ padding: '8px 14px', fontSize: 13, fontWeight: 600, border: 'none', borderRadius: 8, background: '#1D9E75', color: '#fff', cursor: 'pointer' }}>Rename</button>
                </div>
              </>
            )}

            {renameState.phase === 'running' && (
              <div style={{ fontSize: 13, color: '#475569' }}>
                Re-tagging {renameState.progress?.done ?? 0} of {renameState.progress?.total ?? 0} item
                {(renameState.progress?.total ?? 0) === 1 ? '' : 's'}…
                {renameState.progress?.location ? ` (location: ${renameState.progress.location})` : ''}
                <div style={{ marginTop: 10, height: 6, borderRadius: 3, background: '#e2e8f0', overflow: 'hidden' }}>
                  <div style={{
                    height: '100%', background: '#1D9E75',
                    width: `${renameState.progress?.total ? Math.round((renameState.progress.done / renameState.progress.total) * 100) : 0}%`,
                    transition: 'width 0.2s',
                  }} />
                </div>
                <div style={{ marginTop: 8, fontSize: 12, color: '#94a3b8' }}>Don’t close this tab until it finishes.</div>
              </div>
            )}

            {renameState.phase === 'error' && (
              <>
                <div style={{ fontSize: 13, color: '#b91c1c', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
                  <AlertTriangle size={14} /> {renameState.error}
                </div>
                <div style={{ fontSize: 12, color: '#64748b', marginBottom: 16, lineHeight: 1.5 }}>
                  Settings were not changed. Retry re-scans the old label and re-tags only what’s left, then applies the
                  rename. Safe to run again.
                </div>
                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                  <button onClick={cancelRename} style={{ padding: '8px 14px', fontSize: 13, fontWeight: 500, border: '1px solid #cbd5e1', borderRadius: 8, background: '#fff', color: '#475569', cursor: 'pointer' }}>Cancel</button>
                  <button onClick={runRename} style={{ padding: '8px 14px', fontSize: 13, fontWeight: 600, border: 'none', borderRadius: 8, background: '#1D9E75', color: '#fff', cursor: 'pointer' }}>Retry</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
