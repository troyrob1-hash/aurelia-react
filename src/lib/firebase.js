import { initializeApp } from 'firebase/app'
import { getFunctions } from 'firebase/functions'
import { getAuth } from 'firebase/auth'
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

// ── Auth ──────────────────────────────────────────────────────
// `signInWithCognito` / `signOutFirebase` were removed in the 2026-09-28
// Cognito→Firebase Auth cutover. The Cognito ID token → `mintFirebaseToken`
// → `signInWithCustomToken` bridge no longer exists; `src/lib/auth.js` signs
// in against Firebase directly and owns every auth entry point.

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