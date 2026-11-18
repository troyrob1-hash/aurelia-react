import { useRef, useCallback, useEffect } from 'react'

// Restore side of the useAutosave draft backstop, for tabs whose data loads
// asynchronously after the location/week is chosen (Weekly Sales, Labor).
//
// useAutosave calls `hydrate(data)` as soon as the key changes — before this
// tab's load has finished — so the draft is held here and applied only once
// the tab reports it has loaded THAT key (`loadedKey === flushKey`). Applying
// earlier would be overwritten by the load and lost. A draft held for a key
// the user has since left is dropped, never applied elsewhere.
//
// `apply(data)` merges the draft into the tab's state and marks it dirty, so
// the normal autosave writes it.
export function useDraftRestore({ flushKey, loadedKey, apply }) {
  const pendingRef = useRef(null)
  const keyRef = useRef(flushKey)
  keyRef.current = flushKey
  const applyRef = useRef(apply)
  applyRef.current = apply

  const hydrate = useCallback((data) => {
    pendingRef.current = { key: keyRef.current, data }
  }, [])

  useEffect(() => {
    const p = pendingRef.current
    if (!p) return
    if (p.key !== flushKey) { pendingRef.current = null; return }
    if (!flushKey || loadedKey !== flushKey) return
    pendingRef.current = null
    applyRef.current(p.data)
  })

  return hydrate
}

// Draft keys: prefixed per tab (Inventory's key is `org|location|week`, so an
// unprefixed Sales key would collide with it) and include the week, so a draft
// can only ever restore into the same tab, location and week.
export function draftKey(tab, orgId, location, periodKey) {
  return orgId && location && periodKey ? `${tab}|${orgId}|${location}|${periodKey}` : null
}

// Weekly Sales: entries = { [dateKey]: { popup, catering, retail } }. Draft
// values win cell by cell; cells the draft doesn't hold keep the loaded value.
export function mergeSalesDraft(entries, draft) {
  const out = { ...(entries || {}) }
  if (!draft || typeof draft !== 'object' || Array.isArray(draft)) return out
  for (const [dateKey, cats] of Object.entries(draft)) {
    if (!cats || typeof cats !== 'object') continue
    out[dateKey] = { ...(out[dateKey] || {}), ...cats }
  }
  return out
}

// Labor: rows = [{ gl, label, section, amount }]. Draft rows replace loaded
// rows with the same GL; draft-only GLs are added; loaded-only rows stay.
export function mergeLaborDraft(rows, draft) {
  if (!Array.isArray(draft)) return Array.isArray(rows) ? rows : []
  const byGl = new Map((rows || []).map(r => [r.gl, r]))
  for (const r of draft) if (r && r.gl != null) byGl.set(r.gl, { ...(byGl.get(r.gl) || {}), ...r })
  return [...byGl.values()]
}
