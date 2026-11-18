// @vitest-environment jsdom

// Weekly Sales and Labor keep an autosave draft (useAutosave snapshot/hydrate),
// keyed by tab + location + week. A save that fails followed by a reload must
// restore the unsaved edit and save it; a draft for another week or location
// must never restore here.
//
// Renders the REAL pages against an in-memory Firestore whose writes can be
// made to fail. "Reload" = unmount + mount again.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react'

vi.mock('firebase/firestore', () => import('./helpers/fakeFirestore.js'))
vi.mock('@/lib/firebase', () => ({ db: {}, auth: {} }))

const ctx = vi.hoisted(() => ({ loc: 'Test_Sandbox', periodKey: '2026-P11-W3', toasts: [] }))
vi.mock('@/store/authStore', () => {
  const user = { uid: 'troy', email: 'troy@x.test', name: 'Troy', role: 'admin', tenantId: 'fooda' }
  const useAuthStore = (sel) => (sel ? sel({ user }) : { user })
  useAuthStore.getState = () => ({ user })
  return { useAuthStore }
})
vi.mock('@/store/LocationContext', () => ({
  useLocations: () => ({
    selectedLocation: ctx.loc, setSelectedLocation: () => {}, visibleLocations: [{ name: ctx.loc }],
    currentLocation: { name: ctx.loc }, groupedLocations: {}, isParentLocation: () => false,
    getParentName: () => null, allLocations: [{ name: ctx.loc }], locationsByName: {},
  }),
  cleanLocName: (n) => n,
}))
vi.mock('@/store/PeriodContext', () => ({
  usePeriod: () => ({
    year: 2026, period: 11, week: 3, periodKey: ctx.periodKey,
    currentWeek: { start: new Date(2026, 10, 15), end: new Date(2026, 10, 21) },
    weeks: [{ start: new Date(2026, 10, 15), end: new Date(2026, 10, 21) }],
    prevWeek: () => {}, nextWeek: () => {},
  }),
}))
vi.mock('@/components/ui/Toast', () => {
  const push = (kind) => (msg) => ctx.toasts.push([kind, msg])
  const toast = { success: push('success'), error: push('error'), info: push('info'), warning: push('warning') }
  return { useToast: () => toast }
})
vi.mock('@/lib/usePnL', () => ({ useLedgerEnrichedPnL: () => ({ data: {} }) }))
vi.mock('@/lib/ledgerContributions', () => ({ computeLedgerContributions: async () => ({}) }))

import { store, control, reset } from './helpers/fakeFirestore.js'
import WeeklySales from '../src/routes/WeeklySales'
import LaborPlanner from '../src/routes/LaborPlanner'

const LS = 'aurelia:autosave:'
const SALES_KEY = 'sales|fooda|Test_Sandbox|2026-P11-W3'
const LABOR_KEY = 'labor|fooda|Test_Sandbox|2026-P11-W3'
const SALES_DOC = 'tenants/fooda/locations/Test_Sandbox/sales/2026-P11-W3'

beforeEach(() => {
  reset()
  ctx.loc = 'Test_Sandbox'; ctx.periodKey = '2026-P11-W3'; ctx.toasts.length = 0
  const ls = new Map()
  globalThis.localStorage = {
    getItem: (k) => (ls.has(k) ? ls.get(k) : null), setItem: (k, v) => ls.set(k, String(v)),
    removeItem: (k) => ls.delete(k), clear: () => ls.clear(), key: (i) => [...ls.keys()][i] ?? null,
    get length() { return ls.size },
  }
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

const draft = (key) => JSON.parse(localStorage.getItem(LS + key) || 'null')
const waitAutosave = () => act(() => new Promise(r => setTimeout(r, 2300)))

describe('Weekly Sales draft backup', () => {
  const sundayPopup = async () => (await screen.findAllByPlaceholderText('0.00'))[0]

  it('a failed save + reload restores the unsaved edit and saves it', async () => {
    const first = render(<WeeklySales />)
    const input = await sundayPopup()
    control.failWrites = true
    fireEvent.change(input, { target: { value: '77' } })
    await waitAutosave()
    expect(store.has(SALES_DOC)).toBe(false)                     // the save failed
    expect(draft(SALES_KEY)).toMatchObject({ key: SALES_KEY })   // ...but the draft is kept
    expect(JSON.stringify(draft(SALES_KEY).data)).toContain('77')
    first.unmount()                                              // reload

    control.failWrites = false
    render(<WeeklySales />)
    await waitFor(async () => expect((await sundayPopup()).value).toBe('77'))
    expect(ctx.toasts).toContainEqual(['success', 'Restored unsaved sales from before the page closed'])
    await waitAutosave()
    await waitFor(() => expect(JSON.stringify(store.get(SALES_DOC)?.entries)).toContain('77'))
    expect(draft(SALES_KEY)).toBeNull()                          // cleared once saved
  }, 20000)

  it('a draft for another week or another location is never restored here', async () => {
    localStorage.setItem(LS + 'sales|fooda|Test_Sandbox|2026-P11-W2', JSON.stringify({ key: 'sales|fooda|Test_Sandbox|2026-P11-W2', data: { '2026-11-15': { popup: 55 } }, ts: 1 }))
    localStorage.setItem(LS + 'sales|fooda|CR_TMC|2026-P11-W3', JSON.stringify({ key: 'sales|fooda|CR_TMC|2026-P11-W3', data: { '2026-11-15': { popup: 66 } }, ts: 1 }))
    // Inventory's key for the same location/week must not be read by Sales.
    localStorage.setItem(LS + 'fooda|Test_Sandbox|2026-P11-W3', JSON.stringify({ key: 'fooda|Test_Sandbox|2026-P11-W3', data: [{ id: 'x', qty: 1 }], ts: 1 }))
    render(<WeeklySales />)
    const input = await sundayPopup()
    await act(() => new Promise(r => setTimeout(r, 300)))
    expect(input.value).toBe('')
    expect(ctx.toasts.filter(t => /Restored/.test(t[1]))).toEqual([])
  }, 10000)
})

describe('Labor draft backup', () => {
  const seedSubmission = () => store.set('tenants/fooda/laborSubmissions/sub1', {
    period: '2026-P11-W3', location: 'Test_Sandbox', status: 'pending', importedBy: 'Troy',
    glRows: [{ gl: '68100', label: 'Bonus pool', section: 'Comp & Benefits', amount: 50 }],
  })
  const bonusInput = () => screen.findByDisplayValue((v, el) => el?.getAttribute?.('data-labor-gl') === '68100')

  it('a failed save + reload restores the unsaved edit and saves it', async () => {
    seedSubmission()
    const first = render(<LaborPlanner />)
    const input = await bonusInput()
    expect(input.value).toBe('50')
    control.failWrites = true
    fireEvent.change(input, { target: { value: '75' } })
    await waitAutosave()
    expect(store.get('tenants/fooda/laborSubmissions/sub1').glRows[0].amount).toBe(50)   // save failed
    expect(draft(LABOR_KEY)).toMatchObject({ key: LABOR_KEY })
    first.unmount()

    control.failWrites = false
    render(<LaborPlanner />)
    await waitFor(async () => expect((await bonusInput()).value).toBe('75'))
    expect(ctx.toasts).toContainEqual(['success', 'Restored unsaved labor entries from before the page closed'])
    await waitAutosave()
    await waitFor(() => expect(store.get('tenants/fooda/laborSubmissions/sub1').glRows.find(r => r.gl === '68100').amount).toBe(75))
    expect(draft(LABOR_KEY)).toBeNull()
  }, 20000)

  it('a draft for another week is never restored here', async () => {
    seedSubmission()
    localStorage.setItem(LS + 'labor|fooda|Test_Sandbox|2026-P11-W2', JSON.stringify({ key: 'labor|fooda|Test_Sandbox|2026-P11-W2', data: [{ gl: '68100', amount: 999 }], ts: 1 }))
    render(<LaborPlanner />)
    const input = await bonusInput()
    await act(() => new Promise(r => setTimeout(r, 300)))
    expect(input.value).toBe('50')
  }, 10000)
})
