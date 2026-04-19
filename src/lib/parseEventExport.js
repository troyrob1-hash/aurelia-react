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
        const sheet = wb.Sheets[wb.SheetNames[0]]
        const rows = XLSX.utils.sheet_to_json(sheet)
        if (rows.length === 0) { reject(new Error('File is empty')); return }
        const colCount = Object.keys(rows[0]).length
        let type, parsed
        if (colCount >= 50) { type = 'popup'; parsed = parsePopupExport(rows) }
        else if (colCount <= 25) { type = 'catering'; parsed = parseCateringExport(rows) }
        else { reject(new Error(`Unrecognized format (${colCount} cols)`)); return }
        const data = parsed.totals
        const daily = parsed.daily
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

export function mergeEventData(popupData, cateringData, popupDaily, cateringDaily) {
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
  merged.rev_retail_cogs_tax = -Math.abs((merged.rev_retail_barista + merged.rev_retail_cafeteria) * 0.077)
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
