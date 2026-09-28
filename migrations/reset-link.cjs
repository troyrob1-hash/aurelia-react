#!/usr/bin/env node
'use strict';

/**
 * ON-DEMAND PASSWORD RESET LINK — one user at a time, for Slack distribution.
 * =========================================================================
 *
 * WHY THIS EXISTS
 * The 2026-09-28 Cognito → Firebase Auth cutover left all 35 active users with
 * no password; they must each set one. The intended path was Firebase's reset
 * email, but delivery fails:
 *   - fooda.com is Microsoft 365 (MX: fooda-com.mail.eo.outlook.com). Exchange
 *     Online Protection silently quarantines mail from the default
 *     *.firebaseapp.com sender (fails DMARC alignment with fooda.com). Dispatch
 *     returns HTTP 200 every time and nothing arrives — 0 of 32 fooda.com users
 *     had set a password after the Step 4 send.
 *   - aurelia.com has NO MX records at all. Those 3 active users cannot receive
 *     mail from any sender, ever. Slack is their only path, permanently —
 *     fixing the SMTP sender will never reach them.
 *
 * So: generate a link here, hand it to the person over Slack. Slack is a
 * legitimate out-of-band channel (arguably stronger proof than email if it's
 * SSO'd); this is substituting one trusted channel for another, not weakening
 * verification.
 *
 * WHY ONE AT A TIME — NOT A BATCH
 * Firebase password-reset oobCodes expire in ~1 hour and that TTL is not
 * configurable. Batch-generating 35 links means most expire before you finish
 * handing them out, and the recipient gets a confusing "invalid code" error
 * rather than a clear "expired". Generate per person, when they ask.
 *
 * Generating a new link for a user INVALIDATES their previous one, so re-running
 * for the same person is safe and is the correct response to "mine expired".
 *
 * USAGE
 *   export GOOGLE_APPLICATION_CREDENTIALS=/path/to/the-grove-70180-sa.json
 *   node migrations/reset-link.cjs someone@fooda.com
 *   node migrations/reset-link.cjs someone@fooda.com --actor troy.robinson@fooda.com
 *
 *   --org <id>     tenant (default: fooda)
 *   --actor <email> who is generating this, recorded in the audit log
 *   --no-audit     skip the audit-log write
 *   --force        generate even if the user already has a password set
 *
 * LONGER TERM this script becomes unnecessary for fooda.com users once either
 * (a) a custom SMTP sender is configured in Firebase Console → Authentication →
 * Templates, or IT allowlists the Firebase sender in EOP — then the already-
 * shipped /forgot flow works on its own; or (b) Microsoft/Entra sign-in is
 * wired up, removing passwords entirely. The 3 aurelia.com users still need
 * this until their domain can receive mail.
 */

const admin = require('firebase-admin');
const crypto = require('crypto');

const argv = process.argv.slice(2);
function flag(name) { return argv.includes(name); }
function opt(name, dflt = null) { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : dflt; }

const EMAIL    = argv.find(a => !a.startsWith('--') && a.includes('@'));
const ORG      = opt('--org', 'fooda');
const ACTOR    = opt('--actor', null);
const NO_AUDIT = flag('--no-audit');
const FORCE    = flag('--force');

const C = { dim: s => `\x1b[2m${s}\x1b[0m`, b: s => `\x1b[1m${s}\x1b[0m`,
            y: s => `\x1b[33m${s}\x1b[0m`, r: s => `\x1b[31m${s}\x1b[0m`, g: s => `\x1b[32m${s}\x1b[0m` };

function usage(msg) {
  if (msg) console.error(C.r('\n' + msg));
  console.error(`
${C.b('Generate a single-use password-reset link for ONE user.')}

  node migrations/reset-link.cjs <email> [options]

  --org <id>       tenant (default: fooda)
  --actor <email>  who is generating this (recorded in the audit log)
  --no-audit       skip the audit-log write
  --force          generate even if the user already has a password

Requires GOOGLE_APPLICATION_CREDENTIALS pointing at a service-account JSON.
One user at a time on purpose — reset codes expire in ~1 hour, so a batch
would expire mid-distribution.
`);
  process.exit(1);
}

if (!EMAIL) usage('Pass the user\'s email address.');
if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  usage('Set GOOGLE_APPLICATION_CREDENTIALS to a service-account JSON for the project.');
}

admin.initializeApp({ credential: admin.credential.applicationDefault() });
const auth = admin.auth();
const db = admin.firestore();

(async () => {
  const email = EMAIL.trim().toLowerCase();

  // ---- who is this? confirm before anything gets pasted into Slack ----
  let user;
  try {
    user = await auth.getUserByEmail(email);
  } catch (err) {
    if (err.code === 'auth/user-not-found') {
      console.error(C.r(`\nNo Firebase Auth account for ${email}.`));
      console.error('Check the address, or confirm they have a doc under ' +
                    `orgs/${ORG}/users (the cutover migration covered 39 accounts).`);
      process.exit(1);
    }
    throw err;
  }

  const claims = user.customClaims || {};
  const snap = await db.collection('orgs').doc(ORG).collection('users').doc(user.uid).get();
  const profile = snap.exists ? snap.data() : null;

  // Whether they've already set a password must come from providerData, NOT
  // passwordHash: getUserByEmail/getUser do not populate passwordHash (only
  // listUsers does), so `user.passwordHash` is always undefined here and any
  // check on it silently reads as "no password" for everyone. A migrated shell
  // has providerData: []; setting a password adds the 'password' provider.
  const hasPassword = (user.providerData || []).some(p => p.providerId === 'password');

  console.log('\n' + C.b('Generating reset link for:'));
  console.log('  name     : ' + (user.displayName || profile?.displayName || C.dim('<none>')));
  console.log('  email    : ' + user.email);
  console.log('  uid      : ' + C.dim(user.uid));
  console.log('  role     : ' + (claims['custom:role'] || C.r('<no role claim>')) +
              C.dim(`   tenant: ${claims['custom:tenantId'] || '<none>'}`));
  console.log('  password : ' + (hasPassword ? C.y('already set') : C.dim('not set yet')));

  // ---- refuse the cases where a link is useless or misleading ----
  if (user.disabled) {
    console.error(C.r('\nREFUSING: this account is disabled in Firebase Auth.'));
    console.error('A reset link would let them set a password but sign-in would still fail.');
    console.error(`Re-enable first (and set active:true on orgs/${ORG}/users/${user.uid}) if that's intended.`);
    process.exit(1);
  }
  if (profile && profile.active === false) {
    console.error(C.r('\nREFUSING: their Firestore user doc has active:false.'));
    console.error('The account is enabled in Auth but deactivated in the app — resolve the');
    console.error('mismatch before handing out a link.');
    process.exit(1);
  }
  if (!claims['custom:tenantId'] || !claims['custom:role']) {
    console.error(C.r('\nREFUSING: missing custom:tenantId / custom:role claim.'));
    console.error('They could set a password but every Firestore read would be denied.');
    console.error('Re-run the cutover migration for this account first.');
    process.exit(1);
  }
  if (hasPassword && !FORCE) {
    console.log(C.y('\nThis user ALREADY has a password set.'));
    console.log('They can sign in at https://aureliafms.com, or self-serve at /forgot.');
    console.log('Only generate a link if they\'ve genuinely forgotten it — re-run with ' + C.b('--force') + '.');
    process.exit(0);
  }

  // ---- generate; this invalidates any previous link for this user ----
  const link = await auth.generatePasswordResetLink(email);
  const expires = new Date(Date.now() + 60 * 60 * 1000);
  const hhmm = expires.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  console.log('\n' + '='.repeat(74));
  console.log(C.b('LINK') + C.dim('  (single-use · credential-bearing · expires ~' + hhmm + ')'));
  console.log('='.repeat(74));
  console.log(link);
  console.log('='.repeat(74));
  console.log(C.y('Treat this like a password.') + ' Anyone holding it can take over this account.');
  console.log('DM it to ' + C.b(user.email) + ' individually — never a channel, never a shared doc.');
  console.log(C.dim('Expires in ~1 hour. Re-run this command for a fresh one; that invalidates this link.'));

  console.log('\n' + C.b('Ready to paste:'));
  console.log(C.dim('─'.repeat(74)));
  console.log(`Hi${user.displayName ? ' ' + String(user.displayName).split(' ')[0] : ''} — Aurelia moved to a new sign-in system, so everyone needs to set a new password once. Our reset emails aren't getting through the mail filter, so here's your link directly:

${link}

Open it, set a password, then sign in at https://aureliafms.com with your email and that password. The link is personal to you and expires in about an hour — if it's stopped working, just ask me for a new one.`);
  console.log(C.dim('─'.repeat(74)));

  // ---- audit: handing out a credential is worth a record ----
  if (!NO_AUDIT) {
    try {
      const eventId = crypto.randomUUID();
      await db.collection('orgs').doc(ORG).collection('auditLog').doc(eventId).set({
        eventId, orgId: ORG,
        actor: {
          uid: 'admin-script',
          email: ACTOR || 'unknown (pass --actor)',
          displayName: 'reset-link.cjs',
          ip: null, userAgent: null,
        },
        action: 'auth.reset_link_generated',
        resourceType: 'user',
        resourceId: user.uid,
        locationId: null,
        // The link itself is deliberately NOT logged — it is a live credential.
        before: null,
        after: { email: user.email, hadPasswordAlready: hasPassword, forced: FORCE },
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      console.log(C.dim('\naudit: orgs/' + ORG + '/auditLog/' + eventId + ' (link value not logged)'));
    } catch (err) {
      console.warn(C.y('\naudit-log write failed (link is still valid): ' + err.message));
    }
  }

  if (!ACTOR) console.log(C.dim('tip: pass --actor <your-email> so the audit entry records who issued it.'));
  console.log(C.g('\nDone.'));
  process.exit(0);
})().catch(err => {
  console.error(C.r('\nFATAL: ' + (err.code ? err.code + ' — ' : '') + err.message));
  process.exit(1);
});
