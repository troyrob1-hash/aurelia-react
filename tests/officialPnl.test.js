// @vitest-environment jsdom
//
// Persisted safety net for the NetSuite Enterprise P&L parser (src/lib/parseOfficialPnl.js).
// Covers the pure resolver + month parser, then the full parse path (fail-loud on
// wrong columns, never-drop unmapped rows, per-site split) via a real in-memory .xlsx.
import { describe, it, expect } from 'vitest'
import * as XLSX from 'xlsx'
import { resolveOfficialLine, toMonthKey, parseOfficialPnl } from '@/lib/parseOfficialPnl'

// Build a real .xlsx File from an array-of-arrays (header row first).
function xlsxFile(aoa, name = 'enterprise-pnl.xlsx', sheetName = 'P&L') {
  const ws = XLSX.utils.aoa_to_sheet(aoa)
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, sheetName)
  const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' })
  return new File([buf], name, { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
}

const HEADERS = ['Category', 'Subcategory', 'Line', 'NetSuite Account Name', 'Actual $', 'Budget $', 'Variance $', 'Variance %', 'Period']

describe('resolveOfficialLine — account number wins, then name, then line, then alias', () => {
  it('account NUMBER wins over a conflicting name/line', () => {
    // acct 50410 = Salaries line; the line column says "Onsite Equipment" (acct 50430).
    // The number must win.
    expect(resolveOfficialLine('50410 Onsite Labor Salaries', 'Onsite Equipment'))
      .toBe('Onsite Labor (Fooda) Salaries and Wages')
  })
  it('exact normalized name on the account column', () => {
    expect(resolveOfficialLine('Onsite Equipment', '')).toBe('Onsite Equipment')
  })
  it('falls back to the Line column when the account cell does not resolve', () => {
    expect(resolveOfficialLine('', 'Onsite Equipment')).toBe('Onsite Equipment')
  })
  it('resolves a known alias', () => {
    expect(resolveOfficialLine('Merchant Fees', '')).toBe('Bank Charges, Merchant Fees')
  })
  it('returns null for a genuinely unknown line (never guesses)', () => {
    expect(resolveOfficialLine('99999 Mystery Account', 'Some Unknown Line')).toBeNull()
  })
})

describe('toMonthKey — tolerant month parsing to YYYY-PMM', () => {
  it.each([
    ['2026-05', '2026-P05'],
    ['2026/5', '2026-P05'],
    ['May 2026', '2026-P05'],
    ['P05 2026', '2026-P05'],
    ['2026 P05', '2026-P05'],
    ['enterprise-pnl_2026-05.xlsx', '2026-P05'],
  ])('%s → %s', (input, want) => {
    expect(toMonthKey(input)).toBe(want)
  })
  it('returns null for unparseable input', () => {
    expect(toMonthKey('not a date')).toBeNull()
    expect(toMonthKey('')).toBeNull()
  })
})

describe('parseOfficialPnl — full parse path', () => {
  it('matches known lines, keeps unknowns in unmapped (never dropped), detects the month', async () => {
    const file = xlsxFile([
      HEADERS,
      ['COGS', 'Equipment', 'Onsite Equipment', '50430 Onsite Equipment', '1,234.56', '1000', '234.56', '23%', 'May 2026'],
      ['Other', '', 'Some Unknown Line', '99999 Mystery Account', '(50.00)', '40', '-90', '', 'May 2026'],
    ])
    const res = await parseOfficialPnl(file)
    expect(res.detectedMonthKey).toBe('2026-P05')
    expect(res.sites).toHaveLength(1)
    const site = res.sites[0]
    expect(site.matched.map(m => m.officialLine)).toEqual(['Onsite Equipment'])
    expect(site.matched[0].actual).toBeCloseTo(1234.56, 2)
    // the unknown row is surfaced, not dropped
    expect(site.unmapped).toHaveLength(1)
    expect(site.unmapped[0].netsuiteAccount).toContain('99999')
    expect(site.unmapped[0].actual).toBeCloseTo(-50, 2)   // parenthesised negative
    expect(res.summary.matchedCount).toBe(1)
    expect(res.summary.unmappedCount).toBe(1)
  })

  it('splits rows by site into separate buckets', async () => {
    const H = ['Site Name', ...HEADERS]
    const file = xlsxFile([
      H,
      ['JPMC', 'COGS', 'Equipment', 'Onsite Equipment', '50430', '100', '', '', '', 'May 2026'],
      ['Best Buy', 'COGS', 'Equipment', 'Onsite Equipment', '50430', '200', '', '', '', 'May 2026'],
    ])
    const res = await parseOfficialPnl(file)
    expect(res.hasSite).toBe(true)
    expect(res.sites).toHaveLength(2)
    expect(res.sites.map(s => s.siteRaw).sort()).toEqual(['Best Buy', 'JPMC'])
  })

  it('fails loud (names the sheet) when the Actual column is missing', async () => {
    const file = xlsxFile([
      ['Category', 'Line', 'NetSuite Account Name', 'Budget $'],
      ['COGS', 'Onsite Equipment', '50430', '1000'],
    ], 'wrong.xlsx', 'BadSheet')
    await expect(parseOfficialPnl(file)).rejects.toThrow(/Actual \$/)
    await expect(parseOfficialPnl(file)).rejects.toThrow(/BadSheet/)
  })

  it('fails loud when both Line and Account columns are missing', async () => {
    const file = xlsxFile([['Category', 'Actual $'], ['COGS', '1000']])
    await expect(parseOfficialPnl(file)).rejects.toThrow(/Line \/ NetSuite Account Name/)
  })

  it('fails loud when nothing matches a known P&L line (zero-usable guard)', async () => {
    const file = xlsxFile([
      HEADERS,
      ['Other', '', 'Some Unknown Line', '99999 Mystery Account', '50', '40', '10', '', 'May 2026'],
    ])
    await expect(parseOfficialPnl(file)).rejects.toThrow(/matched no rows/)
  })
})
