// Data validation utilities
// Used before any Firestore write to ensure data integrity

export function validateInvoice(invoice) {
  const errors = []
  
  if (!invoice.vendor && !invoice.vendorId) errors.push('Vendor is required')
  if (!invoice.amount || invoice.amount <= 0) errors.push('Amount must be positive')
  if (invoice.amount > 1000000) errors.push('Amount exceeds maximum ($1,000,000)')
  if (!invoice.invoiceDate) errors.push('Invoice date is required')
  if (!invoice.periodKey) errors.push('Period is required')
  if (!invoice.location) errors.push('Location is required')
  
  // Date validation
  if (invoice.invoiceDate) {
    const d = new Date(invoice.invoiceDate)
    if (isNaN(d.getTime())) errors.push('Invalid invoice date')
    if (d > new Date(Date.now() + 86400000 * 30)) errors.push('Invoice date is more than 30 days in the future')
  }

  // Duplicate detection
  if (invoice._existingInvoices) {
    const dup = invoice._existingInvoices.find(i =>
      i.vendor === invoice.vendor &&
      i.amount === invoice.amount &&
      i.invoiceDate === invoice.invoiceDate &&
      i.id !== invoice.id
    )
    if (dup) errors.push('Possible duplicate: same vendor, amount, and date')
  }

  return { valid: errors.length === 0, errors }
}

export function validateJournalEntry(je) {
  const errors = []
  
  if (!je.glCode) errors.push('GL code is required')
  if (!je.totalAmount || je.totalAmount <= 0) errors.push('Amount must be positive')
  if (je.totalAmount > 500000) errors.push('Amount exceeds maximum ($500,000)')
  if (!je.description || je.description.trim().length < 3) errors.push('Description is required (min 3 characters)')
  if (!je.periods || je.periods.length === 0) errors.push('At least one period is required')

  return { valid: errors.length === 0, errors }
}

export function validateInventoryCount(items) {
  const errors = []
  
  if (!items || items.length === 0) errors.push('No items to submit')
  
  items.forEach((item, i) => {
    if (item.qty < 0) errors.push(item.name + ': quantity cannot be negative')
    if (item.qty > 99999) errors.push(item.name + ': quantity exceeds maximum (99,999)')
    if (typeof item.qty !== 'number') errors.push(item.name + ': quantity must be a number')
  })

  return { valid: errors.length === 0, errors }
}

export function validateLaborImport(rows) {
  const errors = []
  
  if (!rows || rows.length === 0) errors.push('No data to import')
  
  let totalAmount = 0
  rows.forEach((row, i) => {
    if (!row.glCode) errors.push('Row ' + (i+1) + ': missing GL code')
    if (typeof row.amount !== 'number') errors.push('Row ' + (i+1) + ': invalid amount')
    if (row.amount < 0) errors.push('Row ' + (i+1) + ': negative amount')
    totalAmount += row.amount || 0
  })

  if (totalAmount > 1000000) errors.push('Total labor amount exceeds $1,000,000 — verify data')

  return { valid: errors.length === 0, errors, totalAmount }
}

export function validateBudget(lines) {
  const errors = []
  
  if (!lines || Object.keys(lines).length === 0) errors.push('No budget data')
  
  Object.entries(lines).forEach(([key, periods]) => {
    Object.entries(periods).forEach(([period, value]) => {
      if (typeof value !== 'number') errors.push(key + ' period ' + period + ': must be a number')
      if (value < 0) errors.push(key + ' period ' + period + ': cannot be negative')
    })
  })

  return { valid: errors.length === 0, errors }
}

export function validateSalesData(data) {
  const errors = []
  
  if (!data.gfs_total && !data.gfs_popup) errors.push('At least one GFS field is required')
  
  const numericFields = Object.entries(data).filter(([k, v]) => typeof v === 'number')
  numericFields.forEach(([key, value]) => {
    if (value < -1000000 || value > 10000000) {
      errors.push(key + ': value out of range')
    }
  })

  return { valid: errors.length === 0, errors }
}
