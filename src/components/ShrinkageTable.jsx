// src/components/ShrinkageTable.jsx
//
// Increment 4 — the shrinkage variance table. One row per canonical retail item (maps to
// a sold item), for the SELECTED location + period. Joins all three feeds on the itemMap
// identity and computes: shrinkage = opening + purchased − sold − closing; $lost = ×unitCost.
// Look mirrors the /waste "Shrinkage Analysis" table (KPI cards + full-column table +
// search/sort). Honest cells: a missing feed shows "—" and the row is flagged incomplete.

import { useState, useEffect, useMemo, useRef } from 'react'
import { Search, AlertTriangle, Download } from 'lucide-react'
import { useAuthStore } from '@/store/authStore'
import { useLocations, cleanLocName } from '@/store/LocationContext'
import SubCafeBar from '@/components/ui/SubCafePrompt'
import { usePeriod } from '@/store/PeriodContext'
import { db } from '@/lib/firebase'
import { doc, getDoc, getDocs, collection } from 'firebase/firestore'
import { locId, getPriorKey, writePnL } from '@/lib/pnl'
import { loadMappings, buildPurchaseLookup, resolvePurchaseLineLive } from '@/lib/itemMap'
import { computeShrinkageRows, shrinkageKpis, countEaches, isCounted } from '@/lib/shrinkage'

const fmtN = (v) => {
  if (v == null) return '—'
  const n = Math.round(v * 10) / 10
  return (n === 0 ? 0 : n).toLocaleString('en-US')   // n === 0 also normalizes -0 → "0"
}
const fmt$ = (v) => v == null ? '—' : '$' + (Number(v) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

export default function ShrinkageTable() {
  const { user } = useAuthStore()
  const orgId = user?.tenantId
  const { selectedLocation, isParentLocation, getParentName } = useLocations()
  const { periodKey } = usePeriod()
  const [loading, setLoading] = useState(true)
  const [rows, setRows] = useState([])
  const [feedState, setFeedState] = useState({ hasSoldFeed: false, hasOpeningDoc: false, hasClosingDoc: false })
  const [search, setSearch] = useState('')
  const [sortBy, setSortBy] = useState('shrinkage')

  const location = selectedLocation
  const scoped = location && location !== 'all'

  useEffect(() => {
    if (!orgId || !scoped || !periodKey) { setRows([]); setLoading(false); return }
    setLoading(true)
    ;(async () => {
      try {
        const lk = locId(location)
        const priorPK = getPriorKey(periodKey)

        // ── the three feeds + catalog, all for THIS loc + period ──
        const [mappings, salesSnap, invSnap, catSnap, priorSnap, curSnap] = await Promise.all([
          loadMappings(orgId),
          getDocs(collection(db, 'tenants', orgId, 'salesItems', lk, 'periods', periodKey, 'items')),
          getDocs(collection(db, 'tenants', orgId, 'invoices')),
          getDocs(collection(db, 'tenants', orgId, 'inventoryCatalog')),
          priorPK ? getDoc(doc(db, 'tenants', orgId, 'locations', lk, 'inventory', priorPK)) : Promise.resolve(null),
          getDoc(doc(db, 'tenants', orgId, 'locations', lk, 'inventory', periodKey)),
        ])

        // SOLD ← salesItems.qtySold, joined to canonical via soldAliases (exact itemName).
        const aliasToCanonical = {}
        for (const m of mappings) for (const a of m.soldAliases || []) aliasToCanonical[a] = m.canonicalId
        const soldByCanonical = {}
        const hasSoldFeed = salesSnap.size > 0
        salesSnap.forEach((d) => {
          const x = d.data(); const cid = aliasToCanonical[x.itemName]
          if (cid) soldByCanonical[cid] = (soldByCanonical[cid] || 0) + (Number(x.qtySold) || 0)
        })

        // PURCHASED ← invoice lineItems.eachesTotal for this loc+period, resolved to a
        // canonical LIVE against the current mappings (not the stored l.canonicalId, which
        // froze at parse time). A code mapped AFTER an invoice was parsed self-heals here on
        // next load — no backfill of invoice docs needed.
        const purchaseLookup = buildPurchaseLookup(mappings)
        const purchasedByCanonical = {}
        const purchasedUnresolvedByCanonical = {}   // canonical has ≥1 resolved line with unknown eaches
        invSnap.forEach((d) => {
          const inv = d.data()
          if (inv.location !== location || inv.periodKey !== periodKey) return
          const vendorKey = inv.vendorKey || (inv.vendor || '').toLowerCase().replace(/[^a-z0-9]+/g, '_')
          for (const l of inv.lineItems || []) {
            const cid = resolvePurchaseLineLive(purchaseLookup, vendorKey, l)
            if (!cid) continue
            if (l.eachesTotal == null) {                        // pack unresolved → eaches unknown
              purchasedUnresolvedByCanonical[cid] = true         // flag; don't add 0 to the sum
              continue
            }
            purchasedByCanonical[cid] = (purchasedByCanonical[cid] || 0) + Number(l.eachesTotal)
          }
        })

        // OPENING / CLOSING ← inventory counts by catalog item id; unitCost ← catalog.
        // Opening/Closing in EACHES: total = qty×qtyPerPack + eaches (countEaches). Only
        // items ACTUALLY COUNTED become keys (isCounted) — a line present but blank in both
        // qty and eaches is "not counted" → omitted → compute reads null → incomplete, not a
        // phantom 0. A genuine counted-0 stays a key (real 0). Same honesty rule as the
        // empty-count-doc fix, now at the line grain.
        const openingByCat = {}, closingByCat = {}, unitCostByCat = {}
        const priorItems = (priorSnap && priorSnap.exists() && priorSnap.data().items) || []
        const curItems = (curSnap && curSnap.exists() && curSnap.data().items) || []
        priorItems.forEach((i) => { if (i.id != null && isCounted(i)) openingByCat[i.id] = countEaches(i) })
        curItems.forEach((i) => { if (i.id != null && isCounted(i)) closingByCat[i.id] = countEaches(i) })
        catSnap.forEach((d) => { const x = d.data(); if (x.unitCost != null) unitCostByCat[d.id] = x.unitCost })
        // Banner/KPI flags: base on ACTUALLY-counted lines, so an all-blank doc reads "no
        // real count" for the heads-up (not just "doc exists").
        const hasOpeningDoc = Object.keys(openingByCat).length > 0
        const hasClosingDoc = Object.keys(closingByCat).length > 0

        const feeds = { hasSoldFeed, openingByCat, closingByCat, purchasedByCanonical, purchasedUnresolvedByCanonical, soldByCanonical, unitCostByCat }
        setFeedState({ hasSoldFeed, hasOpeningDoc, hasClosingDoc })
        setRows(computeShrinkageRows(mappings, feeds))
      } catch (err) {
        console.error('shrinkage load failed:', err)
        setRows([])
      }
      setLoading(false)
    })()
  }, [orgId, location, periodKey, scoped])

  const kpis = useMemo(() => shrinkageKpis(rows), [rows])

  // ── The ONE canonical cogs_shrinkage → P&L writer. ────────────────────────────
  // Posts ONLY the honest total (kpis.totalLoss — complete rows only, the empty-count-
  // fixed number), NEVER the fake-zero-inflated total. Guarded three ways:
  //   1. writes nothing unless ≥1 row is COMPLETE (an all-incomplete table = no counts
  //      yet → posts nothing; never zeroes or posts a phantom 0 over an existing value);
  //   2. writes only when that total actually CHANGES for this loc/period (lastPosted ref);
  //   3. best-effort — a locked period is swallowed, never breaks the view.
  // A genuinely zero-shrinkage but fully-counted period (completeCount ≥ 1, total 0) DOES
  // post 0 — that's real, not a phantom. Only "no complete rows" writes nothing.
  const lastPosted = useRef('')
  useEffect(() => {
    if (!scoped || !periodKey || !orgId) return
    if (kpis.completeCount < 1) return                       // no real data → write nothing
    const rounded = Math.round(kpis.totalLoss * 100) / 100
    const key = `${location}__${periodKey}__${rounded}`
    if (lastPosted.current === key) return                   // unchanged → skip redundant write
    lastPosted.current = key
    writePnL(location, periodKey, { cogs_shrinkage: rounded }).catch(() => {})
  }, [kpis.totalLoss, kpis.completeCount, location, periodKey, scoped, orgId])

  const filtered = useMemo(() => {
    let r = rows
    if (search) { const s = search.toLowerCase(); r = r.filter((x) => x.name?.toLowerCase().includes(s)) }
    if (sortBy === 'name') r = [...r].sort((a, b) => (a.name || '').localeCompare(b.name || ''))
    // default 'shrinkage' order already applied by computeShrinkageRows ($ lost desc, incompletes last)
    return r
  }, [rows, search, sortBy])

  // Row status string for the CSV: the punch list of what a row is waiting on. "complete"
  // when nothing's missing; else the missing feeds + a "pack unresolved" note, joined "; ".
  function rowStatus(r) {
    if (r.complete) return 'complete'
    const parts = (r.missing || [])
      .filter((m) => m !== 'purchased')            // 'purchased' surfaces as "pack unresolved" below
      .map((m) => `missing ${m}`)
    if (r.purchasedUnresolved) parts.push('pack unresolved')
    return parts.join('; ') || 'incomplete'
  }

  // Weekly export. ALL rows (incl. incomplete — those ARE the punch list), respecting the
  // current search + sort (uses `filtered`). null → empty cell (not 0), so a missing count
  // never reads as a real zero in Excel. Values are quoted/escaped; the description can hold
  // commas. Filename: shrinkage_{locId}_{periodKey}.csv.
  function exportCsv() {
    const q = (v) => `"${String(v).replace(/"/g, '""')}"`      // CSV-escape
    const cell = (v) => (v == null ? '' : v)                    // null → empty, NOT 0
    const headers = ['Item', 'Opening', 'Purchased', 'Sold', 'Expected', 'Closing', 'Shrinkage', 'Unit Cost', '$ Lost', 'Status']
    const lines = [headers.map(q).join(',')]
    for (const r of filtered) {
      lines.push([
        q(r.name || ''),
        cell(r.opening), cell(r.purchased), cell(r.sold), cell(r.expected),
        cell(r.closing), cell(r.shrinkage), cell(r.unitCost), cell(r.shrinkageValue),
        q(rowStatus(r)),
      ].join(','))
    }
    const blob = new Blob([lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `shrinkage_${locId(location)}_${periodKey}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  const S = STYLES
  if (!scoped) return <div style={S.prompt}>Select a location to view its shrinkage variance.</div>

  return (
    <div>
      <div style={S.head}>
        <div>
          <h2 style={S.h1}>Shrinkage Analysis</h2>
          <div style={S.sub}>{cleanLocName(location)} · {periodKey}</div>
        </div>
      </div>

      {/* Sub-café drill-down (same as Inventory/Purchasing/etc.): a parent campus surfaces
          its cafés; picking one scopes the variance to that café's locId — where the
          salesItems + inventory data actually live. */}
      {isParentLocation?.(selectedLocation) && (
        <div style={{ marginBottom: 16 }}>
          <SubCafeBar parentName={selectedLocation} activeSubCafe={null} />
        </div>
      )}
      {getParentName?.(selectedLocation) && (
        <div style={{ marginBottom: 16 }}>
          <SubCafeBar parentName={getParentName(selectedLocation)} activeSubCafe={selectedLocation} />
        </div>
      )}

      {/* KPI cards */}
      <div style={S.kpis}>
        <div style={S.kpi}><div style={S.kpiL}>Total shrinkage</div><div style={S.kpiV}>{fmt$(kpis.totalLoss)}</div></div>
        <div style={S.kpi}><div style={S.kpiL}>Units lost</div><div style={S.kpiV}>{fmtN(kpis.unitsLost)}</div></div>
        <div style={S.kpi}><div style={S.kpiL}>Items affected</div><div style={S.kpiV}>{kpis.itemsAffected}</div></div>
        <div style={{ ...S.kpi, background: feedState.hasSoldFeed && feedState.hasClosingDoc ? '#f0fdf4' : '#fffbeb' }}>
          <div style={{ ...S.kpiL, color: feedState.hasSoldFeed && feedState.hasClosingDoc ? '#059669' : '#d97706' }}>Feeds</div>
          <div style={S.kpiV}>{kpis.completeCount}/{kpis.trackedCount} complete</div>
          {kpis.incompleteCount > 0 && <div style={S.kpiHint}>{kpis.incompleteCount} awaiting a count/feed</div>}
        </div>
      </div>

      {/* missing-feed banner */}
      {(!feedState.hasClosingDoc || !feedState.hasSoldFeed) && (
        <div style={S.warn}>
          <AlertTriangle size={14} color="#d97706" />
          {!feedState.hasSoldFeed && ' No Product Mix (sold) data for this period.'}
          {!feedState.hasClosingDoc && ' No closing inventory count for this period.'}
          {' '}Rows show what's known; shrinkage computes once the feed lands.
        </div>
      )}

      {/* search + sort */}
      <div style={S.tools}>
        <div style={S.searchWrap}>
          <Search size={14} style={S.searchIcon} />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search item…" style={S.searchInput} />
        </div>
        <select value={sortBy} onChange={(e) => setSortBy(e.target.value)} style={S.select}>
          <option value="shrinkage">Sort by shrinkage $</option>
          <option value="name">Sort by name</option>
        </select>
        <button style={S.csvBtn} onClick={exportCsv} disabled={filtered.length === 0} title="Download the current location + period's variance rows (all rows, incl. incomplete)">
          <Download size={14} /> Download CSV
        </button>
      </div>

      {/* variance table */}
      {loading ? <div style={S.muted}>Loading shrinkage…</div>
        : filtered.length === 0 ? <div style={S.muted}>No shrinkage-tracked items yet — map sold items on the Mapping tab, then count inventory for this period.</div>
        : (
          <div style={S.tableWrap}>
            <table style={S.table}>
              <thead><tr style={S.thead}>
                <th style={S.thL}>Item</th>
                {['Opening', 'Purchased', 'Sold', 'Expected', 'Closing', 'Shrinkage', '$ Lost'].map((h) => <th key={h} style={S.thR}>{h}</th>)}
              </tr></thead>
              <tbody>
                {filtered.map((r) => {
                  const high = r.shrinkage != null && r.shrinkage > 0.5
                  const neg = r.shrinkage != null && r.shrinkage < -0.5
                  return (
                    <tr key={r.canonicalId} style={{ ...S.tr, background: high ? '#fef2f2' : 'transparent' }}>
                      <td style={S.tdItem}>
                        <div style={S.itemName}>{r.name}</div>
                        {!r.complete && <div style={S.incomplete}>incomplete — missing {r.missing.join(', ')}</div>}
                      </td>
                      <td style={S.td}>{fmtN(r.opening)}</td>
                      <td style={{ ...S.td, color: '#2563eb' }}>
                        {fmtN(r.purchased)}
                        {r.purchasedUnresolved && <span style={S.packTag} title="A purchase line's pack count is unresolved — Purchased is a lower bound, so this row can't compute a trustworthy shrinkage">+ pack?</span>}
                      </td>
                      <td style={{ ...S.td, color: r.sold != null ? '#7c3aed' : '#cbd5e1' }}>{r.sold != null ? fmtN(r.sold) : '—'}</td>
                      <td style={S.td}>{fmtN(r.expected)}</td>
                      <td style={{ ...S.td, fontWeight: 600, color: '#0f172a' }}>{fmtN(r.closing)}</td>
                      <td style={{ ...S.td, fontWeight: 600, color: r.shrinkage == null ? '#cbd5e1' : high ? '#dc2626' : neg ? '#2563eb' : '#059669' }}>{fmtN(r.shrinkage)}</td>
                      <td style={{ ...S.tdR, fontWeight: 600, color: high ? '#dc2626' : '#059669' }}>{r.shrinkageValue != null && r.shrinkageValue > 0.5 ? fmt$(r.shrinkageValue) : (r.complete ? '—' : '—')}</td>
                    </tr>
                  )
                })}
              </tbody>
              <tfoot><tr style={S.tfoot}>
                <td style={S.tdItem}>Total ({kpis.completeCount} complete)</td>
                <td colSpan={5}></td>
                <td style={S.td}>{fmtN(kpis.unitsLost)}</td>
                <td style={S.tdR}>{fmt$(kpis.totalLoss)}</td>
              </tr></tfoot>
            </table>
          </div>
        )}
    </div>
  )
}

const cell = { textAlign: 'right', padding: '10px 10px', color: '#64748b', fontVariantNumeric: 'tabular-nums' }
const STYLES = {
  prompt: { fontSize: 14, color: '#64748b', padding: '24px 0' },
  muted: { textAlign: 'center', padding: 50, color: '#94a3b8', fontSize: 13 },
  head: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16 },
  h1: { fontSize: 20, fontWeight: 800, color: '#0f172a', margin: 0 },
  sub: { fontSize: 13, color: '#64748b', marginTop: 2 },
  kpis: { display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 18 },
  kpi: { background: '#f8fafc', borderRadius: 10, padding: '14px 18px' },
  kpiL: { fontSize: 11, fontWeight: 600, color: '#64748b', textTransform: 'uppercase', marginBottom: 4 },
  kpiV: { fontSize: 22, fontWeight: 800, color: '#0f172a' },
  kpiHint: { fontSize: 11, color: '#d97706', marginTop: 2 },
  warn: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#92400e', background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 8, padding: '8px 10px', marginBottom: 14 },
  tools: { display: 'flex', gap: 12, marginBottom: 14, alignItems: 'center' },
  searchWrap: { position: 'relative', flex: 1 }, searchIcon: { position: 'absolute', left: 12, top: 9, color: '#94a3b8' },
  searchInput: { width: '100%', padding: '8px 12px 8px 34px', fontSize: 13, border: '1px solid #e2e8f0', borderRadius: 8, outline: 'none' },
  select: { padding: '8px 12px', fontSize: 12, border: '1px solid #e2e8f0', borderRadius: 8 },
  csvBtn: { display: 'inline-flex', alignItems: 'center', gap: 5, padding: '8px 12px', fontSize: 12, fontWeight: 600, color: '#0f172a', background: '#fff', border: '1px solid #cbd5e1', borderRadius: 8, cursor: 'pointer', whiteSpace: 'nowrap' },
  tableWrap: { border: '1px solid #e2e8f0', borderRadius: 12, overflow: 'hidden' },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: 13 },
  thead: { background: '#f8fafc' },
  thL: { textAlign: 'left', padding: '10px 14px', fontWeight: 600, fontSize: 11, color: '#475569', textTransform: 'uppercase' },
  thR: { textAlign: 'right', padding: '10px 10px', fontWeight: 600, fontSize: 11, color: '#475569', textTransform: 'uppercase' },
  tr: { borderTop: '1px solid #f1f5f9' },
  tdItem: { padding: '10px 14px' }, itemName: { fontWeight: 500, color: '#0f172a' },
  incomplete: { fontSize: 11, color: '#d97706' },
  packTag: { fontSize: 10, fontWeight: 600, color: '#92400e', background: '#fef3c7', borderRadius: 4, padding: '1px 4px', marginLeft: 5, whiteSpace: 'nowrap' },
  td: cell, tdR: { ...cell, padding: '10px 14px' },
  tfoot: { borderTop: '2px solid #e2e8f0', background: '#f8fafc', fontWeight: 700 },
}
