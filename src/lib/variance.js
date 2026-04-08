// ═══════════════════════════════════════════════════════════════════════════
// Variance Analysis Library - Aurelia FMS
// Actual vs Theoretical (AvT) calculations and variance reporting
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Classify variance severity
 * @returns 'good' | 'warn' | 'alert' | 'neutral'
 */
export function classifyVariance(actual, expected) {
  if (actual == null || expected == null || expected === 0) return 'neutral'
  const pct = Math.abs((actual - expected) / expected)
  if (pct <= 0.10) return 'good'
  if (pct <= 0.25) return 'warn'
  return 'alert'
}

/**
 * Get variance direction
 * @returns 'up' | 'down' | 'neutral'
 */
export function getVarianceDirection(actual, expected) {
  if (actual == null || expected == null) return 'neutral'
  if (actual > expected) return 'up'
  if (actual < expected) return 'down'
  return 'neutral'
}

/**
 * Calculate variance percentage
 */
export function calcVariancePct(actual, expected) {
  if (!expected || expected === 0) return 0
  return ((actual - expected) / expected) * 100
}

/**
 * Identify top variance issues (for alerts)
 * 
 * @param {Array} items - Items with variance data
 * @param {number} limit - Max items to return
 * @returns {Array} Top variance items
 */
export function getTopVarianceIssues(items, limit = 5) {
  return items
    .filter(item => {
      const status = classifyVariance(item.qty, item._priorQty || item.priorQty)
      return status === 'alert' || status === 'warn'
    })
    .sort((a, b) => {
      const aImpact = Math.abs((a.qty || 0) - (a._priorQty || 0)) * (a.unitCost || 0)
      const bImpact = Math.abs((b.qty || 0) - (b._priorQty || 0)) * (b.unitCost || 0)
      return bImpact - aImpact
    })
    .slice(0, limit)
    .map(item => {
      const actual = item.qty || 0
      const expected = item._priorQty || item.priorQty || 0
      const variance = actual - expected
      const impact = variance * (item.unitCost || 0)
      const pct = calcVariancePct(actual, expected)

      return {
        id: item.id,
        name: item.name,
        vendor: item.vendor,
        actual,
        expected,
        variance,
        impact,
        pct: Math.round(pct),
        status: classifyVariance(actual, expected),
        direction: getVarianceDirection(actual, expected)
      }
    })
}

/**
 * Calculate par level status for an item
 * 
 * @param {Object} item - Item with qty, parLevel, reorderPoint, avgDailyUsage
 * @returns {Object} Par status analysis
 */
export function calcParStatus(item) {
  const qty = item.qty || 0
  const parLevel = item.parLevel || 0
  const reorderPoint = item.reorderPoint || 0
  const avgDailyUsage = item.avgDailyUsage || 0

  // Days on hand
  const daysOnHand = avgDailyUsage > 0 
    ? Math.round((qty / avgDailyUsage) * 10) / 10 
    : null

  // Status
  let status = 'good'
  if (parLevel > 0 && qty < reorderPoint) {
    status = 'critical'
  } else if (parLevel > 0 && qty < parLevel) {
    status = 'low'
  }

  // Fill percentage (for visual bar)
  const fillPct = parLevel > 0 ? Math.min(100, (qty / parLevel) * 100) : 100
  const reorderPct = parLevel > 0 ? (reorderPoint / parLevel) * 100 : 0

  return {
    qty,
    parLevel,
    reorderPoint,
    daysOnHand,
    status,
    fillPct: Math.round(fillPct),
    reorderPct: Math.round(reorderPct),
    shortfall: parLevel > qty ? parLevel - qty : 0
  }
}

/**
 * Generate reorder recommendations
 * 
 * @param {Array} items - Items with par level data
 * @returns {Array} Items that need reordering with recommended qty
 */
export function generateReorderList(items) {
  return items
    .filter(item => {
      const qty = item.qty || 0
      const reorderPoint = item.reorderPoint || 0
      return reorderPoint > 0 && qty <= reorderPoint
    })
    .map(item => {
      const qty = item.qty || 0
      const parLevel = item.parLevel || 0
      const recommendedOrder = Math.max(0, parLevel - qty)
      const estimatedCost = recommendedOrder * (item.unitCost || 0)

      return {
        id: item.id,
        name: item.name,
        vendor: item.vendor,
        currentQty: qty,
        parLevel,
        recommendedOrder,
        unitCost: item.unitCost,
        estimatedCost,
        packSize: item.packSize,
        leadTimeDays: item.vendorLeadTimeDays || 2
      }
    })
    .sort((a, b) => b.estimatedCost - a.estimatedCost)
}