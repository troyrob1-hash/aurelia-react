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
- `PeriodProvider` (`src/store/PeriodContext.jsx`) implements the Fooda fiscal calendar: period = calendar month; Week 1 starts on the 1st and ends on the first Sunday; middle weeks are Mon–Sun; the final week ends on the last day of the month (may be short). The canonical key format is `YYYY-PMM-Wn` (or `YYYY-PMM-MONTHLY` when `week === 0`). Use `periodKey` from `usePeriod()` — never reconstruct it. `src/lib/pnl.js` has a legacy `weekPeriod()` that is approximate and being migrated out.

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

Deferred items — known broken or fragile, not blocking current work, but don't lose track of them.

- **`firestore.rules` line 30 — `aurelia/{doc}` write rule never evaluates true.** The block reads `allow write: if ownsTenant(tenantId) && isAdmin();` but inside `match /aurelia/{doc}` there's no `{tenantId}` path variable, so `tenantId` resolves to the *function name* rather than being called. The Firebase rules compiler warns `[W] 30:34 - Invalid variable name: tenantId.` on every deploy. Net effect: admin writes to the `aurelia/` global catalog are silently blocked. Predates June 2026. Fix is one of: (a) `ownsTenant(tenantId())` to actually invoke the function, or (b) drop the tenant clause entirely and use `isAdmin()` — `aurelia/` is the *global* catalog so tenant scoping is probably unintended here.
- **`npm run test:rules` is broken on a fresh clone — `@firebase/rules-unit-testing` is not in `package.json`.** ~~`tests/rules.test.js` imports it but it has never been declared as a devDep.~~ **Resolved 2026-06-17 in commit `422f0ee`** — declared as a devDep so the suite runs from a clean checkout.
- **Roll the `useAutosave` `snapshot`/`hydrate` localStorage backstop to Sales, Budgets, Labor.** Landed for Inventory only in the route-change data-loss fix. Each tab needs (a) a `snapshot` callback returning serializable draft data, (b) a `hydrate` callback that merges the draft back into its working state, and (c) a small `mergeDraft`-style helper in its state hook (see `useInventory.mergeDraft` for the pattern). Until then, those three tabs still lose dirty edits if their flushKey-cleanup save fails silently or is raced by the remount's load.
- **Cross-login persistence for the Inventory A-Z/grouped sort.** Currently lives in `useUIStore` (Zustand, in-memory) so it survives in-session route changes but resets on full page reload. To remember across logins/devices: add a `preferences` map to `orgs/{orgId}/users/{uid}` (rules at `firestore.rules:275-277` already allow each user to write their own doc), read it in `authStore.loadProfile`, expose via `useAuthStore`, and hydrate `useUIStore` from the profile on login. Same pattern will apply to any future per-user UI preference (sales view mode, dashboard filters, etc.).
- **Phase B of the 'fooda' silent-fallback cluster: tighten `mapUser` + `mintFirebaseToken` after Cognito backfill.** Phase A (committed) fixed the two safe sites — `pnl.js:_getOrgId` (was reading the wrong property and always falling back) and `AppShell.jsx:57` (dead code). The two gateways (`src/store/authStore.js:99` and `functions/index.js:90`) still default to `'fooda'` when the Cognito token lacks `custom:tenantId`, but now each emits a warning (and the Cloud Function additionally writes an `auth.tenantId_fallback` entry to `orgs/fooda/auditLog`). Phase B: run an admin script against the Cognito user pool to set `custom:tenantId = "fooda"` on every user where it's missing (use `cognito-idp list-users` filtered to users with no `custom:tenantId`, then `admin-update-user-attributes` per user). After verifying no recent `auth.tenantId_fallback` audit entries, remove both fallbacks in one PR — throw `HttpsError("failed-precondition", "Account missing tenant claim")` in the Cloud Function and surface an error state in `useAuthStore` that forces re-login.
