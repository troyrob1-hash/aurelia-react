// tests/rules.test.js
//
// Tests for firestore.rules running against the Firebase emulator.
// No real Firebase project required — everything runs locally.
//
// Run with: npm run test:rules
//
// Each test sets up an authenticated context with specific custom claims
// (tenantId, role) and verifies that the rules allow or deny operations
// the way we expect.

import {
  initializeTestEnvironment,
  assertSucceeds,
  assertFails,
} from '@firebase/rules-unit-testing'

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { describe, test, beforeAll, afterAll, beforeEach } from 'vitest'

const __filename = fileURLToPath(import.meta.url)
const __dirname  = path.dirname(__filename)

const PROJECT_ID = 'aurelia-rules-test'

let testEnv

beforeAll(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: {
      rules: fs.readFileSync(path.resolve(__dirname, '..', 'firestore.rules'), 'utf8'),
      host: '127.0.0.1',
      port: 8080,
    },
  })
})

afterAll(async () => {
  if (testEnv) await testEnv.cleanup()
})

beforeEach(async () => {
  if (testEnv) await testEnv.clearFirestore()
})

// Helper: get an authenticated Firestore context with given claims
function authedContext(uid, claims = {}) {
  return testEnv.authenticatedContext(uid, claims).firestore()
}

// Helper: get an unauthenticated context
function unauthedContext() {
  return testEnv.unauthenticatedContext().firestore()
}

// Helper: seed a doc using the admin (rules-bypassing) context
async function seed(pathStr, data) {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore()
    const segments = pathStr.split('/')
    const ref = segments.length === 2
      ? db.collection(segments[0]).doc(segments[1])
      : db.doc(pathStr)
    await ref.set(data)
  })
}

// ============================================================
// SIGNED-OUT USERS
// ============================================================
describe('signed-out users', () => {
  test('cannot read tenants/fooda data', async () => {
    await seed('tenants/fooda', { name: 'Fooda' })
    const db = unauthedContext()
    await assertFails(db.doc('tenants/fooda').get())
  })

  test('cannot read aurelia/inv_items', async () => {
    await seed('aurelia/inv_items', { items: [] })
    const db = unauthedContext()
    await assertFails(db.doc('aurelia/inv_items').get())
  })

  test('cannot write anywhere', async () => {
    const db = unauthedContext()
    await assertFails(db.doc('tenants/fooda/invoices/x').set({ amount: 1 }))
  })
})

// ============================================================
// TENANT ISOLATION (the big one)
// ============================================================
describe('tenant isolation', () => {
  test('fooda user can read fooda invoices', async () => {
    await seed('tenants/fooda/invoices/inv1', { amount: 100, location: 'a' })
    const db = authedContext('user1', { 'custom:tenantId': 'fooda', 'custom:role': 'manager' })
    await assertSucceeds(db.doc('tenants/fooda/invoices/inv1').get())
  })

  test('acme user CANNOT read fooda invoices', async () => {
    await seed('tenants/fooda/invoices/inv1', { amount: 100, location: 'a' })
    const db = authedContext('user2', { 'custom:tenantId': 'acme', 'custom:role': 'admin' })
    await assertFails(db.doc('tenants/fooda/invoices/inv1').get())
  })

  test('acme admin cannot write to fooda', async () => {
    const db = authedContext('user3', { 'custom:tenantId': 'acme', 'custom:role': 'admin' })
    await assertFails(db.doc('tenants/fooda/invoices/x').set({ amount: 1 }))
  })

  test('user with NO tenant claim cannot read anything in tenants/', async () => {
    await seed('tenants/fooda/invoices/inv1', { amount: 100 })
    const db = authedContext('user4', { 'custom:role': 'admin' }) // no tenantId
    await assertFails(db.doc('tenants/fooda/invoices/inv1').get())
  })
})

// ============================================================
// ROLE-BASED WRITES
// ============================================================
describe('role-based writes on invoices', () => {
  const fooda = (role) => authedContext('u', { 'custom:tenantId': 'fooda', 'custom:role': role })

  test('viewer can read invoices', async () => {
    await seed('tenants/fooda/invoices/inv1', { amount: 100 })
    await assertSucceeds(fooda('viewer').doc('tenants/fooda/invoices/inv1').get())
  })

  test('viewer CANNOT create invoices', async () => {
    await assertFails(fooda('viewer').doc('tenants/fooda/invoices/new').set({ amount: 100 }))
  })

  test('manager CAN create invoices', async () => {
    await assertSucceeds(fooda('manager').doc('tenants/fooda/invoices/new').set({ amount: 100 }))
  })

  test('manager CANNOT delete invoices', async () => {
    await seed('tenants/fooda/invoices/inv1', { amount: 100 })
    await assertFails(fooda('manager').doc('tenants/fooda/invoices/inv1').delete())
  })

  test('director CAN delete invoices', async () => {
    await seed('tenants/fooda/invoices/inv1', { amount: 100 })
    await assertSucceeds(fooda('director').doc('tenants/fooda/invoices/inv1').delete())
  })

  test('admin CAN delete invoices (admin counts as director)', async () => {
    await seed('tenants/fooda/invoices/inv1', { amount: 100 })
    await assertSucceeds(fooda('admin').doc('tenants/fooda/invoices/inv1').delete())
  })
})

// ============================================================
// ORGS COLLECTION (Settings UI)
// ============================================================
describe('orgs/{orgId} access', () => {
  const fooda = (role) => authedContext('u', { 'custom:tenantId': 'fooda', 'custom:role': role })

  test('admin can write to orgs/fooda/users', async () => {
    await assertSucceeds(fooda('admin').doc('orgs/fooda/users/newuser').set({ email: 'a@b.com' }))
  })

  test('manager CANNOT write to orgs/fooda/users', async () => {
    await assertFails(fooda('manager').doc('orgs/fooda/users/newuser').set({ email: 'a@b.com' }))
  })

  test('manager can read orgs/fooda/users', async () => {
    await seed('orgs/fooda/users/u1', { email: 'a@b.com' })
    await assertSucceeds(fooda('manager').doc('orgs/fooda/users/u1').get())
  })

  test('admin can read orgs/fooda/apiKeys', async () => {
    await seed('orgs/fooda/apiKeys/k1', { label: 'test' })
    await assertSucceeds(fooda('admin').doc('orgs/fooda/apiKeys/k1').get())
  })

  test('manager CANNOT read orgs/fooda/apiKeys', async () => {
    await seed('orgs/fooda/apiKeys/k1', { label: 'test' })
    await assertFails(fooda('manager').doc('orgs/fooda/apiKeys/k1').get())
  })
})

// ============================================================
// AUDIT LOG (write-only via Cloud Functions)
// ============================================================
describe('audit log', () => {
  const fooda = (role) => authedContext('u', { 'custom:tenantId': 'fooda', 'custom:role': role })

  test('director can read audit log', async () => {
    await seed('orgs/fooda/auditLog/log1', { action: 'test' })
    await assertSucceeds(fooda('director').doc('orgs/fooda/auditLog/log1').get())
  })

  test('manager CANNOT read audit log', async () => {
    await seed('orgs/fooda/auditLog/log1', { action: 'test' })
    await assertFails(fooda('manager').doc('orgs/fooda/auditLog/log1').get())
  })

  test('NO ONE can write to audit log from client', async () => {
    await assertFails(fooda('admin').doc('orgs/fooda/auditLog/new').set({ action: 'test' }))
  })
})

// ============================================================
// AURELIA GLOBAL CONFIG
// ============================================================
describe('aurelia/ global config', () => {
  test('any signed-in user can read aurelia/inv_items', async () => {
    await seed('aurelia/inv_items', { items: [] })
    const db = authedContext('u', { 'custom:tenantId': 'fooda', 'custom:role': 'viewer' })
    await assertSucceeds(db.doc('aurelia/inv_items').get())
  })

  test('NO ONE can write to aurelia/ from client', async () => {
    const db = authedContext('u', { 'custom:tenantId': 'fooda', 'custom:role': 'admin' })
    await assertFails(db.doc('aurelia/inv_items').set({ items: [] }))
  })
})

// ============================================================
// DEFAULT DENY
// ============================================================
describe('default deny', () => {
  test('weird unmatched path is denied for everyone', async () => {
    const db = authedContext('u', { 'custom:tenantId': 'fooda', 'custom:role': 'admin' })
    await assertFails(db.doc('random_root_collection/x').get())
    await assertFails(db.doc('random_root_collection/x').set({ a: 1 }))
  })
})