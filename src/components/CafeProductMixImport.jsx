// src/components/CafeProductMixImport.jsx
//
// INCREMENT 1 (shrinkage) — import the Cafe Product Mix export (the SOLD feed) into
// tenants/{orgId}/salesItems. Self-contained: own button + file dialog + MANDATORY
// preview + write. Nothing is written until the user confirms.
//
// Mirrors OfficialPnlImport discipline: parse (the tested parseCafeProductMix) →
// preview with per-café / per-period doc counts + conservation checksum + fail-loud
// on unmapped accounts + collision surfacing → writeSalesItems (idempotent). The
// preview IS the dry-run: identical numbers to the offline dry-run, no writes yet.
//
// Fiscal-safe: the parser reads weekday rows and maps each to its fiscal periodKey,
// so a month-boundary calendar week (e.g. the "June 28" column) splits across P06/P07.

import { useState, useMemo } from 'react'
import { createPortal } from 'react-dom'
import * as XLSX from 'xlsx'
import { X, Upload, CheckCircle, AlertTriangle } from 'lucide-react'
import { useAuthStore } from '@/store/authStore'
import { useToast } from '@/components/ui/Toast'
import { parseCafeProductMix, writeSalesItems } from '@/lib/parseCafeProductMix'
import { autoMapSoldItems } from '@/lib/itemMap'

const ACCEPTED = /\.(xlsx|xls|csv)$/i   // the export formats Tableau produces

export default function CafeProductMixImport({ onImported }) {
  const { user } = useAuthStore()
  const orgId = user?.tenantId
  const toast = useToast()

  const [busy, setBusy] = useState(false)
  const [writing, setWriting] = useState(false)
  const [preview, setPreview] = useState(null)   // { fileName, parsed }
  const [dragActive, setDragActive] = useState(false)

  // Shared parse path for both click-to-browse and drag-drop → parse → preview.
  async function processFile(file) {
    if (!file) return
    if (!ACCEPTED.test(file.name)) {
      toast.error(`"${file.name}" isn't a spreadsheet — drop a .xlsx, .xls, or .csv export.`)
      return
    }
    setBusy(true)
    try {
      const buf = await file.arrayBuffer()
      const wb = XLSX.read(buf, { type: 'array' })
      const ws = wb.Sheets[wb.SheetNames[0]]
      const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: null })
      const parsed = parseCafeProductMix(rows)   // fail-loud on wrong columns
      if (!parsed.items.length) throw new Error('No sold items parsed — is this the Cafe Product Mix export?')
      setPreview({ fileName: file.name, parsed })
    } catch (err) {
      toast.error(err.message || 'Could not parse the Cafe Product Mix file.')
    }
    setBusy(false)
  }

  function handleFile(e) {
    const file = e.target.files?.[0]
    e.target.value = ''
    processFile(file)
  }

  function handleDragOver(e) {
    e.preventDefault()
    if (!busy && !writing) setDragActive(true)
  }
  function handleDragLeave(e) {
    e.preventDefault()
    setDragActive(false)
  }
  function handleDrop(e) {
    e.preventDefault()
    setDragActive(false)
    if (busy || writing) return
    const file = e.dataTransfer?.files?.[0]
    processFile(file)
  }

  // Preview rollups — identical math to the offline dry-run.
  const summary = useMemo(() => {
    if (!preview) return null
    const { items, checksumTotal, weekdaySum, unmappedAccounts, collisions } = preview.parsed
    const byLoc = {}, byLocPeriod = {}
    let writtenQty = 0
    for (const r of items) {
      byLoc[r.locId] = (byLoc[r.locId] || 0) + 1
      const lp = `${r.locId} / ${r.periodKey}`
      byLocPeriod[lp] = (byLocPeriod[lp] || 0) + 1
      writtenQty += r.qtySold
    }
    const conserves = Math.abs(writtenQty - weekdaySum) < 1e-6 && Math.abs(weekdaySum - checksumTotal) < 1e-6
    return {
      docCount: items.length,
      byLoc: Object.entries(byLoc).sort((a, b) => b[1] - a[1]),
      byLocPeriod: Object.entries(byLocPeriod).sort(),
      periods: [...new Set(items.map((r) => r.periodKey))].sort(),
      checksumTotal, weekdaySum, writtenQty, conserves,
      unmappedAccounts, collisions,
    }
  }, [preview])

  const canConfirm = !!summary && summary.unmappedAccounts.length === 0 && summary.conserves && !writing

  function close() { setPreview(null) }

  async function handleConfirm() {
    if (!canConfirm) return
    setWriting(true)
    try {
      const { wrote, collisions } = await writeSalesItems(orgId, preview.parsed, {
        importedBy: user?.email || user?.name || 'unknown',
        sourceFile: preview.fileName,
      })
      // Auto-map the sold items (Increment 2): high-confidence names map silently; the
      // rest land in the volume-ranked unmapped list. Best-effort — a mapping hiccup
      // must not fail the sold import (the feed already landed above).
      let mapMsg = ''
      try {
        const soldNames = preview.parsed.items.map((r) => r.itemName)
        const { autoMapped, unmapped } = await autoMapSoldItems(orgId, soldNames, user?.email || 'unknown')
        mapMsg = ` · auto-mapped ${autoMapped}, ${unmapped} to review`
      } catch (mapErr) {
        console.warn('auto-map after sold import failed (feed still landed):', mapErr)
      }
      close()
      toast.success(`Sold feed imported — ${wrote} item·period doc(s)${collisions ? ` · ${collisions} slug merge(s) logged` : ''}${mapMsg}`)
      onImported?.()
    } catch (err) {
      console.error('salesItems write failed', err)
      toast.error(err.message || 'Write failed (see console)')
    }
    setWriting(false)
  }

  const S = STYLES
  return (
    <>
      <label
        style={{ ...S.dropZone, ...(dragActive ? S.dropZoneActive : {}) }}
        title="Import the Cafe Product Mix export (the SOLD feed → salesItems)"
        onDragOver={handleDragOver}
        onDragEnter={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <Upload size={16} color={dragActive ? '#0f766e' : '#64748b'} />
        <span style={S.dropText}>
          {busy ? 'Reading…' : dragActive ? 'Drop to import' : 'Import Sales'}
        </span>
        <span style={S.dropHint}>{dragActive ? '' : 'drag a .xlsx / .csv here, or click to browse'}</span>
        <input type="file" accept=".csv,.xlsx,.xls" style={{ display: 'none' }} onChange={handleFile} disabled={busy || writing} />
      </label>

      {preview && summary && createPortal(
        <div style={S.overlay} onClick={() => !writing && close()}>
          <div style={S.modal} onClick={(e) => e.stopPropagation()}>
            <div style={S.head}>
              <div>
                <div style={S.title}>Product Mix import — review before writing</div>
                <div style={S.sub}>{preview.fileName} · weeks: {preview.parsed.weekLabels.join(', ')}</div>
              </div>
              <button style={S.x} onClick={() => !writing && close()}><X size={18} /></button>
            </div>

            <div style={S.body}>
              {/* headline */}
              <div style={S.chips}>
                <span style={{ ...S.chip, ...S.chipGreen }}>{summary.docCount} salesItems docs</span>
                <span style={{ ...S.chip, ...S.chipBlue }}>{summary.periods.length} fiscal periods</span>
                <span style={{ ...S.chip, ...(summary.conserves ? S.chipGreen : S.chipRed) }}>
                  {summary.conserves ? '✓ units conserved' : '✗ conservation FAILED'} · {summary.writtenQty} sold
                </span>
              </div>

              {/* fail-loud: unmapped accounts block the write */}
              {summary.unmappedAccounts.length > 0 && (
                <div style={S.warnBlock}>
                  <div style={S.warnHead}><AlertTriangle size={14} color="#dc2626" /> {summary.unmappedAccounts.length} POS account(s) not in ACCOUNT_TO_CAFE — <b>import blocked</b> (add the mapping first)</div>
                  {summary.unmappedAccounts.map((u, i) => <div key={i} style={S.warnLine}>"{u.account}" · {u.qty} units unrouted</div>)}
                </div>
              )}

              {/* conservation detail */}
              {!summary.conserves && (
                <div style={S.warnBlock}>
                  <div style={S.warnHead}><AlertTriangle size={14} color="#dc2626" /> Unit conservation failed — Total {summary.checksumTotal} · weekday {summary.weekdaySum} · written {summary.writtenQty}</div>
                </div>
              )}

              {/* collisions — accepted merge, surfaced */}
              {summary.collisions.length > 0 && (
                <div style={S.unmapBlock}>
                  <div style={S.unmapHead}><AlertTriangle size={13} color="#d97706" /> {summary.collisions.length} slug collision(s) — distinct names merged (qty summed). Verify none are truly different products:</div>
                  <div style={S.unmapList}>
                    {summary.collisions.map((c, i) => <span key={i} style={S.unmapChip}>{c.names.join('  ||  ')}</span>)}
                  </div>
                </div>
              )}

              {/* per-café doc counts */}
              <div style={S.sectionLbl}>Docs per café (keys the counts use)</div>
              <div style={S.chips}>
                {summary.byLoc.map(([locId, n]) => <span key={locId} style={{ ...S.chip, ...S.chipSlate }}>{locId}: {n}</span>)}
              </div>

              {/* per-café / period table */}
              <div style={S.sectionLbl}>Docs per café / fiscal period</div>
              <table style={S.table}>
                <thead><tr><th style={S.th}>Café / period</th><th style={S.thR}>docs</th></tr></thead>
                <tbody>
                  {summary.byLocPeriod.map(([lp, n]) => (
                    <tr key={lp}><td style={S.td}>{lp}</td><td style={S.tdR}>{n}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div style={S.foot}>
              {!summary.conserves && <span style={S.footWarn}>Conservation failed — cannot write.</span>}
              {summary.unmappedAccounts.length > 0 && <span style={S.footWarn}>Unmapped accounts — cannot write.</span>}
              <span style={{ flex: 1 }} />
              <button style={S.cancel} onClick={() => close()} disabled={writing}>Cancel</button>
              <button style={{ ...S.confirm, opacity: canConfirm ? 1 : 0.5 }} onClick={handleConfirm} disabled={!canConfirm}>
                {writing ? 'Writing…' : `Write ${summary.docCount} doc(s)`}
              </button>
            </div>
          </div>
        </div>, document.body)}
    </>
  )
}

const STYLES = {
  btn: { display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 14px', fontSize: 12, fontWeight: 600, background: '#fff', color: '#0f172a', border: '1px solid #cbd5e1', borderRadius: 8, cursor: 'pointer' },
  dropZone: { display: 'inline-flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 4, padding: '14px 22px', minWidth: 260, fontSize: 13, fontWeight: 700, color: '#0f172a', background: '#f8fafc', border: '2px dashed #cbd5e1', borderRadius: 12, cursor: 'pointer', transition: 'border-color .15s, background .15s' },
  dropZoneActive: { borderColor: '#0f766e', background: '#f0fdfa' },
  dropText: { fontSize: 13, fontWeight: 700 },
  dropHint: { fontSize: 11, fontWeight: 500, color: '#94a3b8' },
  overlay: { position: 'fixed', inset: 0, background: 'rgba(15,23,42,.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 10000, padding: 20 },
  modal: { background: '#fff', borderRadius: 14, width: 'min(760px,97vw)', maxHeight: '92vh', display: 'flex', flexDirection: 'column', boxShadow: '0 20px 60px rgba(0,0,0,.3)' },
  head: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', padding: '16px 20px', borderBottom: '1px solid #e2e8f0' },
  title: { fontSize: 16, fontWeight: 800, color: '#0f172a' }, sub: { fontSize: 12, color: '#64748b', marginTop: 2 },
  x: { background: 'none', border: 'none', cursor: 'pointer', color: '#64748b' },
  body: { padding: '10px 20px 14px', overflow: 'auto' },
  sectionLbl: { fontSize: 12, fontWeight: 700, color: '#475569', margin: '14px 0 6px' },
  chips: { display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 4 },
  chip: { fontSize: 11, fontWeight: 600, padding: '3px 8px', borderRadius: 999 },
  chipGreen: { background: '#dcfce7', color: '#166534' }, chipRed: { background: '#fee2e2', color: '#991b1b' },
  chipBlue: { background: '#dbeafe', color: '#1e40af' }, chipSlate: { background: '#f1f5f9', color: '#334155' },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: 12 },
  th: { textAlign: 'left', padding: '4px 6px', color: '#94a3b8', fontWeight: 600, borderBottom: '1px solid #e2e8f0' },
  thR: { textAlign: 'right', padding: '4px 6px', color: '#94a3b8', fontWeight: 600, borderBottom: '1px solid #e2e8f0' },
  td: { padding: '4px 6px', color: '#334155', borderBottom: '1px solid #f1f5f9' },
  tdR: { padding: '4px 6px', textAlign: 'right', color: '#0f172a', fontVariantNumeric: 'tabular-nums', borderBottom: '1px solid #f1f5f9' },
  unmapBlock: { marginTop: 10, background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 8, padding: '8px 10px' },
  unmapHead: { fontSize: 12, color: '#92400e', marginBottom: 6 },
  unmapList: { display: 'flex', flexWrap: 'wrap', gap: 6 },
  unmapChip: { fontSize: 11, color: '#78350f', background: '#fef3c7', border: '1px solid #fde68a', borderRadius: 6, padding: '2px 7px' },
  warnBlock: { marginTop: 12, background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, padding: '8px 10px' },
  warnHead: { fontSize: 12, color: '#991b1b', display: 'flex', alignItems: 'center', gap: 6 },
  warnLine: { fontSize: 12, color: '#b91c1c', marginTop: 3, paddingLeft: 20 },
  foot: { display: 'flex', alignItems: 'center', gap: 10, padding: '14px 20px', borderTop: '1px solid #e2e8f0' },
  footWarn: { fontSize: 12, color: '#d97706', fontWeight: 600 },
  cancel: { padding: '8px 16px', borderRadius: 8, border: '1px solid #cbd5e1', background: '#fff', color: '#475569', fontWeight: 600, cursor: 'pointer' },
  confirm: { padding: '8px 16px', borderRadius: 8, border: 'none', background: '#0f766e', color: '#fff', fontWeight: 700, cursor: 'pointer' },
}
