// src/routes/Shrinkage.jsx
//
// Home for the SHRINKAGE track. Two tabs on ONE page:
//   • VARIANCE (default) — the real per-item variance table: opening + purchased − sold
//     − closing = shrinkage, joined across the three feeds via the itemMap canonical.
//   • MAPPING — Import Sales + the coverage indicator + the unmapped sold/purchase lists
//     that FEED the variance table (sold ← Product Mix, purchased ← resolved invoices).
// A manager sees shrinkage AND fixes the mappings that drive it, in one place.
import { useState } from 'react'
import ShrinkageTable from '@/components/ShrinkageTable'
import CafeProductMixImport from '@/components/CafeProductMixImport'
import ItemMapUnmapped from '@/components/ItemMapUnmapped'

export default function Shrinkage() {
  const [tab, setTab] = useState('variance')   // 'variance' | 'mapping'
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
        <div style={S.actions}>
          {tab === 'mapping' && <CafeProductMixImport />}
        </div>
      </div>

      <div style={S.tabs}>
        <button style={{ ...S.tab, ...(tab === 'variance' ? S.tabOn : {}) }} onClick={() => setTab('variance')}>Variance</button>
        <button style={{ ...S.tab, ...(tab === 'mapping' ? S.tabOn : {}) }} onClick={() => setTab('mapping')}>Mapping &amp; import</button>
      </div>

      {tab === 'variance' ? (
        <ShrinkageTable />
      ) : (
        <div>
          <p style={S.body}>
            Sold items and purchase codes auto-map on import; what didn't auto-map lands
            here, ranked by volume/spend. Mapping an item lights up its row in the Variance
            tab (Sold ← Product Mix, Purchased ← resolved invoice lines).
          </p>
          <ItemMapUnmapped />
        </div>
      )}
    </div>
  )
}

const STYLES = {
  wrap: { padding: '20px 24px', maxWidth: 1100, margin: '0 auto' },
  head: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap' },
  h1: { fontSize: 22, fontWeight: 800, color: '#0f172a', margin: 0 },
  sub: { fontSize: 13, color: '#64748b', margin: '6px 0 0', maxWidth: 640, lineHeight: 1.5 },
  actions: { display: 'flex', gap: 8, alignItems: 'center' },
  tabs: { display: 'flex', gap: 4, margin: '16px 0 18px', borderBottom: '1px solid #e2e8f0' },
  tab: { padding: '8px 16px', fontSize: 13, fontWeight: 600, color: '#64748b', background: 'none', border: 'none', borderBottom: '2px solid transparent', cursor: 'pointer', marginBottom: -1 },
  tabOn: { color: '#0f766e', borderBottom: '2px solid #0f766e' },
  body: { fontSize: 13, color: '#334155', lineHeight: 1.55, margin: '0 0 14px', maxWidth: 720 },
}
