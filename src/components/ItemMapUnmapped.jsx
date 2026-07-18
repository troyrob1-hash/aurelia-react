// src/components/ItemMapUnmapped.jsx
//
// Increment 2 — the VOLUME-RANKED unmapped list + coverage indicator. Not a gate: a
// quiet section that ranks the sold items that haven't auto-mapped by qtySold (desc),
// so the manager maps the high-volume items first and stops when the tail goes optional.
// Each row pre-fills the best fuzzy suggestion (tap-to-confirm); variant-risk pairs show
// the suggestion but don't pre-select. "Café-use" drops an item from shrinkage (stays in
// COGS), reversible.
//
// Partial mapping is the normal state — unmapped items simply don't show shrinkage yet.

import { useState, useEffect, useMemo } from 'react'
import { CheckCircle2, Coffee, ChevronRight, Package } from 'lucide-react'
import { useAuthStore } from '@/store/authStore'
import { useToast } from '@/components/ui/Toast'
import { db } from '@/lib/firebase'
import { collectionGroup, getDocs, collection } from 'firebase/firestore'
import {
  rankUnmappedByVolume, coverageStats, fuzzyBest, classifyMatch, itemTokens, brandOf,
  loadMappings, writeMapping, newMappingDoc, setCafeUse, canonicalIdFor, purchaseKeyId,
} from '@/lib/itemMap'

export default function ItemMapUnmapped() {
  const { user } = useAuthStore()
  const orgId = user?.tenantId
  const toast = useToast()
  const [loading, setLoading] = useState(true)
  const [soldTotals, setSoldTotals] = useState([])   // [{ name, qtySold }]
  const [purchaseUnmapped, setPurchaseUnmapped] = useState([])  // [{ key, vendor, itemCode, upc, description, spend, eaches }]
  const [mappings, setMappings] = useState([])
  const [catalog, setCatalog] = useState([])         // fuzzy candidates
  const [busyId, setBusyId] = useState(null)

  async function load() {
    setLoading(true)
    // Aggregate qtySold per sold item across the whole salesItems feed.
    const itemsSnap = await getDocs(collectionGroup(db, 'items'))
    const byName = {}
    itemsSnap.forEach((d) => {
      const x = d.data()
      if (x.source !== 'cafe_product_mix' || !x.itemName) return
      byName[x.itemName] = (byName[x.itemName] || 0) + (Number(x.qtySold) || 0)
    })
    setSoldTotals(Object.entries(byName).map(([name, qtySold]) => ({ name, qtySold })))

    // Purchase-side unmapped = invoice lines with canonicalId:null (read-time derived,
    // so a code mapped later drops out here on next load without any backfill). Group by
    // stable code so repeats across invoices sum into one row; rank by spend.
    const invSnap = await getDocs(collection(db, 'tenants', orgId, 'invoices'))
    const byKey = {}
    invSnap.forEach((d) => {
      const inv = d.data()
      const vendorKey = inv.vendorKey || (inv.vendor || '').toLowerCase().replace(/[^a-z0-9]+/g, '_')
      for (const l of inv.lineItems || []) {
        if (l.canonicalId) continue                       // already resolved
        const code = String(l.itemCode || '').trim(), upc = String(l.upc || '').trim()
        if (!code && !upc) continue                       // code-unresolved lines have no stable key → skip here
        const key = upc ? `upc__${upc}` : purchaseKeyId(vendorKey, code)
        const g = byKey[key] || (byKey[key] = { key, vendor: vendorKey, itemCode: code, upc, description: l.description || '', spend: 0, eaches: 0 })
        g.spend += Number(l.total) || 0
        g.eaches += Number(l.eachesTotal) || 0
        if (!g.description && l.description) g.description = l.description
      }
    })
    setPurchaseUnmapped(Object.values(byKey))

    setMappings(await loadMappings(orgId))
    const catSnap = await getDocs(collection(db, 'tenants', orgId, 'inventoryCatalog'))
    setCatalog(catSnap.docs.map((d) => { const x = d.data(); const nm = x.name || x.itemName || d.id; return { id: d.id, name: nm, _tokens: itemTokens(nm), _brand: brandOf(nm) } }))
    setLoading(false)
  }
  useEffect(() => { if (orgId) load() }, [orgId])   // eslint-disable-line

  // Names already mapped (any sold alias attached to a canonical).
  const mappedNames = useMemo(() => {
    const s = new Set()
    for (const m of mappings) for (const a of m.soldAliases || []) s.add(a)
    return s
  }, [mappings])

  // Fuzzy candidates = catalog + existing canonical items.
  const candidates = useMemo(() => [
    ...catalog,
    ...mappings.map((m) => ({ id: m.canonicalId, name: m.canonicalName, _tokens: itemTokens(m.canonicalName), _brand: brandOf(m.canonicalName), _canonical: true })),
  ], [catalog, mappings])

  // Volume-ranked unmapped list, each with a pre-filled proposal.
  const ranked = useMemo(() => {
    const unmapped = soldTotals.filter((it) => !mappedNames.has(it.name))
    return rankUnmappedByVolume(unmapped).map((it) => {
      const fz = fuzzyBest(it.name, candidates)
      const kind = classifyMatch(fz)   // 'auto' won't appear here (those were mapped), so 'proposal' | 'none'
      return { ...it, proposal: fz.match ? { name: fz.match.name, id: fz.match.id, score: fz.score } : null, variantRisk: fz.variantRisk, kind }
    })
  }, [soldTotals, mappedNames, candidates])

  const stats = useMemo(() => coverageStats(
    rankUnmappedByVolume(soldTotals), mappedNames
  ), [soldTotals, mappedNames])

  // Purchase codes to map — ranked by spend (desc), each with a fuzzy suggestion on its
  // distributor description (same tap-to-confirm pattern as the sold side).
  const rankedPurchase = useMemo(() =>
    purchaseUnmapped
      .slice().sort((a, b) => b.spend - a.spend)
      .map((g) => {
        const fz = fuzzyBest(g.description, candidates)
        return { ...g, proposal: fz.match ? { name: fz.match.name, id: fz.match.id, score: fz.score } : null, variantRisk: fz.variantRisk }
      }), [purchaseUnmapped, candidates])

  async function mapTo(item, canonicalName, catalogItemId) {
    setBusyId(item.name)
    try {
      const existing = mappings.find((m) => m.canonicalName === canonicalName)
      const mapping = existing
        ? { ...existing, soldAliases: [...new Set([...(existing.soldAliases || []), item.name])] }
        : newMappingDoc({ canonicalName, catalogItemId: catalogItemId || null, soldAliases: [item.name], source: 'manual', createdBy: user?.email || 'unknown' })
      await writeMapping(orgId, mapping, user?.email || 'unknown')
      toast.success(`Mapped "${item.name.slice(0, 28)}" → ${canonicalName.slice(0, 28)}`)
      await load()
    } catch (e) { toast.error(e.message) }
    setBusyId(null)
  }

  async function markCafe(item) {
    setBusyId(item.name)
    try {
      // café-use item → its own canonical, status cafe_use (excluded from shrinkage, kept in COGS)
      const m = newMappingDoc({ canonicalName: item.name, soldAliases: [item.name], status: 'cafe_use', source: 'manual', createdBy: user?.email || 'unknown' })
      await writeMapping(orgId, m, user?.email || 'unknown')
      toast.success(`"${item.name.slice(0, 28)}" marked café-use — excluded from shrinkage`)
      await load()
    } catch (e) { toast.error(e.message) }
    setBusyId(null)
  }

  // Map a purchase code → a canonical item. Attaches { vendor, itemCode, upc } to the
  // canonical's purchaseKeys, which writeMapping indexes into purchaseKeyIndex — so this
  // (and every future invoice line with that code) auto-resolves from now on.
  async function mapPurchaseTo(group, canonicalName, catalogItemId) {
    setBusyId(group.key)
    try {
      const existing = mappings.find((m) => m.canonicalName === canonicalName)
      const pk = { vendor: group.vendor, itemCode: group.itemCode || null, upc: group.upc || null }
      const mapping = existing
        ? { ...existing, purchaseKeys: [...(existing.purchaseKeys || []), pk] }
        : newMappingDoc({ canonicalName, catalogItemId: catalogItemId || null, purchaseKeys: [pk], source: 'manual', createdBy: user?.email || 'unknown' })
      await writeMapping(orgId, mapping, user?.email || 'unknown')
      toast.success(`Mapped ${group.vendor} ${group.itemCode || group.upc} → ${canonicalName.slice(0, 26)}`)
      await load()
    } catch (e) { toast.error(e.message) }
    setBusyId(null)
  }
  async function markPurchaseCafe(group) {
    setBusyId(group.key)
    try {
      const nm = group.description || `${group.vendor} ${group.itemCode || group.upc}`
      const pk = { vendor: group.vendor, itemCode: group.itemCode || null, upc: group.upc || null }
      const m = newMappingDoc({ canonicalName: nm, purchaseKeys: [pk], status: 'cafe_use', source: 'manual', createdBy: user?.email || 'unknown' })
      await writeMapping(orgId, m, user?.email || 'unknown')
      toast.success(`${group.vendor} ${group.itemCode || group.upc} marked café-use — COGS only`)
      await load()
    } catch (e) { toast.error(e.message) }
    setBusyId(null)
  }

  const S = STYLES
  if (loading) return <div style={S.muted}>Loading item map…</div>

  const nextMilestone = stats.milestones.find((m) => m.pct > stats.coveredPct && m.reachable) || stats.milestones[stats.milestones.length - 1]

  return (
    <div style={S.wrap}>
      {/* Coverage indicator */}
      <div style={S.coverCard}>
        <div style={S.coverTop}>
          <div>
            <div style={S.coverPct}>{stats.coveredPct.toFixed(0)}%<span style={S.coverPctSub}> of sold units mapped</span></div>
            <div style={S.coverSub}>{mappedNames.size} items mapped · {stats.unmappedCount} unmapped ({stats.unmappedTailCount} in the ≤5-unit tail — optional)</div>
          </div>
          {nextMilestone && !nextMilestone.reachable === false && (
            <div style={S.milestone}>
              map <b>{nextMilestone.itemsNeeded}</b> more high-volume items → <b>{nextMilestone.pct}%</b> covered
            </div>
          )}
        </div>
        <div style={S.bar}><div style={{ ...S.barFill, width: `${Math.min(100, stats.coveredPct)}%` }} /></div>
      </div>

      {/* Ranked unmapped list */}
      <div style={S.listHead}>Unmapped sold items — highest volume first</div>
      {ranked.length === 0 && <div style={S.muted}>Everything's mapped. 🎉</div>}
      {ranked.slice(0, 120).map((it) => (
        <div key={it.name} style={S.row}>
          <div style={S.rank}>{it.rank}</div>
          <div style={S.qty} title="units sold">{it.qtySold}</div>
          <div style={S.name}>
            {it.name}
            <span style={S.cum}> · cumulative {it.cumPct.toFixed(0)}%</span>
          </div>
          <div style={S.actions}>
            {it.proposal ? (
              <button
                style={{ ...S.mapBtn, ...(it.variantRisk ? S.mapBtnRisk : {}) }}
                disabled={busyId === it.name}
                onClick={() => mapTo(it, it.proposal.name, it.proposal.id)}
                title={it.variantRisk ? 'Possible variant mismatch — confirm carefully' : 'Tap to confirm this mapping'}
              >
                {it.variantRisk ? 'map to? ' : 'map → '}<b>{String(it.proposal.name).slice(0, 26)}</b>
                {it.variantRisk && <span style={S.riskTag}>variant?</span>}
                <ChevronRight size={13} />
              </button>
            ) : (
              <span style={S.noProp}>no suggestion — search to map</span>
            )}
            <button style={S.cafeBtn} disabled={busyId === it.name} onClick={() => markCafe(it)} title="Café-use — exclude from shrinkage, keep in COGS">
              <Coffee size={13} /> café-use
            </button>
          </div>
        </div>
      ))}
      {ranked.length > 120 && <div style={S.muted}>+ {ranked.length - 120} more (lower volume — map later or leave)</div>}

      {/* Purchase-side unmapped — the destination for the import's "N new codes to review" */}
      {rankedPurchase.length > 0 && (
        <>
          <div style={{ ...S.listHead, marginTop: 22, display: 'flex', alignItems: 'center', gap: 6 }}>
            <Package size={13} /> Purchase codes to map — highest spend first ({rankedPurchase.length})
          </div>
          {rankedPurchase.slice(0, 80).map((g) => (
            <div key={g.key} style={S.row}>
              <div style={S.spend} title="spend across invoices">${g.spend.toFixed(0)}</div>
              <div style={S.name}>
                {g.description || '(no description)'}
                <span style={S.cum}> · {g.vendor} {g.itemCode || g.upc}{g.eaches ? ` · ${g.eaches} eaches` : ''}</span>
              </div>
              <div style={S.actions}>
                {g.proposal ? (
                  <button
                    style={{ ...S.mapBtn, ...(g.variantRisk ? S.mapBtnRisk : {}) }}
                    disabled={busyId === g.key}
                    onClick={() => mapPurchaseTo(g, g.proposal.name, g.proposal.id)}
                    title={g.variantRisk ? 'Possible variant mismatch — confirm carefully' : 'Tap to confirm — this code auto-resolves on every future invoice'}
                  >
                    {g.variantRisk ? 'map to? ' : 'map → '}<b>{String(g.proposal.name).slice(0, 26)}</b>
                    {g.variantRisk && <span style={S.riskTag}>variant?</span>}
                    <ChevronRight size={13} />
                  </button>
                ) : (
                  <span style={S.noProp}>no suggestion — search to map</span>
                )}
                <button style={S.cafeBtn} disabled={busyId === g.key} onClick={() => markPurchaseCafe(g)} title="Café-use / supply — keep in COGS, exclude from shrinkage">
                  <Coffee size={13} /> café-use
                </button>
              </div>
            </div>
          ))}
          {rankedPurchase.length > 80 && <div style={S.muted}>+ {rankedPurchase.length - 80} more (lower spend)</div>}
        </>
      )}
    </div>
  )
}

const STYLES = {
  wrap: { marginTop: 4 },
  muted: { fontSize: 13, color: '#94a3b8', padding: '10px 0' },
  coverCard: { border: '1px solid #e2e8f0', borderRadius: 12, padding: '14px 16px', background: '#f8fafc', marginBottom: 14 },
  coverTop: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' },
  coverPct: { fontSize: 26, fontWeight: 800, color: '#0f766e' },
  coverPctSub: { fontSize: 13, fontWeight: 600, color: '#64748b' },
  coverSub: { fontSize: 12, color: '#64748b', marginTop: 2 },
  milestone: { fontSize: 12, color: '#334155', background: '#fff', border: '1px solid #e2e8f0', borderRadius: 8, padding: '6px 10px' },
  bar: { height: 8, background: '#e2e8f0', borderRadius: 999, marginTop: 10, overflow: 'hidden' },
  barFill: { height: '100%', background: '#0f766e', borderRadius: 999, transition: 'width .3s' },
  listHead: { fontSize: 12, fontWeight: 700, color: '#475569', margin: '8px 0 6px' },
  row: { display: 'flex', alignItems: 'center', gap: 10, padding: '7px 8px', borderBottom: '1px solid #f1f5f9' },
  rank: { width: 26, fontSize: 11, color: '#94a3b8', textAlign: 'right' },
  qty: { width: 44, fontSize: 13, fontWeight: 700, color: '#0f172a', textAlign: 'right', fontVariantNumeric: 'tabular-nums' },
  spend: { width: 54, fontSize: 13, fontWeight: 700, color: '#0f766e', textAlign: 'right', fontVariantNumeric: 'tabular-nums' },
  name: { flex: 1, fontSize: 13, color: '#334155', minWidth: 0 },
  cum: { fontSize: 11, color: '#cbd5e1' },
  actions: { display: 'flex', gap: 6, alignItems: 'center', flexShrink: 0 },
  mapBtn: { display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 12, color: '#0f766e', background: '#f0fdfa', border: '1px solid #99f6e4', borderRadius: 8, padding: '4px 8px', cursor: 'pointer', maxWidth: 300 },
  mapBtnRisk: { color: '#92400e', background: '#fffbeb', border: '1px solid #fde68a' },
  riskTag: { fontSize: 10, background: '#fde68a', color: '#78350f', borderRadius: 4, padding: '0 4px', marginLeft: 4 },
  noProp: { fontSize: 11, color: '#cbd5e1', fontStyle: 'italic' },
  cafeBtn: { display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 12, color: '#64748b', background: '#fff', border: '1px solid #e2e8f0', borderRadius: 8, padding: '4px 8px', cursor: 'pointer' },
}
