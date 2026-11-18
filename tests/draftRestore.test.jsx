// @vitest-environment jsdom

// useDraftRestore + helpers: a draft is held until the tab has loaded the
// exact key it was written for, applied once, and dropped if the user moves to
// another key first. Keys are per tab and include the week.

import { describe, it, expect, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useDraftRestore, draftKey, mergeSalesDraft, mergeLaborDraft } from '../src/hooks/useDraftRestore'

describe('draftKey', () => {
  it('tab + org + location + week; null until all are known', () => {
    expect(draftKey('sales', 'fooda', 'Test_Sandbox', '2026-P11-W3')).toBe('sales|fooda|Test_Sandbox|2026-P11-W3')
    expect(draftKey('labor', 'fooda', 'Test_Sandbox', '2026-P11-W3')).toBe('labor|fooda|Test_Sandbox|2026-P11-W3')
    expect(draftKey('sales', 'fooda', null, '2026-P11-W3')).toBeNull()
    expect(draftKey('sales', 'fooda', 'Test_Sandbox', null)).toBeNull()
    expect(draftKey('sales', undefined, 'Test_Sandbox', '2026-P11-W3')).toBeNull()
  })
  it('never equals Inventory’s key for the same location and week', () => {
    expect(draftKey('sales', 'fooda', 'Test_Sandbox', '2026-P11-W3')).not.toBe('fooda|Test_Sandbox|2026-P11-W3')
  })
})

describe('merge helpers', () => {
  it('sales: draft wins cell by cell; other cells keep the loaded value', () => {
    const loaded = { '2026-11-15': { popup: 10, catering: 20 }, '2026-11-16': { retail: 5 } }
    expect(mergeSalesDraft(loaded, { '2026-11-15': { popup: 77 } })).toEqual({
      '2026-11-15': { popup: 77, catering: 20 }, '2026-11-16': { retail: 5 },
    })
    expect(mergeSalesDraft(loaded, [{ id: 'x' }])).toEqual(loaded)   // wrong shape: ignored
    expect(mergeSalesDraft(loaded, null)).toEqual(loaded)
  })
  it('labor: draft rows replace same-GL rows, add new GLs, keep the rest', () => {
    const loaded = [{ gl: '68100', label: 'Bonus', amount: 50 }, { gl: '68200', label: 'Other', amount: 9 }]
    expect(mergeLaborDraft(loaded, [{ gl: '68100', amount: 75 }, { gl: '68300', label: 'New', amount: 1 }])).toEqual([
      { gl: '68100', label: 'Bonus', amount: 75 }, { gl: '68200', label: 'Other', amount: 9 }, { gl: '68300', label: 'New', amount: 1 },
    ])
    expect(mergeLaborDraft(loaded, { '2026-11-15': {} })).toEqual(loaded)   // wrong shape: ignored
  })
})

describe('useDraftRestore', () => {
  const setup = (initial) => {
    const apply = vi.fn()
    const r = renderHook(({ flushKey, loadedKey }) => useDraftRestore({ flushKey, loadedKey, apply }), { initialProps: initial })
    return { apply, ...r }
  }

  it('holds the draft until the tab reports that key loaded, then applies it once', () => {
    const { apply, result, rerender } = setup({ flushKey: 'k1', loadedKey: null })
    act(() => result.current({ a: 1 }))
    rerender({ flushKey: 'k1', loadedKey: null })
    expect(apply).not.toHaveBeenCalled()
    rerender({ flushKey: 'k1', loadedKey: 'k1' })
    expect(apply).toHaveBeenCalledTimes(1)
    expect(apply).toHaveBeenCalledWith({ a: 1 })
    rerender({ flushKey: 'k1', loadedKey: 'k1' })
    expect(apply).toHaveBeenCalledTimes(1)
  })

  it('a draft held for a key the user left before it loaded is dropped, not applied to the new key', () => {
    const { apply, result, rerender } = setup({ flushKey: 'week-2', loadedKey: null })
    act(() => result.current({ a: 1 }))
    rerender({ flushKey: 'week-3', loadedKey: null })
    rerender({ flushKey: 'week-3', loadedKey: 'week-3' })
    rerender({ flushKey: 'week-2', loadedKey: 'week-2' })
    expect(apply).not.toHaveBeenCalled()
  })

  it('a stale "loaded" marker for another key does not trigger the apply', () => {
    const { apply, result, rerender } = setup({ flushKey: 'k2', loadedKey: 'k1' })
    act(() => result.current({ a: 1 }))
    rerender({ flushKey: 'k2', loadedKey: 'k1' })
    expect(apply).not.toHaveBeenCalled()
  })
})
