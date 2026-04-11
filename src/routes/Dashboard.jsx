import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useLocations, cleanLocName } from '@/store/LocationContext'
import { useToast } from '@/components/ui/Toast'
import { useAuthStore } from '@/store/authStore'
import { db } from '@/lib/firebase'
import { doc, getDoc } from 'firebase/firestore'
import { readPnL, getPriorKey, getTrailingPeriodKeys } from '@/lib/pnl'
import { usePnL, useMultiLocationPnL, usePnLHistory } from '@/lib/usePnL'
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

// "Updated X ago" formatter for the live indicator pill
function formatAgo(date) {
  if (!date) return ''
  const sec = Math.floor((Date.now() - date.getTime()) / 1000)
  if (sec < 5)    return 'just now'
  if (sec < 60)   return `${sec}s ago`
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`
  if (sec < 86400)return `${Math.floor(sec / 3600)}h ago`
  return `${Math.floor(sec / 86400)}d ago`
}

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

  const [locationData, setLocationData] = useState([]) // for ranking table
  const [schema,       setSchema]       = useState(DEFAULT_SCHEMA)
  const [collapsed,    setCollapsed]    = useState({})
  const [refreshing,   setRefreshing]   = useState(false)

  const location  = selectedLocation === 'all' ? null : selectedLocation
  const isAll     = selectedLocation === 'all'
  const locNames  = visibleLocations.map(l => l.name)
  const priorKey  = getPriorKey(periodKey)

  // Live subscriptions for current + prior period, single or multi location.
  // Two of each get created but only one pair is actually "active" at a time
  // based on isAll — the unused pair subscribes to an empty set and returns
  // stable empty data with zero Firestore cost. React hooks must be called
  // unconditionally so we pass the no-op inputs rather than conditionally
  // skipping the hook call.
  const singleCurrent = usePnL(!isAll ? location : null, !isAll ? periodKey : null)
  const singlePrior   = usePnL(!isAll ? location : null, !isAll ? priorKey  : null)
  const multiCurrent  = useMultiLocationPnL(isAll ? locNames : [], isAll ? periodKey : null)
  const multiPrior    = useMultiLocationPnL(isAll ? locNames : [], isAll ? priorKey  : null)

  // Trailing 12 periods of historical data for KPI sparklines and trend chart.
  // Loaded once per (locations, periodKey) pair. Not a live subscription —
  // historical periods don't change.
  const trailingKeys = getTrailingPeriodKeys(periodKey, 12)
  const historyLocations = isAll ? locNames : (location ? [location] : [])
  const { byPeriod: history, loading: historyLoading } = usePnLHistory(historyLocations, trailingKeys)

  const pnl       = isAll ? multiCurrent.data : singleCurrent.data
  const priorPnl  = isAll ? multiPrior.data   : singlePrior.data
  const loading   = isAll ? multiCurrent.loading : singleCurrent.loading
  const lastUpdated = isAll
    ? (multiCurrent.lastUpdated || null)
    : (singleCurrent.lastUpdated || null)

  // Schema is still a one-shot read — it rarely changes and doesn't need
  // a live subscription. Loaded once per org + period change.
  useEffect(() => {
    (async () => {
      try {
        const schemaSnap = await getDoc(doc(db, 'tenants', orgId, 'config', 'plSchema'))
        if (schemaSnap.exists() && schemaSnap.data().sections?.length) {
          setSchema(schemaSnap.data().sections)
        }
      } catch {/* fall back to DEFAULT_SCHEMA */}
    })()
  }, [orgId])

  // Location ranking for the All Locations view. Still uses one-shot reads
  // because this is a secondary panel that doesn't need to be live. Will
  // upgrade to live in a future pass if useful.
  useEffect(() => {
    if (!isAll || locNames.length === 0) { setLocationData([]); return }
    let cancelled = false
    ;(async () => {
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
      if (cancelled) return
      setLocationData(locResults.filter(l => l.gfs > 0).sort((a, b) => b.ebitda - a.ebitda))
    })()
    return () => { cancelled = true }
  }, [isAll, periodKey, locNames.join('|')])

  // Manual refresh kept as a visual affordance. Subscriptions already keep
  // data fresh; this just re-runs the secondary (non-live) queries.
  async function refresh() {
    setRefreshing(true)
    try {
      const schemaSnap = await getDoc(doc(db, 'tenants', orgId, 'config', 'plSchema'))
      if (schemaSnap.exists() && schemaSnap.data().sections?.length) {
        setSchema(schemaSnap.data().sections)
      }
    } catch { toast.error('Failed to refresh.') }
    setRefreshing(false)
  }
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

  // ── Spark series for KPI strip ───────────────────────────────
  // Build 5 arrays of 12 values each, one per metric, from history.
  // Each entry aligned to the trailingKeys order (oldest first, newest last).
  const sparkSeries = (() => {
    const gfsArr     = []
    const revArr     = []
    const ebitdaArr  = []
    const primeArr   = []
    const laborPctArr = []
    trailingKeys.forEach(k => {
      const p = history[k] || {}
      const g = p.gfs_total || 0
      const r = p.revenue_total || 0
      const l = (p.cogs_onsite_labor || 0) + (p.cogs_3rd_party || 0)
      const pp = g * 0.018
      const cogsT = l + (p.cogs_inventory || 0) + (p.cogs_purchases || 0) + (p.cogs_waste || 0) + pp
      const gm = r - cogsT
      const eb = gm - (p.exp_comp_benefits || 0)
      const pc = r > 0 ? (l + cogsT - pp) / r : null  // prime cost = labor+COGS (excl payproc double-count)
      const lp = g > 0 ? (l / g) : null
      gfsArr.push(g)
      revArr.push(r)
      ebitdaArr.push(eb)
      primeArr.push(pc != null ? pc * 100 : null)
      laborPctArr.push(lp != null ? lp * 100 : null)
    })
    return { gfs: gfsArr, revenue: revArr, ebitda: ebitdaArr, primeCost: primeArr, laborPct: laborPctArr }
  })()

  // Delta helpers for the 5 KPI cards — compared to the prior period value.
  const deltaPct = (cur, prev) => {
    if (prev == null || prev === 0 || cur == null) return null
    return ((cur - prev) / Math.abs(prev)) * 100
  }
  const laborPctNow   = gfs > 0 ? (labor / gfs) * 100 : null
  const laborPctPrior = priorGFS > 0 ? (priorLabor / priorGFS) * 100 : null
  const laborPctDelta = laborPctNow != null && laborPctPrior != null ? laborPctNow - laborPctPrior : null

  const gfsDelta      = deltaPct(gfs, priorGFS)
  const revDelta      = deltaPct(revenue, priorRev)
  const ebitdaDelta   = ebitda != null && priorEBITDA != null ? ebitda - priorEBITDA : null

  // Mini inline SVG sparkline — hand-rolled, no recharts for this tiny thing.
  // data: array of numbers (nulls allowed), color: stroke color, height: px.
  function Sparkline({ data, color, height = 26 }) {
    const valid = data.filter(v => v != null && !isNaN(v) && v !== 0)
    // Don't render a chart with too few real points — it ends up as a
    // misleading zigzag between min and max. Empty placeholder instead.
    if (valid.length < 3) return <div style={{ height }} />
    const min = Math.min(...valid)
    const max = Math.max(...valid)
    const range = max - min
    // If every value is identical, the "chart" is a flat line. Skip.
    if (range === 0) return <div style={{ height }} />
    const W = 100
    const H = 22
    const xStep = W / (data.length - 1)
    const points = data.map((v, i) => {
      if (v == null || isNaN(v)) return null
      const x = i * xStep
      const y = H - ((v - min) / range) * H
      return `${x.toFixed(1)},${y.toFixed(1)}`
    }).filter(Boolean).join(' ')
    return (
      <svg width="100%" height={height} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ display: 'block' }}>
        <polyline
          points={points}
          fill="none"
          stroke={color}
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
    )
  }




  return (
    <div className={styles.page}>

      {/* ── Header ── */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '0 0 20px', marginBottom: 20,
        borderBottom: '0.5px solid #e5e7eb',
      }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ fontSize: 11, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 500 }}>
            Finance
          </div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
            <h1 style={{ margin: 0, fontSize: 24, fontWeight: 600, color: '#0f172a', letterSpacing: '-0.01em' }}>P&L</h1>
            <span style={{ color: '#cbd5e1', fontSize: 16 }}>›</span>
            <span style={{ fontSize: 14, color: '#475569' }}>
              {location ? cleanLocName(location) : `${locNames.length} locations`}
            </span>
            <span style={{ color: '#cbd5e1' }}>·</span>
            <span style={{ fontSize: 14, color: '#475569' }}>{periodKey}</span>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          {/* Live indicator */}
          <div style={{
            display: 'flex', alignItems: 'center', gap: 6,
            padding: '6px 10px',
            background: lastUpdated ? '#ecfdf5' : '#f8fafc',
            border: `0.5px solid ${lastUpdated ? '#a7f3d0' : '#e2e8f0'}`,
            borderRadius: 999,
            fontSize: 11, fontWeight: 500,
            color: lastUpdated ? '#047857' : '#94a3b8',
          }}>
            <span style={{
              width: 6, height: 6, borderRadius: '50%',
              background: lastUpdated ? '#10b981' : '#cbd5e1',
              boxShadow: lastUpdated ? '0 0 0 2px rgba(16, 185, 129, 0.2)' : 'none',
              animation: lastUpdated ? 'pulse 2s ease-in-out infinite' : 'none',
            }} />
            {lastUpdated ? `Live · updated ${formatAgo(lastUpdated)}` : 'Waiting for data'}
          </div>

          <button
            onClick={exportCSV}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 6,
              padding: '7px 13px', fontSize: 12, fontWeight: 500,
              background: '#fff', color: '#475569',
              border: '0.5px solid #e2e8f0', borderRadius: 8,
              cursor: 'pointer',
            }}
          >
            <Download size={13} /> Export
          </button>
          <button
            onClick={refresh}
            disabled={refreshing}
            style={{
              display: 'inline-flex', alignItems: 'center',
              padding: 8, background: '#fff',
              border: '0.5px solid #e2e8f0', borderRadius: 8,
              cursor: refreshing ? 'wait' : 'pointer',
            }}
          >
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

      {/* ── KPI Strip (Pattern 3, 5 columns) ── */}
      {(() => {
        // Columns defined inline for readability. Each column knows its value,
        // its delta vs prior, its sparkline data, and its color rules.
        const fmtSmall$ = v => {
          if (v == null || isNaN(v)) return '—'
          const abs = Math.abs(v)
          if (abs >= 1_000_000) return '$' + (abs/1_000_000).toFixed(1) + 'M'
          if (abs >= 1_000)     return '$' + Math.round(abs/1_000) + 'k'
          return '$' + Math.round(abs)
        }
        const fmtBig$ = v => {
          if (v == null || isNaN(v)) return '—'
          return '$' + Math.round(v).toLocaleString('en-US')
        }
        const primeColor = primeStatus === 'over'  ? '#b45309'
                          : primeStatus === 'warn' ? '#b45309'
                          : '#0f172a'
        const deltaRow = (val, suffix = '', goodIsUp = true) => {
          if (val == null || isNaN(val)) return null
          const up = val >= 0
          const good = goodIsUp ? up : !up
          return (
            <span style={{ fontSize: 11, fontWeight: 500, color: good ? '#059669' : '#dc2626' }}>
              {up ? '▲' : '▼'} {Math.abs(val).toFixed(1)}{suffix}
            </span>
          )
        }
        const columns = [
          {
            label: 'Gross food sales',
            value: fmtBig$(gfs),
            delta: deltaRow(gfsDelta, '%'),
            sub: 'vs last period',
            sparkData: sparkSeries.gfs,
            sparkColor: '#1D9E75',
            valueColor: '#0f172a',
          },
          {
            label: 'Net revenue',
            value: fmtBig$(revenue),
            delta: deltaRow(revDelta, '%'),
            sub: gfs > 0 ? `${Math.round(revenue/gfs*100)}% of GFS` : 'vs last period',
            sparkData: sparkSeries.revenue,
            sparkColor: '#1D9E75',
            valueColor: '#0f172a',
          },
          {
            label: 'EBITDA',
            value: fmtBig$(ebitda),
            delta: ebitdaDelta != null ? (
              <span style={{ fontSize: 11, fontWeight: 500, color: ebitdaDelta >= 0 ? '#059669' : '#dc2626' }}>
                {ebitdaDelta >= 0 ? '▲' : '▼'} {fmtSmall$(ebitdaDelta)}
              </span>
            ) : null,
            sub: 'vs last period',
            sparkData: sparkSeries.ebitda,
            sparkColor: ebitda >= 0 ? '#1D9E75' : '#dc2626',
            valueColor: ebitda >= 0 ? '#0f172a' : '#dc2626',
          },
          {
            label: 'Prime cost %',
            value: primeCost != null ? (primeCost * 100).toFixed(1) + '%' : '—',
            delta: null,
            sub: primeStatus === 'good' ? 'under 60% target'
                 : primeStatus === 'warn' ? 'approaching 65% ceiling'
                 : primeStatus === 'over' ? 'above 65% critical'
                 : 'labor + COGS / revenue',
            subColor: primeStatus === 'good' ? '#059669'
                      : primeStatus ? '#b45309' : '#94a3b8',
            sparkData: sparkSeries.primeCost,
            sparkColor: primeStatus === 'good' ? '#1D9E75' : '#BA7517',
            valueColor: primeColor,
          },
          {
            label: 'Labor %',
            value: laborPctNow != null ? laborPctNow.toFixed(1) + '%' : '—',
            delta: laborPctDelta != null ? (
              <span style={{ fontSize: 11, fontWeight: 500, color: laborPctDelta <= 0 ? '#059669' : '#dc2626' }}>
                {laborPctDelta <= 0 ? '▼' : '▲'} {Math.abs(laborPctDelta).toFixed(1)}pp
              </span>
            ) : null,
            sub: 'vs last period',
            sparkData: sparkSeries.laborPct,
            sparkColor: '#1D9E75',
            valueColor: '#0f172a',
          },
        ]
        return (
          <div style={{
            background: '#fff',
            border: '0.5px solid #e5e7eb',
            borderRadius: 12,
            padding: '22px 28px',
            marginBottom: 24,
            display: 'grid',
            gridTemplateColumns: 'repeat(5, minmax(0, 1fr))',
            gap: 0,
          }}>
            {columns.map((c, i) => (
              <div key={c.label} style={{
                padding: i === 0 ? '0 24px 0 0'
                        : i === columns.length - 1 ? '0 0 0 24px'
                        : '0 24px',
                borderRight: i < columns.length - 1 ? '0.5px solid #e5e7eb' : 'none',
                minWidth: 0,
              }}>
                <div style={{ fontSize: 11, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 500, marginBottom: 10 }}>
                  {c.label}
                </div>
                <div style={{ fontSize: 24, fontWeight: 500, color: c.valueColor, letterSpacing: '-0.01em', lineHeight: 1.15 }}>
                  {c.value}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 7, minHeight: 14 }}>
                  {c.delta}
                  <span style={{ fontSize: 11, color: c.subColor || '#94a3b8' }}>{c.sub}</span>
                </div>
                <div style={{ marginTop: 10 }}>
                  <Sparkline data={c.sparkData} color={c.sparkColor} />
                </div>
              </div>
            ))}
          </div>
        )
      })()}

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