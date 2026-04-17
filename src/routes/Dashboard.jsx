import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useLocations, cleanLocName } from '@/store/LocationContext'
import { useToast } from '@/components/ui/Toast'
import { useAuthStore } from '@/store/authStore'
import { db } from '@/lib/firebase'
import { doc, getDoc } from 'firebase/firestore'
import { readPnL, getPriorKey, getTrailingPeriodKeys, writePeriodClose } from '@/lib/pnl'
import { usePeriodStatus } from '@/hooks/usePeriodStatus'
import { usePnL, useMultiLocationPnL, usePnLHistory } from '@/lib/usePnL'
import { usePeriod } from '@/store/PeriodContext'
import { ChevronDown, ChevronRight, RefreshCw, Download, ExternalLink } from 'lucide-react'
import {
  LineChart, Line as RLine, XAxis as RXAxis, YAxis as RYAxis,
  Tooltip as RTooltip, ResponsiveContainer as RResponsiveContainer,
  ReferenceLine as RReferenceLine,
} from 'recharts'
import styles from './Dashboard.module.css'
import WhyPanel from './components/WhyPanel'
import { buildPeriodDiff } from '@/lib/whyRules'

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
      // Popup revenue sub-lines
      { key: 'rev_popup_cogs',       label: 'Popup COGS',                       indent: 2, negative: true },
      { key: 'rev_popup_food_sales', label: 'Popup Gross Food Sales',           indent: 2 },
      { key: 'rev_popup_tax',        label: 'Popup Tax',                        indent: 2 },
      { key: 'rev_popup_pp_fee',     label: 'Popup PP Fee Revenue',             indent: 2 },
      // Catering revenue sub-lines
      { key: 'rev_catering_cogs',    label: 'Catering COGS',                    indent: 2, negative: true },
      { key: 'rev_catering_revenue', label: 'Catering Revenue',                 indent: 2 },
      { key: 'rev_catering_pp_fee',  label: 'Payment Processing Fee - Catering', indent: 2 },
      // Delivery
      { key: 'rev_delivery_cogs',    label: 'Delivery COGS',                    indent: 2, negative: true },
      // Retail
      { key: 'rev_retail_barista',   label: 'Retail Revenue - Barista',         indent: 2 },
      { key: 'rev_retail_cafeteria', label: 'Retail Revenue - Cafeteria',       indent: 2 },
      // Retail COGS (tax)
      { key: 'rev_retail_cogs_tax',  label: 'Retail COGS - Tax',               indent: 2, negative: true },
      // Customer Fees
      { key: 'rev_client_fees',      label: 'Popup Client Fees',                indent: 2 },
      // Total
      { key: 'revenue_total',        label: 'Total Revenue',                    bold: true, budgetKey: 'budget_revenue',
        computeFn: p => {
          return (p.rev_popup_cogs||0) + (p.rev_popup_food_sales||0) + (p.rev_popup_tax||0) + (p.rev_popup_pp_fee||0)
               + (p.rev_catering_cogs||0) + (p.rev_catering_revenue||0) + (p.rev_catering_pp_fee||0)
               + (p.rev_delivery_cogs||0)
               + (p.rev_retail_barista||0) + (p.rev_retail_cafeteria||0) + (p.rev_retail_cogs_tax||0)
               + (p.rev_client_fees||0)
        }
      },
    ]
  },
  {
    id: 'cogs', label: 'COGS', color: '#dc2626',
    lines: [
      // Location Costs — Onsite Labor
      { key: 'cogs_labor_salaries',  label: 'Onsite Labor (Fooda) Salaries and Wages', indent: 2, drillTo: '/labor' },
      { key: 'cogs_labor_401k',      label: 'Onsite Labor 401k',               indent: 2, drillTo: '/labor' },
      { key: 'cogs_labor_benefits',  label: 'Onsite Labor Benefits',            indent: 2, drillTo: '/labor' },
      { key: 'cogs_labor_taxes',     label: 'Onsite Labor Taxes',               indent: 2, drillTo: '/labor' },
      { key: 'cogs_labor_bonus',     label: 'Onsite Bonus',                     indent: 2, drillTo: '/labor' },
      { key: '_labor_subtotal',      label: 'Total Onsite Labor',               bold: true, indent: 1, budgetKey: 'budget_labor',
        computeFn: p => (p.cogs_labor_salaries||0) + (p.cogs_labor_401k||0) + (p.cogs_labor_benefits||0)
                      + (p.cogs_labor_taxes||0) + (p.cogs_labor_bonus||0)
                      + (p.cogs_onsite_labor||0) + (p.cogs_3rd_party||0)  // backward compat with old single-line writes
      },
      // Location Costs — Equipment & Consumables
      { key: 'cogs_cleaning',        label: 'Cleaning Supplies & Chemicals',    indent: 2 },
      { key: 'cogs_equipment',       label: 'Onsite Equipment',                 indent: 2 },
      { key: 'cogs_ec_barista',      label: 'Equipment and Consumables - Barista', indent: 2 },
      { key: 'cogs_paper',           label: 'Paper Products & Consumables',     indent: 2 },
      { key: 'cogs_supplies',        label: 'Onsite Supplies',                  indent: 2 },
      { key: 'cogs_uniforms',        label: 'Onsite Uniforms',                  indent: 2 },
      { key: '_ec_subtotal',         label: 'Total Onsite Equipment and Consumables', bold: true, indent: 1,
        computeFn: p => (p.cogs_cleaning||0) + (p.cogs_equipment||0) + (p.cogs_ec_barista||0)
                      + (p.cogs_paper||0) + (p.cogs_supplies||0) + (p.cogs_uniforms||0)
      },
      // Location Costs — Maintenance & Other
      { key: 'cogs_maintenance',     label: 'Onsite Other',                     indent: 1 },
      // Payment Processing
      { key: 'cogs_payment_processing', label: 'Bank Charges, Merchant Fees',   indent: 1 },
      // Retail COGS
      { key: 'cogs_retail_barista',  label: 'Retail COGS - Barista',            indent: 2 },
      { key: 'cogs_retail_cafeteria', label: 'Retail COGS - Cafeteria',         indent: 2 },
      { key: 'cogs_retail_managed',  label: 'Retail COGS - Managed Service Cost', indent: 2 },
      { key: '_retail_cogs_subtotal', label: 'Total Retail COGS',               bold: true, indent: 1,
        computeFn: p => (p.cogs_retail_barista||0) + (p.cogs_retail_cafeteria||0) + (p.cogs_retail_managed||0)
      },
      // Inventory and Purchases (backward compat)
      { key: 'cogs_inventory',       label: 'Inventory Usage',                  indent: 1, drillTo: '/inventory' },
      { key: 'cogs_purchases',       label: 'Purchases (AP)',                   indent: 1, drillTo: '/purchasing' },
      // Total COGS
      { key: '_total_cogs',          label: 'Total COGS',                       bold: true, budgetKey: 'budget_cogs',
        computeFn: p => {
          const labor = (p.cogs_labor_salaries||0) + (p.cogs_labor_401k||0) + (p.cogs_labor_benefits||0)
                      + (p.cogs_labor_taxes||0) + (p.cogs_labor_bonus||0)
                      + (p.cogs_onsite_labor||0) + (p.cogs_3rd_party||0)
          const ec    = (p.cogs_cleaning||0) + (p.cogs_equipment||0) + (p.cogs_ec_barista||0)
                      + (p.cogs_paper||0) + (p.cogs_supplies||0) + (p.cogs_uniforms||0)
          const retail = (p.cogs_retail_barista||0) + (p.cogs_retail_cafeteria||0) + (p.cogs_retail_managed||0)
          return labor + ec + (p.cogs_maintenance||0) + (p.cogs_payment_processing||0)
               + retail + (p.cogs_inventory||0) + (p.cogs_purchases||0)
        }
      },
    ]
  },
  {
    id: 'gp', label: 'Gross Profit', color: '#059669',
    lines: [
      { key: '_gross_profit', label: 'Gross Profit', bold: true, highlight: true,
        computeFn: p => {
          const rev = (p.rev_popup_cogs||0) + (p.rev_popup_food_sales||0) + (p.rev_popup_tax||0) + (p.rev_popup_pp_fee||0)
                    + (p.rev_catering_cogs||0) + (p.rev_catering_revenue||0) + (p.rev_catering_pp_fee||0)
                    + (p.rev_delivery_cogs||0)
                    + (p.rev_retail_barista||0) + (p.rev_retail_cafeteria||0) + (p.rev_retail_cogs_tax||0)
                    + (p.rev_client_fees||0)
          // Fallback to old revenue_total if new sub-lines not populated yet
          const revenue = rev !== 0 ? rev : (p.revenue_total || (p.gfs_total||0) * 0.82)
          const labor = (p.cogs_labor_salaries||0) + (p.cogs_labor_401k||0) + (p.cogs_labor_benefits||0)
                      + (p.cogs_labor_taxes||0) + (p.cogs_labor_bonus||0)
                      + (p.cogs_onsite_labor||0) + (p.cogs_3rd_party||0)
          const ec    = (p.cogs_cleaning||0) + (p.cogs_equipment||0) + (p.cogs_ec_barista||0)
                      + (p.cogs_paper||0) + (p.cogs_supplies||0) + (p.cogs_uniforms||0)
          const retail = (p.cogs_retail_barista||0) + (p.cogs_retail_cafeteria||0) + (p.cogs_retail_managed||0)
          const cogs  = labor + ec + (p.cogs_maintenance||0) + (p.cogs_payment_processing||0)
                      + retail + (p.cogs_inventory||0) + (p.cogs_purchases||0)
          return revenue - cogs
        }
      },
    ]
  },
  {
    id: 'expenses', label: 'Expenses (General and Other)', color: '#d97706',
    lines: [
      { key: 'exp_office_supplies',  label: 'Office Supplies & Equipment',      indent: 1 },
      { key: 'exp_mktg_cashier',     label: 'Cashier Discounts',                indent: 2 },
      { key: 'exp_mktg_coupons',     label: 'Coupons',                          indent: 2 },
      { key: 'exp_mktg_marketing',   label: 'Marketing',                        indent: 2 },
      { key: 'exp_mktg_other',       label: 'Other Marketing and Advertising',  indent: 2 },
      { key: '_mktg_subtotal',       label: 'Total Marketing & Advertising',    bold: true, indent: 1,
        computeFn: p => (p.exp_mktg_cashier||0) + (p.exp_mktg_coupons||0) + (p.exp_mktg_marketing||0) + (p.exp_mktg_other||0)
      },
      { key: 'exp_technology',       label: 'Technology Services',              indent: 1 },
      { key: 'exp_travel',           label: 'Travel and Entertainment',         indent: 1 },
      { key: 'exp_professional',     label: 'Professional Fees',                indent: 1 },
      { key: 'exp_facilities',       label: 'Facilities',                       indent: 1 },
      { key: 'exp_licenses',         label: 'Licenses, Permits and Fines',      indent: 1 },
      { key: 'exp_other',            label: 'Other Expenses',                   indent: 1 },
      { key: 'exp_comp_benefits',    label: 'Compensation & Benefits',          indent: 1 },
      { key: '_total_exp',           label: 'Total Expenses',                   bold: true, budgetKey: 'budget_expenses',
        computeFn: p => (p.exp_office_supplies||0) + (p.exp_mktg_cashier||0) + (p.exp_mktg_coupons||0)
                      + (p.exp_mktg_marketing||0) + (p.exp_mktg_other||0) + (p.exp_technology||0)
                      + (p.exp_travel||0) + (p.exp_professional||0) + (p.exp_facilities||0)
                      + (p.exp_licenses||0) + (p.exp_other||0) + (p.exp_comp_benefits||0)
      },
    ]
  },
  {
    id: 'ebitda', label: 'EBITDA', color: '#059669',
    lines: [
      { key: '_ebitda', label: 'EBITDA', bold: true, highlight: true, budgetKey: 'budget_ebitda',
        computeFn: p => {
          const rev = (p.rev_popup_cogs||0) + (p.rev_popup_food_sales||0) + (p.rev_popup_tax||0) + (p.rev_popup_pp_fee||0)
                    + (p.rev_catering_cogs||0) + (p.rev_catering_revenue||0) + (p.rev_catering_pp_fee||0)
                    + (p.rev_delivery_cogs||0)
                    + (p.rev_retail_barista||0) + (p.rev_retail_cafeteria||0) + (p.rev_retail_cogs_tax||0)
                    + (p.rev_client_fees||0)
          const revenue = rev !== 0 ? rev : (p.revenue_total || (p.gfs_total||0) * 0.82)
          const labor = (p.cogs_labor_salaries||0) + (p.cogs_labor_401k||0) + (p.cogs_labor_benefits||0)
                      + (p.cogs_labor_taxes||0) + (p.cogs_labor_bonus||0)
                      + (p.cogs_onsite_labor||0) + (p.cogs_3rd_party||0)
          const ec    = (p.cogs_cleaning||0) + (p.cogs_equipment||0) + (p.cogs_ec_barista||0)
                      + (p.cogs_paper||0) + (p.cogs_supplies||0) + (p.cogs_uniforms||0)
          const retail = (p.cogs_retail_barista||0) + (p.cogs_retail_cafeteria||0) + (p.cogs_retail_managed||0)
          const cogs  = labor + ec + (p.cogs_maintenance||0) + (p.cogs_payment_processing||0)
                      + retail + (p.cogs_inventory||0) + (p.cogs_purchases||0)
          const gp    = revenue - cogs
          const exp   = (p.exp_office_supplies||0) + (p.exp_mktg_cashier||0) + (p.exp_mktg_coupons||0)
                      + (p.exp_mktg_marketing||0) + (p.exp_mktg_other||0) + (p.exp_technology||0)
                      + (p.exp_travel||0) + (p.exp_professional||0) + (p.exp_facilities||0)
                      + (p.exp_licenses||0) + (p.exp_other||0) + (p.exp_comp_benefits||0)
          return gp - exp
        }
      },
      { key: '_pct_ebitda_gfs', label: 'EBITDA % of GFS', pct: true, indent: 1,
        computeFn: p => {
          const rev = (p.rev_popup_cogs||0) + (p.rev_popup_food_sales||0) + (p.rev_popup_tax||0) + (p.rev_popup_pp_fee||0)
                    + (p.rev_catering_cogs||0) + (p.rev_catering_revenue||0) + (p.rev_catering_pp_fee||0)
                    + (p.rev_delivery_cogs||0)
                    + (p.rev_retail_barista||0) + (p.rev_retail_cafeteria||0) + (p.rev_retail_cogs_tax||0)
                    + (p.rev_client_fees||0)
          const revenue = rev !== 0 ? rev : (p.revenue_total || (p.gfs_total||0) * 0.82)
          const labor = (p.cogs_labor_salaries||0) + (p.cogs_labor_401k||0) + (p.cogs_labor_benefits||0)
                      + (p.cogs_labor_taxes||0) + (p.cogs_labor_bonus||0)
                      + (p.cogs_onsite_labor||0) + (p.cogs_3rd_party||0)
          const ec    = (p.cogs_cleaning||0) + (p.cogs_equipment||0) + (p.cogs_ec_barista||0)
                      + (p.cogs_paper||0) + (p.cogs_supplies||0) + (p.cogs_uniforms||0)
          const retail = (p.cogs_retail_barista||0) + (p.cogs_retail_cafeteria||0) + (p.cogs_retail_managed||0)
          const cogs  = labor + ec + (p.cogs_maintenance||0) + (p.cogs_payment_processing||0)
                      + retail + (p.cogs_inventory||0) + (p.cogs_purchases||0)
          const gp    = revenue - cogs
          const exp   = (p.exp_office_supplies||0) + (p.exp_mktg_cashier||0) + (p.exp_mktg_coupons||0)
                      + (p.exp_mktg_marketing||0) + (p.exp_mktg_other||0) + (p.exp_technology||0)
                      + (p.exp_travel||0) + (p.exp_professional||0) + (p.exp_facilities||0)
                      + (p.exp_licenses||0) + (p.exp_other||0) + (p.exp_comp_benefits||0)
          const ebitda = gp - exp
          return (p.gfs_total||0) > 0 ? ebitda / (p.gfs_total||0) : null
        }
      },
    ]
  },
]

const SOURCES = [
  { label: 'Sales',      key: 'gfs_total',           path: '/sales'      },
  { label: 'Labor',      key: 'cogs_labor_salaries',  path: '/labor'      },
  { label: 'Purchasing', key: 'cogs_purchases',        path: '/purchasing' },
  { label: 'Inventory',  key: 'cogs_inventory',        path: '/inventory'  },
]

const fmt$ = v => {
  if (v === null || v === undefined) return '—'
  if (v === 0) return '$0.00'
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
  const gm      = rev - (labor + (p.cogs_inventory||0) + (p.cogs_purchases||0) + payproc)
  return gm - (p.exp_comp_benefits||0)
}

function computePrimeCost(p) {
  const rev   = p.revenue_total || (p.gfs_total||0) * 0.82
  const labor = (p.cogs_onsite_labor||0) + (p.cogs_3rd_party||0) + (p.exp_comp_benefits||0)
  const cogs  = (p.cogs_inventory||0) + (p.cogs_purchases||0)
  return rev > 0 ? (labor + cogs) / rev : null
}

// Apply a scenario to a baseline pnl object. Returns a NEW object with the
// same shape as the input — every consumer can read it like a real pnl.
//
// scenario: { revenueDelta, laborDelta, foodCostDelta }
//   revenueDelta: percent (-30 to +30) — scales GFS, revenue, and the
//                 payment processing line which is GFS-derived
//   laborDelta:   percentage POINTS (-5 to +5) added to current labor %.
//                 Recomputes onsite + 3rd party labor proportionally.
//   foodCostDelta: percentage POINTS added to current food cost %.
//                  Recomputes inventory + purchases proportionally.
//
// All adjustments preserve the relative mix of sub-lines so we don't
// arbitrarily reweight the underlying components.
function applyScenario(baselinePnl, scenario) {
  if (!scenario || (scenario.revenueDelta === 0 && scenario.laborDelta === 0 && scenario.foodCostDelta === 0)) {
    return baselinePnl
  }
  const out = { ...baselinePnl }

  // 1. Revenue scaling
  const revScale = 1 + (scenario.revenueDelta / 100)
  if (scenario.revenueDelta !== 0) {
    out.gfs_total          = (baselinePnl.gfs_total          || 0) * revScale
    out.gfs_retail         = (baselinePnl.gfs_retail         || 0) * revScale
    out.gfs_catering       = (baselinePnl.gfs_catering       || 0) * revScale
    out.gfs_popup          = (baselinePnl.gfs_popup          || 0) * revScale
    out.revenue_total      = (baselinePnl.revenue_total      || 0) * revScale
    out.revenue_commission = (baselinePnl.revenue_commission || 0) * revScale
  }

  // 2. Labor adjustment (in percentage points of GFS)
  // Current labor = onsite + 3rd party. Compute current labor%, add the
  // delta, find the new total dollar amount, then scale both sub-lines.
  if (scenario.laborDelta !== 0) {
    const gfsForCalc = out.gfs_total || baselinePnl.gfs_total || 0
    const currentLabor = (baselinePnl.cogs_onsite_labor || 0) + (baselinePnl.cogs_3rd_party || 0)
    if (gfsForCalc > 0 && currentLabor > 0) {
      const currentLaborPct = currentLabor / gfsForCalc
      const newLaborPct = currentLaborPct + (scenario.laborDelta / 100)
      const newLabor = Math.max(0, gfsForCalc * newLaborPct)
      const scale = currentLabor > 0 ? newLabor / currentLabor : 1
      out.cogs_onsite_labor = (baselinePnl.cogs_onsite_labor || 0) * scale
      out.cogs_3rd_party    = (baselinePnl.cogs_3rd_party    || 0) * scale
    }
  }

  // 3. Food cost adjustment (in percentage points of revenue)
  // Current food cost = inventory + purchases. Same approach.
  if (scenario.foodCostDelta !== 0) {
    const revForCalc = out.revenue_total || baselinePnl.revenue_total || 0
    const currentFood = (baselinePnl.cogs_inventory || 0) + (baselinePnl.cogs_purchases || 0)
    if (revForCalc > 0 && currentFood > 0) {
      const currentFoodPct = currentFood / revForCalc
      const newFoodPct = currentFoodPct + (scenario.foodCostDelta / 100)
      const newFood = Math.max(0, revForCalc * newFoodPct)
      const scale = currentFood > 0 ? newFood / currentFood : 1
      out.cogs_inventory = (baselinePnl.cogs_inventory || 0) * scale
      out.cogs_purchases = (baselinePnl.cogs_purchases || 0) * scale
    }
  }

  return out
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
  const isDirector = /^(admin|director)$/i.test(user?.role || '')
  const orgId    = user?.tenantId || 'fooda'
  const { selectedLocation, visibleLocations } = useLocations()
  const { periodKey } = usePeriod()

  const [locationData, setLocationData] = useState([]) // for ranking table
  const [schema,       setSchema]       = useState(DEFAULT_SCHEMA)
  const [collapsed,    setCollapsed]    = useState({})
  const [refreshing,   setRefreshing]   = useState(false)
  const [whyLine,      setWhyLine]      = useState(null)  // {line, actual, budget, prior}

  // ── Scenario scratchpad state ──
  // Three sliders that produce a derived pnl for what-if modeling.
  // All deltas are 0 by default (= identity, no scenario applied).
  const [scenarioOpen,    setScenarioOpen]    = useState(false)
  const [revenueDelta,    setRevenueDelta]    = useState(0)   // -30 to +30 (percent)
  const [laborDelta,      setLaborDelta]      = useState(0)   // -5 to +5 (percentage points)
  const [foodCostDelta,   setFoodCostDelta]   = useState(0)   // -5 to +5 (percentage points)
  const [applyToTable,    setApplyToTable]    = useState(false)
  function resetScenario() {
    setRevenueDelta(0); setLaborDelta(0); setFoodCostDelta(0)
  }

  const location  = selectedLocation === 'all' ? null : selectedLocation
  const isAll     = selectedLocation === 'all'
  const locNames  = visibleLocations.map(l => l.name)
  const priorKey  = getPriorKey(periodKey)

  // Period close status
  const closeStatus = usePeriodStatus(location, periodKey)
  const isClosed = closeStatus.periodStatus === 'closed'

  async function handleClosePeriod() {
    if (!location || !periodKey) return
    const actor = user?.name || user?.email || 'unknown'
    const confirmMsg = `Close ${periodKey} for ${cleanLocName(location)}?\n\nThis will lock all source data for this period. You can reopen later if needed.`
    if (!window.confirm(confirmMsg)) return
    try {
      await writePeriodClose(location, periodKey, { status: 'closed', actor })
      toast.success(`Period ${periodKey} closed`)
      window.location.reload()
    } catch (err) {
      toast.error('Failed to close period: ' + (err.message || 'unknown'))
    }
  }

  async function handleReopenPeriod() {
    if (!location || !periodKey) return
    const actor = user?.name || user?.email || 'unknown'
    const reason = window.prompt('Reason for reopening this period:')
    if (!reason || !reason.trim()) return
    try {
      await writePeriodClose(location, periodKey, { status: 'reopened', actor, reason: reason.trim() })
      toast.success(`Period ${periodKey} reopened`)
      window.location.reload()
    } catch (err) {
      toast.error('Failed to reopen period: ' + (err.message || 'unknown'))
    }
  }

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
  // Schema is fixed to DEFAULT_SCHEMA (Enterprise P&L structure).
  // Budget uploads populate the Budget column via field keys but don't
  // override the P&L layout. Dynamic schema from budgetSchema disabled
  // until field-key mapping layer is built post-pilot.
  // useEffect(() => {
  //   (async () => {
  //     try {
  //       const schemaSnap = await getDoc(doc(db, 'tenants', orgId, 'config', 'budgetSchema'))
  //       if (schemaSnap.exists() && schemaSnap.data().sections?.length) {
  //         setSchema(schemaSnap.data().sections)
  //       }
  //     } catch {/* fall back to DEFAULT_SCHEMA */}
  //   })()
  // }, [orgId])

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
      // Schema reload disabled — using fixed DEFAULT_SCHEMA
      // const schemaSnap = await getDoc(doc(db, 'tenants', orgId, 'config', 'budgetSchema'))
      // if (schemaSnap.exists() && schemaSnap.data().sections?.length) {
      //   setSchema(schemaSnap.data().sections)
      // }
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
  const totalCOGS    = labor + (pnl.cogs_inventory||0) + (pnl.cogs_purchases||0) + payproc
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
  const priorCOGS   = priorLabor + (priorPnl.cogs_inventory||0) + (priorPnl.cogs_purchases||0) + priorPayp
  const priorEBITDA = (priorRev - priorCOGS) - (priorPnl.exp_comp_benefits||0)

  // Budget pacing
  const pacing      = getPeriodPacing(periodKey)
  const pacingGFS   = budgetGFS && pacing ? budgetGFS * pacing : null
  const onPace      = pacingGFS ? gfs >= pacingGFS : null

  // Prime cost benchmark — industry standard 55-65% of revenue
  const primeStatus = primeCost == null ? null : primeCost <= 0.60 ? 'good' : primeCost <= 0.65 ? 'warn' : 'over'

  // Scenario derived values — recomputed whenever sliders change
  const scenario = { revenueDelta, laborDelta, foodCostDelta }
  const scenarioActive = revenueDelta !== 0 || laborDelta !== 0 || foodCostDelta !== 0
  const scenarioPnl = scenarioActive ? applyScenario(pnl, scenario) : pnl
  const scenGfs     = scenarioPnl.gfs_total || 0
  const scenRev     = scenarioPnl.revenue_total || 0
  const scenLabor   = (scenarioPnl.cogs_onsite_labor || 0) + (scenarioPnl.cogs_3rd_party || 0)
  const scenPayp    = scenGfs * 0.018
  const scenCogs    = scenLabor + (scenarioPnl.cogs_inventory || 0) + (scenarioPnl.cogs_purchases || 0) + scenPayp
  const scenGm      = scenRev - scenCogs
  const scenEbitda  = scenGm - (scenarioPnl.exp_comp_benefits || 0)
  const scenPrime   = scenRev > 0 ? (scenLabor + scenCogs - scenPayp) / scenRev : null
  const scenLaborPct = scenGfs > 0 ? scenLabor / scenGfs : null

  // EBITDA delta vs baseline — the headline output of the scratchpad
  const scenarioEbitdaDelta = scenarioActive ? scenEbitda - ebitda : 0


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
      const cogsT = l + (p.cogs_inventory || 0) + (p.cogs_purchases || 0) + pp
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

  // Anomaly detection for a P&L line. Walks the trailing 12 periods of
  // history, computes mean + stddev for that line, and flags current as
  // anomalous if it's more than 2 stddevs from mean OR (when budget exists)
  // the variance-to-budget exceeds 15 percent.
  //
  // Returns { isAnomaly, reason, severity: 'warn' | 'alert' } or null.
  function detectAnomaly(line, currentValue, budgetValue) {
    if (line.pct || line.key?.startsWith('_pct')) return null
    if (currentValue == null || currentValue === 0) return null

    // 1. Budget variance check — the easier and more obvious signal
    if (budgetValue != null && budgetValue !== 0) {
      const variancePct = Math.abs((currentValue - budgetValue) / budgetValue)
      if (variancePct > 0.15) {
        return {
          isAnomaly: true,
          reason: `${Math.round(variancePct * 100)}% vs budget`,
          severity: variancePct > 0.30 ? 'alert' : 'warn',
        }
      }
    }

    // 2. Statistical outlier check — needs at least 4 historical points
    const historicalValues = trailingKeys
      .slice(0, -1)  // exclude current period
      .map(k => {
        const p = history[k] || {}
        return line.computeFn ? line.computeFn(p) : p[line.key]
      })
      .filter(v => v != null && !isNaN(v) && v !== 0)

    if (historicalValues.length < 4) return null

    const mean = historicalValues.reduce((a, b) => a + b, 0) / historicalValues.length
    const variance = historicalValues.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / historicalValues.length
    const stddev = Math.sqrt(variance)
    if (stddev === 0) return null

    const zScore = Math.abs((currentValue - mean) / stddev)
    if (zScore > 2) {
      return {
        isAnomaly: true,
        reason: `${zScore.toFixed(1)}σ from trailing mean`,
        severity: zScore > 3 ? 'alert' : 'warn',
      }
    }
    return null
  }

  // Projected close — takes an actual value for an in-progress period and
  // projects what it will be at period close based on pacing. Returns null
  // if we can't meaningfully project (no pacing signal, or period already done).
  const periodPacing = getPeriodPacing(periodKey)
  function projectedClose(actualValue) {
    if (actualValue == null || actualValue === 0) return null
    if (periodPacing == null || periodPacing <= 0) return null
    if (periodPacing >= 1.0) return null  // period is done, actual is final
    return actualValue / periodPacing
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

      {/* ── Period Status + Close ── */}
      {location && !isAll && (
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '12px 20px',
          background: isClosed ? '#f0fdf4' : '#f8fafc',
          border: `0.5px solid ${isClosed ? '#bbf7d0' : '#e2e8f0'}`,
          borderRadius: 10,
          marginBottom: 16,
          fontSize: 13,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
            <span style={{ fontWeight: 600, color: '#334155', fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.03em' }}>
              {isClosed ? '🔒 Period Closed' : 'Period Status'}
            </span>
            {!closeStatus.loading && closeStatus.sources.map(s => (
              <div key={s.key} style={{
                display: 'flex', alignItems: 'center', gap: 5,
                padding: '3px 10px',
                borderRadius: 999,
                fontSize: 11,
                fontWeight: 500,
                background: s.status === 'approved' ? '#dcfce7' : s.status === 'posted' ? '#dbeafe' : s.status === 'optional' ? '#f1f5f9' : '#fef3c7',
                color: s.status === 'approved' ? '#166534' : s.status === 'posted' ? '#1e40af' : s.status === 'optional' ? '#64748b' : '#92400e',
              }}>
                <span style={{
                  width: 6, height: 6, borderRadius: '50%',
                  background: s.status === 'approved' ? '#22c55e' : s.status === 'posted' ? '#3b82f6' : s.status === 'optional' ? '#94a3b8' : '#f59e0b',
                }} />
                {s.label}
              </div>
            ))}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {isClosed && closeStatus.closedBy && (
              <span style={{ fontSize: 11, color: '#64748b' }}>
                Closed by {closeStatus.closedBy}
              </span>
            )}
            {!isClosed && isDirector && (
              <button
                onClick={handleClosePeriod}
                disabled={!closeStatus.allReady}
                title={closeStatus.allReady ? 'Close this period' : 'All sources must be posted or approved before closing'}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 5,
                  padding: '6px 14px', fontSize: 12, fontWeight: 600,
                  background: closeStatus.allReady ? '#059669' : '#f1f5f9',
                  color: closeStatus.allReady ? '#fff' : '#cbd5e1',
                  opacity: closeStatus.allReady ? 1 : 0.6,
                  border: 'none', borderRadius: 8,
                  cursor: closeStatus.allReady ? 'pointer' : 'not-allowed',
                  transition: 'all 0.15s ease',
                }}
              >
                🔒 Close Period
              </button>
            )}
            {isClosed && isDirector && (
              <button
                onClick={handleReopenPeriod}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 5,
                  padding: '6px 14px', fontSize: 12, fontWeight: 500,
                  background: '#fff', color: '#dc2626',
                  border: '1px solid #fecaca', borderRadius: 8,
                  cursor: 'pointer',
                }}
              >
                🔓 Reopen
              </button>
            )}
          </div>
        </div>
      )}

      {/* ── Period-over-period narrative diff (executive summary) ── */}
      {(() => {
        const locLabel = location ? cleanLocName(location) : `${locNames.length} locations`
        const diff = buildPeriodDiff(pnl, priorPnl, history, trailingKeys, locLabel, isAll)
        const bgColor = diff.sentiment === 'positive' ? '#f0fdf4'
                       : diff.sentiment === 'negative' ? '#fef2f2'
                       : '#f8fafc'
        const borderColor = diff.sentiment === 'positive' ? '#bbf7d0'
                           : diff.sentiment === 'negative' ? '#fecaca'
                           : '#e2e8f0'
        const accentColor = diff.sentiment === 'positive' ? '#059669'
                           : diff.sentiment === 'negative' ? '#dc2626'
                           : '#94a3b8'
        return (
          <div style={{
            background: bgColor,
            border: `0.5px solid ${borderColor}`,
            borderLeft: `3px solid ${accentColor}`,
            borderRadius: 10,
            padding: '14px 20px',
            marginBottom: 16,
            display: 'flex',
            alignItems: 'flex-start',
            gap: 12,
          }}>
            <div style={{
              fontSize: 11, color: accentColor,
              textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 600,
              marginTop: 2,
              flexShrink: 0,
            }}>
              Summary
            </div>
            <div style={{
              fontSize: 13, color: '#0f172a', lineHeight: 1.55,
              flex: 1,
            }}>
              {diff.summary}
            </div>
          </div>
        )
      })()}

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

      {/* ── Scenario scratchpad ── */}
      {(() => {
        const fmtSlim = v => {
          if (v == null || isNaN(v)) return '—'
          const abs = Math.abs(v)
          if (abs >= 1_000_000) return '$' + (abs/1_000_000).toFixed(1) + 'M'
          if (abs >= 1_000)     return '$' + Math.round(abs/1_000) + 'k'
          return '$' + Math.round(abs)
        }
        const Slider = ({ label, value, onChange, min, max, step, suffix, leftLabel, rightLabel }) => (
          <div style={{ marginBottom: 18 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 6 }}>
              <label style={{ fontSize: 12, color: '#475569', fontWeight: 500 }}>{label}</label>
              <span style={{
                fontSize: 13, fontWeight: 500,
                color: value === 0 ? '#94a3b8' : value > 0 ? '#dc2626' : '#059669',
                fontVariantNumeric: 'tabular-nums',
              }}>
                {value > 0 ? '+' : ''}{value}{suffix}
              </span>
            </div>
            <input
              type="range"
              min={min}
              max={max}
              step={step}
              value={value}
              onChange={e => onChange(parseFloat(e.target.value))}
              style={{
                width: '100%',
                accentColor: value === 0 ? '#94a3b8' : value > 0 ? '#dc2626' : '#059669',
                cursor: 'pointer',
              }}
            />
            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 2 }}>
              <span style={{ fontSize: 10, color: '#cbd5e1' }}>{leftLabel}</span>
              <span style={{ fontSize: 10, color: '#cbd5e1' }}>{rightLabel}</span>
            </div>
          </div>
        )

        return (
          <div style={{
            background: '#fff',
            border: '0.5px solid #e5e7eb',
            borderRadius: 12,
            marginBottom: 24,
            overflow: 'hidden',
          }}>
            {/* Header bar — always visible, click to toggle */}
            <button
              onClick={() => setScenarioOpen(v => !v)}
              style={{
                width: '100%',
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                padding: '14px 24px',
                background: scenarioActive ? '#fef3c7' : '#fff',
                border: 'none',
                borderBottom: scenarioOpen ? '0.5px solid #e5e7eb' : 'none',
                cursor: 'pointer',
                fontFamily: 'inherit',
                textAlign: 'left',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <div style={{
                  width: 28, height: 28, borderRadius: 6,
                  background: scenarioActive ? '#f59e0b' : '#f1f5f9',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}>
                  <span style={{
                    fontSize: 13,
                    color: scenarioActive ? '#fff' : '#64748b',
                    fontWeight: 600,
                  }}>
                    ƒ
                  </span>
                </div>
                <div>
                  <div style={{ fontSize: 11, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 500 }}>
                    Scenario
                  </div>
                  <div style={{ fontSize: 14, color: '#0f172a', fontWeight: 500, marginTop: 1 }}>
                    {scenarioActive
                      ? `${scenarioEbitdaDelta >= 0 ? '+' : ''}${fmtSlim(scenarioEbitdaDelta)} EBITDA impact`
                      : 'Run a what-if scenario'}
                  </div>
                </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                {scenarioActive && (
                  <span
                    onClick={e => { e.stopPropagation(); resetScenario() }}
                    style={{
                      fontSize: 11, color: '#64748b', fontWeight: 500,
                      padding: '4px 10px',
                      border: '0.5px solid #e2e8f0', borderRadius: 6,
                      background: '#fff',
                      cursor: 'pointer',
                    }}
                  >
                    Reset
                  </span>
                )}
                <span style={{ fontSize: 16, color: '#94a3b8' }}>{scenarioOpen ? '−' : '+'}</span>
              </div>
            </button>

            {/* Body — sliders + projection */}
            {scenarioOpen && (
              <div style={{ padding: '20px 24px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 32 }}>
                {/* Left: sliders */}
                <div>
                  <div style={{ fontSize: 11, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 500, marginBottom: 14 }}>
                    Adjust inputs
                  </div>
                  <Slider
                    label="Revenue volume"
                    value={revenueDelta}
                    onChange={setRevenueDelta}
                    min={-30} max={30} step={1} suffix="%"
                    leftLabel="−30%" rightLabel="+30%"
                  />
                  <Slider
                    label="Labor as % of GFS"
                    value={laborDelta}
                    onChange={setLaborDelta}
                    min={-5} max={5} step={0.1} suffix="pp"
                    leftLabel="−5pp" rightLabel="+5pp"
                  />
                  <Slider
                    label="Food cost as % of revenue"
                    value={foodCostDelta}
                    onChange={setFoodCostDelta}
                    min={-5} max={5} step={0.1} suffix="pp"
                    leftLabel="−5pp" rightLabel="+5pp"
                  />
                  <label style={{
                    display: 'flex', alignItems: 'center', gap: 8,
                    marginTop: 16, padding: '10px 12px',
                    background: '#f8fafc',
                    border: '0.5px solid #e2e8f0', borderRadius: 8,
                    cursor: 'pointer',
                  }}>
                    <input
                      type="checkbox"
                      checked={applyToTable}
                      onChange={e => setApplyToTable(e.target.checked)}
                      style={{ cursor: 'pointer' }}
                    />
                    <span style={{ fontSize: 12, color: '#475569' }}>
                      Show scenario column in P&L table below
                    </span>
                  </label>
                </div>

                {/* Right: projected output */}
                <div>
                  <div style={{ fontSize: 11, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 500, marginBottom: 14 }}>
                    Projected at period close
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
                    {[
                      { label: 'GFS', value: scenGfs, baseline: gfs, fmt: fmtSlim },
                      { label: 'EBITDA', value: scenEbitda, baseline: ebitda, fmt: fmtSlim, primaryColor: scenEbitda >= 0 ? '#0f172a' : '#dc2626' },
                      { label: 'Prime cost %', value: scenPrime != null ? (scenPrime * 100) : null, baseline: primeCost != null ? primeCost * 100 : null, fmt: v => v != null ? v.toFixed(1) + '%' : '—', goodIsDown: true },
                      { label: 'Labor %', value: scenLaborPct != null ? (scenLaborPct * 100) : null, baseline: laborPctNow, fmt: v => v != null ? v.toFixed(1) + '%' : '—', goodIsDown: true },
                    ].map(o => {
                      const delta = (o.value != null && o.baseline != null) ? o.value - o.baseline : null
                      const showDelta = delta != null && Math.abs(delta) > 0.001
                      const goodIsDown = o.goodIsDown
                      const deltaColor = !showDelta ? '#94a3b8'
                                       : goodIsDown ? (delta < 0 ? '#059669' : '#dc2626')
                                       : (delta > 0 ? '#059669' : '#dc2626')
                      return (
                        <div key={o.label} style={{
                          padding: '12px 14px',
                          background: '#f8fafc',
                          border: '0.5px solid #e2e8f0',
                          borderRadius: 8,
                        }}>
                          <div style={{ fontSize: 10, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 500, marginBottom: 4 }}>
                            {o.label}
                          </div>
                          <div style={{ fontSize: 18, fontWeight: 500, color: o.primaryColor || '#0f172a', letterSpacing: '-0.01em' }}>
                            {o.fmt(o.value)}
                          </div>
                          {showDelta && (
                            <div style={{ fontSize: 10, color: deltaColor, marginTop: 3, fontWeight: 500 }}>
                              {delta >= 0 ? '▲' : '▼'} {o.fmt(Math.abs(delta))} from baseline
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                </div>
              </div>
            )}
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
                <th className={styles.thLabel}>Line item</th>
                <th className={styles.thVal}>Actual</th>
                <th className={styles.thVal} style={{ color: '#64748b' }}>Projected close</th>
                {applyToTable && scenarioActive && (
                  <th className={styles.thVal} style={{ color: '#b45309' }}>Scenario</th>
                )}
                <th className={styles.thVal}>Budget</th>
                <th className={styles.thVal}>Variance</th>
                <th className={styles.thVal} style={{ color: '#666' }}>Prior period</th>
              </tr>
            </thead>

            {schema.map(section => {
              const isCollapsed = collapsed[section.id]
              return (
                <tbody key={section.id}>
                  <tr className={styles.section} onClick={() => toggle(section.id)}>
                    <td colSpan={applyToTable && scenarioActive ? 7 : 6} className={styles.sectionCell} style={{ borderTopColor: section.color, color: section.color }}>
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
                          <td />
                          {applyToTable && scenarioActive && <td />}
                          <td /><td /><td />
                        </tr>
                      )
                    }

                    const actual    = resolveVal(line, pnl)
                    const prior     = resolveVal(line, priorPnl)
                    const budget    = line.budgetKey ? (pnl[line.budgetKey] ?? null) : null
                    const variance  = actual != null && budget != null ? actual - budget : null
                    const vsPrior   = actual != null && prior != null && prior !== 0 ? actual - prior : null
                    const projected = projectedClose(actual)
                    const anomaly   = detectAnomaly(line, actual, budget)

                    return (
                      <tr
                        key={line.key}
                        className={`${styles.row} ${line.bold ? styles.bold : ''} ${line.highlight ? styles.highlight : ''}`}
                        onClick={() => setWhyLine({ line, actual, budget, prior })}
                        style={{ cursor: 'pointer' }}
                      >
                        <td className={styles.label} style={{ paddingLeft: 16 + (line.indent||0) * 14 }}>
                          {anomaly && (
                            <span
                              title={anomaly.reason}
                              style={{
                                display: 'inline-block',
                                width: 6, height: 6, borderRadius: '50%',
                                background: anomaly.severity === 'alert' ? '#dc2626' : '#f59e0b',
                                marginRight: 6,
                                verticalAlign: 'middle',
                                boxShadow: anomaly.severity === 'alert'
                                  ? '0 0 0 2px rgba(220, 38, 38, 0.2)'
                                  : '0 0 0 2px rgba(245, 158, 11, 0.2)',
                              }}
                            />
                          )}
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
                        <td className={styles.val} style={{ color: '#64748b', fontStyle: 'italic' }}>
                          {projected != null ? fmt$(projected) : '—'}
                        </td>
                        {applyToTable && scenarioActive && (() => {
                          const scenVal = line.computeFn ? line.computeFn(scenarioPnl) : scenarioPnl[line.key]
                          const scenDelta = scenVal != null && actual != null ? scenVal - actual : null
                          return (
                            <td className={styles.val} style={{ color: '#b45309', fontWeight: 500 }}>
                              {scenVal != null && scenVal !== 0 ? fmt$(scenVal) : '—'}
                              {scenDelta != null && Math.abs(scenDelta) > 0.5 && (
                                <div style={{ fontSize: 10, color: scenDelta > 0 ? '#dc2626' : '#059669', marginTop: 2 }}>
                                  {scenDelta >= 0 ? '+' : ''}{fmt$(scenDelta)}
                                </div>
                              )}
                            </td>
                          )
                        })()}
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
                  <tr className={styles.gap}><td colSpan={applyToTable && scenarioActive ? 7 : 6} /></tr>
                </tbody>
              )
            })}

            {/* EBITDA footer */}
            <tbody>
              <tr className={`${styles.row} ${styles.bold} ${styles.ebitdaRow}`}>
                <td className={styles.label} style={{ paddingLeft: 16, fontSize: 14, letterSpacing: '.02em' }}>EBITDA</td>
                <td className={styles.val} style={{ color: ebitda >= 0 ? '#059669' : '#dc2626', fontSize: 15, fontWeight: 800 }}>{fmt$(ebitda)}</td>
                <td className={styles.val} style={{ color: '#64748b', fontStyle: 'italic' }}>
                  {(() => {
                    const p = projectedClose(ebitda)
                    return p != null ? fmt$(p) : '—'
                  })()}
                </td>
                {applyToTable && scenarioActive && (
                  <td className={styles.val} style={{ color: '#b45309', fontWeight: 600, fontSize: 14 }}>
                    {fmt$(scenEbitda)}
                  </td>
                )}
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

      {/* ── Why Panel (side drawer) ── */}
      {whyLine && (
        <WhyPanel
          line={whyLine.line}
          actual={whyLine.actual}
          budget={whyLine.budget}
          prior={whyLine.prior}
          periodKey={periodKey}
          history={history}
          trailingKeys={trailingKeys}
          orgId={orgId}
          location={location}
          isAllLocations={isAll}
          onClose={() => setWhyLine(null)}
        />
      )}

      {/* ── 12-period trend (small multiples) ── */}
      {(() => {
        // Build chart-ready data: array of { period, revenue, ebitda, primeCost, laborPct }
        // from trailingKeys + history. Skip if no data anywhere.
        const chartData = trailingKeys.map((k, i) => ({
          period: k.replace(/^\d+-/, ''),  // strip year for compactness ("P04-W2")
          fullPeriod: k,
          revenue:   sparkSeries.revenue[i],
          ebitda:    sparkSeries.ebitda[i],
          primeCost: sparkSeries.primeCost[i],
          laborPct:  sparkSeries.laborPct[i],
        }))
        const hasAnyData = chartData.some(d =>
          (d.revenue && d.revenue !== 0) ||
          (d.ebitda && d.ebitda !== 0) ||
          (d.primeCost != null && d.primeCost !== 0) ||
          (d.laborPct != null && d.laborPct !== 0)
        )
        if (!hasAnyData) return null  // hide entirely until there's something to chart

        const fmtDollar = v => '$' + Math.round(v / 1000) + 'k'
        const fmtPercent = v => v != null ? v.toFixed(1) + '%' : ''

        const charts = [
          { key: 'revenue',   label: 'Net revenue',  color: '#1D9E75', fmt: fmtDollar,  refLine: null },
          { key: 'ebitda',    label: 'EBITDA',       color: '#1D9E75', fmt: fmtDollar,  refLine: 0 },
          { key: 'primeCost', label: 'Prime cost %', color: '#BA7517', fmt: fmtPercent, refLine: 60 },
          { key: 'laborPct',  label: 'Labor %',      color: '#1D9E75', fmt: fmtPercent, refLine: null },
        ]

        return (
          <div style={{
            background: '#fff',
            border: '0.5px solid #e5e7eb',
            borderRadius: 12,
            padding: '22px 28px',
            marginTop: 24,
            marginBottom: 24,
          }}>
            <div style={{ fontSize: 11, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 500, marginBottom: 4 }}>
              12-period trend
            </div>
            <div style={{ fontSize: 14, color: '#475569', marginBottom: 18 }}>
              Trailing 12 periods · {trailingKeys[0]} – {trailingKeys[trailingKeys.length - 1]}
            </div>
            <div style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
              gap: 18,
            }}>
              {charts.map(c => {
                const data = chartData.map(d => ({ period: d.period, value: d[c.key] }))
                const validValues = data.map(d => d.value).filter(v => v != null && !isNaN(v))
                if (validValues.length < 2) {
                  return (
                    <div key={c.key} style={{
                      border: '0.5px solid #e5e7eb',
                      borderRadius: 8,
                      padding: '14px 16px',
                      minHeight: 200,
                    }}>
                      <div style={{ fontSize: 11, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 500, marginBottom: 8 }}>
                        {c.label}
                      </div>
                      <div style={{ fontSize: 12, color: '#cbd5e1', display: 'flex', alignItems: 'center', justifyContent: 'center', height: 140 }}>
                        Not enough data
                      </div>
                    </div>
                  )
                }
                const latest = validValues[validValues.length - 1]
                const earliest = validValues[0]
                const change = latest - earliest
                const changePct = earliest !== 0 ? (change / Math.abs(earliest)) * 100 : null
                return (
                  <div key={c.key} style={{
                    border: '0.5px solid #e5e7eb',
                    borderRadius: 8,
                    padding: '14px 16px',
                  }}>
                    <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 4 }}>
                      <div style={{ fontSize: 11, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 500 }}>
                        {c.label}
                      </div>
                      {changePct != null && (
                        <div style={{
                          fontSize: 11,
                          fontWeight: 500,
                          color: (c.key === 'laborPct' || c.key === 'primeCost') ? (changePct <= 0 ? '#059669' : '#dc2626') : (changePct >= 0 ? '#059669' : '#dc2626'),
                        }}>
                          {changePct >= 0 ? '+' : ''}{Math.round(changePct)}% over period
                        </div>
                      )}
                    </div>
                    <div style={{ fontSize: 18, fontWeight: 500, color: '#0f172a', marginBottom: 8, letterSpacing: '-0.01em' }}>
                      {c.fmt(latest)}
                    </div>
                    <RResponsiveContainer width="100%" height={140}>
                      <LineChart data={data} margin={{ top: 5, right: 6, bottom: 0, left: -10 }}>
                        <RXAxis
                          dataKey="period"
                          tick={{ fontSize: 9, fill: '#94a3b8' }}
                          interval={Math.max(0, Math.floor(data.length / 6) - 1)}
                          axisLine={{ stroke: '#e5e7eb' }}
                          tickLine={false}
                        />
                        <RYAxis
                          tick={{ fontSize: 9, fill: '#94a3b8' }}
                          tickFormatter={c.fmt}
                          axisLine={false}
                          tickLine={false}
                          width={50}
                        />
                        {c.refLine != null && (
                          <RReferenceLine y={c.refLine} stroke="#cbd5e1" strokeDasharray="2 3" />
                        )}
                        <RTooltip
                          contentStyle={{
                            background: '#0f172a', border: 'none', borderRadius: 6,
                            fontSize: 11, padding: '6px 10px',
                          }}
                          labelStyle={{ color: '#cbd5e1' }}
                          itemStyle={{ color: '#fff' }}
                          formatter={v => v != null ? c.fmt(v) : '—'}
                        />
                        <RLine
                          type="monotone"
                          dataKey="value"
                          stroke={c.color}
                          strokeWidth={2}
                          dot={{ r: 2, fill: c.color }}
                          activeDot={{ r: 4 }}
                          isAnimationActive={false}
                          connectNulls
                        />
                      </LineChart>
                    </RResponsiveContainer>
                  </div>
                )
              })}
            </div>
          </div>
        )
      })()}

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