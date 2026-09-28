#!/usr/bin/env node
'use strict';

/**
 * MIGRATION — Cognito → Firebase Auth cutover (2026-09-28)
 * ========================================================
 *
 * WHY
 * The AWS subscription lapsed and the Cognito user pool `us-east-2_O2djCRxsH`
 * was deleted along with its app client. Every sign-in failed with
 * `ResourceNotFoundException`. Cognito held the only copies of every password.
 *
 * WHAT SURVIVED
 *   - `orgs/{ORG}/users/*` — 39 docs, all with email + role + region/location
 *     assignments. The full roster, intact.
 *   - Firebase Auth — 35 user records whose uid == the old Cognito `sub`,
 *     auto-created by `signInWithCustomToken`. They are EMPTY SHELLS: no email,
 *     no password, no provider. But their uids are exactly the doc ids in
 *     `orgs/{ORG}/users`, which is what makes this migration cheap.
 *
 * WHAT THIS DOES
 *   1. ATTACH — for a Firestore user whose doc id already exists in Firebase
 *      Auth: `updateUser(uid, {email, displayName})`. The uid is preserved, so
 *      the profile doc, audit history, and every `userId`-keyed record stay
 *      valid. No remapping, anywhere.
 *   2. CREATE — for a Firestore user with no Firebase record:
 *      `createUser({uid: <the Firestore doc id>, email, displayName})`.
 *      Firebase lets you pin the uid on create; that is what keeps these
 *      accounts aligned with their existing docs too.
 *   3. CLAIMS — for every user: `setCustomUserClaims(uid, {...})` using the
 *      EXACT keys firestore.rules reads. See CLAIM SHAPE below.
 *   4. DISABLE — Firestore `active: false` maps to Firebase `disabled: true`,
 *      so a deactivated user cannot set a password and sign in.
 *   5. RESETS (separate flag) — a Firebase password-reset email to each ACTIVE
 *      user. Cognito password hashes are not exportable and the pool is gone;
 *      every user sets a new password. This is unavoidable on any path,
 *      including recreating the Cognito pool.
 *
 * CLAIM SHAPE — the thing to get right
 *   firestore.rules reads:
 *       request.auth.token["custom:tenantId"]      (helper `tenantId()`)
 *       request.auth.token["custom:role"]          (helper `role()`)
 *   so the claims MUST be set under those literal prefixed keys:
 *       { "custom:tenantId": "fooda", "custom:role": "manager" }
 *   NOT { tenantId, role } — that would land at request.auth.token.tenantId,
 *   every rules helper would read null, and EVERY authenticated request would
 *   be denied. This mirrors exactly what `mintFirebaseToken` used to embed in
 *   the custom token, which is why firestore.rules needs no changes at all.
 *
 * SAFETY
 *   - Dry run is the DEFAULT. Nothing is written without `--apply`.
 *   - Reset emails are a SEPARATE flag (`--send-resets`) so accounts can be
 *     migrated and verified before 35 people get an email.
 *   - Refuses to write if any blocking collision is detected (see PRECHECKS).
 *
 * USAGE
 *   export GOOGLE_APPLICATION_CREDENTIALS=/path/to/the-grove-70180-sa.json
 *   node migrations/migrate-cognito-to-firebase-auth.cjs                 # dry run
 *   node migrations/migrate-cognito-to-firebase-auth.cjs --apply         # accounts + claims
 *   node migrations/migrate-cognito-to-firebase-auth.cjs --send-resets --apply
 *
 *   --org <id>     tenant to migrate (default: fooda)
 *   --only <email> restrict to one user (smoke-test a single account first)
 */

const admin = require('firebase-admin');

// ── args ──────────────────────────────────────────────────────
const argv        = process.argv.slice(2);
const APPLY       = argv.includes('--apply');
const SEND_RESETS = argv.includes('--send-resets');
const ORG         = argFor('--org') || 'fooda';
const ONLY        = (argFor('--only') || '').trim().toLowerCase();

function argFor(flag) {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : null;
}

// ── claim keys — must match firestore.rules ───────────────────
const CLAIM_TENANT = 'custom:tenantId';
const CLAIM_ROLE   = 'custom:role';
const CLAIM_NAME   = 'custom:name';

/**
 * Role that goes into the claim.
 *
 * AUTHORITY INVERSION (documented in authStore.js): the Firestore doc is now
 * the source of record and the claim is seeded from it — the reverse of the
 * Cognito arrangement. `role` (singular) is the field permissions.js reads, so
 * it is preferred; `roles[]` is used only to recover a role when the singular
 * field is missing. Highest-privilege wins so a multi-role user is never
 * silently downgraded by the collapse to a single claim.
 */
const ROLE_RANK = ['viewer', 'pending', 'staff', 'manager', 'director', 'vp', 'admin'];
function resolveRole(doc) {
  const candidates = [];
  if (doc.role) candidates.push(String(doc.role).toLowerCase());
  (Array.isArray(doc.roles) ? doc.roles : []).forEach(r => candidates.push(String(r).toLowerCase()));
  if (!candidates.length) return 'viewer';
  return candidates.reduce((best, r) =>
    ROLE_RANK.indexOf(r) > ROLE_RANK.indexOf(best) ? r : best, candidates[0]);
}

// ── init ──────────────────────────────────────────────────────
if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  console.error('FATAL: set GOOGLE_APPLICATION_CREDENTIALS to a service-account JSON for the target project.');
  process.exit(1);
}
admin.initializeApp({ credential: admin.credential.applicationDefault() });
const db   = admin.firestore();
const auth = admin.auth();

// ── helpers ───────────────────────────────────────────────────
const pad = (s, n) => String(s == null ? '' : s).padEnd(n);
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function listAllAuthUsers() {
  const out = [];
  let token;
  do {
    const page = await auth.listUsers(1000, token);
    out.push(...page.users);
    token = page.pageToken;
  } while (token);
  return out;
}

// ── main ──────────────────────────────────────────────────────
(async function main() {
  const projectId = admin.app().options.credential.projectId
    || JSON.parse(require('fs').readFileSync(process.env.GOOGLE_APPLICATION_CREDENTIALS, 'utf8')).project_id;

  console.log('='.repeat(78));
  console.log('Cognito → Firebase Auth migration');
  console.log('  project :', projectId);
  console.log('  org     :', ORG);
  console.log('  mode    :', APPLY ? '*** APPLY (writes) ***' : 'DRY RUN (no writes)');
  console.log('  resets  :', SEND_RESETS ? (APPLY ? 'WILL SEND' : 'would send') : 'skipped (--send-resets to include)');
  if (ONLY) console.log('  only    :', ONLY);
  console.log('='.repeat(78));

  // ---- load both sides ----
  const snap = await db.collection('orgs').doc(ORG).collection('users').get();
  const authUsers = await listAllAuthUsers();
  const byUid   = new Map(authUsers.map(u => [u.uid, u]));
  const byEmail = new Map(authUsers.filter(u => u.email).map(u => [u.email.toLowerCase(), u]));

  console.log(`\nFirestore users: ${snap.size}    Firebase Auth records: ${authUsers.length}\n`);

  // ---- build plan ----
  const plan = [];
  const emailSeen = new Map();

  snap.forEach(d => {
    const doc = d.data();
    const uid = d.id;
    const email = (doc.email || '').trim().toLowerCase();
    const active = doc.active !== false;
    const role = resolveRole(doc);
    const name = doc.displayName || doc.name || email;
    const existing = byUid.get(uid);

    const blockers = [];
    if (!email) blockers.push('no email on the Firestore doc');

    // Two docs claiming one address: Firebase emails are unique, so the second
    // write would fail mid-run. Surface it up front instead.
    if (email) {
      if (emailSeen.has(email)) blockers.push(`duplicate email, also on uid ${emailSeen.get(email)}`);
      else emailSeen.set(email, uid);
    }

    // Address already attached to a DIFFERENT Firebase uid — attaching would
    // throw auth/email-already-exists. Needs a human decision, not a guess.
    const emailOwner = email ? byEmail.get(email) : null;
    if (emailOwner && emailOwner.uid !== uid) {
      blockers.push(`email already on a different Firebase uid ${emailOwner.uid}`);
    }

    let action;
    if (blockers.length)   action = 'BLOCKED';
    else if (!existing)    action = 'CREATE';
    else if (existing.email && existing.email.toLowerCase() === email) action = 'CLAIMS-ONLY';
    else                   action = 'ATTACH';

    plan.push({ uid, email, active, role, name, action, blockers, existing: !!existing });
  });

  const work = ONLY ? plan.filter(p => p.email === ONLY) : plan;
  if (ONLY && !work.length) {
    console.error(`No Firestore user with email ${ONLY} in org ${ORG}.`);
    process.exit(1);
  }

  // ---- report ----
  console.log(pad('ACTION', 12) + pad('EMAIL', 34) + pad('ROLE', 10) + pad('ACTIVE', 8) + 'UID');
  console.log('-'.repeat(110));
  for (const p of work) {
    console.log(
      pad(p.action, 12) + pad(p.email || '<none>', 34) + pad(p.role, 10) +
      pad(p.active ? 'yes' : 'NO', 8) + p.uid
    );
    if (p.blockers.length) p.blockers.forEach(b => console.log(pad('', 12) + '  ↳ BLOCKER: ' + b));
  }

  const counts = work.reduce((m, p) => (m[p.action] = (m[p.action] || 0) + 1, m), {});
  const blocked = work.filter(p => p.action === 'BLOCKED');
  const resetTargets = work.filter(p => p.active && p.action !== 'BLOCKED');

  console.log('\n' + '-'.repeat(78));
  console.log('PLAN:', Object.entries(counts).map(([k, v]) => `${k}=${v}`).join('  '));
  console.log(`Claims to set (${CLAIM_TENANT} / ${CLAIM_ROLE}): ${work.length - blocked.length}`);
  console.log(`Accounts to disable (Firestore active:false): ${work.filter(p => !p.active && p.action !== 'BLOCKED').length}`);
  console.log(`Password-reset emails ${SEND_RESETS ? 'to send' : 'that WOULD be sent with --send-resets'}: ${resetTargets.length} (active users only)`);

  // Firebase Auth records with no matching Firestore doc — not touched, but
  // worth knowing about: they can no longer authenticate and have no profile.
  const orphanShells = authUsers.filter(u => !snap.docs.some(d => d.id === u.uid));
  if (orphanShells.length) {
    console.log(`\nNOTE: ${orphanShells.length} Firebase Auth record(s) have no Firestore user doc (left untouched):`);
    orphanShells.forEach(u => console.log('  ' + u.uid + '  ' + (u.email || '<no email>')));
  }

  if (blocked.length) {
    console.log(`\n!! ${blocked.length} user(s) BLOCKED — resolve the Firestore docs above before applying.`);
  }

  if (!APPLY) {
    console.log('\nDRY RUN — nothing written. Re-run with --apply to execute.');
    process.exit(0);
  }

  if (blocked.length) {
    console.error('\nREFUSING TO APPLY while blockers exist. Fix them, then re-run.');
    process.exit(1);
  }

  // ---- apply ----
  console.log('\nApplying...\n');
  const failures = [];

  for (const p of work) {
    try {
      if (p.action === 'CREATE') {
        // uid pinned to the Firestore doc id — this is what preserves the link
        // to the profile doc and all uid-keyed history.
        await auth.createUser({
          uid: p.uid,
          email: p.email,
          emailVerified: false,
          displayName: p.name || undefined,
          disabled: !p.active,
        });
      } else {
        await auth.updateUser(p.uid, {
          email: p.email,
          displayName: p.name || undefined,
          disabled: !p.active,
        });
      }

      await auth.setCustomUserClaims(p.uid, {
        [CLAIM_TENANT]: ORG,
        [CLAIM_ROLE]:   p.role,
        [CLAIM_NAME]:   p.name || '',
      });

      console.log(`  ok   ${pad(p.action, 12)} ${pad(p.email, 34)} role=${p.role}${p.active ? '' : '  [disabled]'}`);
    } catch (err) {
      failures.push({ ...p, error: err.message });
      console.error(`  FAIL ${pad(p.action, 12)} ${pad(p.email, 34)} ${err.message}`);
    }
  }

  // ---- reset emails ----
  if (SEND_RESETS) {
    console.log('\nSending password-reset emails (active users only)...\n');
    // The Admin SDK can only GENERATE a reset link, not deliver it. The client
    // Web SDK's sendPasswordResetEmail is what makes Firebase send its own
    // templated message, so that is what is used here.
    const { initializeApp: initClient } = require('firebase/app');
    const { getAuth: getClientAuth, sendPasswordResetEmail } = require('firebase/auth');
    const apiKey = process.env.VITE_FIREBASE_API_KEY || process.env.FIREBASE_API_KEY;
    if (!apiKey) {
      console.error('  SKIPPED: set VITE_FIREBASE_API_KEY (web API key) to send reset emails.');
    } else {
      const clientAuth = getClientAuth(initClient({ apiKey, projectId }, 'migration-client'));
      for (const p of resetTargets) {
        if (failures.some(f => f.uid === p.uid)) continue;
        try {
          await sendPasswordResetEmail(clientAuth, p.email);
          console.log('  sent ' + p.email);
        } catch (err) {
          failures.push({ ...p, error: 'reset email: ' + (err.code || err.message) });
          console.error('  FAIL reset email ' + p.email + ' — ' + (err.code || err.message));
        }
        await sleep(400); // stay clear of Firebase's per-project send quota
      }
    }
  }

  // ---- summary ----
  console.log('\n' + '='.repeat(78));
  if (failures.length) {
    console.log(`COMPLETED WITH ${failures.length} FAILURE(S):`);
    failures.forEach(f => console.log(`  ${f.email}  (${f.uid})  ${f.error}`));
    process.exit(1);
  }
  console.log('COMPLETED CLEANLY.');
  if (!SEND_RESETS) {
    console.log('Accounts + claims are in place. Re-run with --send-resets --apply to email users.');
  }
  console.log('Verify: sign in as one user, then check the ID token carries');
  console.log(`  ${CLAIM_TENANT} and ${CLAIM_ROLE}  (Firestore reads will fail if it does not).`);
  console.log('='.repeat(78));
  process.exit(0);
})().catch(err => {
  console.error('\nFATAL:', err);
  process.exit(1);
});
