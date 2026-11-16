import { doc, setDoc } from 'firebase/firestore'
import { db } from '@/lib/firebase'
import { useUIStore, INVENTORY_VIEW_DEFAULTS } from './uiStore'

// Per-user persistence for the Inventory View settings (Grouped/A-Z, "Show
// last week's counts", "Show variance"). Stored on the user's own profile doc
// as preferences.inventory = { viewMode, showPrior, showVariance } — rules
// already let every user write their own orgs/{orgId}/users/{uid}.
//
// Display only, like the toggles themselves: nothing here touches counts.
//
// Lifecycle (driven by authStore):
//   start — after the profile loads: apply the stored values (anything missing
//           or malformed falls back to the default), then write on change.
//   stop  — on sign-out: stop writing, reset to defaults so the next person on
//           a shared terminal starts from defaults, not the last user's view.

const FIELDS = [
  ['inventoryViewMode', 'viewMode', v => v === 'grouped' || v === 'flat'],
  ['inventoryShowPrior', 'showPrior', v => typeof v === 'boolean'],
  ['inventoryShowVariance', 'showVariance', v => typeof v === 'boolean'],
]

/** preferences.inventory (any shape) → store state, defaults for anything bad. */
export function inventoryViewFromPrefs(stored) {
  const out = { ...INVENTORY_VIEW_DEFAULTS }
  if (stored && typeof stored === 'object') {
    for (const [key, field, ok] of FIELDS) if (ok(stored[field])) out[key] = stored[field]
  }
  return out
}

/** Store state → the preferences.inventory map that gets written. */
export function inventoryViewToPrefs(state) {
  const out = {}
  for (const [key, field] of FIELDS) out[field] = state[key]
  return out
}

const changed = (a, b) => FIELDS.some(([key]) => a[key] !== b[key])

export function writeInventoryViewPrefs(tenantId, uid, prefs) {
  return setDoc(doc(db, 'orgs', tenantId, 'users', uid), { preferences: { inventory: prefs } }, { merge: true })
}

let unsub = null

export function startViewPrefsSync({ tenantId, uid, preferences, write = writeInventoryViewPrefs }) {
  stopViewPrefsSync({ reset: false })
  if (!tenantId || !uid) return
  useUIStore.setState(inventoryViewFromPrefs(preferences?.inventory))
  unsub = useUIStore.subscribe((state, prev) => {
    if (!changed(state, prev)) return
    Promise.resolve(write(tenantId, uid, inventoryViewToPrefs(state)))
      .catch(e => console.warn('[viewPrefs] save failed:', e?.message || e))
  })
}

export function stopViewPrefsSync({ reset = true } = {}) {
  if (unsub) { unsub(); unsub = null }
  if (reset) useUIStore.setState({ ...INVENTORY_VIEW_DEFAULTS })
}
