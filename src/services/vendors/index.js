// src/services/vendors/index.js

/**
 * Submit an order to a vendor's API
 * Returns result object with success status
 * Fails gracefully if vendor API is not configured
 */
export async function submitToVendor(vendorId, orderDoc) {
  try {
    console.log(`[vendors] Would submit to vendor ${vendorId}:`, orderDoc)
    
    return {
      success: true,
      submitted: false,
      message: 'Vendor API integration pending',
      vendorId,
      orderNumber: orderDoc.orderNumber || null,
    }
  } catch (err) {
    console.error(`[vendors] Failed to submit to ${vendorId}:`, err)
    return {
      success: false,
      submitted: false,
      message: err.message,
      vendorId,
    }
  }
}