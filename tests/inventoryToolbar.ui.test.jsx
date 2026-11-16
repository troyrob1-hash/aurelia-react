// @vitest-environment jsdom

// The Inventory control row, driven through the REAL InventoryToolbar: every
// control the old header/toolbar had must be reachable here and call the same
// handler; locked periods gate the same things they gated before.

import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react'
import InventoryToolbar, { ParPill } from '../src/components/inventory/InventoryToolbar'
import { useUIStore } from '../src/store/uiStore'

afterEach(cleanup)

const SHEETS = [
  { value: 'all', label: 'All items', counted: 35, total: 146, group: 'sheets', complete: false },
  { value: 'key', label: 'Key items', counted: 1, total: 2, group: 'sheets', complete: false },
  { value: 'cat:bev', label: 'Beverages', color: '#f00', counted: 31, total: 142, group: 'sheets', complete: false },
  { value: 'cat:snk', label: 'Snacks', color: '#0f0', counted: 4, total: 4, group: 'sheets', complete: true },
]

function setup(over = {}) {
  const h = {
    onSheetChange: vi.fn(), onSearchChange: vi.fn(), onScan: vi.fn(), onViewModeChange: vi.fn(),
    onShowPriorChange: vi.fn(), onShowVarianceChange: vi.fn(), onToggleEdit: vi.fn(),
  }
  const more = {
    onPrint: vi.fn(), printDisabled: false, onUploadCounts: vi.fn(), uploadCountsDisabled: false,
    buddyMode: false, buddyLabel: '', onBuddy: vi.fn(), onExport: vi.fn(), onRefresh: vi.fn(),
    ...(over.more || {}),
  }
  render(<InventoryToolbar sheets={SHEETS} sheet="cat:bev" search="" viewMode="grouped"
    showPrior showVariance editing={false} editDisabled={false} editTitle="Edit"
    {...h} {...over} more={more} />)
  return { ...h, more }
}
const open = name => fireEvent.click(screen.getByRole('button', { name }))
// menuitem, menuitemradio, menuitemcheckbox — first row whose text has `name`.
const menuItems = () => [...document.querySelectorAll('[role^="menuitem"]')]
const anyItem = name => menuItems().find(el => el.textContent.includes(name))
const item = anyItem

describe('Sheet button', () => {
  it('shows the current sheet and its progress', () => {
    setup()
    expect(screen.getByRole('button', { name: 'Sheet' }).textContent).toContain('Beverages · 31 of 142')
  })
  it('lists All items, Key items, then each category with counted/total and a check when complete', () => {
    setup()
    open('Sheet')
    const rows = screen.getAllByRole('menuitemradio')
    expect(rows.map(r => r.textContent)).toEqual(['All items35/146', 'Key items1/2', '✓Beverages31/142', 'Snacks✓ 4/4'])
    expect(rows[2].getAttribute('aria-checked')).toBe('true')
  })
  it('picking a sheet calls onSheetChange with its value and closes the list', () => {
    const { onSheetChange } = setup()
    open('Sheet')
    fireEvent.click(anyItem('Key items'))
    expect(onSheetChange).toHaveBeenCalledWith('key')
    expect(screen.queryByRole('menu')).toBeNull()
  })
  it('zones show as a second group', () => {
    render(<InventoryToolbar sheets={[...SHEETS, { value: 'zone:dry', label: 'Dry', group: 'zones', complete: true }]}
      sheet="zone:dry" search="" viewMode="grouped" showPrior showVariance more={{}} onSheetChange={() => {}} />)
    expect(screen.getByRole('button', { name: 'Sheet' }).textContent).toContain('Dry · swept')
    open('Sheet')
    expect(screen.getByText('Zones')).toBeTruthy()
    expect(anyItem('Dry').textContent).toContain('✓ swept')
  })
})

describe('View menu', () => {
  it('Grouped / A–Z / Show last week\'s counts / Show variance call the same setters', () => {
    const h = setup()
    open('View'); fireEvent.click(item('A–Z'))
    expect(h.onViewModeChange).toHaveBeenCalledWith('flat')
    open('View'); fireEvent.click(item("Show last week's counts"))
    expect(h.onShowPriorChange).toHaveBeenCalledWith(false)
    open('View'); fireEvent.click(item('Show variance'))
    expect(h.onShowVarianceChange).toHaveBeenCalledWith(false)
  })
  it('last week\'s counts are ON by default and persist in the same store as grouped/flat', () => {
    const s = useUIStore.getState()
    expect(s.inventoryShowPrior).toBe(true)
    expect(s.inventoryShowVariance).toBe(true)
    expect(s.inventoryViewMode).toBe('grouped')
    s.setInventoryShowPrior(false)
    expect(useUIStore.getState().inventoryShowPrior).toBe(false)
    s.setInventoryShowPrior(true)
  })
})

describe('More menu', () => {
  it('Print count sheets, Upload a count file, Buddy mode, Export (CSV or Excel), Refresh', () => {
    const { more } = setup()
    for (const [name, fn] of [['Print count sheets', 'onPrint'], ['Upload a count file', 'onUploadCounts'], ['Buddy mode', 'onBuddy'], ['Refresh', 'onRefresh']]) {
      open('More'); fireEvent.click(anyItem(name))
      expect(more[fn]).toHaveBeenCalledTimes(1)
    }
    open('More'); fireEvent.click(anyItem('Export'))
    // Export stays open and offers the two formats
    fireEvent.click(within(screen.getByRole('group', { name: 'Export format' })).getByText('Excel'))
    expect(more.onExport).toHaveBeenCalledWith('xlsx')
    open('More'); fireEvent.click(anyItem('Export'))
    fireEvent.click(within(screen.getByRole('group', { name: 'Export format' })).getByText('CSV'))
    expect(more.onExport).toHaveBeenCalledWith('csv')
  })
  it('buddy mode shows who is counting while active', () => {
    setup({ more: { buddyMode: true, buddyLabel: 'Ana + Bo' } })
    open('More')
    expect(anyItem('Buddy mode').textContent).toBe('✓Buddy mode: Ana + Bo')
  })
  it('a locked period disables Upload a count file; no items disables Print', () => {
    const { more } = setup({ more: { uploadCountsDisabled: true, printDisabled: true } })
    open('More')
    expect(anyItem('Upload a count file').disabled).toBe(true)
    expect(anyItem('Print count sheets').disabled).toBe(true)
    fireEvent.click(anyItem('Upload a count file'))
    expect(more.onUploadCounts).not.toHaveBeenCalled()
  })
  it('phone width: More also carries Edit sheet and the View options', () => {
    setup()
    open('More')
    expect(anyItem('Edit sheet')).toBeTruthy()
    expect(anyItem("Show last week's counts")).toBeTruthy()
  })
})

describe('Edit sheet button', () => {
  it('toggles edit mode', () => {
    const { onToggleEdit } = setup()
    fireEvent.click(screen.getByRole('button', { name: 'Edit sheet' }))
    expect(onToggleEdit).toHaveBeenCalledTimes(1)
  })
  it('locked: disabled, with the tooltip', () => {
    const { onToggleEdit } = setup({ editDisabled: true, editTitle: 'Period closed — reopen to edit' })
    const b = screen.getByRole('button', { name: 'Edit sheet' })
    expect(b.disabled).toBe(true)
    expect(b.title).toBe('Period closed — reopen to edit')
    fireEvent.click(b)
    expect(onToggleEdit).not.toHaveBeenCalled()
  })
  it('while editing it reads "Done editing"', () => {
    setup({ editing: true })
    expect(screen.getByRole('button', { name: 'Done editing' }).getAttribute('aria-pressed')).toBe('true')
  })
})

describe('Par pill', () => {
  it('renders nothing at 0, "N below par" above 0, and toggles the par panel', () => {
    const onToggle = vi.fn()
    const { container, rerender } = render(<ParPill count={0} open={false} onToggle={onToggle} />)
    expect(container.innerHTML).toBe('')
    rerender(<ParPill count={3} open={false} onToggle={onToggle} />)
    fireEvent.click(screen.getByRole('button', { name: /3 below par/ }))
    expect(onToggle).toHaveBeenCalledTimes(1)
  })
})
