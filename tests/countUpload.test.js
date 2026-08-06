// Persisted safety net for the inventory count-sheet upload parser
// (src/lib/countUpload.js). Guards the column aliases and the item-match keying
// against the real Wings_Inv_Item sheet shape:
//   UPC | Item | Packs on Hand | Units on Hand | Pack Cost | Unit Cost | Total $ on Hand | Vendor | GL Code
// The "Packs on Hand"/"Units on Hand" headers must resolve to the packs/eaches
// count columns WITHOUT the adjacent "Pack Cost"/"Unit Cost" columns leaking in.
import { describe, it, expect } from 'vitest'
import { resolveCountColumns, buildCatalogIndex, matchCountRow, normUpc, nameSlug } from '@/lib/countUpload'

const WINGS_HEADERS = ['UPC', 'Item', 'Packs on Hand', 'Units on Hand', 'Pack Cost', 'Unit Cost', 'Total $ on Hand', 'Vendor', 'GL Code']

describe('resolveCountColumns — Wings_Inv_Item headers', () => {
  it('recognizes Packs on Hand / Units on Hand as the count columns', () => {
    const cols = resolveCountColumns(WINGS_HEADERS)
    expect(cols.nameCol).toBe('Item')
    expect(cols.upcCol).toBe('UPC')
    expect(cols.casesCol).toBe('Packs on Hand')
    expect(cols.eachesCol).toBe('Units on Hand')
  })

  it('does NOT mistake "Pack Cost" / "Unit Cost" for count columns', () => {
    // If the cost columns leaked in, casesCol/eachesCol would resolve to them.
    const cols = resolveCountColumns(WINGS_HEADERS)
    expect(cols.casesCol).not.toBe('Pack Cost')
    expect(cols.eachesCol).not.toBe('Unit Cost')
  })

  it('is whitespace/punctuation/case tolerant', () => {
    const cols = resolveCountColumns(['Item', 'PACKS  ON-HAND', 'units on hand'])
    expect(cols.casesCol).toBe('PACKS  ON-HAND')
    expect(cols.eachesCol).toBe('units on hand')
  })

  it('still accepts the legacy Cases/Qty/Eaches/Units names', () => {
    expect(resolveCountColumns(['Item', 'Cases', 'Eaches']).casesCol).toBe('Cases')
    expect(resolveCountColumns(['Item', 'Qty', 'Eaches']).casesCol).toBe('Qty')
    expect(resolveCountColumns(['Item', 'Cases', 'Units']).eachesCol).toBe('Units')
  })

  it('bare "Packs"/"Units" also resolve', () => {
    const cols = resolveCountColumns(['Item', 'Packs', 'Units'])
    expect(cols.casesCol).toBe('Packs')
    expect(cols.eachesCol).toBe('Units')
  })

  it('reports no count column when NEITHER packs nor units exists (fail-loud trigger)', () => {
    const cols = resolveCountColumns(['UPC', 'Item', 'Pack Cost', 'Unit Cost', 'Vendor'])
    expect(cols.casesCol).toBeNull()
    expect(cols.eachesCol).toBeNull()
  })
})

describe('no regression — old and new formats both parse', () => {
  it('OLD format (Cases + Eaches) resolves exactly as before', () => {
    const cols = resolveCountColumns(['Item', 'Cases', 'Eaches'])
    expect(cols).toMatchObject({ nameCol: 'Item', casesCol: 'Cases', eachesCol: 'Eaches' })
  })

  it('OLD format (Qty + Eaches) resolves', () => {
    const cols = resolveCountColumns(['Description', 'Qty', 'Eaches'])
    expect(cols).toMatchObject({ nameCol: 'Description', casesCol: 'Qty', eachesCol: 'Eaches' })
  })

  it('NEW format (Packs on Hand + Units on Hand) resolves', () => {
    const cols = resolveCountColumns(WINGS_HEADERS)
    expect(cols).toMatchObject({ casesCol: 'Packs on Hand', eachesCol: 'Units on Hand' })
  })

  it('every pre-change alias still resolves (add, not replace)', () => {
    for (const c of ['Cases', 'Qty', 'Quantity', 'Count']) {
      expect(resolveCountColumns(['Item', c]).casesCol).toBe(c)
    }
    for (const e of ['Eaches', 'Units', 'Loose', 'Each']) {
      expect(resolveCountColumns(['Item', e]).eachesCol).toBe(e)
    }
  })
})

describe('precedence — the two formats cannot silently collide', () => {
  it('packs and eaches groups are disjoint (a packs col is never read as eaches)', () => {
    const cols = resolveCountColumns(['Item', 'Packs on Hand', 'Units on Hand'])
    expect(cols.casesCol).toBe('Packs on Hand')
    expect(cols.eachesCol).toBe('Units on Hand')
    expect(cols.casesCol).not.toBe(cols.eachesCol)
  })

  it('two eaches synonyms in one sheet → leftmost column wins (deterministic)', () => {
    expect(resolveCountColumns(['Item', 'Eaches', 'Units on Hand']).eachesCol).toBe('Eaches')
    expect(resolveCountColumns(['Item', 'Units on Hand', 'Eaches']).eachesCol).toBe('Units on Hand')
  })

  it('two packs synonyms in one sheet → leftmost column wins (deterministic)', () => {
    expect(resolveCountColumns(['Item', 'Cases', 'Packs on Hand']).casesCol).toBe('Cases')
    expect(resolveCountColumns(['Item', 'Packs on Hand', 'Cases']).casesCol).toBe('Packs on Hand')
  })
})

describe('normUpc', () => {
  it('reduces a UPC to bare digits', () => {
    expect(normUpc('810035110489')).toBe('810035110489')
    expect(normUpc(810035110489)).toBe('810035110489') // XLSX numeric cell
    expect(normUpc(' 810035110489 ')).toBe('810035110489')
    expect(normUpc('')).toBe('')
    expect(normUpc(null)).toBe('')
  })
})

describe('matchCountRow — the item-match question (UPC preferred)', () => {
  const cols = { nameCol: 'Item', upcCol: 'UPC' }

  it('88 Acres row (UPC 810035110489) matches the catalog item by UPC', () => {
    const items = [{ id: 'x1', name: '88 Acres Dark Choc Seed Bar', sku: '810035110489', qty: null }]
    const index = buildCatalogIndex(items)
    const row = { UPC: '810035110489', Item: '88 Acres', 'Packs on Hand': 0, 'Units on Hand': 3 }
    const m = matchCountRow(row, cols, index)
    expect(m.item?.id).toBe('x1')
    expect(m.matchedBy).toBe('upc')
  })

  it('UPC wins even when the typed name differs from the catalog name', () => {
    const items = [{ id: 'x1', name: 'Eighty-Eight Acres Bar', sku: '810035110489' }]
    const index = buildCatalogIndex(items)
    const row = { UPC: '810035110489', Item: '88 Acres' } // name would NOT match
    expect(matchCountRow(row, cols, index).matchedBy).toBe('upc')
  })

  it('falls back to name slug when the catalog has no UPC (today’s Wesley: 0 sku)', () => {
    const items = [{ id: 'x1', name: '88 Acres Bar', sku: '' }] // no sku
    const index = buildCatalogIndex(items)
    const row = { UPC: '810035110489', Item: '88 Acres Bar' }
    const m = matchCountRow(row, cols, index)
    expect(m.item?.id).toBe('x1')
    expect(m.matchedBy).toBe('slug')
  })

  it('returns no match (surfaced as unmatched) when neither UPC nor name hits', () => {
    const index = buildCatalogIndex([{ id: 'x1', name: 'Something Else', sku: '' }])
    const row = { UPC: '999', Item: 'Nonexistent Item' }
    expect(matchCountRow(row, cols, index).item).toBeNull()
  })

  it('blank name + no UPC hit is a skippable blank row', () => {
    const index = buildCatalogIndex([{ id: 'x1', name: 'A', sku: '' }])
    expect(matchCountRow({ UPC: '', Item: '' }, cols, index).rawName).toBe('')
  })
})

describe('UPC-matching coexists with old name-based matching (no behavior change for old sheets)', () => {
  const catalog = [{ id: 'a', name: 'Alani Cotton Candy', sku: '' }, { id: 'b', name: '88 Acres Bar', sku: '' }]
  const index = buildCatalogIndex(catalog)

  it('OLD sheet with NO UPC column → matches by name exactly as before (upcCol null)', () => {
    const cols = { nameCol: 'Item', upcCol: null }
    const m = matchCountRow({ Item: '88 Acres Bar', Eaches: 2 }, cols, index)
    expect(m.item?.id).toBe('b')
    expect(m.matchedBy).toBe('slug')
  })

  it('sheet HAS a UPC column but catalog has 0 sku (today’s Wesley) → still name-based, UPC ignored', () => {
    const cols = { nameCol: 'Item', upcCol: 'UPC' }
    const m = matchCountRow({ UPC: '810035110489', Item: '88 Acres Bar' }, cols, index)
    expect(m.item?.id).toBe('b')
    expect(m.matchedBy).toBe('slug') // NOT 'upc' — bySku is empty, so name still wins
  })

  it('UPC only changes the outcome when the catalog item actually carries that sku', () => {
    const withSku = buildCatalogIndex([{ id: 'b', name: '88 Acres Bar', sku: '810035110489' }])
    const cols = { nameCol: 'Item', upcCol: 'UPC' }
    expect(matchCountRow({ UPC: '810035110489', Item: 'anything' }, cols, withSku).matchedBy).toBe('upc')
  })
})

describe('nameSlug parity with catalog item-doc id builder', () => {
  it('matches the Inventory.jsx slug transform', () => {
    // '&' is stripped and the resulting run of spaces collapses to a single '_'.
    expect(nameSlug('88 Acres Dark Choc & Sea Salt')).toBe('88_acres_dark_choc_sea_salt')
  })
})
