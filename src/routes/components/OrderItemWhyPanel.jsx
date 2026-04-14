// src/routes/components/OrderItemWhyPanel.jsx
//
// Lightweight "why this item" side drawer for OrderHub. Click any item in
// the catalog to see: cart context, par/on-hand state, last order history,
// price trend, and same-item alternatives from other vendors. Designed
// to be cheap — no Firestore fetches, everything computed from the data
// already in OrderHub's memory (items, qty, pastOrders).

import { X, TrendingUp, TrendingDown, AlertTriangle, Package, Clock } from 'lucide-react'
import styles from './OrderItemWhyPanel.module.css'

export default function OrderItemWhyPanel({ item, qty, items, pastOrders, onClose }) {
  if (!item) return null

  const inCart = qty[item.id] || 0
  const cartSubtotal = inCart * (item.unitCost || 0)

  // Par / on-hand status
  const belowPar = item.par > 0 && item.onHand < item.par
  const atPar = item.par > 0 && item.onHand >= item.par
  const parStatus = !item.par ? null : belowPar ? 'below' : 'at'

  // Find the most recent past order containing this item
  let lastOrder = null
  let lastQty = 0
  let lastUnitCost = 0
  let lastOrderDate = null
  if (pastOrders?.length) {
    const normalize = (s) => (s || '').toString().trim().toLowerCase()
    const targetName = normalize(item.name)
    const targetSku = normalize(item.sku)
    for (const order of pastOrders) {
      if (!order.items) continue
      for (const li of order.items) {
        const matches = li.id === item.id
          || (li.sku && normalize(li.sku) === targetSku)
          || (li.name && normalize(li.name) === targetName)
        if (matches) {
          lastOrder = order
          lastQty = li.qty || 0
          lastUnitCost = li.unitCost || 0
          lastOrderDate = order.createdAt?.toDate?.() || null
          break
        }
      }
      if (lastOrder) break
    }
  }

  // Price trend vs last order
  let priceDelta = null
  let priceDeltaPct = null
  if (lastUnitCost > 0 && item.unitCost > 0) {
    priceDelta = item.unitCost - lastUnitCost
    priceDeltaPct = (priceDelta / lastUnitCost) * 100
  }

  // Same item from other vendors (fuzzy match on name)
  const alternatives = []
  if (items?.length && item.name) {
    const normalize = (s) => (s || '').toString().trim().toLowerCase()
    const targetName = normalize(item.name)
    for (const candidate of items) {
      if (candidate.id === item.id) continue
      if (normalize(candidate.name) === targetName && candidate.vendor !== item.vendor) {
        alternatives.push({
          vendor: candidate.vendor,
          unitCost: candidate.unitCost,
          delta: ((candidate.unitCost - item.unitCost) / item.unitCost) * 100,
        })
      }
    }
    alternatives.sort((a, b) => a.unitCost - b.unitCost)
  }

  // Age of last order
  let ageLabel = null
  if (lastOrderDate) {
    const days = Math.floor((Date.now() - lastOrderDate.getTime()) / (1000 * 60 * 60 * 24))
    if (days === 0) ageLabel = 'today'
    else if (days === 1) ageLabel = 'yesterday'
    else if (days < 7) ageLabel = `${days} days ago`
    else if (days < 30) ageLabel = `${Math.floor(days / 7)} wk ago`
    else ageLabel = `${Math.floor(days / 30)} mo ago`
  }

  return (
    <>
      <div className={styles.backdrop} onClick={onClose}/>
      <div className={styles.drawer}>
        <div className={styles.header}>
          <div className={styles.titleBlock}>
            <div className={styles.vendor}>{item.vendor || 'Unknown vendor'}</div>
            <h2 className={styles.title}>{item.name}</h2>
            <div className={styles.meta}>
              {item.pack && <span>{item.pack}</span>}
              {item.pack && <span className={styles.dot}>·</span>}
              <span className={styles.price}>${(item.unitCost || 0).toFixed(2)} / unit</span>
            </div>
          </div>
          <button className={styles.closeBtn} onClick={onClose}><X size={18}/></button>
        </div>

        <div className={styles.body}>
          {/* Cart state */}
          <div className={styles.section}>
            <div className={styles.sectionLabel}>In this cart</div>
            {inCart > 0 ? (
              <div className={styles.sectionValue}>
                <strong>{inCart}</strong> × ${item.unitCost.toFixed(2)} = <strong>${cartSubtotal.toFixed(2)}</strong>
              </div>
            ) : (
              <div className={styles.sectionMuted}>Not in cart</div>
            )}
          </div>

          {/* Par / on-hand */}
          {item.par > 0 && (
            <div className={styles.section}>
              <div className={styles.sectionLabel}>Stock status</div>
              <div className={styles.stockRow}>
                <div className={styles.stockCell}>
                  <div className={styles.stockLabel}>On hand</div>
                  <div className={styles.stockValue}>{item.onHand}</div>
                </div>
                <div className={styles.stockCell}>
                  <div className={styles.stockLabel}>Par</div>
                  <div className={styles.stockValue}>{item.par}</div>
                </div>
                <div className={styles.stockCell}>
                  <div className={styles.stockLabel}>Delta</div>
                  <div
                    className={styles.stockValue}
                    style={{ color: belowPar ? '#dc2626' : '#065f46' }}
                  >
                    {item.onHand - item.par >= 0 ? '+' : ''}{item.onHand - item.par}
                  </div>
                </div>
              </div>
              {belowPar && (
                <div className={styles.warnBadge}>
                  <AlertTriangle size={12}/> Below par — consider ordering {item.par - item.onHand} to restock
                </div>
              )}
            </div>
          )}

          {/* Last order */}
          {lastOrder && (
            <div className={styles.section}>
              <div className={styles.sectionLabel}>
                <Clock size={11}/> Last ordered
              </div>
              <div className={styles.sectionValue}>
                <strong>{lastQty}</strong> units {ageLabel && <>{ageLabel}</>}
              </div>
              <div className={styles.sectionSub}>
                {lastOrder.orderNum} · ${(lastQty * lastUnitCost).toFixed(2)}
              </div>
              {priceDelta !== null && Math.abs(priceDeltaPct) > 0.5 && (
                <div className={styles.priceTrend} style={{
                  color: priceDelta > 0 ? '#dc2626' : '#065f46',
                }}>
                  {priceDelta > 0 ? <TrendingUp size={12}/> : <TrendingDown size={12}/>}
                  {priceDelta > 0 ? '+' : ''}{priceDeltaPct.toFixed(1)}% vs last order
                  ({lastUnitCost > 0 ? `was $${lastUnitCost.toFixed(2)}` : ''})
                </div>
              )}
            </div>
          )}

          {/* Alternatives from other vendors */}
          {alternatives.length > 0 && (
            <div className={styles.section}>
              <div className={styles.sectionLabel}>
                <Package size={11}/> Also available from
              </div>
              <div className={styles.altList}>
                {alternatives.slice(0, 5).map((alt, idx) => (
                  <div key={idx} className={styles.altRow}>
                    <span className={styles.altVendor}>{alt.vendor}</span>
                    <span className={styles.altPrice}>${alt.unitCost.toFixed(2)}</span>
                    <span
                      className={styles.altDelta}
                      style={{ color: alt.delta < 0 ? '#065f46' : alt.delta > 0 ? '#dc2626' : '#64748b' }}
                    >
                      {alt.delta > 0 ? '+' : ''}{alt.delta.toFixed(0)}%
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {!lastOrder && alternatives.length === 0 && !item.par && inCart === 0 && (
            <div className={styles.emptyState}>
              No order history or stock data for this item yet.
            </div>
          )}
        </div>
      </div>
    </>
  )
}
