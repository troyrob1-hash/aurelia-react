# Aurelia FMS — Integration Architecture

**Created:** April 2026
**Owner:** Troy Robinson
**Status:** Reference document for post-pilot integrations

This document captures the architectural decisions and extension points for integrating Aurelia FMS with external systems. It is meant to be referenced when building Order Hub → Purchasing automation and NetSuite synchronization after the pilot.

---

## 1. Order Hub → Purchasing flow

### Goal

When a manager creates a purchase order in Order Hub and the order is fulfilled, an invoice should automatically appear in the Purchasing tab linked to the original PO. The invoice should skip the standard approval workflow because the PO carries the approval.

### Current state

- Order Hub creates PO records (existing functionality)
- Purchasing has a `poNumber` field on every invoice (existing functionality)
- No automatic linkage exists between an Order Hub PO and a Purchasing invoice — invoices are entered manually today

### Target architecture

**Cloud Function trigger pattern.** When an order in Order Hub transitions to a `received` or `fulfilled` state, a Firestore trigger creates a draft invoice in Purchasing.
### Why this bypasses the manual approval flow

The hardened CSV import validation in `processInvoiceFile()` forces all manually imported invoices to `Pending` status, regardless of what the CSV says. This is correct for manual imports because we don't trust user-provided status values.

But invoices created by the Cloud Function trigger run as **admin credentials** with **explicit lineage to an approved PO**. The trigger runs server-side, not through the UI handler, so it does not pass through `processInvoiceFile()`. The trigger's validation rules can be more permissive because the source of trust (an approved PO in `tenants/{orgId}/orders/`) is verifiable.

### Extension points already in place in `Purchasing.jsx`

- `handleSave()` and `processInvoiceFile()` both contain TODO comments noting that programmatic invoice creation bypasses these validations
- `markPaid()` has a clean extension point after the Firestore write where post-payment hooks can be added without touching the UI

### Implementation checklist (post-pilot)

1. Add `sourceType` and `sourcePoId` fields to the invoice schema (default `null` for manual entries)
2. Create Cloud Function `createInvoiceFromPO` triggered on order document updates
3. Add UI in Purchasing showing PO lineage when an invoice has `sourceType: 'purchase_order'`
4. Add a Firestore rule that prevents manual editing of `sourcePoId` (only Cloud Functions can write it)

---

## 2. NetSuite integration

### Goal

When an invoice is marked Paid in Aurelia, a corresponding entry should be pushed to Fooda's NetSuite instance so NetSuite remains the system of record for accounting. NetSuite does not need to push data back to Aurelia.

### Architectural pattern

**One-way sync, Aurelia → NetSuite, triggered on payment.**
### Why a Cloud Function trigger, not direct API calls from the frontend

1. **API credentials never touch the browser.** NetSuite credentials live in Secret Manager and are only accessed by Cloud Functions running with service-account auth.
2. **Retry logic.** If NetSuite is down, the trigger can retry with exponential backoff. A frontend call would fail and require manual intervention.
3. **Audit trail.** Every sync attempt is logged via the existing `writeAuditLog` helper.
4. **Rate limiting.** NetSuite API rate limits are managed server-side.

### Extension points already in place

The Integrations tab (formerly API Keys) supports adding NetSuite credentials with the appropriate metadata. The `createAPIKey` Cloud Function stores them in Secret Manager. A future `pushInvoiceToNetSuite` Cloud Function can retrieve them via `getAPIKeyValue` (or directly from Secret Manager) when triggered.

The invoice schema includes a `syncStatus` field on every new invoice (default `null`), which means we do not need to migrate existing invoice documents when NetSuite sync goes live.

### Implementation checklist (post-pilot)

1. Obtain NetSuite REST API credentials from Fooda IT — needs:
   - Account ID
   - Token-based authentication (TBA): consumer key, consumer secret, token ID, token secret
   - Or OAuth 2.0 client credentials if the IT team prefers
2. Add NetSuite integration via the Integrations tab — service: `netsuite`
3. Create Cloud Function `pushInvoiceToNetSuite` triggered on invoice document updates where `status` changes to `Paid`
4. Map Aurelia invoice fields to NetSuite Vendor Bill schema:
   - `vendor` → NetSuite vendor record
   - `glCode` → NetSuite account
   - `amount` → total
   - `invoiceDate` → tranDate
   - `dueDate` → dueDate
   - `poNumber` → linked PO if present
5. Update `syncStatus` field on the invoice document after each sync attempt
6. Add UI in Purchasing showing sync status badge ("Synced to NetSuite" / "Sync failed - retry")
7. Create a Cloud Function `retryFailedSyncs` scheduled hourly to retry invoices with `syncStatus: 'failed'`

### Failure handling

If NetSuite sync fails, the invoice is still marked Paid in Aurelia (the user's action succeeds). The `syncStatus` field captures the failure for later retry. This decoupling means NetSuite outages do not block Aurelia operations.

---

## 3. General principles for future integrations

These apply to any external system Aurelia connects to (POS systems, payroll, accounting, etc.):

1. **Credentials never in the frontend.** Always store in Secret Manager via the Integrations tab, accessed only by Cloud Functions.
2. **External calls happen in Cloud Functions, not in React components.** Triggers off Firestore document changes are the canonical pattern.
3. **Sync state is captured on the source document.** Every doc that participates in external sync has a `syncStatus` field updated by the Cloud Function.
4. **External system failures do not block user actions.** The user's write succeeds; the sync is a separate concern that can be retried.
5. **Every external API call writes to the audit log.** Use the existing `writeAuditLog` helper from `functions/index.js`.
6. **Permissive on the way in, strict on the way out.** External systems may have inconsistent data. Validate and normalize at the boundary, then trust internally.

---

## Contact

Troy Robinson — troy.robinson@fooda.com
