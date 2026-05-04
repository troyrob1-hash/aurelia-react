import { useState, useRef, useEffect, useMemo } from 'react'
import { usePeriod } from '@/store/PeriodContext'
import { useLocations, cleanLocName } from '@/store/LocationContext'
import { usePnL } from '@/lib/usePnL'
import { db } from '@/lib/firebase'
import { collection, addDoc, getDocs, query, where, orderBy, limit, doc, getDoc, serverTimestamp } from 'firebase/firestore'
import { writePnL, weeksInPeriod, getPriorKey } from '@/lib/pnl'

const JE_GL_CODES = [
  { code: 'exp_office_supplies', label: 'Office Supplies & Equipment' },
  { code: 'exp_technology', label: 'Technology Services' },
  { code: 'exp_travel', label: 'Travel and Entertainment' },
  { code: 'exp_professional', label: 'Professional Fees' },
  { code: 'exp_facilities', label: 'Facilities' },
  { code: 'exp_licenses', label: 'Licenses, Permits and Fines' },
  { code: 'exp_other', label: 'Other Expenses' },
  { code: 'exp_mktg_marketing', label: 'Marketing' },
  { code: 'cogs_equipment', label: 'Onsite Equipment' },
  { code: 'cogs_supplies', label: 'Onsite Supplies' },
  { code: 'cogs_cleaning', label: 'Cleaning Supplies & Chemicals' },
  { code: 'cogs_paper', label: 'Paper Products & Consumables' },
  { code: 'cogs_maintenance', label: 'Onsite Other' },
]

const TOOLS = [
  {
    name: 'create_journal_entry',
    description: 'Create a journal entry to record an expense or adjustment on the P&L. Use this when the user wants to post an expense, record a cost, or make a financial adjustment.',
    input_schema: {
      type: 'object',
      properties: {
        gl_code: { type: 'string', description: 'GL code from: ' + JE_GL_CODES.map(g => g.code + ' (' + g.label + ')').join(', ') },
        description: { type: 'string', description: 'Description of the entry' },
        amount: { type: 'number', description: 'Dollar amount (positive)' },
        auto_reverse: { type: 'boolean', description: 'Whether to auto-reverse next week' },
      },
      required: ['gl_code', 'description', 'amount'],
    },
  },
  {
    name: 'get_budget_status',
    description: 'Get detailed budget vs actual comparison for the current period. Use when the user asks about budget tracking, variance, or spending.',
    input_schema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'get_location_comparison',
    description: 'Compare performance across all locations. Use when asked about which locations are over/under performing.',
    input_schema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'get_anomalies',
    description: 'Identify unusual patterns, anomalies, or concerns in the current financial data. Use when asked to flag issues, find problems, or do a health check.',
    input_schema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'close_period',
    description: 'Guide the user through closing the current period. Use when asked to close, finalize, or lock a period.',
    input_schema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'generate_report',
    description: 'Generate a comprehensive financial report or summary. Use when asked for a report, summary, review prep, month-end analysis, or regional review.',
    input_schema: {
      type: 'object',
      properties: {
        report_type: { type: 'string', enum: ['period_summary', 'regional_review', 'month_end', 'variance_analysis', 'action_items'], description: 'Type of report to generate' },
      },
      required: ['report_type'],
    },
  },
  {
    name: 'generate_chart',
    description: 'Generate a chart or visualization inline. Use when asked to show, chart, graph, visualize, or plot data.',
    input_schema: {
      type: 'object',
      properties: {
        chart_type: { type: 'string', enum: ['bar', 'line', 'comparison'], description: 'Type of chart' },
        metric: { type: 'string', description: 'What to chart: gfs, revenue, labor, ebitda, budget_variance' },
        title: { type: 'string', description: 'Chart title' },
      },
      required: ['chart_type', 'metric', 'title'],
    },
  },
  {
    name: 'forecast',
    description: 'Project whether the current period will hit budget based on daily run rate. Use when asked about projections, forecasts, pacing, or "will I hit budget".',
    input_schema: {
      type: 'object',
      properties: {},
    },
  },
]

const SYSTEM_PROMPT = `You are Aurelia, an AI financial assistant for Fooda restaurant operations. You help operators and directors understand their P&L, budget performance, and operational metrics.

You can take actions using tools:
- Create journal entries to record expenses
- Check budget status and variance
- Compare locations
- Flag anomalies and concerns
- Guide period close

When answering:
- Be concise and direct — operators are busy
- Use dollar amounts and percentages
- Compare to budget when available
- Flag concerns proactively
- Suggest actions when relevant
- When you use a tool, explain what you did and the result

Keep responses under 150 words unless asked for detail.`

export default function AureliaChat() {
  const [open, setOpen] = useState(false)
  const [messages, setMessages] = useState([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [pendingAction, setPendingAction] = useState(null)
  const scrollRef = useRef(null)
  const inputRef = useRef(null)

  const { periodKey, year, period, week } = usePeriod()
  const { selectedLocation, visibleLocations } = useLocations()
  const location = selectedLocation === 'all' ? null : selectedLocation
  const { data: pnl } = usePnL(location, periodKey)

  const priorKey = getPriorKey(periodKey)
  const { data: priorPnl } = usePnL(location, priorKey)

  const orgId = user?.tenantId

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight
  }, [messages])

  useEffect(() => {
    if (open && inputRef.current) inputRef.current.focus()
  }, [open])

  // Proactive insights — run on load
  useEffect(() => {
    if (!open || messages.length > 0 || Object.keys(pnl).length === 0) return
    const insights = []
    const gfs = pnl.gfs_total || 0
    const budgetGfs = pnl.budget_gfs || 0
    if (budgetGfs > 0 && gfs > 0) {
      const variance = ((gfs - budgetGfs) / budgetGfs) * 100
      if (variance < -10) insights.push('GFS is ' + Math.abs(variance).toFixed(1) + '% below budget — needs attention')
      else if (variance < -5) insights.push('GFS is trending ' + Math.abs(variance).toFixed(1) + '% below budget')
    }
    const laborTotal = Object.keys(pnl).filter(k => k.startsWith('cogs_labor')).reduce((s, k) => s + (pnl[k] || 0), 0)
    const budgetLabor = pnl.budget_labor || 0
    if (budgetLabor > 0 && laborTotal > budgetLabor * 1.1) {
      insights.push('Labor is ' + (((laborTotal - budgetLabor) / budgetLabor) * 100).toFixed(1) + '% over budget')
    }
    if (gfs > 0 && priorPnl.gfs_total > 0) {
      const weekChg = ((gfs - priorPnl.gfs_total) / priorPnl.gfs_total) * 100
      if (weekChg < -15) insights.push('GFS dropped ' + Math.abs(weekChg).toFixed(1) + '% vs last week')
    }
    if (insights.length > 0) {
      setMessages([{ role: 'assistant', text: 'I noticed a few things about ' + (location ? cleanLocName(location) : 'your portfolio') + ' this period:\n\n' + insights.map((ins, i) => (i + 1) + '. ' + ins).join('\n') + '\n\nWant me to dig into any of these?' }])
    }
  }, [open, pnl, priorPnl])

  function buildContext() {
    const lines = []
    lines.push('Current period: ' + periodKey)
    lines.push('Location: ' + (location ? cleanLocName(location) : 'All Locations'))
    lines.push('')
    if (Object.keys(pnl).length > 0) {
      lines.push('P&L Data:')
      const fmt = v => typeof v === 'number' ? '$' + Math.round(v).toLocaleString() : String(v || '')
      const keys = Object.keys(pnl).filter(k => typeof pnl[k] === 'number').sort()
      keys.forEach(k => lines.push('  ' + k + ': ' + fmt(pnl[k])))
      if (Object.keys(priorPnl).length > 0) {
        lines.push('')
        lines.push('Prior period (' + priorKey + '):')
        Object.keys(priorPnl).filter(k => typeof priorPnl[k] === 'number').sort().forEach(k => {
          lines.push('  ' + k + ': ' + fmt(priorPnl[k]))
        })
      }
    } else {
      lines.push('No P&L data loaded.')
    }
    return lines.join('\n')
  }

  async function executeTool(toolName, toolInput) {
    const fmt = v => '$' + Math.round(v).toLocaleString()
    
    if (toolName === 'create_journal_entry') {
      // Show confirmation first
      const glLabel = JE_GL_CODES.find(g => g.code === toolInput.gl_code)?.label || toolInput.gl_code
      setPendingAction({
        type: 'journal_entry',
        data: toolInput,
        label: glLabel,
        confirm: async () => {
          try {
            await addDoc(collection(db, 'tenants', orgId, 'journalEntries'), {
              glCode: toolInput.gl_code,
              glLabel,
              description: toolInput.description,
              totalAmount: toolInput.amount,
              amortization: 'once',
              amortMonths: 1,
              location: location || 'all',
              periods: [periodKey],
              createdBy: 'Aurelia AI',
              createdAt: serverTimestamp(),
              status: 'posted',
            })
            await writePnL(location || 'all', periodKey, { [toolInput.gl_code]: toolInput.amount })
            if (toolInput.auto_reverse) {
              const [yrStr, rest] = periodKey.split('-P')
              const [pStr, wStr] = rest.split('-W')
              const yr = parseInt(yrStr), p = parseInt(pStr), w = parseInt(wStr)
              const maxW = weeksInPeriod(yr, p)
              let nextKey
              if (w < maxW) nextKey = yrStr + '-P' + pStr + '-W' + (w + 1)
              else {
                const np = p < 12 ? p + 1 : 1
                const ny = p < 12 ? yr : yr + 1
                nextKey = ny + '-P' + String(np).padStart(2, '0') + '-W1'
              }
              await writePnL(location || 'all', nextKey, { [toolInput.gl_code]: -toolInput.amount })
            }
            setPendingAction(null)
            return 'Journal entry created: ' + glLabel + ' for ' + fmt(toolInput.amount) + ' on ' + periodKey + (toolInput.auto_reverse ? ' (auto-reverses next week)' : '')
          } catch (err) {
            setPendingAction(null)
            return 'Error creating journal entry: ' + err.message
          }
        },
        cancel: () => { setPendingAction(null); return 'Journal entry cancelled.' },
      })
      return 'I\'d like to create a journal entry:\n\n- **GL:** ' + glLabel + '\n- **Description:** ' + toolInput.description + '\n- **Amount:** ' + fmt(toolInput.amount) + (toolInput.auto_reverse ? '\n- **Auto-reverse:** next week' : '') + '\n\nShall I go ahead?'
    }

    if (toolName === 'get_budget_status') {
      const gfs = pnl.gfs_total || 0
      const budgetGfs = pnl.budget_gfs || 0
      const rev = pnl.revenue_total || 0
      const budgetRev = pnl.budget_revenue || 0
      const laborTotal = Object.keys(pnl).filter(k => k.startsWith('cogs_labor')).reduce((s, k) => s + (pnl[k] || 0), 0)
      const budgetLabor = pnl.budget_labor || 0
      const ebitda = rev - laborTotal
      const budgetEbitda = pnl.budget_ebitda || 0

      return 'Budget Status for ' + periodKey + ':\n' +
        '- GFS: ' + fmt(gfs) + ' vs budget ' + fmt(budgetGfs) + ' (' + (budgetGfs > 0 ? ((gfs/budgetGfs-1)*100).toFixed(1) + '%' : 'n/a') + ')\n' +
        '- Revenue: ' + fmt(rev) + ' vs budget ' + fmt(budgetRev) + '\n' +
        '- Labor: ' + fmt(laborTotal) + ' vs budget ' + fmt(budgetLabor) + ' (' + (budgetLabor > 0 ? ((laborTotal/budgetLabor-1)*100).toFixed(1) + '%' : 'n/a') + ')\n' +
        '- EBITDA: ' + fmt(ebitda) + ' vs budget ' + fmt(budgetEbitda)
    }

    if (toolName === 'get_anomalies') {
      const issues = []
      const gfs = pnl.gfs_total || 0
      const budgetGfs = pnl.budget_gfs || 0
      const priorGfs = priorPnl.gfs_total || 0
      
      if (budgetGfs > 0 && gfs < budgetGfs * 0.9) issues.push('GFS is ' + (((budgetGfs - gfs) / budgetGfs) * 100).toFixed(1) + '% below budget')
      if (priorGfs > 0 && gfs < priorGfs * 0.85) issues.push('GFS dropped ' + (((priorGfs - gfs) / priorGfs) * 100).toFixed(1) + '% vs last week')
      
      const laborTotal = Object.keys(pnl).filter(k => k.startsWith('cogs_labor')).reduce((s, k) => s + (pnl[k] || 0), 0)
      const budgetLabor = pnl.budget_labor || 0
      if (budgetLabor > 0 && laborTotal > budgetLabor * 1.1) issues.push('Labor is ' + (((laborTotal - budgetLabor) / budgetLabor) * 100).toFixed(1) + '% over budget')
      
      if (gfs > 0 && laborTotal / gfs > 0.35) issues.push('Labor as % of GFS is ' + ((laborTotal / gfs) * 100).toFixed(1) + '% — above 35% threshold')

      const expKeys = Object.keys(pnl).filter(k => k.startsWith('exp_') && typeof pnl[k] === 'number' && pnl[k] > 0)
      expKeys.forEach(k => {
        const budgetK = pnl['budget_' + k]
        if (budgetK && pnl[k] > budgetK * 1.5) issues.push(k.replace('exp_', '').replace(/_/g, ' ') + ' is ' + (((pnl[k] - budgetK) / budgetK) * 100).toFixed(0) + '% over budget')
      })

      return issues.length > 0
        ? 'Anomalies detected:\n' + issues.map((is, i) => (i + 1) + '. ' + is).join('\n')
        : 'No significant anomalies found. All metrics are within normal ranges.'
    }

    if (toolName === 'get_location_comparison') {
      return 'Location comparison requires loading multiple locations. Based on current data for ' + (location ? cleanLocName(location) : 'the selected location') + ':\n- GFS: ' + fmt(pnl.gfs_total || 0) + '\n- Revenue: ' + fmt(pnl.revenue_total || 0) + '\n\nSwitch to the Sales tab All Locations view for a full comparison across all ' + visibleLocations.length + ' locations.'
    }

    if (toolName === 'close_period') {
      return 'To close ' + periodKey + ', all data sources need to be submitted:\n\n1. Sales data \u2014 import events or manually enter\n2. Labor \u2014 upload from Mosaic\n3. Inventory \u2014 complete a count\n4. Purchasing \u2014 enter invoices\n\nOnce all are green, click "Close Period" in the top bar. Want me to check which ones are ready?'
    }

    if (toolName === 'generate_report') {
      const gfs = pnl.gfs_total || 0
      const rev = pnl.revenue_total || 0
      const budgetGfs = pnl.budget_gfs || 0
      const budgetRev = pnl.budget_revenue || 0
      const budgetLabor = pnl.budget_labor || 0
      const budgetEbitda = pnl.budget_ebitda || 0
      const laborTotal = Object.keys(pnl).filter(k => k.startsWith('cogs_labor')).reduce((s, k) => s + (pnl[k] || 0), 0)
      const expTotal = Object.keys(pnl).filter(k => k.startsWith('exp_')).reduce((s, k) => s + (pnl[k] || 0), 0)
      const ebitda = rev - laborTotal - expTotal
      const priorGfs = priorPnl.gfs_total || 0
      const gfsVsBudget = budgetGfs > 0 ? ((gfs / budgetGfs - 1) * 100).toFixed(1) : 'n/a'
      const laborPct = gfs > 0 ? ((laborTotal / gfs) * 100).toFixed(1) : '0'
      const locName = location ? cleanLocName(location) : 'All Locations'

      if (toolInput.report_type === 'period_summary' || toolInput.report_type === 'month_end') {
        return '\u2501\u2501\u2501 ' + locName + ' \u2014 ' + periodKey + ' \u2501\u2501\u2501\n\n' +
          'GROSS FOOD SALES\n' +
          '  Popup:      ' + fmt(pnl.gfs_popup || 0) + '\n' +
          '  Catering:   ' + fmt(pnl.gfs_catering || 0) + '\n' +
          '  Retail:     ' + fmt(pnl.gfs_retail || 0) + '\n' +
          '  Total GFS:  ' + fmt(gfs) + (budgetGfs > 0 ? ' (' + gfsVsBudget + '% vs budget)' : '') + '\n\n' +
          'REVENUE\n' +
          '  Net Revenue: ' + fmt(rev) + (budgetRev > 0 ? ' (budget: ' + fmt(budgetRev) + ')' : '') + '\n' +
          '  Rev % of GFS: ' + (gfs > 0 ? ((rev / gfs) * 100).toFixed(1) : '0') + '%\n\n' +
          'LABOR\n' +
          '  Total Labor: ' + fmt(laborTotal) + (budgetLabor > 0 ? ' (budget: ' + fmt(budgetLabor) + ')' : '') + '\n' +
          '  Labor % GFS: ' + laborPct + '%\n\n' +
          'EXPENSES: ' + fmt(expTotal) + '\n\n' +
          'EBITDA: ' + fmt(ebitda) + (budgetEbitda > 0 ? ' (budget: ' + fmt(budgetEbitda) + ')' : '') + '\n' +
          'EBITDA Margin: ' + (gfs > 0 ? ((ebitda / gfs) * 100).toFixed(1) : '0') + '% of GFS\n\n' +
          'VS PRIOR PERIOD:\n' +
          '  GFS: ' + (priorGfs > 0 ? (((gfs - priorGfs) / priorGfs) * 100).toFixed(1) + '%' : 'no prior data') + '\n' +
          '  Trend: ' + (gfs >= priorGfs ? '\u2191 Improving' : '\u2193 Declining')
      }

      if (toolInput.report_type === 'variance_analysis') {
        const varLines = []
        const budgetKeys = Object.keys(pnl).filter(k => k.startsWith('budget_') && typeof pnl[k] === 'number')
        budgetKeys.forEach(bk => {
          const actualKey = bk.replace('budget_', '')
          const actual = pnl[actualKey]
          const budget = pnl[bk]
          if (typeof actual === 'number' && budget > 0) {
            const variance = ((actual / budget - 1) * 100).toFixed(1)
            const flag = Math.abs(parseFloat(variance)) > 10 ? ' \u26a0' : ''
            varLines.push('  ' + actualKey + ': ' + fmt(actual) + ' vs ' + fmt(budget) + ' (' + variance + '%)' + flag)
          }
        })
        return '\u2501\u2501\u2501 Variance Analysis \u2014 ' + periodKey + ' \u2501\u2501\u2501\n\n' +
          (varLines.length > 0 ? varLines.join('\n') : 'No budget data available for variance analysis.') +
          '\n\n\u26a0 = variance > 10%'
      }

      if (toolInput.report_type === 'action_items') {
        const actions = []
        if (budgetGfs > 0 && gfs < budgetGfs * 0.9) actions.push('\u2022 GFS is ' + Math.abs(parseFloat(gfsVsBudget)) + '% below budget \u2014 review event calendar and popup vendor schedule')
        if (budgetLabor > 0 && laborTotal > budgetLabor * 1.05) actions.push('\u2022 Labor ' + (((laborTotal / budgetLabor - 1) * 100).toFixed(1)) + '% over budget \u2014 review scheduling and overtime')
        if (gfs > 0 && laborTotal / gfs > 0.35) actions.push('\u2022 Labor % of GFS at ' + laborPct + '% \u2014 target is 30-35%')
        const highExpenses = Object.keys(pnl).filter(k => k.startsWith('exp_') && pnl['budget_' + k] && pnl[k] > pnl['budget_' + k] * 1.2)
        highExpenses.forEach(k => actions.push('\u2022 ' + k.replace('exp_', '').replace(/_/g, ' ') + ' is significantly over budget \u2014 investigate'))
        if (actions.length === 0) actions.push('\u2022 All metrics within normal ranges \u2014 no immediate action required')
        return '\u2501\u2501\u2501 Action Items \u2014 ' + locName + ' \u2501\u2501\u2501\n\n' + actions.join('\n')
      }

      if (toolInput.report_type === 'regional_review') {
        return '\u2501\u2501\u2501 Regional Review Prep \u2014 ' + locName + ' \u2501\u2501\u2501\n\n' +
          'KEY METRICS:\n' +
          '  GFS: ' + fmt(gfs) + ' (' + gfsVsBudget + '% vs budget)\n' +
          '  Revenue: ' + fmt(rev) + '\n' +
          '  Labor: ' + fmt(laborTotal) + ' (' + laborPct + '% of GFS)\n' +
          '  EBITDA: ' + fmt(ebitda) + '\n\n' +
          'TALKING POINTS:\n' +
          (gfs >= budgetGfs ? '  \u2713 GFS on track or ahead of budget\n' : '  \u2717 GFS below budget \u2014 need action plan\n') +
          (laborTotal <= budgetLabor ? '  \u2713 Labor within budget\n' : '  \u2717 Labor over budget \u2014 review schedule\n') +
          (ebitda >= budgetEbitda ? '  \u2713 EBITDA on target\n' : '  \u2717 EBITDA below target \u2014 identify drivers\n') +
          '\nSUGGESTED DISCUSSION:\n' +
          '  1. Review ' + (gfs < budgetGfs ? 'GFS recovery plan' : 'what\'s driving GFS outperformance') + '\n' +
          '  2. Labor optimization opportunities\n' +
          '  3. Upcoming period outlook and events'
      }

      return 'Report type not recognized.'
    }

    if (toolName === 'generate_chart') {
      const metric = toolInput.metric
      const title = toolInput.title
      // Build SVG chart inline
      let data = []
      if (metric === 'gfs' || metric === 'revenue' || metric === 'labor' || metric === 'ebitda') {
        const currentVal = metric === 'gfs' ? (pnl.gfs_total || 0)
          : metric === 'revenue' ? (pnl.revenue_total || 0)
          : metric === 'labor' ? Object.keys(pnl).filter(k => k.startsWith('cogs_labor')).reduce((s, k) => s + (pnl[k] || 0), 0)
          : (pnl.revenue_total || 0) - Object.keys(pnl).filter(k => k.startsWith('cogs_labor')).reduce((s, k) => s + (pnl[k] || 0), 0)
        const priorVal = metric === 'gfs' ? (priorPnl.gfs_total || 0)
          : metric === 'revenue' ? (priorPnl.revenue_total || 0)
          : metric === 'labor' ? Object.keys(priorPnl).filter(k => k.startsWith('cogs_labor')).reduce((s, k) => s + (priorPnl[k] || 0), 0)
          : (priorPnl.revenue_total || 0) - Object.keys(priorPnl).filter(k => k.startsWith('cogs_labor')).reduce((s, k) => s + (priorPnl[k] || 0), 0)
        const budgetVal = metric === 'gfs' ? (pnl.budget_gfs || 0) : metric === 'revenue' ? (pnl.budget_revenue || 0) : metric === 'labor' ? (pnl.budget_labor || 0) : (pnl.budget_ebitda || 0)
        data = [
          { label: 'Prior', value: priorVal, color: '#94a3b8' },
          { label: 'Actual', value: currentVal, color: currentVal >= budgetVal ? '#059669' : '#dc2626' },
          { label: 'Budget', value: budgetVal, color: '#3b82f6' },
        ]
      } else if (metric === 'budget_variance') {
        const items = [
          { key: 'gfs_total', label: 'GFS' },
          { key: 'revenue_total', label: 'Revenue' },
          { key: 'cogs_labor_salaries', label: 'Labor' },
        ]
        items.forEach(item => {
          const actual = pnl[item.key] || 0
          const budget = pnl['budget_' + item.key] || pnl['budget_' + item.key.replace('_total', '')] || 0
          const variance = budget > 0 ? ((actual / budget - 1) * 100) : 0
          data.push({ label: item.label, value: variance, color: variance >= 0 ? '#059669' : '#dc2626' })
        })
      }

      if (data.length === 0) return 'No data available to chart.'

      const maxVal = Math.max(...data.map(d => Math.abs(d.value)), 1)
      const barWidth = 60
      const chartWidth = data.length * (barWidth + 20) + 40
      const chartHeight = 160
      const isPercent = metric === 'budget_variance'

      const bars = data.map((d, i) => {
        const barH = Math.max(4, (Math.abs(d.value) / maxVal) * (chartHeight - 40))
        const x = 20 + i * (barWidth + 20)
        const y = chartHeight - 20 - barH
        const valLabel = isPercent ? d.value.toFixed(1) + '%' : '$' + Math.round(d.value).toLocaleString()
        return '<rect x="' + x + '" y="' + y + '" width="' + barWidth + '" height="' + barH + '" rx="4" fill="' + d.color + '"/>' +
          '<text x="' + (x + barWidth/2) + '" y="' + (y - 6) + '" text-anchor="middle" font-size="11" font-weight="600" fill="#475569">' + valLabel + '</text>' +
          '<text x="' + (x + barWidth/2) + '" y="' + (chartHeight - 4) + '" text-anchor="middle" font-size="10" fill="#94a3b8">' + d.label + '</text>'
      }).join('')

      const svg = '<svg viewBox="0 0 ' + chartWidth + ' ' + chartHeight + '" xmlns="http://www.w3.org/2000/svg">' +
        '<text x="' + (chartWidth/2) + '" y="14" text-anchor="middle" font-size="12" font-weight="600" fill="#0f172a">' + title + '</text>' +
        bars + '</svg>'

      return '::CHART::' + svg
    }

    if (toolName === 'forecast') {
      const gfs = pnl.gfs_total || 0
      const budgetGfs = pnl.budget_gfs || 0
      if (budgetGfs === 0) return 'No budget data available for forecasting.'

      // Estimate daily run rate from current GFS
      // Assume we know how many days have elapsed
      const now = new Date()
      const periodMonth = period
      const daysInMonth = new Date(year, periodMonth, 0).getDate()
      const dayOfMonth = Math.min(now.getDate(), daysInMonth)
      const dailyRate = dayOfMonth > 0 ? gfs / dayOfMonth : 0
      const projectedMonthly = dailyRate * daysInMonth
      const monthlyBudget = budgetGfs * (weeksInPeriod(year, period))
      const willHitBudget = projectedMonthly >= monthlyBudget

      return '\u2501\u2501\u2501 Forecast \u2014 ' + periodKey + ' \u2501\u2501\u2501\n\n' +
        'Current GFS: ' + fmt(gfs) + '\n' +
        'Daily run rate: ' + fmt(dailyRate) + '/day\n' +
        'Projected month-end: ' + fmt(projectedMonthly) + '\n' +
        'Monthly budget: ' + fmt(monthlyBudget) + '\n\n' +
        'Forecast: ' + (willHitBudget ? '\u2705 ON TRACK to hit budget' : '\u274c LIKELY TO MISS budget by ' + fmt(monthlyBudget - projectedMonthly)) + '\n\n' +
        (willHitBudget ? '' : 'To close the gap, daily GFS needs to average ' + fmt((monthlyBudget - gfs) / Math.max(1, daysInMonth - dayOfMonth)) + ' for the remaining ' + (daysInMonth - dayOfMonth) + ' days.')
    }

    return 'Unknown tool: ' + toolName
  }

  async function handleSend(overrideMsg) {
    const userMsg = overrideMsg || input.trim()
    if (!userMsg || loading) return
    if (!overrideMsg) setInput('')
    
    if (!overrideMsg) setMessages(prev => [...prev, { role: 'user', text: userMsg }])
    setLoading(true)

    try {
      const context = buildContext()
      const apiMessages = messages
        .filter(m => m.role === 'user' || m.role === 'assistant')
        .map(m => ({ role: m.role, content: m.text }))
      if (!overrideMsg) apiMessages.push({ role: 'user', content: userMsg })
      else apiMessages.push({ role: 'user', content: userMsg })

      const response = await fetch('/api/claude', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 1000,
          system: SYSTEM_PROMPT + '\n\nCurrent financial data:\n' + context,
          messages: apiMessages,
          tools: TOOLS,
        })
      })
      const data = await response.json()
      
      // Handle tool use
      let finalText = ''
      for (const block of (data.content || [])) {
        if (block.type === 'text') {
          finalText += block.text
        } else if (block.type === 'tool_use') {
          const toolResult = await executeTool(block.name, block.input)
          finalText += (finalText ? '\n\n' : '') + toolResult
        }
      }

      if (finalText) setMessages(prev => [...prev, { role: 'assistant', text: finalText }])
    } catch (err) {
      setMessages(prev => [...prev, { role: 'assistant', text: 'Error: ' + (err.message || 'Failed to connect') }])
    }
    setLoading(false)
  }

  async function handleConfirm() {
    if (!pendingAction) return
    setLoading(true)
    const result = await pendingAction.confirm()
    setMessages(prev => [...prev, { role: 'assistant', text: result }])
    setLoading(false)
  }

  function handleCancel() {
    if (!pendingAction) return
    const result = pendingAction.cancel()
    setMessages(prev => [...prev, { role: 'assistant', text: result }])
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        style={{
          position: 'fixed', bottom: 24, right: 24, zIndex: 9999,
          width: 56, height: 56, borderRadius: '50%',
          background: '#0f172a', color: '#fff', border: 'none',
          cursor: 'pointer', fontSize: 24, fontWeight: 700,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          boxShadow: '0 4px 20px rgba(0,0,0,0.15)',
          transition: 'transform 0.15s',
        }}
        onMouseEnter={e => e.currentTarget.style.transform = 'scale(1.08)'}
        onMouseLeave={e => e.currentTarget.style.transform = 'scale(1)'}
        title="Ask Aurelia"
      >
        A
      </button>
    )
  }

  return (
    <div style={{
      position: 'fixed', bottom: 24, right: 24, zIndex: 9999,
      width: 400, height: 560,
      background: '#fff', borderRadius: 16,
      border: '1px solid #e2e8f0',
      boxShadow: '0 8px 40px rgba(0,0,0,0.12)',
      display: 'flex', flexDirection: 'column',
      overflow: 'hidden',
    }}>
      <div style={{
        padding: '14px 18px', background: '#0f172a', color: '#fff',
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      }}>
        <div>
          <div style={{ fontSize: 15, fontWeight: 600 }}>Aurelia AI</div>
          <div style={{ fontSize: 11, opacity: 0.7 }}>{location ? cleanLocName(location) : 'All Locations'} \u00b7 {periodKey}</div>
        </div>
        <button onClick={() => setOpen(false)} style={{
          background: 'none', border: 'none', color: '#fff', fontSize: 18,
          cursor: 'pointer', padding: 4, opacity: 0.7,
        }}>\u2715</button>
      </div>

      <div ref={scrollRef} style={{
        flex: 1, overflowY: 'auto', padding: '12px 16px',
        display: 'flex', flexDirection: 'column', gap: 10,
      }}>
        {messages.length === 0 && (
          <div style={{ textAlign: 'center', padding: '30px 20px', color: '#94a3b8' }}>
            <div style={{ fontSize: 28, marginBottom: 8, fontWeight: 700 }}>A</div>
            <div style={{ fontSize: 13, fontWeight: 500, color: '#475569' }}>Ask me about your financials</div>
            <div style={{ fontSize: 12, marginTop: 12, lineHeight: 1.8, color: '#94a3b8' }}>
              "How am I tracking vs budget?"<br/>
              "Post a $500 equipment expense"<br/>
              "Flag any issues this week"<br/>
              "Help me close this period"
            </div>
          </div>
        )}
        {messages.map((msg, i) => (
          <div key={i} style={{
            alignSelf: msg.role === 'user' ? 'flex-end' : 'flex-start',
            maxWidth: '85%',
            padding: '10px 14px',
            borderRadius: msg.role === 'user' ? '14px 14px 4px 14px' : '14px 14px 14px 4px',
            background: msg.role === 'user' ? '#0f172a' : '#f1f5f9',
            color: msg.role === 'user' ? '#fff' : '#0f172a',
            fontSize: 13, lineHeight: 1.6,
            whiteSpace: 'pre-wrap',
          }}>
            {msg.text.includes('::CHART::') ? (
              <>
                {msg.text.split('::CHART::')[0]}
                <div style={{ margin: '8px 0', background: '#fff', borderRadius: 8, padding: 8, border: '1px solid #e2e8f0' }}
                  dangerouslySetInnerHTML={{ __html: msg.text.split('::CHART::')[1] }} />
              </>
            ) : msg.text}
          </div>
        ))}
        {pendingAction && (
          <div style={{
            padding: '12px 14px', background: '#fffbeb', border: '1px solid #fde68a',
            borderRadius: 12, fontSize: 13,
          }}>
            <div style={{ fontWeight: 600, marginBottom: 8, color: '#92400e' }}>Confirm action</div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={handleConfirm} style={{
                padding: '6px 16px', fontSize: 12, fontWeight: 600,
                background: '#059669', color: '#fff', border: 'none',
                borderRadius: 6, cursor: 'pointer',
              }}>Confirm</button>
              <button onClick={handleCancel} style={{
                padding: '6px 16px', fontSize: 12, fontWeight: 600,
                background: '#fff', color: '#dc2626', border: '1px solid #fecaca',
                borderRadius: 6, cursor: 'pointer',
              }}>Cancel</button>
            </div>
          </div>
        )}
        {loading && (
          <div style={{
            alignSelf: 'flex-start', padding: '10px 14px',
            background: '#f1f5f9', borderRadius: '14px 14px 14px 4px',
            fontSize: 13, color: '#94a3b8',
          }}>
            Thinking...
          </div>
        )}
      </div>

      <div style={{
        padding: '10px 12px', borderTop: '1px solid #e2e8f0',
        display: 'flex', gap: 8,
      }}>
        <input
          ref={inputRef}
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && handleSend()}
          placeholder="Ask about your P&L..."
          style={{
            flex: 1, padding: '10px 14px', fontSize: 13,
            border: '1px solid #e2e8f0', borderRadius: 10,
            outline: 'none', background: '#f8fafc',
          }}
        />
        <button
          onClick={() => handleSend()}
          disabled={loading || !input.trim()}
          style={{
            padding: '10px 16px', fontSize: 13, fontWeight: 600,
            background: loading || !input.trim() ? '#e2e8f0' : '#0f172a',
            color: loading || !input.trim() ? '#94a3b8' : '#fff',
            border: 'none', borderRadius: 10, cursor: 'pointer',
          }}
        >
          Send
        </button>
      </div>
    </div>
  )
}
