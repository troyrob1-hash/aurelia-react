/**
 * Inventory header redesign — every former header/toolbar control maps to a
 * reachable new one, wired to the SAME handler it used before.
 *
 * Old header: Show prior, Manage items, Manage categories, Manage zones, Count
 * sheets, Buddy mode, Par (N), Scan & count, Upload counts, Roll over, Update
 * categories / Hide missing items checkboxes, Item list, Replace entire
 * catalog, Export CSV, Export .xlsx, Refresh. Old toolbar + chip bar: category
 * chips, Quick / Section / Zone / Full, search, Grouped / A–Z, Arrange,
 * Variance. The behaviour of each new control is covered by
 * inventoryToolbar.ui.test.jsx / editSheet.ui.test.jsx; this pins the wiring.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const code = p => readFileSync(resolve(ROOT, p), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
const INV = code('src/routes/Inventory.jsx')
const between = (a, b) => INV.slice(INV.indexOf(a), INV.indexOf(b, INV.indexOf(a)))
const TOOLBAR = between('<InventoryToolbar', '/>\n')
const EDITBAR = between('<EditSheetBar', '/>\n')
const STRIP = between('<StartStrip', '/>\n')

const MAP = [
  // [former control, where it lives now, the wiring that proves it]
  ['category chips + Quick/Section/Zone/Full', 'Sheet', [TOOLBAR, /sheets=\{sheetList\}\s*sheet=\{currentSheet\}\s*onSheetChange=\{pickSheet\}/]],
  ['search', 'Search or scan', [TOOLBAR, /search=\{search\}\s*onSearchChange=\{setSearch\}/]],
  ['Scan & count', 'Scan in the search box', [TOOLBAR, /onScan=\{\(\) => setShowScanner\(true\)\}/]],
  ['Grouped / A–Z', 'View', [TOOLBAR, /viewMode=\{viewMode\}\s*onViewModeChange=\{setViewMode\}/]],
  ['Show prior / Blind', "View → Show last week's counts", [TOOLBAR, /showPrior=\{showPrior\}\s*onShowPriorChange=\{setShowPrior\}/]],
  ['Variance', 'View → Show variance', [TOOLBAR, /showVariance=\{showVariance\}\s*onShowVarianceChange=\{setShowVariance\}/]],
  ['Arrange / Done arranging', 'Edit sheet', [TOOLBAR, /onToggleEdit=\{\(\) => \(arrangeMode \? exitArrangeMode\(\) : enterArrangeMode\(\)\)\}/]],
  ['Count sheets', 'More → Print count sheets', [TOOLBAR, /onPrint: \(\) => setPrintSheet\('__all__'\),\s*printDisabled: items\.length === 0/]],
  ['Upload counts', 'More → Upload a count file', [TOOLBAR, /onUploadCounts: openCountUpload,\s*uploadCountsDisabled: locked/]],
  ['Buddy mode', 'More → Buddy mode', [TOOLBAR, /onBuddy: toggleBuddy/]],
  ['Export CSV / .xlsx', 'More → Export (CSV or Excel)', [TOOLBAR, /onExport: exportInventory/]],
  ['Refresh', 'More → Refresh', [TOOLBAR, /onRefresh: handleRefresh/]],
  ['Par (N)', '"N below par" pill', [INV, /<ParPill count=\{totals\.belowPar \|\| 0\} open=\{showParPanel\} onToggle=\{\(\) => setShowParPanel\(v => !v\)\} \/>/]],
  ['Count sheets (empty period)', 'Start strip → Print count sheets', [STRIP, /onPrint=\{\(\) => setPrintSheet\('__all__'\)\}/]],
  ['Upload counts (empty period)', 'Start strip → Upload a count file', [STRIP, /onUploadCounts=\{openCountUpload\}\s*uploadCountsDisabled=\{locked\}/]],
  ['Roll over inventory', 'Start strip → Roll over last week', [STRIP, /showRollover=\{showRollover\}\s*onRollOver=\{handleRollOver\}\s*rollOverDisabled=\{rollingOver \|\| locked\}/]],
  ['Manage items', 'Edit sheet → Manage items / Add item', [EDITBAR, /onManageItems=\{openManageItems\}/]],
  ['Manage categories', 'Edit sheet → Categories', [EDITBAR, /canEditCats=\{canEditCats\}\s*locked=\{locked\}\s*onCategories=\{\(\) => setShowCatManager\(true\)\}/]],
  ['Manage zones', 'Edit sheet → Zones', [EDITBAR, /onZones=\{\(\) => setShowZoneManager\(true\)\}/]],
  ['Item list + checkboxes + Replace entire catalog', 'Edit sheet → Upload item list', [EDITBAR, /onUploadItemList=\{\(\) => setShowItemListUpload\(true\)\}/]],
  ['Done arranging', 'Edit sheet → Done', [EDITBAR, /onDone=\{exitArrangeMode\}/]],
]

describe('every former control maps to a reachable new one', () => {
  it.each(MAP)('%s → %s', (_old, _now, [src, re]) => {
    expect(src.length).toBeGreaterThan(0)
    expect(src).toMatch(re)
  })

  it('the moved handlers do what the old buttons did', () => {
    expect(INV).toMatch(/const openManageItems = \(\) => \{ setShowManage\(true\); loadRemovedItems\(\) \}/)
    expect(INV).toMatch(/const openCountUpload = \(\) => \{\s*if \(locked\) \{ toast\.error\('Period is closed — a director must reopen it to make changes\.'\); return \}\s*document\.getElementById\('counts-upload'\)\?\.click\(\)/)
    expect(INV).toMatch(/id="counts-upload"\s*onChange=\{e => \{ if \(e\.target\.files\[0\]\) \{ parseCountFile\(e\.target\.files\[0\]\)/)
    expect(INV).toMatch(/const blindMode = !showPrior/)
    expect(INV).toMatch(/if \(buddyMode\) \{\s*setBuddyMode\(false\)\s*setBuddyNames\(\{ caller: '', marker: '' \}\)\s*\} else \{\s*setBuddyDraft\(\{ caller: '', marker: '' \}\)\s*setShowBuddySetup\(true\)/)
  })

  it('the Edit sheet bar only renders in edit mode, and Edit sheet is locked like Arrange was', () => {
    expect(INV).toMatch(/\{arrangeMode && \(\s*<EditSheetBar/)
    expect(TOOLBAR).toMatch(/editDisabled=\{locked && !arrangeMode\}/)
    expect(TOOLBAR).toMatch(/editTitle=\{locked \? 'Period closed — reopen to edit'/)
  })

  it('the old header controls are gone', () => {
    for (const gone of ['Scan &amp; count', 'Par ({', 'Replace entire catalog', '⚙ Manage', "'Done arranging' : 'Arrange'", 'Show prior', 'htmlFor="catalog-upload"', 'styles.btnIcon']) {
      expect(INV.includes(gone), gone).toBe(false)
    }
  })
})

describe('Help & Directions names the new controls, not the moved ones', () => {
  const D = readFileSync(resolve(ROOT, 'src/content/directions.js'), 'utf8')
  it('no amber "Item list" button, green "Upload counts" button, Manage items or Arrange button', () => {
    expect(D).not.toMatch(/"Item list" button|amber "Item list"|"Upload counts" button|Upload counts \(green|⚙ Manage|Arrange button/)
  })
  it('points at Edit sheet → Upload item list and More → Upload a count file', () => {
    expect(D).toMatch(/Edit sheet → "Upload item list"/)
    expect(D).toMatch(/More → "Upload a count file"/)
  })
})

describe('dead responsive rules are gone', () => {
  const CSS = readFileSync(resolve(ROOT, 'src/routes/Inventory.module.css'), 'utf8')
  it.each(['.toolbarRow', '.search ', '.search,', '.page ', '.catBar', '.catPill', '.modeTabs'])('%s', sel => {
    expect(CSS.includes(sel)).toBe(false)
  })
})
