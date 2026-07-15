// Money-path guard for the café/popup Popup-vs-Retail split. The reliable rule
// (verified against a real 308-row multi-site export): RETAIL = "11 Dining" (Fooda's
// own operating entity, universal marker) in Restaurant Internal Name; POPUP = else;
// BLANK = unclassified (surfaced, never silently popup). Location Name and fuzzy
// barista/cafeteria matching are traps — see the ZONZO/Copper Door cases below.
import { describe, it, expect } from 'vitest'
import { classifyVendor } from '@/lib/parseEventExport'

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
