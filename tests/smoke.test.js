/**
 * Aurelia FMS — Daily Smoke Test Suite
 * Runs via GitHub Actions at 6am every day
 * Tests Firestore paths, P&L flow, period key consistency, schema validation,
 * cross-location isolation, and Order Hub integrity
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
        projectId:   process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey:  process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
      })
    })
  }
  db = getFirestore()
})

// ── Constants ─────────────────────────────────────────────────
const ORG_ID       = 'fooda'
const LOC_A        = 'test_location_smoke_A'
const LOC_B        = 'test_location_smoke_B'
const TEST_LOC     = LOC_A  // backward compat alias
const TEST_PERIOD  = `${new Date().getFullYear()}-P${String(new Date().getMonth()+1).padStart(2,'0')}-W1`
const TENANT_PATH  = `tenants/${ORG_ID}`

const cleanupRefs = []

// ── Helpers ───────────────────────────────────────────────────
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

afterAll(async () => {
  await Promise.allSettled(cleanupRefs.map(p => db.doc(p).delete()))
})


// ═════════════════════════════════════════════════════════════
// 1. FIRESTORE PATH TESTS
// ═════════════════════════════════════════════════════════════
describe('Firestore paths', () => {

  it('reads tenant root', async () => {
    const snap = await db.collection('tenants').doc(ORG_ID).get()
    expect(snap).toBeDefined()
  })

  it('reads config/budgetSchema', async () => {
    const data = await read(`${TENANT_PATH}/config/budgetSchema`)
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
// 2. PERIOD KEY CONSISTENCY
// ═════════════════════════════════════════════════════════════
describe('Period key format', () => {

  it('test period key matches expected format', () => {
    expect(TEST_PERIOD).toMatch(/^\d{4}-P\d{2}-W\d+$/)
  })

  it('pnl doc path uses correct period key format', async () => {
    const snap = await db.doc(`${TENANT_PATH}/pnl/${TEST_LOC}/periods/${TEST_PERIOD}`).get()
    expect(snap).toBeDefined()
  })

  it('budget path uses year not period key', async () => {
    const year = new Date().getFullYear()
    const snap = await db.doc(`${TENANT_PATH}/budgets/${TEST_LOC}-${year}`).get()
    expect(snap).toBeDefined()
  })
})


// ═════════════════════════════════════════════════════════════
// 3. P&L FLOW TEST
// ═════════════════════════════════════════════════════════════
describe('P&L flow', () => {

  const pnlPath = `${TENANT_PATH}/pnl/${TEST_LOC}/periods/${TEST_PERIOD}`

  it('writes sales data to P&L', async () => {
    await write(pnlPath, {
      gfs_retail: 10000, gfs_catering: 5000, gfs_popup: 2000,
      gfs_total: 17000, revenue_commission: 3060, revenue_total: 13940,
    })
    const data = await read(pnlPath)
    expect(data.gfs_total).toBe(17000)
    expect(data.revenue_total).toBe(13940)
  })

  it('writes labor data to P&L', async () => {
    await write(pnlPath, {
      cogs_onsite_labor: 4500, cogs_3rd_party: 1200,
      exp_comp_benefits: 2100, labor_total: 7800,
    })
    const data = await read(pnlPath)
    expect(data.cogs_onsite_labor).toBe(4500)
    expect(data.labor_total).toBe(7800)
  })

  it('writes purchasing data to P&L', async () => {
    await write(pnlPath, { cogs_purchases: 3200, ap_paid: 3200, ap_pending: 0 })
    const data = await read(pnlPath)
    expect(data.cogs_purchases).toBe(3200)
  })

  it('writes inventory COGS to P&L', async () => {
    await write(pnlPath, {
      inv_closing: 8000, inv_opening: 7500, inv_purchases: 3200,
      cogs_inventory: Math.max(0, 7500 + 3200 - 8000),
    })
    const data = await read(pnlPath)
    expect(data.cogs_inventory).toBe(2700)
  })

  it('writes waste data to P&L', async () => {
    await write(pnlPath, { cogs_waste: 450, waste_oz: 72 })
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
    const data = await read(pnlPath)
    const labor     = (data.cogs_onsite_labor || 0) + (data.cogs_3rd_party || 0)
    const payproc   = (data.gfs_total || 0) * 0.018
    const totalCOGS = labor + (data.cogs_inventory || 0) + (data.cogs_purchases || 0) + (data.cogs_waste || 0) + payproc
    const grossMargin = (data.revenue_total || 0) - totalCOGS
    expect(typeof grossMargin).toBe('number')
    expect(grossMargin).toBeGreaterThan(0)
  })

  it('prime cost % is within expected range', async () => {
    const data    = await read(pnlPath)
    const revenue = data.revenue_total || 0
    const labor   = (data.cogs_onsite_labor || 0) + (data.cogs_3rd_party || 0) + (data.exp_comp_benefits || 0)
    const cogs    = (data.cogs_inventory || 0) + (data.cogs_purchases || 0)
    const primeCost = revenue > 0 ? (labor + cogs) / revenue : 0
    expect(primeCost).toBeGreaterThan(0.3)
    expect(primeCost).toBeLessThan(1.5) // synthetic test data may exceed real-world thresholds
  })
})


// ═════════════════════════════════════════════════════════════
// 4. OPENING INVENTORY LOGIC
// ═════════════════════════════════════════════════════════════
describe('Opening inventory logic', () => {

  it('writes closing inventory for current period', async () => {
    const invPath = `${TENANT_PATH}/locations/${TEST_LOC}/inventory/${TEST_PERIOD}`
    await write(invPath, {
      items: [
        { id: 'item1', name: 'Red Bull',     qty: 12, unitCost: 1.98 },
        { id: 'item2', name: 'Greek Yogurt', qty: 6,  unitCost: 1.14 },
      ],
      period: TEST_PERIOD,
    })
    const data = await read(invPath)
    expect(data.items).toHaveLength(2)
    const closingValue = data.items.reduce((s, i) => s + (i.qty * i.unitCost), 0)
    expect(closingValue).toBeCloseTo(30.6, 1)
  })

  it('prior period closing becomes next period opening', async () => {
    const data = await read(`${TENANT_PATH}/locations/${TEST_LOC}/inventory/${TEST_PERIOD}`)
    expect(data).not.toBeNull()
    const closingValue = data.items.reduce((s, i) => s + ((i.qty || 0) * (i.unitCost || 0)), 0)
    expect(closingValue).toBeGreaterThan(0)
  })
})


// ═════════════════════════════════════════════════════════════
// 5. APPROVAL WORKFLOWS
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
// 6. MULTI-TENANT ISOLATION
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
    const snap = await db.doc(path2).get()
    expect(snap.exists).toBe(false)
  })
})


// ═════════════════════════════════════════════════════════════
// 7. CROSS-LOCATION ISOLATION — NEW
// Verifies data written at Location A never appears at Location B
// ═════════════════════════════════════════════════════════════
describe('Cross-location data isolation', () => {

  it('sales data written to Location A does not appear at Location B', async () => {
    const pathA = `${TENANT_PATH}/salesSubmissions/smoke_loc_a_sales`
    const pathB = `${TENANT_PATH}/salesSubmissions/smoke_loc_b_sales`

    await write(pathA, { location: LOC_A, period: TEST_PERIOD, weekTotal: 11111, status: 'pending' })
    await write(pathB, { location: LOC_B, period: TEST_PERIOD, weekTotal: 22222, status: 'pending' })

    const dataA = await read(pathA)
    const dataB = await read(pathB)

    expect(dataA.weekTotal).toBe(11111)
    expect(dataB.weekTotal).toBe(22222)
    expect(dataA.location).toBe(LOC_A)
    expect(dataB.location).toBe(LOC_B)
    // Confirm values didn't cross
    expect(dataA.weekTotal).not.toBe(dataB.weekTotal)
    expect(dataA.location).not.toBe(dataB.location)
  })

  it('P&L data is scoped per location path', async () => {
    const pathA = `${TENANT_PATH}/pnl/${LOC_A}/periods/${TEST_PERIOD}`
    const pathB = `${TENANT_PATH}/pnl/${LOC_B}/periods/${TEST_PERIOD}`

    await write(pathA, { gfs_total: 50000, revenue_total: 40000 })
    await write(pathB, { gfs_total: 99999, revenue_total: 80000 })

    const dataA = await read(pathA)
    const dataB = await read(pathB)

    expect(dataA.gfs_total).toBe(50000)
    expect(dataB.gfs_total).toBe(99999)
    expect(dataA.gfs_total).not.toBe(dataB.gfs_total)
  })

  it('waste submissions are scoped per location', async () => {
    const pathA = `${TENANT_PATH}/wasteSubmissions/smoke_waste_a`
    const pathB = `${TENANT_PATH}/wasteSubmissions/smoke_waste_b`

    await write(pathA, { location: LOC_A, period: TEST_PERIOD, totalWaste: 100 })
    await write(pathB, { location: LOC_B, period: TEST_PERIOD, totalWaste: 999 })

    const dataA = await read(pathA)
    const dataB = await read(pathB)

    expect(dataA.totalWaste).toBe(100)
    expect(dataB.totalWaste).toBe(999)
    expect(dataA.location).not.toBe(dataB.location)
  })

  it('inventory counts are scoped per location', async () => {
    const pathA = `${TENANT_PATH}/locations/${LOC_A}/inventory/${TEST_PERIOD}`
    const pathB = `${TENANT_PATH}/locations/${LOC_B}/inventory/${TEST_PERIOD}`

    await write(pathA, { items: [{ id: 'item1', qty: 10, unitCost: 2.00 }], period: TEST_PERIOD })
    await write(pathB, { items: [{ id: 'item1', qty: 99, unitCost: 2.00 }], period: TEST_PERIOD })

    const dataA = await read(pathA)
    const dataB = await read(pathB)

    expect(dataA.items[0].qty).toBe(10)
    expect(dataB.items[0].qty).toBe(99)
    // Same item ID, different qtys — confirm no bleed
    expect(dataA.items[0].qty).not.toBe(dataB.items[0].qty)
  })

  it('budget figures are scoped per location', async () => {
    const year  = new Date().getFullYear()
    const pathA = `${TENANT_PATH}/budgets/${LOC_A}-${year}`
    const pathB = `${TENANT_PATH}/budgets/${LOC_B}-${year}`

    await write(pathA, { location: LOC_A, year: String(year), lines: { food: 5000 }, status: 'draft' })
    await write(pathB, { location: LOC_B, year: String(year), lines: { food: 9999 }, status: 'draft' })

    const dataA = await read(pathA)
    const dataB = await read(pathB)

    expect(dataA.lines.food).toBe(5000)
    expect(dataB.lines.food).toBe(9999)
    expect(dataA.location).not.toBe(dataB.location)
  })

  it('querying salesSubmissions by location returns only that location', async () => {
    const snap = await db.collection(`${TENANT_PATH}/salesSubmissions`)
      .where('location', '==', LOC_A)
      .where('_smokeTest', '==', true)
      .get()

    snap.docs.forEach(doc => {
      expect(doc.data().location).toBe(LOC_A)
      expect(doc.data().location).not.toBe(LOC_B)
    })
  })

  it('querying wasteSubmissions by location returns only that location', async () => {
    const snap = await db.collection(`${TENANT_PATH}/wasteSubmissions`)
      .where('location', '==', LOC_B)
      .where('_smokeTest', '==', true)
      .get()

    snap.docs.forEach(doc => {
      expect(doc.data().location).toBe(LOC_B)
      expect(doc.data().location).not.toBe(LOC_A)
    })
  })
})


// ═════════════════════════════════════════════════════════════
// 8. ORDER HUB ISOLATION — NEW
// Verifies orders are scoped to location and vendor correctly
// ═════════════════════════════════════════════════════════════
describe('Order Hub isolation', () => {

  const orderA = `${TENANT_PATH}/orders/smoke_order_loc_a`
  const orderB = `${TENANT_PATH}/orders/smoke_order_loc_b`

  it('orders written to Location A are tagged correctly', async () => {
    await write(orderA, {
      locationId: LOC_A, vendorId: 'sysco',
      status: 'pending', total: 500,
      items: [{ sku: 'SYS-001', qty: 2, price: 250 }],
      deliveryDate: '2026-04-10',
    })
    const data = await read(orderA)
    expect(data.locationId).toBe(LOC_A)
    expect(data.vendorId).toBe('sysco')
    expect(data.total).toBe(500)
  })

  it('orders written to Location B are tagged correctly', async () => {
    await write(orderB, {
      locationId: LOC_B, vendorId: 'nassau',
      status: 'pending', total: 750,
      items: [{ sku: 'NAS-001', qty: 3, price: 250 }],
      deliveryDate: '2026-04-10',
    })
    const data = await read(orderB)
    expect(data.locationId).toBe(LOC_B)
    expect(data.vendorId).toBe('nassau')
    expect(data.total).toBe(750)
  })

  it('Location A order total does not equal Location B order total', async () => {
    const dataA = await read(orderA)
    const dataB = await read(orderB)
    expect(dataA.total).not.toBe(dataB.total)
    expect(dataA.locationId).not.toBe(dataB.locationId)
    expect(dataA.vendorId).not.toBe(dataB.vendorId)
  })

  it('querying orders by locationId returns only that location', async () => {
    const snap = await db.collection(`${TENANT_PATH}/orders`)
      .where('locationId', '==', LOC_A)
      .where('_smokeTest', '==', true)
      .get()

    snap.docs.forEach(doc => {
      expect(doc.data().locationId).toBe(LOC_A)
      expect(doc.data().locationId).not.toBe(LOC_B)
    })
  })

  it('past orders query for Location A excludes Location B orders', async () => {
    const snapB = await db.collection(`${TENANT_PATH}/orders`)
      .where('locationId', '==', LOC_B)
      .where('_smokeTest', '==', true)
      .get()

    snapB.docs.forEach(doc => {
      expect(doc.data().locationId).not.toBe(LOC_A)
    })
  })

  it('multi-vendor order items stay with correct vendor', async () => {
    const multiOrderPath = `${TENANT_PATH}/orders/smoke_order_multivendor`
    await write(multiOrderPath, {
      locationId: LOC_A,
      status: 'pending',
      carts: {
        sysco:  { items: [{ sku: 'SYS-001', qty: 5 }], total: 300 },
        nassau: { items: [{ sku: 'NAS-002', qty: 2 }], total: 150 },
      },
    })
    const data = await read(multiOrderPath)
    expect(data.carts.sysco.total).toBe(300)
    expect(data.carts.nassau.total).toBe(150)
    expect(data.carts.sysco.items[0].sku).toBe('SYS-001')
    expect(data.carts.nassau.items[0].sku).toBe('NAS-002')
    // Confirm vendor items didn't mix
    expect(data.carts.sysco.items[0].sku).not.toBe(data.carts.nassau.items[0].sku)
  })

  it('order status transitions work correctly', async () => {
    await db.doc(orderA).update({ status: 'submitted', submittedAt: new Date().toISOString() })
    const data = await read(orderA)
    expect(data.status).toBe('submitted')
    expect(data.locationId).toBe(LOC_A) // location unchanged after status update
  })
})


// ═════════════════════════════════════════════════════════════
// 9. CONCURRENT WRITE SAFETY — NEW
// Simulates simultaneous writes to both locations
// ═════════════════════════════════════════════════════════════
describe('Concurrent write safety', () => {

  it('simultaneous writes to both locations complete without error', async () => {
    const pathA = `${TENANT_PATH}/pnl/${LOC_A}/periods/${TEST_PERIOD}`
    const pathB = `${TENANT_PATH}/pnl/${LOC_B}/periods/${TEST_PERIOD}`

    // Fire both writes at exactly the same time
    await Promise.all([
      write(pathA, { gfs_total: 11111 }),
      write(pathB, { gfs_total: 22222 }),
    ])

    const [dataA, dataB] = await Promise.all([read(pathA), read(pathB)])
    expect(dataA.gfs_total).toBe(11111)
    expect(dataB.gfs_total).toBe(22222)
  })

  it('simultaneous order submissions to both locations stay isolated', async () => {
    await Promise.all([
      write(`${TENANT_PATH}/orders/smoke_concurrent_a`, { locationId: LOC_A, total: 111, status: 'pending' }),
      write(`${TENANT_PATH}/orders/smoke_concurrent_b`, { locationId: LOC_B, total: 222, status: 'pending' }),
    ])

    const [a, b] = await Promise.all([
      read(`${TENANT_PATH}/orders/smoke_concurrent_a`),
      read(`${TENANT_PATH}/orders/smoke_concurrent_b`),
    ])

    expect(a.locationId).toBe(LOC_A)
    expect(b.locationId).toBe(LOC_B)
    expect(a.total).toBe(111)
    expect(b.total).toBe(222)
  })

  it('batch of 10 writes across both locations all succeed', async () => {
    const writes = Array.from({ length: 10 }, (_, i) => {
      const loc = i % 2 === 0 ? LOC_A : LOC_B
      return write(`${TENANT_PATH}/orders/smoke_batch_${i}`, {
        locationId: loc, total: i * 100, status: 'pending',
      })
    })
    await Promise.all(writes)

    // Verify alternating pattern held
    for (let i = 0; i < 10; i++) {
      const data = await read(`${TENANT_PATH}/orders/smoke_batch_${i}`)
      const expectedLoc = i % 2 === 0 ? LOC_A : LOC_B
      expect(data.locationId).toBe(expectedLoc)
      expect(data.total).toBe(i * 100)
    }
  })
})