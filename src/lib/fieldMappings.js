// Field mapping configuration for vendor integrations
// Maps vendor-specific field names to Aurelia's internal schema

export const FIELD_MAPPINGS = {
  sysco: {
    catalog: {
      'SUPC': 'sku',
      'Material Description': 'name',
      'Brand': 'vendor',
      'Pack': 'packSize',
      'Size': 'unitSize',
      'Price': 'unitCost',
      'Category': 'category',
      'UPC': 'upc',
    },
    order: {
      'SUPC': 'sku',
      'Qty': 'qty',
      'Ship Date': 'deliveryDate',
      'PO Number': 'poNumber',
    },
  },
  usfoods: {
    catalog: {
      'Item Number': 'sku',
      'Description': 'name',
      'Brand Name': 'vendor',
      'Pack Size': 'packSize',
      'Unit Price': 'unitCost',
      'Category': 'category',
    },
  },
  spartan: {
    sales: {
      'Transaction ID': 'transactionId',
      'Date': 'date',
      'Total': 'amount',
      'Tax': 'tax',
      'Payment Method': 'paymentMethod',
    },
    sku_sold: {
      'SKU': 'sku',
      'Item Name': 'name',
      'Qty Sold': 'qtySold',
      'Revenue': 'revenue',
    },
  },
  toast: {
    sales: {
      'Order Id': 'transactionId',
      'Opened': 'date',
      'Net Amount': 'amount',
      'Tax': 'tax',
      'Payment Type': 'paymentMethod',
    },
  },
  netsuite: {
    journal_export: {
      'glCode': 'account',
      'amount': 'debit',
      'description': 'memo',
      'periodKey': 'postingPeriod',
      'location': 'department',
    },
  },
}

// Apply field mapping to transform vendor data to Aurelia schema
export function mapFields(integrationId, dataType, row) {
  const mapping = FIELD_MAPPINGS[integrationId]?.[dataType]
  if (!mapping) return row

  const result = {}
  Object.entries(row).forEach(([key, value]) => {
    const mappedKey = mapping[key] || key
    result[mappedKey] = value
  })
  return result
}

// Get available field mappings for an integration
export function getMappingConfig(integrationId) {
  return FIELD_MAPPINGS[integrationId] || {}
}
