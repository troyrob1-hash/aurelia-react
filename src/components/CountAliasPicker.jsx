// src/components/CountAliasPicker.jsx
//
// The COUNT-side alias picker. Inventory count docs don't carry the numeric catalogItemId
// — count lines are keyed by a per-location name-slug / custom id (verified: 0/252 real
// Wesley count lines carry the numeric id) — so a mapped item only attaches its
// Opening/Closing when the count NAME happens to equal the canonical name. This picker is
// how a human records the count-doc name that IS a given canonical when they DIFFER (count
// "Gatorade Lemon Lime" ↔ canonical "gatorade 20 oz lemon lime"), writing it to the
// canonical's countAliases[]. Same tap-to-confirm feel as the sold/purchase mapping.
//
// Per (location, period): list the counted lines that AREN'T yet attached to any
// canonical, each with a fuzzy-suggested canonical + a manual picker. Exact-name matches
// are auto-seeded on load (no manual step). Attach/detach are reversible.

import { useState, useEffect, useMemo } from 'react'
import { Link2, ChevronRight, X, Check } from 'lucide-react'
import { useAuthStore } from '@/store/authStore'
import { useLocations } from '@/store/LocationContext'
import { usePeriod } from '@/store/PeriodContext'
import { useToast } from '@/components/ui/Toast'
import { locId } from '@/lib/pnl'
import { writeCountAliases, countNameKeysFor, autoLinkCountAliases } from '@/lib/itemMap'
import { itemNameKey, isCounted, countEaches } from '@/lib/shrinkage'

export default function CountAliasPicker() {
  const { user } = useAuthStore()
  const orgId = user?.tenantId
  const actor = user?.email || 'unknown'
  const { visibleLocations } = useLocations()
  const { periodKey } = usePeriod()
  const toast = useToast()

  const locNames = useMemo(() => (visibleLocations || []).map((l) => l.name).sort(), [visibleLocations])
  const [locName, setLocName] = useState('')
  const [loading, setLoading] = useState(true)
  const [mappings, setMappings] = useState([])
  const [countItems, setCountItems] = useState([])   // [{ name, eaches }] — counted lines only
  const [proposals, setProposals] = useState({})     // itemNameKey(count) → { canonicalId, canonicalName, variantRisk, ambiguous }
  const [busy, setBusy] = useState(null)

  // default the location once the visible list resolves
  useEffect(() => { if (!locName && locNames.length) setLocName(locNames[0]) }, [locNames, locName])

  async function load() {
    if (!orgId || !periodKey || !locName) { setLoading(false); return }
    setLoading(true)
    try {
      // ONE shared engine (also used on-map by ItemMapUnmapped): applies exact + high-
      // confidence fuzzy countAliases, returns the fresh mappings + raw count items +
      // the ambiguous/variant proposals for the manual picker below.
      const { linked, proposals, mappings: maps, items } = await autoLinkCountAliases(orgId, locId(locName), periodKey, actor)
      const counted = items
        .filter((i) => i && i.name && isCounted(i))
        .map((i) => ({ name: i.name, eaches: countEaches(i) }))
      if (linked) toast.info(`Auto-linked ${linked} count line${linked > 1 ? 's' : ''} (exact + high-confidence)`)

      const propMap = {}
      for (const p of proposals) propMap[itemNameKey(p.countName)] = p

      setMappings([...maps])
      setCountItems(counted)
      setProposals(propMap)
    } catch (e) {
      console.error('count-alias load failed:', e)
      toast.error('Could not load counts for this location/period')
      setCountItems([])
    }
    setLoading(false)
  }
  useEffect(() => { load() }, [orgId, periodKey, locName])   // eslint-disable-line

  // Every count name-key already attached to SOME canonical (its own name + countAliases).
  const attachedKeys = useMemo(() => {
    const s = new Set()
    for (const m of mappings) for (const k of countNameKeysFor(m)) s.add(k)
    return s
  }, [mappings])

  // Unattached counted lines (the work queue). Rows WITH a fuzzy suggestion (variant-risk /
  // ambiguous / mid-confidence — tap to confirm) sort first; then alphabetical. The
  // suggestion is the plan's proposal (same matcher as the silent auto tier, minus the
  // guards that held it back), so what auto-attached and what's suggested stay consistent.
  const unattached = useMemo(() => countItems
    .filter((c) => !attachedKeys.has(itemNameKey(c.name)))
    .map((c) => ({ ...c, suggestion: proposals[itemNameKey(c.name)] || null }))
    .sort((a, b) => (Number(!!b.suggestion) - Number(!!a.suggestion)) || a.name.localeCompare(b.name)),
    [countItems, attachedKeys, proposals])

  // Attached aliases at THIS location — count lines present here that map via an alias
  // (not merely the coincidental canonical-name match). Shown so a mis-attach is reversible.
  const attachedHere = useMemo(() => {
    const countKeySet = new Set(countItems.map((c) => itemNameKey(c.name)))
    const nameByKey = new Map(countItems.map((c) => [itemNameKey(c.name), c.name]))
    const rows = []
    for (const m of mappings) {
      for (const a of m.countAliases || []) {
        const k = itemNameKey(a)
        if (countKeySet.has(k)) rows.push({ canonicalId: m.canonicalId, canonicalName: m.canonicalName, alias: a, shownName: nameByKey.get(k) || a })
      }
    }
    return rows.sort((x, y) => x.canonicalName.localeCompare(y.canonicalName))
  }, [mappings, countItems])

  async function attach(countName, canonicalId) {
    if (!canonicalId) return
    setBusy(countName)
    try {
      const m = mappings.find((x) => x.canonicalId === canonicalId)
      await writeCountAliases(orgId, canonicalId, [...(m?.countAliases || []), countName], actor)
      toast.success(`Linked "${countName.slice(0, 26)}" → ${m?.canonicalName.slice(0, 26)}`)
      await load()
    } catch (e) { toast.error(e.message) }
    setBusy(null)
  }
  async function detach(canonicalId, alias) {
    setBusy(alias)
    try {
      const m = mappings.find((x) => x.canonicalId === canonicalId)
      const next = (m?.countAliases || []).filter((a) => itemNameKey(a) !== itemNameKey(alias))
      await writeCountAliases(orgId, canonicalId, next, actor)
      toast.success(`Unlinked "${alias.slice(0, 26)}"`)
      await load()
    } catch (e) { toast.error(e.message) }
    setBusy(null)
  }

  const S = STYLES

  return (
    <div style={S.wrap}>
      <div style={S.head}>
        <div style={S.title}><Link2 size={14} /> Link count lines to items</div>
        <select style={S.locSel} value={locName} onChange={(e) => setLocName(e.target.value)}>
          {locNames.map((n) => <option key={n} value={n}>{n}</option>)}
        </select>
      </div>
      <p style={S.help}>
        Count docs don't carry the item's catalog id, so a counted line only shows Opening/Closing
        when its <b>name</b> matches. Tap the item a count line belongs to — that name is remembered
        (<code>countAliases</code>) so it attaches every period, even when the count name differs from the sold name.
      </p>

      {loading && <div style={S.muted}>Loading counts for {locName}…</div>}

      {!loading && countItems.length === 0 && (
        <div style={S.muted}>No inventory count for {locName} · {periodKey}. Count this period, then link.</div>
      )}

      {!loading && countItems.length > 0 && (
        <>
          <div style={S.listHead}>
            Count lines needing a match — {unattached.length} of {countItems.length} unlinked
          </div>
          {unattached.length === 0 && <div style={S.muted}>Every counted line is linked to an item. 🎉</div>}
          {unattached.slice(0, 150).map((c) => (
            <div key={c.name} style={S.row}>
              <div style={S.qty} title="eaches counted">{c.eaches}</div>
              <div style={S.name}>{c.name}</div>
              <div style={S.actions}>
                {c.suggestion && (
                  <button
                    style={{ ...S.mapBtn, ...((c.suggestion.variantRisk || c.suggestion.ambiguous) ? S.mapBtnRisk : {}) }}
                    disabled={busy === c.name}
                    onClick={() => attach(c.name, c.suggestion.canonicalId)}
                    title={c.suggestion.ambiguous ? 'Ambiguous — more than one item matches equally (size/variant). Confirm the right one.'
                      : c.suggestion.variantRisk ? 'Possible variant mismatch — confirm carefully' : 'Tap to link this count line to that item'}
                  >
                    {(c.suggestion.variantRisk || c.suggestion.ambiguous) ? 'link to? ' : 'link → '}<b>{String(c.suggestion.canonicalName).slice(0, 24)}</b>
                    {c.suggestion.ambiguous ? <span style={S.riskTag}>ambiguous</span> : c.suggestion.variantRisk ? <span style={S.riskTag}>variant?</span> : null}
                    <ChevronRight size={13} />
                  </button>
                )}
                <select
                  style={S.pickSel}
                  disabled={busy === c.name}
                  value=""
                  onChange={(e) => { if (e.target.value) attach(c.name, e.target.value) }}
                  title="Pick the item this count line is"
                >
                  <option value="">{c.suggestion ? 'or pick…' : 'pick item…'}</option>
                  {mappings.slice().sort((a, b) => a.canonicalName.localeCompare(b.canonicalName)).map((m) => (
                    <option key={m.canonicalId} value={m.canonicalId}>{m.canonicalName}</option>
                  ))}
                </select>
              </div>
            </div>
          ))}
          {unattached.length > 150 && <div style={S.muted}>+ {unattached.length - 150} more (lower count)</div>}

          {attachedHere.length > 0 && (
            <>
              <div style={{ ...S.listHead, marginTop: 20 }}>
                <Check size={12} style={{ verticalAlign: -1 }} /> Linked here ({attachedHere.length}) — tap × to correct
              </div>
              {attachedHere.map((r) => (
                <div key={`${r.canonicalId}__${r.alias}`} style={S.attRow}>
                  <div style={S.name}>{r.shownName} <span style={S.arrow}>→</span> <b style={S.canon}>{r.canonicalName}</b></div>
                  <button style={S.detach} disabled={busy === r.alias} onClick={() => detach(r.canonicalId, r.alias)} title="Unlink">
                    <X size={13} />
                  </button>
                </div>
              ))}
            </>
          )}
        </>
      )}
    </div>
  )
}

const STYLES = {
  wrap: { marginTop: 22, borderTop: '1px solid #e2e8f0', paddingTop: 16 },
  head: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' },
  title: { display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, fontWeight: 700, color: '#475569' },
  locSel: { fontSize: 12, color: '#334155', border: '1px solid #cbd5e1', borderRadius: 8, padding: '5px 8px', background: '#fff', maxWidth: 240 },
  help: { fontSize: 12, color: '#64748b', lineHeight: 1.5, margin: '8px 0 12px', maxWidth: 680 },
  muted: { fontSize: 13, color: '#94a3b8', padding: '10px 0' },
  listHead: { fontSize: 12, fontWeight: 700, color: '#475569', margin: '8px 0 6px' },
  row: { display: 'flex', alignItems: 'center', gap: 10, padding: '7px 8px', borderBottom: '1px solid #f1f5f9' },
  qty: { width: 44, fontSize: 13, fontWeight: 700, color: '#0f172a', textAlign: 'right', fontVariantNumeric: 'tabular-nums' },
  name: { flex: 1, fontSize: 13, color: '#334155', minWidth: 0 },
  actions: { display: 'flex', gap: 6, alignItems: 'center', flexShrink: 0 },
  mapBtn: { display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 12, color: '#0f766e', background: '#f0fdfa', border: '1px solid #99f6e4', borderRadius: 8, padding: '4px 8px', cursor: 'pointer', maxWidth: 280 },
  mapBtnRisk: { color: '#92400e', background: '#fffbeb', border: '1px solid #fde68a' },
  riskTag: { fontSize: 10, background: '#fde68a', color: '#78350f', borderRadius: 4, padding: '0 4px', marginLeft: 4 },
  pickSel: { fontSize: 12, color: '#334155', border: '1px solid #e2e8f0', borderRadius: 8, padding: '4px 6px', background: '#fff', maxWidth: 180 },
  attRow: { display: 'flex', alignItems: 'center', gap: 10, padding: '6px 8px', borderBottom: '1px solid #f1f5f9', background: '#f8fafc' },
  arrow: { color: '#cbd5e1' },
  canon: { color: '#0f766e' },
  detach: { display: 'inline-flex', alignItems: 'center', color: '#94a3b8', background: '#fff', border: '1px solid #e2e8f0', borderRadius: 8, padding: '3px 6px', cursor: 'pointer', flexShrink: 0 },
}
