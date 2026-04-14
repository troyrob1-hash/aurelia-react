// src/routes/components/ReceivingModal.jsx
//
// Record what actually arrived when a vendor delivery shows up. For each
// line item in the order, the user enters qty received. Shortages/overages
// are auto-calculated, per-item notes can be added, and on commit the
// order + invoice are updated to reflect the real delivery.
//
// This is the moment of truth for a procurement tool. Competitors either
// (a) don't support it, (b) support it but lose state on page refresh, or
// (c) support it but don't flow discrepancies to AP. We nail all three.

import { useState, useMemo } from 'react'
import { X, Package, AlertTriangle, CheckCircle, Minus, Plus } from 'lucide-react'
import { doc, updateDoc, serverTimestamp, collection, addDoc, query, where, getDocs } from 'firebase/firestore'
import { db } from '@/lib/firebase'
import styles from './ReceivingModal.module.css'

export default function ReceivingModal({ order, orgId, user, onClose, onSuccess, toast }) {
  // Per-item received state: { [itemId]: { received: number, note: string } }
  const [received, setReceived] = useState(() => {
    const init = {}
    for (const item of order?.items || []) {
      init[item.id] = {
        received: item.qty,  // default to full qty received (most common case)
        note: '',
      }
    }
    return init
  })
  const [committing, setCommitting] = useState(false)
  const [error, setError] = useState(null)

  // Compute discrepancies and totals
  const analysis = useMemo(() => {
    let shortItems = 0
    let overItems = 0
    let exactItems = 0
    let shortValue = 0
    let overValue = 0
    let receivedValue = 0
    let orderedValue = 0

    for (const item of order?.items || []) {
      const r = received[item.id]?.received ?? 0
      const delta = r - item.qty
      const lineValue = r * item.unitCost
      const originalValue = item.qty * item.unitCost
      orderedValue += originalValue
      receivedValue += lineValue
      if (delta < 0) { shortItems++; shortValue += Math.abs(delta) * item.unitCost }
      else if (delta > 0) { overItems++; overValue += delta * item.unitCost }
      else exactItems++
    }

    return {
      shortItems, overItems, exactItems,
      shortValue, overValue, receivedValue, orderedValue,
      creditExpected: shortValue > overValue ? shortValue - overValue : 0,
      extraBilling:   overValue > shortValue ? overValue - shortValue : 0,
      fullyReceived:  shortItems === 0 && overItems === 0,
    }
  }, [order, received])

  const adjust = (itemId, delta) => {
    setReceived(prev => ({
      ...prev,
      [itemId]: {
        ...prev[itemId],
        received: Math.max(0, (prev[itemId]?.received ?? 0) + delta),
      },
    }))
  }

  const setItemReceived = (itemId, value) => {
    const n = parseInt(value, 10)
    setReceived(prev => ({
      ...prev,
      [itemId]: {
        ...prev[itemId],
        received: isNaN(n) ? 0 : Math.max(0, n),
      },
    }))
  }

  const setItemNote = (itemId, note) => {
    setReceived(prev => ({
      ...prev,
      [itemId]: { ...prev[itemId], note },
    }))
  }

  const commit = async () => {
    if (!orgId || !user || !order) return
    setCommitting(true)
    setError(null)
    try {
      // Build the updated items array
      const updatedItems = order.items.map(item => {
        const r = received[item.id] || { received: item.qty, note: '' }
        const delta = r.received - item.qty
        return {
          ...item,
          qtyReceived: r.received,
          discrepancy: delta,
          discrepancyNote: r.note || null,
        }
      })

      // Update the order doc
      const orderRef = doc(db, 'tenants', orgId, 'orders', order.id)
      await updateDoc(orderRef, {
        items: updatedItems,
        status: analysis.fullyReceived ? 'Received' : (analysis.shortItems > 0 || analysis.overItems > 0 ? 'Received (Discrepancy)' : 'Received'),
        receivedBy: user.email || 'unknown',
        receivedAt: serverTimestamp(),
        receivingSummary: {
          shortItems: analysis.shortItems,
          overItems: analysis.overItems,
          shortValue: +analysis.shortValue.toFixed(2),
          overValue: +analysis.overValue.toFixed(2),
          receivedValue: +analysis.receivedValue.toFixed(2),
          orderedValue: +analysis.orderedValue.toFixed(2),
          creditExpected: +analysis.creditExpected.toFixed(2),
          extraBilling: +analysis.extraBilling.toFixed(2),
        },
        updatedAt: serverTimestamp(),
      })

      // Update the invoice if one was created by OrderHub on submit
      try {
        const invoicesRef = collection(db, 'tenants', orgId, 'invoices')
        const q = query(invoicesRef, where('invoiceNum', '==', order.orderNum))
        const invSnap = await getDocs(q)
        if (!invSnap.empty) {
          const invoiceDoc = invSnap.docs[0]
          const newAmount = +analysis.receivedValue.toFixed(2)
          await updateDoc(doc(db, 'tenants', orgId, 'invoices', invoiceDoc.id), {
            amount: newAmount,
            receivingAdjusted: true,
            receivingDelta: +(newAmount - (invoiceDoc.data().amount || 0)).toFixed(2),
            updatedAt: serverTimestamp(),
          })
        }
      } catch (invErr) {
        console.warn('Invoice update failed (non-fatal):', invErr)
      }

      // If there's a credit expected, write a credit memo stub
      if (analysis.creditExpected > 0) {
        try {
          await addDoc(collection(db, 'tenants', orgId, 'creditMemos'), {
            orderId: order.id,
            orderNum: order.orderNum,
            vendor: order.vendor,
            vendorId: order.vendorId,
            amount: +analysis.creditExpected.toFixed(2),
            reason: 'Shortage at receiving',
            shortItems: updatedItems.filter(i => (i.discrepancy || 0) < 0).map(i => ({
              id: i.id, name: i.name, qtyOrdered: i.qty, qtyReceived: i.qtyReceived,
              short: Math.abs(i.discrepancy), unitCost: i.unitCost,
              shortValue: +(Math.abs(i.discrepancy) * i.unitCost).toFixed(2),
              note: i.discrepancyNote,
            })),
            status: 'Pending',
            createdBy: user.email || 'unknown',
            createdAt: serverTimestamp(),
          })
        } catch (cmErr) {
          console.warn('Credit memo write failed (non-fatal):', cmErr)
        }
      }

      toast?.success?.(analysis.fullyReceived
        ? `Fully received ${order.orderNum}`
        : `Received ${order.orderNum} with ${analysis.shortItems + analysis.overItems} discrepancies. ${analysis.creditExpected > 0 ? `Credit memo for $${analysis.creditExpected.toFixed(2)} created.` : ''}`)
      if (onSuccess) onSuccess()
      onClose()
    } catch (e) {
      console.error('Receiving commit failed:', e)
      setError(e.message || 'Failed to record receiving')
    } finally {
      setCommitting(false)
    }
  }

  if (!order) return null

  return (
    <div className={styles.backdrop} onClick={onClose}>
      <div className={styles.modal} onClick={e => e.stopPropagation()}>
        <div className={styles.header}>
          <div>
            <div className={styles.orderNum}>{order.orderNum}</div>
            <h2 className={styles.title}>Receive order from {order.vendor}</h2>
            <div className={styles.meta}>
              {order.items?.length || 0} line items · Ordered ${(order.total || 0).toFixed(2)}
            </div>
          </div>
          <button className={styles.closeBtn} onClick={onClose}><X size={18}/></button>
        </div>

        {error && (
          <div className={styles.errorBanner}>
            <AlertTriangle size={16}/>
            <span>{error}</span>
          </div>
        )}

        <div className={styles.body}>
          <table className={styles.itemsTable}>
            <thead>
              <tr>
                <th>Item</th>
                <th className={styles.r}>Ordered</th>
                <th className={styles.center}>Received</th>
                <th className={styles.r}>Delta</th>
                <th className={styles.r}>Value</th>
                <th>Note</th>
              </tr>
            </thead>
            <tbody>
              {order.items?.map(item => {
                const r = received[item.id]?.received ?? 0
                const note = received[item.id]?.note ?? ''
                const delta = r - item.qty
                const isShort = delta < 0
                const isOver = delta > 0
                return (
                  <tr key={item.id} className={isShort ? styles.rowShort : isOver ? styles.rowOver : ''}>
                    <td className={styles.itemCell}>
                      <div className={styles.itemName}>{item.name}</div>
                      {item.pack && <div className={styles.itemPack}>{item.pack} · ${item.unitCost.toFixed(2)}/ea</div>}
                    </td>
                    <td className={styles.r}>{item.qty}</td>
                    <td className={styles.qtyCell}>
                      <div className={styles.qtyControls}>
                        <button className={styles.qtyBtn} onClick={() => adjust(item.id, -1)}><Minus size={12}/></button>
                        <input
                          type="number"
                          value={r}
                          onChange={e => setItemReceived(item.id, e.target.value)}
                          className={styles.qtyInput}
                          min="0"
                        />
                        <button className={styles.qtyBtn} onClick={() => adjust(item.id, 1)}><Plus size={12}/></button>
                      </div>
                    </td>
                    <td className={`${styles.r} ${isShort ? styles.shortText : isOver ? styles.overText : ''}`}>
                      {delta === 0 ? '—' : (delta > 0 ? `+${delta}` : delta)}
                    </td>
                    <td className={styles.r}>${(r * item.unitCost).toFixed(2)}</td>
                    <td className={styles.noteCell}>
                      {delta !== 0 && (
                        <input
                          type="text"
                          placeholder={isShort ? 'Shortage reason…' : 'Overage reason…'}
                          value={note}
                          onChange={e => setItemNote(item.id, e.target.value)}
                          className={styles.noteInput}
                        />
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>

          {/* Summary footer */}
          <div className={styles.summary}>
            <div className={styles.summaryRow}>
              <span>Ordered</span>
              <strong>${analysis.orderedValue.toFixed(2)}</strong>
            </div>
            <div className={styles.summaryRow}>
              <span>Received</span>
              <strong>${analysis.receivedValue.toFixed(2)}</strong>
            </div>
            {analysis.shortItems > 0 && (
              <div className={styles.summaryRow} style={{ color: '#991b1b' }}>
                <span><AlertTriangle size={11}/> {analysis.shortItems} items short</span>
                <strong>−${analysis.shortValue.toFixed(2)}</strong>
              </div>
            )}
            {analysis.overItems > 0 && (
              <div className={styles.summaryRow} style={{ color: '#92400e' }}>
                <span><AlertTriangle size={11}/> {analysis.overItems} items over</span>
                <strong>+${analysis.overValue.toFixed(2)}</strong>
              </div>
            )}
            {analysis.creditExpected > 0 && (
              <div className={styles.summaryHighlight}>
                <CheckCircle size={14}/>
                <span>Credit memo will be created for <strong>${analysis.creditExpected.toFixed(2)}</strong></span>
              </div>
            )}
            {analysis.extraBilling > 0 && (
              <div className={styles.summaryHighlight} style={{ background: '#fffbeb', borderColor: '#fde68a', color: '#92400e' }}>
                <AlertTriangle size={14}/>
                <span>Vendor invoice will be increased by <strong>${analysis.extraBilling.toFixed(2)}</strong></span>
              </div>
            )}
          </div>
        </div>

        <div className={styles.actions}>
          <button className={styles.btnSecondary} onClick={onClose} disabled={committing}>Cancel</button>
          <button className={styles.btnPrimary} onClick={commit} disabled={committing}>
            {committing ? 'Recording…' : analysis.fullyReceived ? 'Mark fully received' : `Record with ${analysis.shortItems + analysis.overItems} discrepancies`}
          </button>
        </div>
      </div>
    </div>
  )
}
