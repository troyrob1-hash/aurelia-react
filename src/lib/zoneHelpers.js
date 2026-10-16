// Pure, UI-facing helpers for the per-location inventory ZONE editor. Mirrors
// categoryHelpers.js exactly in spirit: no React, no Firestore — just constants
// + pure functions, unit-tested in tests/zoneHelpers.test.js.
//
// Zones are per-location, stored at the SAME doc shape categories use:
//   tenants/{orgId}/inventory/{locId}/settings/zones   ({ zones: [...] })
// with locId = sanitizeDocId(locationId). An ABSENT doc means "single default
// zone" — see resolveZones — so existing locations need no migration and behave
// exactly as they do today until a manager adds a SECOND zone.
//
// The string/slug/color primitives are shared with categories ON PURPOSE —
// slugify, uniqueKey and PALETTE are imported, never reimplemented, so the two
// editors can never drift on key generation or the color set.

import { PALETTE, slugify, uniqueKey } from '@/lib/categoryHelpers'

// Re-export the shared primitives so zone call sites import from one place
// (the modal) without reaching into categoryHelpers directly. These are the
// SAME functions — no copies.
export { PALETTE, slugify, uniqueKey }

// The canonical key/label for the one implicit zone every location has before a
// manager configures any. "Everything counted here" — the single bucket that
// makes a one-zone location identical to today's no-zone behavior.
export const DEFAULT_ZONE_KEY = 'default'
export const DEFAULT_ZONE_LABEL = 'Main'

// The built-in default zone set: EXACTLY ONE zone. A location with no zones doc
// resolves to this, and a one-zone location must surface no zone UI at all (see
// isSingleDefaultZone / the rules gate). Returns a FRESH array each call so a
// caller can never mutate the shared default — same contract as
// getDefaultCategories().
export function getDefaultZones() {
  return [
    { key: DEFAULT_ZONE_KEY, label: DEFAULT_ZONE_LABEL, color: '#374151', bg: '#f3f4f6' },
  ]
}

// Zone slug: reuse the category slugifier for identical key rules, but default
// to 'zone' (not 'category') when a label slugifies to empty, so an all-symbol
// label still yields a sensible, zone-flavored key.
export function slugifyZone(label) {
  const s = slugify(label)
  return s === 'category' ? 'zone' : s
}

// The backward-compat gate. Given whatever was read from the per-location zones
// doc (the stored array, or null/undefined when the doc is absent), return the
// zone list the app should use. An absent / empty / malformed doc ALWAYS
// resolves to the single default zone — this is the one place that enforces
// "no zones doc == one implicit zone", so existing locations are unchanged.
export function resolveZones(storedZones) {
  if (Array.isArray(storedZones) && storedZones.length > 0) return storedZones
  return getDefaultZones()
}

// True when a location is effectively single-zone: no zones configured, or a
// single zone (whatever its key/label). This is the explicit back-compat
// predicate — every new zone-aware surface (filters, per-zone inputs) must stay
// hidden while this is true, so a one-zone location looks exactly like today.
// Zones only "turn on" once a SECOND zone exists.
export function isSingleDefaultZone(zones) {
  const resolved = resolveZones(zones)
  return resolved.length <= 1
}

// True once a manager has actually configured multiple zones — the inverse of
// isSingleDefaultZone, named for the call sites that gate zone UI ON.
export function hasMultipleZones(zones) {
  return !isSingleDefaultZone(zones)
}
