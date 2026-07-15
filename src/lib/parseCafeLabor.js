// src/lib/parseCafeLabor.js
//
// PHASE 2.3a — parse the "Café Labor Efficiency Tracking → Summary by Site" export
// (Summary_by_Site.xlsx). One row per (Site, Week of Event); Week of Event is a
// Sunday, already Sun–Sat aligned to the fixed calendar. Fans OUT across periods
// (one file spans ~8 weeks / up to 3 months).
//
// Columns (exact): Site Name | Week of Event | Scheduled Labor | Actual Labor |
//   Labor Variance | Schedule Labor $ | Actual Labor $ | Labor $ Variance |
//   Sales | Actual Labor as a % of GFS
//
// - Detect by COLUMNS (the sheet is generically "Sheet 1"), fail-loud otherwise.
// - Forward-fill Site Name (blank on continuation rows).
// - SKIP the Grand Total row (double-count guard).
// - Actual Labor $ → cogs_onsite_labor_hourly (SEGREGATED field — readers SUM it
//   with cogs_onsite_labor + the FJE labor lines; it never clobbers them).
// - Store the efficiency fields (hrs, variance, % of GFS) for a later view.
// - The export's Sales column is NOT written.

import * as XLSX from 'xlsx'
import { doc, setDoc, serverTimestamp } from 'firebase/firestore'
import { db } from './firebase'
import { writePnL } from './pnl'
import { getPeriodWeeks, formatPeriodKey } from '@/store/PeriodContext'

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '')
const pick = (row, cands) => { for (const c of cands) for (const k of Object.keys(row)) if (norm(k) === norm(c)) return row[k]; return undefined }
const hasAny = (headers, cands) => headers.some(h => cands.some(c => norm(h) === norm(c)))

const COLS = {
  site:          ['Site Name', 'Site'],
  week:          ['Week of Event', 'Week'],
  schedHours:    ['Scheduled Labor'],
  actualHours:   ['Actual Labor'],
  hoursVariance: ['Labor Variance'],
  schedDollars:  ['Schedule Labor $', 'Scheduled Labor $'],
  actualDollars: ['Actual Labor $'],
  dollarVariance:['Labor $ Variance'],
  pctGfs:        ['Actual Labor as a % of GFS', 'Actual Labor as % of GFS'],
  // Sales is deliberately NOT read.
}

function num(v) {
  if (v == null || v === '') return null
  let s = String(v).trim(); const neg = /^\(.*\)$/.test(s)
  s = s.replace(/[(),$%\s]/g, '')
  if (s === '' || s === '-') return null
  const n = parseFloat(s); if (isNaN(n)) return null
  return neg ? -Math.abs(n) : n
}

// Normalize a Week-of-Event cell (Date | "5/31/2026" | "2026-05-31") → {y,m,d} or null.
function parseSunday(val) {
  if (!val) return null
  if (val instanceof Date && !isNaN(val)) return { y: val.getFullYear(), m: val.getMonth() + 1, d: val.getDate() }
  const s = String(val).trim()
  let m
  if ((m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/))) return { y: +m[3], m: +m[1], d: +m[2] }
  if ((m = s.match(/^(\d{4})-(\d{2})-(\d{2})/))) return { y: +m[1], m: +m[2], d: +m[3] }
  return null
}

// Sunday date → periodKey via the Sun–Sat calendar (getPeriodWeeks). The Sunday is
// the week START, so it matches a week's [start,end] — this is the fan-out key.
export function weekOfToPeriodKey(val) {
  const p = parseSunday(val); if (!p) return null
  const weeks = getPeriodWeeks(p.y, p.m)
  for (let i = 0; i < weeks.length; i++) {
    const s = weeks[i].start, e = weeks[i].end
    if (p.d >= s.getDate() && p.d <= e.getDate()) return formatPeriodKey(p.y, p.m, i + 1)
  }
  return null
}

const isGrandTotal = (site, week) => {
  const ns = norm(site), nw = norm(week)
  return ns.includes('grandtotal') || ns === 'total' || nw === 'total' || nw.includes('grandtotal')
}

// Parse → per-site fanned-out weeks. Fail-loud on missing signature columns.
export async function parseCafeLabor(file) {
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

        // Detect by COLUMNS — the sheet is generically named, so key on signature cols.
        const missing = []
        if (!hasAny(headers, COLS.site)) missing.push('Site Name')
        if (!hasAny(headers, COLS.week)) missing.push('Week of Event')
        if (!hasAny(headers, COLS.actualDollars)) missing.push('Actual Labor $')
        if (missing.length) {
          reject(new Error(
            `This doesn't look like the Café Labor Efficiency export. Missing column(s): ${missing.join(', ')}. ` +
            `Found: ${shown}${sheetInfo}`
          ))
          return
        }

        const bySite = {}
        let lastSite = ''
        let skippedTotals = 0
        for (const r of rows) {
          const siteCell = pick(r, COLS.site)
          const site = (siteCell != null && String(siteCell).trim()) ? String(siteCell).trim() : lastSite // forward-fill
          if (siteCell != null && String(siteCell).trim()) lastSite = site
          const weekCell = pick(r, COLS.week)
          if (isGrandTotal(site, weekCell)) { skippedTotals++; continue }         // double-count guard
          const actualDollars = num(pick(r, COLS.actualDollars))
          if (!site && !weekCell && actualDollars == null) continue                // blank row
          const periodKey = weekOfToPeriodKey(weekCell)
          const rec = {
            weekOf: weekCell instanceof Date ? weekCell.toISOString().slice(0, 10) : String(weekCell || ''),
            periodKey,
            hourlyLaborDollars: actualDollars ?? 0,
            eff: {
              actualHours: num(pick(r, COLS.actualHours)),
              scheduledHours: num(pick(r, COLS.schedHours)),
              hoursVariance: num(pick(r, COLS.hoursVariance)),
              scheduledDollars: num(pick(r, COLS.schedDollars)),
              dollarVariance: num(pick(r, COLS.dollarVariance)),
              pctOfGfs: num(pick(r, COLS.pctGfs)),
            },
          }
          ;(bySite[site] ||= { siteRaw: site, weeks: [], unparseable: [] })
          if (periodKey) bySite[site].weeks.push(rec)
          else bySite[site].unparseable.push(rec)          // Week of Event didn't resolve — surfaced, never dropped
        }

        const sites = Object.values(bySite)
        if (!sites.some(s => s.weeks.length)) {
          reject(new Error(
            `Parsed "${sheetName}" but resolved no (site, week) rows. First Week-of-Event values: ` +
            `${rows.slice(0, 4).map(r => pick(r, COLS.week)).join(' | ')}${sheetInfo}`
          ))
          return
        }

        // Distinct periods touched (the fan-out summary).
        const periods = [...new Set(sites.flatMap(s => s.weeks.map(w => w.periodKey)))].sort()
        resolve({
          sheetName, sites, periods,
          summary: {
            fileName: file.name, rowCount: rows.length, siteCount: sites.length,
            weekCount: sites.reduce((n, s) => n + s.weeks.length, 0),
            unparseableCount: sites.reduce((n, s) => n + s.unparseable.length, 0),
            skippedTotals, periods,
          },
        })
      } catch (err) { reject(new Error('Failed to parse: ' + err.message)) }
    }
    reader.onerror = () => reject(new Error('Failed to read file'))
    reader.readAsArrayBuffer(file)
  })
}

// Write one (loc, week): hourly labor → segregated field + efficiency metadata.
// Uses writePnL (respects period locks, merge-safe — never touches cogs_onsite_labor
// or the FJE lines). Efficiency fields are metadata only (no divide-by-zero: raw
// values from the export, ratios are computed by the view with guards).
export async function writeCafeLaborPnL(locId, periodKey, { hourlyLaborDollars, eff, sourceFile, importedBy }, orgId = 'fooda') {
  await writePnL(locId, periodKey, {
    cogs_onsite_labor_hourly: Math.round((Number(hourlyLaborDollars) || 0) * 100) / 100,
    labor_hourly_actual_hours: eff?.actualHours ?? null,
    labor_hourly_scheduled_hours: eff?.scheduledHours ?? null,
    labor_hourly_hours_variance: eff?.hoursVariance ?? null,
    labor_hourly_scheduled_dollars: eff?.scheduledDollars ?? null,
    labor_hourly_dollar_variance: eff?.dollarVariance ?? null,
    labor_hourly_pct_gfs: eff?.pctOfGfs ?? null,
    labor_hourly_source: sourceFile || 'cafe-labor-import',
    labor_hourly_importedBy: importedBy || 'unknown',
  })
}
