// In-memory stand-in for 'firebase/firestore' used by page-level tests.
//   vi.mock('firebase/firestore', () => import('./helpers/fakeFirestore.js'))
// Reads return what `store` holds; writes land in `store` and are logged in
// `writes`. `control.failWrites = true` makes every write reject — a save that
// fails, as when the network drops mid-save.
export const store = new Map()
export const writes = []
export const control = { failWrites: false }
let autoId = 0

export function reset() {
  store.clear(); writes.length = 0; control.failWrites = false; autoId = 0
}

const ref = (base, ...segs) => ({ path: [...(base?.path ? [base.path] : []), ...segs].join('/') })
const snapOf = (path) => ({ id: path.split('/').pop(), ref: { path }, exists: () => store.has(path), data: () => store.get(path) })
const matches = (data, filters) => filters.every(([f, op, v]) =>
  op === '==' ? data?.[f] === v : op === 'in' ? v.includes(data?.[f]) : true)

function record(op, r, data, merge) {
  if (control.failWrites) throw new Error('unavailable (test: writes failing)')
  writes.push({ op, path: r.path, data })
  if (op === 'delete') { store.delete(r.path); return }
  const prev = store.get(r.path) || {}
  store.set(r.path, merge || op === 'update' ? deepMerge(prev, data) : { ...data })
}
function deepMerge(a, b) {
  const out = { ...a }
  for (const [k, v] of Object.entries(b || {})) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date) && out[k] && typeof out[k] === 'object'
      ? deepMerge(out[k], v) : v
  }
  return out
}

export const doc = ref
export const collection = ref
export const where = (f, op, v) => ({ where: [f, op, v] })
export const orderBy = () => ({})
export const limit = () => ({})
export const documentId = () => '__id__'
export const query = (r, ...cs) => ({ path: r.path, filters: cs.filter(c => c.where).map(c => c.where) })
export const getDoc = async (r) => snapOf(r.path)
export const getDocs = async (r) => {
  const depth = r.path.split('/').length + 1
  const docs = [...store.keys()]
    .filter(p => p.startsWith(r.path + '/') && p.split('/').length === depth)
    .map(snapOf)
    .filter(s => matches(s.data(), r.filters || []))
  return { empty: docs.length === 0, size: docs.length, docs, forEach: fn => docs.forEach(fn) }
}
export const setDoc = async (r, data, opts) => record('set', r, data, !!opts?.merge)
export const updateDoc = async (r, data) => record('update', r, data)
export const addDoc = async (c, data) => { const r = { path: `${c.path}/auto${++autoId}` }; record('set', r, data); return { id: `auto${autoId}`, path: r.path } }
export const deleteDoc = async (r) => record('delete', r)
export const writeBatch = () => {
  const ops = []
  return {
    set: (r, d, o) => ops.push(['set', r, d, !!o?.merge]),
    update: (r, d) => ops.push(['update', r, d]),
    delete: (r) => ops.push(['delete', r]),
    commit: async () => { for (const [op, r, d, m] of ops) record(op, r, d, m) },
  }
}
export const onSnapshot = () => () => {}
export const serverTimestamp = () => new Date('2026-11-18T12:00:00Z')
export const deleteField = () => undefined
export const arrayUnion = (...v) => v
export const arrayRemove = () => []
export const increment = (n) => n
export class Timestamp { static now() { return new Date() } }
