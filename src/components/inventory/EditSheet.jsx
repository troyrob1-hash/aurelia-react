import { useState } from 'react'
import { Copy, Plus, Upload } from 'lucide-react'
import styles from './InventoryToolbar.module.css'
import { catalogLossLines } from '@/lib/catalogImport'

// Edit sheet mode's bar (above the ArrangeList). Replaces the old header's
// Manage items / Manage categories / Manage zones / Arrange / Item list
// buttons. Categories and Zones keep their old role gate (canEditCats) and
// locked gating; everything else is open to every role that could use it
// before.
export function EditSheetBar({ onAddItem, onManageItems, canEditCats, locked, onCategories, onZones, onUploadItemList, uploadBusy, onCopyFromSite, onDone }) {
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
      {canEditCats && onCopyFromSite && (
        <button type="button" className={styles.btn} onClick={onCopyFromSite} disabled={locked}
          title={locked ? lockedTitle : "Replace this site's items, sheets and zones with another site's"}>
          <Copy size={14} aria-hidden="true" /> Copy from another site
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

// Copy from another site: pick a source, see what it brings and exactly what
// this site loses (the same named losses as the Replace confirm), then confirm.
// The parent does the I/O (runCatalogCopy in src/lib/catalogCopy.js).
//   sites        [{ value, label }] — accessible sites, this one excluded
//   targetLabel  this site's name
//   targetLosses catalogLossSummary of this site's current items
//   loadSource   (value) => Promise<{ items, sheets }>
//   onCopy       (value) => Promise<{ status, error? }> — 'done' closes via the parent
export function CopyFromSiteDialog({ sites, targetLabel, targetLosses, loadSource, onCopy, onClose }) {
  const [site, setSite] = useState('')
  const [source, setSource] = useState(null)
  const [busy, setBusy] = useState(false)          // reading the source
  const [copying, setCopying] = useState(false)    // the copy itself — dialog can't close
  const [error, setError] = useState(null)

  async function pick(value) {
    setSite(value); setSource(null); setError(null)
    if (!value) return
    setBusy(true)
    try { setSource(await loadSource(value)) } catch (e) { setError("Couldn't read that site: " + (e?.message || e)) }
    setBusy(false)
  }
  async function confirm() {
    setCopying(true); setError(null)
    let result
    try { result = await onCopy(site) } catch (e) { result = { status: 'failed', error: "The copy didn't finish: " + (e?.message || e) } }
    setCopying(false)
    if (result?.status !== 'done') setError(result?.error || "The copy didn't finish.")
  }
  const locked = busy || copying
  const close = () => { if (!copying) onClose() }

  const losses = targetLosses ? catalogLossLines(targetLosses) : []
  const sourceLabel = sites.find(x => x.value === site)?.label
  return (
    <div className={styles.overlay} onMouseDown={e => { if (e.target === e.currentTarget && !locked) close() }}
      onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); close() } }}>
      <div className={styles.dialog} role="dialog" aria-modal="true" aria-labelledby="copy-site-title">
        <h3 id="copy-site-title" className={styles.dialogTitle}>Copy from another site</h3>
        <p className={styles.dialogSub}>
          Makes {targetLabel}'s items, sheets and zones an exact copy of another site's — sheet membership, positions,
          key items and par levels included. Counts and past weeks are not touched.
        </p>
        <label className={styles.field}>
          <span className={styles.fieldLabel}>Copy from</span>
          <select value={site} onChange={e => pick(e.target.value)} disabled={locked} aria-label="Copy from">
            <option value="">Choose a site…</option>
            {sites.map(x => <option key={x.value} value={x.value}>{x.label}</option>)}
          </select>
        </label>
        {source && (
          <div className={styles.field} data-testid="copy-summary">
            <span className={styles.fieldLabel}>{sourceLabel}</span>
            <span>{source.items} item{source.items === 1 ? '' : 's'}, {source.sheets} sheet{source.sheets === 1 ? '' : 's'}</span>
            <span className={styles.fieldLabel} style={{ marginTop: 10 }}>{targetLabel}</span>
            {targetLosses && (targetLosses.total || targetLosses.removedCount) ? (
              <div style={{ whiteSpace: 'pre-line' }}>
                {`This replaces all ${targetLosses.total} current item${targetLosses.total === 1 ? '' : 's'}${losses.length ? ', including:' : '.'}`}
                {losses.length ? '\n' + losses.join('\n') : ''}
                {'\nA backup of the current list is saved first.'}
              </div>
            ) : (
              <span>No items here yet, so nothing will be lost.</span>
            )}
          </div>
        )}
        {copying && (
          <p role="status" aria-live="polite" style={{ fontSize: 13, fontWeight: 600, margin: '8px 0 0' }}>
            Copying {source?.docs ?? source?.items} items from {sourceLabel}… Keep this open until it finishes.
          </p>
        )}
        {error && <p role="alert" style={{ color: '#b91c1c', fontSize: 13, margin: '8px 0 0' }}>{error}</p>}
        <div className={styles.dialogActions}>
          <button type="button" className={styles.btn} onClick={close} disabled={locked}>Cancel</button>
          <button type="button" className={`${styles.btn} ${styles.btnDanger}`} onClick={confirm} disabled={!source || locked}>
            {copying ? 'Copying…' : 'Copy and replace'}
          </button>
        </div>
      </div>
    </div>
  )
}
