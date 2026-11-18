/**
 * Sign-in profile load: retry, then fail visibly — never silently empty.
 *
 * loadProfile reads orgs/{orgId}/users/{uid} for the user's regions and
 * assigned locations. A failed read used to log a warning and carry on with no
 * locations, so a manager saw empty pages with no explanation. Now the read is
 * retried (3 attempts, short backoff) and a final failure flags the user with
 * profileLoadFailed, which AllLocationsGrid turns into a visible message.
 *
 * Also pins that the saved View settings (PR #13) can't break the load: a
 * record with no or malformed preferences still loads its locations, and a
 * throw from the View settings sync can't sign the user out.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const { fs, state } = vi.hoisted(() => ({
  fs: new Map(),
  state: { current: null, cb: null, failReads: 0, syncThrows: false },
}))
vi.mock('firebase/firestore', () => ({
  doc: (_db, ...path) => path.join('/'),
  getDoc: vi.fn(async ref => {
    if (state.failReads > 0) { state.failReads--; throw new Error('unavailable') }
    return { exists: () => fs.has(ref), data: () => fs.get(ref) }
  }),
  setDoc: vi.fn(async () => {}),
  serverTimestamp: () => 'ts',
}))
vi.mock('firebase/auth', () => ({ onAuthStateChanged: (_a, cb) => { state.cb = cb; return () => {} } }))
vi.mock('@/lib/firebase', () => ({ db: {}, auth: { get currentUser() { return state.current } } }))
vi.mock('@/lib/auth', () => ({
  persistenceReady: Promise.resolve(),
  getClaims: async () => state.current && { email: state.current.email, 'custom:tenantId': 'fooda', 'custom:role': 'manager' },
  signOut: async () => {},
}))
vi.mock('../src/store/viewPrefsSync', async importOriginal => {
  const real = await importOriginal()
  return {
    ...real,
    startViewPrefsSync: vi.fn(args => {
      if (state.syncThrows) throw new Error('sync blew up')
      return real.startViewPrefsSync(args)
    }),
  }
})

import { getDoc, setDoc } from 'firebase/firestore'
import { useAuthStore, PROFILE_READ_RETRY_DELAYS_MS } from '../src/store/authStore'
import { startViewPrefsSync, stopViewPrefsSync } from '../src/store/viewPrefsSync'
import { useUIStore } from '../src/store/uiStore'
import { getVisibleLocationsForUser } from '../src/lib/permissions'

// John's real record shape (2026-11-18): manager, one ad-hoc location, no
// regions, and no saved View settings.
const JOHN = {
  role: 'manager', roles: ['manager'], displayName: 'John Newman', active: true,
  assignedLocations: ['CR_Southwest Airlines'], managedRegionIds: [],
}
const LOCS = [{ name: 'CR_Best Buy' }, { name: 'CR_Southwest Airlines' }, { name: 'Test Sandbox' }]

const signInAs = (uid, profile) => {
  if (profile !== undefined) fs.set(`orgs/fooda/users/${uid}`, profile)
  state.current = { uid, email: `${uid}@x.test` }
}

let warn
beforeEach(() => {
  fs.clear()
  state.current = null; state.failReads = 0; state.syncThrows = false
  getDoc.mockClear(); setDoc.mockClear(); startViewPrefsSync.mockClear()
  stopViewPrefsSync()
  useAuthStore.setState({ user: null, loading: true, error: null })
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => { vi.useRealTimers(); warn.mockRestore() })

describe('retry with short backoff', () => {
  it('3 attempts: waits 250 ms then 750 ms between them', () => {
    expect(PROFILE_READ_RETRY_DELAYS_MS).toEqual([250, 750])
  })

  it('two failed reads, then success: locations load, no error flag', async () => {
    vi.useFakeTimers()
    signInAs('john', JOHN)
    state.failReads = 2
    let done = false
    const p = useAuthStore.getState().hydrate().then(u => { done = true; return u })

    await vi.advanceTimersByTimeAsync(249)
    expect(getDoc).toHaveBeenCalledTimes(1)
    expect(done).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(getDoc).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(749)
    expect(getDoc).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)

    const user = await p
    expect(getDoc).toHaveBeenCalledTimes(3)
    expect(user.assignedLocations).toEqual(['CR_Southwest Airlines'])
    expect(user.profileLoadFailed).toBeUndefined()
    expect(useAuthStore.getState().user).toBe(user)
  })

  it('a first-try success reads once and never waits', async () => {
    signInAs('john', JOHN)
    const user = await useAuthStore.getState().hydrate()
    expect(getDoc).toHaveBeenCalledTimes(1)
    expect(user.assignedLocations).toEqual(['CR_Southwest Airlines'])
  })
})

describe('all attempts fail', () => {
  async function hydrateFailing() {
    vi.useFakeTimers()
    signInAs('john', JOHN)
    state.failReads = 99
    const p = useAuthStore.getState().hydrate()
    await vi.advanceTimersByTimeAsync(1000)
    return p
  }

  it('stops after 3 reads and flags the user, instead of a silent empty profile', async () => {
    const user = await hydrateFailing()
    expect(getDoc).toHaveBeenCalledTimes(3)
    expect(user.profileLoadFailed).toBe(true)
    expect(user.assignedLocations).toBeUndefined()
    expect(useAuthStore.getState().user.profileLoadFailed).toBe(true)
    expect(warn).toHaveBeenCalledWith('[authStore] profile read failed:', 'unavailable')
  })

  it('the user stays signed in (the flag is shown, not a bounce to /login)', async () => {
    const user = await hydrateFailing()
    expect(useAuthStore.getState().user).toBe(user)
    expect(user.uid).toBe('john')
    expect(user.tenantId).toBe('fooda')
  })

  it('saved View settings are left alone: no sync, so a toggle cannot overwrite them with defaults', async () => {
    await hydrateFailing()
    expect(startViewPrefsSync).not.toHaveBeenCalled()
    setDoc.mockClear()
    useUIStore.getState().setInventoryShowPrior(false)
    expect(setDoc).not.toHaveBeenCalled()
  })

  it('through onAuthStateChanged too (page restore), not just LoginPage', async () => {
    vi.useFakeTimers()
    await useAuthStore.getState().init()
    signInAs('john', JOHN)
    state.failReads = 99
    const p = state.cb({ uid: 'john' })
    await vi.advanceTimersByTimeAsync(1000)
    await p
    expect(useAuthStore.getState().user).toMatchObject({ uid: 'john', profileLoadFailed: true })
  })
})

describe('saved View settings (PR #13) cannot cost a user their locations', () => {
  it("John's record — no preferences at all — loads his location, and the grid would list it", async () => {
    signInAs('john', JOHN)
    const user = await useAuthStore.getState().hydrate()
    expect(user).toMatchObject({ assignedLocations: ['CR_Southwest Airlines'], managedRegionIds: [], preferences: {} })
    expect(user.profileLoadFailed).toBeUndefined()
    expect(getVisibleLocationsForUser(user, LOCS).map(l => l.name)).toEqual(['CR_Southwest Airlines'])
    expect(startViewPrefsSync).toHaveBeenCalledWith({ tenantId: 'fooda', uid: 'john', preferences: {} })
  })

  it.each([
    ['null', null],
    ['a string', 'junk'],
    ['inventory: null', { inventory: null }],
    ['inventory: a string', { inventory: 'grouped' }],
    ['inventory with bad values', { inventory: { viewMode: 'sideways', showPrior: 'yes' } }],
    ['other keys only', { sales: { viewMode: 'flat' } }],
  ])('preferences = %s still loads the locations', async (_label, preferences) => {
    signInAs('john', { ...JOHN, preferences })
    const user = await useAuthStore.getState().hydrate()
    expect(user.assignedLocations).toEqual(['CR_Southwest Airlines'])
    expect(user.profileLoadFailed).toBeUndefined()
    expect(getVisibleLocationsForUser(user, LOCS).map(l => l.name)).toEqual(['CR_Southwest Airlines'])
  })

  it('saved settings are applied AFTER the user (with locations) is set', async () => {
    signInAs('john', { ...JOHN, preferences: { inventory: { viewMode: 'flat' } } })
    let userAtSync
    startViewPrefsSync.mockImplementationOnce(() => { userAtSync = useAuthStore.getState().user })
    await useAuthStore.getState().hydrate()
    expect(userAtSync.assignedLocations).toEqual(['CR_Southwest Airlines'])
  })

  it('a throw from the View settings sync keeps the user signed in with their locations', async () => {
    await useAuthStore.getState().init()
    signInAs('john', JOHN)
    state.syncThrows = true
    await state.cb({ uid: 'john' })
    expect(useAuthStore.getState().user).toMatchObject({ uid: 'john', assignedLocations: ['CR_Southwest Airlines'] })
    expect(warn).toHaveBeenCalledWith('[authStore] view settings not applied:', 'sync blew up')
  })
})
