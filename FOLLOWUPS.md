
## Post-pilot — Configuration seeding

### Seed `tenants/{orgId}/config/vendors` document properly

**Status:** Document exists but is empty. Code falls back to hardcoded `DEFAULT_VENDORS` array in `Purchasing.jsx`.

**Why this matters:** Multi-tenant readiness. When a non-Fooda customer signs up, they currently see Fooda's vendors (Sysco, Nassau, Vistar, etc.) in the dropdown until an admin overrides the list. The code path is correct — it reads from Firestore first and only falls back to defaults if missing — but the seed data has Fooda-specific vendors baked in.

**Why deferred:** Manual seeding via Firebase console kept failing because the console UI for nested arrays-of-maps is confusing. The fix requires either (a) a proper Node.js seed script run with prod credentials, or (b) replacing `DEFAULT_VENDORS` with an empty array and forcing all customers to add vendors via the Settings UI. Both are post-pilot work.

**Action:**
1. Write a `scripts/seed-prod-vendors.cjs` script using `firebase-admin` and a prod service account
2. Run it once to populate `tenants/fooda/config/vendors` with the current Fooda vendor list
3. Replace `DEFAULT_VENDORS` in `Purchasing.jsx` with `[]` so other tenants don't see Fooda's vendors
4. Optionally: build a Settings → Vendors management UI for ongoing vendor list maintenance

