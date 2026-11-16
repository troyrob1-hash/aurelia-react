// @vitest-environment jsdom

// Edit sheet mode: the bar (role + locked gating) and the Upload item list
// dialog (merge default; Replace reaches replaceCatalog, whose backup +
// zero-item guard + named-losses confirm are pinned in catalogZeroItemGuard).

import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import { EditSheetBar, ItemListUploadDialog } from '../src/components/inventory/EditSheet'
import { canEditInventoryCategories } from '../src/lib/permissions'

afterEach(cleanup)

function bar(over = {}) {
  const h = { onAddItem: vi.fn(), onManageItems: vi.fn(), onCategories: vi.fn(), onZones: vi.fn(), onUploadItemList: vi.fn(), onDone: vi.fn() }
  render(<EditSheetBar canEditCats locked={false} {...h} {...over} />)
  return h
}
const btn = name => screen.queryByRole('button', { name })

describe('Edit sheet bar', () => {
  it('Add item, Manage items, Categories, Zones, Upload item list, Done each fire their handler', () => {
    const h = bar()
    for (const [name, fn] of [['Add item', 'onAddItem'], ['Manage items', 'onManageItems'], ['Categories', 'onCategories'], ['Zones', 'onZones'], ['Upload item list', 'onUploadItemList'], ['Done', 'onDone']]) {
      fireEvent.click(btn(name))
      expect(h[fn], name).toHaveBeenCalledTimes(1)
    }
  })

  it('a role that fails canEditInventoryCategories sees no Categories or Zones; everything else stays', () => {
    // NOTE: permissions.js normalizes 'staff' to 'manager', so staff PASS this
    // gate today (as they did for the old Manage categories / zones buttons).
    // The gate is unchanged by the redesign; only a user with no counting role fails it.
    expect(canEditInventoryCategories({ role: 'staff' })).toBe(true)
    expect(canEditInventoryCategories({ role: 'manager' })).toBe(true)
    const noRole = { role: 'viewer' }
    expect(canEditInventoryCategories(noRole)).toBe(false)
    bar({ canEditCats: canEditInventoryCategories(noRole) })
    expect(btn('Categories')).toBeNull()
    expect(btn('Zones')).toBeNull()
    for (const name of ['Add item', 'Manage items', 'Upload item list', 'Done']) expect(btn(name), name).toBeTruthy()
  })

  it('locked: Categories and Zones disabled with the same tooltip as before', () => {
    const h = bar({ locked: true })
    for (const name of ['Categories', 'Zones']) {
      expect(btn(name).disabled).toBe(true)
      expect(btn(name).title).toBe('Period closed — reopen to edit')
      fireEvent.click(btn(name))
    }
    expect(h.onCategories).not.toHaveBeenCalled()
    expect(h.onZones).not.toHaveBeenCalled()
  })

  it('Inventory passes canEditInventoryCategories(user) as the gate', () => {
    const src = readFileSync(resolve(__dirname, '../src/routes/Inventory.jsx'), 'utf8')
    expect(src).toMatch(/const canEditCats = canEditInventoryCategories\(user\)/)
    expect(src).toMatch(/<EditSheetBar[\s\S]{0,400}canEditCats=\{canEditCats\}/)
  })
})

function dialog(over = {}) {
  const h = { onClose: vi.fn(), onUpdateCategories: vi.fn(), onHideMissing: vi.fn(), onMerge: vi.fn(), onReplace: vi.fn() }
  const utils = render(<ItemListUploadDialog updateCategories={false} hideMissing={false} {...h} {...over} />)
  return { ...h, ...utils }
}
const FILE = new File(['Description,Pack Price\nCoke,$24'], 'items.csv', { type: 'text/csv' })
const pick = () => fireEvent.change(screen.getByLabelText('Item list file'), { target: { files: [FILE] } })

describe('Upload item list dialog', () => {
  it('defaults to "Add and update" and sends the file to the merge path', () => {
    const h = dialog()
    expect(screen.getByRole('radio', { name: /Add and update/ }).checked).toBe(true)
    expect(btn('Upload').disabled).toBe(true) // no file yet
    pick()
    fireEvent.click(btn('Upload'))
    expect(h.onMerge).toHaveBeenCalledWith(FILE)
    expect(h.onReplace).not.toHaveBeenCalled()
    expect(h.onClose).toHaveBeenCalled()
  })

  it('"Replace everything" is styled destructive and sends the file to the replace path only', () => {
    const h = dialog()
    pick()
    fireEvent.click(screen.getByRole('radio', { name: /Replace everything/ }))
    const go = btn('Replace everything…')
    expect(go.className).toMatch(/btnDanger/)
    fireEvent.click(go)
    expect(h.onReplace).toHaveBeenCalledWith(FILE)
    expect(h.onMerge).not.toHaveBeenCalled()
  })

  it('Cancel writes nothing', () => {
    const h = dialog()
    pick()
    fireEvent.click(btn('Cancel'))
    expect(h.onClose).toHaveBeenCalled()
    expect(h.onMerge).not.toHaveBeenCalled()
    expect(h.onReplace).not.toHaveBeenCalled()
  })

  it('the two options flip the parent state; they apply to merge only', () => {
    const h = dialog()
    fireEvent.click(screen.getByRole('checkbox', { name: /Update categories/ }))
    fireEvent.click(screen.getByRole('checkbox', { name: /Hide missing items/ }))
    expect(h.onUpdateCategories).toHaveBeenCalledWith(true)
    expect(h.onHideMissing).toHaveBeenCalledWith(true)
    fireEvent.click(screen.getByRole('radio', { name: /Replace everything/ }))
    expect(screen.getByRole('checkbox', { name: /Update categories/ }).disabled).toBe(true)
  })
})

describe('Replace still runs backup + zero-item guard + named confirm', () => {
  const src = readFileSync(resolve(__dirname, '../src/routes/Inventory.jsx'), 'utf8')
  const body = src.slice(src.indexOf('async function replaceCatalog('), src.indexOf('const { periodKey, isCurrentPeriod'))
  it('replaceCatalog still goes through runCatalogReplace with the named-losses confirm and the backup', () => {
    expect(body).toMatch(/runCatalogReplace\(/)
    expect(body).toMatch(/confirm: \(summary, incomingCount\) => window\.confirm\(catalogLossWarningText\(summary, cleanLocName\(location\), incomingCount\)\)/)
    expect(body).toMatch(/backup: async \(docs\) => \{[^}]*await backupLocationCatalog\(locKey, docs\) \}/)
    expect(body).toMatch(/result\.status === 'empty'/)
  })
})
