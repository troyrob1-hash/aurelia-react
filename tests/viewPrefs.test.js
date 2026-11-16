/**
 * Inventory View settings survive sign-out / sign-in.
 *
 * Grouped/A-Z, "Show last week's counts" and "Show variance" are saved to the
 * user's own profile (orgs/{orgId}/users/{uid}.preferences.inventory), loaded
 * on sign-in, and reset to defaults on sign-out. The last describe drives the
 * REAL authStore through onAuthStateChanged against an in-memory Firestore.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { fs, authState } = vi.hoisted(() => ({ fs: new Map(), authState: { cb: null, current: null, viewAtSignOut: null } }))
const deepMerge = (a = {}, b = {}) => {
  const out = { ...a }
  for (const [k, v] of Object.entries(b)) out[k] = v && typeof v === 'object' && !Array.isArray(v) ? deepMerge(a[k], v) : v
  return out
}
vi.mock('firebase/firestore', () => ({
  doc: (_db, ...path) => path.join('/'),
  getDoc: async ref => ({ exists: () => fs.has(ref), data: () => fs.get(ref) }),
  setDoc: vi.fn(async (ref, data, opts) => { fs.set(ref, opts?.merge ? deepMerge(fs.get(ref), data) : data) }),
  serverTimestamp: () => 'ts',
}))
vi.mock('firebase/auth', () => ({ onAuthStateChanged: (_a, cb) => { authState.cb = cb; return () => {} } }))
vi.mock('@/lib/firebase', () => ({ db: {}, auth: { get currentUser() { return authState.current } } }))
vi.mock('@/lib/auth', () => ({
  persistenceReady: Promise.resolve(),
  getClaims: async () => authState.current && { email: authState.current.email, 'custom:tenantId': 'fooda', 'custom:role': 'manager' },
  signOut: async () => {
    const { useUIStore } = await import('../src/store/uiStore')
    authState.viewAtSignOut = useUIStore.getState().inventoryShowPrior
    authState.current = null; await authState.cb?.(null)
  },
}))

import { setDoc } from 'firebase/firestore'
import { useUIStore, INVENTORY_VIEW_DEFAULTS } from '../src/store/uiStore'
import { inventoryViewFromPrefs, inventoryViewToPrefs, startViewPrefsSync, stopViewPrefsSync } from '../src/store/viewPrefsSync'
import { useAuthStore } from '../src/store/authStore'

const view = () => {
  const s = useUIStore.getState()
  return { viewMode: s.inventoryViewMode, showPrior: s.inventoryShowPrior, showVariance: s.inventoryShowVariance }
}
const DEFAULT_VIEW = { viewMode: 'grouped', showPrior: true, showVariance: true }
const flush = () => new Promise(r => setTimeout(r, 0))

beforeEach(() => {
  stopViewPrefsSync()
  fs.clear()
  setDoc.mockClear()
})

describe('stored map ↔ store state', () => {
  it('defaults stay on: grouped, last week shown, variance shown', () => {
    expect(INVENTORY_VIEW_DEFAULTS).toEqual({ inventoryViewMode: 'grouped', inventoryShowPrior: true, inventoryShowVariance: true })
    expect(inventoryViewFromPrefs(undefined)).toEqual(INVENTORY_VIEW_DEFAULTS)
  })
  it('reads stored values, field by field', () => {
    expect(inventoryViewFromPrefs({ viewMode: 'flat', showPrior: false, showVariance: false }))
      .toEqual({ inventoryViewMode: 'flat', inventoryShowPrior: false, inventoryShowVariance: false })
    expect(inventoryViewFromPrefs({ showVariance: false }))
      .toEqual({ ...INVENTORY_VIEW_DEFAULTS, inventoryShowVariance: false })
  })
  it('a malformed value falls back to its default, not to off', () => {
    expect(inventoryViewFromPrefs({ viewMode: 'sideways', showPrior: 'no', showVariance: 0 })).toEqual(INVENTORY_VIEW_DEFAULTS)
    expect(inventoryViewFromPrefs('junk')).toEqual(INVENTORY_VIEW_DEFAULTS)
  })
  it('round-trips', () => {
    const st = { inventoryViewMode: 'flat', inventoryShowPrior: false, inventoryShowVariance: true }
    expect(inventoryViewFromPrefs(inventoryViewToPrefs(st))).toEqual(st)
  })
})

describe('sync lifecycle', () => {
  it('start applies the stored view without writing it back', () => {
    const write = vi.fn()
    startViewPrefsSync({ tenantId: 'fooda', uid: 'u1', preferences: { inventory: { viewMode: 'flat', showPrior: false } }, write })
    expect(view()).toEqual({ viewMode: 'flat', showPrior: false, showVariance: true })
    expect(write).not.toHaveBeenCalled()
  })
  it('each toggle writes the whole inventory map to the signed-in user', () => {
    const write = vi.fn()
    startViewPrefsSync({ tenantId: 'fooda', uid: 'u1', preferences: {}, write })
    useUIStore.getState().setInventoryShowVariance(false)
    expect(write).toHaveBeenLastCalledWith('fooda', 'u1', { viewMode: 'grouped', showPrior: true, showVariance: false })
    useUIStore.getState().setInventoryViewMode('flat')
    useUIStore.getState().setInventoryShowPrior(false)
    expect(write).toHaveBeenCalledTimes(3)
    expect(write).toHaveBeenLastCalledWith('fooda', 'u1', { viewMode: 'flat', showPrior: false, showVariance: false })
  })
  it('setting the same value again does not write', () => {
    const write = vi.fn()
    startViewPrefsSync({ tenantId: 'fooda', uid: 'u1', preferences: {}, write })
    useUIStore.getState().setInventoryShowPrior(true)
    expect(write).not.toHaveBeenCalled()
  })
  it('stop resets to defaults and stops writing', () => {
    const write = vi.fn()
    startViewPrefsSync({ tenantId: 'fooda', uid: 'u1', preferences: { inventory: { viewMode: 'flat', showPrior: false, showVariance: false } }, write })
    stopViewPrefsSync()
    expect(view()).toEqual(DEFAULT_VIEW)
    useUIStore.getState().setInventoryShowPrior(false)
    expect(write).not.toHaveBeenCalled()
  })
  it('a failed save keeps the on-screen choice and only warns', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    startViewPrefsSync({ tenantId: 'fooda', uid: 'u1', preferences: {}, write: () => Promise.reject(new Error('offline')) })
    useUIStore.getState().setInventoryShowPrior(false)
    await flush()
    expect(view().showPrior).toBe(false)
    expect(warn).toHaveBeenCalledWith('[viewPrefs] save failed:', 'offline')
    warn.mockRestore()
  })
  it('the write lands at orgs/{orgId}/users/{uid} as a merge, so the profile is not replaced', async () => {
    fs.set('orgs/fooda/users/u1', { roles: ['manager'], assignedLocations: ['Test Sandbox'] })
    startViewPrefsSync({ tenantId: 'fooda', uid: 'u1', preferences: {} })
    useUIStore.getState().setInventoryShowVariance(false)
    await flush()
    expect(setDoc).toHaveBeenCalledWith('orgs/fooda/users/u1', { preferences: { inventory: { viewMode: 'grouped', showPrior: true, showVariance: false } } }, { merge: true })
    expect(fs.get('orgs/fooda/users/u1')).toMatchObject({ roles: ['manager'], assignedLocations: ['Test Sandbox'], preferences: { inventory: { showVariance: false } } })
  })
})

describe('sign-out / sign-in through the real authStore', () => {
  const signIn = async (uid, email) => { authState.current = { uid, email }; await authState.cb({ uid }) }
  const signOut = () => useAuthStore.getState().signOut()

  it('settings survive signing out and back in; the next user on the terminal gets defaults', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    fs.set('orgs/fooda/users/alice', { roles: ['manager'] })
    fs.set('orgs/fooda/users/bob', { roles: ['manager'] })
    await useAuthStore.getState().init()

    await signIn('alice', 'alice@x.test')
    expect(view()).toEqual(DEFAULT_VIEW)
    useUIStore.getState().setInventoryViewMode('flat')
    useUIStore.getState().setInventoryShowPrior(false)
    useUIStore.getState().setInventoryShowVariance(false)
    await flush()

    await signOut()
    expect(useAuthStore.getState().user).toBeNull()
    expect(view()).toEqual(DEFAULT_VIEW)

    await signIn('bob', 'bob@x.test')
    expect(view()).toEqual(DEFAULT_VIEW)
    await signOut()

    await signIn('alice', 'alice@x.test')
    expect(view()).toEqual({ viewMode: 'flat', showPrior: false, showVariance: false })
    // Alice's profile kept its other fields.
    expect(fs.get('orgs/fooda/users/alice').roles).toEqual(['manager'])
    // Bob never wrote anything.
    expect(fs.get('orgs/fooda/users/bob').preferences).toBeUndefined()
    await signOut()
  })

  it('signed out from another tab (auth state goes null without signOut here): view resets too', async () => {
    fs.set('orgs/fooda/users/alice', { preferences: { inventory: { viewMode: 'flat', showPrior: false, showVariance: false } } })
    await useAuthStore.getState().init()
    await signIn('alice', 'alice@x.test')
    expect(view()).toEqual({ viewMode: 'flat', showPrior: false, showVariance: false })
    authState.current = null
    await authState.cb(null)
    expect(view()).toEqual(DEFAULT_VIEW)
  })

  it('Sign out resets the view before Firebase signs out, so no save can race the sign-out', async () => {
    fs.set('orgs/fooda/users/alice', { preferences: { inventory: { showPrior: false } } })
    await useAuthStore.getState().init()
    await signIn('alice', 'alice@x.test')
    expect(view().showPrior).toBe(false)
    await signOut()
    expect(authState.viewAtSignOut).toBe(true)
  })
})
