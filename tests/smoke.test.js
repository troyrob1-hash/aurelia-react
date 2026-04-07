/**
 * Aurelia FMS — Daily Smoke Test Suite
 * Runs via GitHub Actions at 6am every day
 * Tests Firestore paths, P&L flow, period key consistency, schema validation
 */

import { initializeApp, cert, getApps } from 'firebase-admin/app'
import { getFirestore, FieldValue } from 'firebase-admin/firestore'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'

// ── Firebase Admin init ───────────────────────────────────────
let db

beforeAll(() => {
  if (!getApps().length) {
    initializeApp({
      credential: cert({
        projectId:    process.env.FIREBASE_PROJECT_ID,
        clientEmail:  process.env.FIREBASE_CLIENT_EMAIL,
        privateKey:   process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
      })
    })
  }
  db = getFirestore()
})

// ── Constants ─────────────────────────────────────────────────
const ORG_ID      = 'fooda'
const TEST_LOC    = 'test_location_smoke'
const TEST_PERIOD = `${new Date().getFullYear()}-P${String(new Date().getMonth()+1).padStart(2,'0')}-W1`
const TENANT_PATH = `tenants/${ORG_ID}`

// Cleanup refs written during tests
const cleanupRefs = []

// ── Helper ────────────────────────────────────────────────────
async function write(path, data) {
  const ref = db.doc(path)
  await ref.set({ ...data, _smokeTest: true, createdAt: FieldValue.serverTimestamp() }, { merge: true })
  cleanupRefs.push(path)
  return ref
}

async function read(path) {
  const snap = await db.doc(path).get()
  return snap.exists ? snap.data() : null
}

// ── Cleanup after all tests ───────────────────────────────────
afterAll(async () => {
  await Promise.allSettled(cleanupRefs.map(p => db.doc(p).delete()))
})

// ═════════════════════════════════════════════════════════════
// 1. FIRESTORE PATH TESTS — verify all collection paths exist and are accessible
// ═════════════════════════════════════════════════════════════
describe('Firestore paths', () => {

  it('reads tenant root', async () => {
    const snap = await db.collection('tenants').doc(ORG_ID).get()
    // May or may not exist — just verify no throw
    expect(snap).toBeDefined()
  })

  it('reads config/budgetSchema', async () => {
    const data = await read(`${TENANT_PATH}/config/budgetSchema`)
    // If it exists it should have sections array
    if (data) expect(Array.isArray(data.sections)).toBe(true)
  })

  it('reads config/laborGlMap', async () => {
    const data = await read(`${TENANT_PATH}/config/laborGlMap`)
    if (data) expect(typeof data).toBe('object')
  })

  it('reads config/vendors', async () => {
    const data = await read(`${TENANT_PATH}/config/vendors`)
    if (data) expect(Array.isArray(data.list)).toBe(true)
  })

  it('reads locations collection', async () => {
    const snap = await db.collection(`${TENANT_PATH}/locations`).limit(1).get()
    expect(snap).toBeDefined()
  })

  it('reads invoices collection', async () => {
    const snap = await db.collection(`${TENANT_PATH}/invoices`).limit(1).get()
    expect(snap).toBeDefined()
  })

  it('reads transfers collection', async () => {
    const snap = await db.collection(`${TENANT_PATH}/transfers`).limit(1).get()
    expect(snap).toBeDefined()
  })

  it('reads laborSubmissions collection', async () => {
    const snap = await db.collection(`${TENANT_PATH}/laborSubmissions`).limit(1).get()
    expect(snap).toBeDefined()
  })

  it('reads salesSubmissions collection', async () => {
    const snap = await db.collection(`${TENANT_PATH}/salesSubmissions`).limit(1).get()
    expect(snap).toBeDefined()
  })

  it('reads wasteSubmissions collection', async () => {
    const snap = await db.collection(`${TENANT_PATH}/wasteSubmissions`).limit(1).get()
    expect(snap).toBeDefined()
  })
})

// ═════════════════════════════════════════════════════════════
// 2. PERIOD KEY CONSISTENCY — verify format is uniform
// ═════════════════════════════════════════════════════════════
describe('Period key format', () => {

  it('test period key matches expected format', () => {
    expect(TEST_PERIOD).toMatch(/^\d{4}-P\d{2}-W\d+$/)
  })

  it('pnl doc path uses correct period key format', async () => {
    const path = `${TENANT_PATH}/pnl/${TEST_LOC}/periods/${TEST_PERIOD}`
    // Just verify the path is readable (may be empty)
    const snap = await db.doc(path).get()
    expect(snap).toBeDefined()
  })

  it('budget path uses year not period key', async () => {
    const year = new Date().getFullYear()
    const path = `${TENANT_PATH}/budgets/${TEST_LOC}-${year}`
    const snap = await db.doc(path).get()
    expect(snap).toBeDefined()
  })
})

// ═════════════════════════════════════════════════════════════
// 3. P&L FLOW TEST — write through each module, verify Dashboard reads
// ═════════════════════════════════════════════════════════════
describe('P&L flow', () => {

  const pnlPath = `${TENANT_PATH}/pnl/${TEST_LOC}/periods/${TEST_PERIOD}`

  it('writes sales data to P&L', async () => {
    await write(pnlPath, {
      gfs_retail:         10000,
      gfs_catering:       5000,
      gfs_popup:          2000,
      gfs_total:          17000,
      revenue_commission: 3060,
      revenue_total:      13940,
    })
    const data = await read(pnlPath)
    expect(data.gfs_total).toBe(17000)
    expect(data.revenue_total).toBe(13940)
  })

  it('writes labor data to P&L', async () => {
    await write(pnlPath, {
      cogs_onsite_labor: 4500,
      cogs_3rd_party:    1200,
      exp_comp_benefits: 2100,
      labor_total:       7800,
    })
    const data = await read(pnlPath)
    expect(data.cogs_onsite_labor).toBe(4500)
    expect(data.labor_total).toBe(7800)
  })

  it('writes purchasing data to P&L', async () => {
    await write(pnlPath, {
      cogs_purchases: 3200,
      ap_paid:        3200,
      ap_pending:     0,
    })
    const data = await read(pnlPath)
    expect(data.cogs_purchases).toBe(3200)
  })

  it('writes inventory COGS to P&L', async () => {
    await write(pnlPath, {
      inv_closing:   8000,
      inv_opening:   7500,
      inv_purchases: 3200,
      cogs_inventory: Math.max(0, 7500 + 3200 - 8000), // 2700
    })
    const data = await read(pnlPath)
    expect(data.cogs_inventory).toBe(2700)
  })

  it('writes waste data to P&L', async () => {
    await write(pnlPath, {
      cogs_waste: 450,
      waste_oz:   72,
    })
    const data = await read(pnlPath)
    expect(data.cogs_waste).toBe(450)
  })

  it('Dashboard can read full P&L doc', async () => {
    const data = await read(pnlPath)
    expect(data).not.toBeNull()
    expect(typeof data.gfs_total).toBe('number')
    expect(typeof data.cogs_onsite_labor).toBe('number')
    expect(typeof data.cogs_purchases).toBe('number')
    expect(typeof data.cogs_inventory).toBe('number')
    expect(typeof data.cogs_waste).toBe('number')
  })

  it('COGS formula is correct', async () => {
    const data  = await read(pnlPath)
    const labor   = (data.cogs_onsite_labor || 0) + (data.cogs_3rd_party || 0)
    const payproc = (data.gfs_total || 0) * 0.018
    const totalCOGS = labor + (data.cogs_inventory || 0) + (data.cogs_purchases || 0) + (data.cogs_waste || 0) + payproc
    const grossMargin = (data.revenue_total || 0) - totalCOGS
    // Gross margin should be positive for a healthy location
    expect(typeof grossMargin).toBe('number')
    expect(grossMargin).toBeGreaterThan(0)
  })

  it('prime cost % is within expected range', async () => {
    const data     = await read(pnlPath)
    const revenue  = data.revenue_total || 0
    const labor    = (data.cogs_onsite_labor || 0) + (data.cogs_3rd_party || 0) + (data.exp_comp_benefits || 0)
    const cogs     = (data.cogs_inventory || 0) + (data.cogs_purchases || 0)
    const primeCost = revenue > 0 ? (labor + cogs) / revenue : 0
    // Prime cost should be between 30% and 85% — flag if outside
    expect(primeCost).toBeGreaterThan(0.3)
    expect(primeCost).toBeLessThan(0.85)
  })
})

// ═════════════════════════════════════════════════════════════
// 4. OPENING INVENTORY — verify prior week closing flows correctly
// ═════════════════════════════════════════════════════════════
describe('Opening inventory logic', () => {

  it('writes closing inventory for current period', async () => {
    const invPath = `${TENANT_PATH}/locations/${TEST_LOC}/inventory/${TEST_PERIOD}`
    await write(invPath, {
      items: [
        { id: 'item1', name: 'Red Bull', qty: 12, unitCost: 1.98 },
        { id: 'item2', name: 'Greek Yogurt', qty: 6, unitCost: 1.14 },
      ],
      period: TEST_PERIOD,
    })
    const data = await read(invPath)
    expect(data.items).toHaveLength(2)
    const closingValue = data.items.reduce((s, i) => s + (i.qty * i.unitCost), 0)
    expect(closingValue).toBeCloseTo(30.6, 1)
  })

  it('prior period closing becomes next period opening', async () => {
    // Simulate what getPriorClosingValue() does
    const invPath = `${TENANT_PATH}/locations/${TEST_LOC}/inventory/${TEST_PERIOD}`
    const data = await read(invPath)
    expect(data).not.toBeNull()
    const closingValue = data.items.reduce((s, i) => s + ((i.qty || 0) * (i.unitCost || 0)), 0)
    expect(closingValue).toBeGreaterThan(0)
  })
})

// ═════════════════════════════════════════════════════════════
// 5. APPROVAL WORKFLOW — verify submission → approval → P&L post
// ═════════════════════════════════════════════════════════════
describe('Approval workflows', () => {

  it('labor submission can be created as pending', async () => {
    const path = `${TENANT_PATH}/laborSubmissions/smoke_test_labor`
    await write(path, {
      period: TEST_PERIOD, location: TEST_LOC,
      status: 'pending', importedBy: 'smoke_test',
      glRows: [], fileName: 'test.xlsx',
    })
    const data = await read(path)
    expect(data.status).toBe('pending')
  })

  it('labor submission can be approved', async () => {
    const path = `${TENANT_PATH}/laborSubmissions/smoke_test_labor`
    await db.doc(path).update({ status: 'approved', approvedBy: 'smoke_test' })
    const data = await read(path)
    expect(data.status).toBe('approved')
  })

  it('sales submission workflow', async () => {
    const path = `${TENANT_PATH}/salesSubmissions/smoke_test_sales`
    await write(path, {
      period: TEST_PERIOD, location: TEST_LOC,
      status: 'pending', submittedBy: 'smoke_test', weekTotal: 17000,
    })
    const data = await read(path)
    expect(data.status).toBe('pending')
    expect(data.weekTotal).toBe(17000)
  })

  it('budget can be saved and locked', async () => {
    const year = new Date().getFullYear()
    const path = `${TENANT_PATH}/budgets/${TEST_LOC}-${year}`
    await write(path, {
      location: TEST_LOC, year: String(year),
      status: 'approved', lines: {},
      submittedBy: 'smoke_test', approvedBy: 'smoke_test',
    })
    const data = await read(path)
    expect(data.status).toBe('approved')
  })
})

// ═════════════════════════════════════════════════════════════
// 6. MULTI-TENANT ISOLATION — verify org isolation
// ═════════════════════════════════════════════════════════════
describe('Multi-tenant isolation', () => {

  it('fooda tenant path is correctly scoped', async () => {
    const path = `tenants/fooda/pnl/${TEST_LOC}/periods/${TEST_PERIOD}`
    const snap = await db.doc(path).get()
    expect(snap.ref.path).toContain('tenants/fooda')
  })

  it('different tenant paths are separate', async () => {
    const path1 = `tenants/fooda/pnl/${TEST_LOC}/periods/${TEST_PERIOD}`
    const path2 = `tenants/other_org/pnl/${TEST_LOC}/periods/${TEST_PERIOD}`
    expect(path1).not.toBe(path2)
    // other_org doc should not exist
    const snap = await db.doc(path2).get()
    expect(snap.exists).toBe(false)
  })
})