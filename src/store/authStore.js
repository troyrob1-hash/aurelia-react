import { create } from 'zustand'
import { loadSession, clearSession, getUser, refreshSession, signOut as authSignOut } from '@/lib/auth'
import { signInWithCognito, db, auth } from '@/lib/firebase'
import { doc, getDoc, updateDoc, serverTimestamp } from 'firebase/firestore'

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
  try {
    const uid = auth.currentUser?.uid
    if (!uid) return user
    const userRef = doc(db, 'orgs', user.tenantId, 'users', uid)
    const snap = await getDoc(userRef)
    if (snap.exists()) {
      const profile = snap.data()
      // Update last login timestamp
      try {
        await updateDoc(userRef, { lastLoginAt: serverTimestamp(), lastLoginIp: null })
      } catch (e) { console.error('lastLoginAt update failed:', e) }
      return {
        ...user,
        uid,
        managedRegionIds: profile.managedRegionIds || [],
        assignedLocations: profile.assignedLocations || [],
        roles: profile.roles || [user.role],
        displayName: profile.displayName || user.name,
      }
    }
  } catch (err) {
    console.error('Failed to load user profile:', err)
  }
  return user
}

function mapUser(attrs) {
  return {
    username:    attrs.email || attrs['cognito:username'],
    email:       attrs.email || '',
    name:        attrs['custom:managerName'] || attrs.name || attrs.email || '',
    role:        attrs['custom:role']     || 'viewer',
    tenantId:    attrs['custom:tenantId'] || 'fooda',
  }
}