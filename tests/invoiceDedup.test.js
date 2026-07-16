// Guards the invoice dedup: the same invoice number counts ONCE in a (location,
// period); blank numbers are never merged; the most recent/complete doc wins. This
// is the structural guard behind refreshPurchasingPnL — even if duplicate docs
// exist (a PDF parsed 5×), the sum can't double-count them.
import { describe, it, expect } from 'vitest'
import { dedupeInvoices, invoiceKey } from '@/routes/Purchasing'

const sum = (list) => dedupeInvoices(list).reduce((t, i) => t + (Number(i.amount) || 0), 0)

describe('invoiceKey', () => {
  it('prefers documentNumber, falls back to invoiceNum, trims, blank when neither', () => {
    expect(invoiceKey({ documentNumber: ' 12353 ', invoiceNum: 'X' })).toBe('12353')
    expect(invoiceKey({ invoiceNum: '647615036' })).toBe('647615036')
    expect(invoiceKey({})).toBe('')
    expect(invoiceKey({ invoiceNum: '   ' })).toBe('')
  })
})

describe('dedupeInvoices', () => {
  it('same number × many → counts ONCE (the #12353 parsed-5× case)', () => {
    const five = Array.from({ length: 5 }, (_, k) => ({ id: 'd' + k, invoiceNum: '12353', amount: 3538, createdAt: { seconds: 100 + k } }))
    const deduped = dedupeInvoices(five)
    expect(deduped).toHaveLength(1)
    expect(sum(five)).toBe(3538)          // not 5 × 3538 = 17690
  })

  it('two DIFFERENT blank-number invoices both count (never merge blanks)', () => {
    const list = [
      { id: 'a', invoiceNum: '', amount: 100 },
      { id: 'b', invoiceNum: '', amount: 250 },
    ]
    expect(dedupeInvoices(list)).toHaveLength(2)
    expect(sum(list)).toBe(350)
  })

  it('keeps the most recently touched doc; tie-breaks on larger amount', () => {
    const list = [
      { id: 'old', invoiceNum: 'INV1', amount: 500, createdAt: { seconds: 100 } },
      { id: 'new', invoiceNum: 'INV1', amount: 520, updatedAt: { seconds: 200 } },  // newer + more complete
    ]
    const [kept] = dedupeInvoices(list)
    expect(kept.id).toBe('new')
    expect(sum(list)).toBe(520)
  })

  it('distinct numbers are all kept', () => {
    const list = [
      { id: 'a', invoiceNum: 'A', amount: 10 },
      { id: 'b', invoiceNum: 'B', amount: 20 },
      { id: 'c', invoiceNum: '', amount: 30 },   // blank → distinct
    ]
    expect(dedupeInvoices(list)).toHaveLength(3)
    expect(sum(list)).toBe(60)
  })

  it('a re-parsed duplicate (same number, higher amount, newer) replaces — one row, correct total', () => {
    const list = [
      { id: 'v1', invoiceNum: '999', amount: 3538, createdAt: { seconds: 10 } },
      { id: 'v2', invoiceNum: '999', amount: 3538, createdAt: { seconds: 20 } },  // re-parse
    ]
    const deduped = dedupeInvoices(list)
    expect(deduped).toHaveLength(1)
    expect(deduped[0].id).toBe('v2')
    expect(sum(list)).toBe(3538)
  })
})
