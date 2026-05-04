import { initializeApp } from 'firebase/app'
import { getFunctions, httpsCallable } from 'firebase/functions'
import { getAuth, signInWithCustomToken, signOut as firebaseSignOut } from 'firebase/auth'
import { getStorage } from 'firebase/storage'
import { getFirestore, doc, getDoc, setDoc, collection, query, where, getDocs, onSnapshot } from 'firebase/firestore'

const firebaseConfig = {
  apiKey:            import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain:        import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId:         import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket:     import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId:             import.meta.env.VITE_FIREBASE_APP_ID,
}

const app = initializeApp(firebaseConfig)
export const db = getFirestore(app)
export const functions = getFunctions(app)
export const auth = getAuth(app)
export const storage = getStorage(app)

// ── Firebase Auth with Cognito Token ──────────────────────────

/**
 * Exchange Cognito ID token for Firebase custom token and sign in
 */
export async function signInWithCognito(cognitoIdToken) {
  try {
    const mintToken = httpsCallable(functions, 'mintFirebaseToken')
    const result = await mintToken({ idToken: cognitoIdToken })
    const { firebaseToken } = result.data
    
    await signInWithCustomToken(auth, firebaseToken)
    console.log('Firebase Auth: signed in with Cognito token')
    return true
  } catch (err) {
    console.error('Firebase Auth failed:', err)
    return false
  }
}

/**
 * Sign out of Firebase Auth
 */
export async function signOutFirebase() {
  try {
    await firebaseSignOut(auth)
    console.log('Firebase Auth: signed out')
  } catch (err) {
    console.error('Firebase signOut error:', err)
  }
}

// ── Tenant-scoped helpers ─────────────────────────────────────

export function tenantRef(tenantId) {
  return `tenants/${tenantId}`
}

export function locationRef(tenantId, locationId) {
  return `tenants/${tenantId}/locations/${locationId}`
}

export async function dbGet(tenantId, key) {
  const ref = doc(db, 'tenants', tenantId, 'legacy', key)
  const snap = await getDoc(ref)
  return snap.exists() ? snap.data().value : null
}

export async function dbSet(tenantId, key, value) {
  const ref = doc(db, 'tenants', tenantId, 'legacy', key)
  await setDoc(ref, { value, updatedAt: new Date().toISOString() }, { merge: true })
}

export function dbListen(tenantId, key, callback) {
  const ref = doc(db, 'tenants', tenantId, 'legacy', key)
  return onSnapshot(ref, snap => {
    if (snap.exists()) callback(snap.data().value)
  })
}

export { doc, getDoc, setDoc, collection, query, where, getDocs, onSnapshot }