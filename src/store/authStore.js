import { create } from 'zustand'
import { loadSession, clearSession, getUser, refreshSession, signOut as authSignOut } from '@/lib/auth'
import { signInWithCognito, db, auth } from '@/lib/firebase'
import { doc, getDoc, setDoc, updateDoc, serverTimestamp } from 'firebase/firestore'
import { onAuthStateChanged } from 'firebase/auth'

export const useAuthStore = create((set, get) => ({
  user:    null,
  session: null,
  loading: true,
  error:   null,

  init: async () => {
    const session = loadSession()
    if (!session) {
      set({ loading: false })
      return
    }

    if (session.expiresAt - Date.now() < 5 * 60 * 1000) {
      try {
        const newSession = await refreshSession(session.refreshToken)
        const attrs = await getUser(newSession.accessToken)
        const baseUser = mapUser(attrs)
        set({ session: newSession, user: baseUser, loading: false })
        loadProfile(baseUser).then(enriched => set({ user: enriched }))
        return
      } catch {
        clearSession()
        set({ loading: false })
        return
      }
    }

    try {
      const attrs = await getUser(session.accessToken)
      await signInWithCognito(session.idToken)
      const baseUser = mapUser(attrs)
      set({ session, user: baseUser, loading: false })
      loadProfile(baseUser).then(enriched => set({ user: enriched }))
    } catch {
      clearSession()
      set({ loading: false })
    }
  },

  clearAuth: () => set({ user: null, session: null }),
    setAuth: (session, attrs) => {
    const baseUser = mapUser(attrs)
    set({ session, user: baseUser, error: null })
    loadProfile(baseUser).then(enriched => set({ user: enriched }))
  },

  signOut: async () => {
    await authSignOut()
    set({ user: null, session: null })
  },

  setError: (error) => set({ error }),
}))

async function loadProfile(user) {
  if (!user?.tenantId) return user
  // Wait for Firebase auth to actually settle rather than guessing 500ms.
  // On slow networks/cold starts the fixed timer expired before currentUser
  // populated, stranding the user with no roles/regions until a manual reload.
  try { if (auth.authStateReady) await auth.authStateReady() } catch (e) {}
  let uid = auth.currentUser?.uid
  if (!uid) {
    uid = await new Promise(resolve => {
      let done = false
      const finish = (v) => { if (done) return; done = true; resolve(v) }
      const unsub = onAuthStateChanged(auth, (u) => { try { unsub() } catch (e) {}; finish(u?.uid || null) })
      setTimeout(() => { try { unsub() } catch (e) {}; finish(auth.currentUser?.uid || null) }, 4000)
    })
  }
  if (!uid) {
    console.warn('[authStore] No Firebase uid after auth settled — profile (roles/regions) not loaded.')
    return user
  }
  const userRef = doc(db, 'orgs', user.tenantId, 'users', uid)
  try { await setDoc(userRef, { lastLoginAt: serverTimestamp() }, { merge: true }) } catch(e) { console.warn('[authStore] lastLoginAt write failed:', e?.message || e) }
  try {
    const snap = await getDoc(userRef)
    if (snap.exists()) {
      const profile = snap.data()
      return { ...user, uid, managedRegionIds: profile.managedRegionIds || [], assignedLocations: profile.assignedLocations || [], roles: (profile.roles && profile.roles.length) ? profile.roles : (user.role && user.role !== 'viewer' ? [user.role] : []), displayName: profile.displayName || user.name }
    }
  } catch(e) { console.warn('[authStore] profile read failed:', e?.message || e) }
  return { ...user, uid }
}

function mapUser(attrs) {
  // Phase A observability for the 'fooda' silent-fallback bug cluster: log
  // when a real sign-in flow hits the fallback so the affected-user list can
  // be built before Phase B removes the fallback. mintFirebaseToken (Cloud
  // Function) has a matching log + audit-log entry. Fallback is intentionally
  // kept for now to avoid locking out legacy Cognito users whose pool entries
  // pre-date the custom:tenantId attribute.
  const tenantClaim = attrs['custom:tenantId']
  if (!tenantClaim) {
    console.warn(
      '[mapUser] custom:tenantId missing for',
      attrs.email || attrs['cognito:username'] || '<unknown>',
      '— falling back to fooda. Tracked: Phase B will remove this fallback after Cognito backfill.'
    )
  }
  return {
    username:    attrs.email || attrs['cognito:username'],
    email:       attrs.email || '',
    name:        attrs['custom:managerName'] || attrs.name || attrs.email || '',
    role:        attrs['custom:role']     || 'viewer',
    tenantId:    tenantClaim || 'fooda',
  }
}
