import { useState, useEffect } from 'react'
import { useAuthStore } from '@/store/authStore'
import { db } from '@/lib/firebase'
import { doc, getDoc } from 'firebase/firestore'
import { getDefaultCategories } from '@/hooks/useInventory'

// Category manager — Step 1: READ-ONLY view of the inventory category groupings
// stored at tenants/{orgId}/settings/inventory.categories[]. No add/edit/delete/
// reorder yet (those land in later steps, with the rename/delete item-migration).
// Falls back to getDefaultCategories() when the doc or field is absent — that's
// exactly what useInventory does, so this shows what Inventory actually groups by.
export default function InventoryCategoriesTab() {
  const user = useAuthStore(s => s.user)
  const orgId = user?.tenantId
  const [categories, setCategories] = useState([])
  const [isCustom, setIsCustom] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    if (!orgId) return
    let cancelled = false
    setLoading(true)
    setError(null)
    getDoc(doc(db, 'tenants', orgId, 'settings', 'inventory'))
      .then(snap => {
        if (cancelled) return
        const arr = snap.exists() ? snap.data().categories : null
        if (Array.isArray(arr) && arr.length) {
          setCategories(arr)
          setIsCustom(true)
        } else {
          setCategories(getDefaultCategories())
          setIsCustom(false)
        }
      })
      .catch(e => { if (!cancelled) setError(e.message || 'Failed to load categories') })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [orgId])

  if (loading) {
    return <div style={{ padding: 24, color: '#64748b', fontSize: 14 }}>Loading categories…</div>
  }
  if (error) {
    return <div style={{ padding: 24, color: '#b91c1c', fontSize: 14 }}>Couldn’t load categories: {error}</div>
  }

  return (
    <div style={{ padding: '8px 4px', maxWidth: 760 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
        <h2 style={{ fontSize: 16, fontWeight: 600, color: '#0f172a', margin: 0 }}>Inventory categories</h2>
        <span style={{
          fontSize: 11, fontWeight: 600, padding: '3px 8px', borderRadius: 999,
          background: isCustom ? '#dcfce7' : '#f1f5f9',
          color: isCustom ? '#166534' : '#64748b',
        }}>
          {isCustom ? 'Customized' : 'Defaults (not yet customized)'}
        </span>
      </div>
      <p style={{ fontSize: 13, color: '#64748b', margin: '0 0 16px', lineHeight: 1.5 }}>
        These groupings organize the inventory count sheet and the category KPI bubbles.
        Read-only for now — editing, reordering, and delete arrive in a later update.
      </p>

      <div style={{ border: '1px solid #e2e8f0', borderRadius: 10, overflow: 'hidden' }}>
        <div style={{
          display: 'grid', gridTemplateColumns: '1fr 160px 90px 70px',
          gap: 12, padding: '8px 14px', background: '#f8fafc',
          borderBottom: '1px solid #e2e8f0',
          fontSize: 11, fontWeight: 600, color: '#94a3b8',
          textTransform: 'uppercase', letterSpacing: '0.04em',
        }}>
          <div>Category</div>
          <div>Key</div>
          <div style={{ textAlign: 'center' }}>Keywords</div>
          <div style={{ textAlign: 'right' }}>Items</div>
        </div>

        {categories.map((cat, idx) => (
          <div
            key={cat.key || cat.label || idx}
            style={{
              display: 'grid', gridTemplateColumns: '1fr 160px 90px 70px',
              gap: 12, padding: '10px 14px', alignItems: 'center',
              borderTop: idx === 0 ? 'none' : '1px solid #f1f5f9',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
              <span
                title={`color ${cat.color} · bg ${cat.bg}`}
                style={{
                  width: 22, height: 22, borderRadius: 6, flexShrink: 0,
                  background: cat.bg || '#f3f4f6',
                  border: `2px solid ${cat.color || '#cbd5e1'}`,
                }}
              />
              <span style={{
                fontSize: 14, fontWeight: 500, color: cat.color || '#0f172a',
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}>
                {cat.label || <span style={{ color: '#cbd5e1' }}>(no label)</span>}
              </span>
            </div>
            <div style={{
              fontSize: 12, color: '#64748b', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>
              {cat.key || '—'}
            </div>
            <div style={{ textAlign: 'center', fontSize: 13, color: '#94a3b8', fontVariantNumeric: 'tabular-nums' }}>
              {Array.isArray(cat.keywords) ? cat.keywords.length : 0}
            </div>
            <div
              title="Item usage counts arrive with category editing (requires an all-locations scan)"
              style={{ textAlign: 'right', fontSize: 13, color: '#cbd5e1', fontVariantNumeric: 'tabular-nums' }}
            >
              —
            </div>
          </div>
        ))}
      </div>

      <p style={{ fontSize: 12, color: '#94a3b8', margin: '10px 2px 0' }}>
        {categories.length} categor{categories.length === 1 ? 'y' : 'ies'}.
        Items are tagged by category <em>label</em>; the <code>key</code> is the stable id used for grouping.
      </p>
    </div>
  )
}
