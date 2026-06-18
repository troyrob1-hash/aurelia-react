// @vitest-environment jsdom

// Regression tests for the mergeCountsWithDeletions helper extracted from
// saveCounts. This is the pure logic at the core of the W1 $61K-reappear bug
// (2026-06-18): clearing an item silently left the old Firestore value in
// place because the merge had no signal to "delete this id" — only "overwrite
// or preserve."

import { describe, it, expect } from 'vitest'
import { mergeCountsWithDeletions } from '../src/hooks/useInventory'

describe('mergeCountsWithDeletions', () => {
  it('removes cleared items via the deletion sentinel — regression for the W1 $61K bug', () => {
    // Scenario from the live repro:
    //   - Firestore counts doc had item X at qty=5000 (≈ $61K closing value)
    //   - User cleared X (typed empty into the field) → items state has X.qty=null
    //   - User entered $10 on item Z → items state has Z.qty=10
    //   - User saved
    //
    // The save's newCounts list filters out null-qty items, so X is NOT in
    // newCounts. Without the deletions sentinel the merge falls through to
    // existing[X]=5000 and the clear is silently lost. With the sentinel
    // present in `deletions`, X must drop out of the result.
    const existing = [
      { id: 'X', qty: 5000, eaches: 0 },
      { id: 'Y', qty: 100,  eaches: 0 },
    ]
    const newCounts = [
      { id: 'Z', qty: 10, eaches: 0 },
    ]
    const deletions = ['X']

    const result = mergeCountsWithDeletions(existing, newCounts, deletions)

    // X was cleared — must NOT survive the merge.
    expect(result.find(i => i.id === 'X')).toBeUndefined()
    // Y was untouched — must be preserved (Tracy protection).
    expect(result.find(i => i.id === 'Y')?.qty).toBe(100)
    // Z is newly counted — must appear.
    expect(result.find(i => i.id === 'Z')?.qty).toBe(10)
  })

  it('preserves untouched items when deletions is empty (Tracy protection)', () => {
    // The merge's original purpose: a partial save (user only counted a
    // handful of items) must NEVER wipe items the user didn't touch. The
    // deletion path must not break this guarantee — that's why deletions
    // is a separate explicit list, not derived from absence in newCounts.
    const existing = [
      { id: 'X', qty: 5000, eaches: 0 },
      { id: 'Y', qty: 100,  eaches: 0 },
    ]
    const newCounts = [
      { id: 'Z', qty: 10, eaches: 0 },
    ]

    const result = mergeCountsWithDeletions(existing, newCounts, [])

    expect(result.find(i => i.id === 'X')?.qty).toBe(5000)
    expect(result.find(i => i.id === 'Y')?.qty).toBe(100)
    expect(result.find(i => i.id === 'Z')?.qty).toBe(10)
  })

  it('newCounts entry overrides existing entry with the same id', () => {
    // Normal "user updated this item" case — newCounts must win.
    const existing = [{ id: 'X', qty: 5000, eaches: 0 }]
    const newCounts = [{ id: 'X', qty: 4500, eaches: 0 }]

    const result = mergeCountsWithDeletions(existing, newCounts, [])

    expect(result.find(i => i.id === 'X')?.qty).toBe(4500)
  })

  it('handles null / empty inputs without crashing', () => {
    expect(mergeCountsWithDeletions(null, null, null)).toEqual([])
    expect(mergeCountsWithDeletions([], [], [])).toEqual([])
    expect(mergeCountsWithDeletions([{ id: 'X', qty: 1 }], null, null))
      .toEqual([{ id: 'X', qty: 1 }])
  })
})
