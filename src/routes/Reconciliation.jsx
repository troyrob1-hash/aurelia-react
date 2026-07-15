// src/routes/Reconciliation.jsx
//
// PHASE 1 · GATE 4 — the reconciliation loop. For a location + month, diff the
// OFFICIAL books (NetSuite Enterprise P&L, imported) against Aurelia's RUNNING
// P&L (weekly docs + read-time ledger contributions, rolled up to official-line
// grain via computeRunningMonth). Each RECON_MAP line renders by status:
//   MAPPED   — Aurelia has a running writer → show the variance (flag if material).
//   COMING   — field exists but no running writer yet → show Official, Running
//              is expected-low (not a real discrepancy).
//   EXTERNAL — structurally NetSuite-only → Official only, no Running.
// Official's own per-line Budget (from the export) is the Budget column. Unmapped
// official lines surface in a footer (never hidden). A partial month (fewer weeks
// found than the month has) is flagged so a low Running isn't misread as a gap.

import { useState, useEffect, useMemo } from 'react'
import { useLocations, cleanLocName } from '@/store/LocationContext'
import { usePeriod } from '@/store/PeriodContext'
import { useAuthStore } from '@/store/authStore'
import { db } from '@/lib/firebase'
import { doc, getDoc } from 'firebase/firestore'
import { locId } from '@/lib/pnl'
import { RECON_MAP, SECTION_ORDER, STATUS, computeRunningMonth } from '@/lib/reconMap'
import { canApproveSales } from '@/lib/permissions'
import OfficialPnlImport from '@/components/OfficialPnlImport'
import { AlertTriangle, CheckCircle } from 'lucide-react'

const fmt$ = (v) => v == null ? '—' : '$' + Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const VAR_THRESH = 1.0   // ignore sub-dollar rounding noise when flagging MAPPED variances

export default function Reconciliation() {
  const { user } = useAuthStore()
  const orgId = user?.tenantId
  const { selectedLocation } = useLocations()
  const { year, period } = usePeriod()
  const monthKey = `${year}-P${String(period).padStart(2, '0')}`
  const location = selectedLocation && selectedLocation !== 'all' ? selectedLocation : null

  const [loading, setLoading] = useState(false)
  const [official, setOfficial] = useState(null)   // officialPnl doc data | null
  const [running, setRunning] = useState(null)     // { lines, weekCount, weeksFound }
  const [err, setErr] = useState('')
  const [reloadTick, setReloadTick] = useState(0)

  useEffect(() => {
    if (!location || !orgId) { setOfficial(null); setRunning(null); return }
    let cancelled = false
    setLoading(true); setErr('')
    ;(async () => {
      try {
        const lid = locId(location)
        const [snap, run] = await Promise.all([
          getDoc(doc(db, 'tenants', orgId, 'officialPnl', lid, 'periods', monthKey)),
          computeRunningMonth(lid, monthKey, orgId),
        ])
        if (cancelled) return
        setOfficial(snap.exists() ? snap.data() : null)
        setRunning(run)
      } catch (e) { if (!cancelled) setErr(e.message || 'Failed to load reconciliation') }
      if (!cancelled) setLoading(false)
    })()
    return () => { cancelled = true }
  }, [location, monthKey, orgId, reloadTick])

  const officialByLine = useMemo(() => {
    const m = {}
    for (const l of (official?.lines || [])) m[l.officialLine] = l
    return m
  }, [official])

  // RECON_MAP grouped by section, in SECTION_ORDER.
  const grouped = useMemo(() => {
    const bySection = {}
    for (const [line, def] of Object.entries(RECON_MAP)) (bySection[def.section] ||= []).push({ line, def })
    return SECTION_ORDER.filter(s => bySection[s]).map(s => ({ section: s, lines: bySection[s] }))
  }, [])

  // One row's three values + variance.
  function rowOf(line, def) {
    const off = officialByLine[line]
    const officialActual = off ? (Number(off.actual) || 0) : null   // null = official didn't carry this line
    const budget = off ? (Number(off.budget) || 0) : null
    const run = running?.lines?.[line]                              // number, or null when no Aurelia source
    const comparable = def.status === STATUS.MAPPED && officialActual != null && run != null
    const variance = comparable ? officialActual - run : null
    return { officialActual, budget, run, variance, flagged: variance != null && Math.abs(variance) > VAR_THRESH }
  }

  // GFS sanity check — Official GFS total vs Running GFS total (aggregate = sum of
  // its disjoint GFS lines).
  const gfsCheck = useMemo(() => {
    if (!official) return null
    let off = 0, run = 0
    for (const [line, def] of Object.entries(RECON_MAP)) {
      if (def.section !== 'GFS') continue
      const r = rowOf(line, def)
      if (r.officialActual != null) off += r.officialActual
      if (r.run != null) run += r.run
    }
    return { off, run, diff: off - run }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [official, running])

  const partial = running && running.weeksFound < running.weekCount
  const canImport = canApproveSales(user)

  if (!location) return <Shell><Empty>Select a specific location (not All Locations) to reconcile its books.</Empty></Shell>

  return (
    <Shell>
      <div style={S.head}>
        <div>
          <div style={S.h1}>Reconciliation</div>
          <div style={S.sub}>
            {cleanLocName(location)} · {monthKey}
            {running && <> · running from <b>{running.weeksFound}</b>/{running.weekCount} weeks</>}
          </div>
        </div>
        {canImport && <OfficialPnlImport onImported={() => setReloadTick(t => t + 1)} />}
      </div>

      {err && <div style={S.errBar}>{err}</div>}
      {loading && <div style={S.muted}>Loading…</div>}

      {!loading && !official && (
        <div style={S.noteBar}>
          <AlertTriangle size={15} color="#d97706" />
          No official P&amp;L imported for <b>{cleanLocName(location)} · {monthKey}</b>. The Running column below shows what Aurelia has; import the NetSuite export to compare.
        </div>
      )}
      {!loading && partial && (
        <div style={S.noteBar}>
          <AlertTriangle size={15} color="#d97706" />
          Partial month — only <b>{running.weeksFound}</b> of {running.weekCount} weeks have data. Running totals are incomplete.
        </div>
      )}

      {gfsCheck && (
        <div style={{ ...S.gfsBar, ...(Math.abs(gfsCheck.diff) > VAR_THRESH ? S.gfsBad : S.gfsOk) }}>
          {Math.abs(gfsCheck.diff) > VAR_THRESH ? <AlertTriangle size={15} /> : <CheckCircle size={15} />}
          <b>GFS check:</b> Official {fmt$(gfsCheck.off)} vs Running {fmt$(gfsCheck.run)}
          {Math.abs(gfsCheck.diff) > VAR_THRESH ? <> — off by {fmt$(Math.abs(gfsCheck.diff))}</> : <> — reconciles</>}
        </div>
      )}

      {!loading && running && (
        <div style={S.tableWrap}>
          <table style={S.table}>
            <thead>
              <tr>
                <th style={S.th}>Line</th>
                <th style={S.thR}>Official</th>
                <th style={S.thR}>Running</th>
                <th style={S.thR}>Budget</th>
                <th style={S.thR}>Variance</th>
                <th style={S.thC}>State</th>
              </tr>
            </thead>
            <tbody>
              {grouped.map(({ section, lines }) => {
                let secOff = 0, secRun = 0, secVar = 0, anyVar = false
                const rows = lines.map(({ line, def }) => {
                  const r = rowOf(line, def)
                  if (r.officialActual != null) secOff += r.officialActual
                  if (r.run != null) secRun += r.run
                  if (r.variance != null) { secVar += r.variance; anyVar = true }
                  return { line, def, r }
                })
                return (
                  <SectionRows key={section} section={section} rows={rows}
                    secOff={secOff} secRun={secRun} secVar={anyVar ? secVar : null} />
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {official?.unmappedLines?.length > 0 && (
        <div style={S.unmapBlock}>
          <div style={S.unmapHead}>
            <AlertTriangle size={14} color="#d97706" /> {official.unmappedLines.length} official line(s) Aurelia doesn't recognize — <b>not reconciled</b> (stored, not diffed):
          </div>
          <div style={S.unmapList}>
            {official.unmappedLines.map((u, i) => (
              <span key={i} style={S.unmapChip}>{u.line || u.netsuiteAccount || '(blank)'} · {fmt$(u.actual)}</span>
            ))}
          </div>
        </div>
      )}

      {official && (
        <div style={S.foot}>
          Official source: {official.sourceFile || '—'} · imported by {official.importedBy || '—'}
        </div>
      )}
    </Shell>
  )
}

function SectionRows({ section, rows, secOff, secRun, secVar }) {
  return (
    <>
      <tr><td colSpan={6} style={S.secHead}>{section}</td></tr>
      {rows.map(({ line, def, r }) => {
        const external = def.status === STATUS.EXTERNAL
        const coming = def.status === STATUS.COMING
        return (
          <tr key={line} style={r.flagged ? S.rowFlag : undefined}>
            <td style={S.tdLine}>{line}{def.acct ? <span style={S.acct}> · {def.acct}</span> : null}</td>
            <td style={S.tdR}>{fmt$(r.officialActual)}</td>
            <td style={{ ...S.tdR, color: r.run == null ? '#cbd5e1' : '#0f172a' }}>
              {r.run == null ? (external ? 'NetSuite-only' : 'no source') : fmt$(r.run)}
            </td>
            <td style={S.tdRMuted}>{fmt$(r.budget)}</td>
            <td style={{ ...S.tdR, fontWeight: r.flagged ? 800 : 500, color: r.variance == null ? '#cbd5e1' : r.flagged ? '#b91c1c' : '#16a34a' }}>
              {r.variance == null ? '—' : fmt$(r.variance)}
            </td>
            <td style={S.tdC}><StatusBadge status={def.status} /></td>
          </tr>
        )
      })}
      <tr style={S.secTotalRow}>
        <td style={S.secTotalLbl}>{section} subtotal</td>
        <td style={S.tdRB}>{fmt$(secOff)}</td>
        <td style={S.tdRB}>{fmt$(secRun)}</td>
        <td style={S.tdR}></td>
        <td style={{ ...S.tdRB, color: secVar == null ? '#94a3b8' : Math.abs(secVar) > VAR_THRESH ? '#b91c1c' : '#16a34a' }}>{secVar == null ? '—' : fmt$(secVar)}</td>
        <td></td>
      </tr>
    </>
  )
}

function StatusBadge({ status }) {
  const map = {
    [STATUS.MAPPED]:   { bg: '#dcfce7', c: '#166534', t: 'mapped' },
    [STATUS.COMING]:   { bg: '#fef3c7', c: '#92400e', t: 'coming' },
    [STATUS.EXTERNAL]: { bg: '#e2e8f0', c: '#475569', t: 'external' },
  }
  const m = map[status] || map[STATUS.COMING]
  return <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 7px', borderRadius: 999, background: m.bg, color: m.c }}>{m.t}</span>
}

const Shell = ({ children }) => <div style={{ padding: '18px 22px', maxWidth: 1100, margin: '0 auto' }}>{children}</div>
const Empty = ({ children }) => <div style={{ padding: 40, textAlign: 'center', color: '#94a3b8', fontSize: 14 }}>{children}</div>

const S = {
  head: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 14 },
  h1: { fontSize: 20, fontWeight: 800, color: '#0f172a' },
  sub: { fontSize: 13, color: '#64748b', marginTop: 2 },
  muted: { fontSize: 13, color: '#94a3b8', padding: '20px 0' },
  errBar: { background: '#fef2f2', border: '1px solid #fecaca', color: '#991b1b', borderRadius: 8, padding: '8px 12px', fontSize: 13, marginBottom: 10 },
  noteBar: { display: 'flex', alignItems: 'center', gap: 8, background: '#fffbeb', border: '1px solid #fde68a', color: '#92400e', borderRadius: 8, padding: '8px 12px', fontSize: 13, marginBottom: 10 },
  gfsBar: { display: 'flex', alignItems: 'center', gap: 8, borderRadius: 8, padding: '8px 12px', fontSize: 13, marginBottom: 12 },
  gfsOk: { background: '#f0fdf4', border: '1px solid #bbf7d0', color: '#166534' },
  gfsBad: { background: '#fef2f2', border: '1px solid #fecaca', color: '#991b1b' },
  tableWrap: { border: '1px solid #e2e8f0', borderRadius: 12, overflow: 'hidden' },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: 13 },
  th: { textAlign: 'left', padding: '8px 14px', fontSize: 11, fontWeight: 700, color: '#475569', textTransform: 'uppercase', background: '#f8fafc' },
  thR: { textAlign: 'right', padding: '8px 14px', fontSize: 11, fontWeight: 700, color: '#475569', textTransform: 'uppercase', background: '#f8fafc' },
  thC: { textAlign: 'center', padding: '8px 14px', fontSize: 11, fontWeight: 700, color: '#475569', textTransform: 'uppercase', background: '#f8fafc' },
  secHead: { padding: '8px 14px', fontSize: 12, fontWeight: 800, color: '#0f172a', background: '#eef2f7', textTransform: 'uppercase', letterSpacing: 0.3 },
  tdLine: { padding: '7px 14px', color: '#334155', borderTop: '1px solid #f1f5f9' },
  acct: { fontSize: 11, color: '#94a3b8' },
  tdR: { padding: '7px 14px', textAlign: 'right', color: '#0f172a', fontVariantNumeric: 'tabular-nums', borderTop: '1px solid #f1f5f9' },
  tdRMuted: { padding: '7px 14px', textAlign: 'right', color: '#94a3b8', fontVariantNumeric: 'tabular-nums', borderTop: '1px solid #f1f5f9' },
  tdC: { padding: '7px 14px', textAlign: 'center', borderTop: '1px solid #f1f5f9' },
  rowFlag: { background: '#fef2f2' },
  secTotalRow: { background: '#f8fafc' },
  secTotalLbl: { padding: '7px 14px', fontWeight: 700, color: '#475569', textAlign: 'right' },
  tdRB: { padding: '7px 14px', textAlign: 'right', fontWeight: 800, color: '#0f172a', fontVariantNumeric: 'tabular-nums' },
  unmapBlock: { marginTop: 16, background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 8, padding: '10px 12px' },
  unmapHead: { fontSize: 12, color: '#92400e', marginBottom: 6, display: 'flex', alignItems: 'center', gap: 6 },
  unmapList: { display: 'flex', flexWrap: 'wrap', gap: 6 },
  unmapChip: { fontSize: 11, color: '#78350f', background: '#fef3c7', border: '1px solid #fde68a', borderRadius: 6, padding: '2px 7px' },
  foot: { marginTop: 12, fontSize: 11, color: '#94a3b8' },
}
