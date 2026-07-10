# RUNBOOK — CF valuation cutover (Phase 2)

Operational runbook for flipping a location's **live** `closingValue` / `cogs_inventory`
writer from the **client** to the **Cloud Function** (`aggregateInventoryValuationShadow`),
and rolling back. Written to be executed under mild stress without re-reading the design.

## Mental model (30 seconds)

- One flag per location: `tenants/fooda/valuationMode/{locId}` → `{ authoritative: 'cf' | 'client' }`.
- **Missing doc / any value other than exactly `'cf'` ⇒ client-authoritative** (fail-safe default).
- Both sides read the flag **at write time**:
  - Client (`useInventory.saveCounts` / `save`): if `'cf'` → skips the live P&L write **and** the Path B write. Count docs (the per-item subcollection) are **always** written regardless — they're the source of truth and the CF trigger.
  - CF: writes shadow fields (`closingValue_cf`, …) in **all** modes forever. When `'cf'` → **also** writes live `closingValue`/`cogs_inventory`/`openingValue` + rebuilds Path B.
- `{locId}` = sanitized, **prefix-preserved** id: `name.replace(/[^a-zA-Z0-9]/g,'_')`, e.g. `CR_Wesley_Medical_KS` (NOT the display name, NOT prefix-stripped).

Prereq: builds 1–4 all **deployed** (Netlify for client, `firebase deploy --only functions:aggregateInventoryValuationShadow` for the CF, `firebase deploy --only firestore:rules` for the flag rules).

---

## FLIP A LOCATION (client → cf)

### 1. Preconditions checklist (all must be true)
- [ ] Location shows **✅ match** in `compare-cf-valuation.cjs` on **recent** activity (`cf_computedAt` is recent, `Δclose` and `Δcogs` both `+0.00`).
- [ ] Count docs carry denormalized `name`/`category`/`vendor` — spot-check 2–3 recent docs at
      `tenants/fooda/inventory/{locId}/counts/{periodKey}/items`. If any are missing (pre–build-1 docs), **re-count the location once** so a fresh save re-writes them, then re-verify.
- [ ] Builds 1–4 deployed (client on Netlify; CF + rules via `firebase deploy`).

Run the compare:
```
GOOGLE_APPLICATION_CREDENTIALS=/path/to/the-grove-70180-sa.json \
  node scripts/compare-cf-valuation.cjs
```

### 2. Set the flag (Firebase console, director/vp/admin account)
Create/set `tenants/fooda/valuationMode/{locId}`:
```json
{
  "authoritative": "cf",
  "reason": "<why — e.g. Stage A, proven-equal 1wk>",
  "updatedBy": "<your email>",
  "updatedAt": <server timestamp / now>
}
```
Value must be **exactly** `cf` — no trailing space, no capitalization. (Rules allow write only for director/vp/admin.)

### 3. Force one recompute
The flag alone changes nothing until the next write. Trigger the CF once:
- **Touch a count doc**: any no-op merge write to `.../counts/{periodKey}/items/{anyDoc}`, **or**
- **Save a count** in the app at that location.

### 4. Verify within ~30s (CF debounce is 2.5s + cold start)
On `tenants/fooda/pnl/{locId}/periods/{periodKey}`:
- [ ] `cf_computedAt` is **fresh** (just now).
- [ ] live `closingValue` **==** `closingValue_cf` (and `cogs_inventory == cogs_inventory_cf`).
- [ ] `inventoryCountedBy` is populated — a **real user email**, NOT blank, NOT `backfill-*`.
- [ ] Path B doc `tenants/fooda/locations/{locId}/inventory/{periodKey}` updated with `updatedBy: 'cf'`.
- [ ] CF log shows `mode=CF-AUTHORITATIVE (live written)` (`firebase functions:log --only aggregateInventoryValuationShadow`).

### 5. Watch window
- Run `compare-cf-valuation.cjs` **daily for a week**. The location must stay **✅**.
- Any drift → go to FAILURE SIGNATURES, then ROLLBACK if unresolved.

---

## ROLLBACK (cf → client)

### 1. Set the flag back (console, any director+)
`tenants/fooda/valuationMode/{locId}.authoritative = 'client'` (or delete the doc — missing ⇒ client).

### 2. Force one client save (CRITICAL — do not skip)
Open **Inventory** at the location, change any count, **save**.
> Between the flag flip and this save, the live value is still **whatever the CF last wrote**. The forced client save overwrites it with client-computed values **immediately**. Flipping the flag alone does NOT restore the client's number — a save must happen.

### 3. Verify
- [ ] Live `closingValue` reflects the **client** write; `inventoryCountedBy` = the saving user (not `'cf'`).
- [ ] On the next count trigger, CF is back to **shadow-only**: `cf_*` fields still update, but live fields no longer move from CF writes. CF log shows `mode=shadow-only`.

### 4. Record it
Add a dated line to the **ROLLBACK LOG** at the bottom of this file: which location, why, what was observed. Do NOT re-attempt the flip until the cause is understood.

---

## FAILURE SIGNATURES (what wrong looks like)

| Symptom | Likely cause | Action |
|---|---|---|
| Live `closingValue` **stops updating** after a count | Flag reads `'cf'` but CF isn't writing live — check CF logs for the `valuationMode read failed` warning (→ shadow-only fail-safe) **or** a typo in the flag value (`'cf '` with a space, `'CF'`, etc. = client mode **by design**, so client should still write… if neither writes, the flag is `'cf'` to the client but the CF errored). | Fix the flag value; check CF logs; force a recompute. |
| Live **diverges** from `_cf` while in cf mode | CF wrote, then **something else overwrote** the live fields — almost always a **client still writing** (a stale browser tab opened before the flip, whose gate read `'client'`). | Find/close the stale tab; force a recompute to let the CF re-assert. |
| `inventoryCountedBy` **blank or `backfill-*`** | Attribution derivation bug (should exclude `backfill-*` and never blank). | ROLLBACK, investigate the `countMeta` derivation in the CF. |
| Location shows **`(no CF data yet)`** after flip | CF never fired / trigger filter mismatch. | Confirm count docs exist at the expected path; touch a count doc; check the trigger is deployed. |

---

## STAGE PLAN

- **Stage A — `CR_Wesley_Medical_KS`.** Proven end-to-end: diagnosed, backfilled, reconciled (`26454.44 == 26454.44`), and an active counter. Flip, **watch 1 week**, exercise the rollback path once on purpose to confirm it's clean.
- **Stage B — the 5 exact-match locations:** `CR_Best_Buy`, `CR_Vans_OC`, `CR_Phillips_66`, `CR_So_CA_Gas`, `CR_800_Brand`. Compare-clean, flip together, watch.
- **Stage C — the rest, in batches.** `compare-cf-valuation.cjs` must be clean for a location before it joins a batch. Locations with unresolved divergence (e.g. `CR_VF_Greensboro`, no Path B recovery source) must be **re-counted and proven ✅ first**.

Keep `_cf` shadow fields writing in all modes permanently so `compare-cf-valuation.cjs` stays a live divergence monitor even after full cutover.

---

## ROLLBACK LOG

_(append dated entries: `YYYY-MM-DD  {locId}  — reason / observation`)_
