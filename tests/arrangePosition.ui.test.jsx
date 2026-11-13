// @vitest-environment jsdom

// Arrange position box, driven through the REAL ArrangeList + useDragReorder:
// type a place, check what the screen shows and what reaches onReorder (which
// Inventory wires to persistReorder — the drag write path).
//
// The non-obvious failure this pins: useDragReorder keeps its own per-group
// order and only re-seeds it when group MEMBERSHIP changes, never on an order
// change. A typed move that only called onReorder would persist correctly but
// leave the list showing the OLD order. moveTo must update that local order
// first, exactly like a drop does.

import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import ArrangeList from '../src/components/inventory/ArrangeList'

afterEach(cleanup)

const GROUPS = [{
  key: 'bev', label: 'Beverages', color: '#000', bg: '#fff',
  items: ['Apple', 'Banana', 'Cherry', 'Date', 'Elder'].map((name, i) => ({ id: name[0].toLowerCase(), name, _cat: 'bev', catShelfOrder: (i + 1) * 10 })),
}]

const names = () => screen.getAllByRole('textbox').map(b => b.getAttribute('aria-label').replace(/^Position of (.*) on .*$/, '$1'))
const places = () => screen.getAllByRole('textbox').map(b => b.value)
const box = name => screen.getByLabelText(`Position of ${name} on Beverages`)
// What a user does: click into the box (focus), type, press a key. Enter and
// Escape act by blurring, which only fires on a focused element — as in a browser.
function type(name, value, key = 'Enter') {
  const el = box(name)
  el.focus()
  fireEvent.change(el, { target: { value } })
  if (key) fireEvent.keyDown(el, { key })
}

function setup(groups = GROUPS, viewMode = 'grouped') {
  const onReorder = vi.fn()
  const utils = render(<ArrangeList groups={groups} viewMode={viewMode} onReorder={onReorder} />)
  return { onReorder, ...utils }
}

describe('typing a position in grouped Arrange', () => {
  it('shows each row\'s sheet place 1..N, not the stored catShelfOrder (10, 20…)', () => {
    setup()
    expect(places()).toEqual(['1', '2', '3', '4', '5'])
  })

  it('Enter moves the item, shifts the rest, re-renders in the new order, and calls onReorder once', () => {
    const { onReorder } = setup()
    type('Apple', '4')
    expect(onReorder).toHaveBeenCalledTimes(1)
    expect(onReorder).toHaveBeenCalledWith('bev', ['b', 'c', 'd', 'a', 'e'])
    // The SCREEN follows immediately (the stale-list failure mode).
    expect(names()).toEqual(['Banana', 'Cherry', 'Date', 'Apple', 'Elder'])
    expect(places()).toEqual(['1', '2', '3', '4', '5'])
  })

  it('stays in the new order when the parent re-renders the same membership in the OLD order', () => {
    const { rerender, onReorder } = setup()
    type('Elder', '1')
    rerender(<ArrangeList groups={GROUPS} viewMode="grouped" onReorder={onReorder} />)
    expect(names()).toEqual(['Elder', 'Apple', 'Banana', 'Cherry', 'Date'])
  })

  it('blur commits too', () => {
    const { onReorder } = setup()
    type('Cherry', '1', null)
    box('Cherry').blur()
    expect(onReorder).toHaveBeenCalledWith('bev', ['c', 'a', 'b', 'd', 'e'])
  })

  it('over-size goes to the end; 0 goes to the top', () => {
    const { onReorder } = setup()
    type('Banana', '99')
    expect(onReorder).toHaveBeenLastCalledWith('bev', ['a', 'c', 'd', 'e', 'b'])
    type('Date', '0')
    expect(onReorder).toHaveBeenLastCalledWith('bev', ['d', 'a', 'c', 'e', 'b'])
  })

  it('its current place, blank, a decimal, or text: nothing written, box reverts', () => {
    const { onReorder } = setup()
    for (const v of ['2', '', '2.5', 'abc']) {
      type('Banana', v)
      expect(box('Banana').value).toBe('2')
    }
    expect(onReorder).not.toHaveBeenCalled()
    expect(names()).toEqual(['Apple', 'Banana', 'Cherry', 'Date', 'Elder'])
  })

  it('Escape reverts and writes nothing (even though it blurs)', () => {
    const { onReorder } = setup()
    type('Apple', '5', 'Escape')
    expect(box('Apple').value).toBe('1')
    box('Apple').focus(); box('Apple').blur()
    expect(onReorder).not.toHaveBeenCalled()
  })

  it('uses the numeric keypad on mobile', () => {
    setup()
    expect(box('Apple').getAttribute('inputmode')).toBe('numeric')
  })
})

describe('flat view', () => {
  it('has NO editable box — just the read-only stored number', () => {
    setup([{ key: '__flat__', label: null, isFlat: true, color: '#000', bg: '#fff', items: GROUPS[0].items.map((i, n) => ({ ...i, flatShelfOrder: (n + 1) * 10 })) }], 'flat')
    expect(screen.queryAllByRole('textbox')).toHaveLength(0)
    expect(screen.getByText('#10')).toBeTruthy()
  })
})
