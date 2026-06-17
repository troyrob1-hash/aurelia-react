import { useState, useRef, useEffect } from 'react'

const LS_PREFIX = 'aurelia:autosave:'

/**
 * useAutosave — shared autosave lifecycle for data-entry tabs (Sales,
 * Inventory, and future tabs). Owns ONLY the lifecycle, never the data:
 *   - Debounced save: debounceMs after dirty flips true, calls save().
 *   - Page-exit flush: pagehide + visibilitychange flush pending edits.
 *   - Location-switch flush: when flushKey changes, the OUTGOING data is
 *     flushed before the new context loads.
 *   - Status: exposes autoSaveStatus + lastSavedAt for a shared status bar.
 *
 * Optional crash-recovery backstop (snapshot + hydrate):
 *   - When `snapshot` is provided, the hook writes a JSON snapshot of the
 *     caller's draft state to localStorage SYNCHRONOUSLY on every commit
 *     where dirty is true. This survives any unmount path the async flush
 *     cannot — route change with save still in flight, browser tab close,
 *     OS kill, network error during save, permission denial.
 *   - On mount (and on every flushKey change), if `hydrate` is provided and
 *     localStorage has a draft for the current flushKey, the hook calls
 *     hydrate(data, ts) so the caller can restore it.
 *   - On successful save (debounce or flush), the draft is removed.
 *
 * The caller supplies its own save fn and dirty flag.
 */
export function useAutosave({
  dirty,
  save,
  enabled = true,
  flushKey,
  debounceMs = 2000,
  snapshot,
  hydrate,
}) {
  const [autoSaveStatus, setAutoSaveStatus] = useState('idle')
  const [lastSavedAt, setLastSavedAt] = useState(null)
  const timerRef = useRef(null)

  const dirtyRef = useRef(dirty)
  const saveRef = useRef(save)
  const enabledRef = useRef(enabled)
  const snapshotRef = useRef(snapshot)
  const hydrateRef = useRef(hydrate)
  const flushKeyRef = useRef(flushKey)
  useEffect(() => { dirtyRef.current = dirty }, [dirty])
  useEffect(() => { saveRef.current = save }, [save])
  useEffect(() => { enabledRef.current = enabled }, [enabled])
  useEffect(() => { snapshotRef.current = snapshot }, [snapshot])
  useEffect(() => { hydrateRef.current = hydrate }, [hydrate])
  useEffect(() => { flushKeyRef.current = flushKey }, [flushKey])

  // Debounced save: after dirty flips true, schedule a save in debounceMs.
  useEffect(() => {
    if (!dirty || !enabled) return
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(async () => {
      setAutoSaveStatus('saving')
      let ok = false
      try { ok = saveRef.current ? await saveRef.current() : false } catch (e) { ok = false }
      setAutoSaveStatus(ok ? 'saved' : 'idle')
      if (ok) {
        setLastSavedAt(new Date())
        const k = flushKeyRef.current
        if (k) {
          try { localStorage.removeItem(LS_PREFIX + k) } catch (e) {}
        }
      }
    }, debounceMs)
    return () => { if (timerRef.current) clearTimeout(timerRef.current) }
  }, [dirty, enabled, debounceMs])

  // Synchronous crash-recovery backstop: on every commit where dirty is true
  // AND a snapshot fn is provided, persist a JSON snapshot of the caller's
  // draft to localStorage. The effect intentionally has no deps and runs on
  // every commit; localStorage writes are sync and cheap (<5ms for <50KB).
  // This is the only mechanism that survives the async flush being cut off.
  useEffect(() => {
    if (!dirty || !enabled || !flushKey || !snapshotRef.current) return
    try {
      const data = snapshotRef.current()
      if (data == null) return
      if (Array.isArray(data) && data.length === 0) return
      localStorage.setItem(
        LS_PREFIX + flushKey,
        JSON.stringify({ data, ts: Date.now() })
      )
    } catch (e) { /* quota / serialization — best-effort */ }
  })

  // Hydrate on flushKey change/mount: if a draft exists for the current
  // flushKey, call hydrate(data, ts). Re-runs when flushKey changes so a
  // user returning to a previous context picks up the draft for it.
  useEffect(() => {
    if (!flushKey || !hydrateRef.current) return
    try {
      const raw = localStorage.getItem(LS_PREFIX + flushKey)
      if (!raw) return
      const parsed = JSON.parse(raw)
      if (parsed?.data != null) {
        hydrateRef.current(parsed.data, parsed.ts)
      }
    } catch (e) {}
  }, [flushKey])

  // Async flush. Called from cleanup paths (flushKey change, unmount,
  // pagehide, visibilitychange). Clears the localStorage entry for the
  // *captured* flushKey on success — callers from cleanup pass the OLD key,
  // not flushKeyRef.current which by then is the NEW key.
  const flush = async (capturedFlushKey) => {
    if (dirtyRef.current && enabledRef.current && saveRef.current) {
      try {
        const ok = await saveRef.current()
        const k = capturedFlushKey ?? flushKeyRef.current
        if (ok && k) {
          try { localStorage.removeItem(LS_PREFIX + k) } catch (e) {}
        }
      } catch (e) {}
    }
  }

  useEffect(() => {
    const onVis = () => { if (document.visibilityState === 'hidden') flush() }
    document.addEventListener('visibilitychange', onVis)
    window.addEventListener('pagehide', flush)
    return () => {
      document.removeEventListener('visibilitychange', onVis)
      window.removeEventListener('pagehide', flush)
    }
  }, [])

  // Flush on flushKey change AND on unmount. Closure captures the flushKey
  // at effect-run time so the cleanup uses the OLD flushKey (for clearing
  // the OLD localStorage entry on save success).
  useEffect(() => {
    const capturedFlushKey = flushKey
    return () => { flush(capturedFlushKey) }
  }, [flushKey])

  return { autoSaveStatus, lastSavedAt, flushNow: flush }
}
