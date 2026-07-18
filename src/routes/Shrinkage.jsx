// src/routes/Shrinkage.jsx
//
// Home for the SHRINKAGE track (packaged-goods: sold-unit == counted-unit ==
// purchased-unit, no recipe math). Built incrementally:
//   1. SOLD feed  — import the Cafe Product Mix export → salesItems  ← HERE NOW
//   2. Item map   — sold ↔ catalog (catalog-seed, since invoices are GL-totals)
//   3. Unit norm  — pack/each normalization
//   4. Shrinkage  — bought − sold − counted variance
// Only Increment 1 (the import) is wired today; 2–4 land on this same view.
import CafeProductMixImport from '@/components/CafeProductMixImport'
import ItemMapUnmapped from '@/components/ItemMapUnmapped'

export default function Shrinkage() {
  const S = STYLES
  return (
    <div style={S.wrap}>
      <div style={S.head}>
        <div>
          <h1 style={S.h1}>Shrinkage</h1>
          <p style={S.sub}>
            Reconciles what was <b>sold</b> (POS) against what was <b>counted</b> (inventory) and
            <b> purchased</b> (invoices) — packaged goods first, where the sold unit is the counted unit.
          </p>
        </div>
        <div style={S.actions}>
          <CafeProductMixImport />
        </div>
      </div>

      <div style={S.card}>
        <div style={S.step}>Increment 1 · Sold feed</div>
        <p style={S.body}>
          Import the <b>Cafe Product Mix</b> export to load per-item, per-week POS sales into the
          <code style={S.code}>salesItems</code> feed, keyed to the same location IDs inventory uses.
          The importer shows a mandatory preview (doc counts, unit conservation, unmapped accounts,
          slug merges) and only writes on confirm.
        </p>
        <p style={S.next}>
          Increments 3–4 (unit normalization, the shrinkage variance) build out here.
        </p>
      </div>

      <div style={S.card}>
        <div style={S.step}>Increment 2 · Item map</div>
        <p style={S.body}>
          Sold items and purchase lines auto-map by name/code — no approval queue. What
          didn't auto-map lands here, ranked by sales volume so you map the items that
          matter first. Coverage tells you when the tail goes optional.
        </p>
        <ItemMapUnmapped />
      </div>
    </div>
  )
}

const STYLES = {
  wrap: { padding: '20px 24px', maxWidth: 1100, margin: '0 auto' },
  head: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap' },
  h1: { fontSize: 22, fontWeight: 800, color: '#0f172a', margin: 0 },
  sub: { fontSize: 13, color: '#64748b', margin: '6px 0 0', maxWidth: 640, lineHeight: 1.5 },
  actions: { display: 'flex', gap: 8, alignItems: 'center' },
  card: { marginTop: 20, border: '1px solid #e2e8f0', borderRadius: 12, padding: '16px 18px', background: '#fff' },
  step: { fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.04em', color: '#0f766e' },
  body: { fontSize: 13, color: '#334155', lineHeight: 1.55, margin: '8px 0 0' },
  next: { fontSize: 12, color: '#94a3b8', margin: '10px 0 0' },
  code: { fontFamily: 'ui-monospace, monospace', fontSize: 12, background: '#f1f5f9', padding: '1px 5px', borderRadius: 4, margin: '0 2px' },
}
