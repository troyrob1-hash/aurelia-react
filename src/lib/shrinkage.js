// Increment 4 — the shrinkage variance calculation. One row per CANONICAL retail item
// (an item that maps to a sold item), for one location + period. All three feeds join on
// the canonical itemMap identity:
//   Opening / Closing ← inventory counts (via canonical.catalogItemId)
//   Purchased        ← Σ resolved invoice lineItems.eachesTotal (via line.canonicalId)
//   Sold             ← Σ salesItems.qtySold (via canonical.soldAliases)
//
//   shrinkage (units) = opening + purchased − sold − closing
//   $ lost            = shrinkage × unitCost
//
// HONESTY: a feed genuinely missing for the period → that cell is null (rendered "—") and
// the row is flagged incomplete — never a fake zero. A row with all feeds present computes
// the real variance. "Sold = 0" is only real when the period HAS sold data (hasSoldFeed);
// otherwise sold is unknown. Purchased = 0 is always real (AP is the record — nothing
// bought that week). Opening/Closing are known only when their count DOC exists.

// Total EACHES an inventory count line represents: packs × qtyPerPack + loose eaches.
// Unifies inventory (opening/closing) to the eaches grain that Sold (salesItems.qtySold)
// and Purchased (lineItems.eachesTotal) already use — so opening+purchased−sold−closing is
// dimensionally consistent, and $Lost = eaches × per-each unitCost (not packs × per-each).
// qtyPerPack defaults to 1 (a single-unit item counts pack==each).
export function countEaches(item) {
  return (Number(item?.qty) || 0) * (Number(item?.qtyPerPack) || 1) + (Number(item?.eaches) || 0)
}

// A count line is actually COUNTED only when qty OR eaches is a real entered number
// (0 counts as entered). A line present in the doc but with BOTH blank (null/'') is
// "present but not counted" → the caller omits it from the count map → the row reads
// incomplete ("—"), never a phantom 0. Same honest-incomplete rule as the empty-count fix.
export function isCounted(item) {
  const num = (v) => v != null && v !== '' && !Number.isNaN(Number(v))
  return num(item?.qty) || num(item?.eaches)
}

// Compute one row. Inputs are pre-resolved per canonical (see buildFeeds in the component).
export function computeShrinkageRow(c, feeds) {
  const catId = c.catalogItemId
  const hasCat = catId != null

  // Opening/Closing are known ONLY when the count ACTUALLY CONTAINS this item's count.
  // An empty count doc, or an item absent from the count, is "not counted" → null →
  // incomplete (rendered "—") — never a fake zero (a false-zero closing would report the
  // whole shelf as lost). A count that DOES contain the item at 0 is a REAL zero (present
  // key). hasOwnProperty distinguishes present-0 from absent. Honest "—" over confident-wrong.
  const counted = (map) => hasCat && map != null && Object.prototype.hasOwnProperty.call(map, catId)
  const opening = counted(feeds.openingByCat) ? Number(feeds.openingByCat[catId]) : null
  const closing = counted(feeds.closingByCat) ? Number(feeds.closingByCat[catId]) : null
  const purchased = Number(feeds.purchasedByCanonical[c.canonicalId] || 0)   // KNOWN sum (resolved eaches)
  // A resolved purchase line whose pack the parser couldn't determine has eachesTotal:null
  // — its real eaches are UNKNOWN, and it contributed nothing to the sum above, so
  // `purchased` is only a lower bound. Flag it like a missing feed: incomplete + excluded
  // from KPI totals, not a confident-but-understated variance (which would over-report
  // shrinkage). Honest-incomplete over confident-wrong — the same rule as the empty count.
  const purchasedUnresolved = !!(feeds.purchasedUnresolvedByCanonical && feeds.purchasedUnresolvedByCanonical[c.canonicalId])
  const sold = feeds.hasSoldFeed ? Number(feeds.soldByCanonical[c.canonicalId] || 0) : null
  const unitCost = hasCat && feeds.unitCostByCat[catId] != null ? Number(feeds.unitCostByCat[catId]) : null

  const missing = []
  if (opening == null) missing.push('opening')
  if (closing == null) missing.push('closing')
  if (sold == null) missing.push('sold')
  if (purchasedUnresolved) missing.push('purchased')       // a real purchase has unknown eaches
  const complete = missing.length === 0

  // Expected = what should be on the shelf = opening + purchased − sold. Needs opening +
  // sold AND a trustworthy purchased (null if any purchase line's eaches are unknown).
  const expected = (opening != null && sold != null && !purchasedUnresolved) ? opening + purchased - sold : null
  const shrinkage = complete ? opening + purchased - sold - closing : null
  const shrinkageValue = (shrinkage != null && unitCost != null) ? shrinkage * unitCost : null

  return {
    canonicalId: c.canonicalId,
    name: c.canonicalName,
    catalogItemId: catId || null,
    opening, purchased, purchasedUnresolved, sold, closing,
    expected, shrinkage, shrinkageValue, unitCost,
    complete, missing,
  }
}

// Compute all rows for the SHRINKAGE-TRACKED canonicals only — status 'active' AND maps to
// a sold item (has ≥1 soldAlias). Café-use / purchase-only canonicals are excluded here
// (they're COGS, not shrinkage). Returns rows sorted by $ lost desc (incomplete rows last).
export function computeShrinkageRows(canonicals, feeds) {
  const tracked = canonicals.filter((c) => c.status !== 'cafe_use' && (c.soldAliases || []).length > 0)
  const rows = tracked.map((c) => computeShrinkageRow(c, feeds))
  return rows.sort((a, b) => {
    if (a.complete !== b.complete) return a.complete ? -1 : 1
    return (b.shrinkageValue || 0) - (a.shrinkageValue || 0)
  })
}

// KPI rollups over the computed rows. Totals count only COMPLETE rows (a variance you can
// stand behind); incompleteCount surfaces how many are waiting on a feed.
export function shrinkageKpis(rows) {
  const complete = rows.filter((r) => r.complete)
  return {
    totalLoss: complete.reduce((s, r) => s + Math.max(0, r.shrinkageValue || 0), 0),
    unitsLost: complete.reduce((s, r) => s + Math.max(0, r.shrinkage || 0), 0),
    itemsAffected: complete.filter((r) => (r.shrinkage || 0) > 0.5).length,
    trackedCount: rows.length,
    completeCount: complete.length,
    incompleteCount: rows.length - complete.length,
  }
}
