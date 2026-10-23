import { useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { Printer, X } from 'lucide-react'
import {
  buildCountSheets, paginateSheets, SHEET_COLUMNS, UNCATEGORIZED_SHEET_KEY,
} from '@/lib/countSheets'
import './countSheetPrint.css'

// Printable count sheets — preview + print. Read-only: builds pages from the
// items already loaded on the Inventory page and hands them to the browser's
// print dialog. Writes nothing.
//
// The preview shows the exact pages that will print (same component). The
// print copy is a portal on <body> that countSheetPrint.css shows ONLY under
// @media print, hiding the app around it; it exists only while this dialog is
// open, so printing any other page is unaffected.

const ALL = '__all__'

export function CountSheetPages({ pages, locationLabel, periodKey, printedAt }) {
  return pages.map(p => (
    <section className="cs-page" key={`${p.sheetKey}-${p.pageNo}`}>
      <div className="cs-head">
        <div className="cs-cat">{p.label}</div>
        <div className="cs-meta">
          <div><strong>{locationLabel}</strong></div>
          <div>Period {periodKey}</div>
        </div>
      </div>
      <div className="cs-fill">
        <div>Counted by <span className="cs-line" /></div>
        <div>Date <span className="cs-line" /></div>
        <div>Sign-off <span className="cs-line" /></div>
      </div>
      <table className="cs-table">
        <thead>
          <tr>
            {SHEET_COLUMNS.map(c => <th key={c.key} className={`cs-col-${c.key}`}>{c.label}</th>)}
          </tr>
        </thead>
        <tbody>
          {p.rows.map(r => (
            <tr key={r.id || r.name}>
              {SHEET_COLUMNS.map(c => (
                <td key={c.key} className={`cs-col-${c.key}`} title={c.field === 'name' ? r.name : undefined}>
                  {c.box ? <span className="cs-box" /> : c.field ? r[c.field] : null}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {p.rows.length === 0 && <div className="cs-empty">No items in this category.</div>}
      <div className="cs-foot">
        <span>{p.label} · {locationLabel} · {periodKey}</span>
        <span>Page {p.pageNo} of {p.pageCount} · printed {printedAt}</span>
      </div>
    </section>
  ))
}

export default function CountSheetPrintModal({ items, categories, locationLabel, periodKey, initialCategory, onClose }) {
  const [selected, setSelected] = useState(initialCategory || ALL)
  const sheets = useMemo(
    () => buildCountSheets(items, categories, selected === ALL ? {} : { only: selected }),
    [items, categories, selected],
  )
  const pages = useMemo(() => paginateSheets(sheets), [sheets])
  const itemRows = sheets.reduce((n, s) => n + s.rows.length, 0)
  const printedAt = useMemo(() => new Date().toLocaleDateString(), [])
  const hasOrphans = useMemo(
    () => buildCountSheets(items, categories).some(s => s.key === UNCATEGORIZED_SHEET_KEY),
    [items, categories],
  )
  const sheetProps = { pages, locationLabel, periodKey, printedAt }

  return (
    <>
      <div
        onClick={onClose}
        style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.45)', zIndex: 4000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}
      >
        <div
          role="dialog"
          aria-label="Print count sheets"
          onClick={e => e.stopPropagation()}
          style={{ background: '#fff', borderRadius: 12, width: 'min(920px, 100%)', maxHeight: '100%', display: 'flex', flexDirection: 'column', boxShadow: '0 20px 50px rgba(0,0,0,0.25)' }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '14px 18px', borderBottom: '1px solid #e2e8f0', flexWrap: 'wrap' }}>
            <div style={{ fontSize: 15, fontWeight: 700, color: '#0f172a', marginRight: 'auto' }}>Print count sheets</div>
            <select
              value={selected}
              onChange={e => setSelected(e.target.value)}
              aria-label="Which sheet"
              style={{ padding: '6px 10px', borderRadius: 8, border: '1px solid #cbd5e1', fontSize: 13 }}
            >
              <option value={ALL}>All categories (one per page)</option>
              {categories.map(c => <option key={c.key} value={c.key}>{c.label}</option>)}
              {hasOrphans && <option value={UNCATEGORIZED_SHEET_KEY}>Not in any category</option>}
            </select>
            <button
              onClick={() => window.print()}
              disabled={itemRows === 0}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 14px', borderRadius: 8, border: 'none', background: itemRows === 0 ? '#94a3b8' : '#0f172a', color: '#fff', fontSize: 13, fontWeight: 600, cursor: itemRows === 0 ? 'not-allowed' : 'pointer' }}
            >
              <Printer size={14} /> Print
            </button>
            <button onClick={onClose} aria-label="Close" style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: '#64748b', padding: 4 }}>
              <X size={18} />
            </button>
          </div>
          <div style={{ padding: '8px 18px', fontSize: 12, color: '#64748b', borderBottom: '1px solid #f1f5f9' }}>
            {itemRows === 0
              ? 'No items in this category — nothing to print.'
              : `${sheets.length} sheet${sheets.length === 1 ? '' : 's'} · ${pages.length} page${pages.length === 1 ? '' : 's'} · ${itemRows} item${itemRows === 1 ? '' : 's'}. No prices or prior counts are printed.`}
            {hasOrphans && selected === ALL && ' Items not in any category get their own sheet at the end.'}
          </div>
          <div style={{ overflow: 'auto', padding: 18, background: '#f1f5f9', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16 }}>
            <div className="cs-preview" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              {itemRows > 0 && (
                <CountSheetPages {...sheetProps} />
              )}
            </div>
          </div>
        </div>
      </div>
      {createPortal(
        <div id="count-sheet-print-root"><CountSheetPages {...sheetProps} /></div>,
        document.body,
      )}
    </>
  )
}
