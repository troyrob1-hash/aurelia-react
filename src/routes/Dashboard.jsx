import { useState, useEffect, useMemo } from 'react'
import { useLocations, cleanLocName } from '@/store/LocationContext'
import { useToast } from '@/components/ui/Toast'
import { db } from '@/lib/firebase'
import { collection, getDocs, query, orderBy, limit } from 'firebase/firestore'
import { ChevronDown, ChevronRight } from 'lucide-react'
import styles from './Dashboard.module.css'

function locationId(n) { return n.replace(/[^a-zA-Z0-9]/g,'_') }

function weekKey(offset=0) {
  const d = new Date(); d.setDate(d.getDate()+offset*7)
  const y = d.getFullYear(), s = new Date(y,0,1)
  const w = Math.ceil(((d-s)/86400000+s.getDay()+1)/7)
  return `${y}-W${String(w).padStart(2,'0')}`
}

const DAYS = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday']
const fmt$ = v => v===0?'—':'$'+Math.abs(v).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})
const fmtPct = (v,d) => d>0?(v/d*100).toFixed(1)+'%':'—'
const neg = v => v<0?'('+fmt$(v)+')':fmt$(v)

export default function Dashboard() {
  const toast = useToast()
  const { selectedLocation, visibleLocations } = useLocations()
  const [salesData, setSalesData]   = useState({})
  const [wasteData, setWasteData]   = useState([])
  const [loading, setLoading]       = useState(true)
  const [collapsed, setCollapsed]   = useState({})
  const [period, setPeriod]         = useState('week')

  const location = selectedLocation==='all' ? null : selectedLocation
  const currentWeek = weekKey()

  useEffect(() => { loadAll() }, [selectedLocation])

  async function loadAll() {
    setLoading(true)
    try {
      await Promise.all([loadSales(), loadWaste()])
    } catch(e) { toast.error('Failed to load dashboard data.') }
    setLoading(false)
  }

  async function loadSales() {
    const locs = location ? [location] : Object.values(visibleLocations).map(l=>l.name).filter(Boolean).slice(0,30)
    const result = {}
    await Promise.all(locs.map(async loc => {
      try {
        const snap = await getDocs(query(collection(db,'tenants','fooda','locations',locationId(loc),'sales'), orderBy('__name__','desc'), limit(4)))
        result[loc] = snap.docs.map(d=>({week:d.id,...d.data()}))
      } catch(e) {}
    }))
    setSalesData(result)
  }

  async function loadWaste() {
    const locs = location ? [location] : Object.values(visibleLocations).map(l=>l.name).filter(Boolean).slice(0,30)
    const all = []
    await Promise.all(locs.map(async loc => {
      try {
        const snap = await getDocs(query(collection(db,'tenants','fooda','locations',locationId(loc),'waste'), orderBy('date','desc'), limit(50)))
        snap.docs.forEach(d => all.push({loc,...d.data()}))
      } catch(e) {}
    }))
    setWasteData(all)
  }

  function toggle(key) { setCollapsed(p=>({...p,[key]:!p[key]})) }

  // Aggregate sales
  const sales = useMemo(() => {
    let retail=0,catering=0,popup=0,delivery=0,pantry=0
    Object.values(salesData).forEach(weeks => {
      const tw = weeks.find(w=>w.week===currentWeek)
      if (!tw?.days) return
      DAYS.forEach(day => {
        retail   += parseFloat(tw.days[day]?.retail   ||0)
        catering += parseFloat(tw.days[day]?.catering ||0)
        popup    += parseFloat(tw.days[day]?.popup    ||0)
      })
    })
    return { retail, catering, popup, delivery, pantry, total: retail+catering+popup+delivery+pantry }
  }, [salesData, currentWeek])

  const salesLW = useMemo(() => {
    const lw = weekKey(-1); let total=0
    Object.values(salesData).forEach(weeks => {
      const tw = weeks.find(w=>w.week===lw)
      if (!tw?.days) return
      DAYS.forEach(day => {
        total += parseFloat(tw.days[day]?.retail||0)+parseFloat(tw.days[day]?.catering||0)+parseFloat(tw.days[day]?.popup||0)
      })
    })
    return total
  }, [salesData])

  const now = new Date(), weekAgo = new Date(now-7*24*60*60*1000)
  const wasteWeek = wasteData.filter(e=>new Date(e.date)>=weekAgo)
  const wasteCost = wasteWeek.reduce((s,e)=>s+(e.total||0),0)

  // COGS estimates
  const retailCOGS   = sales.retail * 0.48
  const cateringCOGS = sales.catering * 0.25
  const payProc      = sales.total * 0.018
  const totalCOGS    = retailCOGS + cateringCOGS + payProc + wasteCost
  const grossMargin  = sales.total - totalCOGS
  const gmPct        = sales.total > 0 ? grossMargin/sales.total : 0

  // Revenue (net of fees ~18%)
  const totalRevenue = sales.total * 0.82
  const revPct       = sales.total > 0 ? totalRevenue/sales.total : 0

  const salesVar = salesLW > 0 ? ((sales.total-salesLW)/salesLW*100) : null

  // P&L rows config
  const Section = ({id, label, children}) => (
    <tbody>
      <tr className={styles.section} onClick={()=>toggle(id)} style={{cursor:'pointer'}}>
        <td colSpan={4}>
          {collapsed[id] ? <ChevronRight size={12}/> : <ChevronDown size={12}/>}
          {' '}{label}
        </td>
      </tr>
      {!collapsed[id] && children}
    </tbody>
  )

  const Row = ({label, actual=null, budget=null, indent=1, bold=false, isTotal=false, color=null}) => {
    const variance = actual!==null && budget!==null && budget!==0 ? actual-budget : null
    return (
      <tr className={`${styles.row} ${isTotal?styles.totalRow:''} ${bold?styles.bold:''}`}>
        <td className={styles.label} style={{paddingLeft: 16+indent*16}}>
          {label.replace(/\xa0/g,'')}
        </td>
        <td className={styles.val} style={{color: color||(actual<0?'#dc2626':undefined)}}>
          {actual!==null ? (actual<0?`(${fmt$(actual)})`:fmt$(actual)) : '—'}
        </td>
        <td className={styles.val} style={{color:'#999'}}>
          {budget!==null ? fmt$(budget) : '—'}
        </td>
        <td className={styles.val} style={{color: variance===null?undefined:variance>=0?'#059669':'#dc2626'}}>
          {variance!==null ? (variance>=0?'+':'')+fmt$(variance) : '—'}
        </td>
      </tr>
    )
  }

  const PctRow = ({label, val, indent=1}) => (
    <tr className={styles.pctRow}>
      <td className={styles.label} style={{paddingLeft:16+indent*16,fontStyle:'italic'}}>{label}</td>
      <td className={styles.val} style={{color:'#666'}}>{val||'—'}</td>
      <td/><td/>
    </tr>
  )

  const Gap = () => <tr className={styles.gap}><td colSpan={4}/></tr>

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <div>
          <h1 className={styles.title}>P&L Dashboard</h1>
          <p className={styles.subtitle}>
            {location ? cleanLocName(location) : `${Object.keys(visibleLocations).length} locations`} · {currentWeek}
          </p>
        </div>
        <div className={styles.headerRight}>
          <div className={styles.varBadge} style={{background: salesVar===null?'#f3f4f6':salesVar>=0?'#d1fae5':'#fee2e2', color: salesVar===null?'#666':salesVar>=0?'#059669':'#dc2626'}}>
            {salesVar===null ? 'No prior week data' : `${salesVar>=0?'▲':'▼'} ${Math.abs(salesVar).toFixed(1)}% vs last week`}
          </div>
        </div>
      </div>

      {/* KPI strip */}
      <div className={styles.kpiStrip}>
        <div className={styles.kpi}>
          <div className={styles.kpiL}>Gross Food Sales</div>
          <div className={styles.kpiV}>{fmt$(sales.total)}</div>
        </div>
        <div className={styles.kpi}>
          <div className={styles.kpiL}>Net Revenue</div>
          <div className={styles.kpiV}>{fmt$(totalRevenue)}</div>
        </div>
        <div className={styles.kpi}>
          <div className={styles.kpiL}>Total COGS</div>
          <div className={styles.kpiV} style={{color:'#dc2626'}}>{fmt$(totalCOGS)}</div>
        </div>
        <div className={styles.kpi}>
          <div className={styles.kpiL}>Gross Margin</div>
          <div className={styles.kpiV} style={{color:grossMargin>=0?'#059669':'#dc2626'}}>{fmt$(grossMargin)}</div>
        </div>
        <div className={styles.kpi}>
          <div className={styles.kpiL}>GM %</div>
          <div className={styles.kpiV} style={{color:grossMargin>=0?'#059669':'#dc2626'}}>{fmtPct(grossMargin,sales.total)}</div>
        </div>
        <div className={styles.kpi}>
          <div className={styles.kpiL}>Waste Cost</div>
          <div className={styles.kpiV} style={{color:'#dc2626'}}>{fmt$(wasteCost)}</div>
        </div>
      </div>

      {loading ? <div className={styles.loading}>Loading...</div> : (
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
              <Row label="Popup"    actual={sales.popup}    indent={1}/>
              <Row label="Catering" actual={sales.catering} indent={1}/>
              <Row label="Delivery" actual={sales.delivery} indent={1}/>
              <Row label="Retail"   actual={sales.retail}   indent={1}/>
              <Row label="Pantry"   actual={sales.pantry}   indent={1}/>
              <Row label="Total Gross Food Sales" actual={sales.total} indent={0} bold isTotal/>
              <Row label="Annual Run Rate" actual={sales.total*52} indent={1}/>
              <Gap/>
            </Section>

            <Section id="rev" label="REVENUE">
              <Row label="PopUp"    indent={1}/>
              <Row label="Restaurant Commission" actual={sales.popup*0.18} indent={2}/>
              <Row label="Total Popup" actual={sales.popup*0.82} indent={1} bold/>
              <Row label="Catering" indent={1}/>
              <Row label="Restaurant Commission" actual={sales.catering*0.18} indent={2}/>
              <Row label="Total Catering" actual={sales.catering*0.82} indent={1} bold/>
              <Row label="Retail"   indent={1}/>
              <Row label="Barista"  indent={2}/>
              <Row label="Cafeteria" indent={2}/>
              <Row label="Total Retail" actual={sales.retail*0.82} indent={1} bold/>
              <Row label="Total Revenue" actual={totalRevenue} indent={0} bold isTotal/>
              <PctRow label="Revenue % GFS" val={fmtPct(totalRevenue,sales.total)}/>
              <Gap/>
            </Section>

            <Section id="cogs" label="COGS">
              <Row label="Location costs" indent={0}/>
              <Row label="Onsite Labor" indent={1}/>
              <Row label="General Onsite Labor" indent={2}/>
              <Row label="Total Onsite Labor" indent={1} bold/>
              <Row label="Onsite equipment and consumables" indent={1}/>
              <Row label="Total Location Costs" indent={0} bold/>
              <Gap/>
              <Row label="Payment processing fees" actual={payProc} indent={0}/>
              <Row label="Revenue Share" indent={0}/>
              <Row label="Retail COGS" indent={0}/>
              <Row label="Barista" indent={1}/>
              <Row label="Cafeteria" actual={retailCOGS} indent={1}/>
              <Row label="Catering Resale" actual={cateringCOGS} indent={1}/>
              <Row label="Total Retail COGS" actual={retailCOGS+cateringCOGS} indent={0} bold/>
              <Row label="Waste / Shrinkage" actual={wasteCost} indent={0} color="#dc2626"/>
              <Row label="Total COGS" actual={totalCOGS} indent={0} bold isTotal/>
              <Gap/>
            </Section>

            <Section id="gm" label="GROSS MARGIN">
              <Row label="Gross Margin" actual={grossMargin} indent={0} bold isTotal color={grossMargin>=0?'#059669':'#dc2626'}/>
              <PctRow label="Gross Margin % of Rev" val={fmtPct(grossMargin,totalRevenue)}/>
              <Gap/>
            </Section>

            <Section id="exp" label="EXPENSES">
              <Row label="Compensation and Benefits" indent={0}/>
              <Row label="Salaries and Wages" indent={1}/>
              <Row label="Market Management" indent={2}/>
              <Row label="Sales" indent={2}/>
              <Row label="Operations" indent={2}/>
              <Row label="Total Salaries and Wages" indent={1} bold/>
              <Row label="Bonuses" indent={1}/>
              <Row label="Benefits and Taxes" indent={1}/>
              <Row label="Total Compensation and Benefits" indent={0} bold/>
              <Gap/>
              <Row label="General Expenses" indent={0}/>
              <Row label="Office Supplies and Equipment" indent={1}/>
              <Row label="Technology Services" indent={1}/>
              <Row label="Travel and Entertainment" indent={1}/>
              <Row label="Professional Fees" indent={1}/>
              <Row label="Total General Expenses" indent={0} bold/>
              <Gap/>
              <Row label="Total Expenses" indent={0} bold isTotal/>
              <Gap/>
            </Section>

            <Section id="ebitda" label="EBITDA">
              <Row label="EBITDA" actual={grossMargin} indent={0} bold isTotal color={grossMargin>=0?'#059669':'#dc2626'}/>
              <PctRow label="EBITDA as % GFS" val={fmtPct(grossMargin,sales.total)}/>
              <PctRow label="EBITDA as % Revenue" val={fmtPct(grossMargin,totalRevenue)}/>
              <Gap/>
            </Section>

            <Section id="other" label="OTHER INCOME / (EXPENSES)">
              <Row label="Interest Income" indent={1}/>
              <Row label="Stock Based Compensation" indent={1}/>
              <Row label="Depreciation Expense" indent={1}/>
              <Row label="Interest Expense" indent={1}/>
              <Row label="Severance" indent={1}/>
              <Row label="Income Taxes" indent={1}/>
              <Row label="Total Other" indent={0} bold/>
              <Gap/>
            </Section>

            <tbody>
              <tr className={`${styles.row} ${styles.totalRow} ${styles.bold} ${styles.netIncome}`}>
                <td className={styles.label} style={{paddingLeft:16}}>NET INCOME</td>
                <td className={styles.val} style={{color:grossMargin>=0?'#059669':'#dc2626',fontSize:15}}>{fmt$(grossMargin)}</td>
                <td className={styles.val}>—</td>
                <td className={styles.val}>—</td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
