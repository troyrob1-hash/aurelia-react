import * as XLSX from 'xlsx'

const RETAIL_PATTERNS = [/11 dining/i, /barista/i, /cafeteria/i]
function isRetailVendor(name) { return RETAIL_PATTERNS.some(p => p.test(name || '')) }
function isBarista(name) { return /barista/i.test(name || '') }

function normalizeDate(val) {
  if (!val) return null
  if (val instanceof Date) {
    const y = val.getFullYear()
    const m = String(val.getMonth() + 1).padStart(2, '0')
    const d = String(val.getDate()).padStart(2, '0')
    return `${y}-${m}-${d}`
  }
  const str = String(val).trim()
  const parts = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)
  if (parts) return `${parts[3]}-${parts[1].padStart(2, '0')}-${parts[2].padStart(2, '0')}`
  if (/^\d{4}-\d{2}-\d{2}/.test(str)) return str.slice(0, 10)
  return null
}

function parsePopupExport(rows) {
  const daily = {}
  const totals = {
    gfs_popup: 0, gfs_retail: 0,
    rev_popup_cogs: 0, rev_popup_food_sales: 0, rev_popup_tax: 0, rev_popup_pp_fee: 0,
    rev_retail_barista: 0, rev_retail_cafeteria: 0,
    rev_client_fees: 0,
    popup_net_revenue: 0, retail_net_revenue: 0,
    popup_events: 0, retail_events: 0,
    vendors: new Set(),
  }
  let currentDate = null
  for (const row of rows) {
    const rawDate = row['Event Date']
    if (rawDate) currentDate = normalizeDate(rawDate)
    if (!currentDate) continue
    const gfs = parseFloat(row['Gross Food Sales']) || 0
    if (gfs === 0 && !row['Commission']) continue
    const vendor = row['Restaurant Internal Name'] || row['Partner Internal Name'] || ''
    const commission = parseFloat(row['Commission']) || 0
    const foodNet = parseFloat(row['Food Sale Net']) || 0
    const taxNet = parseFloat(row['Tax Net']) || 0
    const ppFee = parseFloat(row['Payment Processing Fee']) || 0
    const netRev = parseFloat(row['Net Revenue']) || 0
    const clientFees = parseFloat(row['Account Other Fee Net Amt']) || 0
    totals.vendors.add(vendor)
    if (!daily[currentDate]) daily[currentDate] = { popup: 0, catering: 0, retail: 0 }
    if (isRetailVendor(vendor)) {
      totals.gfs_retail += gfs
      totals.retail_events++
      totals.retail_net_revenue += netRev
      daily[currentDate].retail += gfs
      if (isBarista(vendor)) { totals.rev_retail_barista += gfs }
      else { totals.rev_retail_cafeteria += gfs }
    } else {
      totals.gfs_popup += gfs
      totals.popup_events++
      totals.popup_net_revenue += netRev
      daily[currentDate].popup += gfs
      totals.rev_popup_cogs += -(gfs - commission)
      totals.rev_popup_food_sales += foodNet
      totals.rev_popup_tax += taxNet
      totals.rev_popup_pp_fee += ppFee
      totals.rev_client_fees += clientFees
    }
  }
  return { totals, daily }
}

function parseCateringExport(rows) {
  const daily = {}
  const totals = {
    gfs_catering: 0,
    rev_catering_cogs: 0, rev_catering_revenue: 0, rev_catering_pp_fee: 0,
    catering_events: 0,
    vendors: new Set(),
  }
  let currentDate = null
  for (const row of rows) {
    const rawDate = row['Event date'] || row['Event Date']
    if (rawDate) currentDate = normalizeDate(rawDate)
    if (!currentDate) continue
    const price = parseFloat(row['Total Price']) || 0
    if (price === 0) continue
    const vendor = row['Entity name'] || ''
    const commission = parseFloat(row['Commission']) || 0
    totals.vendors.add(vendor)
    totals.gfs_catering += price
    totals.rev_catering_revenue += price
    totals.rev_catering_cogs += -(price - commission)
    totals.catering_events++
    if (!daily[currentDate]) daily[currentDate] = { popup: 0, catering: 0, retail: 0 }
    daily[currentDate].catering += price
  }
  return { totals, daily }
}

export async function parseEventExport(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = (e) => {
      try {
        const wb = XLSX.read(e.target.result, { type: 'array', cellDates: true })
        const sheetName = wb.SheetNames[0]
        const sheet = wb.Sheets[sheetName]
        const rows = XLSX.utils.sheet_to_json(sheet)
        // Name the sheet we read (and list the others) so a manager who uploaded a
        // whole multi-tab workbook knows to check which tab holds the export.
        const sheetInfo = wb.SheetNames.length > 1
          ? ` [read sheet "${sheetName}" of ${wb.SheetNames.length}: ${wb.SheetNames.join(', ')}]`
          : ` [read sheet "${sheetName}"]`
        if (rows.length === 0) { reject(new Error(`Sheet "${sheetName}" is empty.` + (wb.SheetNames.length > 1 ? ` Other sheets: ${wb.SheetNames.join(', ')}` : ''))); return }
        const headers = Object.keys(rows[0])
        const colCount = headers.length
        // Case/space-tolerant header presence check. The parsers read EXACT keys, so a
        // near-miss (e.g. different casing) still passes here but is caught by the
        // zero-usable-rows guard below — the two together prevent silent empty imports.
        const hasCol = (name) => headers.some(h => String(h).trim().toLowerCase() === name.toLowerCase())
        const shownHeaders = headers.slice(0, 12).join(', ') + (headers.length > 12 ? ', …' : '')

        let type, parsed
        if (colCount >= 50) {
          // Popup export — VALIDATE the signature columns, don't trust col-count alone.
          const missing = ['Event Date', 'Gross Food Sales'].filter(c => !hasCol(c))
          if (missing.length) {
            reject(new Error(
              `This doesn't look like a Fooda popup event export. Expected columns like ` +
              `"Event Date" and "Gross Food Sales" — found: ${shownHeaders}${sheetInfo}`
            ))
            return
          }
          type = 'popup'; parsed = parsePopupExport(rows)
        } else if (colCount <= 25) {
          // Catering export — VALIDATE the signature. A small GENERIC daily-sales export
          // lands here purely by col-count; without these columns parseCateringExport
          // would skip every row and silently import nothing (the bug this fixes).
          const missing = []
          if (!(hasCol('Event date') || hasCol('Event Date'))) missing.push('Event date')
          if (!hasCol('Total Price')) missing.push('Total Price')
          if (!hasCol('Entity name')) missing.push('Entity name')
          if (missing.length) {
            reject(new Error(
              `This doesn't look like a Fooda event export (popup or catering). Expected ` +
              `catering columns like "Event date", "Total Price", "Entity name" — found: ${shownHeaders}${sheetInfo}`
            ))
            return
          }
          type = 'catering'; parsed = parseCateringExport(rows)
        } else {
          reject(new Error(
            `Unrecognized format (${colCount} cols) — not a Fooda popup (>=50 cols) or ` +
            `catering (<=25 cols) export. Found: ${shownHeaders}${sheetInfo}`
          ))
          return
        }
        const data = parsed.totals
        const daily = parsed.daily
        // Zero-usable-rows guard: the format matched but every row was skipped (all $0,
        // blank, or undated). Warn loudly instead of confirming an empty import.
        if (Object.keys(daily).length === 0) {
          reject(new Error(
            `Parsed the ${type} file but found no usable rows — every row was empty, $0, or ` +
            `undated (popup needs a dated row with Gross Food Sales; catering needs Total Price > 0).`
          ))
          return
        }
        for (const [k, v] of Object.entries(data)) {
          if (typeof v === 'number') data[k] = Math.round(v * 100) / 100
        }
        for (const dk of Object.keys(daily)) {
          for (const [k, v] of Object.entries(daily[dk])) {
            if (typeof v === 'number') daily[dk][k] = Math.round(v * 100) / 100
          }
        }
        const summary = {
          type, fileName: file.name, rowCount: rows.length,
          vendorCount: data.vendors?.size || 0,
          vendors: [...(data.vendors || [])],
          daysWithData: Object.keys(daily).length,
        }
        delete data.vendors
        resolve({ type, data, daily, summary })
      } catch (err) { reject(new Error('Failed to parse: ' + err.message)) }
    }
    reader.onerror = () => reject(new Error('Failed to read file'))
    reader.readAsArrayBuffer(file)
  })
}

// retailTaxRate is the CONFIGURABLE retail tax (settings/rates), passed in by the
// caller (getRates). Popup/catering tax come from the real Tax Net column; only
// RETAIL tax is estimated, so it must use the same configurable rate as manual
// entry — not a hardcoded 0.077. Defaults to 0.077 for callers that don't pass it.
export function mergeEventData(popupData, cateringData, popupDaily, cateringDaily, retailTaxRate = 0.077) {
  const merged = {}
  merged.gfs_popup = (popupData?.gfs_popup || 0)
  merged.gfs_catering = (cateringData?.gfs_catering || 0)
  merged.gfs_retail = (popupData?.gfs_retail || 0)
  merged.gfs_total = merged.gfs_popup + merged.gfs_catering + merged.gfs_retail
  merged.rev_popup_cogs = popupData?.rev_popup_cogs || 0
  merged.rev_popup_food_sales = popupData?.rev_popup_food_sales || 0
  merged.rev_popup_tax = popupData?.rev_popup_tax || 0
  merged.rev_popup_pp_fee = popupData?.rev_popup_pp_fee || 0
  merged.rev_catering_cogs = cateringData?.rev_catering_cogs || 0
  merged.rev_catering_revenue = cateringData?.rev_catering_revenue || 0
  merged.rev_catering_pp_fee = cateringData?.rev_catering_pp_fee || 0
  merged.rev_delivery_cogs = 0
  merged.rev_retail_barista = popupData?.rev_retail_barista || 0
  merged.rev_retail_cafeteria = popupData?.rev_retail_cafeteria || 0
  merged.rev_retail_cogs_tax = -Math.abs((merged.rev_retail_barista + merged.rev_retail_cafeteria) * retailTaxRate)
  merged.rev_client_fees = popupData?.rev_client_fees || 0
  merged.revenue_total = merged.rev_popup_cogs + merged.rev_popup_food_sales + merged.rev_popup_tax
    + merged.rev_popup_pp_fee + merged.rev_catering_cogs + merged.rev_catering_revenue
    + merged.rev_catering_pp_fee + merged.rev_delivery_cogs + merged.rev_retail_barista
    + merged.rev_retail_cafeteria + merged.rev_retail_cogs_tax + merged.rev_client_fees
  const allDates = new Set([
    ...Object.keys(popupDaily || {}),
    ...Object.keys(cateringDaily || {}),
  ])
  const daily = {}
  for (const d of allDates) {
    daily[d] = {
      popup: (popupDaily?.[d]?.popup || 0) + (cateringDaily?.[d]?.popup || 0),
      catering: (popupDaily?.[d]?.catering || 0) + (cateringDaily?.[d]?.catering || 0),
      retail: (popupDaily?.[d]?.retail || 0) + (cateringDaily?.[d]?.retail || 0),
    }
  }
  merged._daily = daily
  for (const [k, v] of Object.entries(merged)) {
    if (typeof v === 'number') merged[k] = Math.round(v * 100) / 100
  }
  return merged
}
