/**
 * directions.js — ALL copy for the Help & Directions page (/directions).
 *
 * This is the ONLY file to edit to change the Help page. src/routes/Directions.jsx
 * is a dumb renderer that maps over this data — do not put copy in the JSX.
 *
 * Conventions:
 *   - Anywhere the answer depends on Fooda PROCESS rather than the code (which
 *     report to download, which vendor, a chart-of-accounts question), write it
 *     inline as `[TROY: ...]`. The renderer highlights those as a visible callout
 *     so gaps are obvious, not buried. You can also put process gaps in a tab's
 *     `troy: [...]` array to render them as standalone callouts.
 *   - `workflow` is an ordered list (rendered 1., 2., 3.).
 *   - `uploads[].columns` are the EXACT header names the parser looks for. Keep
 *     them exact — they are matched against the spreadsheet you upload.
 *   - `gotchas` are the sharp edges we've hit; keep them blunt and specific.
 */

export const INTRO = {
  heading: 'How Aurelia works',
  lede:
    'Aurelia is the operations suite for running a cafe P&L: enter what happened this week ' +
    '(sales, counts, invoices, labor), and the Dashboard assembles it into an income statement. ' +
    'This page explains each tab — what it is for, the main workflow, what files it accepts (with the ' +
    'exact column names), and the traps we have already hit.',
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
        'revenue, Inventory feeds COGS, Purchasing feeds purchases, Labor feeds labor, Shrinkage feeds ' +
        'shrinkage, Budgets feeds the budget column. Fix a number on its source tab and the Dashboard follows.',
    },
    {
      h: 'Submit → Approve locks the week (Sales & Labor)',
      body:
        'Weekly Sales and Labor use a submit/approve flow. A manager submits (status "pending"); a director ' +
        'approves (status "approved") which locks that week. "Rejected" or "reopened" puts it back to editable.',
    },
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
    ],
    troy: [
      '[TROY: Is the prime-cost target (labor + COGS ÷ revenue ≤ 60%) and the "pace forecast" a Fooda-official benchmark, or just a UI default we picked?]',
    ],
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
    ],
    troy: [
      '[TROY: Where does the item catalog / order guide / PAR levels come from — who maintains them, and how does a new item get added?]',
    ],
  },

  // ── 3. Weekly Sales ────────────────────────────────────────────────────────
  {
    id: 'sales',
    navLabel: 'Weekly Sales',
    urlName: 'Weekly Sales',
    url: '/sales',
    purpose:
      'Enter or import the week’s sales by category (Popup, Catering, Retail), then submit them for director ' +
      'sign-off. Feeds Gross Food Sales and Revenue on the P&L.',
    workflow: [
      'Pick the location; the week comes from the period selector.',
      'Enter sales per operating day by category (Popup / Catering / Retail) — or import a Fooda export (below).',
      'Entries autosave as a draft while you work.',
      'Submit for approval (status becomes "pending").',
      'A director approves (status "approved") — this signs off and LOCKS the week. "Rejected"/"reopened" makes it editable again.',
    ],
    uploads: [
      {
        name: 'Popup / retail Fooda export',
        note: 'Auto-detected on upload. Required columns:',
        columns: [
          { col: 'Event Date', desc: 'the sales date (also accepts "event_date" / "Date")' },
          { col: 'Gross Food Sales', desc: 'the day’s gross food sales' },
          { col: 'Restaurant Internal Name / Partner Internal Name', desc: 'used to tell retail from popup' },
        ],
      },
      {
        name: 'Catering line-item export',
        note: 'Auto-detected when the file has an "Event accounting site" column. Required columns:',
        columns: [
          { col: 'Event date', desc: 'the event date' },
          { col: 'Total Price', desc: 'the catering total (also accepts "Gross Food Sales")' },
          { col: 'Entity name', desc: 'the site/entity the event belongs to' },
        ],
      },
    ],
    gotchas: [
      'Once a director approves the week, it is locked. Get a director to reopen it before re-uploading or editing.',
      'The importer keys off the exact column names above; a renamed header will silently skip rows.',
    ],
    troy: [
      '[TROY: Exactly which Fooda / Tableau report does a manager download for (a) popup/retail and (b) catering, and where do they get it? Name the report and the menu path.]',
    ],
  },

  // ── 4. Inventory ───────────────────────────────────────────────────────────
  {
    id: 'inventory',
    navLabel: 'Inventory',
    urlName: 'Inventory',
    url: '/inventory',
    purpose:
      'Count on-hand inventory for the week. The counted value drives COGS (opening + purchases − closing) on the P&L.',
    workflow: [
      'Pick a location ("Select a location to begin counting").',
      'For each item, enter the count: cases in the first box, loose units in the "eaches" box.',
      'Counts autosave; use Save, or Save & Close Period when the week’s count is final.',
    ],
    uploads: [
      {
        name: 'Item list (amber button) — item DEFINITIONS only',
        note:
          'Builds this location’s catalog: names, vendors, pack sizes, prices, GL, category. It does NOT import counts. ' +
          'If the file has a counts-looking column (qty/quantity/count/on hand/cases/units) it warns you loudly that ' +
          'the column will be IGNORED — enter counts by hand. Columns it reads:',
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
          'Imports counted quantities for this period, matched to items by name, and always shows a preview before ' +
          'writing. Columns (matched case-insensitively):',
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
      'Two jobs on one tab. Shrinkage: measure inventory lost (Opening + Purchased − Sold − Closing) per item and ' +
      'post it to the P&L as cogs_shrinkage. Waste Log: record what you threw out and track diversion (compost/recycle/donate).',
    workflow: [
      'Shrinkage sub-tab: import the POS/register sales file (below). The tab pairs it with opening/closing counts and purchases to compute loss per item and writes cogs_shrinkage.',
      'Waste Log sub-tab: click "+ Log waste", pick a category (landfill / compost / recycle / donate), enter item, qty, unit and reason.',
      'Review the shrinkage table (sorted by dollar loss) and the diversion percentage.',
    ],
    uploads: [
      {
        name: 'POS / register sales import (Shrinkage)',
        note: 'Matched to the catalog by SKU or by name. Columns:',
        columns: [
          { col: 'SKU / sku / Item Code / UPC', desc: 'the product code to match' },
          { col: 'Item / Name / Description', desc: 'item name (fallback match)' },
          { col: 'Qty Sold / Quantity / Units / Count', desc: 'units sold' },
        ],
      },
    ],
    gotchas: [
      'Shrinkage needs both the prior period’s closing count (as this period’s opening) and this period’s closing count — if inventory is not counted, shrinkage cannot be computed.',
    ],
    troy: [
      '[TROY: Which POS/register report is the shrinkage import, and how is it exported?]',
      '[TROY: Is the 70% diversion goal a Fooda target or a placeholder?]',
    ],
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
      'Default vendor GL codes (already set): food vendors (Sysco, Nassau, Vistar, Amazon, Webstaurant, Blue Cart, RTZN) → 12000; coffee/barista vendors (Café Moto, David Rio, Don Edwards) → 12002. Override per invoice when a shipment is really chem or paper.',
    ],
    extra: [
      {
        h: 'Where each GL code lands on the P&L (the food/chem/paper split)',
        body:
          'The GL code on an invoice decides which P&L line it feeds — this is new, and it is the food/chem/paper ' +
          'split working:\n' +
          '• 12000–12003 (inventory: cafeteria/barista) → cogs_purchases, which rolls into COGS.\n' +
          '• 65070 (cleaning / chemicals) → its own Cleaning line, with its own budget — not lumped into purchases.\n' +
          '• 65080 (paper / consumables / packaging) → its own Paper line.\n' +
          'Other coded lines route the same way to their own P&L line (50430 equipment, 50431 barista equipment & ' +
          'consumables, 50440 supplies, 50450 maintenance, 65050 uniforms). Anything without a mapped code flattens ' +
          'into cogs_purchases. So coding an invoice correctly is what makes cleaning and paper show up as their own ' +
          'lines instead of hiding inside food purchases.',
      },
    ],
    troy: [
      '[TROY: Amazon defaults to 12000, but Amazon orders are often a mix (chem + paper + supplies). Should we split a single Amazon invoice across GL codes per line item, or keep coding the whole invoice to one code?]',
    ],
  },

  // ── 7. Budgets ─────────────────────────────────────────────────────────────
  {
    id: 'budgets',
    navLabel: 'Budgets',
    urlName: 'Budgets',
    url: '/budgets',
    purpose:
      'Hold the annual budget by month and line item, then submit it for approval. Once a director approves, it ' +
      'posts to the P&L as the Budget column (broken out per week).',
    workflow: [
      'Download the blank template, or upload a filled one (below).',
      'Enter/adjust the annual numbers per month across the line items.',
      'Submit for approval; a director approves, which posts the budget to the P&L and locks it. A manager can request an unlock with a reason.',
    ],
    uploads: [
      {
        name: 'Budget template (.xlsx / .csv)',
        note: 'One row per line item, one column per month. Columns:',
        columns: [
          { col: 'Line Item', desc: 'the P&L line (first column)' },
          { col: 'Jan … Dec', desc: 'one column per month (also accepts date cells for the budget year)' },
        ],
      },
    ],
    gotchas: [
      'The budget only shows on the Dashboard after a director approves it — a submitted-but-unapproved budget will not appear as the budget column.',
    ],
    troy: [
      '[TROY: Confirm the line-item names in the template match how Fooda labels them, so uploads map cleanly.]',
    ],
  },

  // ── 8. Operating Ledger / Transfers ────────────────────────────────────────
  {
    id: 'transfers',
    navLabel: 'Operating Ledger',
    urlName: 'Transfers',
    url: '/transfers',
    purpose:
      'Two jobs. Transfers: move inventory between locations with an approval trail. Journal Entries: post GL ' +
      'adjustments (costs that are not a normal invoice) to the P&L, optionally spread over time.',
    workflow: [
      'Transfers sub-tab: log a move (item, units, cost, from → to). Status flows Pending → Approved (director) → Received (manager confirms), which adjusts inventory at both locations.',
      'Journal Entries sub-tab: post a GL adjustment (code, description, amount) with an amortization choice — one-time, monthly, quarterly or annual — plus optional auto-reverse or a recurring template.',
    ],
    uploads: [
      {
        name: 'Bulk transfers import (Excel)',
        note: 'Optional — import multiple transfers at once instead of logging them one by one.',
        columns: [],
      },
    ],
    gotchas: [
      'A transfer only adjusts inventory when it reaches "Received" — a Pending or Approved transfer has not moved anything yet. Approved transfers not received within ~2 days get an aging alert.',
    ],
    troy: [
      '[TROY: Give 1–2 real journal entries you actually post (e.g. a monthly cleaning contract, a one-time repair) so the copy can use concrete examples instead of abstractions.]',
    ],
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
      'Import a payroll/GL file (below) or type amounts into the GL table by hand.',
      'Amounts autosave; submit for approval (status "pending").',
      'A director approves ("Approve & Close Period"), which signs off and locks the week.',
    ],
    uploads: [
      {
        name: 'GL labor import (Excel / CSV)',
        note: 'Standard or "Mosaic" layouts are auto-detected. Columns:',
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
    troy: [
      '[TROY: Which payroll / Mosaic report is the labor source file, and where is it exported from?]',
    ],
  },
]

export const FAQ = [
  {
    q: 'I placed an order but it is not showing up as a cost — why?',
    a:
      'Because an Order Hub order is a commitment, not a cost. It only becomes a cost when you approve (or pay) its ' +
      'invoice in the Purchasing tab. Until then it sits in "ap_pending" for the budget burndown.',
  },
  {
    q: 'What is the difference between the two "Pending"s?',
    a:
      'Order Hub "Pending" = you have ordered but not received it (a commitment, not a cost). Purchasing "Pending" = ' +
      'you have received the invoice and it is accruing as a cost. Same word, opposite meaning.',
  },
  {
    q: 'I closed the period by accident — how do I get back in?',
    a:
      'Ask a director or admin to reopen it (the 🔓 Reopen button on the top bar). Managers cannot reopen a closed period.',
  },
  {
    q: 'My inventory count upload skipped some rows — why?',
    a:
      'The preview tells you: rows that did not match an item by name are skipped (fix the name in the file or add ' +
      'the item to the catalog first), and rows that had an item but no count value are skipped. Only matched rows ' +
      'with a count are written.',
  },
  {
    q: 'Item list vs Upload counts — which do I use?',
    a:
      'Use "Item list" (amber) to define WHAT items exist at a location (names, prices, pack sizes). Use "Upload ' +
      'counts" (green) to enter HOW MANY you have this week. Counts uploaded via the item-list button are ignored.',
  },
  {
    q: 'Why is a whole line on the Dashboard zero?',
    a:
      'Either its source tab has not been filled in for this location/period, or you are looking at the wrong ' +
      'location or week in the top bar. The Dashboard only reports; it never holds numbers of its own.',
  },
  // [TROY: add the real questions managers actually ask you here.]
]
