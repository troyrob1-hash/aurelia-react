// @vitest-environment jsdom

// When a save is refused because the items on screen don't belong to the
// selected location (PR #17's guard) — or any save fails — the save bar must
// say the save did not happen, not keep showing "Saving in a moment…". The
// manual Save button's toast gives the same reason.
//
// Renders the real Inventory page and the REAL SaveStatusBar (useInventory /
// useAutosave mocked to the refused state). Hook-level behaviour is pinned in
// staleLoad.test.jsx and useAutosave.test.jsx.

import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react'

const { state } = vi.hoisted(() => ({ state: { dirty: true, autoSaveStatus: 'failed', reason: null, toast: null } }))

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
vi.mock('@/hooks/useAutosave', () => ({ useAutosave: () => ({ autoSaveStatus: state.autoSaveStatus, lastSavedAt: null }) }))
vi.mock('@/components/ui/Toast', () => ({ useToast: () => state.toast }))
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
      varianceAlerts: [], itemsBelowPar: [], session: null, loading: false, saving: false, dirty: state.dirty, error: null,
      load: noop, adjust: noop, adjustEaches: noop, setEaches: noop, setQty: noop, copyPrior: noop, toggleKey: noop,
      removeItem: noop, restoreItem: noop, addCustomItem: noop, removedItems: [], loadRemovedItems: noop, glCodes: [],
      buddyMode: false, setBuddyMode: noop, buddyNames: { caller: '', marker: '' }, setBuddyNames: noop,
      markSectionComplete: noop, markZoneSwept: noop, setItemCountCategories: noop, removeCategoriesFromItems: noop,
      setZoneValue: noop, save: async () => false, saveCounts: async () => false, mergeDraft: () => false, patchItemFields: noop,
      setCategoriesLocal: noop, setZonesLocal: noop, periodLocked: false, markPeriodLocked: noop,
      applyUploadedCounts: noop, rollOverFromPrior: noop,
      saveBlockedReason: state.reason, getSaveBlockedReason: () => state.reason,
    }),
  }
})

import Inventory from '../src/routes/Inventory'
import SaveStatusBar from '../src/components/SaveStatusBar'

const REASON = "Not saved: this location's items are still loading. Press Save once they appear."
const freshToast = () => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() })

afterEach(() => { cleanup(); Object.assign(state, { dirty: true, autoSaveStatus: 'failed', reason: null }) })

describe('SaveStatusBar', () => {
  it('failed + unsaved edits: "Not saved" with the reason, not "Saving in a moment…"', () => {
    render(<SaveStatusBar autoSaveStatus="failed" dirty failedMessage={REASON} onSave={() => {}} />)
    expect(screen.getByText('Not saved')).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toBe(REASON)
    expect(screen.queryByText(/Saving in a moment/)).toBeNull()
  })
  it('failed without a specific reason still says it did not save', () => {
    render(<SaveStatusBar autoSaveStatus="failed" dirty />)
    expect(screen.getByRole('alert').textContent).toMatch(/didn't save/)
  })
  it('a pending (not failed) save still reads "Saving in a moment…"; nothing unsaved reads "All changes saved"', () => {
    const { rerender } = render(<SaveStatusBar autoSaveStatus="idle" dirty />)
    expect(screen.getByText(/Saving in a moment/)).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
    rerender(<SaveStatusBar autoSaveStatus="failed" dirty={false} />)
    expect(screen.getByText('All changes saved')).toBeTruthy()
  })
})

describe('Inventory page', () => {
  it('a refused save shows "Not saved" and the reason in the save bar', async () => {
    state.reason = REASON; state.toast = freshToast()
    await act(async () => { render(<Inventory />) })
    expect(screen.getByText('Not saved')).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toBe(REASON)
  })
  it('pressing Save when the save is refused toasts the reason, not a generic failure', async () => {
    state.reason = REASON; state.toast = freshToast()
    await act(async () => { render(<Inventory />) })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save' })) })
    expect(state.toast.error).toHaveBeenCalledWith(REASON)
  })
})
