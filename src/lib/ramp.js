// Ramp API Integration
// Handles bill creation, vendor management, and approval routing
// Docs: https://docs.ramp.com/reference
//
// Flow: Aurelia parses invoice → matches to PO → pushes draft bill to Ramp
//       → Ramp routes to Vendor Owner → approved → NetSuite → Aurelia reads back
//
// API key stored in: tenants/{orgId}/config/integrations (field: rampApiKey)
// Set via Settings > Integrations

const RAMP_BASE = 'https://api.ramp.com/developer/v1'

// ── Config ──────────────────────────────────────────────────
let _apiKey = null

export async function loadRampConfig(db, orgId) {
  const { doc, getDoc } = await import('firebase/firestore')
  const snap = await getDoc(doc(db, 'tenants', orgId, 'config', 'integrations'))
  const data = snap.exists() ? snap.data() : {}
  _apiKey = data.rampApiKey || null
  return { connected: !!_apiKey }
}

function headers() {
  if (!_apiKey) throw new Error('Ramp API key not configured. Go to Settings > Integrations.')
  return {
    'Authorization': 'Bearer ' + _apiKey,
    'Content-Type': 'application/json',
  }
}

async function rampFetch(path, options = {}) {
  const resp = await fetch(RAMP_BASE + path, {
    ...options,
    headers: { ...headers(), ...(options.headers || {}) },
  })
  if (!resp.ok) {
    const body = await resp.text().catch(() => '')
    throw new Error('Ramp API ' + resp.status + ': ' + body.slice(0, 200))
  }
  return resp.json()
}

// ── Vendors ──────────────────────────────────────────────────
// List vendors from Ramp — used for matching invoices to vendor owners
export async function listVendors() {
  return rampFetch('/vendors')
}

export async function getVendor(vendorId) {
  return rampFetch('/vendors/' + vendorId)
}

// ── Bills ──────────────────────────────────────────────────
// Create a draft bill in Ramp from a parsed invoice
// Ramp's Vendor Owner routing auto-assigns the approver
export async function createBill(billData) {
  return rampFetch('/bills', {
    method: 'POST',
    body: JSON.stringify(billData),
  })
}

// Build a Ramp bill payload from an Aurelia invoice + PO match
export function buildBillPayload(invoice, poMatch, locationConfig) {
  return {
    vendor_id: locationConfig?.rampVendorId || null,
    vendor_name: invoice.vendor,
    invoice_number: invoice.invoiceNumber,
    invoice_date: invoice.invoiceDate,
    due_date: invoice.dueDate || invoice.invoiceDate,
    amount: {
      amount: Math.round(invoice.amount * 100), // Ramp uses cents
      currency_code: 'USD',
    },
    memo: poMatch
      ? 'PO #' + poMatch.poNumber + ' | ' + (invoice.location || '')
      : invoice.location || '',
    line_items: (invoice.lineItems || []).map(function(item) {
      return {
        description: item.description || item.name,
        amount: {
          amount: Math.round((item.total || item.amount || 0) * 100),
          currency_code: 'USD',
        },
        accounting_category_id: item.glCode || null,
      }
    }),
    // PO reference for Ramp's PO matching
    purchase_order_number: poMatch?.poNumber || null,
  }
}

// List bills from Ramp — used for reconciliation
export async function listBills(params = {}) {
  const query = Object.entries(params)
    .map(function(entry) { return entry[0] + '=' + encodeURIComponent(entry[1]); })
    .join('&')
  return rampFetch('/bills' + (query ? '?' + query : ''))
}

export async function getBill(billId) {
  return rampFetch('/bills/' + billId)
}

// ── Vendor-Location Mapping ──────────────────────────────────
// Maps each location's distributors to Ramp vendor IDs
// Stored in: tenants/{orgId}/config/rampVendorMap
// Shape: { "Qualcomm SD": { "Sysco": "ramp_vendor_123", "Vistar": "ramp_vendor_456" } }

export async function loadVendorMap(db, orgId) {
  const { doc, getDoc } = await import('firebase/firestore')
  const snap = await getDoc(doc(db, 'tenants', orgId, 'config', 'rampVendorMap'))
  return snap.exists() ? snap.data() : {}
}

export async function saveVendorMap(db, orgId, vendorMap) {
  const { doc, setDoc } = await import('firebase/firestore')
  await setDoc(doc(db, 'tenants', orgId, 'config', 'rampVendorMap'), vendorMap)
}

// ── Full Pipeline ──────────────────────────────────────────
// End-to-end: parse invoice → match PO → push to Ramp
export async function pushInvoiceToRamp(db, orgId, invoice, poMatch) {
  // Load vendor map to find Ramp vendor ID
  const vendorMap = await loadVendorMap(db, orgId)
  const locationVendors = vendorMap[invoice.location] || {}
  const rampVendorId = locationVendors[invoice.vendor] || null

  const payload = buildBillPayload(invoice, poMatch, { rampVendorId })

  // Create bill in Ramp
  const result = await createBill(payload)

  // Log the sync to Firestore for audit trail
  const { doc, setDoc, serverTimestamp } = await import('firebase/firestore')
  await setDoc(doc(db, 'tenants', orgId, 'rampSync', result.id || invoice.invoiceNumber), {
    rampBillId: result.id,
    invoiceId: invoice.id,
    poNumber: poMatch?.poNumber || null,
    vendor: invoice.vendor,
    amount: invoice.amount,
    location: invoice.location,
    status: 'synced',
    syncedAt: serverTimestamp(),
  })

  return result
}

// ── Reconciliation ──────────────────────────────────────────
// Compare Ramp bills against Aurelia invoices to find mismatches
export async function reconcile(db, orgId, periodKey) {
  const { collection, getDocs, query, where } = await import('firebase/firestore')

  // Load Aurelia invoices for this period
  const invSnap = await getDocs(
    query(collection(db, 'tenants', orgId, 'invoices'), where('periodKey', '==', periodKey))
  )
  const aureliaInvoices = invSnap.docs.map(function(d) { return { id: d.id, ...d.data() }; })

  // Load Ramp sync records
  const syncSnap = await getDocs(collection(db, 'tenants', orgId, 'rampSync'))
  const synced = new Set(syncSnap.docs.map(function(d) { return d.data().invoiceId; }))

  // Find unsynced invoices
  const unsynced = aureliaInvoices.filter(function(inv) { return !synced.has(inv.id); })

  return {
    total: aureliaInvoices.length,
    synced: synced.size,
    unsynced: unsynced,
    unsyncedAmount: unsynced.reduce(function(s, i) { return s + (i.amount || 0); }, 0),
  }
}
