// src/lib/parseOfficialPnl.js
//
// PHASE 1 · GATE 2 — parse the NetSuite Enterprise P&L export (the official books,
// monthly) into officialPnl docs, mapping each row to the RECON_MAP official-line
// vocabulary. Fail-loud on wrong sheet/columns; NEVER silently drop an unmapped
// row (collect + warn in the preview, same discipline as the budget import).
//
// Export columns: Category | Subcategory | Line | NetSuite Account Name |
//                 Actual $ | Budget $ | Variance $ | Variance %
// Optional: a Site/Entity column (multi-location export) and a Period/Month column.

import * as XLSX from 'xlsx'
import { doc, setDoc, serverTimestamp } from 'firebase/firestore'
import { db } from './firebase'
import { RECON_MAP } from './reconMap'

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '')
const pad = (n) => String(n).padStart(2, '0')

// ── Resolver: NetSuite account/line → officialLine key, built from RECON_MAP ──
const byAcct = {}, byName = {}
for (const [line, def] of Object.entries(RECON_MAP)) {
  if (def.acct && /^\d{4,6}$/.test(def.acct)) byAcct[def.acct] = line   // skip '50xxx?' tentative
  byName[norm(line)] = line
}
// Name variants the normalizer can't catch (grows as real exports reveal them).
const NAME_ALIASES = {
  [norm('Merchant Fees')]: 'Bank Charges, Merchant Fees',
  [norm('Payment Processing Fees')]: 'Bank Charges, Merchant Fees',
  [norm('Onsite Labor Salaries and Wages')]: 'Onsite Labor (Fooda) Salaries and Wages',
  [norm('Comp and Benefits')]: 'Total Comp and Benefits',
  [norm('Retail COGS Managed Service Cost')]: 'Retail COGS - Managed Service Cost',
}

// Resolve a row to an officialLine (or null). Account NUMBER wins, then exact
// normalized name on the account-name column, then the Line column, then aliases.
export function resolveOfficialLine(netsuiteAccount, lineCol) {
  const acctMatch = String(netsuiteAccount || '').match(/\b(\d{4,6})\b/)
  if (acctMatch && byAcct[acctMatch[1]]) return byAcct[acctMatch[1]]
  for (const src of [netsuiteAccount, lineCol]) {
    const n = norm(src)
    if (!n) continue
    if (byName[n]) return byName[n]
    if (NAME_ALIASES[n]) return NAME_ALIASES[n]
  }
  return null
}

// ── number / month helpers ──
function num(v) {
  if (v == null || v === '') return null
  let s = String(v).trim()
  const neg = /^\(.*\)$/.test(s)
  s = s.replace(/[(),$\s]/g, '')
  if (s === '' || s === '-') return null
  const n = parseFloat(s)
  if (isNaN(n)) return null
  return neg ? -Math.abs(n) : n
}
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 }
export function toMonthKey(s) {
  if (!s) return null
  const str = String(s).trim()
  let m
  if ((m = str.match(/(\d{4})[-/](\d{1,2})\b/))) return `${m[1]}-P${pad(+m[2])}`             // 2026-05
  if ((m = str.match(/\bP(\d{1,2})\b.*?(\d{4})|(\d{4}).*?\bP(\d{1,2})\b/i))) {                 // P05 2026 / 2026 P05
    const yr = m[2] || m[3], mo = m[1] || m[4]; if (yr && mo) return `${yr}-P${pad(+mo)}`
  }
  if ((m = str.match(/([A-Za-z]{3,})\.?\s*[-,]?\s*(\d{4})/))) {                                 // May 2026
    const mo = MONTHS[m[1].slice(0, 3).toLowerCase()]; if (mo) return `${m[2]}-P${pad(mo)}`
  }
  return null
}

// header presence + value pluck (case/space tolerant)
const pick = (row, cands) => { for (const c of cands) { for (const k of Object.keys(row)) if (norm(k) === norm(c)) return row[k] } return undefined }
const hasAny = (headers, cands) => headers.some(h => cands.some(c => norm(h) === norm(c)))

const COLS = {
  category:   ['Category'],
  subcategory:['Subcategory', 'Sub Category', 'Sub-category'],
  line:       ['Line'],
  account:    ['NetSuite Account Name', 'Account Name', 'NetSuite Account', 'Account'],
  actual:     ['Actual $', 'Actual', 'Actual Amount'],
  budget:     ['Budget $', 'Budget', 'Budget Amount'],
  variance:   ['Variance $', 'Variance'],
  variancePct:['Variance %', 'Variance Pct', 'Variance Percent'],
  site:       ['Site Name', 'Site', 'Location', 'Entity', 'Entity Name'],
  period:     ['Period', 'Month', 'Posting Period', 'Accounting Period'],
}

// Parse the export → per-site { matched[], unmapped[] } + detected monthKey.
// Rejects (fail-loud) if signature columns are missing, naming the sheet read.
export async function parseOfficialPnl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = (e) => {
      try {
        const wb = XLSX.read(e.target.result, { type: 'array', cellDates: true })
        const sheetName = wb.SheetNames[0]
        const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { raw: false })
        const sheetInfo = wb.SheetNames.length > 1
          ? ` [read sheet "${sheetName}" of ${wb.SheetNames.length}: ${wb.SheetNames.join(', ')}]`
          : ` [read sheet "${sheetName}"]`
        if (!rows.length) { reject(new Error(`Sheet "${sheetName}" is empty.${sheetInfo}`)); return }
        const headers = Object.keys(rows[0])
        const shown = headers.slice(0, 12).join(', ') + (headers.length > 12 ? ', …' : '')

        // Signature: must have a Line OR Account column, AND an Actual column.
        const missing = []
        if (!hasAny(headers, COLS.line) && !hasAny(headers, COLS.account)) missing.push('Line / NetSuite Account Name')
        if (!hasAny(headers, COLS.actual)) missing.push('Actual $')
        if (missing.length) {
          reject(new Error(
            `This doesn't look like a NetSuite Enterprise P&L export. Missing column(s): ${missing.join(', ')}. ` +
            `Found: ${shown}${sheetInfo}`
          ))
          return
        }

        const hasSite = hasAny(headers, COLS.site)
        const hasPeriod = hasAny(headers, COLS.period)

        // Detect month: a Period column value, else the filename.
        let detectedMonthKey = null
        if (hasPeriod) for (const r of rows) { const k = toMonthKey(pick(r, COLS.period)); if (k) { detectedMonthKey = k; break } }
        if (!detectedMonthKey) detectedMonthKey = toMonthKey(file.name)

        // Group rows by site (single bucket if no site column).
        const bySite = {}
        for (const r of rows) {
          const account = pick(r, COLS.account)
          const line = pick(r, COLS.line)
          const actual = num(pick(r, COLS.actual))
          // Skip fully blank / non-data rows (no account, no line, no actual).
          if (!norm(account) && !norm(line) && actual == null) continue
          const siteRaw = hasSite ? String(pick(r, COLS.site) || '').trim() : null
          const key = siteRaw || '__single__'
          ;(bySite[key] ||= { siteRaw, matched: [], unmapped: [] })
          const rec = {
            category: pick(r, COLS.category) || '', subcategory: pick(r, COLS.subcategory) || '',
            line: line || '', netsuiteAccount: account || '',
            actual: actual ?? 0, budget: num(pick(r, COLS.budget)) ?? 0,
            variance: num(pick(r, COLS.variance)), variancePct: num(pick(r, COLS.variancePct)),
          }
          const officialLine = resolveOfficialLine(account, line)
          if (officialLine) bySite[key].matched.push({ officialLine, status: RECON_MAP[officialLine].status, ...rec })
          else bySite[key].unmapped.push(rec)
        }

        const sites = Object.values(bySite)
        // Zero-usable guard: matched nothing anywhere.
        if (!sites.some(s => s.matched.length)) {
          reject(new Error(
            `Parsed "${sheetName}" but matched no rows to a known P&L line. First rows' accounts: ` +
            `${rows.slice(0, 4).map(r => pick(r, COLS.account) || pick(r, COLS.line)).join(' | ')}${sheetInfo}`
          ))
          return
        }

        resolve({
          sheetName, detectedMonthKey, hasSite, sites,
          summary: {
            fileName: file.name, rowCount: rows.length, siteCount: sites.length,
            matchedCount: sites.reduce((s, x) => s + x.matched.length, 0),
            unmappedCount: sites.reduce((s, x) => s + x.unmapped.length, 0),
          },
        })
      } catch (err) { reject(new Error('Failed to parse: ' + err.message)) }
    }
    reader.onerror = () => reject(new Error('Failed to read file'))
    reader.readAsArrayBuffer(file)
  })
}

// Site matching moved to the shared siteMatch util (reused by the Café Labor
// import). Re-exported here so this module's surface is unchanged.
export { buildSiteMatcher } from './siteMatch'

// Write one site's official P&L for a month. locId = sanitized location doc id.
// Stores mapped lines AND unmapped rows (never silently dropped — it's the books).
export async function writeOfficialPnl(locId, monthKey, { location, matched, unmapped, importedBy, sourceFile }, orgId = 'fooda') {
  const ref = doc(db, 'tenants', orgId, 'officialPnl', locId, 'periods', monthKey)
  await setDoc(ref, {
    location: location || locId, monthKey,
    lines: matched.map(m => ({
      officialLine: m.officialLine, actual: m.actual, budget: m.budget,
      variance: m.variance, variancePct: m.variancePct,
      category: m.category, subcategory: m.subcategory, netsuiteAccount: m.netsuiteAccount,
    })),
    unmappedLines: (unmapped || []).map(u => ({
      line: u.line, netsuiteAccount: u.netsuiteAccount, category: u.category,
      subcategory: u.subcategory, actual: u.actual, budget: u.budget,
    })),
    sourceFile: sourceFile || '', importedBy: importedBy || 'unknown', importedAt: serverTimestamp(),
  }, { merge: true })
}
