// @vitest-environment jsdom

// The View toggles hide real table columns. Renders the REAL Inventory page
// (data hooks mocked, table untouched) and checks the Prior and Variance
// columns — header, row cells, the prior hint in the count box, and the
// footer alignment — against each toggle. Display only: the data the columns
// would show (_priorQty, _variance) must still be there for everything else.

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

const { ITEMS } = vi.hoisted(() => ({ ITEMS: [
  { id: 'a', name: 'Apple Fizz', vendor: 'Coke', packSize: 'case', qtyPerPack: 24, packPrice: 18, category: 'Beverages', _cat: 'bev',
    qty: 3, eaches: 0, _priorQty: 7, _priorEaches: 2, _variance: -4, catShelfOrder: 1 },
  { id: 'b', name: 'Banana Soda', vendor: 'Coke', packSize: 'case', qtyPerPack: 12, packPrice: 9, category: 'Beverages', _cat: 'bev',
    qty: null, eaches: null, _priorQty: 5, _priorEaches: 0, _variance: 0, catShelfOrder: 2 },
] }))
vi.mock('@/hooks/useInventory', async () => {
  const actual = await vi.importActual('@/hooks/useInventory')
  const noop = () => {}
  return {
    ...actual,
    useInventory: () => ({
      items: ITEMS, priorFromPeriod: null,
      categories: [{ key: 'bev', label: 'Beverages', color: '#1d4ed8', bg: '#eff6ff' }],
      zones: [{ key: 'main', label: 'Main' }],
      catStats: { bev: { counted: 1, total: 2, value: 54 } }, categoryBreakdown: [],
      centLedger: { item: () => 5400, share: () => 0, closingCents: 5400 },
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

const set = (prior, variance) => useUIStore.setState({ inventoryShowPrior: prior, inventoryShowVariance: variance, inventoryViewMode: 'grouped' })
const table = () => screen.getByRole('table')
const headers = () => within(table()).getAllByRole('columnheader').map(h => h.firstChild.textContent.trim())
const row = name => within(table()).getByText(name).closest('tr')
const cell = (name, col) => row(name).querySelector(`[data-col="${col}"]`)
const caseBox = name => row(name).querySelector('input[title^="Cases"]')

async function mount() {
  await act(async () => { render(<Inventory />) })
}

beforeEach(() => { Object.defineProperty(window, 'innerWidth', { value: 1400, configurable: true }) })
afterEach(() => { cleanup(); set(true, true) })

describe('Show last week\'s counts', () => {
  it('on (the default): Prior column header, each row\'s prior cases/eaches, and the prior hint in the count box', async () => {
    set(true, true)
    await mount()
    expect(headers()).toEqual(['Item', 'Vendor', 'Pack', 'Qty/pk', 'Pack $', 'Prior', 'Count', 'Variance', 'Value'])
    expect(cell('Apple Fizz', 'prior').textContent).toBe('72')
    expect(caseBox('Banana Soda').placeholder).toBe('5')
  })

  it('off: no Prior header, no prior cells, no last-week value anywhere in the rows', async () => {
    set(false, true)
    await mount()
    expect(headers()).not.toContain('Prior')
    expect(cell('Apple Fizz', 'prior')).toBeNull()
    expect(caseBox('Banana Soda').placeholder).toBe('0')
    // No prior figure (7 / 2 / 5) leaks into a row's text.
    expect(row('Banana Soda').textContent).not.toMatch(/\b5\b/)
    expect(row('Apple Fizz').textContent).not.toMatch(/\b7\b/)
  })
})

describe('Show variance', () => {
  it('on (the default): Variance header and the variance badge in the row', async () => {
    set(true, true)
    await mount()
    expect(headers()).toContain('Variance')
    expect(cell('Apple Fizz', 'variance').textContent).toBe('-4.0')
  })

  it('off: no Variance header and no variance cells; Prior is unaffected', async () => {
    set(true, false)
    await mount()
    expect(headers()).not.toContain('Variance')
    expect(cell('Apple Fizz', 'variance')).toBeNull()
    expect(row('Apple Fizz').textContent).not.toMatch(/-4\.0/)
    expect(headers()).toContain('Prior')
  })
})

describe('the table stays aligned and the data stays', () => {
  it.each([[true, true], [false, true], [true, false], [false, false]])('prior %s / variance %s: header, rows and footer all have the same width', async (p, v) => {
    set(p, v)
    await mount()
    const width = tr => [...tr.children].reduce((n, td) => n + (Number(td.getAttribute('colspan')) || 1), 0)
    const t = table()
    const head = width(t.querySelector('thead tr'))
    expect(head).toBe(9 - (p ? 0 : 1) - (v ? 0 : 1))
    for (const tr of t.querySelectorAll('tbody tr')) expect(width(tr)).toBe(head)
    expect(width(t.querySelector('tfoot tr'))).toBe(head)
  })

  it('both off: the values the columns would show are still on the items (display-only)', async () => {
    set(false, false)
    await mount()
    expect(ITEMS[0]._priorQty).toBe(7)
    expect(ITEMS[0]._variance).toBe(-4)
    // Value column — computed from the same ledger — still renders.
    expect(headers()).toContain('Value')
  })

  it('the toggles default on and live in the same store as grouped/flat', () => {
    const fresh = useUIStore.getInitialState?.() ?? useUIStore.getState()
    expect(fresh.inventoryShowPrior).toBe(true)
    expect(fresh.inventoryShowVariance).toBe(true)
  })
})
