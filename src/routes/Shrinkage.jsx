// src/routes/Shrinkage.jsx
//
// Two views under one route, switched by a link at the top:
//   PAGE 1 · Shrinkage (default) — the WORKING page: the variance table (KPIs + Item ·
//            Opening · +Purchased · −Sold · Closing · Shrinkage · $Lost) plus Import Sales.
//            Import and read-variance both happen here. Uncluttered — nothing else.
//   PAGE 2 · Mapping — ONLY the decision queue: unmapped sold items (by volume) + purchase
//            codes (by spend) with map/café-use actions, plus the coverage indicator.
//            NO import control (importing lives on page 1).
// The "Mapping (N need review)" link carries the count so it's clear when there's
// something to approve. ItemMapUnmapped stays mounted (hidden on page 1) purely to keep
// that count live without opening the page; it reports via onCount.
import { useState } from 'react'
import { ArrowRight, ArrowLeft } from 'lucide-react'
import ShrinkageTable from '@/components/ShrinkageTable'
import CafeProductMixImport from '@/components/CafeProductMixImport'
import ItemMapUnmapped from '@/components/ItemMapUnmapped'

export default function Shrinkage() {
  const [view, setView] = useState('shrinkage')   // 'shrinkage' | 'mapping'
  const [needCount, setNeedCount] = useState(null) // unmapped items needing a decision
  const S = STYLES
  const mapping = view === 'mapping'

  return (
    <div style={S.wrap}>
      <div style={S.head}>
        <div>
          <h1 style={S.h1}>{mapping ? 'Mapping' : 'Shrinkage'}</h1>
          <p style={S.sub}>
            {mapping
              ? 'Items needing a decision — map each to a sold item, or mark café-use. Mapping an item lights up its row in the variance table.'
              : <>What was <b>sold</b> (POS) vs <b>purchased</b> (invoices) vs <b>counted</b> (inventory) — per item, per period.</>}
          </p>
        </div>
        <div style={S.actions}>
          {mapping ? (
            <button style={S.link} onClick={() => setView('shrinkage')}><ArrowLeft size={14} /> Shrinkage</button>
          ) : (
            <>
              <CafeProductMixImport />
              <button style={S.link} onClick={() => setView('mapping')}>
                Mapping{needCount != null && needCount > 0 ? ` (${needCount} need review)` : ''} <ArrowRight size={14} />
              </button>
            </>
          )}
        </div>
      </div>

      {/* PAGE 1 — variance table (the working page) */}
      {!mapping && <ShrinkageTable />}

      {/* Mapping list — shown only on page 2, but kept mounted (hidden on page 1) so the
          "N need review" badge stays live. onCount feeds the badge above. */}
      <div style={{ display: mapping ? 'block' : 'none' }}>
        <ItemMapUnmapped onCount={setNeedCount} />
      </div>
    </div>
  )
}

const STYLES = {
  wrap: { padding: '20px 24px', maxWidth: 1100, margin: '0 auto' },
  head: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap', marginBottom: 18 },
  h1: { fontSize: 22, fontWeight: 800, color: '#0f172a', margin: 0 },
  sub: { fontSize: 13, color: '#64748b', margin: '6px 0 0', maxWidth: 640, lineHeight: 1.5 },
  actions: { display: 'flex', gap: 10, alignItems: 'center', flexShrink: 0 },
  link: { display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 13, fontWeight: 600, color: '#0f766e', background: '#f0fdfa', border: '1px solid #99f6e4', borderRadius: 8, padding: '7px 12px', cursor: 'pointer' },
}
