import { create } from 'zustand'
import { getClaims, persistenceReady, signOut as authSignOut } from '@/lib/auth'
import { db, auth } from '@/lib/firebase'
import { doc, getDoc, setDoc, serverTimestamp } from 'firebase/firestore'
import { onAuthStateChanged } from 'firebase/auth'

/**
 * CUTOVER 2026-09-28 (Cognito → Firebase Auth):
 *
 * `init` used to hand-roll the session lifecycle against Cognito — read a
 * sessionStorage blob, compare `expiresAt` to now, call `refreshSession` if it
 * was inside a 5-minute window, `getUser(accessToken)` for attributes, then
 * bridge to Firebase. All of that is gone. The Firebase SDK persists the
 * session and refreshes the ID token on its own; `onAuthStateChanged` is the
 * single source of truth and fires on restore, sign-in, sign-out, token
 * refresh, and sign-out in another tab.
 *
 * The `session` field was dropped from the store: nothing consumes it now that
 * `changePassword` no longer needs an access token.
 */

let unsubAuth = null

export const useAuthStore = create((set, get) => ({
  user:    null,
  loading: true,
  error:   null,

  init: async () => {
    // Guard StrictMode's double-invoked effect — a second subscription would
    // race the first and could flip `user` back to a stale value.
    if (unsubAuth) return
    await persistenceReady

    unsubAuth = onAuthStateChanged(auth, async (fbUser) => {
      if (!fbUser) {
        set({ user: null, loading: false })
        return
      }
      try {
        await get().hydrate()
      } catch (e) {
        console.warn('[authStore] hydrate failed:', e?.message || e)
        set({ user: null, loading: false })
      }
    })
  },

  /**
   * Build the app user from ID-token claims, then enrich from Firestore.
   * Idempotent, and called from two places on purpose: `onAuthStateChanged`
   * (restore / cross-tab) and `LoginPage` immediately after sign-in.
   *
   * LoginPage awaits this before navigating so it cannot lose the race against
   * ProtectedRoute — without it, `nav('/')` can run while `user` is still null
   * and bounce the user straight back to /login.
   */
  hydrate: async () => {
    const claims = await getClaims()
    if (!claims) { set({ user: null, loading: false }); return null }
    const baseUser = mapUser(claims)
    set({ user: baseUser, loading: false, error: null })
    const enriched = await loadProfile(baseUser)
    set({ user: enriched })
    return enriched
  },

  clearAuth: () => set({ user: null }),

  signOut: async () => {
    await authSignOut()
    set({ user: null })
  },

  setError: (error) => set({ error }),
}))

async function loadProfile(user) {
  if (!user?.tenantId) return user
  // Post-cutover this is simpler than it was: sign-in and the Firebase user
  // record are now the same event, so `auth.currentUser` is already populated
  // by the time onAuthStateChanged fires. The old wait-for-uid dance (
  // authStateReady + an onAuthStateChanged race with a 4s timeout) existed
  // because the Cognito sign-in and the Firebase custom-token sign-in were two
  // separate async hops and the second could still be in flight here.
  const uid = auth.currentUser?.uid
  if (!uid) {
    console.warn('[authStore] No Firebase uid — profile (roles/regions) not loaded.')
    return user
  }
  const userRef = doc(db, 'orgs', user.tenantId, 'users', uid)
  try { await setDoc(userRef, { lastLoginAt: serverTimestamp() }, { merge: true }) } catch(e) { console.warn('[authStore] lastLoginAt write failed:', e?.message || e) }
  try {
    const snap = await getDoc(userRef)
    if (snap.exists()) {
      const profile = snap.data()
      // AUTHORITY INVERSION — deliberate, 2026-09-28 cutover.
      //
      // Before: Cognito's `custom:role` attribute was authoritative and the
      // Firestore `roles[]` array was explicitly a non-authoritative display
      // mirror, not read for permission decisions.
      //
      // After: the Firestore user doc is the source of record. The
      // `custom:role` claim still exists and is still what `firestore.rules`
      // enforces on — but it is now *seeded from this document* by
      // `migrations/migrate-cognito-to-firebase-auth.cjs` (and, once ported,
      // by `updateUserRoles`). Firestore writes the claim; the claim gates the
      // rules. Same enforcement point, opposite direction of authority.
      //
      // `roles[]` is still not read here. `user.role` (singular, now
      // claim-sourced-from-Firestore) remains the field permissions.js reads,
      // so the client/rules agreement is unchanged. The consequence to know:
      // editing the Firestore doc alone no longer changes access — the claim
      // must be re-set and the user's ID token refreshed for it to take effect.
      return { ...user, uid, managedRegionIds: profile.managedRegionIds || [], assignedLocations: profile.assignedLocations || [], displayName: profile.displayName || user.name }
    }
  } catch(e) { console.warn('[authStore] profile read failed:', e?.message || e) }
  return { ...user, uid }
}

/**
 * Map Firebase ID-token claims → app user.
 *
 * Reads the SAME claim keys the Cognito bridge used to mint (`custom:tenantId`,
 * `custom:role`) — they are now persistent Firebase custom claims set by the
 * migration. `email` and `name` are native Firebase ID-token fields sourced
 * from the user record's email / displayName.
 */
function mapUser(claims) {
  // The 'fooda' silent-fallback cluster (CLAUDE.md, Phase B): every account
  // touched by the cutover migration gets an explicit `custom:tenantId`, so
  // this fallback should now be unreachable. It is kept one release longer —
  // during an outage recovery, a missing claim degrading to the only tenant
  // that exists beats hard-locking a manager out — but it warns loudly, and
  // Phase B (removing it) is now a clean follow-up rather than a blocked one,
  // since there is no longer a Cognito pool to backfill first.
  const tenantClaim = claims['custom:tenantId']
  if (!tenantClaim) {
    console.warn(
      '[mapUser] custom:tenantId missing for',
      claims.email || claims.user_id || '<unknown>',
      '— falling back to fooda. Expected unreachable post-cutover; if you see this, the migration missed an account.'
    )
  }
  return {
    username: claims.email || '',
    email:    claims.email || '',
    name:     claims['custom:name'] || claims.name || claims.email || '',
    role:     claims['custom:role'] || 'viewer',
    tenantId: tenantClaim || 'fooda',
  }
}
