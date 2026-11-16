// @vitest-environment jsdom

// Barcode scanning matches items by item.sku. Two halves:
//  1. every inventory load path carries sku onto the item (none did, so the
//     scanner could never match anything);
//  2. the scanner matches exactly (or by one check digit on a real barcode),
//     never by substring — a short internal code like "90" must not match a
//     UPC that merely contains "90".

import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'
import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

vi.mock('html5-qrcode', () => ({ Html5Qrcode: class { start() { return Promise.resolve() } stop() { return Promise.resolve() } clear() {} } }))

import BarcodeScanner, { checkDigitMatch } from '../src/components/BarcodeScanner'
import { itemSku } from '../src/hooks/useInventory'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const code = p => readFileSync(resolve(ROOT, p), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

afterEach(cleanup)

async function scan(items, value) {
  const onScan = vi.fn()
  await act(async () => { render(<BarcodeScanner items={items} onScan={onScan} onClose={() => {}} />) })
  fireEvent.click(screen.getByText('Manual / Bluetooth'))
  fireEvent.change(screen.getByPlaceholderText('Enter barcode number...'), { target: { value } })
  fireEvent.click(screen.getByText('Look up'))
  return onScan
}

const NERDS = { id: 'n', name: 'Nerds Clusters', sku: '79200049058' }
const SABRA = { id: 's', name: 'Sabra Hummus Cup', sku: '90' }
const BOYLAN = { id: 'b', name: 'Boylan Root Beer', sku: '760712090019' }

describe('itemSku', () => {
  it('first non-blank value, trimmed; null when none', () => {
    expect(itemSku(' 79200049058 ')).toBe('79200049058')
    expect(itemSku(undefined, '', '  ', 760712090019)).toBe('760712090019')
    expect(itemSku(null, undefined, '')).toBeNull()
    expect(itemSku('override', 'catalog')).toBe('override')
  })
})

describe('every load path carries sku', () => {
  const SRC = code('src/hooks/useInventory.js')
  it('location catalog, master + override (override wins), and custom items', () => {
    expect(SRC).toMatch(/sku: itemSku\(item\.sku\),\s*catShelfOrder:\s+item\.catShelfOrder\s+\?\? null/)
    expect(SRC).toMatch(/sku: itemSku\(override\.sku, item\.sku\),/)
    expect(SRC).toMatch(/sku: itemSku\(data\.sku\),/)
  })
})

describe('scanner matching', () => {
  it('an exact barcode finds its item', async () => {
    const onScan = await scan([SABRA, NERDS], '79200049058')
    expect(onScan).toHaveBeenCalledWith(NERDS)
  })
  it('leading zeros on the scan are ignored', async () => {
    const onScan = await scan([NERDS], '079200049058')
    expect(onScan).toHaveBeenCalledWith(NERDS)
  })
  it('one extra or missing trailing check digit still matches a real barcode', async () => {
    expect(await scan([BOYLAN], '76071209001')).toHaveBeenCalledWith(BOYLAN)
    cleanup()
    expect(await scan([NERDS], '792000490581')).toHaveBeenCalledWith(NERDS)
  })
  it('a short internal code is NOT matched by a UPC that merely contains it', async () => {
    const onScan = await scan([SABRA], '760712090019')
    expect(onScan).not.toHaveBeenCalled()
    expect(screen.getByText(/760712090019/)).toBeTruthy()
  })
  it('a scan that is a substring of a barcode (not a check-digit difference) does not match', async () => {
    const onScan = await scan([BOYLAN], '7120900')
    expect(onScan).not.toHaveBeenCalled()
  })
  it('checkDigitMatch needs 8+ digits on both sides and exactly one trailing digit', () => {
    const map = { '760712090019': BOYLAN, '90': SABRA }
    expect(checkDigitMatch(map, '76071209001')).toBe(BOYLAN)
    expect(checkDigitMatch(map, '7607120900191')).toBe(BOYLAN)
    expect(checkDigitMatch(map, '7607120900')).toBeNull()
    expect(checkDigitMatch(map, '9')).toBeNull()
    expect(checkDigitMatch(map, '60712090019')).toBeNull()
    // Short codes on either side never get the one-digit leeway.
    expect(checkDigitMatch({ '9': SABRA }, '90')).toBeNull()
    expect(checkDigitMatch({ '12345678': BOYLAN }, '1234567')).toBeNull()
    expect(checkDigitMatch({ '1234567': SABRA }, '12345678')).toBeNull()
  })
})
