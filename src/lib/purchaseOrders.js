// Purchase Order lifecycle management
// Tracks orders from submission through invoicing
// Works with any distributor — Sysco, US Foods, PFG, etc.

import { db } from './firebase'
import { doc, setDoc, getDoc, updateDoc, collection, addDoc, query, where, getDocs, serverTimestamp, orderBy } from 'firebase/firestore'
import { audit } from './audit'

// Order statuses
export const PO_STATUS = {
  DRAFT: 'draft',
  SUBMITTED: 'submitted',
  CONFIRMED: 'confirmed',     // vendor acknowledged
  SHIPPED: 'shipped',         // vendor shipped
  DELIVERED: 'delivered',     // operator confirmed receiving
  INVOICED: 'invoiced',       // vendor invoice received
  MATCHED: 'matched',         // 3-way match passed
  DISPUTED: 'disputed',       // 3-way match failed — needs review
  POSTED: 'posted',           // posted to P&L
  CANCELLED: 'cancelled',
}

// Create a purchase order from an Order Hub submission
export async function createPurchaseOrder(orgId, user, orderData) {
  const poRef = await addDoc(collection(db, 'tenants', orgId, 'purchaseOrders'), {
    poNumber: 'PO-' + Date.now().toString(36).toUpperCase(),
    vendor: orderData.vendor || 'Unknown',
    vendorId: orderData.vendorId || null,
    distributor: orderData.distributor || orderData.vendor || 'Unknown',
    location: orderData.location,
    status: PO_STATUS.SUBMITTED,
    
    // Line items as ordered
    lineItems: (orderData.lineItems || []).map(li => ({
      sku: li.sku || li.id || '',
      name: li.name || '',
      orderedQty: li.qty || 0,
      unitCost: li.unitCost || li.price || 0,
      unit: li.unit || 'ea',
      category: li.category || '',
      receivedQty: null,       // filled on receiving
      invoicedQty: null,       // filled on invoice
      invoicedCost: null,      // filled on invoice — may differ from order price
    })),
    
    orderTotal: orderData.total || 0,
    receivedTotal: null,
    invoiceTotal: null,
    
    // Receiving
    receivedAt: null,
    receivedBy: null,
    receivingNotes: null,
    discrepancies: [],
    
    // Invoice matching
    vendorInvoiceId: null,     // vendor's invoice number
    vendorInvoiceDate: null,
    invoiceReceivedAt: null,
    invoiceSource: null,       // 'api', 'webhook', 'pdf-upload', 'manual'
    matchStatus: null,         // 'exact', 'partial', 'mismatch'
    matchDetails: null,        // detailed comparison
    
    // P&L posting
    postedToPnl: false,
    postedAt: null,
    periodKey: orderData.periodKey || null,
    glCode: orderData.glCode || 'cogs_food',
    
    // Meta
    submittedBy: user?.email || 'unknown',
    submittedAt: serverTimestamp(),
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  })
  
  await audit.orderSubmitted(orgId, user, orderData)
  return poRef.id
}

// Record delivery receiving
export async function recordReceiving(orgId, user, poId, receivingData) {
  const poRef = doc(db, 'tenants', orgId, 'purchaseOrders', poId)
  const poSnap = await getDoc(poRef)
  if (!poSnap.exists()) throw new Error('Purchase order not found')
  
  const po = poSnap.data()
  const updatedItems = po.lineItems.map(li => {
    const received = receivingData.items?.[li.sku] || receivingData.items?.[li.name]
    return {
      ...li,
      receivedQty: received?.qty ?? li.orderedQty,
    }
  })
  
  const receivedTotal = updatedItems.reduce((s, li) => s + (li.receivedQty || 0) * (li.unitCost || 0), 0)
  
  const discrepancies = updatedItems
    .filter(li => li.receivedQty !== li.orderedQty)
    .map(li => ({
      sku: li.sku,
      name: li.name,
      ordered: li.orderedQty,
      received: li.receivedQty,
      difference: li.receivedQty - li.orderedQty,
      valueDiff: (li.receivedQty - li.orderedQty) * li.unitCost,
    }))
  
  await updateDoc(poRef, {
    status: PO_STATUS.DELIVERED,
    lineItems: updatedItems,
    receivedTotal,
    receivedAt: serverTimestamp(),
    receivedBy: user?.email || 'unknown',
    receivingNotes: receivingData.notes || null,
    discrepancies,
    updatedAt: serverTimestamp(),
  })
  
  await audit.orderReceived(orgId, user, poId, discrepancies.length)
  return { receivedTotal, discrepancies }
}

// Process an incoming vendor invoice (from API, webhook, or manual entry)
export async function processVendorInvoice(orgId, invoiceData) {
  // invoiceData: { vendor, invoiceNumber, invoiceDate, lineItems, total, source, poNumber? }
  
  // Try to find the matching PO
  let matchedPO = null
  
  if (invoiceData.poNumber) {
    // Direct PO match by number
    const q = query(
      collection(db, 'tenants', orgId, 'purchaseOrders'),
      where('poNumber', '==', invoiceData.poNumber)
    )
    const snap = await getDocs(q)
    if (!snap.empty) matchedPO = { id: snap.docs[0].id, ...snap.docs[0].data() }
  }
  
  if (!matchedPO && invoiceData.vendor) {
    // Try matching by vendor + approximate total + recent date
    const q = query(
      collection(db, 'tenants', orgId, 'purchaseOrders'),
      where('vendor', '==', invoiceData.vendor),
      where('status', 'in', [PO_STATUS.SUBMITTED, PO_STATUS.DELIVERED]),
      orderBy('submittedAt', 'desc')
    )
    const snap = await getDocs(q)
    
    // Find closest total match
    for (const d of snap.docs) {
      const po = d.data()
      const totalDiff = Math.abs((po.orderTotal || 0) - (invoiceData.total || 0))
      const pctDiff = po.orderTotal > 0 ? totalDiff / po.orderTotal : 1
      if (pctDiff < 0.15) { // within 15% — likely the same order
        matchedPO = { id: d.id, ...po }
        break
      }
    }
  }
  
  // Perform 3-way match if PO found
  let matchResult = null
  if (matchedPO) {
    matchResult = performThreeWayMatch(matchedPO, invoiceData)
  }
  
  // Write the invoice to AP
  const invoiceRef = await addDoc(collection(db, 'tenants', orgId, 'invoices'), {
    vendor: invoiceData.vendor,
    vendorId: invoiceData.vendorId || null,
    invoiceNum: invoiceData.invoiceNumber || '',
    invoiceDate: invoiceData.invoiceDate || new Date().toISOString().slice(0, 10),
    amount: invoiceData.total || 0,
    lineItems: invoiceData.lineItems || [],
    
    // Source tracking
    source: invoiceData.source || 'api',          // 'api', 'webhook', 'pdf-upload', 'manual'
    distributor: invoiceData.vendor,
    
    // PO matching
    poId: matchedPO?.id || null,
    poNumber: matchedPO?.poNumber || invoiceData.poNumber || null,
    matchStatus: matchResult?.status || 'unmatched',
    matchDetails: matchResult || null,
    
    // GL classification
    glCode: invoiceData.glCode || matchedPO?.glCode || 'cogs_food',
    location: invoiceData.location || matchedPO?.location || '',
    periodKey: invoiceData.periodKey || matchedPO?.periodKey || '',
    
    // Status
    status: matchResult?.status === 'exact' ? 'Approved' : 'Pending',
    autoApproved: matchResult?.status === 'exact',
    
    // Credits
    creditAmount: matchResult?.creditAmount || 0,
    creditReason: matchResult?.creditReason || null,
    
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  })
  
  // Update the PO status
  if (matchedPO) {
    await updateDoc(doc(db, 'tenants', orgId, 'purchaseOrders', matchedPO.id), {
      status: matchResult?.status === 'exact' ? PO_STATUS.MATCHED : PO_STATUS.INVOICED,
      vendorInvoiceId: invoiceData.invoiceNumber,
      vendorInvoiceDate: invoiceData.invoiceDate,
      invoiceReceivedAt: serverTimestamp(),
      invoiceSource: invoiceData.source,
      invoiceTotal: invoiceData.total,
      matchStatus: matchResult?.status || null,
      matchDetails: matchResult || null,
      updatedAt: serverTimestamp(),
    })
  }
  
  return {
    invoiceId: invoiceRef.id,
    poId: matchedPO?.id || null,
    matchResult,
  }
}

// 3-way match: PO vs Receiving vs Invoice
function performThreeWayMatch(po, invoice) {
  const result = {
    status: 'exact',         // exact, partial, mismatch
    poTotal: po.orderTotal || 0,
    receivedTotal: po.receivedTotal || po.orderTotal || 0,
    invoiceTotal: invoice.total || 0,
    
    totalVariance: 0,
    lineVariances: [],
    creditAmount: 0,
    creditReason: null,
    
    checks: {
      poToReceived: 'pass',
      receivedToInvoice: 'pass',
      poToInvoice: 'pass',
    },
  }
  
  // Check PO vs Received
  if (po.receivedTotal !== null && po.receivedTotal !== undefined) {
    const diff = Math.abs(po.receivedTotal - po.orderTotal)
    if (diff > 1) {
      result.checks.poToReceived = diff / po.orderTotal > 0.05 ? 'fail' : 'warn'
    }
  }
  
  // Check Received vs Invoice
  const receivedTotal = po.receivedTotal || po.orderTotal
  const invRecDiff = Math.abs(invoice.total - receivedTotal)
  if (invRecDiff > 1) {
    result.checks.receivedToInvoice = invRecDiff / receivedTotal > 0.05 ? 'fail' : 'warn'
  }
  
  // Check PO vs Invoice
  const invPoDiff = Math.abs(invoice.total - po.orderTotal)
  if (invPoDiff > 1) {
    result.checks.poToInvoice = invPoDiff / po.orderTotal > 0.05 ? 'fail' : 'warn'
  }
  
  result.totalVariance = invoice.total - po.orderTotal
  
  // Line item comparison
  if (invoice.lineItems && po.lineItems) {
    for (const invLine of invoice.lineItems) {
      const poLine = po.lineItems.find(p => 
        p.sku === invLine.sku || p.name === invLine.name
      )
      if (poLine) {
        const qtyDiff = (invLine.qty || invLine.invoicedQty || 0) - poLine.orderedQty
        const costDiff = (invLine.unitCost || invLine.price || 0) - poLine.unitCost
        if (Math.abs(qtyDiff) > 0 || Math.abs(costDiff) > 0.01) {
          result.lineVariances.push({
            sku: poLine.sku,
            name: poLine.name,
            orderedQty: poLine.orderedQty,
            receivedQty: poLine.receivedQty,
            invoicedQty: invLine.qty || invLine.invoicedQty,
            orderedCost: poLine.unitCost,
            invoicedCost: invLine.unitCost || invLine.price,
            qtyDiff,
            costDiff,
          })
        }
      }
    }
  }
  
  // Calculate credit if items were short
  if (po.discrepancies && po.discrepancies.length > 0) {
    result.creditAmount = po.discrepancies
      .filter(d => d.difference < 0)
      .reduce((s, d) => s + Math.abs(d.valueDiff || 0), 0)
    if (result.creditAmount > 0) {
      result.creditReason = po.discrepancies
        .filter(d => d.difference < 0)
        .map(d => d.name + ' x' + Math.abs(d.difference))
        .join(', ')
    }
  }
  
  // Determine overall status
  const hasFailure = Object.values(result.checks).includes('fail')
  const hasWarning = Object.values(result.checks).includes('warn')
  
  if (hasFailure || result.lineVariances.length > 2) {
    result.status = 'mismatch'
  } else if (hasWarning || result.lineVariances.length > 0) {
    result.status = 'partial'
  } else {
    result.status = 'exact'
  }
  
  return result
}

// Post matched invoice to P&L
export async function postInvoiceToPnl(orgId, user, invoiceId) {
  const invRef = doc(db, 'tenants', orgId, 'invoices', invoiceId)
  const invSnap = await getDoc(invRef)
  if (!invSnap.exists()) throw new Error('Invoice not found')
  
  const inv = invSnap.data()
  const { writePnL } = await import('./pnl.js')
  
  const netAmount = (inv.amount || 0) - (inv.creditAmount || 0)
  
  await writePnL(inv.location, inv.periodKey, {
    [inv.glCode || 'cogs_food']: netAmount,
  })
  
  await updateDoc(invRef, {
    status: 'Posted',
    postedAt: serverTimestamp(),
    postedBy: user?.email,
    netAmount,
    updatedAt: serverTimestamp(),
  })
  
  // Update PO status
  if (inv.poId) {
    await updateDoc(doc(db, 'tenants', orgId, 'purchaseOrders', inv.poId), {
      status: PO_STATUS.POSTED,
      postedToPnl: true,
      postedAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    })
  }
  
  await audit.invoicePaid(orgId, user, invoiceId, netAmount)
  return { netAmount }
}

// Get all POs for a location
export async function getPurchaseOrders(orgId, location, statuses = null) {
  let q = query(
    collection(db, 'tenants', orgId, 'purchaseOrders'),
    where('location', '==', location),
    orderBy('submittedAt', 'desc')
  )
  
  const snap = await getDocs(q)
  let results = snap.docs.map(d => ({ id: d.id, ...d.data() }))
  
  if (statuses) {
    results = results.filter(r => statuses.includes(r.status))
  }
  
  return results
}
