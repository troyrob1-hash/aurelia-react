// Money/units guard for the vendor-robust invoice line-item parser. The model does the
// raw PDF extraction; these pure helpers do the eaches math, the two disambiguation
// rules, and the reconciliation — so THOSE (the money-path logic) are locked here with
// cases modeled on the 4 real invoices (Sysco / Reyes / Nassau / RTZN).
import { describe, it, expect } from 'vitest'
import { normalizeVendor, enrichLine, validateInvoice, processInvoice } from '@/lib/parseInvoiceLines'

describe('normalizeVendor — header → mapping-key vendor', () => {
  it('maps the four known distributors', () => {
    expect(normalizeVendor('SYSCO MINNESOTA')).toBe('sysco')
    expect(normalizeVendor('Reyes Coca-Cola Bottling, LLC')).toBe('reyes_coca_cola')
    expect(normalizeVendor('NASSAU CANDY DISTRIBUTORS')).toBe('nassau_candy')
    expect(normalizeVendor('RTZN Brands LLC')).toBe('rtzn')
    expect(normalizeVendor('Righteous Felon')).toBe('rtzn')
  })
  it('falls back to a slug for unknown vendors', () => {
    expect(normalizeVendor('Cafe Moto')).toBe('cafe_moto')
    expect(normalizeVendor('')).toBe('other')
  })
})

describe('enrichLine — eaches = casesOrdered × packCount', () => {
  it('computes eachesTotal from cases × pack (Sysco: 1 case × 64)', () => {
    const l = enrichLine({ itemCode: '6799157', casesOrdered: 1, packCount: 64, unitPrice: 45.75, total: 45.75 }, 'sysco')
    expect(l.eachesTotal).toBe(64)
    expect(l.warnings).toHaveLength(0)
  })
  it('RTZN parenthetical pack (3 cases × 6ct = 18)', () => {
    const l = enrichLine({ itemCode: '10001-8', casesOrdered: 3, packCount: 6, unitPrice: 17.94, total: 53.82 }, 'rtzn')
    expect(l.eachesTotal).toBe(18)
  })
})

describe('Rule 1 — Nassau BX/CS pricing tiebreaker', () => {
  it('pricing reconciles (unitPrice × cases == total) → pack trusted', () => {
    // Justin's: $33.96/CS × 2 = $67.92 → BX==CS, pack 72 (12CT × 6/CS) trusted
    const l = enrichLine({ itemCode: '937131', casesOrdered: 2, packCount: 72, unitPrice: 33.96, total: 67.92 }, 'nassau_candy')
    expect(l.eachesTotal).toBe(144)
    expect(l.warnings).toHaveLength(0)
  })
  it('pricing does NOT reconcile → flag "pack unresolved", eaches null (never guess)', () => {
    // unitPrice × cases ($33.96 × 3 = $101.88) ≠ total $67.92 → BX/CS ambiguous
    const l = enrichLine({ itemCode: '937131', casesOrdered: 3, packCount: 72, unitPrice: 33.96, total: 67.92 }, 'nassau_candy')
    expect(l.eachesTotal).toBeNull()
    expect(l.warnings.some((w) => w.startsWith('pack unresolved'))).toBe(true)
  })
})

describe('Rule 2 — missing code → "code unresolved", NO description fallback', () => {
  it('a codeless line (RTZN) is flagged, not keyed by description', () => {
    const l = enrichLine({ itemCode: '', casesOrdered: 3, packCount: 6, description: 'Blobs Orange Peach Gummy', unitPrice: 17.94, total: 53.82 }, 'rtzn')
    expect(l.codeUnresolved).toBe(true)
    expect(l.itemCode).toBe('')                 // NOT the description
    expect(l.warnings).toContain('code unresolved')
  })
  it('a UPC present rescues a missing itemCode (UPC is a valid key)', () => {
    const l = enrichLine({ itemCode: '', upc: '049000047851', casesOrdered: 1, packCount: 24, unitPrice: 48, total: 41.5 }, 'reyes_coca_cola')
    expect(l.codeUnresolved).toBe(true)
    expect(l.warnings).not.toContain('code unresolved')   // upc is the key
  })
})

describe('validateInvoice — dual reconciliation', () => {
  it('Σtotal reconciles to SUBTOTAL, not the grand total (Nassau freight excluded)', () => {
    const parsed = {
      vendor: 'NASSAU CANDY', subtotal: 270.06, total: 301.74, netConsumerQty: null,
      lineItems: [
        { itemCode: '937131', casesOrdered: 2, packCount: 72, unitPrice: 33.96, total: 67.92 },
        { itemCode: '57662',  casesOrdered: 3, packCount: 108, unitPrice: 40.50, total: 121.50 },
        { itemCode: '30834',  casesOrdered: 2, packCount: 288, unitPrice: 40.32, total: 80.64 },
      ],
    }
    const { validation } = processInvoice(parsed)
    expect(validation.sumTotals).toBeCloseTo(270.06, 2)
    expect(validation.subtotalOk).toBe(true)          // matches subtotal
    expect(270.06).not.toBeCloseTo(301.74, 2)         // and is NOT the grand total
  })
  it('Σeaches checksum mismatch is surfaced (Reyes 540 vs 510)', () => {
    const lines = [{ eachesTotal: 540, warnings: [], codeUnresolved: false, upc: '', total: 0 }]
    const v = validateInvoice({ subtotal: 872.79, netConsumerQty: 510 }, lines)
    expect(v.eachesOk).toBe(false)                    // 540 ≠ 510 → flagged
  })
  it('Σeaches checksum match passes', () => {
    const lines = [{ eachesTotal: 510, warnings: [], codeUnresolved: false, upc: '', total: 0 }]
    const v = validateInvoice({ subtotal: 0, netConsumerQty: 510 }, lines)
    expect(v.eachesOk).toBe(true)
  })
})

describe('processInvoice — end to end on a Sysco-shaped invoice', () => {
  const parsed = {
    vendor: 'SYSCO MINNESOTA', subtotal: 93.61, total: 93.61, netConsumerQty: null,
    lineItems: [
      { itemCode: '4599775', casesOrdered: 1, packCount: 36, size: '1.5 OZ', description: 'HERSHEY KIT KAT', unitPrice: 47.86, total: 47.86 },
      { itemCode: '6799157', upc: '00028400443616', casesOrdered: 1, packCount: 64, size: '1.5 OZ', description: 'LAYS SRCRM & O', unitPrice: 45.75, total: 45.75 },
    ],
  }
  const { vendor, lines, validation } = processInvoice(parsed)
  it('detects vendor, computes eaches, captures upc, reconciles money', () => {
    expect(vendor).toBe('sysco')
    expect(lines[0].eachesTotal).toBe(36)
    expect(lines[1].eachesTotal).toBe(64)
    expect(lines[1].upc).toBe('00028400443616')
    expect(validation.subtotalOk).toBe(true)
    expect(validation.linesPackUnresolved).toBe(0)
    expect(validation.linesCodeUnresolved).toBe(0)
  })
})
