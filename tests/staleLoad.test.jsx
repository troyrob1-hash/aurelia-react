// @vitest-environment jsdom

// Switching location (or period) mid-load must never mix two locations.
//
// useInventory.load() sets state at several points with awaits between them
// (items → prior items → opening value / purchases / categories / zones /
// session). Before the guard, a slow load for the location the user just left
// could land after the new one: reproduced live on 2026-11-18 by switching
// CR_TMC → Test Sandbox within 150 ms — Test Sandbox's items under TMC's
// categories, $0 opening and session. A save in that state writes to the
// location now selected.
//
// These drive the REAL hook against an in-memory Firestore whose reads can be
// held back per path, so the slow load can be released at the worst moment.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act, waitFor, cleanup } from '@testing-library/react'

const { store, writes, holds } = vi.hoisted(() => ({ store: new Map(), writes: [], holds: [] }))

vi.mock('firebase/firestore', () => {
  const ref = (base, ...segs) => ({ path: [...(base?.path ? [base.path] : []), ...segs].join('/') })
  const gate = async (path) => { for (const h of [...holds]) if (h.match(path)) await h.promise }
  const snapOf = (path) => ({ id: path.split('/').pop(), ref: { path }, exists: () => store.has(path), data: () => store.get(path) })
  // Writes can be held too ('write:' + path), to model a slow network save.
  const record = async (op, r, data) => {
    await gate('write:' + r.path)
    writes.push({ op, path: r.path })
    if (op === 'delete') store.delete(r.path)
    else store.set(r.path, { ...(store.get(r.path) || {}), ...(data || {}) })
  }
  return {
    doc: ref,
    collection: ref,
    getDoc: async (r) => { await gate(r.path); return snapOf(r.path) },
    getDocs: async (r) => {
      await gate(r.path)
      const depth = r.path.split('/').length + 1
      const docs = [...store.keys()]
        .filter(p => p.startsWith(r.path + '/') && p.split('/').length === depth)
        .map(snapOf)
      return { empty: docs.length === 0, size: docs.length, docs, forEach: fn => docs.forEach(fn) }
    },
    setDoc: async (r, data) => record('set', r, data),
    updateDoc: async (r, data) => record('update', r, data),
    deleteDoc: async (r) => record('delete', r),
    writeBatch: () => {
      const ops = []
      return {
        set: (r, d) => ops.push(['set', r, d]),
        update: (r, d) => ops.push(['update', r, d]),
        delete: (r) => ops.push(['delete', r]),
        commit: async () => { for (const [op, r, d] of ops) await record(op, r, d) },
      }
    },
    onSnapshot: () => () => {},
    query: (r) => r,
    where: () => null,
    documentId: () => '__id__',
    serverTimestamp: () => 'ts',
    deleteField: () => undefined,
    arrayUnion: (...v) => v,
    arrayRemove: () => [],
  }
})
vi.mock('@/lib/firebase', () => ({ db: {}, auth: {} }))
vi.mock('@/store/authStore', () => ({ useAuthStore: { getState: () => ({ user: { tenantId: 'fooda' } }) } }))
vi.mock('@/lib/pnl', async (importOriginal) => ({ ...(await importOriginal()), isPeriodLocked: async () => false }))
vi.mock('@/hooks/useCountsListener', () => ({ useCountsListener: () => {} }))
vi.mock('@/components/ui/Toast', () => {
  const toast = { success: () => {}, error: () => {}, info: () => {}, warning: () => {} }
  return { useToast: () => toast }
})

import { useInventory } from '../src/hooks/useInventory'
import { useAutosave } from '../src/hooks/useAutosave'
import { resolveZones } from '../src/lib/zoneHelpers'

const T = 'tenants/fooda'
const W3 = '2026-P11-W3'
const W2 = '2026-P11-W2'
const USER = { email: 'troy@x.test', name: 'Troy', uid: 'troy' }

// Hold back every read whose path matches; returns the release function.
function hold(match) {
  let release
  const promise = new Promise(r => { release = r })
  holds.push({ match, promise, release: () => release() })
  return release
}
const settle = () => act(() => new Promise(r => setTimeout(r, 30)))

function seed() {
  const item = (loc, id, name, category) =>
    store.set(`${T}/inventory/${loc}/items/${id}`, { id, name, category, isCatalogItem: true, packPrice: 24, qtyPerPack: 24, packSize: 'case', vendor: 'V' })
  // Test Sandbox: its own categories, a prior close of $168, a session, a W3 count.
  item('Test_Sandbox', 'wf', 'Watermelon Fizz', 'coke_storage_closet')
  item('Test_Sandbox', 'zc', 'Zebra Cola', 'coke_storage_closet')
  store.set(`${T}/inventory/Test_Sandbox/settings/categories`, { categories: [
    { key: 'beverages', label: 'Beverages', color: '#1e40af', bg: '#dbeafe', keywords: [] },
    { key: 'coke_storage_closet', label: 'Coke Storage Closet', color: '#374151', bg: '#f3f4f6', keywords: [] },
  ] })
  store.set(`${T}/pnl/Test_Sandbox/periods/${W2}`, { closingValue: 168 })
  store.set(`${T}/inventorySessions/Test_Sandbox_${W3}`, { status: 'in_progress', startedBy: 'sandbox@x.test', sectionsCompleted: [] })
  store.set(`${T}/inventory/Test_Sandbox/counts/${W3}/items/wf`, { itemId: 'wf', qty: 3 })
  store.set(`${T}/inventory/Test_Sandbox/counts/${W2}/items/wf`, { itemId: 'wf', qty: 9 })
  // Slow Loc: different categories, zones, prior close; no W3 session yet.
  item('Slow_Loc', 'oj', 'Orange Juice', 'dairy')
  store.set(`${T}/inventory/Slow_Loc/settings/categories`, { categories: [
    { key: 'dairy', label: 'Dairy', color: '#0369a1', bg: '#e0f2fe', keywords: [] },
  ] })
  store.set(`${T}/inventory/Slow_Loc/settings/zones`, { zones: [{ key: 'walk_in', label: 'Walk-in' }, { key: 'shelf', label: 'Shelf' }] })
  store.set(`${T}/pnl/Slow_Loc/periods/${W2}`, { closingValue: 999 })
  store.set(`${T}/inventory/Slow_Loc/counts/${W2}/items/oj`, { itemId: 'oj', qty: 7 })
}

let warn, log
beforeEach(() => {
  store.clear(); writes.length = 0; holds.length = 0
  seed()
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  log = vi.spyOn(console, 'log').mockImplementation(() => {})
  return () => { warn.mockRestore(); log.mockRestore() }
})

// Unmount, then let any still-held load finish, so nothing leaks into the next test.
afterEach(async () => {
  cleanup()
  holds.forEach(h => h.release())
  await new Promise(r => setTimeout(r, 30))
})

const render = (location, period = W3) => renderHook(
  ({ loc, pk }) => useInventory('fooda', loc, pk, USER),
  { initialProps: { loc: location, pk: period } },
)

// The complete Test Sandbox W3 picture — everything load() sets.
function expectSandboxW3(r) {
  const s = r.current
  expect(s.items.map(i => i.name).sort()).toEqual(['Watermelon Fizz', 'Zebra Cola'])
  expect(s.items.find(i => i.id === 'wf').qty).toBe(3)
  expect(s.categories.map(c => c.key)).toEqual(['beverages', 'coke_storage_closet'])
  expect(s.totals.openingValue).toBe(168)
  expect(s.zones).toEqual(resolveZones(null))
  expect(s.session).toMatchObject({ startedBy: 'sandbox@x.test' })
  // Prior column = Test Sandbox W2 (wf 9), not Slow Loc's (oj 7).
  expect(s.items.find(i => i.id === 'wf')._priorQty).toBe(9)
  expect(s.loading).toBe(false)
  expect(s.error).toBeNull()
}

describe('a superseded load never lands', () => {
  it('slow location left mid-load (its tail lands last) — the live repro: nothing from it is applied', async () => {
    // Slow Loc's items arrive, but its prior-period reads hang — like TMC's
    // 452-item walk-back — so its categories/opening/zones/session come last.
    const release = hold(p => p.startsWith(`${T}/inventory/Slow_Loc/counts/`) && !p.includes(W3))
    const { result, rerender } = render('Slow Loc')
    await waitFor(() => expect(result.current.items.map(i => i.id)).toEqual(['oj']))

    rerender({ loc: 'Test Sandbox', pk: W3 })
    await waitFor(() => expect(result.current.loading).toBe(false))
    expectSandboxW3(result)

    release()
    await settle()
    expectSandboxW3(result)
  })

  it('slow location whose whole load lands last: its items do not replace the new ones', async () => {
    const release = hold(p => p.includes('Slow_Loc'))
    const { result, rerender } = render('Slow Loc')
    rerender({ loc: 'Test Sandbox', pk: W3 })
    await waitFor(() => expect(result.current.loading).toBe(false))
    expectSandboxW3(result)

    release()
    await settle()
    expectSandboxW3(result)
  })

  it('period switched mid-load: the old week does not land on the new one', async () => {
    // Hold only reads started during the W2 load (W2 counts are also W3's
    // prior, so hold by "started now", not by path).
    const holding = { on: true }
    const release = hold(() => holding.on)
    const { result, rerender } = render('Test Sandbox', W2)
    await act(async () => {})
    holding.on = false
    rerender({ loc: 'Test Sandbox', pk: W3 })
    await waitFor(() => expect(result.current.loading).toBe(false))
    expectSandboxW3(result)

    release()
    await settle()
    expectSandboxW3(result)
  })

  it('an old load finishing while the new one is still loading neither applies nor ends the loading state', async () => {
    const holding = { on: true }
    const releaseSandbox = hold(() => holding.on)
    const { result, rerender } = render('Test Sandbox')
    await act(async () => {})
    holding.on = false
    hold(p => p.includes('Slow_Loc'))
    rerender({ loc: 'Slow Loc', pk: W3 })

    releaseSandbox()
    await settle()
    expect(result.current.loading).toBe(true)
    expect(result.current.items).toEqual([])
    expect(result.current.categories).toEqual([])
  })

  it('a location only passed through does not get a session doc', async () => {
    const release = hold(p => p.includes('Slow_Loc'))
    const { result, rerender } = render('Slow Loc')
    rerender({ loc: 'Test Sandbox', pk: W3 })
    await waitFor(() => expect(result.current.loading).toBe(false))
    release()
    await settle()
    expect(writes.filter(w => w.path.includes('Slow_Loc'))).toEqual([])
    expect(store.has(`${T}/inventorySessions/Slow_Loc_${W3}`)).toBe(false)
  })

  it('switching to All Locations mid-load clears loading instead of leaving it stuck', async () => {
    const release = hold(p => p.includes('Slow_Loc'))
    const { result, rerender } = render('Slow Loc')
    rerender({ loc: null, pk: W3 })
    await waitFor(() => expect(result.current.loading).toBe(false))
    release()
    await settle()
    expect(result.current.items).toEqual([])
    expect(result.current.loading).toBe(false)
  })
})

describe('a save never writes one location onto another', () => {
  it('while the next location is still loading, saveCounts and save refuse and write nothing', async () => {
    const { result, rerender } = render('Test Sandbox')
    await waitFor(() => expect(result.current.loading).toBe(false))
    act(() => result.current.adjust('wf', 1))

    const release = hold(p => p.includes('Slow_Loc'))
    rerender({ loc: 'Slow Loc', pk: W3 })
    // Items on screen are still Test Sandbox's; the selection is Slow Loc.
    expect(result.current.items.map(i => i.id).sort()).toEqual(['wf', 'zc'])
    writes.length = 0
    let saved, savedFull
    await act(async () => { saved = await result.current.saveCounts() })
    await act(async () => { savedFull = await result.current.save() })
    expect(saved).toBe(false)
    expect(savedFull).toBe(false)
    expect(writes).toEqual([])

    // Once Slow Loc's own items are in, saving works and lands on Slow Loc only.
    release()
    await waitFor(() => expect(result.current.items.map(i => i.id)).toEqual(['oj']))
    await waitFor(() => expect(result.current.loading).toBe(false))
    act(() => result.current.adjust('oj', 2))
    writes.length = 0
    await act(async () => { saved = await result.current.saveCounts() })
    expect(saved).toBe(true)
    expect(writes.length).toBeGreaterThan(0)
    expect(writes.every(w => w.path.includes('Slow_Loc'))).toBe(true)
  })

  it('after a mixed race settles, a save writes only the selected location’s own items', async () => {
    const release = hold(p => p.includes('Slow_Loc'))
    const { result, rerender } = render('Slow Loc')
    rerender({ loc: 'Test Sandbox', pk: W3 })
    await waitFor(() => expect(result.current.loading).toBe(false))
    release()
    await settle()

    act(() => result.current.adjust('zc', 4))
    writes.length = 0
    let saved
    await act(async () => { saved = await result.current.saveCounts() })
    expect(saved).toBe(true)
    expect(writes.some(w => w.path.includes('Slow_Loc'))).toBe(false)
    expect(writes.map(w => w.path)).toContain(`${T}/inventory/Test_Sandbox/counts/${W3}/items/id_zc`)
    // closingValue is computed from Test Sandbox's items: wf 3 + zc 4 cases × $24.
    expect(store.get(`${T}/pnl/Test_Sandbox/periods/${W3}`).closingValue).toBe(168)
  })

  it('unsaved edits still flush to the location being LEFT when switching (autosave on location change)', async () => {
    const { result, rerender } = renderHook(({ loc }) => {
      const inv = useInventory('fooda', loc, W3, USER)
      useAutosave({ dirty: inv.dirty, save: inv.saveCounts, flushKey: `fooda|${loc}|${W3}`, debounceMs: 60000 })
      return inv
    }, { initialProps: { loc: 'Test Sandbox' } })
    await waitFor(() => expect(result.current.loading).toBe(false))
    act(() => result.current.adjust('zc', 5))
    writes.length = 0

    hold(p => p.includes('Slow_Loc'))
    rerender({ loc: 'Slow Loc' })
    await settle()

    expect(writes.map(w => w.path)).toContain(`${T}/inventory/Test_Sandbox/counts/${W3}/items/id_zc`)
    expect(writes.some(w => w.path.includes('Slow_Loc'))).toBe(false)
  })

  it('an edit left pending at the old location is not autosaved onto the next one once its items arrive', async () => {
    // Live repro on the PR branch: edit at Test Sandbox, switch to CR_TMC
    // inside the 2 s autosave window; when the timer fired, TMC's own items had
    // just loaded, so the save wrote TMC's P&L and snapshot at $0 — a phantom
    // "counted" week for a location the user only opened.
    const { result, rerender } = renderHook(({ loc }) => {
      const inv = useInventory('fooda', loc, W3, USER)
      useAutosave({ dirty: inv.dirty, save: inv.saveCounts, flushKey: `fooda|${loc}|${W3}`, debounceMs: 300 })
      return inv
    }, { initialProps: { loc: 'Test Sandbox' } })
    await waitFor(() => expect(result.current.loading).toBe(false))
    act(() => result.current.adjust('zc', 5))

    // The switch-time save to Test Sandbox is slow (as on a real network), so
    // it is still running when the 300 ms autosave timer comes due.
    const releaseWrites = hold(p => p.startsWith('write:') && p.includes('Test_Sandbox'))
    // Slow Loc's items arrive quickly but the rest of its load (prior weeks)
    // is still running when the timer comes due — the browser timeline.
    const releaseTail = hold(p => p.startsWith(`${T}/inventory/Slow_Loc/counts/`) && !p.includes(W3))
    rerender({ loc: 'Slow Loc' })
    await waitFor(() => expect(result.current.items.map(i => i.id)).toEqual(['oj']))
    await act(() => new Promise(r => setTimeout(r, 600)))
    releaseTail()
    releaseWrites()
    await settle()

    expect(writes.map(w => w.path)).toContain(`${T}/inventory/Test_Sandbox/counts/${W3}/items/id_zc`)
    expect(writes.filter(w => w.path.includes('Slow_Loc') && !w.path.includes('inventorySessions'))).toEqual([])
    expect(store.has(`${T}/pnl/Slow_Loc/periods/${W3}`)).toBe(false)
    expect(result.current.dirty).toBe(false)
  })

  it('hiding the page right after a switch does not save the next location (no carried-over unsaved flag)', async () => {
    const { result, rerender } = renderHook(({ loc }) => {
      const inv = useInventory('fooda', loc, W3, USER)
      useAutosave({ dirty: inv.dirty, save: inv.saveCounts, flushKey: `fooda|${loc}|${W3}`, debounceMs: 60000 })
      return inv
    }, { initialProps: { loc: 'Test Sandbox' } })
    await waitFor(() => expect(result.current.loading).toBe(false))
    act(() => result.current.adjust('zc', 5))

    const releaseWrites = hold(p => p.startsWith('write:') && p.includes('Test_Sandbox'))
    const releaseTail = hold(p => p.startsWith(`${T}/inventory/Slow_Loc/counts/`) && !p.includes(W3))
    rerender({ loc: 'Slow Loc' })
    await waitFor(() => expect(result.current.items.map(i => i.id)).toEqual(['oj']))
    await act(async () => { window.dispatchEvent(new Event('pagehide')) })
    await settle()
    releaseTail()
    releaseWrites()
    await settle()

    expect(writes.filter(w => w.path.includes('Slow_Loc') && !w.path.includes('inventorySessions'))).toEqual([])
  })
})

