// Money-path guard for the single canonical food-COGS roll-up (option (a), 2026-07).
//
// The bug this locks out: cogs_inventory used to be purchases-inclusive
// (max(0, opening + purchases − closing)) AND every aggregation ALSO added
// cogs_purchases — so the moment a location both counted inventory and posted
// purchases in the same week, food COGS double-counted purchases. It also froze a
// purchases snapshot that went stale when invoices later moved periods.
//
// Fix: cogs_inventory is redefined as the PURE inventory delta (opening − closing,
// legitimately negative on a stock-up week, NOT clamped at write). Purchases live
// solely in cogs_purchases. computeFoodCogs adds the two atoms EXACTLY ONCE and is
// the ONLY place the final clamp lives. Every consumer routes through it.
import { describe, it, expect } from 'vitest'
import { computeFoodCogs, inventoryDelta } from '@/lib/pnl'

describe('computeFoodCogs', () => {
  it('both atoms populated → added exactly ONCE, not doubled', () => {
    // delta $100 (drew inventory down) + $500 purchased → $600 consumed. NOT $1100.
    expect(computeFoodCogs({ cogs_inventory: 100, cogs_purchases: 500 })).toBe(600)
  })

  it('no closing count (delta absent) → food COGS = purchases alone', () => {
    // A location that never counts: cogs_inventory unwritten → purchases is the proxy.
    expect(computeFoodCogs({ cogs_purchases: 500 })).toBe(500)
    expect(computeFoodCogs({ cogs_inventory: 0, cogs_purchases: 500 })).toBe(500)
  })

  it('negative delta (stock-up week) OFFSETS purchases correctly', () => {
    // Bought $500 but inventory GREW by $200 (closing > opening) → only $300 consumed.
    expect(computeFoodCogs({ cogs_inventory: -200, cogs_purchases: 500 })).toBe(300)
  })

  it('final clamp at 0 — a stock-up bigger than purchases never yields negative COGS', () => {
    // Inventory grew $800 on $500 of purchases → consumed nothing (not −$300).
    expect(computeFoodCogs({ cogs_inventory: -800, cogs_purchases: 500 })).toBe(0)
  })

  it('purchases-only, no inventory field, is unaffected (fallback path)', () => {
    expect(computeFoodCogs({ cogs_inventory: -300 })).toBe(0)  // delta alone, no purchases → clamp
  })

  it('null / undefined / empty are safe → 0 (used on possibly-absent priorPnl)', () => {
    expect(computeFoodCogs(null)).toBe(0)
    expect(computeFoodCogs(undefined)).toBe(0)
    expect(computeFoodCogs({})).toBe(0)
  })

  it('the delta already equals the true COGS when purchases are 0 (the 15/16 real docs)', () => {
    // Count docs saved while cogs_purchases was 0 stored cogs_inventory = opening−closing.
    // Adding a (zero) purchases atom leaves the food COGS unchanged — migration no-op.
    expect(computeFoodCogs({ cogs_inventory: 7257.15, cogs_purchases: 0 })).toBe(7257.15)
  })
})

// The FIRST-COUNT GUARD: what the write paths store as cogs_inventory. Without it, a
// no-prior week (opening defaulted to 0) would store (0 − closing) — a spurious full-
// negative delta that swallows the week's real purchases at aggregation.
describe('inventoryDelta (first-count guard)', () => {
  it('first-count week (no prior close, opening defaulted 0, closing > 0) → stores 0, NOT −closing', () => {
    // Best_Buy/P06-W1 & So_CA_Gas/P06-W3 shape: opening 0 because prior wasn't counted.
    expect(inventoryDelta({ openingValue: 0, closingValue: 8201.51, priorCountExists: false })).toBe(0)
    // fallback signal (no explicit flag): openingValue 0 ⇒ treated as first-count ⇒ 0
    expect(inventoryDelta({ openingValue: 0, closingValue: 8201.51 })).toBe(0)
  })

  it('first-count week then feeds computeFoodCogs → food COGS = purchases (not $0, not negative)', () => {
    // The whole point: a real invoiced $1,167.40 stays in COGS on a first-count week.
    const ci = inventoryDelta({ openingValue: 0, closingValue: 8201.51, priorCountExists: false })
    expect(computeFoodCogs({ cogs_inventory: ci, cogs_purchases: 1167.40 })).toBeCloseTo(1167.40, 2)
  })

  it('genuine stock-up (real prior close, closing > opening) → keeps its negative delta', () => {
    // opening $500 (real prior), closing $700 → inventory grew $200 → delta −200.
    expect(inventoryDelta({ openingValue: 500, closingValue: 700, priorCountExists: true })).toBe(-200)
    // and it offsets that week's purchases correctly: $1,167 bought, $200 went to shelf → $967 consumed.
    const ci = inventoryDelta({ openingValue: 500, closingValue: 700, priorCountExists: true })
    expect(computeFoodCogs({ cogs_inventory: ci, cogs_purchases: 1167.40 })).toBeCloseTo(967.40, 2)
  })

  it('normal draw-down (real prior, closing < opening) → positive delta', () => {
    expect(inventoryDelta({ openingValue: 900, closingValue: 200, priorCountExists: true })).toBe(700)
  })
})
