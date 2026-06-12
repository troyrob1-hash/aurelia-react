// src/hooks/useOrders.js
//
// NOTE: The useOrders() hook that previously lived here was a fully-built but
// UNUSED order-approval workflow (createDraft / submitOrder / approveOrder /
// recordReceiving, etc.). Nothing imported the hook — only the constants below
// are used (OrderHub imports APPROVAL_THRESHOLDS). The hook was removed because
// its role checks did not match the app's permission model (permissions.js) and
// it implemented an order-approval flow the product does not use (orders need no
// approval). The live order flow lives in src/routes/OrderHub.jsx (submitOrders).
//
// If an orders hook is ever needed, build it against permissions.js
// (getUserRoles / canApproveSales), sort client-side (no orderBy), and post to
// P&L via writePurchasingPnL — do not resurrect the old version.

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
  CANCELLED: 'Cancelled',
}

// Approval thresholds (imported by OrderHub)
export const APPROVAL_THRESHOLDS = {
  AUTO_APPROVE: 250,
  DIRECTOR_REQUIRED: 1000,
}
