import * as XLSX from 'xlsx'

// Retail vendor patterns — these are Fooda-operated (11 Dining LLC)
const RETAIL_PATTERNS = [/11 dining/i, /barista/i, /cafeteria/i]

function isRetailVendor(name) {
  return RETAIL_PATTERNS.some(p => p.test(name || ''))
}

function isBarista(name) {
  return /barista/i.test(name || '')
}

/**
 * Parse a Fooda Popup event export (65 columns).
 * Returns aggregated Revenue sub-line data.
 */
function parsePopupExport(rows) {
  const result = {
    gfs_popup: 0, gfs_retail: 0,
    rev_popup_cogs: 0, rev_popup_food_sales: 0, rev_popup_tax: 0, rev_popup_pp_fee: 0,
    rev_retail_barista: 0, rev_retail_cafeteria: 0,
    rev_client_fees: 0,
    popup_net_revenue: 0, retail_net_revenue: 0,
    popup_events: 0, retail_events: 0,
    vendors: new Set(),
  }

  for (const row of rows) {
    const gfs = parseFloat(row['Gross Food Sales']) || 0
    if (gfs === 0 && !row['Commission']) continue

    const vendor = row['Restaurant Internal Name'] || row['Partner Internal Name'] || ''
    const commission = parseFloat(row['Commission']) || 0
    const foodNet = parseFloat(row['Food Sale Net']) || 0
    const taxNet = parseFloat(row['Tax Net']) || 0
    const ppFee = parseFloat(row['Payment Processing Fee']) || 0
    const netRev = parseFloat(row['Net Revenue']) || 0
    const clientFees = parseFloat(row['Account Other Fee Net Amt']) || 0

    result.vendors.add(vendor)

    if (isRetailVendor(vendor)) {
      result.gfs_retail += gfs
      result.retail_events++
      result.retail_net_revenue += netRev
      if (isBarista(vendor)) {
        result.rev_retail_barista += gfs
      } else {
        result.rev_retail_cafeteria += gfs
      }
    } else {
      result.gfs_popup += gfs
      result.popup_events++
      result.popup_net_revenue += netRev
      result.rev_popup_cogs += -(gfs - commission) // negative (vendor payout)
      result.rev_popup_food_sales += foodNet
      result.rev_popup_tax += taxNet
      result.rev_popup_pp_fee += ppFee
      result.rev_client_fees += clientFees
    }
  }

  return result
}

/**
 * Parse a Fooda Catering event export (19 columns).
 * Returns aggregated Revenue sub-line data.
 */
function parseCateringExport(rows) {
  const result = {
    gfs_catering: 0,
    rev_catering_cogs: 0, rev_catering_revenue: 0, rev_catering_pp_fee: 0,
    catering_events: 0,
    vendors: new Set(),
  }

  for (const row of rows) {
    const price = parseFloat(row['Total Price']) || 0
    if (price === 0) continue

    const vendor = row['Entity name'] || ''
    const commission = parseFloat(row['Commission']) || 0

    result.vendors.add(vendor)
    result.gfs_catering += price
    result.rev_catering_revenue += price
    result.rev_catering_cogs += -(price - commission) // negative (vendor payout)
    result.catering_events++
  }

  return result
}

/**
 * Parse an event export file. Auto-detects popup (65 cols) vs catering (19 cols).
 * Returns { type, data, summary }
 */
export async function parseEventExport(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = (e) => {
      try {
        const wb = XLSX.read(e.target.result, { type: 'array', cellDates: true })
        const sheet = wb.Sheets[wb.SheetNames[0]]
        const rows = XLSX.utils.sheet_to_json(sheet)

        if (rows.length === 0) {
          reject(new Error('File is empty'))
          return
        }

        const colCount = Object.keys(rows[0]).length

        let type, data
        if (colCount >= 50) {
          // Popup export (65 columns)
          type = 'popup'
          data = parsePopupExport(rows)
        } else if (colCount <= 25) {
          // Catering export (19 columns)
          type = 'catering'
          data = parseCateringExport(rows)
        } else {
          reject(new Error(`Unrecognized file format (${colCount} columns). Expected popup (65 cols) or catering (19 cols).`))
          return
        }

        // Round all values to 2 decimals
        for (const [k, v] of Object.entries(data)) {
          if (typeof v === 'number') data[k] = Math.round(v * 100) / 100
        }

        // Build summary
        const summary = {
          type,
          fileName: file.name,
          rowCount: rows.length,
          vendorCount: data.vendors?.size || 0,
          vendors: [...(data.vendors || [])],
        }
        delete data.vendors

        resolve({ type, data, summary })
      } catch (err) {
        reject(new Error('Failed to parse file: ' + err.message))
      }
    }
    reader.onerror = () => reject(new Error('Failed to read file'))
    reader.readAsArrayBuffer(file)
  })
}

/**
 * Merge popup + catering data into a single P&L write object.
 */
export function mergeEventData(popupData, cateringData) {
  const merged = {}

  // GFS
  merged.gfs_popup = (popupData?.gfs_popup || 0)
  merged.gfs_catering = (cateringData?.gfs_catering || 0)
  merged.gfs_retail = (popupData?.gfs_retail || 0)
  merged.gfs_total = merged.gfs_popup + merged.gfs_catering + merged.gfs_retail

  // Revenue sub-lines
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

  // Compute total revenue
  merged.revenue_total = merged.rev_popup_cogs + merged.rev_popup_food_sales + merged.rev_popup_tax
    + merged.rev_popup_pp_fee + merged.rev_catering_cogs + merged.rev_catering_revenue
    + merged.rev_catering_pp_fee + merged.rev_delivery_cogs + merged.rev_retail_barista
    + merged.rev_retail_cafeteria + merged.rev_retail_cogs_tax + merged.rev_client_fees

  // Round everything
  for (const [k, v] of Object.entries(merged)) {
    if (typeof v === 'number') merged[k] = Math.round(v * 100) / 100
  }

  return merged
}
