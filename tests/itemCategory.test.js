/**
 * Regression tests for the "changing an item's category doesn't stick" bug
 * (reported 2026-10-06).
 *
 * The write was never the problem — saveEditField awaited a setDoc({merge:true})
 * and only then flipped the "All changes saved" flag, so the value did reach
 * Firestore. Two read-back defects made it look otherwise:
 *
 *   1. saveEditField never mirrored the write into local state, and an item's
 *      category GROUP is derived from local state by assignCategory. So the item
 *      kept rendering under its old category until something happened to call
 *      load() — which is why it "worked on retry" at random.
 *   2. assignCategory treated 'General'/'Other' as "uncategorized" and re-ran
 *      keyword inference over them. Explicitly choosing General therefore snapped
 *      the item back to the inferred guess the user was correcting.
 *
 * The fix is the `categoryExplicit` sentinel plus a patchItemFields call. These
 * tests cover both, and pin the legacy behavior that must NOT change.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import {
  assignCategory,
  applyItemPatches,
  getDefaultCategories,
  CATEGORY_ALIASES,
} from '../src/hooks/useInventory'

const CATS = getDefaultCategories()

// The exact payload saveEditField writes (and patches) for a category pick.
const pick = (label) => ({ category: label, categoryExplicit: true })

describe('category change persists AND displays immediately (no reload)', () => {
  it('moves the item to the new group as soon as the patch is applied', () => {
    // An item the keyword inference filed under Dairy...
    const items = [{ id: 'i1', name: 'Whole Milk Gallon', glCode: null, category: 'Dairy' }]
    expect(assignCategory(items[0], CATS)).toBe('dairy')

    // ...user picks "Pantry / Snacks" in the edit panel. saveEditField writes
    // this payload and patches the SAME payload into local items.
    const patched = applyItemPatches(items, { i1: pick('Pantry / Snacks') })

    // No reload, no load() call — the derived group must already be correct.
    expect(assignCategory(patched[0], CATS)).toBe('pantry')
  })

  it('resolves every default category label to its own key', () => {
    // A label that round-trips to a different key than the one the user clicked
    // is the same bug wearing a different hat.
    for (const cat of CATS) {
      const item = { id: 'x', name: 'Some Item', ...pick(cat.label) }
      expect(assignCategory(item, CATS), `label "${cat.label}"`).toBe(cat.key)
    }
  })

  it('patches only the targeted item and only the targeted fields', () => {
    const items = [
      { id: 'i1', name: 'A', category: 'Dairy', qty: 5, eaches: 2 },
      { id: 'i2', name: 'B', category: 'Frozen', qty: 9 },
    ]
    const out = applyItemPatches(items, { i1: pick('Produce') })

    // counts and siblings untouched — a category edit must never disturb counts
    expect(out[0]).toMatchObject({ name: 'A', qty: 5, eaches: 2, category: 'Produce' })
    expect(out[1]).toBe(items[1])          // identity preserved for untouched ids
  })

  it('is a no-op for an empty patch set', () => {
    const items = [{ id: 'i1', category: 'Dairy' }]
    expect(applyItemPatches(items, {})).toBe(items)
    expect(applyItemPatches(items, null)).toBe(items)
  })
})

describe('explicitly choosing General sticks', () => {
  it('does NOT fall back to keyword inference', () => {
    // 'Whole Milk' matches the Dairy keyword list. Pre-fix, an explicit General
    // was read as "uncategorized" and inference dragged it straight back.
    const item = { id: 'i1', name: 'Whole Milk Gallon', glCode: null, ...pick('General') }
    expect(assignCategory(item, CATS)).toBe('general')
    expect(assignCategory(item, CATS)).not.toBe('dairy')
  })

  it('holds for Other as well', () => {
    const item = { id: 'i1', name: 'Frozen Pizza', ...pick('Other') }
    // No 'Other' in the default list, so it resolves to the literal label key
    // rather than being re-inferred to 'frozen'.
    expect(assignCategory(item, CATS)).not.toBe('frozen')
    expect(assignCategory(item, CATS)).toBe('other')
  })

  it('survives a patch round-trip from an inferred category', () => {
    const items = [{ id: 'i1', name: 'Cold Brew Concentrate', category: 'Bar / Barista' }]
    expect(assignCategory(items[0], CATS)).toBe('bar_items')
    const patched = applyItemPatches(items, { i1: pick('General') })
    expect(assignCategory(patched[0], CATS)).toBe('general')
  })
})

describe('legacy (non-explicit) behavior is unchanged', () => {
  it('still infers over an unattributed General — catalog/upload filler', () => {
    // Uploads legitimately carry 'General' as filler meaning "not categorized".
    // Without categoryExplicit that must keep inferring, or every uploaded item
    // would pile into General.
    const item = { id: 'i1', name: 'Whole Milk Gallon', category: 'General' }
    expect(assignCategory(item, CATS)).toBe('dairy')
  })

  it('still infers over an unattributed Other', () => {
    const item = { id: 'i1', name: 'Frozen Pizza', category: 'Other' }
    expect(assignCategory(item, CATS)).toBe('frozen')
  })

  it('still applies the built-in aliases to non-explicit labels', () => {
    expect(assignCategory({ id: 'i1', name: 'x', category: 'Snacks' }, CATS)).toBe('pantry')
    expect(assignCategory({ id: 'i1', name: 'x', category: 'Barista' }, CATS)).toBe('bar_items')
    expect(assignCategory({ id: 'i1', name: 'x', category: 'Cafeteria' }, CATS)).toBe('pantry')
  })

  it('falls back to keyword inference when there is no category at all', () => {
    expect(assignCategory({ id: 'i1', name: 'Red Bull 12oz' }, CATS)).toBe('beverages')
    expect(assignCategory({ id: 'i1', name: 'Nothing Matches Here' }, CATS)).toBe('general')
  })
})

describe('an explicit pick beats a colliding built-in alias', () => {
  // A per-location category whose label collides with CATEGORY_ALIASES (the
  // documented collidesWithKeyMap hazard, warned-but-allowed in the editor)
  // used to be rerouted to the built-in key, so picking it appeared not to save.
  const CUSTOM = [...CATS, { key: 'house_snacks', label: 'Snacks', color: '#000', bg: '#fff', keywords: [] }]

  it('honors the location category over the alias when explicit', () => {
    const item = { id: 'i1', name: 'Pretzel Bites', ...pick('Snacks') }
    expect(assignCategory(item, CUSTOM)).toBe('house_snacks')
  })

  it('still prefers the alias for a non-explicit value (no silent regroup)', () => {
    const item = { id: 'i1', name: 'Pretzel Bites', category: 'Snacks' }
    expect(assignCategory(item, CUSTOM)).toBe('pantry')
  })

  it('keeps one shared alias table — the panel and the table cannot drift', () => {
    // The <select> read a private 7-entry copy that omitted these two, so a
    // saved Proteins/Produce pick could resolve differently in the dropdown
    // than in the grouped list.
    expect(CATEGORY_ALIASES).toMatchObject({ proteins: 'proteins', produce: 'produce' })
    expect(Object.keys(CATEGORY_ALIASES)).toHaveLength(9)
  })
})

describe('assignCategory is defensive about inputs', () => {
  it('tolerates a missing item or category list', () => {
    expect(assignCategory({ id: 'i1', name: 'x' }, [])).toBe('general')
    expect(assignCategory({ id: 'i1', name: 'x', ...pick('Dairy') }, [])).toBe('dairy')
  })
})

describe('saveEditField wiring', () => {
  // The tests above prove the RESOLUTION is right once a patch is applied. They
  // cannot prove saveEditField actually applies one — that lives in a component
  // callback. These assert the wiring at the source level (same approach as
  // tests/authClaims.test.js), because "write succeeds, local state never
  // updated" is exactly the bug being fixed and it is invisible to a unit test.
  const SRC = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../src/routes/Inventory.jsx'), 'utf8')
  const body = SRC.slice(
    SRC.indexOf('const saveEditField'),
    SRC.indexOf('useEffect(() => { setEditLastSavedAt(null) }')
  )

  it('is found, and is scoped as expected', () => {
    expect(body.length).toBeGreaterThan(200)
  })

  it('mirrors the write into local items via patchItemFields', () => {
    expect(body).toMatch(/patchItemFields\(\s*\{\s*\[itemId\]:\s*payload\s*\}\s*\)/)
  })

  it('writes and patches the SAME payload object (cannot drift)', () => {
    // One `payload` const feeding both setDoc and patchItemFields is what
    // guarantees the local mirror matches what landed on the server.
    expect(body).toMatch(/const payload = \{ \[field\]: val, \.\.\.extra \}/)
    expect(body).toMatch(/'items', itemId\), payload, \{ merge: true \}\)/)
  })

  it('patches only AFTER the await, never optimistically', () => {
    const awaitAt = body.indexOf('await setDoc')
    const patchAt = body.indexOf('patchItemFields(')
    expect(awaitAt).toBeGreaterThan(-1)
    expect(patchAt).toBeGreaterThan(awaitAt)
  })

  it('refuses to write when no single location is selected', () => {
    expect(body).toMatch(/if \(!location\) throw new Error\(/)
  })

  it('declares patchItemFields as a dependency', () => {
    expect(body).toMatch(/\[location, orgId, patchItemFields\]/)
  })

  it('the category picker sends the categoryExplicit sentinel', () => {
    expect(SRC).toMatch(/saveEditField\(item\.id, 'category', catLabel, \{ categoryExplicit: true \}\)/)
  })

  it('the category <select> is controlled off _cat, not defaultValue', () => {
    const sel = SRC.slice(SRC.indexOf("{ label: 'Category'"), SRC.indexOf("{ label: 'Vendor'"))
    expect(SRC).toMatch(/value=\{item\._cat \|\| 'general'\}/)
    // The private 7-entry alias map that used to live here must be gone.
    expect(sel).not.toMatch(/keyMap/)
  })

  it('the panel renders the live item, not the click-time snapshot', () => {
    expect(SRC).toMatch(/const item = items\.find\(i => i\.id === whyItem\.id\) \|\| whyItem/)
  })
})
