// "Copy from another site": runCatalogCopy + its real Firestore I/O
// (firestoreCopyIo) against an in-memory Firestore. The target ends up an
// exact copy of the source (items incl. sheet membership, per-sheet positions,
// key flags, par levels; categories; zones), counts/sessions/P&L are never
// touched, the backup is written first, and every guard refuses before any write.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('firebase/firestore', () => import('./helpers/fakeFirestore.js'))
vi.mock('@/lib/firebase', () => ({ db: {}, auth: {} }))

import { store, writes, reset } from './helpers/fakeFirestore.js'
import { runCatalogCopy, firestoreCopyIo, planCatalogCopy, chunk, copyGuardError, sourceSummary, catalogsMatch, COPY_CHUNK } from '../src/lib/catalogCopy'

const T = 'tenants/fooda/inventory'
const W3 = '2026-P11-W3'
const SRC_ITEMS = {
  coke: { name: 'Mexican Coke', category: 'Coke Cooler', countCategories: ['cooler', 'closet'], sheetShelfOrder: { closet: 13 }, catShelfOrder: 4, flatShelfOrder: 9, isKey: true, parLevel: 6, packPrice: 33.17, qtyPerPack: 24, isCatalogItem: true },
  chips: { name: 'Chips', category: 'Cubby', catShelfOrder: 1, flatShelfOrder: 1, packPrice: 12, qtyPerPack: 30, isCatalogItem: true },
  gone: { name: 'Old Item', category: 'Cubby', removed: true, removedBy: 'x', isCatalogItem: true },
  stir: { name: 'Stir Sticks', custom: true, category: 'Cubby', countCategories: ['cubby', 'closet'] },
}
const SRC_CATS = [{ key: 'cooler', label: 'Coke Cooler' }, { key: 'cubby', label: 'Cubby' }, { key: 'closet', label: 'Coke Closet' }]
const SRC_ZONES = [{ key: 'storage', label: 'Storage' }]

function seed() {
  for (const [id, d] of Object.entries(SRC_ITEMS)) store.set(`${T}/SRC/items/${id}`, d)
  store.set(`${T}/SRC/settings/categories`, { categories: SRC_CATS })
  store.set(`${T}/SRC/settings/zones`, { zones: SRC_ZONES })
  // Target: an old catalog, one id shared with the source (different data).
  store.set(`${T}/DST/items/coke`, { name: 'Coke (old)', parLevel: 2, catShelfOrder: 1 })
  store.set(`${T}/DST/items/oldonly`, { name: 'Only at DST', isKey: true, parLevel: 3 })
  store.set(`${T}/DST/settings/categories`, { categories: [{ key: 'general', label: 'General' }] })
  // Past week count + session + P&L at the target: must survive untouched.
  store.set(`${T}/DST/counts/2026-P11-W2/items/id_coke`, { itemId: 'coke', qty: 4 })
  store.set('tenants/fooda/inventorySessions/DST_2026-P11-W2', { startedBy: 'a@x' })
  store.set('tenants/fooda/pnl/DST/periods/2026-P11-W2', { closingValue: 132.68 })
}
const io = () => firestoreCopyIo('fooda', 'troy@x.test')
const run = (o = {}) => runCatalogCopy({ sourceLoc: 'SRC', targetLoc: 'DST', weekKey: W3, locked: false, ...o }, o.io || io())
const items = (loc) => Object.fromEntries([...store.entries()].filter(([p]) => p.startsWith(`${T}/${loc}/items/`)).map(([p, d]) => [p.split('/').pop(), d]))

beforeEach(() => { reset(); seed() })

describe('exact copy', () => {
  it('target items, categories and zones become identical to the source', async () => {
    const r = await run()
    expect(r.status).toBe('done')
    expect(items('DST')).toEqual(items('SRC'))
    expect(items('DST').coke).toEqual(SRC_ITEMS.coke)       // sheet membership, per-sheet position, key, par
    expect(items('DST').gone.removed).toBe(true)             // hidden items carried too
    expect(items('DST').oldonly).toBeUndefined()              // target-only item removed
    expect(store.get(`${T}/DST/settings/categories`)).toEqual({ categories: SRC_CATS })
    expect(store.get(`${T}/DST/settings/zones`)).toEqual({ zones: SRC_ZONES })
    expect(r).toMatchObject({ written: 4, deleted: 1 })
  })

  it('never touches counts, sessions, P&L or the source', async () => {
    const before = new Map(store)
    await run()
    for (const [p, d] of before) {
      if (/\/counts\/|inventorySessions|\/pnl\/|\/SRC\//.test(p)) expect(store.get(p)).toEqual(d)
    }
    expect(writes.filter(w => /\/counts\/|inventorySessions|\/pnl\/|\/SRC\//.test(w.path))).toEqual([])
  })

  it('a source with no zones / categories doc leaves the target with none either (same fallback)', async () => {
    store.delete(`${T}/SRC/settings/zones`)
    store.delete(`${T}/SRC/settings/categories`)
    store.set(`${T}/DST/settings/zones`, { zones: [{ key: 'old' }] })
    const r = await run()
    expect(r.status).toBe('done')
    expect(store.has(`${T}/DST/settings/zones`)).toBe(false)
    expect(store.has(`${T}/DST/settings/categories`)).toBe(false)
  })
})

describe('backup first', () => {
  it('the catalogBackups snapshot + settings backup are written before any change to the item list', async () => {
    const r = await run()
    const firstChange = writes.findIndex(w => w.path.startsWith(`${T}/DST/items/`) || /DST\/settings\/(categories|zones)$/.test(w.path))
    const lastBackup = writes.map((w, i) => (/catalogBackups|catalogBackup-/.test(w.path) ? i : -1)).reduce((a, b) => Math.max(a, b), -1)
    expect(lastBackup).toBeGreaterThanOrEqual(0)
    expect(lastBackup).toBeLessThan(firstChange)
    expect(store.get(`${T}/DST/catalogBackups/${r.backupId}/items/oldonly`)).toEqual({ name: 'Only at DST', isKey: true, parLevel: 3 })
    expect(store.get(`${T}/DST/catalogBackups/${r.backupId}/items/coke`)).toEqual({ name: 'Coke (old)', parLevel: 2, catShelfOrder: 1 })
    expect(store.get(`${T}/DST/settings/catalogBackup-${r.backupId}`)).toMatchObject({ categories: [{ key: 'general', label: 'General' }], zones: null, items: 2, reason: 'copy-from-site' })
  })
})

describe('guards — each refuses before anything is written', () => {
  const noWrites = () => expect(writes).toEqual([])
  it('source and target must differ', async () => {
    const r = await run({ sourceLoc: 'DST' })
    expect(r).toMatchObject({ status: 'refused' }); expect(r.error).toMatch(/onto itself/); noWrites()
  })
  it('locked period', async () => {
    const r = await run({ locked: true })
    expect(r.error).toMatch(/closed/); noWrites()
  })
  it('any count entered for the current week — says so and names the week', async () => {
    store.set(`${T}/DST/counts/${W3}/items/id_chips`, { itemId: 'chips', qty: 1 })
    const r = await run()
    expect(r.status).toBe('refused')
    expect(r.error).toContain(W3)
    expect(r.error).toMatch(/1 item/)
    noWrites()
  })
  it('a legacy (array) count doc for the current week also refuses', async () => {
    store.set(`${T}/DST/counts/${W3}`, { items: [{ id: 'chips', qty: 2 }] })
    const r = await run()
    expect(r.status).toBe('refused'); noWrites()
  })
  it('a source with no items', async () => {
    const r = await run({ sourceLoc: 'EMPTY' })
    expect(r.error).toMatch(/no items/); noWrites()
  })
  it('a failed backup changes nothing and says so', async () => {
    const base = io()
    const r = await run({ io: { ...base, backup: async () => { throw new Error('denied') } } })
    expect(r.status).toBe('refused'); expect(r.error).toMatch(/Nothing was changed/); noWrites()
  })
})

describe('chunked writes and partial failure', () => {
  it('writes go in chunks of at most 400, items first, deletes last', async () => {
    const commits = []
    const big = { items: Array.from({ length: 950 }, (_, i) => ({ id: 'i' + i, data: { name: 'n' + i } })), categories: SRC_CATS, zones: null }
    const fake = {
      countWeek: async () => 0,
      readCatalog: async (loc) => (loc === 'SRC' ? big : commits.length ? big : { items: [{ id: 'old', data: {} }], categories: null, zones: null }),
      backup: async () => 'ts1',
      commit: async (ops) => { commits.push(ops) },
    }
    const r = await runCatalogCopy({ sourceLoc: 'SRC', targetLoc: 'DST', weekKey: W3, locked: false }, fake)
    expect(r.status).toBe('done')
    expect(commits.map(c => c.length)).toEqual([400, 400, 153])
    expect(commits.every(c => c.length <= COPY_CHUNK)).toBe(true)
    const flat = commits.flat()
    expect(flat.at(-1)).toEqual({ type: 'delete', path: 'items/old' })
    expect(flat.findIndex(o => o.type === 'delete' && o.path.startsWith('items/'))).toBeGreaterThan(flat.findLastIndex(o => o.type === 'set' && o.path.startsWith('items/')))
  })

  it('a write that fails partway: failed (never done), and the message points to the backup', async () => {
    const base = io()
    let n = 0
    const flaky = { ...base, commit: async (ops) => { if (++n === 1) return base.commit(ops); throw new Error('network') } }
    const many = Array.from({ length: 500 }, (_, i) => [`${T}/SRC/items/x${i}`, { name: 'x' + i }])
    for (const [p, d] of many) store.set(p, d)
    const r = await run({ io: flaky })
    expect(r.status).toBe('failed')
    expect(r.error).toMatch(/stopped partway/)
    expect(r.error).toContain(r.backupId)
    expect(store.get(`${T}/DST/catalogBackups/${r.backupId}/items/oldonly`)).toBeTruthy()
  })

  it('a result that does not match the source is reported as failed, not done', async () => {
    const base = io()
    const lossy = { ...base, commit: async (ops) => base.commit(ops.filter(o => o.path !== 'items/chips')) }
    const r = await run({ io: lossy })
    expect(r.status).toBe('failed')
    expect(r.error).toMatch(/doesn't match the source/)
  })
})

describe('helpers', () => {
  it('copyGuardError, sourceSummary, planCatalogCopy, chunk, catalogsMatch', () => {
    expect(copyGuardError({ sourceLoc: 'A', targetLoc: 'B', locked: false, weekKey: W3, weekCounts: 0 })).toBeNull()
    expect(copyGuardError({ sourceLoc: '', targetLoc: 'B' })).toMatch(/Pick a site/)
    expect(sourceSummary({ items: [{ id: 'a', data: {} }, { id: 'b', data: { removed: true } }], categories: [1, 2, 3] })).toEqual({ items: 1, sheets: 3, docs: 2 })
    const plan = planCatalogCopy({ items: [{ id: 'a', data: { n: 1 } }], categories: null, zones: [{ key: 'z' }] }, { items: [{ id: 'a', data: {} }, { id: 'b', data: {} }] })
    expect(plan).toEqual([
      { type: 'set', path: 'items/a', data: { n: 1 } },
      { type: 'delete', path: 'settings/categories' },
      { type: 'set', path: 'settings/zones', data: { zones: [{ key: 'z' }] } },
      { type: 'delete', path: 'items/b' },
    ])
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]])
    const cat = { items: [{ id: 'a', data: { x: 1, y: 2 } }], categories: [1], zones: null }
    expect(catalogsMatch(cat, { items: [{ id: 'a', data: { y: 2, x: 1 } }], categories: [1], zones: null })).toBe(true)
    expect(catalogsMatch(cat, { items: [{ id: 'a', data: { x: 1 } }], categories: [1], zones: null })).toBe(false)
    expect(catalogsMatch(cat, { ...cat, zones: [] })).toBe(false)
  })
})
