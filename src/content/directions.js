/**
 * directions.js — ALL copy for the Help & Directions page (/directions).
 *
 * This is the ONLY file to edit to change the Help page. src/routes/Directions.jsx
 * is a dumb renderer that maps over this data — do not put copy in the JSX.
 *
 * Conventions:
 *   - `[TROY: ...]` markers are process questions only Troy can answer. As of this
 *     revision they are all filled in — if you add a new one, the renderer will
 *     highlight it as a visible callout so it doesn't get buried.
 *   - `workflow` is an ordered list (rendered 1., 2., 3.).
 *   - `uploads[].columns` are the EXACT header / report names Aurelia looks for.
 *   - `gotchas` are the sharp edges we've hit; keep them blunt and specific.
 */

export const INTRO = {
  heading: 'How Aurelia works',
  lede:
    'Aurelia is the operations suite for running a cafe P&L: enter what happened this week ' +
    '(sales, counts, invoices, labor), and the Dashboard assembles it into an income statement. ' +
    'This page explains each tab — what it is for, the main workflow, what files it accepts (with the ' +
    'exact report/column names), and the traps we have already hit.',
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
    {
      h: 'Submit → Approve locks the week (Sales & Labor)',
      body:
        'Weekly Sales and Labor use a submit/approve flow. A manager submits (status "pending"); a director ' +
        'approves (status "approved") which locks that week. "Rejected" or "reopened" puts it back to editable.',
    },
  ],
}

// Prominent, rendered ABOVE the per-tab sections — the first thing a new manager does.
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
      'Get the week’s sales into the P&L — you do NOT have to hand-key them. Import the two Fooda reports and ' +
      'Aurelia fills in Gross Food Sales and Revenue for you, then a director signs off.',
    workflow: [
      'Pick the location; the week comes from the period selector.',
      'Click Import Events and select BOTH Fooda reports together (see below). Aurelia routes the revenue automatically.',
      'Preview the summary, then Confirm & Post to P&L.',
      '(Optional) Hand-key a day by category if you ever need to — but the import is the normal path.',
      'Submit for approval; a director approves ("approved"), which LOCKS the week. "Rejected"/"reopened" makes it editable again.',
    ],
    uploads: [
      {
        name: 'Import Events — upload BOTH Fooda reports together',
        note:
          'Click Import Events and select both files at once. Aurelia auto-detects each and routes revenue: anything ' +
          'under 11 Dining (Cafeteria/Barista) → Retail; every other vendor → Popup. Preview, then Confirm & Post to P&L.',
        columns: [
          { col: 'Event Line Items - Catering', desc: '→ catering revenue' },
          { col: 'Vendor_Partner Financials - Popup Event Summary', desc: '→ popup + retail revenue' },
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
      'of truth for purchase costs — approving/paying an invoice is what books it into COGS.',
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
          'lines instead of hiding inside food purchases.',
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
      'Enter the week’s labor cost by GL code and submit it for sign-off. Feeds Onsite Labor, 3rd-Party Labor and ' +
      'Comp & Benefits on the P&L.',
    workflow: [
      'Pick the location; the week comes from the period selector.',
      'Import the labor file — California Labor.xlsx — or type amounts into the GL table by hand.',
      'Amounts autosave; submit for approval (status "pending").',
      'A director approves ("Approve & Close Period"), which signs off and locks the week.',
    ],
    uploads: [
      {
        name: 'GL labor import — California Labor.xlsx (Excel / CSV)',
        note: 'Standard or "Mosaic" layouts are auto-detected; Aurelia prefers a labor/payroll sheet in the workbook. Columns:',
        columns: [
          { col: 'GL Code (GL / Account)', desc: 'the labor GL code' },
          { col: 'Amount (Value)', desc: 'the amount for that code' },
          { col: 'Mosaic layout', desc: 'a first cell like "50410 - Onsite Labor…" is also parsed' },
        ],
      },
    ],
    gotchas: [
      'The labor GL family: 50410 Onsite Labor, 50411 401k, 50412 Benefits, 50413 Payroll Taxes, 50414 Bonus — all roll up as Onsite Labor. 50420 is 3rd-Party Labor and is broken out on its own. 68xxx codes are Comp & Benefits.',
      'Rule of thumb: Onsite Labor = every 504xx code EXCEPT 50420. Do not let a food invoice get coded to 50412/50413/50414 — those are labor benefit codes, not food.',
    ],
    troy: [],
  },
]

export const FAQ = [
  {
    q: 'What do I do first?',
    a: 'Upload your item list. Nothing works before that — counting, ordering, valuation and invoicing all key off your location’s catalog. See "Start here".',
  },
  {
    q: 'Do I have to hand-key sales?',
    a: 'No. Use Import Events and upload both Fooda reports (Event Line Items - Catering, and Vendor_Partner Financials - Popup Event Summary). Aurelia posts the revenue for you.',
  },
  {
    q: 'How do I upload invoices?',
    a: 'Drag the PDF in — Aurelia reads vendor, dates, amounts and GL code. You can also import a CSV, or enter one by hand.',
  },
  {
    q: 'Do I enter food / chem / paper totals separately?',
    a: 'No. Code the GL and it lands on the right line automatically: 12000–12003 → purchases/COGS, 65070 → Cleaning, 65080 → Paper.',
  },
  {
    q: 'What’s the difference between the two Inventory upload buttons?',
    a: 'Amber "Item list" = definitions, no counts. Green "Upload counts" = counts, previewed before they’re written.',
  },
  {
    q: 'Why isn’t my item counted when I only entered units?',
    a: 'It is now — eaches-only counts register. An item with loose units but no full cases still counts toward value.',
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
