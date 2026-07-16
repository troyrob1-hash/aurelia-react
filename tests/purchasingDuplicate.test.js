// Guards the duplicate-warning predicate: it must fire ONLY on a matching invoice
// number (+ location), never on vendor+amount+week — else numberless Amazon/Webstaurant
// purchases (legitimately repeatable in a week) train users to click through warnings.
import { describe, it, expect } from 'vitest'
import { isNumberDuplicate } from '@/routes/Purchasing'

describe('isNumberDuplicate — number-based duplicate warning', () => {
  const AZ = 'Cafe AZ'

  it('two numberless Amazon purchases (same vendor/amount/week) → NOT a duplicate', () => {
    const existing = [{ id: 'a', invoiceNum: '', vendorId: 'amazon', amount: 25.0, invoiceDate: '2026-07-08', location: AZ }]
    const second   = { invoiceNum: '', vendorId: 'amazon', amount: 25.0, invoiceDate: '2026-07-08', location: AZ }
    expect(isNumberDuplicate(second, existing, null, AZ)).toBeNull()
  })

  it('the same real invoice number re-entered for the same location → duplicate', () => {
    const existing = [{ id: 'x', invoiceNum: 'SYS-9001', vendorId: 'sysco', amount: 1200, invoiceDate: '2026-07-06', location: AZ }]
    const reentry  = { invoiceNum: 'SYS-9001', vendorId: 'sysco', amount: 1200, invoiceDate: '2026-07-06', location: AZ }
    expect(isNumberDuplicate(reentry, existing, null, AZ)?.id).toBe('x')
  })

  it('the same number at a DIFFERENT location → not a duplicate', () => {
    const existing = [{ id: 'x', invoiceNum: 'SYS-9001', location: AZ }]
    const other    = { invoiceNum: 'SYS-9001', location: 'Cafe Q' }
    expect(isNumberDuplicate(other, existing, null, 'Cafe Q')).toBeNull()
  })

  it('numberless with a different amount → not a duplicate', () => {
    const existing = [{ id: 'a', invoiceNum: '', vendorId: 'amazon', amount: 25.0, invoiceDate: '2026-07-08', location: AZ }]
    const diff     = { invoiceNum: '', vendorId: 'amazon', amount: 40.0, invoiceDate: '2026-07-08', location: AZ }
    expect(isNumberDuplicate(diff, existing, null, AZ)).toBeNull()
  })

  it('excludes the row being edited (editId) — editing an invoice is not a self-duplicate', () => {
    const existing = [{ id: 'e1', invoiceNum: 'SYS-9001', location: AZ }]
    const editing  = { invoiceNum: 'SYS-9001', location: AZ }
    expect(isNumberDuplicate(editing, existing, 'e1', AZ)).toBeNull()          // same doc, being edited
    expect(isNumberDuplicate(editing, existing, 'other', AZ)?.id).toBe('e1')   // a DIFFERENT doc with the number → dup
  })

  it('documentNumber takes precedence over invoiceNum for the match', () => {
    const existing = [{ id: 'd', documentNumber: '647615036', invoiceNum: '', location: AZ }]
    const match    = { documentNumber: '647615036', location: AZ }
    expect(isNumberDuplicate(match, existing, null, AZ)?.id).toBe('d')
  })
})
