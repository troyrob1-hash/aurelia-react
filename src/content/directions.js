/**
 * directions.js — ALL copy for the Help & Directions page (/directions).
 *
 * This is the ONLY file to edit to change the Help page. src/routes/Directions.jsx
 * is a dumb renderer that maps over this data — do not put copy in the JSX.
 *
 * Structure:
 *   INTRO       — orientation (the two top-bar controls, period close, data flow)
 *   START_HERE  — item list first
 *   REPORTS     — the six real monthly-report inputs (+ one manual log). This is the
 *                 spec, taken from Fooda's Unit Monthly Report workbook (V26-03).
 *                 Each report carries a `tag`: 'live' (Aurelia accepts it now),
 *                 'coming' (documented but not wired yet), or is a manual log.
 *   CADENCE     — weekly vs month-end
 *   TABS        — what each app tab does
 *   FAQ
 *
 * Conventions:
 *   - `[TROY: ...]` markers render as a highlighted callout (all filled today).
 *   - `uploads[].columns` / `report.columns` are EXACT header/report names.
 */

export const INTRO = {
  heading: 'How Aurelia works',
  lede:
    'Aurelia builds your café’s P&L from a handful of reports you already pull each month. ' +
    'You upload your item list once, then feed in six reports (labor, café sales, catering, purchases, ' +
    'the enterprise P&L, occupancy) on a weekly/month-end rhythm — and the Dashboard assembles the income ' +
    'statement. This page is the field guide: which report, where it lives, exactly how to pull it, and what ' +
    'Aurelia does with it.',
  blocks: [
    {
      h: 'Two controls sit on top of everything',
      body:
        'The top bar has a Location picker and a Period selector (Year / P1–P12 / a Week, or "Monthly"). ' +
        'Everything you enter is scoped to the location AND period shown up there. If your numbers look ' +
        'wrong or empty, check those two first — you are almost always looking at a different location or week.',
    },
    {
      h: 'Closing a period is one-way for managers',
      body:
        'A director or admin can Close a period (the green 🔒 Close Period button). Once closed, every tab ' +
        'locks — count boxes, sales entry and labor inputs go read-only ("Period closed — reopen to edit"). ' +
        'A manager CANNOT reopen it; only a director or admin can (the 🔓 Reopen button). Close a period only ' +
        'when the week is truly done.',
    },
    {
      h: 'The Dashboard is read-only — it just reports',
      body:
        'You never type numbers into the P&L (Dashboard) tab. It pulls from the operational tabs: Sales feeds ' +
        'revenue, Inventory feeds COGS, Purchasing feeds purchases, Labor feeds labor, Budgets feeds the budget ' +
        'column. Fix a number on its source tab and the Dashboard follows.',
    },
  ],
}

// Prominent, rendered ABOVE the reports — the first thing a new manager does.
export const START_HERE = {
  heading: 'Start here: upload your item list',
  body: [
    'Upload your item list first. Everything in Aurelia keys off your location’s item catalog — counting, ' +
      'ordering, valuation, invoicing. The unit manager owns this list; nobody sets it up for you.',
    'Get the workbook from the company OneDrive and upload it whole — Aurelia reads the INVItems tab ' +
      'automatically and tells you which sheet it used.',
    'Inventory → "Item list" (amber button). This loads item DEFINITIONS — names, pack sizes, prices, ' +
      'vendors, GL codes. NOT counts. You enter counts after, by typing them or using the green "Upload counts" button.',
  ],
}

// The reports front door — "tape this to your monitor."
export const REPORTS_INTRO = {
  heading: 'Reports to pull',
  lede:
    'Six reports feed Aurelia — Labor, Café sales, Catering sales, the Enterprise P&L, the Annual Budget, and Sales Items (shrinkage). ' +
    'Pull the weekly ones (Labor, Café, Catering, Sales Items) every week so the running P&L and shrinkage stay useful; the Enterprise ' +
    'P&L is month-end (available the 20th) and the Annual Budget is once a year. Two others — Custom Purchases and ' +
    'A/R Aging — are REFERENCE ONLY: Aurelia already covers purchases in the Purchasing tab, and does not track A/R. ' +
    'The table below is the cheat-sheet; step-by-step for each is underneath.',
  tableauHome: 'https://us-east-1.online.tableau.com/#/site/fooda/home',
  tableauTip:
    'In Tableau, use the SEARCH BAR at the top to find each report by name, then FAVORITE it (the star) so it ' +
    'sits on your home page and you never hunt for it again.',
  operatingNotes: [
    'Export everything as a CROSSTAB CSV — the export icon → "Crosstab" → CSV. (Not "Data" — Crosstab gives the laid-out columns Aurelia expects.)',
    'Fiscal weeks run SUNDAY–SATURDAY. Week 1 = the 1st through the first Saturday; the last week = the last Sunday through month-end. A week never crosses a month boundary, so a month has 5 or 6 weeks depending on the calendar.',
    'The Enterprise P&L (the official books) is only AVAILABLE THE 20TH of the following month — that timing is the workflow. You cannot close or reconcile a month against it before then.',
  ],
}

// status: 'active'  = Aurelia actually uses this report (shown in the pull table).
//         'reference' = listed for reference only — Aurelia covers it elsewhere or
//                       doesn't track it (shown in a separate "Reference only" list).
// tag:    'live' = wired in Aurelia today · 'coming' = documented spec, not wired yet.
// manual: true = a hand-entered log, not a file import (excluded from the pull table).
// format: how to export it (e.g. 'Crosstab CSV').
export const REPORTS = [
  {
    id: 'r-labor',
    num: 1,
    name: 'Labor',
    where: 'Tableau',
    report: 'Summary by Site  (under "Café Labor Efficiency Tracking")',
    status: 'active',
    tag: 'live',
    format: 'Crosstab CSV',
    cadence: 'Weekly',
    feeds: 'Labor tab (hourly labor)',
    filtersShort: 'Site Name = your site · "Week" dropdown = "Last 8 weeks"',
    steps: [
      'In Tableau, search for "Café Labor Efficiency Tracking" and open the "Summary by Site" view.',
      'Check that Site Name matches your site.',
      'Set the "Week" dropdown to "Last 8 weeks."',
      'Export to .csv using the export icon — a box with a downward arrow — on the right edge of the report.',
    ],
    columns: [
      'Site Name', 'Week of Event', 'Scheduled Labor', 'Actual Labor', 'Labor Variance',
      'Schedule Labor $', 'Actual Labor $', 'Labor $ Variance', 'Sales', 'Actual Labor as % of GFS',
    ],
    notes: [
      'This is HOURLY labor only. Manager salaries are entered separately in Setup — they are not in this report.',
    ],
    aurelia: 'Upload it on the Labor tab. Aurelia records hourly labor by week onto the P&L.',
  },
  {
    id: 'r-cafe',
    num: 2,
    name: 'Café sales',
    where: 'Tableau',
    report: 'Popup Event Summary - Market Operations → Vendor/Partner Financials - Popup Event Summary',
    status: 'active',
    tag: 'live',
    format: 'Crosstab CSV',
    cadence: 'Weekly',
    feeds: 'Weekly Sales → Popup + Retail',
    filtersShort: 'Event dates = first & last of the month · account internal name = yours',
    steps: [
      'In Tableau, search for "Vendor/Partner Financials - Popup Event Summary" (it sits under "Popup Event Summary - Market Operations").',
      'Set the event dates to the FIRST and LAST day of the month.',
      'Ensure the account internal name matches yours.',
      'Export to .csv.',
    ],
    columns: [],
    notes: [
      'Aurelia routes it automatically: anything under 11 Dining (Cafeteria/Barista) → Retail; every other vendor → Popup.',
    ],
    aurelia: 'Upload it with the catering file via Import Events on Weekly Sales — posts popup + retail revenue.',
  },
  {
    id: 'r-catering',
    num: 3,
    name: 'Catering sales',
    where: 'Tableau',
    report: 'Event Summary - Catering → Event Restaurant Details - Event Summary - Catering',
    status: 'active',
    tag: 'live',
    format: 'Crosstab CSV · date range back 2 months',
    cadence: 'Weekly',
    feeds: 'Weekly Sales → Catering',
    filtersShort: 'Date range back 2 months · account check as café sales',
    steps: [
      'In Tableau, search for "Event Summary - Catering" and open "Event Restaurant Details - Event Summary - Catering."',
      'Set the date range to go back 2 months (catering events settle late, so the wider window catches them).',
      'Confirm the account matches yours.',
      'Export as a Crosstab CSV.',
    ],
    columns: [],
    notes: [],
    aurelia: 'Upload it with the café file via Import Events on Weekly Sales — posts catering revenue.',
  },
  {
    id: 'r-custom',
    name: 'Custom purchases',
    where: 'NetSuite',
    report: 'Custom Purchases Summary FOR CR  (invoiced via Ramp)',
    status: 'reference',
    tag: 'coming',
    format: 'Excel-icon download',
    cadence: '—',
    feeds: 'Purchasing (already covered)',
    refNote: 'Reference only — NOT needed in Aurelia. The Purchasing tab already captures these purchases (import the invoice, or enter it), with dedup and posting-date week handled. Pull this only if you want the raw NetSuite list.',
    filtersShort: 'Dates = the month · Site = your account only',
    steps: [
      'In NetSuite, set the dates to the month.',
      'Click the two up-arrows and "more" beside the dates.',
      'Under "Site ANY of," uncheck "all," find your account, click OK, then Refresh.',
      'Download via the Excel icon at the bottom right.',
    ],
    columns: [
      'Site', 'Vendor Invoice Date', 'Name', 'Amount (Gross)', 'Account (Line): Name', 'Document Number',
    ],
    notes: [
      'The GL arrives as a combined string, e.g. "12000 - Inventory - Cafeteria."',
      'Negative amounts are credit memos.',
    ],
    aurelia: 'Covered by the Purchasing tab — you do not need to pull or import this separately.',
  },
  {
    id: 'r-enterprise',
    num: 4,
    name: 'Enterprise P&L',
    where: 'Tableau',
    report: 'Enterprise P&L - Actuals vs. Budget',
    status: 'active',
    tag: 'live',
    format: 'Crosstab CSV',
    cadence: 'Month-end (the 20th)',
    feeds: 'Reconciliation tab (the official P&L)',
    filtersShort: 'Month = previous month · your site checked · expand Subcategory → Line → NetSuite Account Name',
    steps: [
      'In Tableau, search for "Enterprise P&L - Actuals vs. Budget."',
      'Under "Month," select the PREVIOUS month.',
      'Ensure your site is checked under "Site."',
      'Hover and click the + next to "Subcategory" — "Line" opens.',
      'Hover and click the + next to "Line" — "NetSuite Account Name" appears.',
      'THEN run the report (do the expands first, or the account detail is missing).',
      'Export as a Crosstab CSV.',
    ],
    columns: [],
    notes: [
      'AVAILABLE THE 20TH OF THE FOLLOWING MONTH — that timing IS the workflow. You cannot reconcile the month against it before then.',
      'This is the OFFICIAL P&L — the number Aurelia checks itself against.',
    ],
    aurelia: 'Import it on the Reconciliation tab (director/vp/admin). Aurelia diffs its running P&L against these official lines, per line.',
  },
  {
    id: 'r-budget',
    num: 5,
    name: 'Annual Budget',
    where: 'Tableau',
    report: 'Enterprise P&L  (full year)',
    status: 'active',
    tag: 'live',
    format: 'Crosstab CSV',
    cadence: 'Annual (early January)',
    feeds: 'Budgets tab',
    filtersShort: 'Full fiscal year · your site · same Subcategory → Line → NetSuite Account Name expands',
    steps: [
      'In Tableau, open "Enterprise P&L" and set the range to the FULL fiscal year.',
      'Do the same expands as the monthly Enterprise P&L: Subcategory → + → Line → + → NetSuite Account Name.',
      'Run, then export as a Crosstab CSV.',
    ],
    columns: [],
    notes: [
      'Run this ONCE, in early January, when the year’s budget is finalized.',
      'Aurelia prorates the annual budget evenly across each fiscal week — that feeds the Labor pace signal and the per-line budget/variance columns.',
    ],
    aurelia: 'Import it on the Budgets tab (admin). Aurelia sets the annual budget, prorated per fiscal week.',
  },
  {
    id: 'r-sales-items',
    num: 6,
    name: 'Sales Items (Shrinkage)',
    where: 'Tableau',
    report: 'Cafe Product Mix',
    status: 'active',
    tag: 'live',
    format: 'Crosstab CSV',
    cadence: 'Weekly',
    feeds: 'Shrinkage Analysis → Import Sales',
    filtersShort: 'Include "Account Internal Name" · Weekday breakdown ON · your site(s)',
    steps: [
      'In Tableau, search for "Cafe Product Mix" and open it.',
      'ADD the "Account Internal Name" dimension to the view (this is what splits San Diego into its cafés — AZ/AY/S/N/Q/R/WT). Without it San Diego comes in campus-grain and will not reconcile per café.',
      'Turn the WEEKDAY breakdown ON (the weekday rows under each item — Aurelia reads these, not the weekly Total).',
      'Set the date range to cover the weeks you want to reconcile.',
      'Export as a Crosstab CSV.',
    ],
    columns: [
      'Site', 'Account Internal Name', 'Restaurant', 'Item Name', 'Weekday of Event Date', 'Week of Event Date columns',
    ],
    notes: [
      'MUST include "Account Internal Name." It is the per-café key — Aurelia maps the 9 POS accounts to the 6 café locations (the San Diego satellites AY→AZ, N→S, R→Q lump into their parent café). Pull it campus-grain and San Diego cannot reconcile per café.',
      'Weekday breakdown must be ON. Aurelia sums the weekday rows (not the per-week Total) so a calendar week that straddles a month boundary is split into the correct fiscal weeks.',
      'This is the SOLD side of shrinkage — what the POS rang up. Aurelia diffs it against what was counted (Inventory) to surface unexplained loss.',
    ],
    aurelia: 'Import it on Shrinkage Analysis via the Import Sales button — loads per-item, per-week POS sales (the SOLD feed) keyed to the same café IDs inventory uses.',
  },
  {
    id: 'r-ar-aging',
    name: 'A/R Aging',
    where: 'NetSuite',
    report: 'A/R Aging Detail - NetSuite',
    status: 'reference',
    tag: 'coming',
    format: '—',
    cadence: '—',
    feeds: '(not tracked)',
    refNote: 'Reference only — Aurelia does NOT track accounts receivable. Listed so you know where it lives if finance asks for it.',
    filtersShort: '—',
    steps: [
      'In NetSuite, open "A/R Aging Detail" for your site.',
      'This is for reference — Aurelia has no A/R import.',
    ],
    columns: [],
    notes: [],
    aurelia: 'Not tracked in Aurelia — reference only.',
  },
  {
    id: 'r-occupancy',
    name: 'Occupancy',
    where: 'Building management',
    report: 'Daily badge swipes / headcount',
    status: 'reference',
    tag: 'coming',
    format: '—',
    cadence: '—',
    feeds: '(not tracked)',
    refNote: 'Reference only — Aurelia does not track occupancy today. Get it from building management if you need it separately.',
    filtersShort: '—',
    steps: [
      'Get the daily badge swipes / headcount from building management (there is no report to export).',
    ],
    columns: [],
    notes: [],
    aurelia: 'Not tracked in Aurelia — reference only.',
  },
  {
    id: 'r-running',
    name: 'Non-invoiced purchases',
    where: 'Purchasing tab (manual entry)',
    report: 'Amazon / Webstaurant / personal-card purchases',
    status: 'active',
    tag: 'live',
    manual: true,
    cadence: 'As they happen',
    feeds: 'Purchasing',
    filtersShort: '—',
    steps: [
      'Not an import — there is no report. Amazon, Webstaurant, or anything bought on a personal card never arrives as a formal invoice, so enter each on the Purchasing tab.',
      'Per purchase: Vendor · Date · Amount · GL. No invoice number needed — a numberless purchase saves and posts to the fiscal week of its date.',
    ],
    columns: [],
    notes: [
      'The invoice number is OPTIONAL here. Two numberless purchases from the same vendor in the same week both count — Aurelia never merges numberless entries.',
    ],
    aurelia: 'Live — enter each on the Purchasing tab. It posts to cogs_purchases in the fiscal week of the purchase date.',
  },
]

export const CADENCE = {
  heading: 'How often to pull each one',
  weekly: {
    label: 'Weekly',
    items: ['Labor', 'Café sales', 'Catering sales', 'Custom purchases'],
  },
  monthEnd: {
    label: 'Month-end',
    items: ['Enterprise P&L — available the 20th of the following month', 'Occupancy'],
  },
  note:
    'Pull the weekly reports every week — that is what keeps the running P&L useful mid-month instead of a ' +
    'once-a-month scramble. The Enterprise P&L is the month-end reconciliation (the official number), and ' +
    'occupancy is entered at month-end. Running purchases (#7) get logged as they happen.',
}

export const TABS = [
  // ── 1. P&L / Dashboard ────────────────────────────────────────────────────
  {
    id: 'dashboard',
    navLabel: 'P&L',
    urlName: 'Dashboard',
    url: '/dashboard',
    purpose:
      'Read-only income statement for the selected location and period. Shows Gross Food Sales, Revenue, ' +
      'COGS, Gross Profit, Expenses and EBITDA — actual vs budget, vs prior period, with a scenario builder.',
    workflow: [
      'Pick a location and period in the top bar (or "All Locations" for a ranked roll-up).',
      'Read the statement top to bottom: GFS → Revenue → COGS → Gross Profit → Expenses → EBITDA.',
      'Compare the Actual and Budget columns; the budget comes from the Budgets tab once a director approves it.',
      'Nothing is entered here — to change a number, fix it on the tab that owns it.',
    ],
    uploads: [],
    gotchas: [
      'This tab has no inputs. If a line is zero, the source tab has not been filled in (or you are on the wrong location/period).',
      'Prime cost (COGS + Labor as a % of revenue) is the core efficiency metric. Aurelia shows the number and its ' +
        'trend — there is no invented "target %" to grade yourself against. Judge it against your own budget and prior weeks.',
    ],
    troy: [],
  },

  // ── 2. Order Hub ───────────────────────────────────────────────────────────
  {
    id: 'orders',
    navLabel: 'Order Hub',
    urlName: 'Order Hub',
    url: '/orders',
    purpose:
      'Place purchase orders to vendors from the item catalog. Ordering records a COMMITMENT (money you have ' +
      'promised to spend), not a cost — the cost lands later, in Purchasing, when the invoice is approved/paid.',
    workflow: [
      'Pick the location. Browse the catalog by category or vendor, or search by name; items below PAR are flagged.',
      'Set a quantity on each item you need (this fills the cart).',
      'Place the order. This creates an Order (status "Submitted") and auto-creates a matching invoice (status "Pending", GL 12000) in Purchasing.',
      'The order value posts to "ap_pending" for the budget burndown — it does NOT hit COGS yet.',
    ],
    uploads: [
      {
        name: 'Import catalog (vendor catalog)',
        note: 'Loads a vendor product list into the catalog via the import modal. This is the product list, not counts and not invoices.',
        columns: [],
      },
    ],
    gotchas: [
      'An Order Hub "Pending" order is a COMMITMENT — goods not received. It is intentionally NOT counted as a cost. It becomes a cost only when you approve/pay its invoice in Purchasing. (Purchasing "Pending" means the opposite — see the Purchasing tab.)',
      'Placing an order auto-creates the invoice for you. Do not also hand-create an invoice for the same order in Purchasing, or it double-counts.',
      'Your catalog and PAR levels come from the item list the unit manager uploads (see "Start here"). Items below their PAR are flagged so you know what to reorder.',
    ],
    troy: [],
  },

  // ── 3. Weekly Sales ────────────────────────────────────────────────────────
  {
    id: 'sales',
    navLabel: 'Weekly Sales',
    urlName: 'Weekly Sales',
    url: '/sales',
    purpose:
      'Get the week’s sales into the P&L — you do NOT hand-key them. Import the two Fooda Tableau reports ' +
      '(café sales #2 and catering #3 in "Reports to pull") and Aurelia fills in GFS and Revenue, then a director signs off.',
    workflow: [
      'Pick the location; the week comes from the period selector.',
      'Click Import Events and select BOTH reports together — café sales and catering. Aurelia routes the revenue automatically.',
      'Preview the summary, then Confirm & Post to P&L.',
      '(Optional) Hand-key a day by category if you ever need to — but the import is the normal path.',
      'Submit for approval; a director approves ("approved"), which LOCKS the week. "Rejected"/"reopened" makes it editable again.',
    ],
    uploads: [
      {
        name: 'Import Events — upload BOTH Tableau reports together',
        note:
          'Select both files at once. Aurelia auto-detects each and routes revenue: anything under 11 Dining ' +
          '(Cafeteria/Barista) → Retail; every other vendor → Popup. Preview, then Confirm & Post to P&L. See ' +
          '"Reports to pull" #2 and #3 for how to pull each one.',
        columns: [
          { col: 'Vendor/Partner Financials - Popup Event Summary', desc: '→ café sales: popup + retail revenue (#2)' },
          { col: 'Event Restaurant Details - Event Summary - Catering', desc: '→ catering revenue (#3)' },
        ],
      },
    ],
    gotchas: [
      'Upload BOTH reports — catering comes from one file, popup + retail from the other. Missing one means that stream reads zero.',
      'Once a director approves the week, it is locked. Get a director to reopen it before re-importing or editing.',
    ],
    troy: [],
  },

  // ── 4. Inventory ───────────────────────────────────────────────────────────
  {
    id: 'inventory',
    navLabel: 'Inventory',
    urlName: 'Inventory',
    url: '/inventory',
    purpose:
      'Count on-hand inventory for the week. The counted value drives COGS (opening + purchases − closing) on the P&L. ' +
      'This is also where you FIRST load your item list (see "Start here").',
    workflow: [
      'Pick a location ("Select a location to begin counting").',
      'Load the item list once with the amber "Item list" button (the whole OneDrive workbook — Aurelia reads INVItems).',
      'For each item, enter the count: cases in the first box, loose units in the "eaches" box.',
      'Counts autosave; use Save, or Save & Close Period when the week’s count is final.',
    ],
    uploads: [
      {
        name: 'Item list (amber button) — item DEFINITIONS only',
        note:
          'Builds this location’s catalog: names, vendors, pack sizes, prices, GL, category. It does NOT import counts. ' +
          'Upload the whole workbook — Aurelia finds the INVItems tab and tells you which sheet it used. If the file has a ' +
          'counts-looking column (qty/quantity/count/on hand/cases/units) it warns you that the column will be IGNORED. ' +
          'Columns it reads:',
        columns: [
          { col: 'Description / Item / Name', desc: 'item name' },
          { col: 'Pack Size', desc: 'case/unit size' },
          { col: 'Pack Price', desc: 'price per case' },
          { col: 'Cost Per Unit', desc: 'each cost' },
          { col: 'Qty Per Pack', desc: 'units per case' },
          { col: 'Vendor', desc: 'supplier' },
          { col: 'GL Code', desc: 'accounting code' },
          { col: 'Selling Price', desc: 'retail price' },
        ],
      },
      {
        name: 'Upload counts (green button) — actual COUNTS',
        note:
          'Imports counted quantities for this period, matched to items by name, and always shows a preview (naming the ' +
          'sheet it read) before writing. Columns (matched case-insensitively):',
        columns: [
          { col: 'item / name / description / item name / product', desc: 'the item name to match' },
          { col: 'cases / qty / quantity / count', desc: 'number of cases' },
          { col: 'eaches / units / loose / each', desc: 'loose units' },
        ],
      },
    ],
    gotchas: [
      'Item list ≠ Upload counts. The amber "Item list" button only defines what items exist; the green "Upload counts" button enters how many you have. Uploading counts into the item-list button does nothing to your counts (and it warns you).',
      'Eaches-only counts DO count. An item with loose units but zero full cases still contributes to inventory value — you do not have to put anything in the cases box for it to count.',
      'A count upload previews first: it shows how many rows will be counted, how many will not match an item (fix the name or add it to the catalog), and how many had an item but no count value (skipped).',
    ],
    troy: [],
  },

  // ── 5. Shrinkage / Waste ───────────────────────────────────────────────────
  {
    id: 'waste',
    navLabel: 'Shrinkage',
    urlName: 'Waste Log',
    url: '/waste',
    purpose:
      'Not fully set up yet. The Waste Log works — log discards as they happen. The full shrinkage calculation is not ' +
      'built, so do not rely on the shrinkage number until it is.',
    workflow: [
      'Waste Log (ready): click "+ Log waste", pick a category (landfill / compost / recycle / donate), enter item, qty, unit and reason. Log discards as they happen.',
      'Shrinkage (not ready): the Opening + Purchased − Sold − Closing calculation needs a sales-item feed matched to your ' +
        'inventory by name, which is not built yet. Treat the shrinkage number as not-yet-reliable.',
    ],
    uploads: [],
    gotchas: [
      'The full shrinkage number is not trustworthy yet — the sales-to-inventory match it depends on isn’t built. Use the Waste Log in the meantime; don’t make decisions off the shrinkage figure.',
    ],
    troy: [],
  },

  // ── 6. Purchasing ──────────────────────────────────────────────────────────
  {
    id: 'purchasing',
    navLabel: 'Purchasing',
    urlName: 'Purchasing',
    url: '/purchasing',
    purpose:
      'The accounts-payable tab: enter vendor invoices, approve them, and mark them paid. This is the single source ' +
      'of truth for purchase costs — approving/paying an invoice is what books it into COGS. (The NetSuite custom-purchases ' +
      'feed #4 and the running-purchases log #7 in "Reports to pull" are the eventual bulk inputs here — not wired yet.)',
    workflow: [
      'Add an invoice — by hand, by dropping a PDF (AI reads it), or by CSV import.',
      'Approve the invoice (Pending → Approved). Approval books the cost into the period.',
      'Mark it paid (Approved → Paid). Statuses: Pending, Approved, Paid, Overdue, Disputed, Void (plus "Needs GL Review" for low-confidence PDF parses).',
    ],
    uploads: [
      {
        name: 'PDF drop (AI extract)',
        note:
          'Drop a vendor invoice PDF and Claude reads it — pulling vendor, invoice #, dates, GL code and line items. ' +
          'If it is unsure of the GL code, the invoice lands as "Needs GL Review" for you to confirm.',
        columns: [],
      },
      {
        name: 'CSV / XLSX import',
        note: 'Columns the importer reads (first name is preferred, alternates in parentheses):',
        columns: [
          { col: 'Amount (Total)', desc: 'invoice amount — rows with no amount are skipped' },
          { col: 'Vendor', desc: 'vendor name' },
          { col: 'Invoice #', desc: 'invoice number' },
          { col: 'GL Code', desc: 'accounting code (see GL routing below)' },
          { col: 'Date', desc: 'invoice date' },
          { col: 'Due Date', desc: 'payment due date' },
          { col: 'Paid / Status / Location / Notes', desc: 'optional' },
        ],
      },
    ],
    gotchas: [
      'Purchasing "Pending" = a RECEIVED cost that accrues into COGS — the OPPOSITE of an Order Hub "Pending", which is a not-yet-received commitment. Same word, opposite meaning.',
      'Default vendor GL codes: food vendors (Sysco, Nassau, Vistar, Amazon, Webstaurant, Blue Cart, RTZN) → 12000; coffee/barista vendors (Café Moto, David Rio, Don Edwards) → 12002.',
      'Amazon defaults to 12000 (Inventory–Cafeteria). When a specific Amazon order is really chemicals or paper, override that invoice to the chem (65070) or paper (65080) GL code so it lands on the right line.',
    ],
    extra: [
      {
        h: 'Where each GL code lands on the P&L (the food/chem/paper split)',
        body:
          'The GL code on an invoice decides which P&L line it feeds — this is the food/chem/paper split working:\n' +
          '• 12000–12003 (inventory: cafeteria/barista) → cogs_purchases, which rolls into COGS.\n' +
          '• 65070 (cleaning / chemicals) → its own Cleaning line, with its own budget — not lumped into purchases.\n' +
          '• 65080 (paper / consumables / packaging) → its own Paper line.\n' +
          'Other coded lines route the same way to their own P&L line (50430 equipment, 50431 barista equipment & ' +
          'consumables, 50440 supplies, 50450 maintenance, 65050 uniforms). Anything without a mapped code flattens ' +
          'into cogs_purchases. So coding an invoice correctly is what makes cleaning and paper show up as their own ' +
          'lines instead of hiding inside food purchases. NetSuite delivers the GL as a combined string ' +
          '("12000 - Inventory - Cafeteria") — Aurelia reads the numeric code off the front.',
      },
    ],
    troy: [],
  },

  // ── 7. Budgets ─────────────────────────────────────────────────────────────
  {
    id: 'budgets',
    navLabel: 'Budgets',
    urlName: 'Budgets',
    url: '/budgets',
    purpose:
      'Hold the annual budget by month and line item, then submit it for approval. Your director sends you the budget ' +
      'workbook (2026_Fooda_Cafe_Budgets_Live.xlsm). Upload it in Budgets — Aurelia reads the Budget_Load sheet and maps ' +
      'each line to its P&L destination. If a line can’t be matched, the preview warns you before importing; it never ' +
      'silently drops. Once a director approves, the budget posts to the P&L as the Budget column (broken out per week).',
    workflow: [
      'Your director sends you the budget workbook (2026_Fooda_Cafe_Budgets_Live.xlsm) — upload it in Budgets.',
      'Aurelia reads the Budget_Load sheet and maps each line to its P&L destination. The preview warns you about any line ' +
        'it couldn’t match BEFORE you import — it never silently drops a line.',
      'Confirm the import, then submit for approval. A director approves, which posts the budget to the P&L and locks it. ' +
        'A manager can request an unlock with a reason.',
    ],
    uploads: [
      {
        name: 'Budget workbook (2026_Fooda_Cafe_Budgets_Live.xlsm) / template (.xlsx / .csv)',
        note: 'One row per line item, one column per month. Columns:',
        columns: [
          { col: 'Line Item', desc: 'the P&L line (first column)' },
          { col: 'Jan … Dec', desc: 'one column per month (also accepts date cells for the budget year)' },
        ],
      },
    ],
    extra: [
      {
        h: 'The 24 budget lines (with GL codes), from 2026_Fooda_Cafe_Budgets_Live.xlsm',
        body:
          'Popup GFS (99999)\nCatering GFS (88888)\nDelivery GFS (77777)\nRetail GFS (66666)\nPantry GFS (-33333)\n' +
          'Popup Revenue (40042)\nCatering Revenue (40200)\nRetail Revenue (40160)\nTotal Fees & Subsidies (40080)\n' +
          'Onsite Labor (50410)\nOnsite equipment and consumables (50430)\nOnsite Maintenance and Other (50450)\n' +
          'Payment Processing Fees (61020)\nRevenue Share (40050)\nRetail COGS (50160)\n' +
          'Total Compensation and Benefits (68016)\nOffice Supplies & Equipment (65090)\nBank fees (61010)\n' +
          'Advertising and Marketing (62010)\nTechnology Services (63010)\nTravel and Entertainment (64120)\n' +
          'Professional Fees (66010)\nFacilities (67200)\nTotal other expenses (50460)',
      },
    ],
    gotchas: [
      'The budget only shows on the Dashboard after a director approves it — a submitted-but-unapproved budget will not appear as the budget column.',
      'If a budget line can’t be matched to a P&L line, the import preview lists it and skips it — it is never written to a dead field. Fix the label in the workbook if something you expected shows up in that list.',
    ],
    troy: [],
  },

  // ── 8. Operating Ledger / Transfers ────────────────────────────────────────
  {
    id: 'transfers',
    navLabel: 'Operating Ledger',
    urlName: 'Transfers',
    url: '/transfers',
    purpose:
      'Two jobs. Transfers: move inventory between locations — most common at multi-café units. Journal Entries: GL ' +
      'adjustments and amortization (built, but not yet part of the routine).',
    workflow: [
      'Transfers: move inventory between locations — most common at multi-café units (e.g. Qualcomm, where several ' +
        'cafés run under one account). If one café pulls product from a sibling, log a transfer so both sides’ value ' +
        'adjusts. Create → approve → receive.',
      'Journal Entries: GL adjustments and amortization. Built, and eventually everyone — managers and finance — will ' +
        'post here. Not yet part of the routine; check with your director before using it.',
    ],
    uploads: [
      {
        name: 'Bulk transfers import (Excel)',
        note: 'Optional — import multiple transfers at once instead of logging them one by one.',
        columns: [],
      },
    ],
    gotchas: [
      'A transfer only adjusts inventory when it reaches "Received" — a Pending or Approved transfer has not moved anything yet.',
    ],
    troy: [],
  },

  // ── 9. Labor ───────────────────────────────────────────────────────────────
  {
    id: 'labor',
    navLabel: 'Labor',
    urlName: 'Labor',
    url: '/labor',
    purpose:
      'Get the week’s labor onto the P&L. The source is the Tableau "Café Labor Efficiency Tracking" export ' +
      '(report #1 in "Reports to pull") — HOURLY labor by week. Manager salaries are entered separately in Setup.',
    workflow: [
      'Pick the location; the week comes from the period selector.',
      'Pull report #1 (Café Labor Efficiency Tracking → Summary by Site, "Last 8 weeks") and upload it here — or type amounts into the GL table by hand.',
      'Amounts autosave; submit for approval (status "pending").',
      'A director approves ("Approve & Close Period"), which signs off and locks the week.',
    ],
    uploads: [
      {
        name: 'Labor import — Café Labor Efficiency Tracking export (#1)',
        note: 'Weekly hourly labor by site. Columns in the export:',
        columns: [
          { col: 'Site Name', desc: 'must match your site' },
          { col: 'Week of Event', desc: 'the labor week' },
          { col: 'Actual Labor $', desc: 'actual hourly labor dollars' },
          { col: 'Actual Labor as % of GFS', desc: 'labor efficiency' },
        ],
      },
    ],
    gotchas: [
      'HOURLY labor only. Manager salaries are entered separately in Setup — don’t expect them in this report.',
      'The labor GL family (for hand entry / coding): 50410 Onsite Labor, 50411 401k, 50412 Benefits, 50413 Payroll Taxes, 50414 Bonus — all roll up as Onsite Labor. 50420 is 3rd-Party Labor, broken out on its own. 68xxx codes are Comp & Benefits.',
    ],
    troy: [],
  },
]

export const FAQ = [
  {
    q: 'What do I do first?',
    a: 'Upload your item list (see "Start here"). Then pull the six reports — the "Reports to pull" table is the cheat-sheet.',
  },
  {
    q: 'Which reports do I actually pull each week?',
    a: 'Labor, café sales, catering, and custom purchases — weekly. The Enterprise P&L and occupancy are month-end (the Enterprise P&L isn’t available until the 20th of the following month).',
  },
  {
    q: 'Do I have to hand-key sales?',
    a: 'No. Use Import Events and upload both Tableau reports together — "Vendor/Partner Financials - Popup Event Summary" (café) and "Event Restaurant Details - Event Summary - Catering". Aurelia posts the revenue for you.',
  },
  {
    q: 'Where do I pull the labor report, and why is my manager salary missing?',
    a: 'Tableau → "Café Labor Efficiency Tracking" → "Summary by Site", Week = "Last 8 weeks". It’s HOURLY labor only by design; manager salaries are entered separately in Setup.',
  },
  {
    q: 'Why can’t I upload my custom purchases / enterprise P&L / occupancy yet?',
    a: 'Those aren’t wired into Aurelia yet — the retrieval steps are documented as the spec so you can pull them on cadence now. Custom purchases come from NetSuite; the Enterprise P&L is the official month-end number.',
  },
  {
    q: 'What’s the difference between custom purchases and running purchases?',
    a: 'Custom purchases (#4) are invoiced through Ramp and pulled from NetSuite. Running purchases (#7) are personal-card / reimbursement buys (Amazon, Webstaurant) that never become invoices — you log those by hand.',
  },
  {
    q: 'Do I enter food / chem / paper totals separately?',
    a: 'No. Code the GL and it lands on the right line automatically: 12000–12003 → purchases/COGS, 65070 → Cleaning, 65080 → Paper. NetSuite’s combined GL string ("12000 - Inventory - Cafeteria") is fine — Aurelia reads the number off the front.',
  },
  {
    q: 'What’s the difference between the two Inventory upload buttons?',
    a: 'Amber "Item list" = definitions, no counts. Green "Upload counts" = counts, previewed before they’re written.',
  },
  {
    q: 'Why isn’t my Order Hub order showing as a cost?',
    a: 'It’s a commitment, not a cost. It hits COGS when the invoice is approved/paid in Purchasing.',
  },
  {
    q: 'I closed a period by mistake.',
    a: 'Only a director/admin can reopen it. Ask one to hit the 🔓 Reopen button on the top bar.',
  },
]
