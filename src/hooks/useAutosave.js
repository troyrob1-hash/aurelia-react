import { useState, useRef, useEffect } from 'react'

/**
 * useAutosave — shared autosave lifecycle for data-entry tabs (Sales,
 * Inventory, and future tabs). Owns ONLY the lifecycle, never the data:
 *   - Debounced save: debounceMs after dirty flips true, calls save().
 *   - Page-exit flush: pagehide + visibilitychange flush pending edits.
 *   - Location-switch flush: when flushKey changes, the OUTGOING data is
 *     flushed before the new context loads.
 *   - Status: exposes autoSaveStatus + lastSavedAt for a shared status bar.
 * The caller supplies its own save fn and dirty flag.
 */
export function useAutosave({ dirty, save, enabled = true, flushKey, debounceMs = 2000 }) {
  const [autoSaveStatus, setAutoSaveStatus] = useState('idle')
  const [lastSavedAt, setLastSavedAt] = useState(null)
  const timerRef = useRef(null)

  const dirtyRef = useRef(dirty)
  const saveRef = useRef(save)
  const enabledRef = useRef(enabled)
  useEffect(() => { dirtyRef.current = dirty }, [dirty])
  useEffect(() => { saveRef.current = save }, [save])
  useEffect(() => { enabledRef.current = enabled }, [enabled])

  useEffect(() => {
    if (!dirty || !enabled) return
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(async () => {
      setAutoSaveStatus('saving')
      let ok = false
      try { ok = saveRef.current ? await saveRef.current() : false } catch (e) { ok = false }
      setAutoSaveStatus(ok ? 'saved' : 'idle')
      if (ok) setLastSavedAt(new Date())
    }, debounceMs)
    return () => { if (timerRef.current) clearTimeout(timerRef.current) }
  }, [dirty, enabled, debounceMs])

  const flush = async () => {
    if (dirtyRef.current && enabledRef.current && saveRef.current) {
      try { await saveRef.current() } catch (e) {}
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

  useEffect(() => {
    return () => { flush() }
  }, [flushKey])

  return { autoSaveStatus, lastSavedAt, flushNow: flush }
}
