// src/components/CafeLaborImport.jsx
//
// PHASE 2.3a · GATE 3 — self-contained Café Labor import flow (BudgetImport-style).
// NOT bound to the Labor tab's selected location/period: it derives (location,
// period) per row from Site Name + Week of Event. Button → parseCafeLabor →
// mandatory preview (matched/unmatched/overwrite/locked/skipped/unresolved) →
// confirm → writeCafeLaborPnL fan-out. Nothing writes until the manager confirms.

import { useState } from 'react'
import { createPortal } from 'react-dom'
import { Upload, X, CheckCircle, AlertTriangle, Lock, ArrowRight } from 'lucide-react'
import { useLocations, cleanLocName } from '@/store/LocationContext'
import { useAuthStore } from '@/store/authStore'
import { useToast } from '@/components/ui/Toast'
import { db } from '@/lib/firebase'
import { doc, getDoc } from 'firebase/firestore'
import { locId } from '@/lib/pnl'
import { parseCafeLabor, writeCafeLaborPnL } from '@/lib/parseCafeLabor'
import { buildSiteMatcher } from '@/lib/siteMatch'

const fmt$ = (v) => (v == null || isNaN(v)) ? '—' : '$' + Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

export default function CafeLaborImport() {
  const { locationsByName } = useLocations()
  const { user } = useAuthStore()
  const orgId = user?.tenantId
  const toast = useToast()

  const [busy, setBusy] = useState(false)
  const [preview, setPreview] = useState(null)   // enriched preview (see buildPreview)
  const [writing, setWriting] = useState(false)

  async function handleFile(e) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setBusy(true)
    try {
      const parsed = await parseCafeLabor(file)
      const enriched = await buildPreview(parsed, file.name)
      setPreview(enriched)
    } catch (err) {
      toast.error(err.message || 'Could not parse the Café Labor file.')
    }
    setBusy(false)
  }

  // Enrich the raw parse with site matching + per-(loc,period) overwrite/lock/close
  // reads. Everything the manager needs to see BEFORE any write.
  async function buildPreview(parsed, fileName) {
    const matcher = buildSiteMatcher(Object.keys(locationsByName), cleanLocName)
    const matched = [], unmatched = [], unparseable = []
    for (const site of parsed.sites) {
      site.unparseable.forEach(w => unparseable.push({ siteRaw: site.siteRaw, weekOf: w.weekOf }))
      const m = matcher(site.siteRaw)
      if (!m.appName) { unmatched.push(site.siteRaw); continue }
      const lid = locId(m.appName)
      const rows = []
      for (const w of site.weeks) {
        const [pnlSnap, lockSnap] = await Promise.all([
          getDoc(doc(db, 'tenants', orgId, 'pnl', lid, 'periods', w.periodKey)),
          getDoc(doc(db, 'tenants', orgId, 'periodLocks', `${lid}__${w.periodKey}`)),
        ])
        const pdata = pnlSnap.exists() ? pnlSnap.data() : {}
        const currentDollars = pdata.cogs_onsite_labor_hourly
        const locked = lockSnap.exists() && lockSnap.data().locked === true
        const closed = pdata.periodStatus === 'closed' || pdata.periodStatus === 'approved'
        rows.push({
          periodKey: w.periodKey, weekOf: w.weekOf, newDollars: w.hourlyLaborDollars, eff: w.eff,
          currentDollars, exists: currentDollars !== undefined, locked, closed,
          writable: !locked && !closed,
        })
      }
      rows.sort((a, b) => a.periodKey.localeCompare(b.periodKey))
      matched.push({ siteRaw: site.siteRaw, appName: m.appName, matchStatus: m.status, rows })
    }
    const allRows = matched.flatMap(s => s.rows)
    return {
      fileName, periods: parsed.periods, skippedTotals: parsed.summary.skippedTotals,
      matched, unmatched, unparseable,
      writableCount: allRows.filter(r => r.writable).length,
      overwriteCount: allRows.filter(r => r.writable && r.exists).length,
      blockedCount: allRows.filter(r => !r.writable).length,
    }
  }

  async function handleConfirm() {
    if (!preview) return
    setWriting(true)
    let wrote = 0, skipped = 0, failed = 0
    for (const site of preview.matched) {
      for (const r of site.rows) {
        if (!r.writable) { skipped++; continue }
        try {
          await writeCafeLaborPnL(site.appName, r.periodKey, {
            hourlyLaborDollars: r.newDollars, eff: r.eff,
            sourceFile: preview.fileName, importedBy: user?.email || user?.name || 'unknown',
          })
          wrote++
        } catch (err) { failed++; console.error('Café labor write failed', site.appName, r.periodKey, err) }
      }
    }
    setWriting(false)
    setPreview(null)
    if (failed) toast.error(`Imported ${wrote} · ${skipped} locked/closed skipped · ${failed} failed (see console)`)
    else toast.success(`Café Labor imported — ${wrote} (site, week) posted to hourly labor${skipped ? ` · ${skipped} locked/closed skipped` : ''}`)
  }

  const S = STYLES
  return (
    <>
      <label style={S.btn} title="Import the Café Labor Efficiency 'Summary by Site' export">
        <Upload size={14} /> {busy ? 'Reading…' : 'Import Café Labor'}
        <input type="file" accept=".csv,.xlsx,.xls" style={{ display: 'none' }} onChange={handleFile} disabled={busy || writing} />
      </label>

      {preview && createPortal(
        <div style={S.overlay} onClick={() => !writing && setPreview(null)}>
          <div style={S.modal} onClick={e => e.stopPropagation()}>
            <div style={S.head}>
              <div>
                <div style={S.title}>Café Labor import — review before posting</div>
                <div style={S.sub}>{preview.fileName} · periods: {preview.periods.join(', ') || '—'}</div>
              </div>
              <button style={S.x} onClick={() => !writing && setPreview(null)}><X size={18} /></button>
            </div>

            {/* summary chips */}
            <div style={S.chips}>
              <span style={{ ...S.chip, ...S.chipGreen }}>{preview.writableCount} will post</span>
              {preview.overwriteCount > 0 && <span style={{ ...S.chip, ...S.chipAmber }}>{preview.overwriteCount} overwrite</span>}
              {preview.blockedCount > 0 && <span style={{ ...S.chip, ...S.chipRed }}>{preview.blockedCount} locked/closed</span>}
              {preview.unmatched.length > 0 && <span style={{ ...S.chip, ...S.chipRed }}>{preview.unmatched.length} unmatched site(s)</span>}
              {preview.skippedTotals > 0 && <span style={{ ...S.chip, ...S.chipGray }}>Grand Total row skipped</span>}
              {preview.unparseable.length > 0 && <span style={{ ...S.chip, ...S.chipAmber }}>{preview.unparseable.length} unresolved week(s)</span>}
            </div>

            <div style={S.body}>
              {/* matched sites */}
              {preview.matched.map(site => (
                <div key={site.siteRaw} style={S.siteBlock}>
                  <div style={S.siteHead}>
                    <CheckCircle size={14} color="#16a34a" />
                    <b>{cleanLocName(site.appName)}</b>
                    <span style={S.matchTag}>{site.siteRaw !== site.appName ? `matched "${site.siteRaw}" (${site.matchStatus})` : 'exact'}</span>
                  </div>
                  <table style={S.table}>
                    <thead><tr>
                      <th style={S.th}>Period</th><th style={S.th}>Week of</th>
                      <th style={S.thR}>Actual Labor $ → hourly</th><th style={S.thR}>Current</th><th style={S.th}>Status</th>
                    </tr></thead>
                    <tbody>
                      {site.rows.map(r => (
                        <tr key={r.periodKey} style={!r.writable ? S.rowBlocked : undefined}>
                          <td style={S.td}>{r.periodKey}</td>
                          <td style={S.td}>{r.weekOf}</td>
                          <td style={S.tdR}><b>{fmt$(r.newDollars)}</b></td>
                          <td style={S.tdR}>
                            {r.exists
                              ? <span style={S.overwrite}>{fmt$(r.currentDollars)} <ArrowRight size={11} style={{ verticalAlign: 'middle' }} /> {fmt$(r.newDollars)}</span>
                              : <span style={S.muted}>new</span>}
                          </td>
                          <td style={S.td}>
                            {!r.writable
                              ? <span style={S.blocked}><Lock size={11} style={{ verticalAlign: 'middle' }} /> {r.closed ? 'closed' : 'locked'} — won't write</span>
                              : r.exists ? <span style={S.amberTxt}>replace</span> : <span style={S.greenTxt}>post</span>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ))}

              {/* unmatched sites */}
              {preview.unmatched.length > 0 && (
                <div style={S.warnBlock}>
                  <div style={S.warnHead}><AlertTriangle size={14} color="#dc2626" /> Unmatched sites — <b>will NOT import</b></div>
                  {preview.unmatched.map(s => <div key={s} style={S.warnLine}>no Aurelia location matches “{s}”</div>)}
                </div>
              )}

              {/* unresolved weeks */}
              {preview.unparseable.length > 0 && (
                <div style={S.warnBlock}>
                  <div style={S.warnHead}><AlertTriangle size={14} color="#d97706" /> Unresolved Week-of-Event dates — surfaced, not dropped</div>
                  {preview.unparseable.map((u, i) => <div key={i} style={S.warnLine}>{u.siteRaw}: “{u.weekOf}” didn’t resolve to a period</div>)}
                </div>
              )}
            </div>

            <div style={S.foot}>
              <button style={S.cancel} onClick={() => setPreview(null)} disabled={writing}>Cancel</button>
              <button style={{ ...S.confirm, opacity: (preview.writableCount === 0 || writing) ? 0.5 : 1 }}
                      onClick={handleConfirm} disabled={preview.writableCount === 0 || writing}>
                {writing ? 'Posting…' : `Post ${preview.writableCount} (site, week) to hourly labor`}
              </button>
            </div>
          </div>
        </div>, document.body)}
    </>
  )
}

const STYLES = {
  btn: { display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer', background: '#16a34a', color: '#fff', padding: '7px 12px', borderRadius: 8, fontSize: 13, fontWeight: 600 },
  overlay: { position: 'fixed', inset: 0, background: 'rgba(15,23,42,.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: 20 },
  modal: { background: '#fff', borderRadius: 12, width: 'min(820px, 96vw)', maxHeight: '88vh', display: 'flex', flexDirection: 'column', boxShadow: '0 20px 60px rgba(0,0,0,.3)' },
  head: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', padding: '16px 20px', borderBottom: '1px solid #e2e8f0' },
  title: { fontSize: 16, fontWeight: 800, color: '#0f172a' },
  sub: { fontSize: 12, color: '#64748b', marginTop: 2 },
  x: { background: 'none', border: 'none', cursor: 'pointer', color: '#64748b' },
  chips: { display: 'flex', flexWrap: 'wrap', gap: 8, padding: '12px 20px', borderBottom: '1px solid #f1f5f9' },
  chip: { fontSize: 12, fontWeight: 600, padding: '3px 10px', borderRadius: 999 },
  chipGreen: { background: '#dcfce7', color: '#166534' }, chipAmber: { background: '#fef3c7', color: '#92400e' },
  chipRed: { background: '#fee2e2', color: '#991b1b' }, chipGray: { background: '#f1f5f9', color: '#475569' },
  body: { overflow: 'auto', padding: '8px 20px', flex: 1 },
  siteBlock: { marginBottom: 18 },
  siteHead: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 14, color: '#0f172a', margin: '10px 0 6px' },
  matchTag: { fontSize: 11, color: '#64748b', fontWeight: 500 },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: 13 },
  th: { textAlign: 'left', padding: '6px 8px', color: '#64748b', fontWeight: 600, borderBottom: '1px solid #e2e8f0', fontSize: 11, textTransform: 'uppercase', letterSpacing: .3 },
  thR: { textAlign: 'right', padding: '6px 8px', color: '#64748b', fontWeight: 600, borderBottom: '1px solid #e2e8f0', fontSize: 11, textTransform: 'uppercase', letterSpacing: .3 },
  td: { padding: '6px 8px', borderBottom: '1px solid #f1f5f9', color: '#0f172a' },
  tdR: { padding: '6px 8px', borderBottom: '1px solid #f1f5f9', color: '#0f172a', textAlign: 'right' },
  rowBlocked: { background: '#fef2f2', opacity: .75 },
  overwrite: { color: '#92400e', fontWeight: 600 }, muted: { color: '#94a3b8' },
  amberTxt: { color: '#b45309', fontWeight: 600, fontSize: 12 }, greenTxt: { color: '#16a34a', fontWeight: 600, fontSize: 12 },
  blocked: { color: '#b91c1c', fontWeight: 600, fontSize: 12 },
  warnBlock: { background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 8, padding: '10px 12px', margin: '10px 0' },
  warnHead: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, fontWeight: 700, color: '#0f172a', marginBottom: 4 },
  warnLine: { fontSize: 12, color: '#78350f', paddingLeft: 20 },
  foot: { display: 'flex', justifyContent: 'flex-end', gap: 10, padding: '14px 20px', borderTop: '1px solid #e2e8f0' },
  cancel: { padding: '8px 16px', borderRadius: 8, border: '1px solid #cbd5e1', background: '#fff', color: '#475569', fontWeight: 600, cursor: 'pointer' },
  confirm: { padding: '8px 16px', borderRadius: 8, border: 'none', background: '#16a34a', color: '#fff', fontWeight: 700, cursor: 'pointer' },
}
