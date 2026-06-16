// Budget bulk-import: parses the 2026 Fooda Cafe Budgets "Budget_Load" sheet
// (one row per location x GL line, 12 monthly columns) and maps each GL line to
// the app's budget_* P&L keys. Pure logic — no Firestore writes here.
//
// Source sheet shape (Budget_Load): 49 locations, 27 GL lines each, identical set.
//   col0 Region/Site | col1 Budget Line | col2 PL Line | col3 GL | col4 BU
//   col5..col16 = 12 monthly budget values (Jan..Dec)

// GL account number -> app budget_* key. Keyed by GL (stable) not label.
export const FILE_GL_TO_BUDGET = {
  // Gross Food Sales
  '99999':  'budget_gfs_popup',
  '88888':  'budget_gfs_catering',
  '77777':  'budget_gfs_delivery',
  '66666':  'budget_gfs_retail',
  '-33333': 'budget_gfs_pantry',
  // Revenue
  '40042':  'budget_revenue_popup',
  '40200':  'budget_revenue_catering',
  '40100':  'budget_revenue_delivery',
  '40160':  'budget_revenue_retail',
  '40510':  'budget_revenue_pantry',
  '40080':  'budget_revenue_fees',
  '40050':  'budget_revenue_share',
  // Labor
  '50410':  'budget_cogs_labor_salaries',
  '68016':  'budget_cogs_labor_benefits',
  // COGS
  '50430':  'budget_cogs_equipment',
  '50450':  'budget_cogs_maintenance',
  '61020':  'budget_cogs_payment_processing',
  '50160':  'budget_cogs_retail_managed',
  // Expenses
  '65090':  'budget_exp_office_supplies',
  '61010':  'budget_exp_bank_fees',
  '62010':  'budget_exp_mktg_marketing',
  '63010':  'budget_exp_technology',
  '64120':  'budget_exp_travel',
  '66010':  'budget_exp_professional',
  '67200':  'budget_exp_facilities',
  '69003':  'budget_exp_licenses',
  '69001':  'budget_exp_other',
}

// GL -> Budgets-page schema line key + label. The Budgets annual table reads
// budget doc `lines` keyed by slugify(label) with {month:value} maps. These slug
// keys match the BUDGET_TO_PNL dictionary in Budgets.jsx so its approve/repost
// also maps them to the right P&L keys.
export const GL_TO_SCHEMA = {
  '99999':  { key: 'popup', label: 'Popup' },
  '88888':  { key: 'catering', label: 'Catering' },
  '66666':  { key: 'retail', label: 'Retail' },
  '77777':  { key: 'delivery', label: 'Delivery' },
  '-33333': { key: 'pantry', label: 'Pantry' },
  '40042':  { key: 'popup_revenue', label: 'Popup Revenue' },
  '40200':  { key: 'catering_revenue', label: 'Catering Revenue' },
  '40100':  { key: 'delivery_revenue', label: 'Delivery Revenue' },
  '40160':  { key: 'retail_revenue', label: 'Retail Revenue' },
  '40510':  { key: 'pantry_revenue', label: 'Pantry Revenue' },
  '40080':  { key: 'client_fees', label: 'Client Fees' },
  '40050':  { key: 'revenue_share', label: 'Revenue Share' },
  '50410':  { key: 'onsite_labor_fooda_salaries_and_wages', label: 'Onsite Labor (Fooda) Salaries and Wages' },
  '68016':  { key: 'total_comp_and_benefits', label: 'Total Comp and Benefits' },
  '50430':  { key: 'onsite_equipment', label: 'Onsite Equipment' },
  '50450':  { key: 'onsite_other', label: 'Onsite Other' },
  '61020':  { key: 'bank_charges_merchant_fees', label: 'Bank Charges, Merchant Fees' },
  '50160':  { key: 'retail_cogs_managed_service_cost', label: 'Retail COGS - Managed Service Cost' },
  '65090':  { key: 'office_supplies_equipment', label: 'Office Supplies Equipment' },
  '61010':  { key: 'bank_fees', label: 'Bank fees' },
  '62010':  { key: 'marketing', label: 'Marketing' },
  '63010':  { key: 'technology_services', label: 'Technology Services' },
  '64120':  { key: 'travel_and_entertainment', label: 'Travel and Entertainment' },
  '66010':  { key: 'professional_fees', label: 'Professional Fees' },
  '67200':  { key: 'facilities', label: 'Facilities' },
  '69003':  { key: 'licenses_permits_and_fines', label: 'Licenses, Permits and Fines' },
  '69001':  { key: 'other_expenses', label: 'Other Expenses' },
}

// Section display order + colors (mirrors the Budgets page conventions).
const SCHEMA_SECTIONS = ['Gross Food Sales', 'Revenue', 'Labor', 'COGS', 'Expenses', 'EBITDA']
const SECTION_COLORS = ['#10b981', '#3b82f6', '#f59e0b', '#8b5cf6', '#ef4444']

// Map our GL_SECTION buckets to the Budgets page section labels.
const SECTION_LABEL = { GFS: 'Gross Food Sales', Revenue: 'Revenue', Labor: 'Labor', COGS: 'COGS', Expenses: 'Expenses' }

// Ordered GL list (file/display order) so schema lines render in a sensible order.
const GL_ORDER = [
  '99999','88888','77777','66666','-33333',
  '40042','40200','40100','40160','40510','40080','40050',
  '50410','68016',
  '50430','50450','61020','50160',
  '65090','61010','62010','63010','64120','66010','67200','69003','69001',
]

// Build the shared config/budgetSchema sections array from GL_TO_SCHEMA.
export function buildBudgetSchema() {
  const bySection = {}
  for (const gl of GL_ORDER) {
    const sm = GL_TO_SCHEMA[gl]
    const secKey = GL_SECTION[gl]
    if (!sm || !secKey) continue
    const label = SECTION_LABEL[secKey]
    if (!bySection[label]) bySection[label] = []
    bySection[label].push({
      key: sm.key,
      label: sm.label,
      bold: false,
      highlight: false,
      gfsBase: false,
    })
  }
  // Add the Total Gross Food Sales line (gfsBase) so the Budgets page has a
  // denominator for the % GFS column and the annual GFS KPI.
  if (bySection['Gross Food Sales']) {
    bySection['Gross Food Sales'].push({
      key: 'total_gross_food_sales',
      label: 'Total Gross Food Sales',
      bold: true, highlight: true, gfsBase: true,
    })
  }
  // Add an EBITDA line (the Budgets page reads label === 'ebitda' for the KPI).
  if (!bySection['EBITDA']) bySection['EBITDA'] = []
  bySection['EBITDA'].push({ key: 'ebitda', label: 'EBITDA', bold: true, highlight: true, gfsBase: false })
  return SCHEMA_SECTIONS
    .filter(name => bySection[name])
    .map((name, i) => ({
      id: name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''),
      label: name,
      color: SECTION_COLORS[i % SECTION_COLORS.length],
      lines: bySection[name],
    }))
}

// Build the budget doc `lines` in the exact shape the Budgets page reads:
// { [slugKey]: { 1: jan, 2: feb, ... 12: dec } } — only non-zero months.
export function buildBudgetLines(loc) {
  const lines = {}
  for (const [gl, monthly] of Object.entries(loc.lines)) {
    const m = GL_TO_SCHEMA[gl]
    if (!m) continue
    const months = {}
    monthly.forEach((v, i) => { if (v && v !== 0) months[i + 1] = v })
    if (Object.keys(months).length) lines[m.key] = months
  }
  // Total Gross Food Sales = sum of all GFS-section GLs, per month.
  const gfsTotal = {}
  for (const [gl, monthly] of Object.entries(loc.lines)) {
    if (GL_SECTION[gl] !== 'GFS') continue
    monthly.forEach((v, i) => { if (v) gfsTotal[i + 1] = (gfsTotal[i + 1] || 0) + v })
  }
  if (Object.keys(gfsTotal).length) lines['total_gross_food_sales'] = gfsTotal
  // EBITDA per month = Revenue - Labor - COGS - Expenses (from the loaded lines).
  const ebitda = {}
  for (let mo = 1; mo <= 12; mo++) {
    let rev = 0, lab = 0, cogs = 0, exp = 0
    for (const [gl, monthly] of Object.entries(loc.lines)) {
      const v = monthly[mo - 1] || 0
      const sec = GL_SECTION[gl]
      if (sec === 'Revenue') rev += v
      else if (sec === 'Labor') lab += v
      else if (sec === 'COGS') cogs += v
      else if (sec === 'Expenses') exp += v
    }
    const e = rev - lab - cogs - exp
    if (e) ebitda[mo] = Math.round(e * 100) / 100
  }
  if (Object.keys(ebitda).length) lines['ebitda'] = ebitda
  return lines
}

// Which rollup section each GL belongs to (for budget_gfs/revenue/labor/cogs/expenses totals).
export const GL_SECTION = {
  '99999':'GFS','88888':'GFS','77777':'GFS','66666':'GFS','-33333':'GFS',
  '40042':'Revenue','40200':'Revenue','40100':'Revenue','40160':'Revenue','40510':'Revenue','40080':'Revenue','40050':'Revenue',
  '50410':'Labor','68016':'Labor',
  '50430':'COGS','50450':'COGS','61020':'COGS','50160':'COGS',
  '65090':'Expenses','61010':'Expenses','62010':'Expenses','63010':'Expenses','64120':'Expenses','66010':'Expenses','67200':'Expenses','69003':'Expenses','69001':'Expenses',
}

// Locations in the file we never bulk-write as-is.
export const SKIP_LOCATIONS = new Set(['Growth P&L'])

const SHEET = 'Budget_Load'

// Parse an .xlsm/.xlsx ArrayBuffer -> structured per-location budgets.
// XLSX is passed in (already imported by the caller via await import('xlsx')).
export function parseBudgetWorkbook(XLSX, arrayBuffer) {
  const wb = XLSX.read(new Uint8Array(arrayBuffer), { type: 'array', cellDates: true })
  if (!wb.SheetNames.includes(SHEET)) {
    return { locations: [], errors: ['Sheet "' + SHEET + '" not found. Sheets: ' + wb.SheetNames.slice(0,8).join(', ') + '...'] }
  }
  const ws = wb.Sheets[SHEET]
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true })
  // Row 0 = header. Monthly values are columns 5..16 (indices 5-16).
  const MONTH_COLS = [5,6,7,8,9,10,11,12,13,14,15,16]

  const byLoc = {}
  const errors = []
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i]
    if (!r || !r[0]) continue
    const name = String(r[0]).trim()
    if (SKIP_LOCATIONS.has(name)) continue
    const gl = String(r[3]).trim()
    if (!gl) continue
    const monthly = MONTH_COLS.map(c => {
      const v = r[c]
      const n = typeof v === 'number' ? v : parseFloat(String(v || '0').replace(/[$,]/g,''))
      return isNaN(n) ? 0 : n
    })
    if (!byLoc[name]) byLoc[name] = { name, lines: {} }
    byLoc[name].lines[gl] = monthly
  }

  const locations = Object.values(byLoc).map(loc => {
    // annual total per section (for preview)
    const sectionAnnual = { GFS:0, Revenue:0, Labor:0, COGS:0, Expenses:0 }
    for (const [gl, monthly] of Object.entries(loc.lines)) {
      const sec = GL_SECTION[gl]
      if (sec) sectionAnnual[sec] += monthly.reduce((a,b)=>a+b, 0)
    }
    sectionAnnual.EBITDA = sectionAnnual.Revenue - sectionAnnual.Labor - sectionAnnual.COGS - sectionAnnual.Expenses
    return { ...loc, sectionAnnual, lineCount: Object.keys(loc.lines).length }
  })

  return { locations, errors }
}

// Build the budget_* object for ONE location and ONE month (1-12).
// Mirrors the shape Budgets.jsx writes: per-line keys + rollup totals + ebitda.
export function buildBudgetDataForMonth(loc, month) {
  const mi = month - 1
  const data = {}
  const sec = { GFS:0, Revenue:0, Labor:0, COGS:0, Expenses:0 }
  for (const [gl, monthly] of Object.entries(loc.lines)) {
    const val = monthly[mi] || 0
    const key = FILE_GL_TO_BUDGET[gl]
    if (key) data[key] = val
    const s = GL_SECTION[gl]
    if (s) sec[s] += val
  }
  data.budget_gfs      = sec.GFS
  data.budget_revenue  = sec.Revenue
  data.budget_labor    = sec.Labor
  data.budget_cogs     = sec.COGS
  data.budget_expenses = sec.Expenses
  data.budget_ebitda   = sec.Revenue - sec.Labor - sec.COGS - sec.Expenses
  return data
}


// ── WRITE PATH ──────────────────────────────────────────────────────────────
// Writes one location's full-year budget. Mirrors Budgets.jsx handleApprove:
// per month, build budget_* data, divide by weeks in period, write each week.
// Also writes the budgets/{locId}-{year} source doc. Idempotent (overwrites).
//
// Deps are injected (db, firestore fns, writePnL, weeksInPeriod, locId) so this
// stays a pure lib and the caller wires the app's real instances.
export async function writeLocationBudget({
  loc, appName, year, orgId,
  db, doc, setDoc, serverTimestamp,
  writePnL, weeksInPeriod, locId,
  submittedBy, writeSchema,
}) {
  // Write the shared schema once (first location of a batch). Without this the
  // Budgets page has no rows to render the values into.
  if (writeSchema) {
    await setDoc(doc(db, 'tenants', orgId, 'config', 'budgetSchema'), {
      sections: buildBudgetSchema(),
      updatedAt: serverTimestamp(),
      updatedBy: submittedBy || 'budget import',
    }, { merge: true })
  }
  // 1. Source doc — written in the SCHEMA shape the Budgets page reads:
  //    lines = { slugKey: { 1: jan, ... 12: dec } }. status 'approved' so it
  //    displays as a live budget (bulk import is the deliberate approved upload).
  await setDoc(doc(db, 'tenants', orgId, 'budgets', locId(appName) + '-' + year), {
    lines: buildBudgetLines(loc),
    location: appName,
    year,
    status: 'approved',
    source: 'bulk_import',
    submittedBy: submittedBy || 'budget import',
    updatedAt: serverTimestamp(),
  }, { merge: false })

  // 2. P&L writes — per month, divide by weeks, write each week.
  let weeksWritten = 0
  for (let mo = 1; mo <= 12; mo++) {
    const budgetData = buildBudgetDataForMonth(loc, mo)
    const basePeriod = year + '-P' + String(mo).padStart(2, '0')
    const numWeeks = weeksInPeriod(year, mo)
    const weekly = {}
    for (const [k, v] of Object.entries(budgetData)) {
      weekly[k] = Math.round((v / numWeeks) * 100) / 100
    }
    for (let w = 1; w <= numWeeks; w++) {
      await writePnL(appName, basePeriod + '-W' + w, weekly)
      weeksWritten++
    }
  }
  return { location: appName, weeksWritten }
}
