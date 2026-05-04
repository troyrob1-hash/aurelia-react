import { useState, useRef, useCallback } from 'react'

const APIS = [
  { id:'sysco', n:'Sysco', c:'#185FA5', bg:'#E6F1FB', ic:'#B5D4F4', tc:'#0C447C', s:'planned', m:'Pricing API — real-time catalog sync',
    f:[{d:'in',t:'Order Hub',x:'Product catalog + pricing'},{d:'in',t:'Inventory',x:'Pack sizes + unit costs'},{d:'out',t:'Order Hub',x:'Submit purchase orders'}]},
  { id:'usfoods', n:'US Foods', c:'#185FA5', bg:'#E6F1FB', ic:'#B5D4F4', tc:'#0C447C', s:'planned', m:'Pricing API — catalog + ordering',
    f:[{d:'in',t:'Order Hub',x:'Product catalog + pricing'},{d:'in',t:'Inventory',x:'Pack sizes + unit costs'},{d:'out',t:'Order Hub',x:'Submit purchase orders'}]},
  { id:'mosaic', n:'Mosaic', c:'#0F6E56', bg:'#E1F5EE', ic:'#9FE1CB', tc:'#085041', s:'connected', m:'Last import: GL labor export',
    f:[{d:'in',t:'Labor',x:'GL labor data import'}]},
  { id:'7shifts', n:'7shifts', c:'#0F6E56', bg:'#E1F5EE', ic:'#9FE1CB', tc:'#085041', s:'planned', m:'Schedule + timesheet sync',
    f:[{d:'in',t:'Labor',x:'Scheduled vs actual hours'}]},
  { id:'spartan', n:'Spartan POS', c:'#993C1D', bg:'#FAECE7', ic:'#F5C4B3', tc:'#712B13', s:'planned', m:'Register API — SKU + daily totals',
    f:[{d:'in',t:'Sales',x:'Daily register totals'},{d:'in',t:'Shrinkage',x:'SKU-level sold quantities'}]},
  { id:'fooda', n:'Fooda Events', c:'#993556', bg:'#FBEAF0', ic:'#F4C0D1', tc:'#72243E', s:'connected', m:'Last import: event export file',
    f:[{d:'in',t:'Sales',x:'Popup + catering event data'}]},
  { id:'claude', n:'Claude AI', c:'#854F0B', bg:'#FAEEDA', ic:'#FAC775', tc:'#633806', s:'connected', m:'Anthropic API — live',
    f:[{d:'in',t:'Chatbot',x:'Financial Q&A + insights'},{d:'in',t:'Purchasing',x:'PDF invoice parsing'},{d:'out',t:'Chatbot',x:'Reports + forecasts'}]},
  { id:'netsuite', n:'NetSuite', c:'#534AB7', bg:'#EEEDFE', ic:'#CECBF6', tc:'#3C3489', s:'planned', m:'GL sync — journal + AP export',
    f:[{d:'in',t:'Purchasing',x:'Approved invoice sync'},{d:'out',t:'Ledger',x:'Export journal entries'},{d:'out',t:'P&L',x:'Export P&L actuals'}]},
  { id:'quickbooks', n:'QuickBooks', c:'#3B6D11', bg:'#EAF3DE', ic:'#C0DD97', tc:'#27500A', s:'planned', m:'Financial export integration',
    f:[{d:'out',t:'P&L',x:'Export financials'},{d:'out',t:'Purchasing',x:'Export AP'}]},
]

const TABS = [
  { id:'orderhub', n:'Orders', c:'#1D9E75', side:'left', m:'452 catalog items loaded',
    f:[{d:'from',t:'Sysco',x:'Catalog + pricing'},{d:'from',t:'US Foods',x:'Catalog + pricing'},{d:'to',t:'Purchasing',x:'Order \u2192 invoice'}]},
  { id:'inventory', n:'Inventory', c:'#1D9E75', side:'left', m:'452 items in catalog',
    f:[{d:'from',t:'Sysco',x:'Pack sizes + costs'},{d:'to',t:'Shrinkage',x:'Opening/closing counts'}]},
  { id:'labor', n:'Labor', c:'#7F77DD', side:'left', m:'Mosaic import active',
    f:[{d:'from',t:'Mosaic',x:'GL labor data'},{d:'from',t:'7shifts',x:'Hours data'},{d:'to',t:'P&L',x:'Labor costs'}]},
  { id:'sales', n:'Sales', c:'#D4537E', side:'left', m:'Event import active',
    f:[{d:'from',t:'Spartan POS',x:'Register totals'},{d:'from',t:'Fooda Events',x:'Event data'},{d:'to',t:'P&L',x:'Revenue data'}]},
  { id:'shrinkage', n:'Shrinkage', c:'#BA7517', side:'left', m:'POS data needed',
    f:[{d:'from',t:'Spartan POS',x:'SKU sold qty'},{d:'from',t:'Inventory',x:'Count data'},{d:'to',t:'P&L',x:'Shrinkage loss'}]},
  { id:'chatbot', n:'Chatbot', c:'#888780', side:'right', m:'Claude Sonnet 4 — active',
    f:[{d:'from',t:'Claude AI',x:'AI engine'},{d:'to',t:'Claude AI',x:'Reports + forecasts'}]},
  { id:'pnl', n:'P&L', c:'#F15D3B', side:'right', m:'Central financial hub',
    f:[{d:'from',t:'Sales',x:'Revenue'},{d:'from',t:'Labor',x:'Labor costs'},{d:'from',t:'Purchasing',x:'AP costs'},{d:'from',t:'Shrinkage',x:'Shrinkage loss'},{d:'from',t:'Budgets',x:'Budget data'},{d:'to',t:'NetSuite',x:'Export actuals'},{d:'to',t:'QuickBooks',x:'Export financials'}]},
  { id:'purchasing', n:'Purchasing', c:'#378ADD', side:'right', m:'AI parsing active',
    f:[{d:'from',t:'Claude AI',x:'PDF parsing'},{d:'from',t:'Order Hub',x:'Orders \u2192 invoices'},{d:'to',t:'P&L',x:'AP costs'},{d:'to',t:'NetSuite',x:'Invoice sync'}]},
  { id:'ledger', n:'Ledger', c:'#378ADD', side:'right', m:'JE export ready',
    f:[{d:'to',t:'NetSuite',x:'Export journal entries'}]},
  { id:'budgets', n:'Budgets', c:'#639922', side:'right', m:'FY2026 budget loaded',
    f:[{d:'to',t:'P&L',x:'Budget targets'}]},
]

// Positions
const HUB = { x: 350, y: 280 }
const API_POS = {
  sysco:{ x:100, y:68 }, usfoods:{ x:90, y:148 }, mosaic:{ x:95, y:265 },
  '7shifts':{ x:100, y:340 }, spartan:{ x:90, y:415 }, fooda:{ x:85, y:490 },
  claude:{ x:600, y:85 }, netsuite:{ x:600, y:200 }, quickbooks:{ x:600, y:370 },
}
const TAB_POS = {
  orderhub:{ x:248, y:115 }, inventory:{ x:248, y:185 }, labor:{ x:248, y:330 },
  sales:{ x:248, y:400 }, shrinkage:{ x:258, y:470 },
  chatbot:{ x:453, y:125 }, pnl:{ x:443, y:175 }, purchasing:{ x:443, y:228 },
  ledger:{ x:443, y:310 }, budgets:{ x:398, y:460 },
}

// Connection data
const API_CONNS = [
  ['sysco','orderhub','#85B7EB',true], ['sysco','inventory','#85B7EB',false],
  ['usfoods','orderhub','#85B7EB',false], ['usfoods','inventory','#85B7EB',false],
  ['mosaic','labor','#5DCAA5',true], ['7shifts','labor','#5DCAA5',false],
  ['spartan','sales','#F0997B',false], ['spartan','shrinkage','#F0997B',false],
  ['fooda','sales','#ED93B1',true],
  ['claude','chatbot','#FAC775',true], ['claude','purchasing','#FAC775',false],
  ['netsuite','purchasing','#AFA9EC',false], ['netsuite','ledger','#AFA9EC',false],
  ['quickbooks','purchasing','#C0DD97',false],
]
const TAB_CONNS = [
  ['labor','pnl'], ['sales','pnl'], ['purchasing','pnl'],
  ['shrinkage','pnl'], ['budgets','pnl'], ['orderhub','purchasing'], ['inventory','shrinkage'],
]
const OUTBOUND = [
  ['pnl','netsuite','#AFA9EC'], ['pnl','quickbooks','#C0DD97'], ['ledger','netsuite','#AFA9EC'],
]

function curve(x1,y1,x2,y2) {
  const dx = Math.abs(x2 - x1) * 0.35
  return `M${x1},${y1} C${x1+dx},${y1} ${x2-dx},${y2} ${x2},${y2}`
}

export default function IntegrationMapTab() {
  const [active, setActive] = useState(null)
  const [detail, setDetail] = useState(null)
  const svgRef = useRef(null)
  const wrapRef = useRef(null)

  const allInfo = {}
  APIS.forEach(a => { allInfo[a.id] = a })
  TABS.forEach(t => { allInfo[t.id] = t })

  function getRelated(id) {
    const s = new Set([id])
    API_CONNS.forEach(([a,b]) => { if (a===id) s.add(b); if (b===id) s.add(a) })
    TAB_CONNS.forEach(([a,b]) => { if (a===id) s.add(b); if (b===id) s.add(a) })
    OUTBOUND.forEach(([a,b]) => { if (a===id) s.add(b); if (b===id) s.add(a) })
    // Hub lines
    if (TABS.find(t => t.id === id)) s.add('hub')
    if (id === 'hub') TABS.forEach(t => s.add(t.id))
    return s
  }

  function handleClick(id, px, py) {
    if (active === id) { setActive(null); setDetail(null); return }
    setActive(id)
    const d = allInfo[id]
    if (!d) return
    const svg = svgRef.current?.getBoundingClientRect()
    const wrap = wrapRef.current?.getBoundingClientRect()
    if (!svg || !wrap) return
    const sx = svg.width / 700, sy = svg.height / 580
    let left = px * sx + svg.left - wrap.left
    let top = py * sy
    if (left > svg.width / 2) left -= 280; else left += 30
    if (top + 250 > svg.height) top = svg.height - 260
    if (top < 0) top = 10
    setDetail({ ...d, left, top })
  }

  const related = active ? getRelated(active) : null

  function isConnActive(a, b) {
    if (!active) return false
    return (a === active || b === active)
  }

  function isDim(id) {
    if (!active) return false
    return !related.has(id)
  }

  return (
    <div>
      <div style={{ marginBottom: 16 }}>
        <h2 style={{ fontSize: 18, fontWeight: 600, margin: 0 }}>Integration map</h2>
        <p style={{ fontSize: 13, color: '#64748b', margin: '4px 0 0' }}>Hover to highlight. Click any node for details.</p>
      </div>

      <div ref={wrapRef} style={{ position: 'relative', border: '1px solid #e2e8f0', borderRadius: 14, overflow: 'hidden' }}>
        <svg ref={svgRef} width="100%" viewBox="0 0 680 560" style={{ display: 'block', background: '#f9fafb' }}>
          <defs>
            <marker id="ah" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto">
              <path d="M2 2L8 5L2 8" fill="none" stroke="context-stroke" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
            </marker>
          </defs>

          {/* Hub radial lines — every tab to Aurelia */}
          {TABS.map(tab => {
            const tp = TAB_POS[tab.id]
            if (!tp) return null
            const act = active === 'hub' || active === tab.id
            return (
              <line key={'hub-'+tab.id} x1={tp.x + 30} y1={tp.y} x2={HUB.x} y2={HUB.y}
                stroke="#F15D3B" strokeWidth={act ? 1.5 : 0.4}
                opacity={active ? (act ? 0.4 : 0.03) : 0.08}
                style={{ transition: 'all 0.3s' }}
              />
            )
          })}

          {/* API connections */}
          {API_CONNS.map(([apiId, tabId, color, animated], i) => {
            const ap = API_POS[apiId], tp = TAB_POS[tabId]
            if (!ap || !tp) return null
            const act = isConnActive(apiId, tabId)
            const rightSide = ap.x > 400
            const ax = rightSide ? ap.x - 50 : ap.x + 50
            const tx = rightSide ? tp.x + 50 : tp.x
            return (
              <g key={'api-'+i}>
                <path d={curve(ax,ap.y,tx,tp.y)} fill="none" stroke={act ? color : '#D3D1C7'}
                  strokeWidth={act ? 2.5 : 1.2} opacity={active ? (act ? 0.8 : 0.03) : 0.3}
                  markerEnd="url(#ah)" style={{ transition: 'all 0.3s' }}/>
                {animated && <path d={curve(ax,ap.y,tx,tp.y)} fill="none" stroke={color}
                  strokeWidth={0.8} opacity={active ? (act ? 0.3 : 0) : 0.15}
                  strokeDasharray="8 8" style={{ animation: 'flowR 1.2s linear infinite' }}/>}
              </g>
            )
          })}

          {/* Outbound connections */}
          {OUTBOUND.map(([tabId, apiId, color], i) => {
            const tp = TAB_POS[tabId], ap = API_POS[apiId]
            if (!tp || !ap) return null
            const act = isConnActive(tabId, apiId)
            return (
              <path key={'out-'+i} d={curve(tp.x+50,tp.y,ap.x-50,ap.y)} fill="none"
                stroke={act ? color : '#D3D1C7'} strokeWidth={act ? 2 : 0.8}
                opacity={active ? (act ? 0.6 : 0.03) : 0.2}
                strokeDasharray="4 4" markerEnd="url(#ah)" style={{ transition: 'all 0.3s' }}/>
            )
          })}

          {/* Internal tab-to-tab */}
          {TAB_CONNS.map(([a, b], i) => {
            const pa = TAB_POS[a], pb = TAB_POS[b]
            if (!pa || !pb) return null
            const act = isConnActive(a, b)
            return (
              <path key={'int-'+i} d={curve(pa.x+30,pa.y,pb.x,pb.y)} fill="none"
                stroke={act ? '#888780' : '#D3D1C7'} strokeWidth={act ? 1.5 : 0.6}
                opacity={active ? (act ? 0.5 : 0.03) : 0.12}
                strokeDasharray="4 4" markerEnd="url(#ah)" style={{ transition: 'all 0.3s' }}/>
            )
          })}

          {/* AURELIA HUB */}
          <g style={{ cursor: 'pointer' }} onClick={() => handleClick('hub', HUB.x, HUB.y)}
            onMouseEnter={() => !active && setActive('hub')} onMouseLeave={() => active === 'hub' && setActive(null)}>
            <circle cx={HUB.x} cy={HUB.y} r={44} fill="none" stroke="#F15D3B" strokeWidth={1}
              opacity={active === 'hub' ? 0.4 : 0.15}/>
            <circle cx={HUB.x} cy={HUB.y} r={36} fill="#F15D3B"/>
            <circle cx={HUB.x} cy={HUB.y} r={28} fill="none" stroke="#fff" strokeWidth={0.5} opacity={0.3}/>
            <svg x={HUB.x-12} y={HUB.y-14} width="24" height="24" viewBox="0 0 32 32">
              <path d="M16 6 L26 27 L21 27 L19 22.5 L13 22.5 L11 27 L6 27 Z M14.3 18.5 L17.7 18.5 L16 14.8 Z" fill="#ffffff"/>
            </svg>
            
          </g>

          {/* EXTERNAL SERVICE NODES */}
          {APIS.map(api => {
            const p = API_POS[api.id]
            if (!p) return null
            const right = p.x > 400
            const w = Math.max(api.n.length * 7 + 20, 80)
            const rx = right ? p.x - w/2 : p.x - w/2
            return (
              <g key={api.id} className="nd" style={{ opacity: isDim(api.id) ? 0.07 : 1, cursor: 'pointer', transition: 'opacity 0.3s' }}
                onClick={() => handleClick(api.id, p.x, p.y)} data-id={api.id}>
                <rect x={rx} y={p.y - 16} width={w} height={32} rx={6}
                  fill={api.bg} stroke={api.ic} strokeWidth={0.5}/>
                {right ? (
                  <>
                    <text x={rx + w/2} y={p.y} textAnchor="middle" dominantBaseline="central"
                      fill={api.tc} style={{ fontSize: api.n.length > 10 ? 9 : 11, fontWeight: 500 }}>{api.n}</text>
                  </>
                ) : (
                  <>
                    <text x={rx + w/2} y={p.y} textAnchor="middle" dominantBaseline="central"
                      fill={api.tc} style={{ fontSize: api.n.length > 10 ? 9 : 11, fontWeight: 500 }}>{api.n}</text>
                  </>
                )}
                {api.s === 'connected' && (
                  <circle cx={right ? rx + 6 : rx + w - 6} cy={p.y - 12} r={3.5} fill="#059669"/>
                )}
              </g>
            )
          })}

          {/* TAB NODES */}
          {TABS.map(tab => {
            const p = TAB_POS[tab.id]
            if (!p) return null
            const w = Math.max(tab.n.length * 7.5 + 16, 58)
            const right = tab.side === 'right'
            return (
              <g key={tab.id} style={{ opacity: isDim(tab.id) ? 0.07 : 1, cursor: 'pointer', transition: 'opacity 0.3s' }}
                onClick={() => handleClick(tab.id, p.x + w/2, p.y)} data-id={tab.id}>
                <rect x={p.x} y={p.y - 14} width={w} height={28} rx={6}
                  fill="#fff" stroke="#e2e8f0" strokeWidth={0.5}/>
                <rect x={right ? p.x + w - 3 : p.x} y={p.y - 14} width={3} height={28} rx={1} fill={tab.c}/>
                <text x={p.x + w/2} y={p.y} textAnchor="middle" dominantBaseline="central"
                  fill="#0f172a" style={{ fontSize: tab.n.length > 8 ? 9 : 10, fontWeight: 500 }}>{tab.n}</text>
              </g>
            )
          })}
        </svg>

        {/* Detail panel */}
        {detail && (
          <div style={{
            position: 'absolute', width: 270, background: '#fff',
            border: '1px solid #e2e8f0', borderRadius: 10,
            boxShadow: '0 12px 40px rgba(0,0,0,0.12)',
            padding: '16px 18px', zIndex: 10,
            left: detail.left, top: detail.top,
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
              <div>
                <div style={{ fontSize: 14, fontWeight: 700, color: '#0f172a' }}>{detail.n}</div>
                <span style={{ fontSize: 11, color: detail.s === 'connected' ? '#059669' : detail.s === 'planned' ? '#94a3b8' : detail.c }}>
                  {detail.s === 'connected' ? '\u25cf Connected' : detail.s === 'planned' ? '\u25cb Planned' : '\u25a0 Aurelia tab'}
                </span>
              </div>
              <button onClick={() => { setActive(null); setDetail(null) }}
                style={{ background: 'none', border: 'none', fontSize: 16, color: '#94a3b8', cursor: 'pointer', padding: 0 }}>{'\u2715'}</button>
            </div>

            {detail.f?.filter(f => f.d === 'in' || f.d === 'from').length > 0 && (
              <>
                <div style={{ fontSize: 9, fontWeight: 600, color: '#059669', textTransform: 'uppercase', margin: '10px 0 5px' }}>Inbound</div>
                {detail.f.filter(f => f.d === 'in' || f.d === 'from').map((f, i) => (
                  <div key={i} style={{ padding: '6px 10px', background: '#f0fdf4', borderRadius: 6, fontSize: 11, marginBottom: 3, display: 'flex', alignItems: 'flex-start', gap: 6 }}>
                    <span style={{ color: '#059669', fontSize: 13 }}>{'\u2192'}</span>
                    <div>
                      <div style={{ fontWeight: 600, color: '#166534' }}>{f.t}</div>
                      <div style={{ color: '#64748b', fontSize: 10 }}>{f.x}</div>
                    </div>
                  </div>
                ))}
              </>
            )}

            {detail.f?.filter(f => f.d === 'out' || f.d === 'to').length > 0 && (
              <>
                <div style={{ fontSize: 9, fontWeight: 600, color: '#2563eb', textTransform: 'uppercase', margin: '10px 0 5px' }}>Outbound</div>
                {detail.f.filter(f => f.d === 'out' || f.d === 'to').map((f, i) => (
                  <div key={i} style={{ padding: '6px 10px', background: '#eff6ff', borderRadius: 6, fontSize: 11, marginBottom: 3, display: 'flex', alignItems: 'flex-start', gap: 6 }}>
                    <span style={{ color: '#2563eb', fontSize: 13 }}>{'\u2190'}</span>
                    <div>
                      <div style={{ fontWeight: 600, color: '#1e40af' }}>{f.t}</div>
                      <div style={{ color: '#64748b', fontSize: 10 }}>{f.x}</div>
                    </div>
                  </div>
                ))}
              </>
            )}

            <div style={{ fontSize: 10, color: '#94a3b8', marginTop: 8, paddingTop: 8, borderTop: '1px solid #f1f5f9' }}>
              {detail.m}
            </div>
          </div>
        )}
      </div>

      <div style={{ display: 'flex', gap: 20, fontSize: 11, color: '#94a3b8', marginTop: 8 }}>
        <span><span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: '#059669', marginRight: 4, verticalAlign: 'middle' }}/> Live</span>
        <span><span style={{ display: 'inline-block', width: 16, height: 2, background: '#85B7EB', borderRadius: 1, marginRight: 4, verticalAlign: 'middle' }}/> API flow</span>
        <span><span style={{ display: 'inline-block', width: 16, height: 0, borderTop: '2px dashed #B4B2A9', marginRight: 4, verticalAlign: 'middle' }}/> Internal</span>
        <span><span style={{ display: 'inline-block', width: 16, height: 1, background: '#F15D3B', opacity: 0.3, marginRight: 4, verticalAlign: 'middle' }}/> Hub</span>
      </div>
    </div>
  )
}
