import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useLocations, cleanLocName } from '@/store/LocationContext'
import { useToast } from '@/components/ui/Toast'
import { useAuthStore } from '@/store/authStore'
import { db } from '@/lib/firebase'
import { doc, getDoc } from 'firebase/firestore'
import { readPnL } from '@/lib/pnl'
import { usePeriod } from '@/store/PeriodContext'
import { ChevronDown, ChevronRight, RefreshCw, Download, ExternalLink } from 'lucide-react'
import styles from './Dashboard.module.css'

const DEFAULT_SCHEMA = [
  {
    id: 'gfs', label: 'Gross Food Sales', color: '#059669',
    lines: [
      { key: 'gfs_popup',    label: 'Popup',                 indent: 1 },
      { key: 'gfs_catering', label: 'Catering',              indent: 1 },
      { key: 'gfs_retail',   label: 'Retail',                indent: 1 },
      { key: 'gfs_total',    label: 'Total Gross Food Sales', bold: true, budgetKey: 'budget_gfs' },
    ]
  },
  {
    id: 'revenue', label: 'Revenue', color: '#2563eb',
    lines: [
      { key: 'revenue_commission', label: 'Restaurant Commission', indent: 1 },
      { key: 'revenue_total',      label: 'Total Revenue',         bold: true, budgetKey: 'budget_revenue' },
      { key: '_pct_rev_gfs', label: 'Revenue % of GFS', pct: true, indent: 1,
        computeFn: p => p.gfs_total > 0 ? p.revenue_total / p.gfs_total : null },
    ]
  },
  {
    id: 'cogs', label: 'Cost of Goods Sold', color: '#dc2626',
    lines: [
      { key: 'cogs_onsite_labor', label: 'Onsite Labor (GL 50410)',    indent: 2, drillTo: '/labor' },
      { key: 'cogs_3rd_party',    label: '3rd Party Labor (GL 50420)', indent: 2, drillTo: '/labor' },
      { key: '_labor_subtotal',   label: 'Total Onsite Labor',         bold: true, indent: 1, budgetKey: 'budget_labor',
        computeFn: p => (p.cogs_onsite_labor||0) + (p.cogs_3rd_party||0) },
      { key: 'cogs_inventory',  label: 'Inventory Usage',   indent: 1, drillTo: '/inventory' },
      { key: 'cogs_purchases',  label: 'Purchases (AP)',    indent: 1, drillTo: '/purchasing' },
      { key: 'cogs_waste',      label: 'Waste / Shrinkage', indent: 1, danger: true, drillTo: '/waste' },
      { key: '_cogs_payproc',   label: 'Payment Processing (1.8%)', indent: 1,
        computeFn: p => (p.gfs_total||0) * 0.018 },
      { key: '_total_cogs', label: 'Total COGS', bold: true, budgetKey: 'budget_cogs',
        computeFn: p => {
          const labor   = (p.cogs_onsite_labor||0) + (p.cogs_3rd_party||0)
          const payproc = (p.gfs_total||0) * 0.018
          return labor + (p.cogs_inventory||0) + (p.cogs_purchases||0) + (p.cogs_waste||0) + payproc
        }
      },
      { key: '_pct_cogs_rev', label: 'COGS % of Revenue', pct: true, indent: 1,
        computeFn: p => {
          const labor   = (p.cogs_onsite_labor||0) + (p.cogs_3rd_party||0)
          const payproc = (p.gfs_total||0) * 0.018
          const total   = labor + (p.cogs_inventory||0) + (p.cogs_purchases||0) + (p.cogs_waste||0) + payproc
          const rev     = p.revenue_total || (p.gfs_total||0) * 0.82
          return rev > 0 ? total / rev : null
        }
      },
    ]
  },
  {
    id: 'gm', label: 'Gross Margin', color: '#059669',
    lines: [
      { key: '_gross_margin', label: 'Gross Margin', bold: true, highlight: true,
        computeFn: p => {
          const rev     = p.revenue_total || (p.gfs_total||0) * 0.82
          const labor   = (p.cogs_onsite_labor||0) + (p.cogs_3rd_party||0)
          const payproc = (p.gfs_total||0) * 0.018
          return rev - (labor + (p.cogs_inventory||0) + (p.cogs_purchases||0) + (p.cogs_waste||0) + payproc)
        }
      },
      { key: '_pct_gm_rev', label: 'Gross Margin % of Revenue', pct: true, indent: 1,
        computeFn: p => {
          const rev     = p.revenue_total || (p.gfs_total||0) * 0.82
          const labor   = (p.cogs_onsite_labor||0) + (p.cogs_3rd_party||0)
          const payproc = (p.gfs_total||0) * 0.018
          const gm      = rev - (labor + (p.cogs_inventory||0) + (p.cogs_purchases||0) + (p.cogs_waste||0) + payproc)
          return rev > 0 ? gm / rev : null
        }
      },
    ]
  },
  {
    id: 'expenses', label: 'Expenses', color: '#d97706',
    lines: [
      { key: 'exp_comp_benefits', label: 'Compensation & Benefits', indent: 1, drillTo: '/labor' },
      { key: '_total_exp', label: 'Total Expenses', bold: true, budgetKey: 'budget_labor',
        computeFn: p => (p.exp_comp_benefits||0) },
    ]
  },
  {
    id: 'ebitda', label: 'EBITDA', color: '#059669',
    lines: [
      { key: '_ebitda', label: 'EBITDA', bold: true, highlight: true, budgetKey: 'budget_ebitda',
        computeFn: p => {
          const rev     = p.revenue_total || (p.gfs_total||0) * 0.82
          const labor   = (p.cogs_onsite_labor||0) + (p.cogs_3rd_party||0)
          const payproc = (p.gfs_total||0) * 0.018
          const gm      = rev - (labor + (p.cogs_inventory||0) + (p.cogs_purchases||0) + (p.cogs_waste||0) + payproc)
          return gm - (p.exp_comp_benefits||0)
        }
      },
      { key: '_pct_ebitda_gfs', label: 'EBITDA % of GFS', pct: true, indent: 1,
        computeFn: p => {
          const rev     = p.revenue_total || (p.gfs_total||0) * 0.82
          const labor   = (p.cogs_onsite_labor||0) + (p.cogs_3rd_party||0)
          const payproc = (p.gfs_total||0) * 0.018
          const ebitda  = (rev - (labor + (p.cogs_inventory||0) + (p.cogs_purchases||0) + (p.cogs_waste||0) + payproc)) - (p.exp_comp_benefits||0)
          return (p.gfs_total||0) > 0 ? ebitda / (p.gfs_total||0) : null
        }
      },
    ]
  },
]

const SOURCES = [
  { label: 'Sales',      key: 'gfs_total',         path: '/sales'      },
  { label: 'Labor',      key: 'cogs_onsite_labor',  path: '/labor'      },
  { label: 'Purchasing', key: 'cogs_purchases',      path: '/purchasing' },
  { label: 'Inventory',  key: 'cogs_inventory',      path: '/inventory'  },
  { label: 'Waste',      key: 'cogs_waste',          path: '/waste'      },
]

const fmt$ = v => {
  if (v === null || v === undefined || v === 0) return '—'
  const abs = Math.abs(v)
  const s   = '$' + abs.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  return v < 0 ? `(${s})` : s
}
const fmtPct   = v => v != null ? (v * 100).toFixed(1) + '%' : '—'
const varColor = v => v == null ? undefined : v >= 0 ? '#059669' : '#dc2626'

// Compute EBITDA from a raw pnl data object
function computeEBITDA(p) {
  const rev     = p.revenue_total || (p.gfs_total||0) * 0.82
  const labor   = (p.cogs_onsite_labor||0) + (p.cogs_3rd_party||0)
  const payproc = (p.gfs_total||0) * 0.018
  const gm      = rev - (labor + (p.cogs_inventory||0) + (p.cogs_purchases||0) + (p.cogs_waste||0) + payproc)
  return gm - (p.exp_comp_benefits||0)
}

function computePrimeCost(p) {
  const rev   = p.revenue_total || (p.gfs_total||0) * 0.82
  const labor = (p.cogs_onsite_labor||0) + (p.cogs_3rd_party||0) + (p.exp_comp_benefits||0)
  const cogs  = (p.cogs_inventory||0) + (p.cogs_purchases||0)
  return rev > 0 ? (labor + cogs) / rev : null
}

// Derive prior period key — one week back
function getPriorKey(key) {
  const parts = key.match(/(\d+)-P(\d+)-W(\d+)/)
  if (!parts) return null
  let [, yr, p, w] = parts.map(Number)
  if (w > 1) return `${yr}-P${String(p).padStart(2,'0')}-W${w-1}`
  if (p > 1) return `${yr}-P${String(p-1).padStart(2,'0')}-W4`
  return `${yr-1}-P12-W4`
}

// Budget pacing — how far through the period are we (0–1)
function getPeriodPacing(periodKey) {
  const parts = periodKey.match(/(\d+)-P(\d+)-W(\d+)/)
  if (!parts) return null
  const w = Number(parts[3])
  return Math.min(w / 4, 1) // assume 4 weeks per period
}

export default function Dashboard() {
  const toast    = useToast()
  const navigate = useNavigate()
  const { user } = useAuthStore()
  const orgId    = user?.tenantId || 'fooda'
  const { selectedLocation, visibleLocations } = useLocations()
  const { periodKey } = usePeriod()

  const [pnl,          setPnl]          = useState({})
  const [priorPnl,     setPriorPnl]     = useState({})
  const [locationData, setLocationData] = useState([]) // for ranking table
  const [schema,       setSchema]       = useState(DEFAULT_SCHEMA)
  const [loading,      setLoading]      = useState(true)
  const [collapsed,    setCollapsed]    = useState({})
  const [refreshing,   setRefreshing]   = useState(false)

  const location  = selectedLocation === 'all' ? null : selectedLocation
  const isAll     = selectedLocation === 'all'
  const locNames  = Object.keys(visibleLocations)

  async function aggregatePnL(periodK, locs) {
    if (!isAll && location) return await readPnL(location, periodK).catch(() => ({}))
    const results = await Promise.all(locs.map(l => readPnL(l, periodK).catch(() => ({}))))
    const agg = {}
    const numKeys = [
      'gfs_retail','gfs_catering','gfs_popup','gfs_total',
      'revenue_commission','revenue_total',
      'cogs_onsite_labor','cogs_3rd_party','cogs_inventory',
      'cogs_purchases','cogs_waste','exp_comp_benefits',
      'budget_gfs','budget_revenue','budget_cogs','budget_labor','budget_ebitda',
    ]
    results.forEach(r => numKeys.forEach(k => { agg[k] = (agg[k]||0) + (r[k]||0) }))
    return agg
  }

  useEffect(() => { load() }, [selectedLocation, periodKey])

  async function load() {
    setLoading(true)
    try {
      const schemaSnap = await getDoc(doc(db, 'tenants', orgId, 'config', 'plSchema'))
      if (schemaSnap.exists() && schemaSnap.data().sections?.length) {
        setSchema(schemaSnap.data().sections)
      }

      const [current, prior] = await Promise.all([
        aggregatePnL(periodKey, locNames),
        aggregatePnL(getPriorKey(periodKey), locNames),
      ])
      setPnl(current)
      setPriorPnl(prior)

      // Location ranking — only when viewing all locations
      if (isAll && locNames.length > 0) {
        const locResults = await Promise.all(
          locNames.map(async name => {
            const d = await readPnL(name, periodKey).catch(() => ({}))
            return {
              name,
              gfs:    d.gfs_total || 0,
              ebitda: computeEBITDA(d),
              ebitdaPct: d.gfs_total > 0 ? computeEBITDA(d) / d.gfs_total : null,
            }
          })
        )
        setLocationData(locResults.filter(l => l.gfs > 0).sort((a, b) => b.ebitda - a.ebitda))
      }
    } catch { toast.error('Failed to load P&L data.') }
    setLoading(false)
  }

  async function refresh() { setRefreshing(true); await load(); setRefreshing(false) }
  function toggle(id)      { setCollapsed(p => ({ ...p, [id]: !p[id] })) }

  function resolveVal(line, data) {
    if (line.computeFn) return line.computeFn(data)
    return data[line.key] ?? null
  }

  function exportCSV() {
    const rows = [['Line Item', 'Actual', 'Budget', 'Variance', 'Prior Period']]
    schema.forEach(section => {
      rows.push([section.label.toUpperCase(), '', '', '', ''])
      section.lines.forEach(line => {
        if (line.pct) return
        const actual   = resolveVal(line, pnl)
        const budget   = line.budgetKey ? (pnl[line.budgetKey] ?? null) : null
        const prior    = resolveVal(line, priorPnl)
        const variance = actual != null && budget != null ? actual - budget : null
        rows.push([line.label, actual?.toFixed(2)||'', budget?.toFixed(2)||'', variance?.toFixed(2)||'', prior?.toFixed(2)||''])
      })
    })
    const csv  = rows.map(r => r.map(v => `"${v}"`).join(',')).join('\n')
    const blob = new Blob([csv], { type: 'text/csv' })
    const url  = URL.createObjectURL(blob)
    Object.assign(document.createElement('a'), { href: url, download: `pnl-${periodKey}.csv` }).click()
    URL.revokeObjectURL(url)
  }

  // ── Derived values ───────────────────────────────────────────
  const gfs          = pnl.gfs_total || 0
  const revenue      = pnl.revenue_total || 0
  const labor        = (pnl.cogs_onsite_labor||0) + (pnl.cogs_3rd_party||0)
  const payproc      = gfs * 0.018
  const totalCOGS    = labor + (pnl.cogs_inventory||0) + (pnl.cogs_purchases||0) + (pnl.cogs_waste||0) + payproc
  const grossMargin  = revenue - totalCOGS
  const ebitda       = grossMargin - (pnl.exp_comp_benefits||0)
  const primeCost    = computePrimeCost(pnl)
  const budgetGFS    = pnl.budget_gfs    || 0
  const budgetEBITDA = pnl.budget_ebitda || 0
  const varGFS       = budgetGFS    ? gfs    - budgetGFS    : null
  const varEBITDA    = budgetEBITDA ? ebitda - budgetEBITDA : null

  // Prior period
  const priorGFS    = priorPnl.gfs_total || 0
  const priorRev    = priorPnl.revenue_total || 0
  const priorLabor  = (priorPnl.cogs_onsite_labor||0) + (priorPnl.cogs_3rd_party||0)
  const priorPayp   = priorGFS * 0.018
  const priorCOGS   = priorLabor + (priorPnl.cogs_inventory||0) + (priorPnl.cogs_purchases||0) + (priorPnl.cogs_waste||0) + priorPayp
  const priorEBITDA = (priorRev - priorCOGS) - (priorPnl.exp_comp_benefits||0)

  // Budget pacing
  const pacing      = getPeriodPacing(periodKey)
  const pacingGFS   = budgetGFS && pacing ? budgetGFS * pacing : null
  const onPace      = pacingGFS ? gfs >= pacingGFS : null

  // Prime cost benchmark — industry standard 55-65% of revenue
  const primeStatus = primeCost == null ? null : primeCost <= 0.60 ? 'good' : primeCost <= 0.65 ? 'warn' : 'over'

  const KPIs = [
    {
      label: 'Gross Food Sales',
      val: fmt$(gfs),
      sub: varGFS != null ? `${varGFS>=0?'▲':'▼'} ${fmt$(Math.abs(varGFS))} vs budget` : null,
      subColor: varColor(varGFS),
      badge: onPace != null ? { label: onPace ? 'On pace' : 'Behind pace', ok: onPace } : null,
    },
    {
      label: 'Net Revenue',
      val: fmt$(revenue),
      sub: gfs > 0 ? `${(revenue/gfs*100).toFixed(1)}% of GFS` : null,
    },
    {
      label: 'Prime Cost',
      val: primeCost != null ? fmtPct(primeCost) : '—',
      sub: 'Labor + COGS / Revenue',
      valColor: primeStatus === 'good' ? '#059669' : primeStatus === 'warn' ? '#d97706' : primeStatus === 'over' ? '#dc2626' : undefined,
      badge: primeStatus ? {
        label: primeStatus === 'good' ? '≤60% target' : primeStatus === 'warn' ? '60–65% caution' : '>65% critical',
        ok: primeStatus === 'good',
        warn: primeStatus === 'warn',
      } : null,
    },
    {
      label: 'Gross Margin',
      val: fmt$(grossMargin),
      sub: revenue > 0 ? `${(grossMargin/revenue*100).toFixed(1)}% of Revenue` : null,
      valColor: grossMargin >= 0 ? '#059669' : '#dc2626',
    },
    {
      label: 'EBITDA',
      val: fmt$(ebitda),
      sub: varEBITDA != null ? `${varEBITDA>=0?'▲':'▼'} ${fmt$(Math.abs(varEBITDA))} vs budget` : gfs > 0 ? `${(ebitda/gfs*100).toFixed(1)}% of GFS` : null,
      valColor: ebitda >= 0 ? '#059669' : '#dc2626',
      subColor: varColor(varEBITDA),
      alert: ebitda < 0,
    },
    {
      label: 'Total COGS',
      val: fmt$(totalCOGS),
      sub: revenue > 0 ? `${(totalCOGS/revenue*100).toFixed(1)}% of Revenue` : null,
      valColor: totalCOGS > 0 ? '#dc2626' : undefined,
    },
  ]

  return (
    <div className={styles.page}>

      {/* ── Header ── */}
      <div className={styles.header}>
        <div>
          <h1 className={styles.title}>P&L Dashboard</h1>
          <p className={styles.subtitle}>
            {location ? cleanLocName(location) : `${locNames.length} locations`} · {periodKey}
            {priorPnl.gfs_total ? ` · vs ${getPriorKey(periodKey)}` : ''}
          </p>
        </div>
        <div className={styles.headerRight}>
          <button className={styles.btnExport} onClick={exportCSV}>
            <Download size={13} /> Export
          </button>
          <button className={styles.refreshBtn} onClick={refresh} disabled={refreshing}>
            <RefreshCw size={13} className={refreshing ? styles.spinning : ''} />
          </button>
        </div>
      </div>

      {/* ── Negative EBITDA alert ── */}
      {ebitda < 0 && gfs > 0 && (
        <div className={styles.alertBanner}>
          ⚠️ EBITDA is negative for {periodKey} — {fmt$(ebitda)}. Review labor and COGS immediately.
        </div>
      )}

      {/* ── Data freshness bar ── */}
      <div className={styles.freshnessBar}>
        <span className={styles.freshnessLabel}>Data status</span>
        <div className={styles.freshnessPills}>
          {SOURCES.map(s => {
            const posted = !!(pnl[s.key])
            return (
              <button key={s.key} className={`${styles.freshPill} ${posted ? styles.freshPosted : styles.freshMissing}`} onClick={() => navigate(s.path)}>
                <span className={styles.freshDot} />
                {s.label}
              </button>
            )
          })}
        </div>
      </div>

      {/* ── KPI Strip ── */}
      <div className={styles.kpiStrip}>
        {KPIs.map(k => (
          <div key={k.label} className={`${styles.kpi} ${k.alert ? styles.kpiAlert : ''}`}>
            <div className={styles.kpiL}>{k.label}</div>
            <div className={styles.kpiV} style={{ color: k.valColor }}>{k.val}</div>
            {k.sub && <div className={styles.kpiSub} style={{ color: k.subColor }}>{k.sub}</div>}
            {k.badge && (
              <div className={`${styles.kpiBadge} ${k.badge.ok ? styles.kpiBadgeGood : k.badge.warn ? styles.kpiBadgeWarn : styles.kpiBadgeOver}`}>
                {k.badge.label}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* ── P&L Table ── */}
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
                <th className={styles.thVal} style={{ color: '#666' }}>Prior Period</th>
              </tr>
            </thead>

            {schema.map(section => {
              const isCollapsed = collapsed[section.id]
              return (
                <tbody key={section.id}>
                  <tr className={styles.section} onClick={() => toggle(section.id)}>
                    <td colSpan={5} className={styles.sectionCell} style={{ borderTopColor: section.color, color: section.color }}>
                      <span className={styles.sectionToggle}>
                        {isCollapsed ? <ChevronRight size={11} /> : <ChevronDown size={11} />}
                      </span>
                      {section.label.toUpperCase()}
                    </td>
                  </tr>

                  {!isCollapsed && section.lines.map(line => {
                    if (line.pct) {
                      const v = line.computeFn ? line.computeFn(pnl) : null
                      return (
                        <tr key={line.key} className={styles.pctRow}>
                          <td className={styles.label} style={{ paddingLeft: 16 + (line.indent||0) * 14, fontStyle: 'italic', color: '#888' }}>{line.label}</td>
                          <td className={styles.val} style={{ color: '#888' }}>{v != null ? fmtPct(v) : '—'}</td>
                          <td /><td /><td />
                        </tr>
                      )
                    }

                    const actual   = resolveVal(line, pnl)
                    const prior    = resolveVal(line, priorPnl)
                    const budget   = line.budgetKey ? (pnl[line.budgetKey] ?? null) : null
                    const variance = actual != null && budget != null ? actual - budget : null
                    const vsPrior  = actual != null && prior != null && prior !== 0 ? actual - prior : null

                    return (
                      <tr key={line.key} className={`${styles.row} ${line.bold ? styles.bold : ''} ${line.highlight ? styles.highlight : ''}`}>
                        <td className={styles.label} style={{ paddingLeft: 16 + (line.indent||0) * 14 }}>
                          {line.label}
                          {line.drillTo && (
                            <button className={styles.drillBtn} onClick={e => { e.stopPropagation(); navigate(line.drillTo) }}>
                              <ExternalLink size={10} />
                            </button>
                          )}
                        </td>
                        <td className={styles.val} style={{
                          color: line.danger && actual > 0 ? '#dc2626'
                               : line.highlight ? (actual >= 0 ? '#059669' : '#dc2626')
                               : undefined
                        }}>
                          {actual != null && actual !== 0 ? fmt$(actual) : '—'}
                        </td>
                        <td className={styles.val} style={{ color: '#888' }}>
                          {budget != null && budget !== 0 ? fmt$(budget) : '—'}
                        </td>
                        <td className={styles.val} style={{ color: varColor(variance) }}>
                          {variance != null ? (variance >= 0 ? '+' : '') + fmt$(variance) : '—'}
                        </td>
                        <td className={styles.val} style={{ color: vsPrior != null ? varColor(vsPrior) : '#bbb', fontSize: 12 }}>
                          {vsPrior != null ? (vsPrior >= 0 ? '▲' : '▼') + ' ' + fmt$(Math.abs(vsPrior)) : prior != null && prior !== 0 ? fmt$(prior) : '—'}
                        </td>
                      </tr>
                    )
                  })}
                  <tr className={styles.gap}><td colSpan={5} /></tr>
                </tbody>
              )
            })}

            {/* EBITDA footer */}
            <tbody>
              <tr className={`${styles.row} ${styles.bold} ${styles.ebitdaRow}`}>
                <td className={styles.label} style={{ paddingLeft: 16, fontSize: 14, letterSpacing: '.02em' }}>EBITDA</td>
                <td className={styles.val} style={{ color: ebitda >= 0 ? '#059669' : '#dc2626', fontSize: 15, fontWeight: 800 }}>{fmt$(ebitda)}</td>
                <td className={styles.val} style={{ color: '#888' }}>{budgetEBITDA ? fmt$(budgetEBITDA) : '—'}</td>
                <td className={styles.val} style={{ color: varColor(varEBITDA) }}>{varEBITDA != null ? (varEBITDA >= 0 ? '+' : '') + fmt$(varEBITDA) : '—'}</td>
                <td className={styles.val} style={{ color: priorEBITDA !== 0 ? varColor(ebitda - priorEBITDA) : '#bbb', fontSize: 12 }}>
                  {priorEBITDA !== 0 ? (ebitda >= priorEBITDA ? '▲' : '▼') + ' ' + fmt$(Math.abs(ebitda - priorEBITDA)) : '—'}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      )}

      {/* ── Location ranking table (All Locations only) ── */}
      {isAll && locationData.length > 0 && (
        <div className={styles.rankingWrap}>
          <div className={styles.rankingHeader}>Location Performance — {periodKey}</div>
          <table className={styles.rankingTable}>
            <thead>
              <tr>
                <th>#</th>
                <th>Location</th>
                <th style={{ textAlign: 'right' }}>GFS</th>
                <th style={{ textAlign: 'right' }}>EBITDA</th>
                <th style={{ textAlign: 'right' }}>EBITDA %</th>
              </tr>
            </thead>
            <tbody>
              {locationData.map((loc, i) => (
                <tr key={loc.name} className={styles.rankRow} onClick={() => navigate('/dashboard')}>
                  <td className={styles.rankNum} style={{ color: i === 0 ? '#059669' : i === locationData.length - 1 ? '#dc2626' : '#999' }}>
                    {i + 1}
                  </td>
                  <td className={styles.rankName}>{cleanLocName(loc.name)}</td>
                  <td style={{ textAlign: 'right' }}>{fmt$(loc.gfs)}</td>
                  <td style={{ textAlign: 'right', color: loc.ebitda >= 0 ? '#059669' : '#dc2626', fontWeight: 700 }}>{fmt$(loc.ebitda)}</td>
                  <td style={{ textAlign: 'right', color: loc.ebitdaPct != null ? (loc.ebitdaPct >= 0.10 ? '#059669' : loc.ebitdaPct >= 0 ? '#d97706' : '#dc2626') : '#bbb' }}>
                    {loc.ebitdaPct != null ? fmtPct(loc.ebitdaPct) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}