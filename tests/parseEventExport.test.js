// Money-path guard for the café/popup Popup-vs-Retail split. The reliable rule
// (verified against a real 308-row multi-site export): RETAIL = "11 Dining" (Fooda's
// own operating entity, universal marker) in Restaurant Internal Name; POPUP = else;
// BLANK = unclassified (surfaced, never silently popup). Location Name and fuzzy
// barista/cafeteria matching are traps — see the ZONZO/Copper Door cases below.
import { describe, it, expect } from 'vitest'
import { classifyVendor, pickHeader, parseCateringExport } from '@/lib/parseEventExport'

describe('classifyVendor — popup vs retail split', () => {
  it('"11 Dining" entities are RETAIL (cafeteria and barista)', () => {
    expect(classifyVendor('11 Dining LLC - Cafeteria')).toBe('retail')
    expect(classifyVendor('11 Dining LLC - Barista')).toBe('retail')
  })

  it('popup coffee vendors in Barista/Retail locations are POPUP (the trap case)', () => {
    // ZONZO sits in a "Barista" Location Name but is NOT 11 Dining → popup.
    expect(classifyVendor('ZONZO COFFEE')).toBe('popup')
    expect(classifyVendor('Copper Door Coffee VF Corp Resident')).toBe('popup')
  })

  it('a blank Restaurant Internal Name is UNCLASSIFIED, not silently popup', () => {
    expect(classifyVendor('')).toBe('unclassified')
    expect(classifyVendor('   ')).toBe('unclassified')
    expect(classifyVendor(null)).toBe('unclassified')
    expect(classifyVendor(undefined)).toBe('unclassified')
  })

  it('the "11 Dining" marker is case-insensitive and space-tolerant', () => {
    expect(classifyVendor('11 dining llc - barista')).toBe('retail')
    expect(classifyVendor('11DINING - Cafeteria')).toBe('retail')
  })

  it('a generic popup restaurant (no marker) is POPUP', () => {
    expect(classifyVendor('Salata, CityWest Cafe')).toBe('popup')
  })
})

describe('pickHeader — commission/revenue column resolution (fail-loud on absent)', () => {
  it('resolves whichever commission column exists', () => {
    expect(pickHeader(['Entity name', 'Total Commission', 'Total Price'], ['Total Commission', 'Commission'])).toBe('Total Commission')
    expect(pickHeader(['Entity name', 'Commission'], ['Total Commission', 'Commission'])).toBe('Commission')
  })
  it('returns null when NEITHER commission column exists (caller fails loud, no silent 0)', () => {
    expect(pickHeader(['Entity name', 'Total Price'], ['Total Commission', 'Commission'])).toBeNull()
  })
  it('prefers Gross Food Sales over Food Sales (parity with popup)', () => {
    expect(pickHeader(['Food Sales', 'Gross Food Sales', 'Total Price'], ['Gross Food Sales', 'Food Sales'])).toBe('Gross Food Sales')
  })
  it('is case/space-tolerant and returns the real key', () => {
    expect(pickHeader([' total commission '], ['Total Commission'])).toBe(' total commission ')
  })
})

describe('parseCateringExport — GFS revenue basis + per-row commission', () => {
  const rows = [
    { 'Event date': '6/1/2026', 'Gross Food Sales': 100, 'Total Price': 130, 'Total Commission': 19, 'Entity name': 'Acme Catering' },
    { 'Event date': '6/2/2026', 'Gross Food Sales': 200, 'Total Price': 260, 'Total Commission': 18, 'Entity name': 'Acme Catering' },
  ]
  it('reads Gross Food Sales for revenue, NOT Total Price', () => {
    const { totals } = parseCateringExport(rows, 'Gross Food Sales', 'Total Commission')
    expect(totals.gfs_catering).toBe(300)          // 100 + 200 (GFS) — not 390 (Total Price)
    expect(totals.rev_catering_revenue).toBe(300)
    expect(totals.catering_events).toBe(2)
  })
  it('reads per-row commission from the resolved column (retains it, not computed)', () => {
    const { totals } = parseCateringExport(rows, 'Gross Food Sales', 'Total Commission')
    // cogs = -(gfs - commission): -(100-19) + -(200-18) = -81 + -182 = -263
    expect(totals.rev_catering_cogs).toBeCloseTo(-263, 2)
    // net catering margin = revenue + cogs = retained commission = 37
    expect(totals.rev_catering_revenue + totals.rev_catering_cogs).toBeCloseTo(37, 2)
  })
  it('a 93%-commission (near-resale) row keeps its real rate, not a flat 19%', () => {
    const { totals } = parseCateringExport(
      [{ 'Event date': '6/3/2026', 'Gross Food Sales': 1000, 'Total Commission': 930, 'Entity name': '11 Dining LLC - Cafeteria' }],
      'Gross Food Sales', 'Total Commission')
    expect(totals.rev_catering_cogs).toBeCloseTo(-70, 2)   // -(1000-930), not -(1000-190)
  })
})
