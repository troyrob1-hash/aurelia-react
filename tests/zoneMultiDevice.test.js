/**
 * MULTI-DEVICE zone counting — Stage 1 prerequisite for multi-category sheets.
 *
 * With category sheets, two people counting different sheets of the SAME item
 * at once is the normal case. Before this fix:
 *   - every save re-sent the item's WHOLE zones map from the local copy, so
 *     device B's stale copy of the cooler overwrote device A's fresh count;
 *   - the live listener carried only the top-level total, never zones, and a
 *     touched item ignored remote updates entirely — so A never learned B's
 *     zone and kept deriving a wrong total;
 *   - sweeps/sections were written by re-sending the whole local session, so a
 *     device could un-sweep a colleague's zone (and did so again at close).
 *
 * The headline test drives the REAL write and merge code against a fake
 * Firestore that applies set(..., {merge:true}) the way Firestore does
 * (nested maps merge key-by-key; deleteField removes; no-merge replaces).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const DEL = { __deleteField: true }
let store = {}
let ops = []

vi.mock('firebase/firestore', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    doc: vi.fn((col, id) => ({ id })),
    deleteField: () => DEL,
    serverTimestamp: () => 'TS',
    writeBatch: vi.fn(() => ({
      set: (ref, data, opts) => ops.push({ type: 'set', id: ref.id, data, merge: !!opts?.merge }),
      delete: (ref) => ops.push({ type: 'delete', id: ref.id }),
      commit: async () => { for (const op of ops.splice(0)) applyOp(op) },
    })),
    updateDoc: vi.fn(async (ref, data) => {
      if (!store[ref.id]) throw Object.assign(new Error('nf'), { code: 'not-found' })
      store[ref.id] = mergeDeep(store[ref.id], data)
    }),
  }
})

const isMap = v => v && typeof v === 'object' && !Array.isArray(v) && v !== DEL
function mergeDeep(target, src) {
  const out = { ...(target || {}) }
  for (const [k, v] of Object.entries(src)) {
    if (v === DEL) delete out[k]
    else if (isMap(v) && isMap(out[k])) out[k] = mergeDeep(out[k], v)
    else out[k] = v
  }
  return out
}
function applyOp(op) {
  if (op.type === 'delete') { delete store[op.id]; return }
  store[op.id] = op.merge ? mergeDeep(store[op.id], op.data) : mergeDeep({}, op.data)
}

import {
  buildCountWrite, buildZonePayload, zonesWrite, persistCountItems, countDocId,
  applyRemoteCountPatch, staleDerivedTotals, persistDerivedTotals, itemValue,
} from '../src/hooks/useInventory'
import { remoteZones } from '../src/hooks/useCountsListener'
import { mergeRemoteZones } from '../src/lib/zones'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const code = p => readFileSync(resolve(ROOT, p), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
const SRC = code('src/hooks/useInventory.js')

const ZONES = [{ key: 'cooler', label: 'Coffee Bar' }, { key: 'storage', label: 'BOH' }]
const base = { id: 'milk', name: 'Oat milk', qtyPerPack: 12, packPrice: 24 }   // $2 / each
const ID = countDocId('milk')

// What the live listener hands to onRemote for a stored doc.
const listenerPatch = d => ({
  qty: d.qty ?? null, eaches: d.eaches ?? 0, lastCountedAt: null, lastCountedBy: null,
  zones: remoteZones(d.zones), storedTotal: d.eaches ?? null,
})
// The server-side valuation (functions/index.js) reads ONLY the stored top-level.
const cfValue = d => ((Number(d.qty) || 0) * 24) + ((Number(d.eaches) || 0) * 2)

beforeEach(() => {
  ops = []
  store = { [ID]: { itemId: 'milk', qty: null, eaches: 24, qtyPerPack: 12, packPrice: 24,
    zones: { cooler: { qty: 1, eaches: 0 }, storage: { qty: 1, eaches: 0 } } } }
})

describe('HEADLINE — two devices, two sheets, one item', () => {
  // Both loaded {cooler: 1 pack, storage: 1 pack}. A recounts the cooler (2 packs),
  // B recounts storage (3 packs), at the same time.
  const loaded = { ...base, zones: { cooler: { qty: 1, eaches: 0 }, storage: { qty: 1, eaches: 0 } } }
  const devA = { ...loaded, zones: { ...loaded.zones, cooler: { qty: 2, eaches: 0 } } }
  const devB = { ...loaded, zones: { ...loaded.zones, storage: { qty: 3, eaches: 0 } } }

  it('both zone counts survive — neither device overwrites the other', async () => {
    await persistCountItems({}, [buildCountWrite(devA, ZONES, [], new Set(['cooler']))], [], 'a')
    await persistCountItems({}, [buildCountWrite(devB, ZONES, [], new Set(['storage']))], [], 'b')
    expect(store[ID].zones).toEqual({ cooler: { qty: 2, eaches: 0 }, storage: { qty: 3, eaches: 0 } })
  })

  it('COUNTERFACTUAL: re-sending the whole local map (the old write) loses A\'s count', async () => {
    const oldWrite = row => { const r = { ...row }; delete r.zoneKeys; return r }
    await persistCountItems({}, [oldWrite(buildCountWrite(devA, ZONES, [], ['cooler']))], [], 'a')
    await persistCountItems({}, [oldWrite(buildCountWrite(devB, ZONES, [], ['storage']))], [], 'b')
    expect(store[ID].zones.cooler).toEqual({ qty: 1, eaches: 0 })   // A's 2 packs: gone
  })

  it('the stored total converges: A learns B\'s zone, finds the stale total, fixes it — and the server value is right', async () => {
    await persistCountItems({}, [buildCountWrite(devA, ZONES, [], ['cooler'])], [], 'a')
    await persistCountItems({}, [buildCountWrite(devB, ZONES, [], ['storage'])], [], 'b')
    // B wrote last, with its stale view of the cooler: 1 + 3 packs = 48 eaches.
    expect(store[ID].eaches).toBe(48)

    // A's listener delivers B's doc. A has saved (not touched any more).
    const aNow = applyRemoteCountPatch(devA, listenerPatch(store[ID]), false, undefined)
    expect(aNow.zones).toEqual({ cooler: { qty: 2, eaches: 0 }, storage: { qty: 3, eaches: 0 } })
    expect(aNow._storedTotal).toBe(48)

    // A's next save reconciles: derived 60 ≠ stored 48 → top-level rewrite.
    const stale = staleDerivedTotals([aNow], ZONES, [], new Set())
    expect(stale).toEqual([{ id: 'milk', qty: null, eaches: 60 }])
    await persistDerivedTotals({}, stale, 'a')
    expect(store[ID].eaches).toBe(60)
    expect(store[ID].zones).toEqual({ cooler: { qty: 2, eaches: 0 }, storage: { qty: 3, eaches: 0 } })
    expect(cfValue(store[ID])).toBe(itemValue(aNow, ZONES, []))   // $120 both ways
  })

  it('a device still editing keeps its dirty zone and takes the other device\'s zone', () => {
    const aTyping = { ...devA, zones: { ...devA.zones, cooler: { qty: 4, eaches: 0 } } }
    const remote = { ...store[ID], zones: { cooler: { qty: 9, eaches: 9 }, storage: { qty: 3, eaches: 0 } }, eaches: 99 }
    const merged = applyRemoteCountPatch(aTyping, listenerPatch(remote), true, new Set(['cooler']))
    expect(merged.zones).toEqual({ cooler: { qty: 4, eaches: 0 }, storage: { qty: 3, eaches: 0 } })
  })
})

describe('writes cover only the zones this device edited', () => {
  const item = { ...base, zones: { cooler: { qty: 2, eaches: 0 }, storage: { qty: null, eaches: null } } }

  it('only dirty keys are written; a cleared dirty zone is a deleteField', () => {
    expect(buildZonePayload(item.zones, ['cooler'])).toEqual({ cooler: { qty: 2, eaches: 0 } })
    expect(buildZonePayload(item.zones, ['storage'])).toEqual({ storage: DEL })
  })

  it('no dirty zone → `zones` is omitted, never an empty map (which would wipe every zone)', () => {
    expect(zonesWrite(buildCountWrite(item, ZONES, [], []))).toEqual({})
    expect(zonesWrite(buildCountWrite(item, ZONES, [], undefined))).toEqual({})
  })

  it('every count writer uses the shared row builder (4 sites), passing the dirty keys', () => {
    const calls = SRC.match(/\.map\(i => buildCountWrite\(i, zonesRef\.current, zonesCompletedRef\.current, touchedZonesRef\.current\.get\(String\(i\.id\)\)\)\)/g) || []
    expect(calls.length).toBe(4)
    // The hand-built rows that wiped zoned docs (restoreItem / addCustomItem) are gone.
    expect(SRC).not.toMatch(/qty: i\.qty \?\? null, eaches: i\.eaches \|\| 0/)
  })

  it('legacy rows are unchanged by the shared builder', () => {
    const row = buildCountWrite({ id: 'x', name: 'Gum', qty: 3, eaches: 2, qtyPerPack: 1, unitCost: 1, lastCountedAt: 't', lastCountedBy: 'me' }, ZONES, [], undefined)
    expect(row).toEqual({
      id: 'x', qty: 3, eaches: 2, countedAt: 't', countedBy: 'me', packPrice: null, qtyPerPack: 1, unitCost: 1,
      name: 'Gum', category: null, vendor: null, countedViaUpload: undefined,
    })
  })
})

describe('applyRemoteCountPatch — the per-item remote rule', () => {
  const z = { cooler: { qty: 1, eaches: 0 }, storage: { qty: 2, eaches: 0 } }

  it('untouched zoned item mirrors the doc, incl. a remote zone delete', () => {
    const r = applyRemoteCountPatch({ ...base, zones: z }, listenerPatch({ qty: null, eaches: 12, zones: { cooler: { qty: 1, eaches: 0 } } }), false)
    expect(r.zones).toEqual({ cooler: { qty: 1, eaches: 0 } })
    expect(r._storedTotal).toBe(12)
  })

  it('removed doc: untouched zoned item loses its zones; a dirty zone survives', () => {
    expect(applyRemoteCountPatch({ ...base, zones: z }, null, false).zones).toBeUndefined()
    expect(applyRemoteCountPatch({ ...base, zones: z }, null, true, new Set(['storage'])).zones).toEqual({ storage: { qty: 2, eaches: 0 } })
  })

  it('legacy items keep the original rule exactly: touched → skipped; untouched → replaced', () => {
    const legacy = { ...base, qty: 5, eaches: 1, _qtyRaw: '5' }
    expect(applyRemoteCountPatch(legacy, listenerPatch({ qty: 9, eaches: 0 }), true)).toBe(legacy)
    const r = applyRemoteCountPatch(legacy, listenerPatch({ qty: 9, eaches: 0 }), false)
    expect([r.qty, r.eaches, r._qtyRaw, 'zones' in r]).toEqual([9, 0, null, false])
  })

  it('a zone this device removed (dirty, absent locally) is NOT resurrected by a remote value', () => {
    expect(mergeRemoteZones({ a: 1 }, { a: 9, b: 7 }, ['b'])).toEqual({ a: 9 })
  })

  it('mergeRemoteZones: dirty keys local, everything else remote', () => {
    expect(mergeRemoteZones({ a: 1, b: 2 }, { a: 9, c: 3 }, ['b'])).toEqual({ a: 9, c: 3, b: 2 })
    expect(mergeRemoteZones({}, null, [])).toBeUndefined()
  })
})

describe('staleDerivedTotals — only real mismatches, never items just written', () => {
  const done = { ...base, zones: { cooler: { qty: 1, eaches: 0 }, storage: { qty: 1, eaches: 0 } } }
  it('flags a stale stored total, including stored-null vs a now-complete item', () => {
    expect(staleDerivedTotals([{ ...done, _storedTotal: 12 }], ZONES, [])).toEqual([{ id: 'milk', qty: null, eaches: 24 }])
    expect(staleDerivedTotals([{ ...done, _storedTotal: null }], ZONES, [])).toHaveLength(1)
  })
  it('skips matches, just-written items, and items with no known stored total', () => {
    expect(staleDerivedTotals([{ ...done, _storedTotal: 24 }], ZONES, [])).toEqual([])
    expect(staleDerivedTotals([{ ...done, _storedTotal: 12 }], ZONES, [], new Set(['milk']))).toEqual([])
    expect(staleDerivedTotals([done], ZONES, [])).toEqual([])
  })
  it('both save paths reconcile, only after a successful count write', () => {
    expect(SRC).toMatch(/if \(countsPersisted\) await reconcileStoredTotals\(itemsCol, sourceItems, newCounts\)/)
    expect(SRC).toMatch(/if \(countsPersisted2\) await reconcileStoredTotals\(itemsCol2, items, newCounts2\)/)
  })
})

describe('a failed count write is retried, not dropped', () => {
  it('touched ids (and dirty zone keys) are cleared only when the write succeeded — both save paths', () => {
    expect(SRC).toMatch(/countsPersisted = false/)
    expect(SRC).toMatch(/const cleared = countsPersisted\s*\?\s*touchedIdsToClear/)
    expect(SRC).toMatch(/const cleared2 = countsPersisted2 \? touchedIdsToClear/)
    expect(SRC).toMatch(/cleared\.forEach\(id => \{ touchedItemsRef\.current\.delete\(id\); touchedZonesRef\.current\.delete\(id\) \}\)/)
  })
})

describe('the listener carries zones', () => {
  it('remoteZones parses a doc\'s zones; null for a legacy doc or junk', () => {
    expect(remoteZones({ cooler: { qty: 1, eaches: 2, extra: 'x' } })).toEqual({ cooler: { qty: 1, eaches: 2 } })
    expect(remoteZones(undefined)).toBeNull()
    expect(remoteZones([1])).toBeNull()
    expect(remoteZones({ bad: 3 })).toBeNull()
  })
  it('the snapshot patch includes zones and the stored total', () => {
    const L = code('src/hooks/useCountsListener.js')
    expect(L).toMatch(/zones: remoteZones\(data\.zones\),/)
    expect(L).toMatch(/storedTotal: data\.eaches \?\? null,/)
  })
})

describe('session: sweeps and sections survive two devices', () => {
  const sweep = SRC.slice(SRC.indexOf('const markZoneSwept'), SRC.indexOf('const setZoneValue'))
  const section = SRC.slice(SRC.indexOf('const markSectionComplete'), SRC.indexOf('const markZoneSwept'))

  it('sweeps write ONE key atomically, never the whole local session', () => {
    expect(sweep).toMatch(/\{ zonesCompleted: swept \? arrayUnion\(zoneKey\) : arrayRemove\(zoneKey\) \}/)
    expect(sweep).not.toMatch(/\n\s*updatedSession,\n\s*\{ merge: true \}/)
  })

  it('section completion is an atomic union', () => {
    expect(section).toMatch(/\{ sectionsCompleted: arrayUnion\(sectionKey\) \}/)
  })

  it('Save & Close writes status fields only — no `...session` re-send', () => {
    const close = SRC.slice(SRC.lastIndexOf("'inventorySessions'"), SRC.lastIndexOf("'inventorySessions'") + 700)
    expect(close).toMatch(/status: 'completed'/)
    expect(close).not.toMatch(/\.\.\.session/)
  })

  it('the session doc is live-synced on the current period', () => {
    expect(SRC).toMatch(/if \(!liveSync \|\| !orgId \|\| !locId \|\| !periodKey\) return undefined\s*const unsub = onSnapshot\(\s*doc\(db, 'tenants', orgId, 'inventorySessions'/)
  })
})
