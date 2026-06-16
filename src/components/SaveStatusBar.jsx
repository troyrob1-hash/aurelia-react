import React from 'react'

/**
 * SaveStatusBar — shared floating save/status bar for data-entry tabs.
 * Renders the autosave status (dot + label + last-saved time + reassurance),
 * an optional headline metric, and Save / Save & Close buttons.
 *
 * Pairs with the useAutosave hook: pass its autoSaveStatus + lastSavedAt.
 *
 * Props:
 *   autoSaveStatus  'idle' | 'saving' | 'saved'
 *   lastSavedAt     Date | null
 *   dirty           boolean
 *   metricLabel     e.g. 'Week total' | 'Live COGS'   (optional)
 *   metricValue     formatted string e.g. '$1,250.00' (optional)
 *   reassurance     e.g. 'Counts save automatically'  (optional)
 *   onSave          () => void  — manual draft save (optional)
 *   saveLabel       button text, default 'Save'
 *   onSaveAndClose  () => void  — deliberate finalize (optional)
 *   saveAndCloseLabel  default 'Save & Close Period'
 *   saving          boolean — disables buttons while a save is in flight
 *   hidden          boolean — when true, render nothing (approved/closed)
 */
export default function SaveStatusBar({
  autoSaveStatus,
  lastSavedAt,
  dirty,
  metricLabel,
  metricValue,
  reassurance,
  onSave,
  saveLabel = 'Save',
  onSaveAndClose,
  saveAndCloseLabel = 'Save & Close Period',
  saving = false,
  hidden = false,
}) {
  if (hidden) return null

  const isSaving = autoSaveStatus === 'saving'
  const unsaved = dirty && !isSaving
  const dot = isSaving ? '#fbbf24' : unsaved ? '#94a3b8' : '#34d399'
  const label = isSaving ? 'Saving\u2026' : unsaved ? 'Saving in a moment\u2026' : 'All changes saved'
  const ts = lastSavedAt
    ? lastSavedAt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : null

  return (
    <div style={{
      position: 'fixed', bottom: 88, right: 20, zIndex: 50,
      display: 'flex', alignItems: 'center', gap: 16,
      background: '#0f172a', color: '#fff',
      padding: '12px 18px', borderRadius: 12,
      boxShadow: '0 8px 24px rgba(0,0,0,0.25)',
      maxWidth: 'calc(100vw - 40px)',
    }}>
      {metricLabel != null && metricValue != null && (
        <div style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.3 }}>
          <span style={{ fontSize: 11, opacity: 0.7, textTransform: 'uppercase', letterSpacing: '0.04em' }}>{metricLabel}</span>
          <span style={{ fontSize: 18, fontWeight: 700 }}>{metricValue}</span>
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.3, minWidth: 150 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
          <span style={{ width: 9, height: 9, borderRadius: '50%', background: dot, flexShrink: 0, boxShadow: isSaving ? 'none' : '0 0 6px ' + dot }} />
          <span style={{ fontSize: 13, fontWeight: 600, color: '#fff' }}>{label}</span>
        </div>
        <span style={{ fontSize: 11, opacity: 0.65, marginTop: 2 }}>
          {ts ? 'Saved automatically at ' + ts : (reassurance || 'Changes save automatically')}
        </span>
      </div>

      {onSave && (
        <button onClick={onSave} disabled={saving || !dirty} style={{
          padding: '8px 14px', fontSize: 13, fontWeight: 600,
          background: '#fff', color: '#0f172a', border: 'none',
          borderRadius: 8, cursor: (saving || !dirty) ? 'default' : 'pointer',
          opacity: (saving || !dirty) ? 0.5 : 1, whiteSpace: 'nowrap',
        }}>{saveLabel}</button>
      )}

      {onSaveAndClose && (
        <button onClick={onSaveAndClose} disabled={saving} style={{
          padding: '8px 16px', fontSize: 13, fontWeight: 600,
          background: '#2563eb', color: '#fff', border: 'none',
          borderRadius: 8, cursor: saving ? 'default' : 'pointer',
          opacity: saving ? 0.6 : 1, whiteSpace: 'nowrap',
        }}>{saving ? 'Saving\u2026' : saveAndCloseLabel}</button>
      )}
    </div>
  )
}
