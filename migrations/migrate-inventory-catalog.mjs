#!/usr/bin/env node
/**
 * Inventory catalog migration — Aurelia FMS
 *
 * Migrates the global master item catalog from a single document at
 *   aurelia/inv_items
 * to a per-tenant subcollection at
 *   tenants/{tenantId}/inventory_catalog/items/{itemId}
 *
 * Each item in the source array becomes its own document, indexed by item id.
 * The source document is NOT modified or deleted — it remains as a safety net.
 *
 * Idempotent: re-running the script overwrites the destination docs by item id.
 *
 * Usage:
 *   Dry-run (default — prints what it would do, no writes):
 *     node scripts/migrate-inventory-catalog.mjs
 *
 *   Real run (writes to Firestore):
 *     node scripts/migrate-inventory-catalog.mjs --commit
 *
 * Requires: ./prod-service-account.json with Firestore read+write permissions
 * for project the-grove-70180.
 */

import { initializeApp, cert } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import readline from 'readline'

// ─── Config ───────────────────────────────────────────────────────────────
const TENANT_ID         = 'fooda'
const SOURCE_PATH       = ['aurelia', 'inv_items']
const DEST_COLLECTION   = ['tenants', TENANT_ID, 'inventoryCatalog']
const EXPECTED_PROJECT  = 'the-grove-70180'

// ─── Setup ────────────────────────────────────────────────────────────────
const __dirname = dirname(fileURLToPath(import.meta.url))
const SA_PATH   = join(__dirname, '..', 'prod-service-account.json')

let serviceAccount
try {
  serviceAccount = JSON.parse(readFileSync(SA_PATH, 'utf8'))
} catch (e) {
  console.error('FATAL: could not read', SA_PATH)
  console.error(e.message)
  process.exit(1)
}

if (serviceAccount.project_id !== EXPECTED_PROJECT) {
  console.error(`FATAL: service account is for project '${serviceAccount.project_id}', expected '${EXPECTED_PROJECT}'`)
  console.error('Aborting — wrong project credential.')
  process.exit(1)
}

const COMMIT = process.argv.includes('--commit')

initializeApp({ credential: cert(serviceAccount) })
const db = getFirestore()

// ─── Helpers ──────────────────────────────────────────────────────────────
function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  return new Promise(resolve => rl.question(question, ans => { rl.close(); resolve(ans) }))
}

function bold(s)   { return `\x1b[1m${s}\x1b[0m` }
function dim(s)    { return `\x1b[2m${s}\x1b[0m` }
function green(s)  { return `\x1b[32m${s}\x1b[0m` }
function yellow(s) { return `\x1b[33m${s}\x1b[0m` }
function red(s)    { return `\x1b[31m${s}\x1b[0m` }
function cyan(s)   { return `\x1b[36m${s}\x1b[0m` }

// ─── Main ─────────────────────────────────────────────────────────────────
async function main() {
  console.log()
  console.log(bold('Aurelia inventory catalog migration'))
  console.log(dim('─'.repeat(60)))
  console.log(`Project:     ${cyan(serviceAccount.project_id)}`)
  console.log(`Source:      ${cyan('/' + SOURCE_PATH.join('/'))}`)
  console.log(`Destination: ${cyan('/' + DEST_COLLECTION.join('/') + '/{itemId}')}`)
  console.log(`Mode:        ${COMMIT ? red(bold('COMMIT (will write)')) : green(bold('DRY-RUN (no writes)'))}`)
  console.log(dim('─'.repeat(60)))
  console.log()

  // Read the source document
  console.log('Reading source document...')
  const sourceRef  = db.doc('/' + SOURCE_PATH.join('/'))
  const sourceSnap = await sourceRef.get()

  if (!sourceSnap.exists) {
    console.error(red(`FATAL: source document /${SOURCE_PATH.join('/')} does not exist`))
    process.exit(1)
  }

  const sourceData = sourceSnap.data()
  let rawValue = sourceData.value

  // Handle the string-or-array shape (Bug 4 fix happens here)
  if (typeof rawValue === 'string') {
    console.log(yellow('Source value is a JSON string — parsing'))
    try {
      rawValue = JSON.parse(rawValue)
    } catch (e) {
      console.error(red('FATAL: source value is a string but failed to parse as JSON'))
      console.error(e.message)
      process.exit(1)
    }
  }

  if (!Array.isArray(rawValue)) {
    console.error(red('FATAL: source value is neither an array nor a JSON string of an array'))
    console.error('Got type:', typeof rawValue)
    process.exit(1)
  }

  console.log(green(`Found ${rawValue.length} items in source array`))
  console.log()

  // Validate items and prepare destination writes
  const writes = []
  const skipped = []

  for (const item of rawValue) {
    if (!item || typeof item !== 'object') {
      skipped.push({ reason: 'not an object', item })
      continue
    }
    if (item.id === undefined || item.id === null || item.id === '') {
      skipped.push({ reason: 'missing id', item: { name: item.name } })
      continue
    }
    const docId = String(item.id)
    // Sanitize: Firestore doc IDs cannot contain '/' and have other rules
    if (docId.includes('/')) {
      skipped.push({ reason: 'id contains slash', item: { id: docId } })
      continue
    }
    writes.push({
      docId,
      data: {
        // Original fields, preserved as-is
        id:          item.id,
        name:        item.name || '',
        unitCost:    item.unitCost || 0,
        packSize:    item.packSize || null,
        qtyPerPack:  item.qtyPerPack || null,
        packPrice:   item.packPrice || null,
        vendor:      item.vendor || null,
        glCode:      item.glCode || null,
        sellingPrice: item.sellingPrice || null,
        itemType:    item.itemType || null,
        // Migration metadata
        _migratedAt:     new Date().toISOString(),
        _migratedFrom:   '/' + SOURCE_PATH.join('/'),
      },
    })
  }

  console.log(bold('Migration plan:'))
  console.log(`  ${green('Will write:')} ${writes.length} items`)
  if (skipped.length > 0) {
    console.log(`  ${yellow('Will skip: ')} ${skipped.length} items`)
    for (const s of skipped) {
      console.log(`    - ${s.reason}: ${JSON.stringify(s.item)}`)
    }
  }
  console.log()

  // Sample preview — show first 5 and last 2
  console.log(bold('Sample of items to write:'))
  const preview = [...writes.slice(0, 5), ...(writes.length > 7 ? [{ docId: '...', data: { name: dim('...') } }] : []), ...writes.slice(-2)]
  for (const w of preview) {
    if (w.docId === '...') { console.log(dim('  ... ' + (writes.length - 7) + ' more ...')); continue }
    console.log(`  ${cyan(w.docId.padEnd(12))} ${(w.data.name || '').padEnd(40)} ${dim('$' + (w.data.unitCost || 0).toFixed(2))}  ${dim(w.data.vendor || '')}`)
  }
  console.log()

  if (!COMMIT) {
    console.log(green(bold('DRY-RUN COMPLETE')))
    console.log()
    console.log('No writes performed. To run for real:')
    console.log(cyan('  node scripts/migrate-inventory-catalog.mjs --commit'))
    console.log()
    process.exit(0)
  }

  // ── COMMIT MODE ──
  console.log(red(bold('COMMIT MODE — about to write to production Firestore')))
  console.log()
  const confirm = await prompt(`Type ${bold('yes')} to write ${writes.length} docs to project ${bold(serviceAccount.project_id)}: `)
  if (confirm.trim().toLowerCase() !== 'yes') {
    console.log('Aborted.')
    process.exit(0)
  }

  console.log()
  console.log('Writing in batches of 500...')

  // Firestore batch write limit is 500. Chunk and write.
  const BATCH_SIZE = 500
  let written = 0
  for (let i = 0; i < writes.length; i += BATCH_SIZE) {
    const chunk = writes.slice(i, i + BATCH_SIZE)
    const batch = db.batch()
    for (const w of chunk) {
      const ref = db.collection('/' + DEST_COLLECTION.join('/')).doc(w.docId)
      batch.set(ref, w.data, { merge: true })
    }
    await batch.commit()
    written += chunk.length
    process.stdout.write(`\r  Written: ${written}/${writes.length}`)
  }
  console.log()
  console.log()
  console.log(green(bold('MIGRATION COMPLETE')))
  console.log(`  Wrote ${written} items to /${DEST_COLLECTION.join('/')}`)
  console.log(`  Source document /${SOURCE_PATH.join('/')} left untouched as safety net.`)
  console.log()
  console.log('Verify in Firestore Console:')
  console.log(cyan(`  https://console.firebase.google.com/project/${serviceAccount.project_id}/firestore/data/~2Ftenants~2F${TENANT_ID}~2FinventoryCatalog`))
  console.log()
  process.exit(0)
}

main().catch(e => {
  console.error(red('FATAL ERROR:'))
  console.error(e)
  process.exit(1)
})
