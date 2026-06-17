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
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

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
})
