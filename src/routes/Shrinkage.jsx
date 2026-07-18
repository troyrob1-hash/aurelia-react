// src/routes/Shrinkage.jsx
//
// The SHRINKAGE page — ONE stacked view, no tabs. Shrinkage and the mapping/import that
// drives it are one job, not two modes:
//   TOP:    KPI cards + the per-item variance table (opening + purchased − sold − closing
//           = shrinkage, joined across the three feeds via the itemMap canonical).
//   BELOW:  Import Sales + the mapping section (coverage, unmapped sold items, purchase
//           codes to map). Keeping it visible under the table surfaces WHY rows are
//           incomplete — an unmapped item is right there, not hidden behind a tab.
import ShrinkageTable from '@/components/ShrinkageTable'
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
            What was <b>sold</b> (POS) vs <b>purchased</b> (invoices) vs <b>counted</b> (inventory) —
            per item, per period. Packaged goods, where the sold unit is the counted unit.
          </p>
        </div>
      </div>

      {/* Main view — KPI cards + variance table */}
      <ShrinkageTable />

      {/* Below the table — import + mapping that FEED the rows above */}
      <div style={S.mapSection}>
        <div style={S.mapHead}>
          <div>
            <h2 style={S.h2}>Import &amp; mapping</h2>
            <p style={S.body}>
              Sold items and purchase codes auto-map on import; what didn't auto-map lands
              here, ranked by volume/spend. Mapping an item lights up its row above
              (Sold ← Product Mix, Purchased ← resolved invoice lines) — so an unmapped
              item is why a row reads incomplete.
            </p>
          </div>
          <div style={S.actions}><CafeProductMixImport /></div>
        </div>
        <ItemMapUnmapped />
      </div>
    </div>
  )
}

const STYLES = {
  wrap: { padding: '20px 24px', maxWidth: 1100, margin: '0 auto' },
  head: { marginBottom: 18 },
  h1: { fontSize: 22, fontWeight: 800, color: '#0f172a', margin: 0 },
  h2: { fontSize: 16, fontWeight: 800, color: '#0f172a', margin: 0 },
  sub: { fontSize: 13, color: '#64748b', margin: '6px 0 0', maxWidth: 640, lineHeight: 1.5 },
  actions: { display: 'flex', gap: 8, alignItems: 'center', flexShrink: 0 },
  mapSection: { marginTop: 32, paddingTop: 24, borderTop: '1px solid #e2e8f0' },
  mapHead: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap', marginBottom: 8 },
  body: { fontSize: 13, color: '#334155', lineHeight: 1.55, margin: '6px 0 0', maxWidth: 720 },
}
