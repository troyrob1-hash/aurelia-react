// @vitest-environment jsdom

// Regression tests for the mergeCountsWithDeletions helper extracted from
// saveCounts. This is the pure logic at the core of the W1 $61K-reappear bug
// (2026-06-18): clearing an item silently left the old Firestore value in
// place because the merge had no signal to "delete this id" — only "overwrite
// or preserve."

import { describe, it, expect } from 'vitest'
import { mergeCountsWithDeletions, hasCount } from '../src/hooks/useInventory'

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

// hasCount — the predicate that decides whether an item carries a count
// worth persisting. Regression for the W1 $3.83 eaches-divergence bug
// (2026-06-18): the previous filter was `i.qty != null` alone, which silently
// dropped items where the user only used the eaches input, even though those
// items contributed to closingValue.
describe('hasCount', () => {
  it('true when qty is a positive number', () => {
    expect(hasCount({ qty: 5, eaches: 0 })).toBe(true)
  })

  it('true when qty is zero (legitimate "I counted zero" — saved as 0)', () => {
    // The − button decrements to 0 and clamps; qty: 0 is a real count and
    // must survive. saveCounts treats it as a normal entry (not a deletion).
    expect(hasCount({ qty: 0, eaches: 0 })).toBe(true)
  })

  it('true when qty is null but eaches > 0 — the regression for the $3.83 bug', () => {
    // Van entered counts only in the eaches input. Items had qty=null and
    // eaches=1.08. Pre-fix, the newCounts filter `i.qty != null` dropped
    // these AND Fix A's deletion path actively removed them from the doc.
    // Result: items contributed to closingValue but never landed.
    expect(hasCount({ qty: null, eaches: 1.08 })).toBe(true)
  })

  it('true when qty is 0 AND eaches > 0 (qty zeroed via − button, eaches typed)', () => {
    // The combined case from Van's repro — qty=0 from the − button, eaches=1.08
    // from the eaches input. Item must persist with both fields.
    expect(hasCount({ qty: 0, eaches: 1.08 })).toBe(true)
  })

  it('false when both qty is null and eaches is 0 — truly uncounted', () => {
    expect(hasCount({ qty: null, eaches: 0 })).toBe(false)
  })

  it('false when both qty is null and eaches is null', () => {
    expect(hasCount({ qty: null, eaches: null })).toBe(false)
  })

  it('false for non-numeric eaches (defensive)', () => {
    expect(hasCount({ qty: null, eaches: 'oops' })).toBe(false)
    expect(hasCount({ qty: null, eaches: undefined })).toBe(false)
  })

  it('false on null / missing item', () => {
    expect(hasCount(null)).toBe(false)
    expect(hasCount(undefined)).toBe(false)
  })
})

// The combined Van scenario: items state after his actual session, passed
// through hasCount + mergeCountsWithDeletions, should produce a counts doc
// that includes the eaches-only items (not a doc missing them).
describe('Van $3.83 repro — eaches-only items land on the counts doc', () => {
  it('an item with qty=null, eaches=1.08, touched lands in newCounts and is NOT deleted', () => {
    // Simulate what saveCounts builds for an items array like Van's: 99 items
    // at qty=0 (zeroed via − button) plus one item where the user only typed
    // an eaches value (qty stays null).
    const items = [
      { id: 'A', qty: 0,    eaches: 0    },  // - button to zero
      { id: 'B', qty: 0,    eaches: 0    },  // - button to zero
      { id: 'C', qty: null, eaches: 1.08 },  // only eaches set
    ]
    const touched = new Set(['A', 'B', 'C'])

    // newCounts: hasCount filter — should include all three
    const newCounts = items.filter(hasCount).map(i => ({
      id: i.id, qty: i.qty == null ? null : i.qty, eaches: i.eaches || 0,
    }))
    expect(newCounts.map(c => c.id)).toEqual(['A', 'B', 'C'])
    expect(newCounts.find(c => c.id === 'C').eaches).toBe(1.08)

    // deletions: only items with NEITHER qty NOR eaches that are touched
    const deletions = items
      .filter(i => !hasCount(i) && touched.has(String(i.id)))
      .map(i => String(i.id))
    expect(deletions).toEqual([])  // C is NOT deleted — eaches saves it

    // merge — C survives with eaches=1.08
    const result = mergeCountsWithDeletions(
      [{ id: 'C', qty: 5000, eaches: 0 }],  // existing high prior value for C
      newCounts,
      deletions
    )
    expect(result.find(i => i.id === 'C').eaches).toBe(1.08)
    expect(result.find(i => i.id === 'C').qty).toBeNull()
  })
})
