/**
 * Zero-item guard — a catalog file that yields no items never reaches a write.
 *
 * Incident (TOPS, 2026-11-13): an HDK item file with its cost columns removed
 * parsed to 0 items (parseCatalogRow skips cost-less rows as section headers).
 * Replace Entire Catalog then backed up, deleted all 146 TOPS item docs, wrote
 * nothing, and toasted success. These tests drive runCatalogReplace — the
 * sequence replaceCatalog actually runs — with recording I/O.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import {
  runCatalogReplace, catalogFileError, countUsableCatalogRows, zeroItemFileMessage, catalogLossWarningText, catalogLossSummary,
} from '../src/lib/catalogImport'
import { getDefaultCategories } from '../src/hooks/useInventory'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const code = p => readFileSync(resolve(ROOT, p), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

const CATS = getDefaultCategories()
const H = rows => Object.keys(rows[0])
const EXISTING = [
  { id: '183', data: { catShelfOrder: 1 } },
  { id: '80', data: { name: "Lay's Classic 2.25oz", packPrice: 31.08, catShelfOrder: 144 } },
  { id: '312', data: { removed: true, name: 'smart food pop corn white cheddar' } },
]

// Recording I/O: every call lands in `calls`, so "deletes nothing" is literal.
function recorder({ confirm = true } = {}) {
  const calls = []
  return {
    calls,
    io: {
      confirm: async (summary, n) => { calls.push(['confirm', n]); return confirm },
      backup: async docs => { calls.push(['backup', docs.length]) },
      saveCategories: async cats => { calls.push(['saveCategories', cats.length]) },
      deleteItems: async docs => { calls.push(['deleteItems', docs.length]) },
      writeItems: async items => { calls.push(['writeItems', items.length]) },
    },
  }
}

// John's shape: HDK export with the cost columns deleted — name, vendor, category.
const NO_COST = [
  { Description: 'Coke Zero 20oz', Vendor: 'Coke', Category: 'Coke Storage Closet' },
  { Description: 'BiB Lemonade', Vendor: 'Sysco', Category: 'BiBs' },
]
const WITH_COST = [
  { Description: 'Coke Zero 20oz', Vendor: 'Coke', 'Pack Price': '$24.00', Category: 'Coke Storage Closet' },
  { Description: 'BiB Lemonade', Vendor: 'Sysco', 'Pack Price': '$40.00', Category: 'BiBs' },
]

describe('replace — the zero-item guard', () => {
  it('a no-cost-column file aborts replace and deletes nothing', async () => {
    const { calls, io } = recorder()
    const res = await runCatalogReplace({ rows: NO_COST, headers: H(NO_COST), existingDocs: EXISTING, categories: CATS }, io)
    expect(res.status).toBe('empty')
    expect(res.error).toMatch(/0 items/)
    expect(res.error).toMatch(/cost\/price column/)
    expect(res.error).toMatch(/Nothing was changed/)
    // Not even the confirm or the backup — the file is rejected before anything.
    expect(calls).toEqual([])
  })

  it('a file whose cost column is all blank/$0 also aborts, with the blank-cost message', async () => {
    const rows = NO_COST.map(r => ({ ...r, 'Pack Price': '$0.00' }))
    const { calls, io } = recorder()
    const res = await runCatalogReplace({ rows, headers: H(rows), existingDocs: EXISTING, categories: CATS }, io)
    expect(res.status).toBe('empty')
    expect(res.error).toMatch(/blank or \$0/)
    expect(calls).toEqual([])
  })

  it('a good file runs the full sequence in the safe order: confirm → backup → categories → delete → write', async () => {
    const { calls, io } = recorder()
    const res = await runCatalogReplace({ rows: WITH_COST, headers: H(WITH_COST), existingDocs: EXISTING, categories: CATS }, io)
    expect(res.status).toBe('done')
    expect(calls).toEqual([
      ['confirm', 2], ['backup', 3], ['saveCategories', CATS.length + 2], ['deleteItems', 3], ['writeItems', 2],
    ])
  })

  it('declining the confirm deletes nothing', async () => {
    const { calls, io } = recorder({ confirm: false })
    const res = await runCatalogReplace({ rows: WITH_COST, headers: H(WITH_COST), existingDocs: EXISTING, categories: CATS }, io)
    expect(res.status).toBe('cancelled')
    expect(calls).toEqual([['confirm', 2]])
  })

  it('the confirm names how many items the file will write', () => {
    const text = catalogLossWarningText(catalogLossSummary(EXISTING), 'TOPS', 2)
    expect(text).toMatch(/replace them with 2 items/)
    expect(catalogLossWarningText(catalogLossSummary([]), 'TOPS', 1)).toMatch(/adds 1 item\b/)
  })
})

describe('the shared guard (merge uses it too)', () => {
  it('counts usable rows with the same rules both paths use', () => {
    expect(countUsableCatalogRows(NO_COST, H(NO_COST))).toBe(0)
    expect(countUsableCatalogRows(WITH_COST, H(WITH_COST))).toBe(2)
  })
  it('catalogFileError is null for a good file, the message for a 0-item file', () => {
    expect(catalogFileError(WITH_COST, H(WITH_COST))).toBeNull()
    expect(catalogFileError(NO_COST, H(NO_COST))).toBe(zeroItemFileMessage(H(NO_COST)))
    expect(catalogFileError([], [])).toMatch(/0 items/)
  })
  it('merge (uploadCatalog) checks the file BEFORE its backup or any write', () => {
    const src = code('src/routes/Inventory.jsx')
    const body = src.slice(src.indexOf('async function uploadCatalog('), src.indexOf('async function replaceCatalog('))
    const guard = body.indexOf('catalogFileError(rows, headers)')
    expect(guard).toBeGreaterThan(-1)
    expect(guard).toBeLessThan(body.indexOf('backupLocationCatalog('))
    expect(guard).toBeLessThan(body.indexOf('writeBatch(db)'))
    expect(body.slice(guard, guard + 120)).toMatch(/if \(fileError\) \{ toast\.error\(fileError\); return \}/)
  })
  it('replace (replaceCatalog) runs through runCatalogReplace — no destructive Firestore call outside it', () => {
    const src = code('src/routes/Inventory.jsx')
    const body = src.slice(src.indexOf('async function replaceCatalog('), src.indexOf('const { periodKey, isCurrentPeriod'))
    expect(body).toMatch(/runCatalogReplace\(/)
    expect(body.indexOf("result.status === 'empty'")).toBeGreaterThan(body.indexOf('runCatalogReplace('))
    // every delete lives inside the io.deleteItems callback handed to runCatalogReplace
    const del = body.indexOf('.delete(')
    expect(del).toBeGreaterThan(body.indexOf('deleteItems:'))
    expect(del).toBeLessThan(body.indexOf('writeItems:'))
  })
})
