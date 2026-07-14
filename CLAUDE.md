# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev               # Vite dev server (uses .env.local)
npm run dev:staging       # Vite dev server with .env.staging vars
npm run build             # Production build → dist/
npm run build:staging     # Production build against staging env
npm run preview           # Preview the production build locally
npm run lint              # ESLint on src/**/*.{js,jsx}
npm run test              # vitest run (all)
npm run test:smoke        # vitest tests/smoke.test.js with .env.test creds (hits real Firestore)
npm run test:rules        # vitest tests/rules.test.js inside firestore emulator
```

Run a single vitest file directly: `npx vitest run path/to/file.test.js`. Single test by name: `npx vitest run -t "test name"`.

There is no pre-commit hook. Deploys: Netlify ships `main` automatically; Firebase Functions and Firestore rules ship via `firebase deploy --only functions`, `firebase deploy --only firestore:rules`, etc. `.firebaserc` defines `default`/`prod` = `the-grove-70180`, `staging` = `the-grove-staging`.

## Architecture

### Two-stage auth: Cognito → Firebase custom token

1. User signs in with Cognito `USER_PASSWORD_AUTH` (`src/lib/auth.js`). Tokens are persisted in `sessionStorage`.
2. The Cognito ID token is sent to the `mintFirebaseToken` Cloud Function (`functions/index.js`), which verifies the JWT against Cognito's JWKS and returns a Firebase custom token carrying `custom:tenantId`, `custom:role`, and `email` claims.
3. `signInWithCustomToken` (in `src/lib/firebase.js`) signs into Firebase Auth. From this point on, Firestore rules enforce tenant scoping using `request.auth.token["custom:tenantId"]` and `custom:role` (see `firestore.rules`).

Everything tenant-scoped flows from those custom claims — never hardcode `'fooda'` even though it's the default. `useAuthStore` in `src/store/authStore.js` is the single source for `{ user, session, loading }`; route guards in `src/App.jsx` use it.

### Two Firestore namespaces (this trips people up)

- **`tenants/{orgId}/...`** — application data: inventory, P&L, invoices, orders, transfers, budgets, labor/sales/waste submissions, audit trail.
- **`orgs/{orgId}/...`** — admin/settings data: users, locations, API keys, sessions, integrations, period locks.

Both `orgId` values are the same `custom:tenantId` claim. Rules helpers `ownsTenant()` / `isAdmin()` / `isDirector()` / `isManager()` are defined in `firestore.rules` and applied per-collection. The Settings UI and Cloud Functions write to `orgs/`; everything operational writes to `tenants/`.

### Role model is additive (multi-role)

`src/lib/permissions.js` is authoritative. Roles: `staff` (== manager), `manager`, `director`, `vp`, `admin`. Users can hold multiple roles via `user.roles: string[]` (legacy users carry `user.role: string` and are normalized by `getUserRoles`). Visibility:

- Admin / VP → all locations
- Director / Manager → union of `managedRegionIds` (resolved via `tenants/{orgId}/regions/{regionId}.locations[]` — a list of location NAMES) plus ad-hoc `assignedLocations[]`
- Anyone else → empty (the `viewer`/`pending` role lands in the `PendingApproval` screen in `App.jsx`)

`canAdministerSystem` is admin-only; VPs see everything but cannot administer. Use the predicates in `permissions.js` rather than checking `user.role` directly.

### Locations & periods are React context, not props

- `LocationProvider` (`src/store/LocationContext.jsx`) subscribes to `orgs/{tenantId}/locations` and `tenants/{tenantId}/regions`, computes `visibleLocations` and `groupedLocations` via `permissions.js`, and exposes `selectedLocation` plus sub-cafe helpers. Locations are referenced by **name** (string) in regions and `assignedLocations`, but the location doc has its own `id`. `locationsByName` is the lookup table.
- `PeriodProvider` (`src/store/PeriodContext.jsx`) implements the Fooda fiscal calendar: period = calendar month; **weeks run Sunday–Saturday** (a week ends on Saturday). Week 1 starts on the 1st and ends on the first Saturday (partial); middle weeks are Sun–Sat; the final week ends on the last day of the month (may be short). A week never crosses a month boundary — it is chopped at the 1st and last of the month, so the week COUNT varies by month (e.g. May 2026 = 6 weeks, July 2026 = 5). The canonical key format is `YYYY-PMM-Wn` (or `YYYY-PMM-MONTHLY` when `week === 0`). Use `periodKey` from `usePeriod()` — never reconstruct it. **Three calendar copies must stay in lockstep** (Sun–Sat): `getPeriodWeeks` (PeriodContext, boundaries), `weeksInPeriod` (`src/lib/pnl.js`, week count), and `cfWeeksInPeriod` (`functions/index.js`, week count — deploy with `firebase deploy --only functions`). `src/lib/pnl.js` has a legacy `weekPeriod()` that is approximate and being migrated out. (Calendar corrected from Mon–Sun to Sun–Sat in Phase 0.1, 2026-07.)

### Shared P&L sink

All operational modules write into `tenants/{orgId}/pnl/{locId}/periods/{periodKey}` via helpers in `src/lib/pnl.js` (and `pnlRollup.js` / `usePnL.js`). Dashboard reads from the same path. `locId(name)` sanitizes location names to doc-id-safe strings (`name.replace(/[^a-zA-Z0-9]/g, '_')`). When adding a new data source that feeds P&L, write through `pnl.js` so Dashboard picks it up automatically.

### Autosave pattern for data-entry tabs

`src/hooks/useAutosave.js` owns the lifecycle (debounce, `pagehide` flush, `visibilitychange` flush, flush-on-`flushKey`-change) for every data-entry tab. The caller owns `dirty` and `save`. Critical detail captured in recent fixes (see git log `da2baaa`, `13d3289`): debounce timer is keyed off `dirty` only, with `save` accessed via a ref so a fresh keystroke does not reset the timer; `flushKey` must include any dimension whose change abandons the current write (e.g. `${locationId}__${periodKey}`) or the outgoing context's dirty counts will be lost.

The companion UI is `src/components/SaveStatusBar.jsx`. Sales/Inventory/Budgets/LaborPlanner all use the same pair — match the conventions when adding a new tab.

### Two function backends

- **Firebase Cloud Functions v2** (`functions/index.js`): `mintFirebaseToken`, `inviteUser`, `deactivateUser`, `updateUserRoles`, `updateRegion`, `submitAccessRequest`, `createAPIKey` / `getAPIKeyValue` / `revokeAPIKey` (API keys stored in Secret Manager), `processScheduledPayments` + `processRecurringInvoices` (scheduled), `cleanExpiredSessions`, `claudeProxy`, `integrationWebhook`, plus `auditUserWrite` / `auditLocationWrite` / `auditApiKeyWrite` Firestore triggers writing `orgs/{orgId}/auditLog`. Server-side admin SDK writes bypass rules and are how privileged operations land.
- **Netlify Function** (`netlify/functions/claude.js`): production Claude API proxy. Dev mode uses an inline Vite middleware in `vite.config.js` (`claudeProxy`) — both read `ANTHROPIC_API_KEY` / `VITE_ANTHROPIC_KEY`. Calls `/api/claude` from the frontend.

`INTEGRATIONS_ARCHITECTURE.md` captures the canonical pattern for external sync (Order Hub → Purchasing draft invoice trigger, NetSuite push on payment): Firestore document triggers, never frontend calls; sync state on the source doc; failures don't block user actions.

### Audit logs (two layers, deliberately)

- Client-side `src/lib/audit.js` (`audit.invoicePaid(...)`, etc.) writes to `tenants/{orgId}/auditTrail` for app actions. Best-effort, swallows errors.
- Server-side `writeAuditLog()` in `functions/index.js` writes to `orgs/{orgId}/auditLog` for privileged Cloud Function actions and Firestore-trigger diffs. Authoritative.

### Routing

`src/App.jsx` is the only router. Every non-auth route is `lazy()`-imported and code-split; `vite.config.js` also splits `react-vendor`, `firebase`, and `charts` into manual chunks. Routes nest under a single protected shell (`AppShell` + `PeriodProvider` + `LocationProvider`). `Settings` and `BudgetImport` are gated by `<AdminOnly>` (admin role only).

## Environment

Two-env split: `.env.local` (dev → `the-grove-70180`) and `.env.staging` (→ `the-grove-staging`). `.env.test` holds credentials the smoke tests load via `dotenv-cli`. Required vars:

```
VITE_FIREBASE_API_KEY, VITE_FIREBASE_AUTH_DOMAIN, VITE_FIREBASE_PROJECT_ID,
VITE_FIREBASE_STORAGE_BUCKET, VITE_FIREBASE_MESSAGING_SENDER_ID, VITE_FIREBASE_APP_ID,
VITE_COGNITO_REGION, VITE_COGNITO_CLIENT_ID
```

Cloud Function env (set via `firebase functions:secrets:set` or the Functions runtime config): `COGNITO_USER_POOL_ID`, `COGNITO_CLIENT_ID`, `ANTHROPIC_API_KEY`.

## Gotchas

- `scripts/` is in `.gitignore` — local seed/repair scripts live there and are not part of any deployable artifact. The migrations folder (`migrations/migrate-inventory-catalog.mjs`) is the migration record.
- Tests `tests/rules.test.js` need the firestore emulator (port `8080` per `firebase.json`); `npm run test:rules` boots it automatically. `tests/smoke.test.js` hits real Firestore and is what GitHub Actions runs daily at 11:00 UTC (`.github/workflows/daily-smoke-test.yml`).
- Files matching `*service-account*.json`, `*firebase-adminsdk*.json`, `*QC*Budget*.xlsx`, `*Qualcomm*.xlsx`, and `src/fixtures/real/` are gitignored — they hold credentials or real customer data.
- The default-deny block at the bottom of `firestore.rules` is followed by additional rules nested inside it (`periodLocks`, `auditTrail`, `syncLog`, `integrations`, `purchaseOrders`, `posTransactions`, `notifications`). That nesting is intentional Firestore-rules syntax, not a typo — those collections are open to any authenticated user.
- The legacy `tenants/{orgId}/legacy/{key}` doc is used by `dbGet`/`dbSet`/`dbListen` in `firebase.js` as a tenant-scoped key/value store for older data — prefer typed collections for new data.

## Known issues / TODO

Deferred items — known broken or fragile, not blocking current work, but don't lose track of them. Resolved entries are kept with a strikethrough body + resolution date/commit so future readers can see what's been chased and what hasn't.

### Open

- **`firestore.rules` line 30 — `aurelia/{doc}` write rule never evaluates true.** The block reads `allow write: if ownsTenant(tenantId) && isAdmin();` but inside `match /aurelia/{doc}` there's no `{tenantId}` path variable, so `tenantId` resolves to the *function name* rather than being called. The Firebase rules compiler warns `[W] 30:34 - Invalid variable name: tenantId.` on every deploy. Net effect: admin writes to the `aurelia/` global catalog are silently blocked. Predates June 2026. Fix is one of: (a) `ownsTenant(tenantId())` to actually invoke the function, or (b) drop the tenant clause entirely and use `isAdmin()` — `aurelia/` is the *global* catalog so tenant scoping is probably unintended here.
- **`functions/.env` contains plaintext AWS access keys.** `AKIAZE5CPX22SYWIWXFO` + matching secret, pasted twice. `functions/.env` is gitignored so they're not in source control, but plaintext access keys on disk walk out with a stolen laptop. Move to Secret Manager: `firebase functions:secrets:set AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`, then update `functions/index.js` Cognito + SES clients to read from the secret runtime (same pattern as `COGNITO_USER_POOL_ID` / `ANTHROPIC_API_KEY`). Discovered 2026-06-19 during the email-casing audit.
- **`aws-sdk` v2 is end-of-life.** Every Cognito + SES call in `functions/index.js` (lines 226-227, 380-382, 496-497, 797-798) uses `require("aws-sdk")` v2, which AWS has stopped releasing updates for. The SDK still works but no new bug/security fixes will land. Migration to AWS SDK for JavaScript v3: each call site changes shape (per-service packages like `@aws-sdk/client-cognito-identity-provider`, promise-native, no `.promise()` wrappers, no global `AWS.config`). Coordinated PR — touches 4 call sites and the functions package.json.
- **Phase B of the 'fooda' silent-fallback cluster: tighten `mapUser` + `mintFirebaseToken` after Cognito backfill.** Phase A (committed) fixed the two safe sites — `pnl.js:_getOrgId` (was reading the wrong property and always falling back) and `AppShell.jsx:57` (dead code). The two gateways (`src/store/authStore.js:99` and `functions/index.js:90`) still default to `'fooda'` when the Cognito token lacks `custom:tenantId`, but now each emits a warning (and the Cloud Function additionally writes an `auth.tenantId_fallback` entry to `orgs/fooda/auditLog`). Phase B: run an admin script against the Cognito user pool to set `custom:tenantId = "fooda"` on every user where it's missing (use `cognito-idp list-users` filtered to users with no `custom:tenantId`, then `admin-update-user-attributes` per user). After verifying no recent `auth.tenantId_fallback` audit entries, remove both fallbacks in one PR — throw `HttpsError("failed-precondition", "Account missing tenant claim")` in the Cloud Function and surface an error state in `useAuthStore` that forces re-login.
- **Historical `eaches` 100× corruption audit.** The eaches-input controlled-component bug (fixed 2026-06-18, commit `ec0357a`) silently turned `1.08` keystroke sequences into `108` because `setEaches` stored only the parsed number with no raw-string preservation. Any inventory count taken before that fix that involved a decimal eaches value is corrupt by exactly 100× — the dollar contribution still lands at the right magnitude on the closing because `eachPrice` is typically $0.01-ish so `108 × $0.01 ≈ $1.08`, but the stored `eaches` count itself is wrong. Audit: scan `tenants/fooda/inventory/{locId}/counts/{period}` items array historically and flag entries where `eaches >= 100` AND `eaches % 1 === 0` AND the period is before `ec0357a` deployed — those are likely victims. Decision needed per-victim: leave (cosmetic), or divide eaches by 100 and re-derive closingValue.
- **Path B snapshot still uses `i.qty != null` filter, not `hasCount`.** The save() function's secondary write to `tenants/{orgId}/locations/{locId}/inventory/{periodKey}` (around `useInventory.js:927`) drops eaches-only items because its filter is `items.filter(i => i.qty != null)` rather than `items.filter(hasCount)`. Same shape as the W1 $3.83 bug fixed for the primary counts doc in `ec0357a`. Path B is read by WasteLog and the P&L Why panel, so divergence between primary and Path B isn't user-visible in the inventory UI itself but could mislead waste tracking and the Why explanations.
- **Roll the `useAutosave` `snapshot`/`hydrate` localStorage backstop to Sales, Budgets, Labor.** Landed for Inventory only in the route-change data-loss fix. Each tab needs (a) a `snapshot` callback returning serializable draft data, (b) a `hydrate` callback that merges the draft back into its working state, and (c) a small `mergeDraft`-style helper in its state hook (see `useInventory.mergeDraft` for the pattern). Until then, those three tabs still lose dirty edits if their flushKey-cleanup save fails silently or is raced by the remount's load.
- **Cross-login persistence for the Inventory A-Z/grouped sort.** Currently lives in `useUIStore` (Zustand, in-memory) so it survives in-session route changes but resets on full page reload. To remember across logins/devices: add a `preferences` map to `orgs/{orgId}/users/{uid}` (rules at `firestore.rules:275-277` already allow each user to write their own doc), read it in `authStore.loadProfile`, expose via `useAuthStore`, and hydrate `useUIStore` from the profile on login. Same pattern will apply to any future per-user UI preference (sales view mode, dashboard filters, etc.).
- **`scripts/backfill-opening-values.cjs` exists but is UNSAFE as-written.** Optional backfill that retro-syncs every weekly P&L doc's stored `openingValue` to its prior week's current `closingValue` + recomputes `cogs_inventory = max(0, opening + cogs_purchases − closingValue)`. **Hazard:** when the prior period doc doesn't exist (oldest-week edge), the script sets `openingValue = 0` and then writes `cogs_inventory = max(0, 0 + cogs_purchases − closingValue)` — which fabricates a non-zero `cogs_inventory` on docs that may never have had one. The dry-run surfaces these as "prior missing → opening forced to $0" but doesn't refuse to write them. **Do NOT run with `--apply`** until the missing-prior branch is changed to either skip the doc entirely or leave `cogs_inventory` untouched. The save-time fix in `09106ea` (useInventory.js refreshes opening from prior closing on every save) heals the staleness organically as users touch each week, so the backfill is *optional* — there's no urgent reason to ship it.
- **CR_ / SO_ prefix path confusion in diagnostic scripts.** Location names like `"CR_Best Buy"` carry the legacy CR_ / SO_ prefix in the raw `location` field on invoices, counts docs, and the `locations` collection. `cleanLocName()` strips them for *display only*. Firestore paths use `locId(rawName)` which sanitizes non-alphanumerics to `_` but does NOT strip the prefix — so the path is `CR_Best_Buy`, not `Best_Buy`. Any audit script that hard-codes the display name will silently read empty/missing docs. Always use the raw prefixed name for `locId()`. (Captured 2026-06-18 after a Best Buy diagnostic hit the wrong path twice.)
- **W1 stale Sysco invoice `647615036` ($1,167.40, glCode 50413) on CR_Best Buy.** Approved before commit `550a6c9` deployed, so the post-approve recompute never ran — `tenants/fooda/pnl/CR_Best_Buy/periods/2026-P06-W1.cogs_purchases` is absent ($0 effective) when it should be $1,167.40. Re-approve or markPaid the invoice to trigger the recompute path and backfill. One-shot data fix.

### Resolved (kept for context — do not re-investigate without reason)

- **`npm run test:rules` is broken on a fresh clone — `@firebase/rules-unit-testing` is not in `package.json`.** ~~`tests/rules.test.js` imports it but it has never been declared as a devDep.~~ **Resolved 2026-06-17 in commit `422f0ee`** — declared as a devDep so the suite runs from a clean checkout.
- **Access-request flow had two dangerous gaps (found 2026-06-18).** ~~(1) `submitAccessRequest` did no check for existing accounts; active users could submit redundant requests and duplicates weren't deduped. (2) Clicking Approve on a stale request silently downgraded an active user — `inviteUser`'s existing-user branch reset the Cognito password, overwrote `custom:role`, and stomped `roles` / `managedRegionIds` / `assignedLocations` to InviteModal defaults.~~ **Resolved 2026-06-18 / 2026-06-19** in commits `cc7d674` (email normalization at every entry point + dedupe guard in `inviteUser`) and `c7d18e9` (`submitAccessRequest` dedupe — rejects re-submissions from active users and duplicate pending requests, with clean `status: "already_active"` / `"duplicate_pending"` responses surfaced on RequestAccessPage). Email casing root cause: client entry points were inconsistent (`ForgotPage` lowercased, `LoginPage` + `InviteModal` didn't) — later traced to a non-issue at the Cognito layer because the user pool has `UsernameConfiguration.CaseSensitive: false`, so duplicates couldn't form Cognito-side; the fix is still defensively useful for Firestore doc-id consistency.
- **P&L opening-value reconciliation "bug" (raised 2026-06-18).** ~~Best Buy W2 surfaced three "opening" values that didn't match — UI $2.64, stored W2.openingValue $18.54, W1.closingValue $0 — framed as if they should all be one number.~~ **Resolved 2026-06-22 — misdiagnosed, partial real fix shipped.** The UI computes opening *correctly* by always reading the prior week's stored `closingValue` live (`useInventory.js:378`); it never reads the current week's own stored `openingValue` for display. The three numbers were three temporal snapshots of the same field at different moments — the UI was always showing the live value at observation time. The real bug was that the *stored* `openingValue` field on each week's P&L doc is a frozen snapshot from the last time *that week* was saved, and goes stale the moment the prior week is re-saved. Fixed in commit `09106ea` — both `saveCounts` and `save()` now read prior week's current `closingValue` at write time and use it for the payload + the `cogs_inventory` clamp. UI behavior unchanged; downstream consumers that read the stored field now see a fresh-as-of-last-save value. Optional one-shot retro-sync via `scripts/backfill-opening-values.cjs` (but see UNSAFE note above before running with `--apply`).
