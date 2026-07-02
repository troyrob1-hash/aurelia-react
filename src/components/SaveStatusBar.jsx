import React from 'react'
import { Lock } from 'lucide-react'
import { cleanLocName } from '@/store/LocationContext'

// Compact a canonical period key (YYYY-PMM-Wn) → "P6-W4" for display.
// Non-matching keys (e.g. MONTHLY) fall through mostly intact.
function shortPeriod(k) {
  return (k || '').replace(/^\d{4}-P0*(\d+)/, 'P$1')
}

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
  locked = false,   // period closed/locked → both actions disabled + indicator
  periodKey,        // for the "…closed" indicator
  location,         // raw location name (cleanLocName strips CR_/SO_)
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
      position: 'fixed', bottom: 24, right: 96, zIndex: 50,
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
        {locked ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 7, color: '#fca5a5' }}>
            <Lock size={13} style={{ flexShrink: 0 }} />
            <span style={{ fontSize: 13, fontWeight: 700, whiteSpace: 'nowrap' }}>
              {([shortPeriod(periodKey), location ? cleanLocName(location) : null].filter(Boolean).join(' - ') || 'Period')} (closed)
            </span>
          </div>
        ) : (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
              <span style={{ width: 9, height: 9, borderRadius: '50%', background: dot, flexShrink: 0, boxShadow: isSaving ? 'none' : '0 0 6px ' + dot }} />
              <span style={{ fontSize: 13, fontWeight: 600, color: '#fff' }}>{label}</span>
            </div>
            <span style={{ fontSize: 11, opacity: 0.65, marginTop: 2 }}>
              {ts ? 'Saved automatically at ' + ts : (reassurance || 'Changes save automatically')}
            </span>
          </>
        )}
      </div>

      {onSave && (
        <button onClick={onSave} disabled={saving || !dirty || locked} style={{
          padding: '8px 14px', fontSize: 13, fontWeight: 600,
          background: '#fff', color: '#0f172a', border: 'none',
          borderRadius: 8, cursor: (saving || !dirty || locked) ? 'default' : 'pointer',
          opacity: (saving || !dirty || locked) ? 0.5 : 1, whiteSpace: 'nowrap',
        }}>{saveLabel}</button>
      )}

      {onSaveAndClose && (
        // Red-outlined destructive - closing LOCKS the period (director-only reopen).
        <button onClick={onSaveAndClose} disabled={saving || locked} style={{
          padding: '8px 16px', fontSize: 13, fontWeight: 600,
          background: 'transparent', color: (saving || locked) ? '#fca5a5' : '#f87171',
          border: '1px solid ' + ((saving || locked) ? '#7f1d1d' : '#ef4444'),
          borderRadius: 8, cursor: (saving || locked) ? 'default' : 'pointer',
          opacity: (saving || locked) ? 0.6 : 1, whiteSpace: 'nowrap',
        }}>{saving ? 'Saving\u2026' : saveAndCloseLabel}</button>
      )}
    </div>
  )
}
