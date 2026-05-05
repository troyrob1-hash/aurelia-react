// Client-side audit trail logger
// Records every significant action with user, timestamp, and context
// Writes to tenants/{orgId}/auditTrail collection

import { db } from './firebase'
import { collection, addDoc, serverTimestamp } from 'firebase/firestore'

export async function logAction(orgId, action, details = {}) {
  if (!orgId) return
  try {
    await addDoc(collection(db, 'tenants', orgId, 'auditTrail'), {
      action,
      ...details,
      createdAt: serverTimestamp(),
    })
  } catch (err) {
    console.warn('Audit log failed:', err.message)
  }
}

// Pre-built action loggers
export const audit = {
  // P&L
  pnlUpdated: (orgId, user, location, periodKey, fields) =>
    logAction(orgId, 'pnl.updated', { user: user?.email, location, periodKey, fields: Object.keys(fields), timestamp: new Date().toISOString() }),
  
  periodClosed: (orgId, user, location, periodKey) =>
    logAction(orgId, 'period.closed', { user: user?.email, location, periodKey, timestamp: new Date().toISOString() }),

  periodReopened: (orgId, user, location, periodKey) =>
    logAction(orgId, 'period.reopened', { user: user?.email, location, periodKey, timestamp: new Date().toISOString() }),

  // Invoices
  invoiceCreated: (orgId, user, invoice) =>
    logAction(orgId, 'invoice.created', { user: user?.email, vendor: invoice.vendor, amount: invoice.amount, source: invoice.source }),

  invoiceApproved: (orgId, user, invoiceId, amount) =>
    logAction(orgId, 'invoice.approved', { user: user?.email, invoiceId, amount }),

  invoicePaid: (orgId, user, invoiceId, amount) =>
    logAction(orgId, 'invoice.paid', { user: user?.email, invoiceId, amount }),

  // Journal entries
  jeCreated: (orgId, user, je) =>
    logAction(orgId, 'je.created', { user: user?.email, glCode: je.glCode, amount: je.totalAmount, description: je.description }),

  // Orders
  orderSubmitted: (orgId, user, order) =>
    logAction(orgId, 'order.submitted', { user: user?.email, vendor: order.vendor, total: order.total, itemCount: order.lineItems?.length }),

  orderReceived: (orgId, user, orderId, discrepancyCount) =>
    logAction(orgId, 'order.received', { user: user?.email, orderId, discrepancyCount }),

  // Inventory
  inventoryCounted: (orgId, user, location, periodKey, itemCount) =>
    logAction(orgId, 'inventory.counted', { user: user?.email, location, periodKey, itemCount }),

  // Labor
  laborImported: (orgId, user, location, periodKey, rowCount) =>
    logAction(orgId, 'labor.imported', { user: user?.email, location, periodKey, rowCount }),

  // Sales
  salesImported: (orgId, user, location, periodKey, source) =>
    logAction(orgId, 'sales.imported', { user: user?.email, location, periodKey, source }),

  // Budget
  budgetUploaded: (orgId, user, location, year) =>
    logAction(orgId, 'budget.uploaded', { user: user?.email, location, year }),

  // Auth
  userLogin: (orgId, user) =>
    logAction(orgId, 'user.login', { user: user?.email, timestamp: new Date().toISOString() }),

  // Settings
  settingsChanged: (orgId, user, setting, oldVal, newVal) =>
    logAction(orgId, 'settings.changed', { user: user?.email, setting, oldVal, newVal }),

  // Integrations
  integrationConnected: (orgId, user, integrationId) =>
    logAction(orgId, 'integration.connected', { user: user?.email, integrationId }),

  integrationSynced: (orgId, user, integrationId, result) =>
    logAction(orgId, 'integration.synced', { user: user?.email, integrationId, ...result }),

  // Export
  dataExported: (orgId, user, exportType, location, periodKey) =>
    logAction(orgId, 'data.exported', { user: user?.email, exportType, location, periodKey }),
}
