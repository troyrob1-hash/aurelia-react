import { useEffect, useRef } from 'react'
import { collection, onSnapshot } from 'firebase/firestore'
import { db } from '@/lib/firebase'

// Live-merge listener for per-item inventory counts (Phase 3).
//
// Subscribes to the CURRENT period's per-item count subcollection so two
// counters on the same location see each other's counts stream in. This hook
// owns ONLY the onSnapshot lifecycle + docChanges parsing — it WRITES NOTHING
// and holds no count state. It hands parsed deltas to `onRemote`, which the
// caller (useInventory) applies with the touchedItemsRef guard (Phase 3 step 2).
//
// Isolation (the crash lesson): the snapshot handler is wrapped in try/catch so
// a parse/listener bug is logged and swallowed — it can never propagate and take
// down the counting page.
//
// Params:
//   orgId, locId, periodKey — scope (locId already sanitized by the caller)
//   enabled  — subscribe only when true. Caller passes current-period only:
//              historical periods are read-once (some legacy-array, no
//              subcollection) and have no live writers.
//   onRemote — ({ patches, removedIds }) => void, called once per snapshot with:
//                patches:    { [rawItemId]: { qty, eaches, lastCountedAt, lastCountedBy } }
//                removedIds: string[]   (raw item ids whose count doc was deleted)
//              Only NON-echo, data changes are included (see hasPendingWrites).
export function useCountsListener({ orgId, locId, periodKey, enabled, onRemote }) {
  // Keep the latest onRemote in a ref so a caller passing a fresh callback each
  // render does NOT tear down and re-create the subscription.
  const onRemoteRef = useRef(onRemote)
  onRemoteRef.current = onRemote

  useEffect(() => {
    if (!enabled || !orgId || !locId || !periodKey) return undefined

    const colRef = collection(
      db, 'tenants', orgId, 'inventory', locId, 'counts', periodKey, 'items'
    )

    const unsubscribe = onSnapshot(
      colRef,
      (snap) => {
        try {
          const patches = {}
          const removedIds = []
          for (const change of snap.docChanges()) {
            const d = change.doc
            // Skip our OWN not-yet-acked optimistic writes — they're already in
            // local state, and the touchedItemsRef guard (in onRemote) covers
            // the acked echo. This is a cheap early-out, not the correctness
            // guarantee.
            if (d.metadata.hasPendingWrites) continue
            const data = d.data() || {}
            // Match on the RAW itemId stored in the doc (encoding-independent);
            // fall back to the doc id for any pre-fix docs without the field.
            const rawId = data.itemId != null ? String(data.itemId) : d.id
            if (change.type === 'removed') {
              removedIds.push(rawId)
            } else {
              // added | modified — mirror the load() hydration field mapping.
              patches[rawId] = {
                qty: data.qty ?? null,
                eaches: data.eaches ?? 0,
                lastCountedAt: data.countedAt ?? null,
                lastCountedBy: data.countedBy ?? null,
              }
            }
          }
          if (Object.keys(patches).length || removedIds.length) {
            onRemoteRef.current?.({ patches, removedIds })
          }
        } catch (e) {
          // Never let a listener/parse bug crash the counting page.
          console.error('useCountsListener: snapshot handler failed (ignored):', e)
        }
      },
      (err) => {
        console.error('useCountsListener: subscription error:', err)
      }
    )

    return unsubscribe
    // onRemote intentionally excluded (accessed via ref) so it never re-subscribes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, orgId, locId, periodKey])
}
