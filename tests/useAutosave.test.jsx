// @vitest-environment jsdom

// Regression test for useAutosave count-loss bug (commit da2baaa).
//
// The bug: the debounced-save effect listed `save` in its deps. Every parent
// re-render (i.e. every keystroke) created a fresh save closure, so the effect
// tore down and reset its setTimeout on every keystroke and the save never
// fired while the user kept entering inventory counts. They lost data.
//
// The fix: depend only on `dirty` (+ enabled/debounceMs) and read save from a
// ref. This test reproduces the keystroke pattern and asserts the debounce
// timer survives identity changes to save.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useAutosave } from '../src/hooks/useAutosave'

describe('useAutosave', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    // vitest 4 + jsdom 25 leaves globalThis.localStorage as a plain {} (the
    // `--localstorage-file was provided without a valid path` warning is the
    // tell). Inject a minimal in-memory Storage shim so the hook's
    // localStorage backstop has something to write to during tests.
    const store = new Map()
    globalThis.localStorage = {
      getItem: (k) => store.has(k) ? store.get(k) : null,
      setItem: (k, v) => { store.set(k, String(v)) },
      removeItem: (k) => { store.delete(k) },
      clear: () => store.clear(),
      get length() { return store.size },
      key: (i) => Array.from(store.keys())[i] ?? null,
    }
  })
  afterEach(() => {
    vi.useRealTimers()
    globalThis.localStorage?.clear?.()
  })

  it('still fires the debounced save when save fn identity changes on every render', async () => {
    const debounceMs = 2000
    let saveCount = 0
    const makeSave = () => vi.fn(async () => { saveCount++; return true })

    const { rerender } = renderHook(
      ({ save }) => useAutosave({ dirty: true, save, debounceMs }),
      { initialProps: { save: makeSave() } }
    )

    // Simulate 10 keystrokes spaced 200ms apart (200ms × 10 = 2000ms total),
    // each one re-rendering the parent with a brand-new save closure — exactly
    // the pattern that caused inventory counts to vanish.
    for (let i = 0; i < 10; i++) {
      await vi.advanceTimersByTimeAsync(200)
      rerender({ save: makeSave() })
    }

    // User stops typing. Advance LESS than debounceMs. In the fixed hook the
    // original timer (set at mount, never reset) already fired at t=2000. In
    // the buggy hook the timer was reset on every keystroke and is still
    // pending (would fire at t≈4000), so saveCount stays 0.
    await vi.advanceTimersByTimeAsync(debounceMs - 100)

    expect(saveCount).toBeGreaterThan(0)
  })

  it('flushes the pending save when flushKey changes (e.g. week or location switch)', async () => {
    // Inventory counts rely on this path: when a manager switches week or
    // location mid-entry, the [flushKey] effect's cleanup must flush the
    // outgoing context's dirty buffer to Firestore before the new context
    // mounts. If the wiring breaks, the in-progress counts are silently
    // dropped (the bug behind commit 13d3289).
    const save = vi.fn(async () => true)

    const { rerender } = renderHook(
      ({ flushKey }) => useAutosave({ dirty: true, save, flushKey }),
      { initialProps: { flushKey: 'week-1__loc-A' } }
    )

    // Debounce timer is set but fake timers haven't been advanced, so the
    // only path that can fire save() in this test is the flushKey-cleanup
    // flush. This pre-assert pins down the test's hypothesis.
    expect(save).not.toHaveBeenCalled()

    // Simulate a week/location switch.
    rerender({ flushKey: 'week-2__loc-A' })

    // flush is async (awaits save internally); let one microtask settle so
    // the synchronous prefix of save() — which is what mock.calls records —
    // has definitely run before we assert.
    await Promise.resolve()

    expect(save).toHaveBeenCalledTimes(1)
  })

  it('a key change cancels the pending debounced save — it must not fire later against the NEW key', async () => {
    // The flush on key change already saved the outgoing context. If the old
    // debounce timer survives, it fires with saveRef pointing at the NEW
    // context's save (live repro 2026-11-18: an edit at Test Sandbox, switch to
    // CR_TMC 1.5 s later, and the timer wrote TMC's P&L/snapshot at $0).
    const saveA = vi.fn(async () => true)
    const saveB = vi.fn(async () => true)
    const { rerender } = renderHook(
      ({ flushKey, save, dirty }) => useAutosave({ dirty, save, flushKey, debounceMs: 2000 }),
      { initialProps: { flushKey: 'loc-A', save: saveA, dirty: true } }
    )
    await vi.advanceTimersByTimeAsync(1500)
    rerender({ flushKey: 'loc-B', save: saveB, dirty: true })
    await vi.advanceTimersByTimeAsync(5000)
    expect(saveA).toHaveBeenCalledTimes(1)   // the flush
    expect(saveB).not.toHaveBeenCalled()
  })

  it('right after a key change, the backstop does not save the OLD data under the NEW key', async () => {
    // The commit right after a location switch still holds the old location's
    // items and dirty flag; snapshotting them under the new key planted a draft
    // that was later "restored" into the new location (live, 2026-11-18).
    const oldItems = [{ id: 'zebra_cola_12oz', qty: 1 }]
    const { rerender } = renderHook(
      ({ flushKey }) => useAutosave({ dirty: true, save: async () => false, flushKey, snapshot: () => oldItems }),
      { initialProps: { flushKey: 'fooda|Test_Sandbox|W3' } }
    )
    expect(JSON.parse(localStorage.getItem('aurelia:autosave:fooda|Test_Sandbox|W3')).key).toBe('fooda|Test_Sandbox|W3')
    rerender({ flushKey: 'fooda|CR_TMC|W3' })
    await Promise.resolve()
    expect(localStorage.getItem('aurelia:autosave:fooda|CR_TMC|W3')).toBeNull()
  })

  it('a draft is restored only into the key it was written for; keyless (older) drafts are ignored', async () => {
    const hydrate = vi.fn()
    localStorage.setItem('aurelia:autosave:fooda|CR_TMC|W3', JSON.stringify({ data: [{ id: 'x', qty: 1 }], ts: 1 }))
    localStorage.setItem('aurelia:autosave:fooda|Cafe_AZ|W3', JSON.stringify({ key: 'fooda|Test_Sandbox|W3', data: [{ id: 'y' }], ts: 1 }))
    localStorage.setItem('aurelia:autosave:fooda|HDK|W3', JSON.stringify({ key: 'fooda|HDK|W3', data: [{ id: 'z' }], ts: 7 }))
    const { rerender } = renderHook(
      ({ flushKey }) => useAutosave({ dirty: false, save: async () => true, flushKey, hydrate }),
      { initialProps: { flushKey: 'fooda|CR_TMC|W3' } }
    )
    rerender({ flushKey: 'fooda|Cafe_AZ|W3' })
    expect(hydrate).not.toHaveBeenCalled()
    rerender({ flushKey: 'fooda|HDK|W3' })
    expect(hydrate).toHaveBeenCalledTimes(1)
    expect(hydrate).toHaveBeenCalledWith([{ id: 'z' }], 7)
  })

  it('a page-exit flush right after a key change does not run the NEW context\'s save with the old edits', async () => {
    const saveA = vi.fn(async () => true)
    const saveB = vi.fn(async () => true)
    const { rerender } = renderHook(
      ({ flushKey, save }) => useAutosave({ dirty: true, save, flushKey }),
      { initialProps: { flushKey: 'loc-A', save: saveA } }
    )
    rerender({ flushKey: 'loc-B', save: saveB })
    await Promise.resolve()
    expect(saveA).toHaveBeenCalledTimes(1)   // the key-change flush
    window.dispatchEvent(new Event('pagehide'))
    await Promise.resolve()
    expect(saveB).not.toHaveBeenCalled()
  })

  it('flush awaits the save call instead of fire-and-forget', async () => {
    // Companion to the flushKey test above. The cleanup path can't tell the
    // difference between `await saveRef.current()` and a bare
    // `saveRef.current()` — both schedule save() synchronously and the
    // cleanup discards flush's return value either way. flushNow exposes the
    // SAME flush function externally, so awaiting flushNow makes the await
    // semantic observable: if flush awaits save, flushNow's promise stays
    // pending until save resolves; if flush fires-and-forgets, flushNow's
    // promise resolves on the next microtask.
    let resolveSave
    const save = vi.fn(() => new Promise(res => { resolveSave = res }))

    const { result } = renderHook(() => useAutosave({ dirty: true, save }))

    const flushPromise = result.current.flushNow()
    expect(save).toHaveBeenCalledTimes(1)

    let flushResolved = false
    flushPromise.then(() => { flushResolved = true })

    // Drain several microtasks; the awaited flush should still be pending
    // because the save deferred has not been resolved.
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(flushResolved).toBe(false)

    // Resolve the save; flush's await unblocks, and flushPromise resolves.
    resolveSave(true)
    await flushPromise
    expect(flushResolved).toBe(true)
  })

  it('persists a snapshot to localStorage and restores it on a fresh mount (route-change recovery)', async () => {
    // Reproduces the route-change data-loss bug: user types counts, navigates
    // away (Inventory unmounts), comes back. The async flush on unmount can
    // fail silently (rules denial, network) or be raced by the remount's
    // load(). Without the localStorage backstop, counts vanish.
    const flushKey = 'test-snapshot-' + Math.random().toString(36).slice(2)
    const snapshotData = [{ id: 'apple', qty: 5 }, { id: 'banana', qty: 3 }]
    // save returns false so the localStorage entry isn't cleared on unmount —
    // simulates the silent-failure case the backstop must survive.
    const save = vi.fn(async () => false)

    // Step 1: mount with dirty=true + snapshot. The no-deps snapshot effect
    // fires on the first commit and persists the draft to localStorage.
    const { unmount } = renderHook(() => useAutosave({
      dirty: true,
      save,
      flushKey,
      snapshot: () => snapshotData,
    }))

    const stored = localStorage.getItem('aurelia:autosave:' + flushKey)
    expect(stored).toBeTruthy()
    expect(JSON.parse(stored).data).toEqual(snapshotData)

    // Step 2: unmount (the route change). flushKey cleanup runs flush() which
    // calls save() (returns false), so localStorage retains the draft.
    unmount()
    // Let the flush's awaited save settle so any post-save side effects run.
    await Promise.resolve()
    await Promise.resolve()

    // Step 3: fresh re-mount with a hydrate callback. The hook reads
    // localStorage on flushKey-effect run and calls hydrate with the draft.
    const hydrate = vi.fn()
    renderHook(() => useAutosave({
      dirty: false,
      save: vi.fn(),
      flushKey,
      hydrate,
    }))

    expect(hydrate).toHaveBeenCalledTimes(1)
    expect(hydrate.mock.calls[0][0]).toEqual(snapshotData)

    localStorage.removeItem('aurelia:autosave:' + flushKey)
  })
})
