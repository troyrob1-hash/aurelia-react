/**
 * Authentication — Firebase Auth (email/password), native.
 *
 * CUTOVER 2026-09-28: this module previously spoke to an AWS Cognito user pool
 * (us-east-2_O2djCRxsH) over raw `cognito-idp` REST, then exchanged the Cognito
 * ID token for a Firebase custom token via the `mintFirebaseToken` Cloud
 * Function. The AWS subscription lapsed, the pool and its app client were
 * deleted, and every login started failing with `ResourceNotFoundException` —
 * Cognito was a hard dependency for 100% of sign-ins AND for session restore.
 *
 * Firebase Auth was already the real session layer (the app has always run on
 * `signInWithCustomToken`; firestore.rules has always enforced on Firebase
 * claims). Cognito was only a password-checker bolted on the front. This module
 * now checks passwords directly against Firebase, and the token bridge is gone.
 *
 * Claim shape is UNCHANGED and deliberately so — see `migrations/
 * migrate-cognito-to-firebase-auth.cjs`, which sets `custom:tenantId` /
 * `custom:role` as Firebase custom claims with the exact keys
 * `firestore.rules` already reads. Rules needed no changes.
 *
 * Gone with Cognito (no Firebase equivalent, callers updated):
 *   - saveSession/loadSession/clearSession/getAuthHeaders — the Firebase SDK
 *     owns token storage and refresh. There is no hand-rolled session object.
 *   - refreshSession — automatic (SDK refreshes the ID token ~hourly).
 *   - completeNewPassword — Cognito's NEW_PASSWORD_REQUIRED challenge has no
 *     Firebase analogue; first-time users go through the password-reset email.
 *   - confirmSignUp / confirmForgotPassword — Firebase's reset flow is a signed
 *     emailed link, not a 6-digit code the app verifies.
 */

import {
  signInWithEmailAndPassword,
  sendPasswordResetEmail,
  updatePassword,
  reauthenticateWithCredential,
  EmailAuthProvider,
  setPersistence,
  browserSessionPersistence,
  signOut as firebaseSignOut,
} from 'firebase/auth'
import { auth } from './firebase'

/**
 * Persistence: sessionStorage-scoped, matching the pre-cutover Cognito
 * behavior exactly (the old `saveSession` wrote to `sessionStorage`, so closing
 * the tab ended the session). Firebase's own default is `browserLocalPersistence`
 * — which would silently turn this into a stay-signed-in-forever app on the
 * shared back-of-house terminals managers use. That is a product decision, not
 * a cutover detail, so it is NOT being made here. To change it later, swap in
 * `browserLocalPersistence`; nothing else in the app depends on the choice.
 *
 * Awaited by `signIn` and by `authStore.init` — setting persistence after a
 * sign-in has already landed would not retroactively move the token.
 */
export const persistenceReady = setPersistence(auth, browserSessionPersistence)
  .catch(err => {
    // Non-fatal: falls back to the SDK default rather than blocking login.
    console.warn('[auth] setPersistence failed, using SDK default:', err?.message || err)
  })

/**
 * Read the signed-in user's claims off the Firebase ID token.
 *
 * These are the same claims `mintFirebaseToken` used to mint into a custom
 * token; they are now persistent custom claims on the user record, so they ride
 * on every ID token automatically and survive refresh.
 *
 * @param {boolean} forceRefresh force a token refresh (use after a role change)
 * @returns {Promise<object|null>} raw claims, or null if signed out
 */
export async function getClaims(forceRefresh = false) {
  const u = auth.currentUser
  if (!u) return null
  const res = await u.getIdTokenResult(forceRefresh)
  return res.claims
}

/**
 * Sign in with email + password.
 * On success the SDK persists the session and fires onAuthStateChanged;
 * `authStore` hydrates from there.
 *
 * @returns {Promise<{type:'success', claims:object}>}
 */
export async function signIn(email, password) {
  await persistenceReady
  const cred = await signInWithEmailAndPassword(auth, email, password)
  const res = await cred.user.getIdTokenResult()
  return { type: 'success', claims: res.claims }
}

/**
 * Send a password-reset email. Firebase sends and templates the message and
 * hosts the reset page — there is no code for the app to verify, which is why
 * the old two-step `forgotPassword` + `confirmForgotPassword` pair collapsed
 * into this one call.
 *
 * Deliberately does NOT surface whether the address exists: Firebase returns
 * `auth/user-not-found` here, and echoing that to an unauthenticated form is an
 * account-enumeration oracle. ForgotPage shows the same confirmation either way.
 */
export async function forgotPassword(email) {
  await sendPasswordResetEmail(auth, email)
}

/**
 * Change the password of the currently signed-in user.
 *
 * Firebase requires a recent login for this; `updatePassword` throws
 * `auth/requires-recent-login` on a stale session. Reauthenticating with the
 * current password first both satisfies that and preserves the old Cognito
 * behavior of proving you know the existing password.
 *
 * NOTE: signature changed — was `changePassword(accessToken, old, new)` when
 * the access token came from the Cognito session. The caller (AppShell) no
 * longer has or needs a token.
 */
export async function changePassword(currentPassword, newPassword) {
  const u = auth.currentUser
  if (!u) throw new Error('Not signed in.')
  if (!u.email) throw new Error('This account has no email address on file.')
  const cred = EmailAuthProvider.credential(u.email, currentPassword)
  await reauthenticateWithCredential(u, cred)
  await updatePassword(u, newPassword)
}

export async function signOut() {
  await firebaseSignOut(auth)
}

/**
 * Map a Firebase auth error to something a human should read.
 *
 * `auth/invalid-credential` is the modern catch-all: with email-enumeration
 * protection on, Firebase deliberately collapses wrong-password and
 * no-such-user into it. Do not try to un-collapse that.
 */
export function friendlyAuthError(err) {
  const code = err?.code || ''
  switch (code) {
    case 'auth/invalid-credential':
    case 'auth/wrong-password':
    case 'auth/user-not-found':
      return 'Incorrect email or password.'
    case 'auth/invalid-email':
      return 'That email address is not valid.'
    case 'auth/user-disabled':
      return 'This account has been deactivated. Contact your administrator.'
    case 'auth/too-many-requests':
      return 'Too many attempts. Wait a few minutes and try again.'
    case 'auth/network-request-failed':
      return 'Network error. Check your connection and try again.'
    case 'auth/requires-recent-login':
      return 'For security, please sign out and back in before changing your password.'
    case 'auth/weak-password':
      return 'Password is too weak — use at least 8 characters.'
    case 'auth/operation-not-allowed':
      // Email/Password provider disabled in the Firebase console.
      return 'Email sign-in is not enabled for this project. Contact your administrator.'
    default:
      return err?.message || 'Sign in failed. Please try again.'
  }
}
