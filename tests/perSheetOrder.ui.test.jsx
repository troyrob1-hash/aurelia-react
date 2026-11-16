// @vitest-environment jsdom

// Per-sheet positions on the REAL Inventory page (data hooks mocked, table
// untouched): Watermelon Fizz is counted on Beverages and the Coke Storage
// Closet, with its own position on the closet sheet. Each sheet must list it at
// its own place — first in the closet, between Apple and Cola in Beverages.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, act, within } from '@testing-library/react'

vi.mock('@/store/authStore', () => ({ useAuthStore: () => ({ user: { tenantId: 'fooda', role: 'manager', name: 'Test' } }) }))
vi.mock('@/store/LocationContext', () => ({
  useLocations: () => ({ selectedLocation: 'Test Sandbox', setSelectedLocation: () => {}, isParentLocation: () => false, getParentName: () => null }),
  cleanLocName: s => s,
}))
vi.mock('@/store/PeriodContext', () => ({
  usePeriod: () => ({ periodKey: '2026-P11-W3', isCurrentPeriod: true, currentWeek: null, week: 3 }),
  isShortWeek: () => false,
}))
vi.mock('@/lib/pnl', async () => ({
  ...(await vi.importActual('@/lib/pnl')),
  readPeriodClose: async () => ({ periodStatus: 'open' }), writePeriodClose: vi.fn(), lockPeriod: vi.fn(),
}))
vi.mock('@/lib/firebase', () => ({ db: {} }))
vi.mock('@/hooks/useAutosave', () => ({ useAutosave: () => ({ autoSaveStatus: 'idle', lastSavedAt: null }) }))
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ success: () => {}, error: () => {}, info: () => {} }) }))
vi.mock('@/components/SaveStatusBar', () => ({ default: () => null }))
vi.mock('@/components/BarcodeScanner', () => ({ default: () => null }))
vi.mock('@/components/ui/SubCafePrompt', () => ({ default: () => null }))
vi.mock('@/components/AllLocationsGrid', () => ({ default: () => null }))

const { ITEMS } = vi.hoisted(() => {
  const base = { vendor: 'Coke', packSize: 'case', qtyPerPack: 24, packPrice: 18, qty: null, eaches: null, _priorQty: null, _priorEaches: 0, _variance: 0 }
  return { ITEMS: [
    { ...base, id: 'a', name: 'Apple Fizz', category: 'Beverages', _cat: 'bev', catShelfOrder: 1 },
    { ...base, id: 'w', name: 'Watermelon Fizz', category: 'Beverages', _cat: 'bev', countCategories: ['bev', 'closet'], catShelfOrder: 2, sheetShelfOrder: { closet: 1 } },
    { ...base, id: 'c', name: 'Cola', category: 'Beverages', _cat: 'bev', catShelfOrder: 3 },
    { ...base, id: 'q', name: 'Quince Soda', category: 'Coke Storage Closet', _cat: 'closet', catShelfOrder: 2 },
    { ...base, id: 'r', name: 'Root Beer', category: 'Coke Storage Closet', _cat: 'closet', catShelfOrder: 3 },
  ] }
})
vi.mock('@/hooks/useInventory', async () => {
  const actual = await vi.importActual('@/hooks/useInventory')
  const noop = () => {}
  return {
    ...actual,
    useInventory: () => ({
      items: ITEMS, priorFromPeriod: null,
      categories: [{ key: 'bev', label: 'Beverages', color: '#1d4ed8', bg: '#eff6ff' }, { key: 'closet', label: 'Coke Storage Closet', color: '#b45309', bg: '#fffbeb' }],
      zones: [{ key: 'main', label: 'Main' }],
      catStats: { bev: { counted: 0, total: 3, value: 0 }, closet: { counted: 0, total: 3, value: 0 } }, categoryBreakdown: [],
      centLedger: { item: () => 0, share: () => 0, closingCents: 0 },
      totals: { counted: 1, total: 2, progress: 50, liveCOGS: 0, openingValue: 0, openingValueDisplay: 0, purchases: 0, belowPar: 0 },
      varianceAlerts: [], itemsBelowPar: [], session: null, loading: false, saving: false, dirty: false, error: null,
      load: noop, adjust: noop, adjustEaches: noop, setEaches: noop, setQty: noop, copyPrior: noop, toggleKey: noop,
      removeItem: noop, restoreItem: noop, addCustomItem: noop, removedItems: [], loadRemovedItems: noop, glCodes: [],
      buddyMode: false, setBuddyMode: noop, buddyNames: { caller: '', marker: '' }, setBuddyNames: noop,
      markSectionComplete: noop, markZoneSwept: noop, setItemCountCategories: noop, removeCategoriesFromItems: noop,
      setZoneValue: noop, save: noop, saveCounts: noop, mergeDraft: () => false, patchItemFields: noop,
      setCategoriesLocal: noop, setZonesLocal: noop, periodLocked: false, markPeriodLocked: noop,
      applyUploadedCounts: noop, rollOverFromPrior: noop,
    }),
  }
})

import Inventory from '../src/routes/Inventory'
import { useUIStore } from '../src/store/uiStore'

const NAMES = ['Apple Fizz', 'Watermelon Fizz', 'Cola', 'Quince Soda', 'Root Beer']
// Each category sheet renders as its own table; item names in row order.
const sheets = () => [...document.querySelectorAll('table')].map(t =>
  [...t.querySelectorAll('tbody tr')].map(tr => NAMES.find(n => tr.textContent.includes(n))).filter(Boolean))

beforeEach(() => {
  Object.defineProperty(window, 'innerWidth', { value: 1400, configurable: true })
  useUIStore.setState({ inventoryViewMode: 'grouped', inventoryShowPrior: true, inventoryShowVariance: true })
})
afterEach(cleanup)

describe('each sheet lists a split item at its own position', () => {
  it('Beverages: Apple, Watermelon, Cola — Closet: Watermelon (its own #1), Quince, Root Beer', async () => {
    await act(async () => { render(<Inventory />) })
    expect(screen.getByText('Beverages')).toBeTruthy()
    expect(screen.getByText('Coke Storage Closet')).toBeTruthy()
    expect(sheets()).toEqual([
      ['Apple Fizz', 'Watermelon Fizz', 'Cola'],
      ['Watermelon Fizz', 'Quince Soda', 'Root Beer'],
    ])
  })
})
