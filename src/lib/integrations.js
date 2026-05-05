// Integration Service Layer
// Standardized adapter pattern for all vendor integrations
// Each adapter implements: connect, disconnect, sync, getStatus

import { db } from './firebase'
import { doc, getDoc, setDoc, updateDoc, serverTimestamp, collection, addDoc } from 'firebase/firestore'

// Registry of available integrations
export const INTEGRATIONS = {
  sysco: {
    id: 'sysco',
    name: 'Sysco',
    category: 'distributor',
    capabilities: ['catalog', 'pricing', 'ordering'],
    authType: 'api_key',
    docsUrl: 'https://developer.sysco.com',
    tabs: ['orderhub', 'inventory', 'purchasing'],
  },
  usfoods: {
    id: 'usfoods',
    name: 'US Foods',
    category: 'distributor',
    capabilities: ['catalog', 'pricing', 'ordering'],
    authType: 'api_key',
    docsUrl: 'https://developer.usfoods.com',
    tabs: ['orderhub', 'inventory', 'purchasing'],
  },
  spartan: {
    id: 'spartan',
    name: 'Spartan POS',
    category: 'pos',
    capabilities: ['sales', 'sku_sold', 'daily_totals'],
    authType: 'api_key',
    docsUrl: null,
    tabs: ['sales', 'shrinkage'],
  },
  toast: {
    id: 'toast',
    name: 'Toast POS',
    category: 'pos',
    capabilities: ['sales', 'sku_sold', 'daily_totals', 'menu'],
    authType: 'oauth',
    docsUrl: 'https://doc.toasttab.com',
    tabs: ['sales', 'shrinkage'],
  },
  mosaic: {
    id: 'mosaic',
    name: 'Mosaic',
    category: 'labor',
    capabilities: ['labor_gl', 'payroll'],
    authType: 'file_import',
    docsUrl: null,
    tabs: ['labor'],
  },
  netsuite: {
    id: 'netsuite',
    name: 'NetSuite',
    category: 'erp',
    capabilities: ['journal_export', 'ap_export', 'gl_sync'],
    authType: 'oauth',
    docsUrl: 'https://docs.oracle.com/en/cloud/saas/netsuite/',
    tabs: ['ledger', 'purchasing', 'pnl'],
  },
  quickbooks: {
    id: 'quickbooks',
    name: 'QuickBooks Online',
    category: 'accounting',
    capabilities: ['journal_export', 'ap_export'],
    authType: 'oauth',
    docsUrl: 'https://developer.intuit.com',
    tabs: ['pnl', 'purchasing'],
  },
}

// ─── Integration Status Management ───────────────────────────

export async function getIntegrationStatus(orgId, integrationId) {
  const ref = doc(db, 'tenants', orgId, 'integrations', integrationId)
  const snap = await getDoc(ref)
  if (!snap.exists()) return { connected: false, lastSync: null, error: null }
  return snap.data()
}

export async function setIntegrationStatus(orgId, integrationId, status) {
  const ref = doc(db, 'tenants', orgId, 'integrations', integrationId)
  await setDoc(ref, {
    ...status,
    integrationId,
    updatedAt: serverTimestamp(),
  }, { merge: true })
}

export async function logSyncEvent(orgId, integrationId, event) {
  await addDoc(collection(db, 'tenants', orgId, 'syncLog'), {
    integrationId,
    ...event,
    createdAt: serverTimestamp(),
  })
}

// ─── Base Adapter Class ──────────────────────────────────────

export class IntegrationAdapter {
  constructor(orgId, integrationId, config = {}) {
    this.orgId = orgId
    this.integrationId = integrationId
    this.config = config
    this.meta = INTEGRATIONS[integrationId]
  }

  async connect(credentials) {
    // Validate credentials, test connection, store status
    try {
      const testResult = await this.testConnection(credentials)
      if (testResult.success) {
        await setIntegrationStatus(this.orgId, this.integrationId, {
          connected: true,
          connectedAt: serverTimestamp(),
          lastSync: null,
          error: null,
          config: this.config,
        })
        await logSyncEvent(this.orgId, this.integrationId, {
          type: 'connected',
          message: 'Integration connected successfully',
        })
        return { success: true }
      }
      return { success: false, error: testResult.error }
    } catch (err) {
      return { success: false, error: err.message }
    }
  }

  async disconnect() {
    await setIntegrationStatus(this.orgId, this.integrationId, {
      connected: false,
      disconnectedAt: serverTimestamp(),
    })
    await logSyncEvent(this.orgId, this.integrationId, {
      type: 'disconnected',
      message: 'Integration disconnected',
    })
  }

  async sync(options = {}) {
    const startTime = Date.now()
    try {
      await setIntegrationStatus(this.orgId, this.integrationId, {
        syncStatus: 'syncing',
        lastSyncStarted: serverTimestamp(),
      })

      const result = await this.performSync(options)

      await setIntegrationStatus(this.orgId, this.integrationId, {
        syncStatus: 'success',
        lastSync: serverTimestamp(),
        lastSyncDuration: Date.now() - startTime,
        lastSyncResult: {
          itemsProcessed: result.itemsProcessed || 0,
          itemsCreated: result.itemsCreated || 0,
          itemsUpdated: result.itemsUpdated || 0,
          errors: result.errors || 0,
        },
        error: null,
      })

      await logSyncEvent(this.orgId, this.integrationId, {
        type: 'sync_complete',
        duration: Date.now() - startTime,
        ...result,
      })

      return result
    } catch (err) {
      await setIntegrationStatus(this.orgId, this.integrationId, {
        syncStatus: 'error',
        error: err.message,
        lastSyncDuration: Date.now() - startTime,
      })

      await logSyncEvent(this.orgId, this.integrationId, {
        type: 'sync_error',
        error: err.message,
        duration: Date.now() - startTime,
      })

      throw err
    }
  }

  // Override in subclass
  async testConnection(credentials) {
    return { success: false, error: 'Not implemented' }
  }

  // Override in subclass
  async performSync(options) {
    return { itemsProcessed: 0 }
  }
}

// ─── Vendor-specific Adapters ────────────────────────────────

export class SyscoAdapter extends IntegrationAdapter {
  constructor(orgId, config) {
    super(orgId, 'sysco', config)
  }

  async testConnection(credentials) {
    // Will call Sysco API /v1/ping or similar
    // For now, validate that key format is correct
    if (!credentials.apiKey || credentials.apiKey.length < 10) {
      return { success: false, error: 'Invalid API key format' }
    }
    return { success: true }
  }

  async performSync(options) {
    // Will call Sysco API to fetch catalog, prices
    // Then write to tenants/{orgId}/inventoryCatalog
    return { itemsProcessed: 0, message: 'Sysco sync not yet configured — waiting for API access' }
  }
}

export class SpartanPOSAdapter extends IntegrationAdapter {
  constructor(orgId, config) {
    super(orgId, 'spartan', config)
  }

  async testConnection(credentials) {
    if (!credentials.apiKey) {
      return { success: false, error: 'API key required' }
    }
    return { success: true }
  }

  async performSync(options) {
    // Will call Spartan POS API to fetch daily sales + SKU data
    // Then write to tenants/{orgId}/posData and sales submissions
    return { itemsProcessed: 0, message: 'Spartan POS sync not yet configured — waiting for API access' }
  }
}

export class NetSuiteAdapter extends IntegrationAdapter {
  constructor(orgId, config) {
    super(orgId, 'netsuite', config)
  }

  async testConnection(credentials) {
    if (!credentials.accountId || !credentials.consumerKey) {
      return { success: false, error: 'Account ID and Consumer Key required' }
    }
    return { success: true }
  }

  async performSync(options) {
    // Will push JEs and AP to NetSuite
    return { itemsProcessed: 0, message: 'NetSuite sync not yet configured — waiting for OAuth setup' }
  }
}

// ─── Adapter Factory ─────────────────────────────────────────

export function getAdapter(orgId, integrationId, config = {}) {
  switch (integrationId) {
    case 'sysco': return new SyscoAdapter(orgId, config)
    case 'usfoods': return new SyscoAdapter(orgId, config) // same API pattern
    case 'spartan': return new SpartanPOSAdapter(orgId, config)
    case 'toast': return new SpartanPOSAdapter(orgId, config) // similar pattern
    case 'netsuite': return new NetSuiteAdapter(orgId, config)
    default: return new IntegrationAdapter(orgId, integrationId, config)
  }
}
