import { useState, useEffect, useMemo } from 'react'
import { useLocations, cleanLocName } from '@/store/LocationContext'
import { useToast } from '@/components/ui/Toast'
import { db } from '@/lib/firebase'
import { collection, getDocs, query, orderBy, limit, doc, getDoc } from 'firebase/firestore'
import { readPnL, locId } from '@/lib/pnl'
import { usePeriod, getPeriodLabel } from '@/store/PeriodContext'
import { ChevronDown, ChevronRight, RefreshCw } from 'lucide-react'
import styles from './Dashboard.module.css'



const fmt$ = v => {
  if (!v || isNaN(v) || v === 0) return '—'
  const abs = Math.abs(v)
  const s = '$' + abs.toLocaleString('en-US', { minimumFractionDigits:2, maximumFractionDigits:2 })
  return v < 0 ? `(${s})` : s
}
const fmtPct = (v, d) => d > 0 ? (v/d*100).toFixed(1)+'%' : '—'
const varColor = v => v === null || v === undefined ? undefined : v >= 0 ? '#059669' : '#dc2626'

export default function Dashboard() {
  const toast = useToast()
  const { selectedLocation, visibleLocations } = useLocations()
  const [pnl, setPnl]         = useState({})
  const [loading, setLoading] = useState(true)
  const [collapsed, setCollapsed] = useState({})
  const [refreshing, setRefreshing] = useState(false)

  const { year, period, week, periodKey, currentWeek } = usePeriod()
  const location = selectedLocation === 'all' ? null : selectedLocation

  useEffect(() => { load() }, [selectedLocation, periodKey])

  async function load() {
    setLoading(true)
    try {
      if (location) {
        // Single location — read direct
        const data = await readPnL(location, periodKey)
        setPnl(data)
      } else {
        // All locations — aggregate
        const locs = Object.values(visibleLocations).map(l => l.name).filter(Boolean)
        const results = await Promise.all(locs.map(l => readPnL(l, periodKey).catch(()=>({}))))
        const agg = {}
        const numKeys = [
          'gfs_retail','gfs_catering','gfs_popup','gfs_total',
          'revenue_commission','revenue_total',
          'cogs_onsite_labor','cogs_3rd_party','cogs_inventory',
          'cogs_purchases','cogs_waste','exp_comp_benefits','labor_total',
          'budget_gfs','budget_revenue','budget_cogs','budget_labor','budget_ebitda',
          'inv_closing','ap_paid','ap_pending',
        ]
        results.forEach(r => {
          numKeys.forEach(k => { agg[k] = (agg[k]||0) + (r[k]||0) })
        })
        setPnl(agg)
      }
    } catch(e) { toast.error('Failed to load P&L data.') }
    setLoading(false)
  }

  async function refresh() {
    setRefreshing(true)
    await load()
    setRefreshing(false)
  }

  function toggle(key) { setCollapsed(p => ({...p, [key]: !p[key]})) }

  // Computed values
  const gfs         = pnl.gfs_total || 0
  const gfsRetail   = pnl.gfs_retail || 0
  const gfsCatering = pnl.gfs_catering || 0
  const gfsPopup    = pnl.gfs_popup || 0
  const revenue     = pnl.revenue_total || (gfs * 0.82)
  const commission  = pnl.revenue_commission || (gfs * 0.18)

  const cogsLabor   = pnl.cogs_onsite_labor || 0
  const cogs3rd     = pnl.cogs_3rd_party || 0
  const cogsInv     = pnl.cogs_inventory || (gfsRetail * 0.48 + gfsCatering * 0.25)
  const cogsPurch   = pnl.cogs_purchases || 0
  const cogsWaste   = pnl.cogs_waste || 0
  const cogsPayProc = gfs * 0.018
  const totalCOGS   = cogsLabor + cogs3rd + cogsInv + cogsPurch + cogsWaste + cogsPayProc
  const grossMargin = revenue - totalCOGS
  const gmPct       = revenue > 0 ? grossMargin/revenue : 0

  const expComp     = pnl.exp_comp_benefits || 0
  const totalExp    = expComp
  const ebitda      = grossMargin - totalExp
  const ebitdaPct   = gfs > 0 ? ebitda/gfs : 0

  // Budget variance
  const budgetGFS    = pnl.budget_gfs || 0
  const budgetRev    = pnl.budget_revenue || 0
  const budgetCOGS   = pnl.budget_cogs || 0
  const budgetEBITDA = pnl.budget_ebitda || 0
  const varGFS       = budgetGFS ? gfs - budgetGFS : null
  const varEBITDA    = budgetEBITDA ? ebitda - budgetEBITDA : null

  // Row components
  const Section = ({ id, label, children }) => (
    <tbody>
      <tr className={styles.section} onClick={() => toggle(id)}>
        <td colSpan={4} className={styles.sectionCell}>
          <span className={styles.sectionToggle}>{collapsed[id] ? <ChevronRight size={11}/> : <ChevronDown size={11}/>}</span>
          {label}
        </td>
      </tr>
      {!collapsed[id] && children}
    </tbody>
  )

  const Row = ({ label, actual=null, budget=null, indent=1, bold=false, isTotal=false, color=null }) => {
    const variance = actual !== null && budget !== null && budget !== 0 ? actual - budget : null
    return (
      <tr className={`${styles.row} ${isTotal ? styles.totalRow : ''} ${bold ? styles.bold : ''}`}>
        <td className={styles.label} style={{ paddingLeft: 16 + indent*16 }}>{label}</td>
        <td className={styles.val} style={{ color: color || (actual < 0 ? '#dc2626' : undefined) }}>
          {actual !== null ? fmt$(actual) : '—'}
        </td>
        <td className={styles.val} style={{ color:'#888' }}>
          {budget ? fmt$(budget) : '—'}
        </td>
        <td className={styles.val} style={{ color: varColor(variance) }}>
          {variance !== null ? (variance >= 0 ? '+' : '') + fmt$(variance) : '—'}
        </td>
      </tr>
    )
  }

  const PctRow = ({ label, val, indent=1 }) => (
    <tr className={styles.pctRow}>
      <td className={styles.label} style={{ paddingLeft: 16+indent*16, fontStyle:'italic', color:'#888' }}>{label}</td>
      <td className={styles.val} style={{ color:'#888' }}>{val || '—'}</td>
      <td/><td/>
    </tr>
  )

  const Gap = () => <tr className={styles.gap}><td colSpan={4}/></tr>

  const noData = gfs === 0 && revenue === 0 && totalCOGS === 0

  return (
    <div className={styles.page}>
      {/* Header */}
      <div className={styles.header}>
        <div>
          <h1 className={styles.title}>P&L Dashboard</h1>
          <p className={styles.subtitle}>
            {location ? cleanLocName(location) : `${Object.keys(visibleLocations).length} locations`} · {periodKey}
          </p>
        </div>
        <div className={styles.headerRight}>
          <button className={styles.refreshBtn} onClick={refresh} disabled={refreshing}>
            <RefreshCw size={13} className={refreshing ? styles.spinning : ''}/>
          </button>
        </div>
      </div>

      {/* KPI Strip */}
      <div className={styles.kpiStrip}>
        <div className={styles.kpi}>
          <div className={styles.kpiL}>Gross Food Sales</div>
          <div className={styles.kpiV}>{fmt$(gfs)}</div>
          {varGFS !== null && <div className={styles.kpiVar} style={{color:varColor(varGFS)}}>{varGFS>=0?'▲':'▼'} {fmt$(Math.abs(varGFS))} vs budget</div>}
        </div>
        <div className={styles.kpi}>
          <div className={styles.kpiL}>Net Revenue</div>
          <div className={styles.kpiV}>{fmt$(revenue)}</div>
          <div className={styles.kpiSub}>{fmtPct(revenue,gfs)} of GFS</div>
        </div>
        <div className={styles.kpi}>
          <div className={styles.kpiL}>Total COGS</div>
          <div className={styles.kpiV} style={{color: totalCOGS > 0 ? '#dc2626' : undefined}}>{fmt$(totalCOGS)}</div>
          <div className={styles.kpiSub}>{fmtPct(totalCOGS,revenue)} of Revenue</div>
        </div>
        <div className={styles.kpi}>
          <div className={styles.kpiL}>Gross Margin</div>
          <div className={styles.kpiV} style={{color: grossMargin >= 0 ? '#059669' : '#dc2626'}}>{fmt$(grossMargin)}</div>
          <div className={styles.kpiSub}>{fmtPct(grossMargin,revenue)} of Revenue</div>
        </div>
        <div className={styles.kpi}>
          <div className={styles.kpiL}>EBITDA</div>
          <div className={styles.kpiV} style={{color: ebitda >= 0 ? '#059669' : '#dc2626'}}>{fmt$(ebitda)}</div>
          <div className={styles.kpiSub}>{fmtPct(ebitda,gfs)} of GFS</div>
        </div>
        <div className={styles.kpi}>
          <div className={styles.kpiL}>Waste / Shrinkage</div>
          <div className={styles.kpiV} style={{color: cogsWaste > 0 ? '#dc2626' : undefined}}>{fmt$(cogsWaste)}</div>
        </div>
      </div>

      {loading ? (
        <div className={styles.loading}>Loading P&L data...</div>
      ) : noData ? (
        <div className={styles.noData}>
          <div style={{fontSize:32,marginBottom:12}}>📊</div>
          <p style={{fontWeight:700,fontSize:16,marginBottom:8}}>No P&L data for this period</p>
          <p style={{fontSize:13,color:'#999',maxWidth:380,textAlign:'center',lineHeight:1.6}}>
            Save weekly sales, submit orders, import labor, and close inventory to populate the P&L automatically.
          </p>
        </div>
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

            <Section id="gfs" label="GROSS FOOD SALES">
              <Row label="Popup"    actual={gfsPopup}    indent={1}/>
              <Row label="Catering" actual={gfsCatering} indent={1}/>
              <Row label="Retail"   actual={gfsRetail}   indent={1}/>
              <Row label="Total Gross Food Sales" actual={gfs} budget={budgetGFS} indent={0} bold isTotal/>
              <Row label="Annual Run Rate" actual={gfs*52} indent={1}/>
              {budgetGFS > 0 && <Row label="Var to Budget" actual={varGFS} indent={1} color={varColor(varGFS)}/>}
              <Gap/>
            </Section>

            <Section id="rev" label="REVENUE">
              <Row label="Restaurant Commission" actual={commission} indent={2}/>
              <Row label="Total Popup Revenue"   actual={gfsPopup*0.82}    indent={1} bold/>
              <Row label="Total Catering Revenue" actual={gfsCatering*0.82} indent={1} bold/>
              <Row label="Total Retail Revenue"   actual={gfsRetail*0.82}  indent={1} bold/>
              <Row label="Total Revenue" actual={revenue} budget={budgetRev} indent={0} bold isTotal/>
              <PctRow label="Revenue % GFS" val={fmtPct(revenue,gfs)}/>
              <Gap/>
            </Section>

            <Section id="cogs" label="COGS">
              <Row label="Onsite Labor (GL 50410)" actual={cogsLabor || null} indent={2}/>
              <Row label="3rd Party Labor (GL 50420)" actual={cogs3rd || null} indent={2}/>
              <Row label="Total Onsite Labor" actual={(cogsLabor+cogs3rd)||null} indent={1} bold/>
              <Gap/>
              <Row label="Payment Processing Fees (1.8%)" actual={cogsPayProc} indent={1}/>
              <Gap/>
              <Row label="Retail COGS" actual={gfsRetail*0.48||null} indent={2}/>
              <Row label="Catering COGS" actual={gfsCatering*0.25||null} indent={2}/>
              <Row label="Inventory Usage" actual={cogsInv||null} indent={2}/>
              <Row label="Total Retail COGS" actual={cogsInv||null} indent={1} bold/>
              <Gap/>
              <Row label="Purchases (AP / Orders)" actual={cogsPurch||null} indent={1}/>
              <Row label="Waste / Shrinkage" actual={cogsWaste||null} indent={1} color={cogsWaste > 0 ? '#dc2626' : undefined}/>
              <Gap/>
              <Row label="Total COGS" actual={totalCOGS} budget={budgetCOGS} indent={0} bold isTotal/>
              <Gap/>
            </Section>

            <Section id="gm" label="GROSS MARGIN">
              <Row label="Gross Margin" actual={grossMargin} indent={0} bold isTotal
                color={grossMargin >= 0 ? '#059669' : '#dc2626'}/>
              <PctRow label="Gross Margin % of Revenue" val={fmtPct(grossMargin,revenue)}/>
              <PctRow label="Gross Margin % of GFS"     val={fmtPct(grossMargin,gfs)}/>
              <Gap/>
            </Section>

            <Section id="exp" label="EXPENSES">
              <Row label="Compensation and Benefits" indent={0}/>
              <Row label="Salaries and Wages"        indent={1}/>
              <Row label="Total Comp & Benefits" actual={expComp||null} budget={pnl.budget_labor||null} indent={0} bold/>
              <Gap/>
              <Row label="General Expenses"          indent={0}/>
              <Row label="Technology / SaaS"         indent={1}/>
              <Row label="Travel and Entertainment"  indent={1}/>
              <Row label="Professional Fees"         indent={1}/>
              <Row label="Total General Expenses"    indent={0} bold/>
              <Gap/>
              <Row label="Total Expenses" actual={totalExp||null} indent={0} bold isTotal/>
              <Gap/>
            </Section>

            <Section id="ebitda" label="EBITDA">
              <Row label="EBITDA" actual={ebitda} budget={budgetEBITDA||null} indent={0} bold isTotal
                color={ebitda >= 0 ? '#059669' : '#dc2626'}/>
              <PctRow label="EBITDA as % GFS"     val={fmtPct(ebitda,gfs)}/>
              <PctRow label="EBITDA as % Revenue" val={fmtPct(ebitda,revenue)}/>
              <PctRow label="EBITDA as % GM"      val={fmtPct(ebitda,grossMargin)}/>
              {budgetEBITDA > 0 && <Row label="Budget EBITDA" actual={budgetEBITDA} indent={1} color="#888"/>}
              {varEBITDA !== null && <Row label="Variance to Budget" actual={varEBITDA} indent={1} color={varColor(varEBITDA)}/>}
              <Gap/>
            </Section>

            <Section id="other" label="OTHER INCOME / (EXPENSES)">
              <Row label="Interest Income"        indent={1}/>
              <Row label="Stock Based Compensation" indent={1}/>
              <Row label="Depreciation Expense"   indent={1}/>
              <Row label="Interest Expense"       indent={1}/>
              <Row label="Severance"              indent={1}/>
              <Row label="Income Taxes"           indent={1}/>
              <Row label="Total Other Income / (Expenses)" indent={0} bold/>
              <Gap/>
            </Section>

            <tbody>
              <tr className={`${styles.row} ${styles.totalRow} ${styles.bold} ${styles.netIncome}`}>
                <td className={styles.label} style={{paddingLeft:16,fontSize:14,letterSpacing:'.02em'}}>NET INCOME</td>
                <td className={styles.val} style={{color: ebitda>=0?'#059669':'#dc2626', fontSize:15, fontWeight:800}}>{fmt$(ebitda)}</td>
                <td className={styles.val} style={{color:'#888'}}>{budgetEBITDA ? fmt$(budgetEBITDA) : '—'}</td>
                <td className={styles.val} style={{color: varColor(varEBITDA)}}>{varEBITDA !== null ? (varEBITDA>=0?'+':'')+fmt$(varEBITDA) : '—'}</td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
