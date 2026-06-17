# Aurelia FMS — Code Audit (2026-06-17)

Triaged findings from a single-pass audit of the live repo on `main` at `422f0ee`. Read targets: `src/`, `functions/`, `netlify/`, `tests/`, `firestore.rules`, `firebase.json`, `firestore.indexes.json`, `vite.config.js`, `netlify.toml`, `package.json`, `.github/workflows/`. `node_modules/`, `dist/`, `scripts/` skipped. High-blast-radius files (`useAutosave`, `SaveStatusBar`, `pnl.js`, `authStore` + Cognito-Firebase bridge, `LocationContext`, `PeriodContext`, `useInventory`) reviewed by the assistant directly; the rest by five specialist subagents.

## Severity scheme

- **P0** — production-breaking, **silent data loss**, security/auth. Anything where a user thinks their work was saved/persisted but it wasn't, where one user's data leaks into another tenant, or where the system can be made to write fake records.
- **P1** — wrong-answer bugs: math errors, stale state used in financial calcs, error swallowing on a critical path, missing dirty triggers, partial-write hazards.
- **P2** — UX/correctness: broken edge cases, confusing errors, accessibility, perf cliffs.
- **P3** — code quality, dead code, duplication, stale comments.

## Confidence and limits — read this before fixing

- Findings marked **Suspected** were not run-verified — the agent reasoned from code but couldn't reproduce. Triage these before estimating effort; some may not reproduce in prod.
- Subagent findings (everything outside the high-blast-radius set noted above) were reviewed by the assistant for plausibility but **not re-derived line-by-line**. Before changing a file, re-read the cited lines to confirm the finding still describes what's there.
- A single sweep catches patterns and obvious bugs. **Subtle race conditions, integration-edge issues across files, and anything depending on real Firestore state will need narrower follow-up.**
- Already-tracked issues (CLAUDE.md Known issues, the two stale rules tests, useAutosave bugs fixed in da2baaa, today's wasteLog/posData rule additions) were excluded from agent reports and are not duplicated here.

## Cross-cutting patterns — fix these classes, not just instances

These show up multiple times across files. Fixing one instance and not the others leaves the bug class alive.

1. **Silent `'fooda'` tenant fallback.** `mapUser` / `mintFirebaseToken` / `_getOrgId` / `AppShell` all default `tenantId` to the string `'fooda'` when the user's claim is missing. Any Cognito user without a `custom:tenantId` claim is silently bucketed into the `fooda` tenant — including their reads and writes. Fix at all four sites in one change. (See P0 entries for `functions/index.js:90`, `src/store/authStore.js:99`, `src/components/layout/AppShell.jsx:57`, `src/lib/pnl.js:18`.)
2. **`merge: true` on a `setDoc` doesn't deep-merge nested maps.** Firestore field-merge **replaces** any top-level map field as a whole. Several writers pass `{ entries: localState, ... }` or `{ lines: budget, ... }` with `merge:true` thinking the nested map will be merged — it isn't, and any incomplete in-memory map silently overwrites the persisted one. Affects WeeklySales draft + save & close, Budgets handleSave, and a few others. The recent inventory `merge:false` + JS-read-merge-write fix (13d3289) was the right pattern; replicate it for sales and budgets.
3. **Auth-race silent data-loss after Firebase sign-in failure.** `signInWithCognito` returns `false` on failure (does not throw); `auth.js:60` / `authStore.js:36` ignore the return value. The app proceeds with a valid Cognito session and a signed-out Firebase Auth, so Firestore writes silently fail under the security rules. Pair with the `'fooda'` fallback above and any token-refresh path can quietly turn a user into a read-only ghost.
4. **Sequential awaits across financial writes with no rollback.** Transfers, Purchasing bulk-approve/bulk-pay, OrderHub submit, AureliaChat JE, Recurring invoices — many paths do `addDoc` → `writePnL` → `updateDoc` sequentially. Mid-loop failure leaves Firestore inconsistent (JE posted but P&L partial; transfers received but inventory not adjusted; orders submitted for some vendors and not others). Pattern fix: use Firestore `runTransaction` or `writeBatch` where possible, otherwise mark the parent doc `status: 'partial'` and surface the failure to the user.
5. **Cents-rounding distribution across weekly buckets.** Budget Approve and event/budget imports compute `Math.round(monthlyValue / numWeeks * 100) / 100` per week — sum-of-weekly ≠ monthly by up to ~$0.48/line. Across 25 lines × 12 months it accumulates to ~$140/yr per location of false variance. Fix once with a `distributeWithRemainder(total, n)` helper; apply at every weekly-split call site (`Budgets.jsx:392`, `WeeklySales.jsx:469`, `Transfers.jsx:186`, `budgetImport.js:295`).
6. **Hardcoded tax/fee rates (7.7% retail tax, 1.8% pp fee, 18% commission).** Multi-tenant app with locations in different jurisdictions. Same constants appear in `pnl.js`, `parseEventExport.js`, `whyRules.js`. Move to per-location config; flag in P1 sections.
7. **`useEffect` deps that omit `orgId`.** Pattern across Transfers (load + JE), AppShell period-close, Budgets all-locations grid, others. After auth state changes (refresh, tenant switch, late sign-in), the effect doesn't re-run and reads/writes against the prior tenant or `undefined`. Fix is mechanical: add `orgId` to every effect that consumes it.
8. **End-of-week date loop drops Sunday.** `for (let d = wk.start; d <= wk.end; d.setDate(d.getDate()+1))` where `wk.end` is at local midnight clips the last day. Fixed in one place in `WeeklySales` (line 353) but the import paths weren't updated. Affects sales + catering imports.
9. **Date math at midnight is DST-fragile.** Several loops use `setDate(d.getDate()+1)` from a midnight start; on spring-forward weeks the increment shifts by 23h and `toISOString().slice(0,10)` can stamp the same day twice or skip one. Standard fix: `d.setHours(12,0,0,0)` before iterating.

---

## P0 — production-breaking, silent data loss, or security

### Auth, tenant isolation, security

- **`functions/index.js:1112`** — `claudeProxy` is `invoker:"public"` with no Authorization-header check (the comment claims it's authenticated; the handler doesn't verify). Anyone with the URL can burn the Anthropic API key.
  - **Impact:** Billing abuse, prompt-injection logging against your Anthropic account, exfil.
  - **Fix sketch:** Verify `req.headers.authorization` via `admin.auth().verifyIdToken(...)` and reject otherwise.
- **`functions/index.js:1153`** — `integrationWebhook` is `invoker:"public"`, logs whether `x-webhook-signature` is present but never verifies it. Any unauthenticated caller can write fake invoices, POs, POS transactions, JE-syncs.
  - **Impact:** Financial-record corruption with no audit link to a person; some paths auto-approve when a `poNumber` matches.
  - **Fix sketch:** HMAC-verify the signature against a per-integration secret from Secret Manager before any write; reject if invalid or missing.
- **`netlify/functions/claude.js`** — Same as `functions/index.js:1112` but on the Netlify edge. No auth, no origin check, no body-size cap.
  - **Impact:** Same Anthropic billing-abuse vector, exposed on the public Netlify host.
  - **Fix sketch:** Require Firebase ID token in Authorization header; verify with `firebase-admin`; cap body size.
- **`functions/index.js:197`** — `inviteUser` accepts caller role of `director` *and* allows the `roles` array to include `"admin"`. A director can mint a Cognito admin in their tenant.
  - **Impact:** Privilege escalation from director → admin via a created account.
  - **Fix sketch:** Restrict caller to `admin`, or strip `"admin"` from `roles` when caller is not admin.
- **`functions/index.js:207`** — `tempPassword = "Welcome2026!"` hardcoded with `Permanent: true` for every invited (and re-invited) account; `generateTempPassword()` (line 479) is defined but never called.
  - **Impact:** Anyone who learns a colleague's email can log in as them with a publicly-knowable password until they change it; re-invites silently reset to the same constant.
  - **Fix sketch:** Use `generateTempPassword()` per invite, return it for one-time admin display, set `Permanent: false`.
- **`src/pages/Settings/components/InviteModal.jsx:82`** — Frontend mirrors the same hardcoded fallback: `const pw = result?.data?.tempPassword || "Welcome2026!"`. If the function omits a tempPassword, the modal shows the constant as if real.
  - **Impact:** Admin hands out a non-working (or universally-known) password.
  - **Fix sketch:** If `tempPassword` is missing, show an error; never invent.
- **`functions/index.js:90`** + **`src/store/authStore.js:99`** + **`src/lib/pnl.js:18`** + **`src/components/layout/AppShell.jsx:57`** — Silent `tenantId = "fooda"` fallback when the user's `custom:tenantId` claim is missing (see Cross-cutting pattern #1).
  - **Impact:** Cross-tenant exposure — a malformed token routes a user's reads/writes into the `fooda` tenant.
  - **Fix sketch:** Refuse to mint a token / load the shell / write P&L when tenantId is missing. Single coordinated change across all four sites.
- **`firestore.rules:339-381`** — The `match /{document=**}` default-deny block contains *nested* match rules for `tenants/{orgId}/periodLocks`, `auditTrail`, `syncLog`, `integrations`, `purchaseOrders`, `posTransactions`, `notifications` that grant access on `request.auth != null` with no `ownsTenant(orgId)` check.
  - **Impact:** Any signed-in user from any tenant can read/write *any other tenant's* period locks (silently unlocking closed books), purchase orders, POS transactions, sync logs, notifications, and fabricate `auditTrail` entries. Largest single-finding blast radius in this audit.
  - **Fix sketch:** Move these blocks out of the wildcard match; gate every rule on `ownsTenant(tenantId)` (and role for writes); restrict `auditTrail` create to admin via callable, not client. Add rules tests covering each.
- **`functions/index.js:338`** — `deactivateUser` calls `cognito.adminDisableUser({ Username: targetUid })`; for users invited as existing accounts the Cognito Username is the email, not the sub UUID, so the Cognito disable silently 404s while Firestore is marked inactive.
  - **Impact:** Deactivated user can keep minting tokens via Cognito; security rules don't check `active`.
  - **Fix sketch:** Resolve Cognito Username from `sub` via `adminListUsers Filter='sub="..."'`, or store the Cognito Username alongside uid in the Firestore user doc.

### Silent data loss

- **`src/components/BarcodeScanner.jsx:36`** — Substring-match fallback `keys.find(k => k.includes(clean) || clean.includes(k))` matches any SKU containing the scanned digits.
  - **Impact:** A 4-char barcode can silently match a wrong product → count goes to the wrong line.
  - **Fix sketch:** Drop partial match; require exact (with leading-zero strip) and minimum length ≥ 8.
- **`src/components/AureliaChat.jsx:227`** — `writePnL(location || 'all', ...)` writes a JE into a phantom `'all'` location bucket when user is on All Locations.
  - **Impact:** Chat-posted JE never lands on any real location's P&L; chat reports success.
  - **Fix sketch:** Block JE creation unless a real location is selected.
- **`src/components/AureliaChat.jsx:213-247`** — JE `addDoc` then `writePnL` are sequential, no rollback; `writePnL` failure leaves orphan JE.
  - **Impact:** JE shows posted but P&L not updated; auditors can't reconcile.
  - **Fix sketch:** Mark JE `status: 'failed'` on writePnL failure, or use a transaction.
- **`src/hooks/useVendorsProducts.js:165-180`** — `useLocationInventory` builds `inv[productId] = data` from a query filtered only by `locationId`; if multiple inventory docs share productId+location, last-write-wins arbitrarily.
  - **Impact:** Real counts overwritten by stale/empty same-id doc.
  - **Fix sketch:** Order by `updatedAt desc` and take first, or enforce a productId-only doc-id convention.
- **`src/pages/Settings/tabs/APIKeysTab.jsx:44`** + **`LocationsTab.jsx:50,87,109,116,134,146,161`** — These two tabs read/write `orgs/{orgId}/...` while the rest of the app uses `tenants/{orgId}/...`. New locations/keys go into a parallel tree no consumer reads.
  - **Impact:** Admin "adds a location" → appears in Settings but never in any dropdown/Sales/Inventory/P&L. Same class of bug as the wasteLog rule we already fixed.
  - **Fix sketch:** Migrate to `tenants/{orgId}/...` (the dominant convention). Audit for other tabs writing into `orgs/`.
- **`src/pages/Settings/tabs/UsersTab.jsx:57-82`** — `fetchUsers(cursor)` ignores the cursor: `getDocs(q)` with no `limit()` or `startAfter()`; "Load more" appends duplicates; `hasMore = snap.docs.length === PAGE_SIZE` is almost always false so the affordance doesn't appear.
  - **Impact:** Admin can't see/manage all users in a large tenant; "Load more" duplicates the list when it does fire.
  - **Fix sketch:** Add `limit(PAGE_SIZE)` + `orderBy('createdAt','desc')` + `startAfter(cursor)`, or drop pagination and fetch all.
- **`src/routes/Budgets.jsx:265`** — Tab calls `setDirty(true)` on cell edits and import, but `useAutosave` is **not** wired and there's no beforeunload guard.
  - **Impact:** Manager edits cells → switches location → all edits lost, no warning.
  - **Fix sketch:** Wire `useAutosave({ save: handleSave, flushKey: `${location}|${year}` })` like Sales/Inventory.
- **`src/routes/Budgets.jsx:372`** — `handleSave` does `setDoc(..., { lines: budget, ... }, { merge: true })` with no guard that `budget` was actually loaded; a fast edit-during-load race writes `{lines:{}}` over an approved budget. (Firestore merge replaces the nested `lines` map as a whole.)
  - **Impact:** Approved annual budget can be wiped to empty.
  - **Fix sketch:** Refuse save if `loading || Object.keys(budget).length === 0`; or read-then-merge.
- **`src/routes/Budgets.jsx:461`** — `repostBudget` reads `activeBudget` (`budget` OR `scenarioBudget`) from closure; if the user clicks Re-post while `showScenario && scenarioGFS !== 0`, the what-if numbers get posted to every weekly P&L.
  - **Impact:** Real P&L overwritten with scenario data.
  - **Fix sketch:** Read raw `budget` directly inside `repostBudget`, or block when scenario is active.
- **`src/routes/Inventory.jsx:519, 531`** — `seedPriorPeriod` writes `locations/{lk}/inventory/{priorPK}` and `inventorySessions/{lk}_{priorPK}` with `setDoc` (no `merge:true`) — fully overwriting any real prior-period data.
  - **Impact:** Admin seeds against a real account → destroys actual prior-period counts.
  - **Fix sketch:** Either pass `{ merge: true }` with a `seeded:true` flag, or refuse to write when the target exists. **Also gate the seed function on `canAdministerSystem`** (see P2 follow-up).
- **`src/routes/LaborPlanner.jsx:228`** — Multi-loader effect (`loadOrgConfig` + `loadBudgets` + `loadGFS` + `loadIntegrations` + `loadPendingSubmission`) has no request-id/staleness check; rapid period/location switching lets older results land last and `setRows`/`setSubmissionId` of period A leaks into period B's view; autosave then writes A's rows into B's doc.
  - **Impact:** Cross-period labor data overwrite.
  - **Fix sketch:** Add a `loadRequestId.current` ref like WeeklySales; bail every setState if stale.
- **`src/routes/OrderHub.jsx:641`** — After submit, `writePurchasingPnL(location, periodKey, { pendingTotal: cartTotal })` writes only the new cart's total to `ap_pending`; merge-write replaces, no increment. A second order in the same period replaces the first order's pending value.
  - **Impact:** Multiple orders/period silently lose earlier `ap_pending`; Dashboard shows only the most recent cart.
  - **Fix sketch:** Read current value and write `current + cartTotal`, aggregate all open orders for the period, or use `FieldValue.increment`.
- **`src/routes/OrderHub.jsx:884`** — Remove-guide writes `{ items: null }` with merge; on next load `data().items || []` becomes `[]`, and the truthy-`[]` guide filter empties the catalog.
  - **Impact:** After "Remove guide", reload silently shows zero items.
  - **Fix sketch:** `deleteDoc` the guide or use `deleteField()`; treat `Array.isArray(items) && items.length === 0` as "no guide" on read.
- **`src/routes/Purchasing.jsx:321`** + **`:509`** — Form-created and PDF-parsed invoices post to P&L via `writePnL(..., { [glCode]: amount })`. `writePnL` uses `setDoc … merge:true` which REPLACES the field — each new invoice for the same period+GL overwrites the prior invoice's contribution.
  - **Impact:** 2nd-and-later invoices for the same GL silently wipe the earlier invoice's amount on Dashboard P&L.
  - **Fix sketch:** Re-aggregate current-period invoices for that GL and write the sum, or switch to `FieldValue.increment`.
- **`src/routes/Transfers.jsx:397`** — `adjustInventory` swallows all errors with an empty catch (`/* non-critical — inventory adjustment failed silently */`), AND skips silently when item name doesn't match (case/whitespace/rename).
  - **Impact:** Transfer marked Received but inventory unchanged at one or both ends — silent inventory drift.
  - **Fix sketch:** Toast and mark transfer `inventoryAdjusted: false`; alert when `fromIdx === -1`.
- **`src/routes/WeeklySales.jsx:191`** — Event import `setDoc(salesRef, {...})` has no `merge:true`, overwriting unrelated top-level fields on the sales doc (submission metadata, `closedBy`, etc.).
  - **Impact:** Event import wipes audit/lock fields.
  - **Fix sketch:** Add `{ merge: true }`.
- **`src/routes/WeeklySales.jsx:786`** — `handleSaveDraft` writes `entries` with `merge:true` which REPLACES the nested map; if `entries` is empty during a load-races-with-debounce window, the saved week's days get wiped. Same class as the inventory fix in 13d3289.
  - **Impact:** Sales day cells silently lost on week/location switch.
  - **Fix sketch:** Guard `if (loading) return false; if (!Object.keys(entries).length && lastSaved) return false;`. Apply the read-then-merge pattern from `useInventory.saveCounts`.

---

## P1 — wrong answers, partial writes, missing audit, error swallowing

### Math / data correctness

- **`src/routes/Budgets.jsx:392`** — `Math.round(v/numWeeks * 100) / 100` per week, no remainder distribution; weekly buckets don't sum to monthly. (Cross-cutting pattern #5.)
- **`src/routes/WeeklySales.jsx:469`** + **`src/routes/Transfers.jsx:186`** + **`src/lib/budgetImport.js:295`** — Same cents-rounding pattern.
- **`src/lib/parseEventExport.js:154`** + **`src/lib/pnl.js:236`** — `rev_retail_cogs_tax = -Math.abs(retail * 0.077)` hardcodes 7.7% retail tax. Cook County is ~10.25%, NY 8.875%. Wrong COGS-tax line for every location outside Fooda's home jurisdiction.
- **`src/lib/whyRules.js:897`** — `payproc = gfs * 0.018` hardcoded; real rate varies per vendor/location. Executive summary's EBITDA differs from real EBITDA by the rate delta.
- **`src/routes/Dashboard.jsx:262`** — `computeEBITDA` ignores new GL-coded labor fields (`cogs_labor_salaries`, `_401k`, `_benefits`, `_taxes`, `_bonus`); the P&L table beneath uses them. KPI strip and table disagree.
- **`src/routes/Dashboard.jsx:265`** — `computeEBITDA` hardcodes `gfs_total * 0.018` for payment processing while the P&L table uses real `cogs_payment_processing`. Double-counts or under-counts.
- **`src/lib/pnlRollup.js:13`** — Sums all numeric fields including percentages; parent-cafe rollup shows nonsense aggregated margins.
  - **Fix:** Switch to the `NUMERIC_KEYS` allowlist used in `usePnL.js`.
- **`src/lib/usePnL.js:71`** — Parent rollup with `period.endsWith('-MONTHLY')` aggregates sub-cafe weeks but `setLoading(false)` fires off the first sub's first response, so parent renders an undercounted snapshot.
- **`src/lib/usePnL.js:165`** — Effect deps `[location, period]` omit `isParent` and `subCafes`; when `allLocations` loads after first render, parent shows its own (empty) doc instead of the rollup.
- **`src/lib/usePnL.js:213`** — `useMultiLocationPnL` sums every numeric key including `budget_*` across all locations; if parent + sub-cafes both carry budgets, they're double-counted.
- **`src/lib/variance.js:47`** — `expected = 0` returns `'neutral'`, so brand-new items (no prior) never appear in variance alerts.
- **`src/lib/purchaseOrders.js:251,259,265`** — Three-way match `diff / po.orderTotal > 0.05` divides by zero on zero-total POs → always `'fail'`.
- **`src/lib/purchaseOrders.js:156`** — Fuzzy invoice-to-PO match using "within 15% of total" + first-by-submittedAt: two similar-value POs from the same vendor get matched arbitrarily; both records silently corrupted.
- **`src/lib/purchaseOrders.js:268`** — `totalVariance = invoice.total - po.orderTotal`; conventionally invoice-vs-received, not invoice-vs-ordered. Reported variance is the wrong delta.
- **`src/lib/ramp.js:71`** — `due_date: invoice.dueDate || invoice.invoiceDate`. Every auto-generated Ramp bill appears past-due immediately.
- **`src/lib/ramp.js:32`** — No `Idempotency-Key` header; retries create duplicate Ramp bills (real-money risk).
- **`src/lib/ramp.js:73`** — `Math.round(invoice.amount * 100)` per line item; rounding each item separately can make line items sum to ≠ invoice total → Ramp rejects, or accepts with drift.
- **`src/lib/parseEventExport.js:61`** — Retail-vendor branch accumulates only GFS; COGS/tax/processing-fee from the same row are silently dropped → revenue total and EBITDA understated.
- **`src/components/AureliaChat.jsx:455-463`** — Forecast treats Fooda period number (1–12) as a calendar month index (`new Date(year, periodMonth, 0).getDate()`) and multiplies `budgetGfs` by `weeksInPeriod` (double-counts if `budgetGfs` is already a period total).
- **`src/components/AureliaChat.jsx:228-241`** — Next-period rollover constructs `nextKey` with `'-W1'` without `padStart` while current-period branch uses raw `(w+1)`; format may not match canonical periodKey.
- **`src/lib/pnl.js:299`** — `writeBudgetPnL` writes period `${year}-${String(mo).padStart(2,'0')}` (e.g. `2026-01`) instead of canonical `2026-P01-MONTHLY`/`2026-P01-Wn`. Budget rows likely don't roll into any consumer.
- **`functions/index.js:1018`** — Recurring-invoice processor uses `Math.ceil(d.getDate()/7)` for periodKey, which doesn't match the Fooda fiscal calendar used elsewhere. Auto-generated invoices land in a period nothing queries.
- **`functions/index.js:1357`** — `posTransactions` batch fallback ID is `serverTimestamp().toString()` (a sentinel that stringifies to a constant). Multiple un-IDed txns in a batch collide on the same doc ID. Silent POS data loss.

### Auth race / partial writes / error swallowing

- **`src/lib/auth.js:107`** + **`src/lib/firebase.js:36`** — Cross-cutting pattern #3. `signInWithCognito` returns `false` on Firebase token-exchange failure instead of throwing; `refreshSession` ignores it; app proceeds as authenticated while Firebase Auth is signed out, every subsequent Firestore write silently fails under rules.
- **`functions/index.js:311`** — `inviteUser` audit-log try/catch swallows failure but still returns `success:true`. Invitation succeeds without an audit record.
- **`functions/index.js:361`** + **`:370`** — `cleanExpiredSessions` queries `orgs.where("active","==",true)` then `sessions where("revokedAt","==",null)`. Firestore equality-on-null only matches docs that *have* the field set to null; any session created without `revokedAt: null` written explicitly is never reaped. Cleanup job effectively dead.
- **`functions/index.js:1376`** — `handleNetSuiteWebhook` batch-updates JEs without verifying existence; a single stale ID fails the whole batch and the outer try/catch just writes a generic `syncStatus:'error'`.
- **`src/components/layout/AppShell.jsx:117-156`** — `handleReopenPeriod` writes close doc → `unlockPeriod` → updates only `approved` submissions; any failure mid-chain leaves the period half-reopened with no rollback. Also only `approved` is cleared; `pending` stays stuck.
- **`src/components/layout/AppShell.jsx:60-71`** — Notifications listener has no `limit()` / `orderBy` and no error callback on `onSnapshot`. Silent listener death + memory/perf cliff for tenants with months of unread.
- **`src/routes/Transfers.jsx:130`** — `handleReversal` sequence (addDoc → writePnL → updateDoc) with no atomicity. Double-click before updateDoc lands → second reversal posts → 2× negative.
- **`src/routes/Transfers.jsx:236`** — Sequential per-period `writePnL` after JE is saved; mid-loop failure leaves JE posted but P&L partial.
- **`src/routes/Transfers.jsx:313`** + **`:174`** — `useEffect` deps omit `orgId`; load runs against `undefined` or stale tenant.
- **`src/routes/Transfers.jsx:369`** — `updateStatus` only gates `Approved` on `isDirector`; a manager can mark `Received` (calls `adjustInventory`) or `Rejected`.
  - **Fix:** Gate Received to destination-location user OR director; gate Rejected to creator-or-director.
- **`src/routes/Purchasing.jsx:288-331`** — Editing an invoice updates Firestore but never re-posts to P&L; amount/GL corrections silently drift Dashboard.
- **`src/routes/Purchasing.jsx:526-560`** — CSV import sets every row's `periodKey` to the current-page periodKey regardless of each row's `invoiceDate`.
- **`src/routes/Purchasing.jsx:626-654`** — `bulkApprove` / `bulkMarkPaid` loops have no per-row try/catch and recompute period totals from a stale closure of `invoices`; partial failures + last-write-wins in `writePurchasingPnL`.
- **`src/routes/OrderHub.jsx:323-344`** — Cart-sync handler calls `setQty(remote.qty || {})` whenever the remote snapshot lacks `qty`; a partial draft write from another device silently empties the local cart.
- **`src/routes/OrderHub.jsx:549-672`** — `submitOrders` does `addDoc(orders) + addDoc(invoices) + submitToVendor` per vendor sequentially; mid-loop failure has no rollback and no per-vendor success reporting; re-submit duplicates the succeeded ones.
- **`src/routes/OrderHub.jsx:416-428,729`** — `frequentItems` reads `o.lineItems`; `submitOrders` writes the field as `items`. Frequent category empty, receiving modal can't load line items for orders this app created.
- **`src/routes/OrderHub.jsx:193,201`** — `loadBudget` effect deps omit `periodKey`; budget loop iterates only W1..W4 (5-week periods truncated).
- **`src/routes/WeeklySales.jsx:284`** — `useState(false)` for `rejectNote`; `rejectNote.trim()` crashes on first reject click.
- **`src/routes/WeeklySales.jsx:486`** — `loadHistoryAndForecast` setters skip the staleness check; old-location forecast/anomaly state lands on the new location.
- **`src/routes/WeeklySales.jsx:840`** — `handleSave` batch write has the same nested-map-replace hazard as `handleSaveDraft`.
- **`src/routes/WeeklySales.jsx:1199,1241,1359`** — Sales/catering imports use the end-of-week loop that drops Sunday (Cross-cutting pattern #8).
- **`src/routes/components/ReceivingModal.jsx:130,149`** — Invoice update and credit memo write swallowed by `console.warn`; AP mismatch and lost recoverable money on vendor shortages.
- **`src/routes/components/VendorImportModal.jsx:144`** — `parsePrice('$N/A')` returns 0; bad rows become $0 unit cost in the catalog with no warning.
- **`src/routes/LaborPlanner.jsx:123`** — `saveLabor` reads outer-closure `submissionId`; autosave across week-switch can create a duplicate submission, then later updates write to the wrong one.
- **`src/routes/LaborPlanner.jsx:277`** — Submissions sorted by `createdAt?.seconds || 0` falls back to 0 for pending serverTimestamp; right after import, newest doc may rank as oldest → wrong submission selected.
- **`src/hooks/useInventory.js:514, 570, 671`** — `setDoc` with `merge: false` + JS-read-merge-write pattern has an unavoidable race window with another device. Acceptable trade-off but worth noting; document or guard.
- **`src/hooks/useAutosave.js:44-46`** — `pagehide`/`visibilitychange` listeners call `flush()` (async) without awaiting; browsers may unload before save resolves. Adjacent to da2baaa fix but still fire-and-forget at the event level.
  - **Fix sketch:** Use `navigator.sendBeacon` or write to localStorage on pagehide.
- **`src/store/authStore.js:47`** — `clearAuth()` resets user/session but doesn't sign out of Firebase Auth; mismatch with `signOut()` which does.
- **`src/lib/inventory.js:18`** — `getInventory` fallback returns prior-week items with `qty: null`; autosave path could persist these as the canonical count for the new week before the user types. (**Suspected** — would need to confirm whether autosave actually writes carryforward items.)
- **`src/lib/budgetImport.js:285`** — Sequential `writePnL` per week with no try/catch; one locked week aborts the loop, leaves the year's budget half-applied.
- **`src/lib/budgetImport.js:285`** — Re-importing the master XLSM overwrites hand-edited approved budgets with no warning.
- **`src/lib/purchaseOrders.js:189`** — `processVendorInvoice` falls back `location || matchedPO?.location || ''`; empty-string fallback creates orphan invoices that no `where('location',...)` query finds.
- **`src/lib/purchaseOrders.js:335`** — `postInvoiceToPnl` doesn't validate `inv.location` / `inv.periodKey` non-empty before `writePnL`. Writes to garbage paths.
- **`src/lib/permissions.js:188`** — `user.assignedLocations` adds names directly to allowed set; location rename silently drops direct-assignment visibility.
- **`src/lib/audit.js`** — Coverage gaps: no logger for permissions role changes, vendor-map writes, period locks, integration credential updates, or budget edits via the Budgets page.
- **`src/components/AureliaChat.jsx:638-643`** — `dangerouslySetInnerHTML` on assistant text split on `::CHART::`; LLM output containing the literal token is dropped straight into innerHTML.
  - **Fix sketch:** Sanitize with DOMPurify, or render via a chart component.
- **`firestore.indexes.json`** — Missing composite indexes for `invoices` (status + scheduledPaymentDate), `invoices.recurrence` (active + nextDate), `purchaseOrders` (poNumber), `orders` (locationId + status). Scheduled `processScheduledPayments` / `processRecurringInvoices` either fail at runtime ("query requires an index") or return partial results during index build.
- **`package.json:14`** — `prebuild: npm test` excludes `tests/rules.test.js`. Rule edits aren't gated by CI.
- **`.github/workflows/daily-smoke-test.yml:34`** — Smoke tests hit production Firestore with admin creds; writes `_smokeTest:true` docs into real prod collections (`tenants/fooda/pnl/...`, orders, budgets, submissions). A failure between `write()` and `cleanupRefs.push(path)` leaves orphans.
- **`src/routes/auth/SignUpPage.jsx`** — File implements self-service Cognito signup; if any router mounts `/signup` it bypasses the request-access review. **Suspected** — confirm no router entry.

---

## P2 — UX, perf, edge cases

- **`src/components/layout/AppShell.jsx:79-83`** — `markAllRead` loops sequentially with swallowed errors; many round-trips, silent partial success. (Use `writeBatch`.)
- **`src/components/SyncStatusPanel.jsx:26-44`** — N concurrent `onSnapshot` listeners with no error callback; `syncLog` fetched once on mount, never refreshes after sync. Stale "Recent activity"; silent listener death.
- **`src/components/BarcodeScanner.jsx:103-128`** — Global keydown excludes `INPUT` only; typing in `<textarea>` / contenteditable while modal open eats keystrokes and may auto-submit.
- **`src/components/Onboarding.jsx:55`** — `localStorage.setItem('aurelia_onboarded','true')` is global, not user-keyed; new users on a shared browser skip onboarding.
- **`src/hooks/usePeriodStatus.js:81`** — `pnl.cogs_purchases ? 'posted' : 'missing'`; legitimate $0 purchases reports `missing` and blocks close.
- **`src/hooks/usePeriodStatus.js:118-121`** — Error branch leaves stale `sources` from previous run; user sees prior location's readiness on new location.
- **`src/hooks/useVendorsProducts.js:33-36`** — Composite-index-requiring queries swallow errors into `setError + setVendors([])`; missing index silently empties vendor/product lists.
- **`src/pages/Settings/components/EditAccessModal.jsx:75-90`** — `assignedLocations` state not pruned when a region is toggled on; stale ad-hoc assignment lingers after region removal.
- **`src/pages/Settings/tabs/SSOTab.jsx:36-107`** — Reads/writes `orgs/{orgId}` directly while form blanks `clientSecret`; the doc write replaces the whole `ssoConfig` field, wiping the prior secret unless re-typed.
- **`src/pages/Settings/tabs/UsersTab.jsx:87-94`** — `accessRequests` query has no `where('status','==','pending')` or limit; grows unbounded.
- **`src/pages/Settings/tabs/DataBrowserTab.jsx:44`** — `locationFilter` default uses `'Test_Sandbox'` when locations haven't hydrated; admin browses placeholder location.
- **`src/pages/Settings/tabs/IntegrationMapTab.jsx:101-118`** — `handleTestConnection` shows "Connected" on adapter success but never persists the API key. Misleading.
- **`src/pages/Settings/tabs/LocationsTab.jsx:131-156`** — Sub-cafe doc-ID derived from name slug; two sub-cafes with the same alphanumeric-stripped name silently overwrite.
- **`src/pages/Settings/tabs/LocationsTab.jsx:89-101`** — Region assignment uses read-modify-write of `locations` array; concurrent edits lose entries. (Use `arrayUnion`.)
- **`src/routes/Inventory.jsx:170-208`** — `seedPriorPeriod` reachable from any user with location context if not admin-gated by its render site. (**Suspected** — verify caller.) Combined with the P0 overwrite this is severe; if button is admin-only this is P3.
- **`src/routes/Inventory.jsx:387-399`** — `tabClosed` only sets `true`; never resets to `false` on location/period switch. Closed state lingers when navigating to an open period.
- **`src/routes/OrderHub.jsx:610-624`** — Auto-created invoice hard-codes `glCode: '12000'` regardless of category mix.
- **`src/routes/OrderHub.jsx:646-664`** — Cart clears in a 2s `setTimeout`; the synced `orderDrafts/{uid__loc}` doc isn't cleared first. Window for double-submit on quick reload.
- **`src/routes/OrderHub.jsx:704-720`** — Order-guide load `catch { setOrderGuide(null) }` silently demotes a transient permission error to "no guide = full catalog".
- **`src/routes/OrderHub.jsx:347-376`** — Draft cart write debouncer with mid-debounce `location` switch can write the prior cart into the new location's draft doc. (**Suspected** — depends on exact timing.)
- **`src/routes/Purchasing.jsx:251`** — `buildSpendTrend` sums `Void`/`Disputed` invoices into the period total.
- **`src/routes/Purchasing.jsx:460-516`** — PDF AI parse writes Firestore with `status: 'Pending'` but local state shows `'Needs GL Review'`. UI lies until refresh.
- **`src/routes/WasteLog.jsx:106-111`** — `wasteTotals` reduce treats `each`/`gal` as oz; mixed-unit waste totals nonsense.
- **`src/routes/WasteLog.jsx:122-181`** — Load effect has no `cancelled` flag; fast location/period switch races setState across loads; shrinkage write then posts the wrong number.
- **`src/routes/WasteLog.jsx:222-226`** — Shrinkage `writePnL` fires on every change to `totalShrinkageValue`, including partial-load windows; `.catch(() => {})` swallows failures.
- **`src/routes/Dashboard.jsx:464`** — Location-ranking `readPnL(...).catch(() => ({}))` silently drops failing locations from rankings.
- **`src/routes/Dashboard.jsx:385`** — `handleClosePeriod` re-reads no fresh server state before writing; can close on stale `allReady`.
- **`src/routes/LaborPlanner.jsx:189,264,316`** — Render-from-out-of-sync state during transitions; duplicate Firestore reads of same doc; `addDoc` before `writeLaborPnL` leaves phantom pending submissions on P&L failure.
- **`src/routes/Transfers.jsx:174,186,236,241,417`** — Cross-tenant JE leak in UI memory after switch; amortization cents drift; sequential per-period writes; orphan negatives; partial bulk imports.
- **`src/routes/WeeklySales.jsx:469,524,734,1097,1199,2638`** — Cents drift; final `setLoading(false)` runs without isStale guard; `loadAllLocations` no cancellation; paste accepts future dates; DST date math; `|| 5` fallback hides 6-7 day operations.
- **`src/lib/permissions.js:170`** — User with typo'd role gets `[]` visibility silently.
- **`src/lib/validation.js:55,23,7`** — Validator incompatible with `null` carry-forward; duplicate detection uses exact float equality; allows empty-string vendor.
- **`src/lib/parseEventExport.js:36,109`** — Sticky-date fallback silently skips malformed-date rows; column-count format detection breaks on schema drift.
- **`src/lib/integrations.js:175`** — Status-update failure during sync swallowed.
- **`src/lib/ramp.js:14`** — Module-scoped `_apiKey` cache; cross-tenant pollution on session switch.
- **`src/lib/inventory.js:73`** — `getItemHistory` matches by `id` only; legacy items without `id` show as `0` in history → false "went to zero" spikes.
- **`src/lib/budgetImport.js:165`** — `if (e) ebitda[mo] = ...` drops months where EBITDA is exactly 0.
- **`netlify.toml`** — No `Content-Security-Policy`, `Strict-Transport-Security`, `X-Content-Type-Options`, `Referrer-Policy`, `X-Frame-Options`. No rate limit on `/api/claude`.
- **`functions/index.js:434`** — `submitAccessRequest` has no rate limit / captcha / dedup; spam vector that also burns SES sending quota.
- **`functions/index.js:1280`** — Three-way match coerces line-item amounts via `Number(...)` but not totals; vendor sending numeric strings produces `NaN` diff → always `'mismatch'`.

---

## P3 — code quality, dead code, stale comments

- **`functions/index.js:71`** — `SYSTEM_ACTOR.email = "system@aurelia-fms"` (no TLD).
- **`functions/index.js:479`** — `generateTempPassword()` defined, never called.
- **`functions/index.js:542, 649`** — `const caller = callerSnap.data()` computed, never used.
- **`firebase.json:39`** — Hosting rewrites everything to `/index.html` with no functions rewrites; if Firebase Hosting becomes primary, `/api/claude` won't route.
- **`firestore.rules:323`** — Dead `orgs/{orgId}/wasteLog` rule (covered by today's bb8d2a9 fix; CLAUDE.md notes leaving it alone for now).
- **`src/lib/audit.js:9, 17`** — Silent `if (!orgId) return`; transient Firestore failures lose audit events with no retry queue.
- **`src/lib/fieldMappings.js:59`** — NetSuite mapping mixes export-direction with vendor→Aurelia import direction in the same shape; easy to misuse.
- **`src/lib/inventory.js:22`** — Stale comment ("qty zeroed" — code sets to null).
- **`src/lib/pnlRollup.js:16`** — Nested-rollup `_subCafeCount` clobber if ever used recursively.
- **`src/lib/whyRules.js:39, 528, 82`** — Stale TODO comments; locationToId redefined; double-built query.
- **`src/lib/usePnL.js:207`** — `JSON.stringify(locations)` as a dep key; order-sensitive churn on re-sort.
- **`src/components/AllLocationsGrid.jsx:24`** — Click handler without keyboard role/tab-index.
- **`src/components/AureliaChat.jsx:487-491`** — `if/else` pushes identical content; dead branch.
- **`src/components/SyncStatusPanel.jsx:39-41`** — `.catch(() => {})` on syncLog read.
- **`src/hooks/useDragDropUpload.js:75`** — Counter can flicker on rapid drag in/out (already clamped).
- **`src/hooks/usePeriodStatus.js:5`** — Unused `lid = locId(location)`.
- **`src/hooks/useVendorsProducts.js:249-268`** — `seedVendorsAndProducts` exported, no call site.
- **`src/pages/Settings/components/UserRow.jsx:10`** — Unused `formatDistanceToNow` import.
- **`src/pages/Settings/tabs/LocationsTab.jsx:35`** — `isDirector` computed, never read.
- **`src/services/vendors/index.js:8-28`** — `submitToVendor` stub returns `success:true, submitted:false`; callers checking `success` mark orders as submitted. (Could escalate to P2 depending on caller.)
- **`src/routes/Budgets.jsx:455, 642, 646`** — Missing `assertSafeToWrite` guard on `handleReject`; nonsense % when GFS empty; dead `currentMo > 0` conditional.
- **`src/routes/BudgetImport.jsx:88`** — `e.target.value=''` clears input before parse error renders.
- **`src/routes/Home.jsx:140`** — Module filter role-gates only Admin section.
- **`src/routes/auth/LoginPage.jsx:1,91`** — Unused imports; raw Cognito error on new-password failure.
- **`src/routes/auth/ForgotPage.jsx:48`** + **`SignUpPage.jsx`** — Branding inconsistency.
- **`src/routes/components/VendorImportModal.jsx:178,183`** — `createdAt: serverTimestamp()` with merge overwrites original creation date on re-import.
- **`src/routes/components/WhyPanel.jsx:38`** — Effect deps include floats; precision changes cause wasted re-fetches.
- **`src/lib/whyRules.js:386`** — `parseFloat || 0` negative-zero edge case (pathological).

---

## Test coverage gaps (not bugs, but blast-radius mitigations)

- **`tests/rules.test.js`** — No assertions for: `orderDrafts` userId-prefix predicate (rules :85-92), new `wasteLog` / `posData` rules, `accessRequests`, cross-tenant default-deny against the nested wildcard block (rules :339+), `transfers` status guard. The nested-match P0 above would NOT be caught by the current suite.
- **`tests/smoke.test.js`** — Doesn't exercise `wasteLog` or `posData` despite those rules being added today; doesn't test reject/lock flows or period locks; uses admin SDK so rules are bypassed (can't catch rule bugs).
- **`tests/useAutosave.test.jsx`** — No test for `visibilitychange` / `pagehide` flush (which the da2baaa commit message claims is covered); no `enabled: false` short-circuit test.
- **No CI on push** runs `test:rules`. The line-30 `tenantId` bug and the nested-wildcard cross-tenant rule above would land in `main` unblocked by today's prebuild gate.

---

## What I deliberately did NOT audit

- `src/routes/components/` beyond what the route agents touched in passing (`ReceivingModal.jsx`, `VendorImportModal.jsx`, `WhyPanel.jsx`, `OrderItemWhyPanel.jsx` were covered; anything else under that directory got cursory attention only).
- `node_modules/`, `dist/`, `scripts/` (per scope).
- `migrations/migrate-inventory-catalog.mjs` — historical migration record; not running.
- Generated lock files, CSS modules, image assets.

## Suggested fix order

If you want a priorityordering for tackling these:

1. **Auth cluster first** (P0 security): unauthenticated proxies, hardcoded invite password, director→admin escalation, `'fooda'` tenant fallback. These are the biggest blast-radius items and require a follow-up rules deploy + Cloud Function deploy each.
2. **firestore.rules :339 cross-tenant block.** One coordinated rules edit + redeploy. Highest single-finding impact.
3. **Silent data-loss class** (Budgets autosave + merge-replace pattern in Sales/Budgets; Transfers `adjustInventory` swallow; OrderHub `pendingTotal` overwrite; Purchasing GL overwrite). All client-only; ship in normal Netlify build.
4. **Cents/tax-rate/date-math cleanups** (cross-cutting patterns #5–#9). Each is a small fix; bundle them per file.
5. **Test coverage gaps.** Add rules tests covering the failure modes from items 1-3 before fixing, so the regression is provably caught.
6. **P2/P3 cleanup.** Sweep when touching adjacent code.
