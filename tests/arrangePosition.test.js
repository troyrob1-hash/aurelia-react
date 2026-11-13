/**
 * Arrange mode — type a position number (grouped view). Sysco order-guide
 * behavior: typing N moves the item to place N on its sheet and shifts the
 * items in between (insert-and-shift, never a swap). A typed move is a drag to
 * that slot: same arrayMove, same optimistic order, same onReorder →
 * persistReorder write. These tests pin the move math, the drag equivalence,
 * the split-item behavior (intentional), and that nothing here writes on its own.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { arrayMove, planMoveTo, parsePositionInput, reorderChanges } from '../src/lib/shelfOrder'
import { byShelf } from '../src/lib/countSheets'
import { sheetCategoryKeys } from '../src/lib/buckets'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const code = p => readFileSync(resolve(ROOT, p), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

const IDS = ['a', 'b', 'c', 'd', 'e']

describe('planMoveTo — move to sheet place n (1-based), insert-and-shift', () => {
  it('moves DOWN and shifts the items between up (not a swap)', () => {
    expect(planMoveTo(IDS, 'a', 4)).toEqual(['b', 'c', 'd', 'a', 'e'])
  })
  it('moves UP and shifts the items between down (not a swap)', () => {
    expect(planMoveTo(IDS, 'e', 2)).toEqual(['a', 'e', 'b', 'c', 'd'])
  })
  it('to the start and to the end', () => {
    expect(planMoveTo(IDS, 'c', 1)).toEqual(['c', 'a', 'b', 'd', 'e'])
    expect(planMoveTo(IDS, 'c', 5)).toEqual(['a', 'b', 'd', 'e', 'c'])
  })
  it('bigger than the sheet clamps to the end', () => {
    expect(planMoveTo(IDS, 'b', 99)).toEqual(['a', 'c', 'd', 'e', 'b'])
  })
  it('0 or negative clamps to 1', () => {
    expect(planMoveTo(IDS, 'd', 0)).toEqual(['d', 'a', 'b', 'c', 'e'])
    expect(planMoveTo(IDS, 'd', -7)).toEqual(['d', 'a', 'b', 'c', 'e'])
  })
  it('its current place is a no-op (null) — including a clamp that lands on it', () => {
    expect(planMoveTo(IDS, 'c', 3)).toBeNull()
    expect(planMoveTo(IDS, 'e', 99)).toBeNull()
    expect(planMoveTo(IDS, 'a', 0)).toBeNull()
  })
  it('non-integer n or an id not on the sheet is a no-op', () => {
    expect(planMoveTo(IDS, 'a', 2.5)).toBeNull()
    expect(planMoveTo(IDS, 'a', NaN)).toBeNull()
    expect(planMoveTo(IDS, 'a', null)).toBeNull()
    expect(planMoveTo(IDS, 'zz', 2)).toBeNull()
  })
  it('matches ids by string (doc ids can arrive as numbers)', () => {
    expect(planMoveTo([183, 412, 11], '11', 1)).toEqual([11, 183, 412])
  })
  it('never mutates the input order', () => {
    const ids = [...IDS]
    planMoveTo(ids, 'a', 5)
    expect(ids).toEqual(IDS)
  })
})

describe('parsePositionInput — whole numbers only; anything else reverts', () => {
  it('accepts whole numbers (sign allowed — planMoveTo clamps)', () => {
    expect(parsePositionInput('3')).toBe(3)
    expect(parsePositionInput(' 12 ')).toBe(12)
    expect(parsePositionInput('-2')).toBe(-2)
    expect(parsePositionInput('0')).toBe(0)
  })
  it('rejects blank, decimals and non-numeric', () => {
    for (const bad of ['', '   ', '2.5', '3.', '.5', 'abc', '3a', '1e2', null, undefined]) {
      expect(parsePositionInput(bad)).toBeNull()
    }
  })
})

describe('typing k == dragging to slot k', () => {
  it('for every item and every slot, the typed order is exactly the drag order', () => {
    const ids = ['p', 'q', 'r', 's', 't', 'u']
    for (let from = 0; from < ids.length; from++) {
      for (let slot = 0; slot < ids.length; slot++) {
        const dragged = arrayMove(ids, from, slot)                // what a drop to slot hands onReorder
        const typed = planMoveTo(ids, ids[from], slot + 1)       // what typing slot+1 hands onReorder
        if (from === slot) expect(typed).toBeNull()             // drag to own slot: order unchanged
        else expect(typed).toEqual(dragged)
      }
    }
  })
  it('drag and typing share ONE move function — the hook has no arrayMove of its own', () => {
    const hook = code('src/hooks/useDragReorder.js')
    expect(hook).toMatch(/import \{ arrayMove, planMoveTo \} from '@\/lib\/shelfOrder'/)
    expect(hook).not.toMatch(/function arrayMove/)
    expect(hook).toMatch(/arrayMove\(o\[d\.groupKey\] \|\| ids, from, to\)/)   // the drag path
  })
  it('moveTo does a drop\'s two steps: optimistic order, then the SAME onReorder', () => {
    const hook = code('src/hooks/useDragReorder.js')
    const body = hook.slice(hook.indexOf('const moveTo = useCallback('), hook.indexOf('const orderedGroups'))
    expect(body).toMatch(/planMoveTo\(ids, itemId, n\)/)
    expect(body).toMatch(/if \(!next\) return false/)
    expect(body.indexOf('setOrder(')).toBeLessThan(body.indexOf('onReorder?.(groupKey, next)'))
    expect(code('src/routes/Inventory.jsx')).toMatch(/<ArrangeList groups=\{arrangeGroups\} viewMode=\{viewMode\} onReorder=\{persistReorder\}/)
  })
})

describe('the write — persistReorder, unchanged path', () => {
  it('a typed move renumbers the sheet 1..N, writing only changed positions', () => {
    const items = [
      { id: 'a', catShelfOrder: 1 }, { id: 'b', catShelfOrder: 2 }, { id: 'c', catShelfOrder: 3 },
      { id: 'd', catShelfOrder: 4 }, { id: 'e', catShelfOrder: 5 },
    ]
    const next = planMoveTo(IDS, 'b', 4)            // a d? → a c d b e
    expect(reorderChanges(items, 'catShelfOrder', next)).toEqual([
      { id: 'c', pos: 2 }, { id: 'd', pos: 3 }, { id: 'b', pos: 4 },
    ])
  })
  it('file-wide upload positions (#37, #52, #90) become the sheet\'s 1..N on the first move', () => {
    const items = [{ id: 'x', catShelfOrder: 37 }, { id: 'y', catShelfOrder: 52 }, { id: 'z', catShelfOrder: 90 }]
    const shown = [...items].sort(byShelf('catShelfOrder')).map(i => i.id)
    const next = planMoveTo(shown, 'z', 1)
    expect(reorderChanges(items, 'catShelfOrder', next)).toEqual([
      { id: 'z', pos: 1 }, { id: 'x', pos: 2 }, { id: 'y', pos: 3 },
    ])
  })
  it('unarranged items are numbered in their DISPLAYED order (positioned first, then A-Z)', () => {
    const items = [
      { id: 'm', name: 'Mango', catShelfOrder: null }, { id: 'k', name: 'Kiwi', catShelfOrder: 1 },
      { id: 'b', name: 'Banana', catShelfOrder: null }, { id: 'z', name: 'Zucchini', catShelfOrder: 2 },
    ]
    const shown = [...items].sort(byShelf('catShelfOrder')).map(i => i.id)
    expect(shown).toEqual(['k', 'z', 'b', 'm'])
    const next = planMoveTo(shown, 'm', 1)            // Mango to the top
    expect(next).toEqual(['m', 'k', 'z', 'b'])
    expect(reorderChanges(items, 'catShelfOrder', next)).toEqual([
      { id: 'm', pos: 1 }, { id: 'k', pos: 2 }, { id: 'z', pos: 3 }, { id: 'b', pos: 4 },
    ])
  })
  it('persistReorder computes its writes with reorderChanges — no second diff', () => {
    const src = code('src/routes/Inventory.jsx')
    const body = src.slice(src.indexOf('const persistReorder = useCallback('), src.indexOf('const draftFlushKey'))
    expect(body).toMatch(/const changes = reorderChanges\(items, field, orderedIds\)/)
    expect(body).not.toMatch(/orderedIds\.forEach/)
  })
})

describe('split items — INTENTIONAL: renumbered like drag, which moves them on their other sheets', () => {
  // One catShelfOrder serves every sheet a split item is on. Per-sheet
  // positions are a separate schema change; until then a typed move matches
  // drag exactly. If this test fails because split items stopped being
  // written, that's a behavior change to decide on — not a free fix.
  const S = { id: 's', name: 'Watermelon', _cat: 'bev', countCategories: ['bev', 'closet'], catShelfOrder: 2 }
  const items = [
    { id: 'a', name: 'Apple', _cat: 'bev', catShelfOrder: 1 }, S, { id: 'c', name: 'Cola', _cat: 'bev', catShelfOrder: 3 },
    { id: 'q', name: 'Quince', _cat: 'closet', catShelfOrder: 1 }, { id: 'r', name: 'Rye', _cat: 'closet', catShelfOrder: 3 },
  ]
  const sheet = key => items.filter(i => sheetCategoryKeys(i).includes(key)).sort(byShelf('catShelfOrder')).map(i => i.id)

  it('moving another item past it on sheet A writes the split item a new position', () => {
    expect(sheet('bev')).toEqual(['a', 's', 'c'])
    const next = planMoveTo(sheet('bev'), 'c', 1)
    const changes = reorderChanges(items, 'catShelfOrder', next)
    expect(changes).toContainEqual({ id: 's', pos: 3 })
  })
  it('…which moves it on its OTHER sheet too', () => {
    expect(sheet('closet')).toEqual(['q', 's', 'r'])
    const changes = reorderChanges(items, 'catShelfOrder', planMoveTo(sheet('bev'), 'c', 1))
    const after = items.map(i => ({ ...i, ...(changes.find(c => c.id === i.id) ? { catShelfOrder: changes.find(c => c.id === i.id).pos } : {}) }))
    const closetAfter = after.filter(i => sheetCategoryKeys(i).includes('closet')).sort(byShelf('catShelfOrder')).map(i => i.id)
    expect(closetAfter).toEqual(['q', 'r', 's'])
  })
  it('the arrange banner tells users, and marks split rows', () => {
    const list = code('src/components/inventory/ArrangeList.jsx')
    expect(list).toMatch(/share one position — moving one here moves it on its other sheets too/)
    expect(list).toMatch(/isSplitItem\(item\)/)
  })
})

describe('wiring', () => {
  it('nothing in the typed path writes on its own — no Firestore in the hook or the list', () => {
    for (const f of ['src/hooks/useDragReorder.js', 'src/components/inventory/ArrangeList.jsx']) {
      const src = code(f)
      expect(src).not.toMatch(/firebase|firestore|writeBatch|setDoc|updateDoc|\bdb\b/)
    }
    expect(code('src/lib/shelfOrder.js')).not.toMatch(/from 'firebase|writeBatch\(|setDoc\(/)
  })
  it('the editable box is grouped view only — flat keeps the read-only number', () => {
    const list = code('src/components/inventory/ArrangeList.jsx')
    expect(list).toMatch(/\{g\.isFlat \? \(\s*<span[^>]*>\s*\{pos != null \? `#\$\{pos\}` : '—'\}/)
    expect(list).toMatch(/<PositionBox\s+place=\{idx \+ 1\}/)
    expect(list).toMatch(/onCommit=\{n => moveTo\(g\.key, item\.id, n\)\}/)
  })
  it('the box commits through parsePositionInput (invalid → revert) on Enter/blur; Escape reverts', () => {
    const list = code('src/components/inventory/ArrangeList.jsx')
    const box = list.slice(list.indexOf('function PositionBox('))
    expect(box).toMatch(/const n = parsePositionInput\(draft\)/)
    expect(box).toMatch(/if \(n == null \|\| n === place\) \{ setDraft\(String\(place\)\); return \}/)
    expect(box).toMatch(/inputMode="numeric"/)
    expect(box).toMatch(/e\.key === 'Escape'/)
  })
  it('Arrange builds its groups from the UNFILTERED items (search / count modes never apply)', () => {
    const src = code('src/routes/Inventory.jsx')
    expect(src).toMatch(/const arrangeGroups = useMemo\(\s*\(\) => shelfGroups\(items, categories, viewMode, viewMode === 'flat' \? 'all' : activeCat\)/)
    expect(src).toMatch(/const displayGroups = useMemo\(\s*\(\) => shelfGroups\(displayItems, categories, viewMode, activeCat\)/)
    expect(code('src/components/inventory/ArrangeList.jsx')).toMatch(/don't apply while arranging/)
  })
})
