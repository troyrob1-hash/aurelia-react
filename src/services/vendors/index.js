// src/services/vendors/index.js
// Vendor integration layer - plug in APIs as they become available

export const VENDOR_INTEGRATIONS = {
  sysco: {
    id: 'sysco',
    name: 'Sysco',
    status: 'pending', // 'pending' | 'connected' | 'error'
    apiType: 'graphql', // Sysco uses Apollo GraphQL
    endpoints: {
      orders: null,    // Fill when API access granted
      products: null,
      pricing: null,
    },
    submitOrder: async (order, credentials) => {
      // TODO: Implement when Sysco API access granted
      console.log('Sysco API not yet configured')
      return { success: false, error: 'API not configured' }
    },
  },
  
  nassau: {
    id: 'nassau',
    name: 'Nassau Candy',
    status: 'pending',
    apiType: 'rest',
    endpoints: {},
    submitOrder: async (order, credentials) => {
      console.log('Nassau API not yet configured')
      return { success: false, error: 'API not configured' }
    },
  },
  
  cafemoto: {
    id: 'cafemoto',
    name: 'Café Moto',
    status: 'pending',
    apiType: 'email', // Some vendors only do email orders
    endpoints: {},
    submitOrder: async (order, credentials) => {
      console.log('Café Moto - email order flow')
      return { success: false, error: 'Email flow not implemented' }
    },
  },
  
  davidrio: {
    id: 'davidrio',
    name: 'David Rio',
    status: 'pending',
    apiType: 'rest',
    endpoints: {},
    submitOrder: async (order, credentials) => {
      console.log('David Rio API not yet configured')
      return { success: false, error: 'API not configured' }
    },
  },
}

// Submit order to vendor API (or fallback)
export async function submitToVendor(vendorId, order, credentials = {}) {
  const vendor = VENDOR_INTEGRATIONS[vendorId]
  
  if (!vendor) {
    return { success: false, error: `Unknown vendor: ${vendorId}` }
  }
  
  if (vendor.status !== 'connected') {
    // Fallback: Generate order for manual submission
    return {
      success: true,
      method: 'manual',
      message: `Order ready for manual submission to ${vendor.name}`,
      portalUrl: getVendorPortalUrl(vendorId),
    }
  }
  
  try {
    return await vendor.submitOrder(order, credentials)
  } catch (error) {
    console.error(`Vendor API error (${vendorId}):`, error)
    return { success: false, error: error.message }
  }
}

// Vendor portal URLs for manual fallback
export function getVendorPortalUrl(vendorId) {
  const urls = {
    sysco: 'https://shop.sysco.com',
    nassau: 'https://www.nassaucandy.com',
    cafemoto: 'https://www.cafemoto.com',
    davidrio: 'https://www.davidrio.com',
    amazon: 'https://business.amazon.com',
    webstaurant: 'https://www.webstaurantstore.com',
  }
  return urls[vendorId] || null
}

// Check which vendors have API integration
export function getVendorStatus() {
  return Object.entries(VENDOR_INTEGRATIONS).map(([id, v]) => ({
    id,
    name: v.name,
    status: v.status,
    apiType: v.apiType,
  }))
}