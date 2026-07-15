// src/lib/siteMatch.js
//
// Shared site-name → Aurelia-location matcher. Used by both the Café Labor import
// (Phase 2.3a) and the Enterprise P&L import (Phase 1). Same normalized + alias
// approach as BudgetImport. cleanFn (cleanLocName) is injected so this stays free
// of the LocationContext React coupling.

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '')

// appRawNames: the app's raw location keys (with CR_/SO_ prefixes).
// aliases: { fileSiteName: appRawName } for wording the normalizer can't catch.
// Returns matchSite(siteRaw) -> { status: 'single'|'alias'|'exact'|'normalized'|'unmatched', appName }.
export function buildSiteMatcher(appRawNames, cleanFn, aliases = {}) {
  const lookup = {}
  for (const raw of appRawNames) { lookup[norm(raw)] = raw; lookup[norm(cleanFn ? cleanFn(raw) : raw)] = raw }
  return function matchSite(siteRaw) {
    if (!siteRaw) return { status: 'single', appName: null }
    if (aliases[siteRaw]) return { status: 'alias', appName: aliases[siteRaw] }
    if (appRawNames.includes(siteRaw)) return { status: 'exact', appName: siteRaw }
    const hit = lookup[norm(siteRaw)] || (cleanFn && lookup[norm(cleanFn(siteRaw))])
    return hit ? { status: 'normalized', appName: hit } : { status: 'unmatched', appName: null }
  }
}
