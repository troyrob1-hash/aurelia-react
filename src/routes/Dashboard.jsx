import { useState, useEffect } from 'react'
import { useLocations, cleanLocName } from '@/store/LocationContext'
import { useToast } from '@/components/ui/Toast'
import { db } from '@/lib/firebase'
import { doc, getDoc } from 'firebase/firestore'
import { readPnL } from '@/lib/pnl'
import { usePeriod } from '@/store/PeriodContext'
import { ChevronDown, ChevronRight, RefreshCw } from 'lucide-react'
import styles from './Dashboard.module.css'

// ── Default P&L schema (Fooda) ────────────────────────────────
// Stored per org in Firestore: orgs/{orgId}/plSchema/default
// Falls back to this if no schema exists yet
const DEFAULT_SCHEMA = [
  {
    id: 'gfs', label: 'Gross Food Sales', color: '#059669',
    lines: [
      { key: 'gfs_popup',    label: 'Popup',                  indent: 1 },
      { key: 'gfs_catering', label: 'Catering',               indent: 1 },
      { key: 'gfs_retail',   label: 'Retail',                 indent: 1 },
      { key: 'gfs_total',    label: 'Total Gross Food Sales',  bold: true, isGFSBase: true },
    ]
  },
  {
    id: 'revenue', label: 'Revenue', color: '#2563eb',
    lines: [
      { key: 'revenue_commission', label: 'Restaurant Commission', indent: 1 },
      { key: 'revenue_total',      label: 'Total Revenue',         bold: true },
      { key: '_pct_rev_gfs',       label: 'Revenue % of GFS',      pct: true, numKey: 'revenue_total', indent: 1 },
    ]
  },
  {
    id: 'cogs', label: 'Cost of Goods Sold', color: '#dc2626',
    lines: [
      { key: 'cogs_onsite_labor',  label: 'Onsite Labor (GL 50410)',      indent: 2 },
      { key: 'cogs_3rd_party',     label: '3rd Party Labor (GL 50420)',   indent: 2 },
      { key: '_labor_subtotal',    label: 'Total Onsite Labor',           bold: true, indent: 1, computeFn: p => (p.cogs_onsite_labor||0)+(p.cogs_3rd_party||0) },
      { key: 'cogs_inventory',     label: 'Inventory Usage',              indent: 1 },
      { key: 'cogs_purchases',     label: 'Purchases (AP / Orders)',      indent: 1 },
      { key: 'cogs_waste',         label: 'Waste / Shrinkage',            indent: 1, danger: true },
      { key: '_cogs_payproc',      label: 'Payment Processing (1.8%)',    indent: 1, computeFn: p => (p.gfs_total||0)*0.018 },
      { key: '_total_cogs',        label: 'Total COGS',                   bold: true, computeFn: p => {
        const labor = (p.cogs_onsite_labor||0)+(p.cogs_3rd_party||0)
        const payproc = (p.gfs_total||0)*0.018
        return labor+(p.cogs_inventory||0)+(p.cogs_purchases||0)+(p.cogs_waste||0)+payproc
      }},
      { key: '_pct_cogs_rev',      label: 'COGS % of Revenue', pct: true, indent: 1,
        computeFn: p => {
          const labor = (p.cogs_onsite_labor||0)+(p.cogs_3rd_party||0)
          const payproc = (p.gfs_total||0)*0.018
          const totalCOGS = labor+(p.cogs_inventory||0)+(p.cogs_purchases||0)+(p.cogs_waste||0)+payproc
          const rev = p.revenue_total || (p.gfs_total||0)*0.82
          return rev > 0 ? totalCOGS/rev : 0
        }, isPct: true
      },
    ]
  },
  {
    id: 'gm', label: 'Gross Margin', color: '#059669',
    lines: [
      { key: '_gross_margin', label: 'Gross Margin', bold: true, highlight: true,
        computeFn: p => {
          const rev = p.revenue_total || (p.gfs_total||0)*0.82
          const labor = (p.cogs_onsite_labor||0)+(p.cogs_3rd_party||0)
          const payproc = (p.gfs_total||0)*0.018
          const totalCOGS = labor+(p.cogs_inventory||0)+(p.cogs_purchases||0)+(p.cogs_waste||0)+payproc
          return rev - totalCOGS
        }
      },
      { key: '_pct_gm_rev', label: 'Gross Margin % of Revenue', pct: true, indent: 1,
        computeFn: p => {
          const rev = p.revenue_total || (p.gfs_total||0)*0.82
          const labor = (p.cogs_onsite_labor||0)+(p.cogs_3rd_party||0)
          const payproc = (p.gfs_total||0)*0.018
          const totalCOGS = labor+(p.cogs_inventory||0)+(p.cogs_purchases||0)+(p.cogs_waste||0)+payproc
          const gm = rev - totalCOGS
          return rev > 0 ? gm/rev : 0
        }, isPct: true
      },
    ]
  },
  {
    id: 'expenses', label: 'Expenses', color: '#d97706',
    lines: [
      { key: 'exp_comp_benefits', label: 'Compensation & Benefits', indent: 1 },
      { key: '_total_exp',        label: 'Total Expenses', bold: true, computeFn: p => (p.exp_comp_benefits||0) },
    ]
  },
  {
    id: 'ebitda', label: 'EBITDA', color: '#059669',
    lines: [
      { key: '_ebitda', label: 'EBITDA', bold: true, highlight: true,
        computeFn: p => {
          const rev = p.revenue_total || (p.gfs_total||0)*0.82
          const labor = (p.cogs_onsite_labor||0)+(p.cogs_3rd_party||0)
          const payproc = (p.gfs_total||0)*0.018
          const totalCOGS = labor+(p.cogs_inventory||0)+(p.cogs_purchases||0)+(p.cogs_waste||0)+payproc
          const gm = rev - totalCOGS
          return gm - (p.exp_comp_benefits||0)
        }
      },
      { key: '_pct_ebitda_gfs', label: 'EBITDA % of GFS', pct: true, indent: 1,
        computeFn: p => {
          const rev = p.revenue_total || (p.gfs_total||0)*0.82
          const labor = (p.cogs_onsite_labor||0)+(p.cogs_3rd_party||0)
          const payproc = (p.gfs_total||0)*0.018
          const totalCOGS = labor+(p.cogs_inventory||0)+(p.cogs_purchases||0)+(p.cogs_waste||0)+payproc
          const ebitda = (rev - totalCOGS) - (p.exp_comp_benefits||0)
          return (p.gfs_total||0) > 0 ? ebitda/(p.gfs_total||0) : 0
        }, isPct: true
      },
    ]
  },
]

const fmt$ = v => {
  if (v === null || v === undefined || v === 0) return '—'
  const abs = Math.abs(v)
  const s   = '$' + abs.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})
  return v < 0 ? `(${s})` : s
}
const fmtPct  = v => v !== null && v !== undefined ? (v*100).toFixed(1)+'%' : '—'
const varColor = v => v === null || v === undefined ? undefined : v >= 0 ? '#059669' : '#dc2626'
const orgId   = 'fooda'

export default function Dashboard() {
  const toast = useToast()
  const { selectedLocation, visibleLocations } = useLocations()
  const { year, period, periodKey } = usePeriod()

  const [pnl,       setPnl]       = useState({})
  const [schema,    setSchema]    = useState(DEFAULT_SCHEMA)
  const [loading,   setLoading]   = useState(true)
  const [collapsed, setCollapsed] = useState({})
  const [refreshing,setRefreshing]= useState(false)

  const location = selectedLocation === 'all' ? null : selectedLocation

  useEffect(() => { load() }, [selectedLocation, periodKey])

  async function load() {
    setLoading(true)
    try {
      // Load org P&L schema if it exists
      const schemaSnap = await getDoc(doc(db,'orgs',orgId,'plSchema','default'))
      if (schemaSnap.exists() && schemaSnap.data().sections?.length) {
        setSchema(schemaSnap.data().sections)
      }

      // Load P&L data
      if (location) {
        const data = await readPnL(location, periodKey)
        setPnl(data || {})
      } else {
        const locs    = Object.values(visibleLocations).map(l => l.name).filter(Boolean)
        const results = await Promise.all(locs.map(l => readPnL(l, periodKey).catch(()=>({}))))
        const agg     = {}
        const numKeys = [
          'gfs_retail','gfs_catering','gfs_popup','gfs_total',
          'revenue_commission','revenue_total',
          'cogs_onsite_labor','cogs_3rd_party','cogs_inventory',
          'cogs_purchases','cogs_waste','exp_comp_benefits',
          'budget_gfs','budget_revenue','budget_cogs','budget_ebitda',
        ]
        results.forEach(r => numKeys.forEach(k => { agg[k] = (agg[k]||0)+(r[k]||0) }))
        setPnl(agg)
      }
    } catch(e) { toast.error('Failed to load P&L data.') }
    setLoading(false)
  }

  async function refresh() { setRefreshing(true); await load(); setRefreshing(false) }
  function toggle(id) { setCollapsed(p => ({...p, [id]: !p[id]})) }

  // Resolve a line's value — either direct key or computed
  function resolveVal(line) {
    if (line.computeFn) return line.computeFn(pnl)
    return pnl[line.key] ?? null
  }

  // KPI values
  const gfs        = pnl.gfs_total || 0
  const revenue    = pnl.revenue_total || 0
  const labor      = (pnl.cogs_onsite_labor||0)+(pnl.cogs_3rd_party||0)
  const payproc    = gfs * 0.018
  const totalCOGS  = labor+(pnl.cogs_inventory||0)+(pnl.cogs_purchases||0)+(pnl.cogs_waste||0)+payproc
  const grossMargin= revenue - totalCOGS
  const ebitda     = grossMargin - (pnl.exp_comp_benefits||0)
  const budgetGFS  = pnl.budget_gfs || 0
  const budgetEBITDA = pnl.budget_ebitda || 0
  const varGFS     = budgetGFS ? gfs - budgetGFS : null
  const varEBITDA  = budgetEBITDA ? ebitda - budgetEBITDA : null

  const KPIs = [
    { label:'Gross Food Sales', val:fmt$(gfs),        sub: varGFS!==null ? `${varGFS>=0?'▲':'▼'} ${fmt$(Math.abs(varGFS))} vs budget` : null, subColor: varColor(varGFS) },
    { label:'Net Revenue',      val:fmt$(revenue),    sub: gfs>0 ? `${(revenue/gfs*100).toFixed(1)}% of GFS` : null },
    { label:'Total COGS',       val:fmt$(totalCOGS),  sub: revenue>0 ? `${(totalCOGS/revenue*100).toFixed(1)}% of Revenue` : null, valColor: totalCOGS>0?'#dc2626':undefined },
    { label:'Gross Margin',     val:fmt$(grossMargin),sub: revenue>0 ? `${(grossMargin/revenue*100).toFixed(1)}% of Revenue` : null, valColor: grossMargin>=0?'#059669':'#dc2626' },
    { label:'EBITDA',           val:fmt$(ebitda),     sub: varEBITDA!==null ? `${varEBITDA>=0?'▲':'▼'} ${fmt$(Math.abs(varEBITDA))} vs budget` : gfs>0?`${(ebitda/gfs*100).toFixed(1)}% of GFS`:null, valColor: ebitda>=0?'#059669':'#dc2626', subColor: varColor(varEBITDA) },
    { label:'Waste / Shrinkage',val:fmt$(pnl.cogs_waste||0), valColor: (pnl.cogs_waste||0)>0?'#dc2626':undefined },
  ]

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <div>
          <h1 className={styles.title}>P&L Dashboard</h1>
          <p className={styles.subtitle}>
            {location ? cleanLocName(location) : `${Object.keys(visibleLocations).length} locations`} · {periodKey}
          </p>
        </div>
        <button className={styles.refreshBtn} onClick={refresh} disabled={refreshing}>
          <RefreshCw size={13} className={refreshing?styles.spinning:''}/>
        </button>
      </div>

      {/* KPI Strip — always visible */}
      <div className={styles.kpiStrip}>
        {KPIs.map(k => (
          <div key={k.label} className={styles.kpi}>
            <div className={styles.kpiL}>{k.label}</div>
            <div className={styles.kpiV} style={{color:k.valColor}}>{k.val}</div>
            {k.sub && <div className={styles.kpiSub} style={{color:k.subColor}}>{k.sub}</div>}
          </div>
        ))}
      </div>

      {/* P&L Table — ALWAYS renders, dashes when no data */}
      {loading ? (
        <div className={styles.loading}>Loading P&L data...</div>
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr className={styles.thead}>
                <th className={styles.thLabel}>Line Item</th>
                <th className={styles.thVal}>Actual</th>
                <th className={styles.thVal}>Budget</th>
                <th className={styles.thVal}>Variance</th>
              </tr>
            </thead>

            {schema.map(section => {
              const isCollapsed = collapsed[section.id]
              return (
                <tbody key={section.id}>
                  {/* Section header */}
                  <tr className={styles.section} onClick={()=>toggle(section.id)}>
                    <td colSpan={4} className={styles.sectionCell} style={{borderTopColor:section.color,color:section.color}}>
                      <span className={styles.sectionToggle}>
                        {isCollapsed ? <ChevronRight size={11}/> : <ChevronDown size={11}/>}
                      </span>
                      {section.label.toUpperCase()}
                    </td>
                  </tr>

                  {/* Lines */}
                  {!isCollapsed && section.lines.map(line => {
                    if (line.pct) {
                      const v = line.computeFn ? line.computeFn(pnl) : null
                      return (
                        <tr key={line.key} className={styles.pctRow}>
                          <td className={styles.label} style={{paddingLeft:16+(line.indent||0)*14,fontStyle:'italic',color:'#888'}}>{line.label}</td>
                          <td className={styles.val} style={{color:'#888'}}>{v !== null ? fmtPct(v) : '—'}</td>
                          <td/><td/>
                        </tr>
                      )
                    }

                    const actual   = resolveVal(line)
                    const budgetKey= `budget_${line.key}`
                    const budget   = pnl[budgetKey] ?? null
                    const variance = actual !== null && budget !== null ? actual - budget : null

                    return (
                      <tr key={line.key} className={`${styles.row} ${line.bold?styles.bold:''} ${line.highlight?styles.highlight:''}`}>
                        <td className={styles.label} style={{paddingLeft:16+(line.indent||0)*14}}>
                          {line.label}
                        </td>
                        <td className={styles.val} style={{
                          color: line.danger && actual > 0 ? '#dc2626'
                               : line.highlight ? (actual >= 0 ? '#059669' : '#dc2626')
                               : undefined
                        }}>
                          {actual !== null && actual !== 0 ? fmt$(actual) : '—'}
                        </td>
                        <td className={styles.val} style={{color:'#888'}}>
                          {budget !== null && budget !== 0 ? fmt$(budget) : '—'}
                        </td>
                        <td className={styles.val} style={{color:varColor(variance)}}>
                          {variance !== null ? (variance>=0?'+':'')+fmt$(variance) : '—'}
                        </td>
                      </tr>
                    )
                  })}

                  {/* Section gap */}
                  <tr className={styles.gap}><td colSpan={4}/></tr>
                </tbody>
              )
            })}

            {/* Net Income */}
            <tbody>
              <tr className={`${styles.row} ${styles.bold} ${styles.netIncome}`}>
                <td className={styles.label} style={{paddingLeft:16,fontSize:14,letterSpacing:'.02em'}}>NET INCOME</td>
                <td className={styles.val} style={{color:ebitda>=0?'#059669':'#dc2626',fontSize:15,fontWeight:800}}>{fmt$(ebitda)}</td>
                <td className={styles.val} style={{color:'#888'}}>{budgetEBITDA?fmt$(budgetEBITDA):'—'}</td>
                <td className={styles.val} style={{color:varColor(varEBITDA)}}>{varEBITDA!==null?(varEBITDA>=0?'+':'')+fmt$(varEBITDA):'—'}</td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}