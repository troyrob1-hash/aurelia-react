// @vitest-environment jsdom

// "Copy from another site" UI: the Edit sheet bar button (role-gated, disabled
// when locked) and the dialog (pick a source, see its summary and this site's
// named losses — the same lines as the Replace confirm — then confirm).

import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import { EditSheetBar, CopyFromSiteDialog } from '../src/components/inventory/EditSheet'
import { catalogLossLines, catalogLossWarningText } from '../src/lib/catalogImport'

afterEach(cleanup)

const bar = (props = {}) => render(<EditSheetBar onAddItem={() => {}} onManageItems={() => {}} canEditCats locked={false}
  onCategories={() => {}} onZones={() => {}} onUploadItemList={() => {}} onCopyFromSite={() => {}} onDone={() => {}} {...props} />)

describe('Edit sheet bar button', () => {
  it('opens the dialog', () => {
    const onCopyFromSite = vi.fn()
    bar({ onCopyFromSite })
    fireEvent.click(screen.getByRole('button', { name: /Copy from another site/ }))
    expect(onCopyFromSite).toHaveBeenCalledTimes(1)
  })
  it('hidden for a role that cannot edit categories', () => {
    bar({ canEditCats: false })
    expect(screen.queryByRole('button', { name: /Copy from another site/ })).toBeNull()
  })
  it('disabled in a locked period', () => {
    bar({ locked: true })
    const b = screen.getByRole('button', { name: /Copy from another site/ })
    expect(b.disabled).toBe(true)
    expect(b.title).toMatch(/Period closed/)
  })
})

const LOSSES = { total: 7, withPar: 2, withPosition: 5, withSplit: 3, withKey: 1, removedCount: 4 }
const SITES = [{ value: 'HDK', label: 'HDK' }, { value: 'TOPS', label: 'TOPS' }]
async function dialog(props = {}) {
  const p = { sites: SITES, targetLabel: 'Test Sandbox', targetLosses: LOSSES, loadSource: vi.fn(async () => ({ items: 523, sheets: 20 })),
    onCopy: vi.fn(async () => ({ status: 'done' })), onClose: vi.fn(), ...props }
  render(<CopyFromSiteDialog {...p} />)
  return p
}
const choose = async (v) => act(async () => { fireEvent.change(screen.getByLabelText('Copy from'), { target: { value: v } }) })

describe('dialog', () => {
  it('lists the sites given, and nothing can be confirmed before one is picked', async () => {
    await dialog()
    expect([...screen.getByLabelText('Copy from').options].map(o => o.value)).toEqual(['', 'HDK', 'TOPS'])
    expect(screen.getByRole('button', { name: 'Copy and replace' }).disabled).toBe(true)
  })
  it("picking a site shows its summary and this site's named losses — the Replace confirm's lines", async () => {
    const p = await dialog()
    await choose('HDK')
    expect(p.loadSource).toHaveBeenCalledWith('HDK')
    const summary = screen.getByTestId('copy-summary').textContent
    expect(summary).toContain('523 items, 20 sheets')
    expect(summary).toContain('This replaces all 7 current items, including:')
    for (const line of catalogLossLines(LOSSES)) {
      expect(summary).toContain(line)
      expect(catalogLossWarningText(LOSSES, 'X')).toContain(line)
    }
    expect(catalogLossLines(LOSSES)).toHaveLength(5)
  })
  it('an empty site says nothing will be lost', async () => {
    await dialog({ targetLosses: { total: 0, withPar: 0, withPosition: 0, withSplit: 0, withKey: 0, removedCount: 0 } })
    await choose('TOPS')
    expect(screen.getByTestId('copy-summary').textContent).toContain('nothing will be lost')
  })
  it('confirm runs the copy for the chosen site', async () => {
    const p = await dialog()
    await choose('TOPS')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Copy and replace' })) })
    expect(p.onCopy).toHaveBeenCalledWith('TOPS')
    expect(screen.queryByRole('alert')).toBeNull()
  })
  it('a refusal or failure is shown, not swallowed', async () => {
    await dialog({ onCopy: async () => ({ status: 'refused', error: 'This site already has counts entered for 2026-P11-W3 (1 item).' }) })
    await choose('HDK')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Copy and replace' })) })
    expect(screen.getByRole('alert').textContent).toContain('2026-P11-W3')
  })
  it('an exception from the copy is shown too', async () => {
    await dialog({ onCopy: async () => { throw new Error('boom') } })
    await choose('HDK')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Copy and replace' })) })
    expect(screen.getByRole('alert').textContent).toMatch(/didn't finish: boom/)
  })
})

describe('Inventory wiring', () => {
  const src = readFileSync(resolve(process.cwd(), 'src/routes/Inventory.jsx'), 'utf8')
  it('offers the sites this user can see, minus this one, and checks TODAY\'s week', () => {
    expect(src).toMatch(/visibleLocations \|\| \[\]\)\.filter\(l => l\.name && l\.name !== location\)/)
    expect(src).toMatch(/weekKey: dateToKey\(new Date\(\)\), locked: periodLocked/)
    expect(src).toMatch(/onCopyFromSite=\{openCopyFromSite\}/)
  })
})
