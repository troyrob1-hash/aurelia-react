import { useState } from 'react'
import { Plus, Upload } from 'lucide-react'
import styles from './InventoryToolbar.module.css'

// Edit sheet mode's bar (above the ArrangeList). Replaces the old header's
// Manage items / Manage categories / Manage zones / Arrange / Item list
// buttons. Categories and Zones keep their old role gate (canEditCats) and
// locked gating; everything else is open to every role that could use it
// before.
export function EditSheetBar({ onAddItem, onManageItems, canEditCats, locked, onCategories, onZones, onUploadItemList, uploadBusy, onDone }) {
  const lockedTitle = 'Period closed — reopen to edit'
  return (
    <div className={styles.editBar} role="region" aria-label="Edit sheet">
      <span className={styles.editBarTitle}>Editing this sheet</span>
      <button type="button" className={styles.btn} onClick={onAddItem} title="Add a custom item to this location's count sheet">
        <Plus size={14} aria-hidden="true" /> Add item
      </button>
      <button type="button" className={styles.btn} onClick={onManageItems} title="Add, remove or restore items for this location">
        Manage items
      </button>
      {canEditCats && (
        <button type="button" className={styles.btn} onClick={onCategories} disabled={locked}
          title={locked ? lockedTitle : "Manage this location's inventory categories"}>
          Categories
        </button>
      )}
      {canEditCats && (
        <button type="button" className={styles.btn} onClick={onZones} disabled={locked}
          title={locked ? lockedTitle : "Manage this location's counting zones"}>
          Zones
        </button>
      )}
      <button type="button" className={`${styles.btn} ${styles.btnDefs}`} onClick={onUploadItemList} disabled={uploadBusy}
        title="Upload item list (.xlsx, .csv) — item DEFINITIONS only, never counts">
        <Upload size={14} aria-hidden="true" /> {uploadBusy ? 'Replacing…' : 'Upload item list'}
      </button>
      <button type="button" className={`${styles.btn} ${styles.btnActive}`} onClick={onDone}>Done</button>
    </div>
  )
}

// Upload item list: file + the two merge options + the mode. "Add and update"
// runs the existing merge (uploadCatalog); "Replace everything" runs the
// existing replace (replaceCatalog), whose named-losses confirm, pre-upload
// backup and zero-item guard all live in runCatalogReplace — untouched here.
// The two options are the parent's state (read by uploadCatalog at upload
// time), so this dialog only flips them.
export function ItemListUploadDialog({ onClose, updateCategories, onUpdateCategories, hideMissing, onHideMissing, onMerge, onReplace }) {
  const [file, setFile] = useState(null)
  const [mode, setMode] = useState('merge')
  const replace = mode === 'replace'

  const submit = () => {
    if (!file) return
    onClose()
    if (replace) onReplace(file)
    else onMerge(file)
  }

  return (
    <div className={styles.overlay} onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className={styles.dialog} role="dialog" aria-modal="true" aria-labelledby="item-list-title">
        <h3 id="item-list-title" className={styles.dialogTitle}>Upload item list</h3>
        <p className={styles.dialogSub}>
          Item <strong>definitions</strong> only — name, vendor, pack size, pack price, unit cost, GL code,
          category. Does NOT import counted quantities.
        </p>

        <label className={styles.field}>
          <span className={styles.fieldLabel}>File (.xlsx, .xls, .csv)</span>
          <input type="file" accept=".xlsx,.xls,.csv" aria-label="Item list file"
            onChange={e => setFile(e.target.files?.[0] || null)} />
        </label>

        <div role="radiogroup" aria-label="Upload mode" className={styles.field}>
          <span className={styles.fieldLabel}>Mode</span>
          <label className={`${styles.modeOption} ${!replace ? styles.modeOptionOn : ''}`}>
            <input type="radio" name="item-list-mode" checked={!replace} onChange={() => setMode('merge')} />
            <span>
              <strong>Add and update</strong>
              <span className={styles.checkHint}>Updates matched items' pricing / vendor / GL, adds new items, never deletes anything.</span>
            </span>
          </label>
          <label className={`${styles.modeOption} ${styles.modeDanger} ${replace ? styles.modeDangerOn : ''}`}>
            <input type="radio" name="item-list-mode" checked={replace} onChange={() => setMode('replace')} />
            <span>
              <strong>Replace everything</strong>
              <span className={styles.checkHint}>
                Deletes this location's ENTIRE item catalog and rebuilds it from the file — par levels, shelf
                order and multi-sheet membership are lost for every item the file doesn't re-create. A backup is
                saved first, and you'll see exactly what would be lost before anything is deleted.
              </span>
            </span>
          </label>
        </div>

        <div className={styles.field}>
          <span className={styles.fieldLabel}>Options {replace && '(Add and update only)'}</span>
          <label className={styles.check}
            title="When checked, a matched item's category is updated to what the file says for that row — but only when the row actually names one. Off by default so a hand-corrected category never gets silently reverted by a re-upload.">
            <input type="checkbox" checked={updateCategories} disabled={replace} onChange={e => onUpdateCategories(e.target.checked)} />
            <span>Update categories<span className={styles.checkHint}>Use the file's category for matched items (only rows that name one).</span></span>
          </label>
          <label className={styles.check}
            title="When checked, an item at this location that ISN'T in the uploaded file is hidden (the same as clicking Remove) instead of just being reported. Hidden items can be restored from Edit sheet → Manage items → Removed. Off by default.">
            <input type="checkbox" checked={hideMissing} disabled={replace} onChange={e => onHideMissing(e.target.checked)} />
            <span>Hide missing items<span className={styles.checkHint}>Hide items not in the file (restorable from Manage items).</span></span>
          </label>
        </div>

        <div className={styles.dialogActions}>
          <button type="button" className={styles.btn} onClick={onClose}>Cancel</button>
          <button type="button" className={`${styles.btn} ${replace ? styles.btnDanger : styles.btnPrimary}`}
            onClick={submit} disabled={!file}>
            {replace ? 'Replace everything…' : 'Upload'}
          </button>
        </div>
      </div>
    </div>
  )
}
