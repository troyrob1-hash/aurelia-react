// "Copy from another site" — make this location's inventory catalog, category
// sheets and counting zones an exact copy of another location's. Same outcome
// as scripts/copy-inventory-catalog.cjs: every source item doc is written with
// the same id and data (so sheet membership, per-sheet positions, key flags and
// par levels come with it), target docs the source doesn't have are deleted,
// and the categories / zones docs are set to the source's (or deleted when the
// source has none, so both fall back the same way).
//
// Never reads or writes counts, sessions, snapshots or P&L — past weeks' count
// records stay exactly as they are.
//
// I/O is injected (same pattern as runCatalogReplace) so every guard and the
// write order are testable without Firestore:
//   io.readCatalog(locId)  -> { items: [{ id, data }], categories: [] | null, zones: [] | null }
//   io.countWeek(locId, weekKey) -> number of count records for that week
//   io.backup(locId, catalog) -> backup id (written BEFORE anything changes)
//   io.commit(ops)          -> writes one chunk: [{ type: 'set'|'delete', path, data }]

import { doc, getDoc, getDocs, collection, setDoc, writeBatch } from 'firebase/firestore'
import { db } from '@/lib/firebase'
import { catalogLossSummary, catalogBackupTimestamp } from '@/lib/catalogImport'

export const COPY_CHUNK = 400

/** Why a copy can't start, or null. */
export function copyGuardError({ sourceLoc, targetLoc, locked, weekKey, weekCounts }) {
  if (!sourceLoc || !targetLoc) return 'Pick a site to copy from.'
  if (sourceLoc === targetLoc) return "Pick a different site — a site can't be copied onto itself."
  if (locked) return 'This period is closed — reopen it to change the item list.'
  if (weekCounts > 0) {
    return `This site already has counts entered for ${weekKey} (${weekCounts} item${weekCounts === 1 ? '' : 's'}). ` +
      "Replacing the item list mid-count isn't allowed — finish or clear this week's count first."
  }
  return null
}

/** What the source brings: active items and category sheets. */
export function sourceSummary(catalog) {
  const items = (catalog?.items || []).filter(d => !d.data?.removed).length
  return { items, sheets: (catalog?.categories || []).length, docs: (catalog?.items || []).length }
}

/** The ordered write plan: item sets, then settings, then deletes (superset first). */
export function planCatalogCopy(source, target) {
  const srcIds = new Set(source.items.map(d => d.id))
  const ops = source.items.map(d => ({ type: 'set', path: `items/${d.id}`, data: d.data }))
  ops.push(source.categories
    ? { type: 'set', path: 'settings/categories', data: { categories: source.categories } }
    : { type: 'delete', path: 'settings/categories' })
  ops.push(source.zones
    ? { type: 'set', path: 'settings/zones', data: { zones: source.zones } }
    : { type: 'delete', path: 'settings/zones' })
  for (const d of target.items) if (!srcIds.has(d.id)) ops.push({ type: 'delete', path: `items/${d.id}` })
  return ops
}

export function chunk(ops, size = COPY_CHUNK) {
  const out = []
  for (let i = 0; i < ops.length; i += size) out.push(ops.slice(i, i + size))
  return out
}

const stable = v => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x))
  ? Object.fromEntries(Object.keys(x).sort().map(key => [key, x[key]])) : x)

/** True when two catalogs are identical (items by id + data, categories, zones). */
export function catalogsMatch(a, b) {
  if (a.items.length !== b.items.length) return false
  const byId = new Map(b.items.map(d => [d.id, d.data]))
  if (!a.items.every(d => byId.has(d.id) && stable(byId.get(d.id)) === stable(d.data))) return false
  return stable(a.categories || null) === stable(b.categories || null) && stable(a.zones || null) === stable(b.zones || null)
}

/**
 * Run the copy. Returns one of:
 *   { status: 'refused', error }
 *   { status: 'done', backupId, written, deleted }
 *   { status: 'failed', backupId, error }   — never reported as done; the backup exists
 */
export async function runCatalogCopy({ sourceLoc, targetLoc, weekKey, locked }, io) {
  const early = copyGuardError({ sourceLoc, targetLoc, locked, weekKey, weekCounts: 0 })
  if (early) return { status: 'refused', error: early }
  const weekCounts = await io.countWeek(targetLoc, weekKey)
  const guard = copyGuardError({ sourceLoc, targetLoc, locked, weekKey, weekCounts })
  if (guard) return { status: 'refused', error: guard }

  let source, target, backupId
  try {
    source = await io.readCatalog(sourceLoc)
    if (!source.items.length) return { status: 'refused', error: 'That site has no items to copy.' }
    target = await io.readCatalog(targetLoc)
    backupId = await io.backup(targetLoc, target)
  } catch (e) {
    // Nothing has been written to this site's item list yet.
    return { status: 'refused', error: `Couldn't read the sites or save the backup (${e?.message || e}). Nothing was changed.` }
  }
  const ops = planCatalogCopy(source, target)
  const failed = (e) => ({
    status: 'failed', backupId,
    error: `The copy stopped partway (${e?.message || e}). This site's item list may be incomplete. ` +
      `A backup of it from before the copy was saved (${backupId}).`,
  })
  try {
    for (const part of chunk(ops)) await io.commit(part)
    const after = await io.readCatalog(targetLoc)
    if (!catalogsMatch(after, source)) return failed(new Error("the result doesn't match the source"))
  } catch (e) {
    return failed(e)
  }
  return {
    status: 'done', backupId,
    written: source.items.length,
    deleted: ops.filter(o => o.type === 'delete' && o.path.startsWith('items/')).length,
  }
}

export { catalogLossSummary }

/**
 * The Firestore I/O runCatalogCopy uses in the app. Paths are per location:
 * tenants/{org}/inventory/{loc}/items, settings/categories, settings/zones.
 * Backup = the existing catalogBackups/{ts}/items/{id} snapshot (same format
 * the item-list upload writes) + this site's categories/zones beside it at
 * settings/catalogBackup-{ts} (rules allow settings/{doc}; there is no rule for
 * a catalogBackups/{ts} parent doc).
 */
export function firestoreCopyIo(orgId, actor = null) {
  const base = (loc) => ['tenants', orgId, 'inventory', loc]
  let target = null
  return {
    async readCatalog(loc) {
      const [itemsSnap, catSnap, zoneSnap] = await Promise.all([
        getDocs(collection(db, ...base(loc), 'items')),
        getDoc(doc(db, ...base(loc), 'settings', 'categories')),
        getDoc(doc(db, ...base(loc), 'settings', 'zones')),
      ])
      return {
        items: itemsSnap.docs.map(d => ({ id: d.id, data: d.data() })),
        categories: catSnap.exists() ? (catSnap.data().categories ?? null) : null,
        zones: zoneSnap.exists() ? (zoneSnap.data().zones ?? null) : null,
      }
    },
    async countWeek(loc, weekKey) {
      const [perItem, legacy] = await Promise.all([
        getDocs(collection(db, ...base(loc), 'counts', weekKey, 'items')),
        getDoc(doc(db, ...base(loc), 'counts', weekKey)),
      ])
      return perItem.size || (legacy.exists() ? (legacy.data().items || []).length : 0)
    },
    async backup(loc, catalog) {
      target = loc
      const ts = catalogBackupTimestamp()
      for (const part of chunk(catalog.items)) {
        const batch = writeBatch(db)
        for (const d of part) batch.set(doc(db, ...base(loc), 'catalogBackups', ts, 'items', d.id), d.data)
        await batch.commit()
      }
      await setDoc(doc(db, ...base(loc), 'settings', `catalogBackup-${ts}`), {
        categories: catalog.categories, zones: catalog.zones, items: catalog.items.length,
        reason: 'copy-from-site', takenAt: new Date().toISOString(), takenBy: actor,
      })
      return ts
    },
    async commit(ops) {
      if (!target) throw new Error('commit before backup')
      const batch = writeBatch(db)
      for (const op of ops) {
        const ref = doc(db, ...base(target), ...op.path.split('/'))
        if (op.type === 'set') batch.set(ref, op.data); else batch.delete(ref)
      }
      await batch.commit()
    },
  }
}
