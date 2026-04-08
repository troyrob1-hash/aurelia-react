// src/hooks/useOrders.js
// Enterprise-grade orders hook with approval workflow

import { useState, useEffect, useCallback, useMemo } from 'react'
import { 
  collection, doc, addDoc, updateDoc, deleteDoc, 
  query, where, orderBy, onSnapshot, serverTimestamp,
  writeBatch, getDoc
} from 'firebase/firestore'
import { db } from '@/lib/firebase'
import { useAuthStore } from '@/store/authStore'
import { useToast } from '@/components/ui/Toast'

// Order status flow
export const ORDER_STATUS = {
  DRAFT: 'Draft',
  SUBMITTED: 'Submitted', 
  PENDING_APPROVAL: 'Pending Approval',
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
  ORDERED: 'Ordered',
  RECEIVING: 'Receiving',
  RECEIVED: 'Received',
  CLOSED: 'Closed',
  CANCELLED: 'Cancelled'
}

// Approval thresholds
export const APPROVAL_THRESHOLDS = {
  AUTO_APPROVE: 250,
  DIRECTOR_REQUIRED: 1000,
}

export function useOrders(locationId = null) {
  // Get user and derive orgId consistently
  const { user } = useAuthStore()
  const orgId = user?.tenantId || null
  
  const toast = useToast()
  const [orders, setOrders] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  // Real-time orders subscription
  useEffect(() => {
    if (!orgId) {
      setOrders([])
      setLoading(false)
      return
    }

    setLoading(true)
    setError(null)

    const ordersRef = collection(db, 'tenants', orgId, 'orders')
    let q = query(ordersRef, orderBy('createdAt', 'desc'))
    
    if (locationId && locationId !== 'all') {
      q = query(ordersRef, 
        where('locationId', '==', locationId),
        orderBy('createdAt', 'desc')
      )
    }

    const unsubscribe = onSnapshot(q, 
      (snapshot) => {
        const data = snapshot.docs.map(doc => ({
          id: doc.id,
          ...doc.data(),
          createdAt: doc.data().createdAt?.toDate?.() || null,
          updatedAt: doc.data().updatedAt?.toDate?.() || null,
        }))
        setOrders(data)
        setLoading(false)
      },
      (err) => {
        console.error('Orders subscription error:', err)
        setError(err.message)
        setLoading(false)
      }
    )

    return () => unsubscribe()
  }, [orgId, locationId])

  // Generate order number: ORD-YYYYMMDD-XXXX
  const generateOrderNum = useCallback(() => {
    const now = new Date()
    const date = now.toISOString().slice(0,10).replace(/-/g, '')
    const rand = Math.floor(Math.random() * 9000 + 1000)
    return `ORD-${date}-${rand}`
  }, [])

  // Create draft order
  const createDraft = useCallback(async (orderData) => {
    if (!orgId || !user) throw new Error('Not authenticated')

    const orderNum = generateOrderNum()
    const order = {
      orderNum,
      status: ORDER_STATUS.DRAFT,
      locationId: orderData.locationId || null,
      locationName: orderData.locationName || '',
      vendorId: orderData.vendorId || null,
      vendorName: orderData.vendorName || '',
      deliveryDate: orderData.deliveryDate || null,
      notes: orderData.notes || '',
      items: orderData.items || [],
      subtotal: orderData.subtotal || 0,
      tax: orderData.tax || 0,
      total: orderData.total || 0,
      // Audit fields
      createdBy: user.email,
      createdByName: user.displayName || user.email,
      createdAt: serverTimestamp(),
      updatedBy: user.email,
      updatedAt: serverTimestamp(),
      // Workflow fields
      submittedBy: null,
      submittedAt: null,
      approvedBy: null,
      approvedAt: null,
      rejectedBy: null,
      rejectedAt: null,
      rejectionReason: null,
      receivedBy: null,
      receivedAt: null,
    }

    const docRef = await addDoc(
      collection(db, 'tenants', orgId, 'orders'), 
      order
    )
    
    toast.success(`Draft order ${orderNum} created`)
    return { id: docRef.id, ...order }
  }, [orgId, user, generateOrderNum, toast])

  // Submit order for approval
  const submitOrder = useCallback(async (orderId, items, metadata = {}) => {
    if (!orgId || !user) throw new Error('Not authenticated')

    const subtotal = items.reduce((sum, i) => sum + (i.qty * i.unitCost), 0)
    const tax = 0
    const total = subtotal + tax

    // Determine if auto-approve applies
    const userRole = user.role || 'Manager'
    let nextStatus = ORDER_STATUS.PENDING_APPROVAL
    let approvedBy = null
    let approvedAt = null

    if (userRole === 'Admin' || userRole === 'Director') {
      nextStatus = ORDER_STATUS.APPROVED
      approvedBy = user.email
      approvedAt = serverTimestamp()
    } else if (total <= APPROVAL_THRESHOLDS.AUTO_APPROVE) {
      nextStatus = ORDER_STATUS.APPROVED
      approvedBy = 'system:auto-approve'
      approvedAt = serverTimestamp()
    }

    const updates = {
      status: nextStatus,
      items: items.map(i => ({
        productId: i.id,
        name: i.name,
        sku: i.sku,
        category: i.cat || i.category,
        pack: i.pack,
        unitCost: i.unitCost,
        qtyOrdered: i.qty,
        qtyReceived: 0,
        subtotal: +(i.qty * i.unitCost).toFixed(2),
        glCode: i.glCode || null,
      })),
      subtotal: +subtotal.toFixed(2),
      tax: +tax.toFixed(2),
      total: +total.toFixed(2),
      submittedBy: user.email,
      submittedAt: serverTimestamp(),
      approvedBy,
      approvedAt,
      updatedBy: user.email,
      updatedAt: serverTimestamp(),
      ...metadata,
    }

    await updateDoc(doc(db, 'tenants', orgId, 'orders', orderId), updates)

    if (nextStatus === ORDER_STATUS.APPROVED) {
      toast.success(`Order submitted and approved`)
    } else {
      toast.info(`Order submitted — pending approval`)
    }

    return { status: nextStatus, total }
  }, [orgId, user, toast])

  // Quick submit (create + submit in one action)
  const quickSubmit = useCallback(async (orderData) => {
    const draft = await createDraft(orderData)
    return submitOrder(draft.id, orderData.items, {
      vendorId: orderData.vendorId,
      vendorName: orderData.vendorName,
      locationId: orderData.locationId,
      locationName: orderData.locationName,
      deliveryDate: orderData.deliveryDate,
      notes: orderData.notes,
    })
  }, [createDraft, submitOrder])

  // Approve order (Director/Admin only)
  const approveOrder = useCallback(async (orderId, notes = '') => {
    if (!orgId || !user) throw new Error('Not authenticated')
    
    const userRole = user.role || 'Manager'
    if (userRole === 'Manager') {
      throw new Error('Managers cannot approve orders')
    }

    await updateDoc(doc(db, 'tenants', orgId, 'orders', orderId), {
      status: ORDER_STATUS.APPROVED,
      approvedBy: user.email,
      approvedAt: serverTimestamp(),
      approvalNotes: notes,
      updatedBy: user.email,
      updatedAt: serverTimestamp(),
    })

    toast.success('Order approved')
  }, [orgId, user, toast])

  // Reject order
  const rejectOrder = useCallback(async (orderId, reason) => {
    if (!orgId || !user) throw new Error('Not authenticated')
    if (!reason?.trim()) throw new Error('Rejection reason required')

    await updateDoc(doc(db, 'tenants', orgId, 'orders', orderId), {
      status: ORDER_STATUS.REJECTED,
      rejectedBy: user.email,
      rejectedAt: serverTimestamp(),
      rejectionReason: reason,
      updatedBy: user.email,
      updatedAt: serverTimestamp(),
    })

    toast.warning('Order rejected')
  }, [orgId, user, toast])

  // Record receiving
  const recordReceiving = useCallback(async (orderId, receivedItems, isPartial = false) => {
    if (!orgId || !user) throw new Error('Not authenticated')

    const orderRef = doc(db, 'tenants', orgId, 'orders', orderId)
    const orderSnap = await getDoc(orderRef)
    if (!orderSnap.exists()) throw new Error('Order not found')

    const order = orderSnap.data()
    const updatedItems = order.items.map(item => {
      const received = receivedItems.find(r => r.productId === item.productId)
      if (received) {
        return { ...item, qtyReceived: received.qtyReceived }
      }
      return item
    })

    const allReceived = updatedItems.every(i => i.qtyReceived >= i.qtyOrdered)
    
    await updateDoc(orderRef, {
      items: updatedItems,
      status: allReceived ? ORDER_STATUS.RECEIVED : ORDER_STATUS.RECEIVING,
      receivedBy: user.email,
      receivedAt: serverTimestamp(),
      updatedBy: user.email,
      updatedAt: serverTimestamp(),
    })

    toast.success(allReceived ? 'Order fully received' : 'Partial receipt recorded')
  }, [orgId, user, toast])

  // Cancel order
  const cancelOrder = useCallback(async (orderId, reason = '') => {
    if (!orgId || !user) throw new Error('Not authenticated')

    await updateDoc(doc(db, 'tenants', orgId, 'orders', orderId), {
      status: ORDER_STATUS.CANCELLED,
      cancelledBy: user.email,
      cancelledAt: serverTimestamp(),
      cancellationReason: reason,
      updatedBy: user.email,
      updatedAt: serverTimestamp(),
    })

    toast.info('Order cancelled')
  }, [orgId, user, toast])

  // Duplicate order (reorder)
  const duplicateOrder = useCallback(async (orderId) => {
    const original = orders.find(o => o.id === orderId)
    if (!original) throw new Error('Order not found')

    return createDraft({
      locationId: original.locationId,
      locationName: original.locationName,
      vendorId: original.vendorId,
      vendorName: original.vendorName,
      items: original.items.map(i => ({
        ...i,
        qtyReceived: 0,
      })),
      subtotal: original.subtotal,
      total: original.total,
      notes: `Reorder from ${original.orderNum}`,
    })
  }, [orders, createDraft])

  // Computed: Orders by status
  const ordersByStatus = useMemo(() => {
    const grouped = {}
    Object.values(ORDER_STATUS).forEach(s => grouped[s] = [])
    orders.forEach(o => {
      if (grouped[o.status]) grouped[o.status].push(o)
    })
    return grouped
  }, [orders])

  // Computed: Pending approval count
  const pendingApprovalCount = useMemo(() => 
    orders.filter(o => o.status === ORDER_STATUS.PENDING_APPROVAL).length
  , [orders])

  // Computed: This week's order total
  const weeklyOrderTotal = useMemo(() => {
    const now = new Date()
    const startOfWeek = new Date(now)
    startOfWeek.setDate(now.getDate() - now.getDay())
    startOfWeek.setHours(0, 0, 0, 0)
    
    return orders
      .filter(o => o.createdAt && o.createdAt >= startOfWeek)
      .reduce((sum, o) => sum + (o.total || 0), 0)
  }, [orders])

  return {
    orders,
    ordersByStatus,
    pendingApprovalCount,
    weeklyOrderTotal,
    loading,
    error,
    createDraft,
    submitOrder,
    quickSubmit,
    approveOrder,
    rejectOrder,
    recordReceiving,
    cancelOrder,
    duplicateOrder,
    ORDER_STATUS,
    APPROVAL_THRESHOLDS,
  }
}

export default useOrders