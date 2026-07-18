// src/components/ShrinkageTable.jsx
//
// Increment 4 — the shrinkage variance table. One row per canonical retail item (maps to
// a sold item), for the SELECTED location + period. Joins all three feeds on the itemMap
// identity and computes: shrinkage = opening + purchased − sold − closing; $lost = ×unitCost.
// Look mirrors the /waste "Shrinkage Analysis" table (KPI cards + full-column table +
// search/sort). Honest cells: a missing feed shows "—" and the row is flagged incomplete.

import { useState, useEffect, useMemo } from 'react'
import { Search, AlertTriangle } from 'lucide-react'
import { useAuthStore } from '@/store/authStore'
import { useLocations, cleanLocName } from '@/store/LocationContext'
import { usePeriod } from '@/store/PeriodContext'
import { db } from '@/lib/firebase'
import { doc, getDoc, getDocs, collection } from 'firebase/firestore'
import { locId, getPriorKey } from '@/lib/pnl'
import { loadMappings } from '@/lib/itemMap'
import { computeShrinkageRows, shrinkageKpis } from '@/lib/shrinkage'

const fmtN = (v) => v == null ? '—' : (Math.round(v * 10) / 10).toLocaleString('en-US')
const fmt$ = (v) => v == null ? '—' : '$' + (Number(v) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

export default function ShrinkageTable() {
  const { user } = useAuthStore()
  const orgId = user?.tenantId
  const { selectedLocation } = useLocations()
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

        // PURCHASED ← resolved invoice lineItems.eachesTotal, for this loc+period, by canonicalId.
        const purchasedByCanonical = {}
        invSnap.forEach((d) => {
          const inv = d.data()
          if (inv.location !== location || inv.periodKey !== periodKey) return
          for (const l of inv.lineItems || []) {
            if (!l.canonicalId) continue
            purchasedByCanonical[l.canonicalId] = (purchasedByCanonical[l.canonicalId] || 0) + (Number(l.eachesTotal) || 0)
          }
        })

        // OPENING / CLOSING ← inventory counts by catalog item id; unitCost ← catalog.
        // Only items PRESENT in the count become keys — so the compute treats an absent /
        // empty count as "not counted" (null), not a fake zero. A counted 0 stays a key.
        const openingByCat = {}, closingByCat = {}, unitCostByCat = {}
        const priorItems = (priorSnap && priorSnap.exists() && priorSnap.data().items) || []
        const curItems = (curSnap && curSnap.exists() && curSnap.data().items) || []
        priorItems.forEach((i) => { if (i.id != null) openingByCat[i.id] = i.qty || 0 })
        curItems.forEach((i) => { if (i.id != null) closingByCat[i.id] = i.qty || 0 })
        catSnap.forEach((d) => { const x = d.data(); if (x.unitCost != null) unitCostByCat[d.id] = x.unitCost })
        // Banner/KPI flags: a doc with zero items is "no real count" for the heads-up.
        const hasOpeningDoc = priorItems.length > 0
        const hasClosingDoc = curItems.length > 0

        const feeds = { hasSoldFeed, openingByCat, closingByCat, purchasedByCanonical, soldByCanonical, unitCostByCat }
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
  const filtered = useMemo(() => {
    let r = rows
    if (search) { const s = search.toLowerCase(); r = r.filter((x) => x.name?.toLowerCase().includes(s)) }
    if (sortBy === 'name') r = [...r].sort((a, b) => (a.name || '').localeCompare(b.name || ''))
    // default 'shrinkage' order already applied by computeShrinkageRows ($ lost desc, incompletes last)
    return r
  }, [rows, search, sortBy])

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
                      <td style={{ ...S.td, color: '#2563eb' }}>{r.purchased > 0 ? '+' + fmtN(r.purchased) : fmtN(r.purchased)}</td>
                      <td style={{ ...S.td, color: r.sold != null ? '#7c3aed' : '#cbd5e1' }}>{r.sold != null ? '-' + fmtN(r.sold) : '—'}</td>
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
  tableWrap: { border: '1px solid #e2e8f0', borderRadius: 12, overflow: 'hidden' },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: 13 },
  thead: { background: '#f8fafc' },
  thL: { textAlign: 'left', padding: '10px 14px', fontWeight: 600, fontSize: 11, color: '#475569', textTransform: 'uppercase' },
  thR: { textAlign: 'right', padding: '10px 10px', fontWeight: 600, fontSize: 11, color: '#475569', textTransform: 'uppercase' },
  tr: { borderTop: '1px solid #f1f5f9' },
  tdItem: { padding: '10px 14px' }, itemName: { fontWeight: 500, color: '#0f172a' },
  incomplete: { fontSize: 11, color: '#d97706' },
  td: cell, tdR: { ...cell, padding: '10px 14px' },
  tfoot: { borderTop: '2px solid #e2e8f0', background: '#f8fafc', fontWeight: 700 },
}
