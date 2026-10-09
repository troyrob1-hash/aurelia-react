/**
 * Auth claim-shape contract — the 2026-09-28 Cognito → Firebase Auth cutover.
 *
 * Three places must agree on the LITERAL claim keys, or the app is bricked:
 *   1. firestore.rules            — reads request.auth.token["custom:tenantId"] / ["custom:role"]
 *   2. the migration script       — writes them via setCustomUserClaims
 *   3. authStore.mapUser          — reads them off the ID token
 *
 * The failure mode this guards is total and silent-at-write-time: setting
 * `{ tenantId, role }` instead of `{ "custom:tenantId", "custom:role" }` lands
 * the values at request.auth.token.tenantId, every rules helper reads null,
 * and EVERY authenticated Firestore request is denied — for every user at once.
 * Nothing throws; the writes succeed. Only reads fail, everywhere.
 *
 * Per CLAUDE.md these files are the tracked home for that kind of guard.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const read = p => readFileSync(resolve(ROOT, p), 'utf8')

/**
 * Strip comments before asserting on structure.
 *
 * These files carry long cutover-history comments that quote the very shapes
 * being asserted against (e.g. the migration's header explains
 * `setCustomUserClaims(uid, {...})`, and authStore's header names the removed
 * `refreshSession`). Matching raw text finds the prose, not the code.
 */
const code = p => read(p)
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')

const RULES     = read('firestore.rules')
const MIGRATION = code('migrations/migrate-cognito-to-firebase-auth.cjs')
const AUTHSTORE = code('src/store/authStore.js')
const FUNCTIONS = code('functions/index.js')

const TENANT_KEY = 'custom:tenantId'
const ROLE_KEY   = 'custom:role'

describe('claim keys firestore.rules enforces on', () => {
  it('reads tenant from request.auth.token["custom:tenantId"]', () => {
    expect(RULES).toMatch(/function\s+tenantId\(\)\s*\{\s*return\s+request\.auth\.token\["custom:tenantId"\]/)
  })

  it('reads role from request.auth.token["custom:role"]', () => {
    expect(RULES).toMatch(/function\s+role\(\)\s*\{\s*return\s+request\.auth\.token\["custom:role"\]/)
  })

  it('reads no other custom: claim than tenantId and role', () => {
    // If rules start gating on a third claim, the migration has to set it too.
    const found = new Set([...RULES.matchAll(/token\["(custom:[^"]+)"\]/g)].map(m => m[1]))
    expect([...found].sort()).toEqual([ROLE_KEY, TENANT_KEY].sort())
  })
})

describe('migration writes the keys rules read', () => {
  it('declares the prefixed keys as its claim constants', () => {
    expect(MIGRATION).toMatch(new RegExp(`CLAIM_TENANT\\s*=\\s*'${TENANT_KEY}'`))
    expect(MIGRATION).toMatch(new RegExp(`CLAIM_ROLE\\s*=\\s*'${ROLE_KEY}'`))
  })

  it('passes those constants to setCustomUserClaims as computed keys', () => {
    const call = MIGRATION.match(/setCustomUserClaims\([\s\S]{0,300}?\}\)/)
    expect(call, 'setCustomUserClaims call not found').toBeTruthy()
    expect(call[0]).toContain('[CLAIM_TENANT]')
    expect(call[0]).toContain('[CLAIM_ROLE]')
  })

  it('never sets a bare unprefixed tenantId/role claim', () => {
    // The exact catastrophic typo: { tenantId: ORG, role: p.role }.
    const call = MIGRATION.match(/setCustomUserClaims\([\s\S]{0,300}?\}\)/)[0]
    expect(call).not.toMatch(/\btenantId\s*:/)
    expect(call).not.toMatch(/(^|[^:\w])role\s*:/m)
  })
})

describe('authStore.mapUser reads the same keys', () => {
  it('reads both prefixed claims off the ID token', () => {
    expect(AUTHSTORE).toContain(`claims['${TENANT_KEY}']`)
    expect(AUTHSTORE).toContain(`claims['${ROLE_KEY}']`)
  })

  it('no longer bridges through Cognito', () => {
    expect(AUTHSTORE).not.toContain('signInWithCognito')
    expect(AUTHSTORE).not.toMatch(/\brefreshSession\b/)
  })
})

describe('the Cognito bridge is gone from the login path', () => {
  it('lib/auth.js makes no request to cognito-idp', () => {
    const authLib = code('src/lib/auth.js')
    expect(authLib).not.toMatch(/cognito-idp|amazonaws\.com|InitiateAuth/)
    expect(authLib).toContain('signInWithEmailAndPassword')
  })

  it('lib/firebase.js no longer exports the token-bridge helper', () => {
    expect(code('src/lib/firebase.js')).not.toMatch(/export\s+async\s+function\s+signInWithCognito/)
  })
})

describe('Cloud Functions provisioning (2026-10-09 AWS teardown)', () => {
  // inviteUser / updateUserRoles now set the claims that used to come from
  // Cognito. They are the ONLY writers of these claims in production (the
  // migration was one-time), so the same shape contract applies to them.
  it('declares the prefixed claim constants', () => {
    expect(FUNCTIONS).toMatch(new RegExp(`CLAIM_TENANT = "${TENANT_KEY}"`))
    expect(FUNCTIONS).toMatch(new RegExp(`CLAIM_ROLE   = "${ROLE_KEY}"`))
  })

  it('routes every claim write through the MERGING helper', () => {
    // A bare setCustomUserClaims({"custom:role": x}) would REPLACE the claims
    // object and drop custom:tenantId — denying that user every read. Only
    // setTenantClaims may call it, and it must merge over getUser().customClaims.
    const helper = FUNCTIONS.slice(
      FUNCTIONS.indexOf('async function setTenantClaims'),
      FUNCTIONS.indexOf('function authErrCode')
    )
    expect(helper).toMatch(/getUser\(uid\)\)\.customClaims \|\| \{\}/)
    expect(helper).toMatch(/const next = \{ \.\.\.existing \}/)
    expect(helper).toMatch(/setCustomUserClaims\(uid, next\)/)

    // Exactly one setCustomUserClaims call in the whole file — inside the helper.
    expect(FUNCTIONS.match(/setCustomUserClaims\(/g)).toHaveLength(1)
  })

  it('invite and role-change both go through setTenantClaims', () => {
    expect(FUNCTIONS).toMatch(/setTenantClaims\(uid, \{ orgId, role: primaryRole, displayName \}\)/)
    expect(FUNCTIONS).toMatch(/setTenantClaims\(targetUid, \{ orgId, role: primaryRole \}\)/)
  })

  it('never writes a bare unprefixed tenantId/role claim', () => {
    const helper = FUNCTIONS.slice(
      FUNCTIONS.indexOf('async function setTenantClaims'),
      FUNCTIONS.indexOf('function authErrCode')
    )
    expect(helper).not.toMatch(/next\.tenantId/)
    expect(helper).not.toMatch(/next\.role\b/)
  })

  it('has no AWS/Cognito calls left', () => {
    expect(FUNCTIONS).not.toMatch(/aws-sdk/)
    expect(FUNCTIONS).not.toMatch(/CognitoIdentityServiceProvider/)
    expect(FUNCTIONS).not.toMatch(/adminCreateUser|adminSetUserPassword|adminDisableUser|adminUpdateUserAttributes|adminGetUser/)
    expect(FUNCTIONS).not.toMatch(/AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY/)
    expect(FUNCTIONS).not.toMatch(/new AWS\.SES/)
  })

  it('aws-sdk is gone from functions/package.json', () => {
    const pkg = JSON.parse(read('functions/package.json'))
    expect(pkg.dependencies).not.toHaveProperty('aws-sdk')
  })

  it('no longer hands out a shared temp password', () => {
    // The old flow returned the literal "Welcome2026!" to every invitee.
    expect(FUNCTIONS).not.toMatch(/Welcome2026/)
    expect(FUNCTIONS).not.toMatch(/tempPassword/)
    expect(FUNCTIONS).toMatch(/generatePasswordResetLink\(email\)/)
    // and the client must read the new field, not the old one
    const modal = code('src/pages/Settings/components/InviteModal.jsx')
    expect(modal).toMatch(/result\?\.data\?\.resetLink/)
    expect(modal).not.toMatch(/tempPassword|Welcome2026/)
  })

  it('deactivateUser disables the credential before the Firestore flag', () => {
    const fn = FUNCTIONS.slice(
      FUNCTIONS.indexOf('exports.deactivateUser'),
      FUNCTIONS.indexOf('exports.cleanExpiredSessions')
    )
    const disableAt = fn.indexOf('updateUser(targetUid, { disabled: true })')
    const flagAt    = fn.indexOf('active: false')
    expect(disableAt).toBeGreaterThan(-1)
    expect(flagAt).toBeGreaterThan(disableAt)   // order matters: credential first
  })
})

describe('migration role resolution', () => {
  // resolveRole is the seam where Firestore becomes authoritative for the
  // claim. Re-implemented here from the script's own table so a change to the
  // ranking has to be deliberate; a multi-role user must never be downgraded.
  const ROLE_RANK = ['viewer', 'pending', 'staff', 'manager', 'director', 'vp', 'admin']
  function resolveRole(doc) {
    const c = []
    if (doc.role) c.push(String(doc.role).toLowerCase())
    ;(Array.isArray(doc.roles) ? doc.roles : []).forEach(r => c.push(String(r).toLowerCase()))
    if (!c.length) return 'viewer'
    return c.reduce((best, r) => ROLE_RANK.indexOf(r) > ROLE_RANK.indexOf(best) ? r : best, c[0])
  }

  it('keeps the script and this test on one ranking table', () => {
    const inScript = MIGRATION.match(/ROLE_RANK\s*=\s*\[([^\]]+)\]/)[1]
      .split(',').map(s => s.trim().replace(/['"]/g, ''))
    expect(inScript).toEqual(ROLE_RANK)
  })

  it('takes the highest tier when roles[] holds several', () => {
    expect(resolveRole({ role: 'manager', roles: ['manager', 'director'] })).toBe('director')
    expect(resolveRole({ role: 'director', roles: ['director'] })).toBe('director')
    expect(resolveRole({ roles: ['manager', 'admin', 'viewer'] })).toBe('admin')
  })

  it('falls back to roles[] when the singular field is missing', () => {
    expect(resolveRole({ roles: ['manager'] })).toBe('manager')
  })

  it('defaults to viewer, never to something privileged', () => {
    expect(resolveRole({})).toBe('viewer')
    expect(resolveRole({ roles: [] })).toBe('viewer')
  })

  it('preserves the staff legacy alias rather than dropping it', () => {
    // firestore.rules isManager() recognizes 'staff'; the claim must carry it
    // through so a staff user keeps manager-tier writes.
    expect(resolveRole({ role: 'staff' })).toBe('staff')
    expect(RULES).toMatch(/role\(\)\s*==\s*'staff'/)
  })
})
