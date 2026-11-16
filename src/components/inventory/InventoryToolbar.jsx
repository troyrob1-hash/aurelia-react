import { useState } from 'react'
import { AlertTriangle, ChevronDown, MoreHorizontal, Search, SlidersHorizontal } from 'lucide-react'
import Menu, { MenuItem, MenuHeading, MenuDivider } from './Menu'
import { sheetButtonLabel } from '@/lib/sheetPicker'
import styles from './InventoryToolbar.module.css'

// The Inventory control row (single-location view): Sheet · Search · View ·
// Edit sheet · More. Pure presentation — Inventory.jsx owns every handler, so
// each control here does exactly what its old header button did.
//
// At phone width (see the CSS module) View and Edit sheet hide from the row and
// reappear inside More; their More copies carry styles.phoneOnly.
export default function InventoryToolbar({
  sheets, sheet, onSheetChange,
  search, onSearchChange,
  viewMode, onViewModeChange, showPrior, onShowPriorChange, showVariance, onShowVarianceChange,
  editing, editDisabled, editTitle, onToggleEdit,
  more,
}) {
  const current = sheets.find(o => o.value === sheet) || sheets[0]
  const sheetGroup = sheets.filter(o => o.group === 'sheets')
  const zoneGroup = sheets.filter(o => o.group === 'zones')

  const viewItems = close => (<>
    <MenuHeading>View</MenuHeading>
    <MenuItem kind="radio" checked={viewMode === 'grouped'} onSelect={() => onViewModeChange('grouped')} close={close} title="Group items by category">Grouped</MenuItem>
    <MenuItem kind="radio" checked={viewMode === 'flat'} onSelect={() => onViewModeChange('flat')} close={close} title="Show all items A-Z, no categories">A–Z</MenuItem>
    <MenuDivider />
    <MenuItem kind="checkbox" checked={showPrior} onSelect={() => onShowPriorChange(!showPrior)} close={close} title="Off = blind count: no prior-count hints in the count boxes, no variance alerts">Show last week's counts</MenuItem>
    <MenuItem kind="checkbox" checked={showVariance} onSelect={() => onShowVarianceChange(!showVariance)} close={close}>Show variance</MenuItem>
  </>)

  return (
    <div className={styles.row} role="toolbar" aria-label="Inventory controls">
      {/* 1. Sheet */}
      <Menu
        label="Sheet"
        wide
        buttonClassName={styles.btnSheet}
        buttonContent={<>
          {current?.color && <span className={styles.dot} style={{ background: current.color }} aria-hidden="true" />}
          <span className={styles.sheetText}>{sheetButtonLabel(current)}</span>
          <ChevronDown size={14} aria-hidden="true" />
        </>}
      >
        {({ close }) => (<>
          {sheetGroup.map(o => (
            <MenuItem key={o.value} kind="radio" checked={o.value === sheet} onSelect={() => onSheetChange(o.value)} close={close}>
              <span className={styles.sheetName}>
                {o.color && <span className={styles.dot} style={{ background: o.color }} aria-hidden="true" />}
                {o.label}
              </span>
              <span className={`${styles.sheetCount} ${o.complete ? styles.sheetDone : ''}`}>
                {o.complete && <span aria-label="complete">✓ </span>}{o.counted}/{o.total}
              </span>
            </MenuItem>
          ))}
          {zoneGroup.length > 0 && (<>
            <MenuDivider />
            <MenuHeading>Zones</MenuHeading>
            {zoneGroup.map(o => (
              <MenuItem key={o.value} kind="radio" checked={o.value === sheet} onSelect={() => onSheetChange(o.value)} close={close}
                title={o.complete ? 'Swept — blanks in this zone count as zero' : 'Not swept — blanks are unknown'}>
                <span className={styles.sheetName}>{o.label}</span>
                <span className={`${styles.sheetCount} ${o.complete ? styles.sheetDone : ''}`}>{o.complete ? '✓ swept' : 'not swept'}</span>
              </MenuItem>
            ))}
          </>)}
        </>)}
      </Menu>

      {/* 2. Search */}
      <div className={styles.searchWrap}>
        <Search size={14} className={styles.searchIcon} aria-hidden="true" />
        <input
          type="text"
          value={search}
          onChange={e => onSearchChange(e.target.value)}
          placeholder="Search items or vendor..."
          aria-label="Search items or vendor"
          className={styles.searchInput}
        />
      </div>

      {/* 3. View */}
      <div className={styles.desktopOnly}>
        <Menu label="View" buttonContent={<><SlidersHorizontal size={14} aria-hidden="true" /> View</>}>
          {({ close }) => viewItems(close)}
        </Menu>
      </div>

      {/* 4. Edit sheet */}
      <button
        type="button"
        className={`${styles.btn} ${styles.desktopOnly} ${editing ? styles.btnActive : ''}`}
        onClick={onToggleEdit}
        disabled={editDisabled}
        title={editTitle}
        aria-pressed={!!editing}
      >
        {editing ? 'Done editing' : 'Edit sheet'}
      </button>

      {/* 5. More */}
      <Menu label="More" align="right" buttonContent={<><MoreHorizontal size={14} aria-hidden="true" /> More</>}>
        {({ close }) => <MoreItems close={close} more={more} viewItems={viewItems}
          edit={{ editing, editDisabled, editTitle, onToggleEdit }} />}
      </Menu>
    </div>
  )
}

function MoreItems({ close, more, viewItems, edit }) {
  const [exporting, setExporting] = useState(false)
  return (<>
    <MenuItem onSelect={more.onPrint} disabled={more.printDisabled} close={close}
      title="Print blank count sheets by category for crew to fill in by hand">Print count sheets</MenuItem>
    <MenuItem onSelect={more.onUploadCounts} disabled={more.uploadCountsDisabled} close={close}
      title={more.uploadCountsTitle}>Upload a count file</MenuItem>
    <MenuItem kind="checkbox" checked={more.buddyMode} onSelect={more.onBuddy} close={close}
      title={more.buddyMode ? 'Exit buddy mode' : 'Start a team count with two people'}>
      {more.buddyMode ? `Buddy mode: ${more.buddyLabel}` : 'Buddy mode'}
    </MenuItem>
    {exporting ? (
      <div className={styles.menuChoice} role="group" aria-label="Export format">
        <span>Export as</span>
        <MenuItem className={styles.menuChoiceBtn} onSelect={() => more.onExport('csv')} close={close} title="Export CSV">CSV</MenuItem>
        <MenuItem className={styles.menuChoiceBtn} onSelect={() => more.onExport('xlsx')} close={close} title="Export Excel">Excel</MenuItem>
      </div>
    ) : (
      <MenuItem onSelect={() => setExporting(true)} keepOpen close={close}>Export…</MenuItem>
    )}
    <MenuItem onSelect={more.onRefresh} close={close} title="Reload this location's inventory">Refresh</MenuItem>

    {/* Phone width: View and Edit sheet live here instead of the row. */}
    <div className={styles.phoneOnly}>
      <MenuDivider />
      <MenuItem onSelect={edit.onToggleEdit} disabled={edit.editDisabled} title={edit.editTitle} close={close}>
        {edit.editing ? 'Done editing' : 'Edit sheet'}
      </MenuItem>
      <MenuDivider />
      {viewItems(close)}
    </div>
  </>)
}

// "N below par" — replaces the always-on "Par (N)" button. Renders nothing
// at zero; clicking toggles the existing par panel.
export function ParPill({ count, open, onToggle }) {
  if (!(count > 0)) return null
  return (
    <button type="button" className={`${styles.pill} ${open ? styles.pillActive : ''}`}
      onClick={onToggle} aria-pressed={!!open} title="Par levels">
      <AlertTriangle size={13} aria-hidden="true" /> {count} below par
    </button>
  )
}
