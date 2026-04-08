import { create } from 'zustand'
import { loadSession, clearSession, getUser, refreshSession, signOut as authSignOut } from '@/lib/auth'
import { signInWithCognito } from '@/lib/firebase'

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
        set({ session: newSession, user: mapUser(attrs), loading: false })
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
      set({ session, user: mapUser(attrs), loading: false })
    } catch {
      clearSession()
      set({ loading: false })
    }
  },

  setAuth: (session, attrs) => {
    set({ session, user: mapUser(attrs), error: null })
  },

  signOut: async () => {
    await authSignOut()
    set({ user: null, session: null })
  },

  setError: (error) => set({ error }),
}))

function mapUser(attrs) {
  return {
    username:    attrs.email || attrs['cognito:username'],
    email:       attrs.email || '',
    name:        attrs['custom:managerName'] || attrs.name || attrs.email || '',
    role:        attrs['custom:role']     || 'viewer',
    tenantId:    attrs['custom:tenantId'] || 'fooda',
  }
}