// src/components/OfficialPnlImport.jsx
//
// PHASE 1 · GATE 3 — import the NetSuite Enterprise P&L export (the official books,
// monthly) into officialPnl docs. Self-contained: own button + file dialog +
// MANDATORY preview + write. Nothing is written until the user confirms.
//
// Mirrors the Café Labor import discipline: parse (the tested parseOfficialPnl,
// commit f9e1b3f) → enrich the preview with site matching + overwrite reads →
// show matched / unmapped / month / multi-site / overwrite → writeOfficialPnl per
// site. Fail-loud parser rejections (wrong columns, nothing matched) surface as a
// toast, never swallowed.
//
// Semantic: a re-imported month REPLACES the stored official P&L for that
// (location, month) — the books for a closed month are corrected truth, not a
// merge. writeOfficialPnl overwrites lines[]/unmappedLines[] wholesale.

import { useState, useEffect, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { X, Upload, CheckCircle, AlertTriangle } from 'lucide-react'
import { useAuthStore } from '@/store/authStore'
import { useLocations, cleanLocName } from '@/store/LocationContext'
import { usePeriod } from '@/store/PeriodContext'
import { useToast } from '@/components/ui/Toast'
import { db } from '@/lib/firebase'
import { doc, getDoc } from 'firebase/firestore'
import { locId } from '@/lib/pnl'
import { parseOfficialPnl, writeOfficialPnl } from '@/lib/parseOfficialPnl'
import { buildSiteMatcher } from '@/lib/siteMatch'

const fmt$ = (v) => '$' + (Number(v) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const MONTH_NAMES = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const labelMonth = (mk) => { const m = String(mk).match(/(\d{4})-P(\d{2})/); return m ? `${mk} (${MONTH_NAMES[+m[2]] || '?'} ${m[1]})` : mk }

// 18 fiscal months back from the current period, for the month picker.
function monthOptions(periodKey) {
  const m = String(periodKey).match(/(\d{4})-P(\d{2})/)
  let y = m ? +m[1] : new Date().getUTCFullYear(), p = m ? +m[2] : 1
  const out = []
  for (let i = 0; i < 18; i++) { out.push(`${y}-P${String(p).padStart(2, '0')}`); if (--p < 1) { p = 12; y-- } }
  return out
}

export default function OfficialPnlImport({ onImported }) {
  const { user } = useAuthStore()
  const orgId = user?.tenantId
  const { locationsByName, selectedLocation } = useLocations()
  const { periodKey } = usePeriod()
  const toast = useToast()

  const [busy, setBusy] = useState(false)
  const [preview, setPreview] = useState(null)     // { fileName, hasSite, sites[] }
  const [monthKey, setMonthKey] = useState('')     // chosen target month (init from detected)
  const [overwrites, setOverwrites] = useState({}) // locId -> bool (doc already exists this month)
  const [writing, setWriting] = useState(false)

  const months = useMemo(() => monthOptions(periodKey), [periodKey])

  async function handleFile(e) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setBusy(true)
    try {
      const parsed = await parseOfficialPnl(file)          // fail-loud on wrong columns / zero-match
      const enriched = buildPreview(parsed)
      setPreview(enriched)
      setMonthKey(parsed.detectedMonthKey || '')           // may be null → user must pick
    } catch (err) {
      toast.error(err.message || 'Could not parse the Official P&L file.')  // surface the parser's named rejection
    }
    setBusy(false)
  }

  // Site-match every parsed site to an Aurelia location. A single-location export
  // (no Site column) targets the currently selected location.
  function buildPreview(parsed) {
    const matcher = buildSiteMatcher(Object.keys(locationsByName), cleanLocName)
    const sel = selectedLocation && selectedLocation !== 'all' ? selectedLocation : null
    const sites = parsed.sites.map(s => {
      let appName, matchStatus
      if (parsed.hasSite) { const m = matcher(s.siteRaw); appName = m.appName; matchStatus = m.status }
      else { appName = sel; matchStatus = sel ? 'selected' : 'unmatched' }
      return {
        siteRaw: s.siteRaw, appName, matchStatus,
        matched: s.matched, unmapped: s.unmapped,
        matchedTotal: s.matched.reduce((a, m) => a + (Number(m.actual) || 0), 0),
      }
    })
    return {
      fileName: parsed.summary.fileName, sheetName: parsed.sheetName, hasSite: parsed.hasSite,
      detectedMonthKey: parsed.detectedMonthKey, sites,
    }
  }

  // Overwrite check — reactive to the chosen month. Reads the existing officialPnl
  // doc per matched site so the preview can warn before replacing the books.
  useEffect(() => {
    if (!preview || !monthKey) { setOverwrites({}); return }
    let cancelled = false
    ;(async () => {
      const targets = preview.sites.filter(s => s.appName)
      const entries = await Promise.all(targets.map(async s => {
        const lid = locId(s.appName)
        const snap = await getDoc(doc(db, 'tenants', orgId, 'officialPnl', lid, 'periods', monthKey))
        return [lid, snap.exists()]
      }))
      if (!cancelled) setOverwrites(Object.fromEntries(entries))
    })()
    return () => { cancelled = true }
  }, [preview, monthKey, orgId])

  const writableSites = preview?.sites.filter(s => s.appName) || []
  const unmatchedSites = preview?.sites.filter(s => !s.appName) || []
  const canConfirm = !!monthKey && writableSites.length > 0 && !writing

  function close() { setPreview(null); setMonthKey(''); setOverwrites({}) }

  async function handleConfirm() {
    if (!canConfirm) return
    setWriting(true)
    let wrote = 0, failed = 0
    for (const s of writableSites) {
      try {
        await writeOfficialPnl(locId(s.appName), monthKey, {
          location: s.appName, matched: s.matched, unmapped: s.unmapped,
          importedBy: user?.email || user?.name || 'unknown', sourceFile: preview.fileName,
        }, orgId)
        wrote++
      } catch (err) { failed++; console.error('officialPnl write failed', s.appName, monthKey, err) }
    }
    setWriting(false)
    close()
    if (failed) toast.error(`Imported ${wrote} · ${failed} failed (see console)`)
    else toast.success(`Official P&L imported — ${wrote} location(s) for ${monthKey}${unmatchedSites.length ? ` · ${unmatchedSites.length} unmatched site(s) skipped` : ''}`)
    if (wrote > 0) onImported?.()   // let a host (e.g. the reconciliation view) reload
  }

  const S = STYLES
  return (
    <>
      <label style={S.btn} title="Import the NetSuite Enterprise P&L export (the official books, monthly)">
        <Upload size={14} /> {busy ? 'Reading…' : 'Import Official P&L'}
        <input type="file" accept=".csv,.xlsx,.xls" style={{ display: 'none' }} onChange={handleFile} disabled={busy || writing} />
      </label>

      {preview && createPortal(
        <div style={S.overlay} onClick={() => !writing && close()}>
          <div style={S.modal} onClick={e => e.stopPropagation()}>
            <div style={S.head}>
              <div>
                <div style={S.title}>Official P&amp;L import — review before posting</div>
                <div style={S.sub}>{preview.fileName} · sheet "{preview.sheetName}"</div>
              </div>
              <button style={S.x} onClick={() => !writing && close()}><X size={18} /></button>
            </div>

            {/* month — detected or required */}
            <div style={S.monthRow}>
              <span style={S.monthLbl}>Posting month</span>
              <select style={S.select} value={monthKey} onChange={e => setMonthKey(e.target.value)}>
                <option value="">— pick a month —</option>
                {months.map(mk => <option key={mk} value={mk}>{labelMonth(mk)}</option>)}
              </select>
              {preview.detectedMonthKey
                ? <span style={S.detected}>detected from file: {preview.detectedMonthKey}</span>
                : <span style={S.detectedWarn}><AlertTriangle size={12} style={{ verticalAlign: 'middle' }} /> not detectable from the file — pick the month</span>}
            </div>

            <div style={S.body}>
              {unmatchedSites.length > 0 && (
                <div style={S.warnBlock}>
                  <div style={S.warnHead}><AlertTriangle size={14} color="#dc2626" /> {unmatchedSites.length} site(s) don't match an Aurelia location — <b>will NOT import</b></div>
                  {unmatchedSites.map((s, i) => <div key={i} style={S.warnLine}>no location matches "{s.siteRaw || '(single, no location selected)'}"</div>)}
                </div>
              )}

              {writableSites.map((s, i) => {
                const lid = locId(s.appName)
                const willOverwrite = overwrites[lid]
                return (
                  <div key={i} style={S.siteBlock}>
                    <div style={S.siteHead}>
                      <CheckCircle size={14} color="#16a34a" />
                      <b>{cleanLocName(s.appName)}</b>
                      {s.siteRaw && s.siteRaw !== s.appName && <span style={S.matchTag}>matched "{s.siteRaw}" ({s.matchStatus})</span>}
                      {!preview.hasSite && <span style={S.matchTag}>single-location export → selected location</span>}
                      <span style={{ flex: 1 }} />
                      {monthKey && (willOverwrite
                        ? <span style={{ ...S.chip, ...S.chipAmber }}>replaces existing {monthKey}</span>
                        : <span style={{ ...S.chip, ...S.chipGreen }}>new {monthKey}</span>)}
                    </div>

                    {/* summary chips */}
                    <div style={S.chips}>
                      <span style={{ ...S.chip, ...S.chipGreen }}>{s.matched.length} lines mapped · {fmt$(s.matchedTotal)}</span>
                      {s.unmapped.length > 0 && <span style={{ ...S.chip, ...S.chipRed }}>{s.unmapped.length} unmapped</span>}
                    </div>

                    {/* matched lines: officialLine → Actual $ */}
                    <table style={S.table}>
                      <thead><tr><th style={S.th}>Official line</th><th style={S.th}>NetSuite</th><th style={S.thR}>Actual $</th></tr></thead>
                      <tbody>
                        {s.matched.map((m, j) => (
                          <tr key={j}>
                            <td style={S.td}>{m.officialLine}</td>
                            <td style={S.tdMuted}>{m.netsuiteAccount || m.line}</td>
                            <td style={S.tdR}>{fmt$(m.actual)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>

                    {/* unmapped — surfaced prominently, never dropped */}
                    {s.unmapped.length > 0 && (
                      <div style={S.unmapBlock}>
                        <div style={S.unmapHead}>
                          <AlertTriangle size={13} color="#d97706" /> {s.unmapped.length} line(s) from the export couldn't be mapped — <b>these won't reconcile</b>:
                        </div>
                        <div style={S.unmapList}>
                          {s.unmapped.map((u, j) => (
                            <span key={j} style={S.unmapChip}>{u.line || u.netsuiteAccount || '(blank)'} · {fmt$(u.actual)}</span>
                          ))}
                        </div>
                        <div style={S.unmapNote}>They're stored on the doc (unmappedLines[]) so nothing is lost — but Aurelia has no running line to diff them against.</div>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>

            <div style={S.foot}>
              {!monthKey && <span style={S.footWarn}>Pick a posting month to enable import.</span>}
              <span style={{ flex: 1 }} />
              <button style={S.cancel} onClick={() => close()} disabled={writing}>Cancel</button>
              <button style={{ ...S.confirm, opacity: canConfirm ? 1 : 0.5 }} onClick={handleConfirm} disabled={!canConfirm}>
                {writing ? 'Posting…' : `Post ${writableSites.length} location(s) → ${monthKey || '…'}`}
              </button>
            </div>
          </div>
        </div>, document.body)}
    </>
  )
}

const STYLES = {
  btn: { display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 14px', fontSize: 12, fontWeight: 600, background: '#fff', color: '#0f172a', border: '1px solid #cbd5e1', borderRadius: 8, cursor: 'pointer' },
  overlay: { position: 'fixed', inset: 0, background: 'rgba(15,23,42,.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 10000, padding: 20 },
  modal: { background: '#fff', borderRadius: 14, width: 'min(760px,97vw)', maxHeight: '92vh', display: 'flex', flexDirection: 'column', boxShadow: '0 20px 60px rgba(0,0,0,.3)' },
  head: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', padding: '16px 20px', borderBottom: '1px solid #e2e8f0' },
  title: { fontSize: 16, fontWeight: 800, color: '#0f172a' }, sub: { fontSize: 12, color: '#64748b', marginTop: 2 },
  x: { background: 'none', border: 'none', cursor: 'pointer', color: '#64748b' },
  monthRow: { display: 'flex', alignItems: 'center', gap: 10, padding: '10px 20px', borderBottom: '1px solid #f1f5f9', background: '#f8fafc' },
  monthLbl: { fontSize: 12, fontWeight: 700, color: '#475569' },
  select: { padding: '6px 10px', borderRadius: 8, border: '1px solid #cbd5e1', fontSize: 13 },
  detected: { fontSize: 11, color: '#16a34a' },
  detectedWarn: { fontSize: 11, color: '#d97706', fontWeight: 600 },
  body: { padding: '4px 20px 14px', overflow: 'auto' },
  siteBlock: { border: '1px solid #e2e8f0', borderRadius: 10, padding: '10px 12px', margin: '12px 0' },
  siteHead: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 14, color: '#0f172a', marginBottom: 8 },
  matchTag: { fontSize: 11, color: '#64748b', background: '#f1f5f9', padding: '2px 6px', borderRadius: 6 },
  chips: { display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 },
  chip: { fontSize: 11, fontWeight: 600, padding: '3px 8px', borderRadius: 999 },
  chipGreen: { background: '#dcfce7', color: '#166534' }, chipAmber: { background: '#fef3c7', color: '#92400e' }, chipRed: { background: '#fee2e2', color: '#991b1b' },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: 12 },
  th: { textAlign: 'left', padding: '4px 6px', color: '#94a3b8', fontWeight: 600, borderBottom: '1px solid #e2e8f0' },
  thR: { textAlign: 'right', padding: '4px 6px', color: '#94a3b8', fontWeight: 600, borderBottom: '1px solid #e2e8f0' },
  td: { padding: '4px 6px', color: '#334155', borderBottom: '1px solid #f1f5f9' },
  tdMuted: { padding: '4px 6px', color: '#94a3b8', borderBottom: '1px solid #f1f5f9' },
  tdR: { padding: '4px 6px', textAlign: 'right', color: '#0f172a', fontVariantNumeric: 'tabular-nums', borderBottom: '1px solid #f1f5f9' },
  unmapBlock: { marginTop: 10, background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 8, padding: '8px 10px' },
  unmapHead: { fontSize: 12, color: '#92400e', marginBottom: 6 },
  unmapList: { display: 'flex', flexWrap: 'wrap', gap: 6 },
  unmapChip: { fontSize: 11, color: '#78350f', background: '#fef3c7', border: '1px solid #fde68a', borderRadius: 6, padding: '2px 7px' },
  unmapNote: { fontSize: 11, color: '#a16207', marginTop: 6 },
  warnBlock: { marginTop: 12, background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, padding: '8px 10px' },
  warnHead: { fontSize: 12, color: '#991b1b', display: 'flex', alignItems: 'center', gap: 6 },
  warnLine: { fontSize: 12, color: '#b91c1c', marginTop: 3, paddingLeft: 20 },
  foot: { display: 'flex', alignItems: 'center', gap: 10, padding: '14px 20px', borderTop: '1px solid #e2e8f0' },
  footWarn: { fontSize: 12, color: '#d97706', fontWeight: 600 },
  cancel: { padding: '8px 16px', borderRadius: 8, border: '1px solid #cbd5e1', background: '#fff', color: '#475569', fontWeight: 600, cursor: 'pointer' },
  confirm: { padding: '8px 16px', borderRadius: 8, border: 'none', background: '#0f766e', color: '#fff', fontWeight: 700, cursor: 'pointer' },
}
