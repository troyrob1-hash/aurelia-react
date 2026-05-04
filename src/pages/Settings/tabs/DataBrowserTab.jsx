import { useState, useEffect } from 'react'
import { db } from '@/lib/firebase'
import { collection, getDocs, doc, getDoc } from 'firebase/firestore'
import { useAuthStore } from '@/store/authStore'
import { useLocations } from '@/store/LocationContext'

const COLLECTIONS = [
  { id: 'pnl', label: 'P&L Periods', path: (org, loc) => `tenants/${org}/pnl/${loc}/periods` },
  { id: 'budgets', label: 'Budgets', path: (org) => `tenants/${org}/budgets` },
  { id: 'invoices', label: 'Invoices', path: (org) => `tenants/${org}/invoices` },
  { id: 'orders', label: 'Orders', path: (org) => `tenants/${org}/orders` },
  { id: 'journalEntries', label: 'Journal Entries', path: (org) => `tenants/${org}/journalEntries` },
  { id: 'jeTemplates', label: 'JE Templates', path: (org) => `tenants/${org}/jeTemplates` },
  { id: 'laborSubmissions', label: 'Labor Submissions', path: (org) => `tenants/${org}/laborSubmissions` },
  { id: 'salesSubmissions', label: 'Sales Submissions', path: (org) => `tenants/${org}/salesSubmissions` },
  { id: 'inventoryCatalog', label: 'Inventory Catalog', path: (org) => `tenants/${org}/inventoryCatalog` },
  { id: 'inventorySessions', label: 'Inventory Sessions', path: (org) => `tenants/${org}/inventorySessions` },
  { id: 'orderGuides', label: 'Order Guides', path: (org) => `tenants/${org}/orderGuides` },
  { id: 'posData', label: 'POS Data', path: (org) => `tenants/${org}/posData` },
  { id: 'regions', label: 'Regions', path: (org) => `tenants/${org}/regions` },
  { id: 'locations', label: 'Locations', path: (org) => `tenants/${org}/locations` },
  { id: 'config', label: 'Config', path: (org) => `tenants/${org}/config` },
]

function formatValue(val) {
  if (val === null || val === undefined) return 'null'
  if (typeof val === 'object' && val.toDate) return val.toDate().toLocaleString()
  if (typeof val === 'object' && !Array.isArray(val)) return JSON.stringify(val).slice(0, 100) + (JSON.stringify(val).length > 100 ? '...' : '')
  if (Array.isArray(val)) return `[${val.length} items]`
  if (typeof val === 'number') return val.toLocaleString()
  return String(val)
}

export default function DataBrowserTab() {
  const user = useAuthStore(s => s.user)
  const orgId = user?.tenantId

  const [selectedCollection, setSelectedCollection] = useState(null)
  const [documents, setDocuments] = useState([])
  const [selectedDoc, setSelectedDoc] = useState(null)
  const [docData, setDocData] = useState(null)
  const [loading, setLoading] = useState(false)
  const { visibleLocations } = useLocations()
  const locOptions = visibleLocations.map(l => (l.name || '').replace(/[^a-zA-Z0-9]/g, '_'))
  const [locationFilter, setLocationFilter] = useState(locOptions[0] || 'Test_Sandbox')

  async function loadCollection(col) {
    setSelectedCollection(col)
    setSelectedDoc(null)
    setDocData(null)
    setLoading(true)
    try {
      const pathFn = COLLECTIONS.find(c => c.id === col.id)?.path
      if (!pathFn) return
      const path = col.id === 'pnl'
        ? pathFn(orgId, locationFilter)
        : pathFn(orgId)
      const snap = await getDocs(collection(db, ...path.split('/')))
      setDocuments(snap.docs.map(d => ({ id: d.id, data: d.data() })))
    } catch (err) {
      console.error('Load failed:', err)
      setDocuments([])
    }
    setLoading(false)
  }

  async function loadDocument(docItem) {
    setSelectedDoc(docItem.id)
    setDocData(docItem.data)
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <div>
          <h2 style={{ fontSize: 18, fontWeight: 600, margin: 0 }}>Data browser</h2>
          <p style={{ fontSize: 13, color: '#64748b', margin: '4px 0 0' }}>Browse Firestore collections and documents</p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 12, color: '#64748b' }}>Location (for P&L):</span>
          <select value={locationFilter} onChange={e => { setLocationFilter(e.target.value); if (selectedCollection) loadCollection({ ...selectedCollection }) }}
            style={{ padding: '6px 10px', fontSize: 12, border: '1px solid #e2e8f0', borderRadius: 6 }}>
            {locOptions.map(loc => (
              <option key={loc} value={loc}>{loc.replace(/_/g, ' ')}</option>
            ))}
          </select>
          {selectedCollection && (
            <button onClick={() => loadCollection(selectedCollection)} style={{
              padding: '6px 12px', fontSize: 11, fontWeight: 600,
              background: '#0f172a', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer',
            }}>Reload</button>
          )}
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '200px 240px 1fr', gap: 1, border: '1px solid #e2e8f0', borderRadius: 10, overflow: 'hidden', minHeight: 400 }}>
        {/* Collections */}
        <div style={{ background: '#f8fafc', borderRight: '1px solid #e2e8f0', overflowY: 'auto' }}>
          <div style={{ padding: '10px 12px', fontSize: 11, fontWeight: 600, color: '#64748b', textTransform: 'uppercase', borderBottom: '1px solid #e2e8f0' }}>Collections</div>
          {COLLECTIONS.map(col => (
            <button key={col.id} onClick={() => loadCollection(col)} style={{
              display: 'block', width: '100%', textAlign: 'left',
              padding: '8px 12px', fontSize: 12, border: 'none', cursor: 'pointer',
              background: selectedCollection?.id === col.id ? '#e0f2fe' : 'transparent',
              color: selectedCollection?.id === col.id ? '#0369a1' : '#475569',
              fontWeight: selectedCollection?.id === col.id ? 600 : 400,
              borderBottom: '1px solid #f1f5f9',
            }}>
              {col.label}
              {selectedCollection?.id === col.id && documents.length > 0 && (
                <span style={{ fontSize: 10, color: '#94a3b8', marginLeft: 4 }}>({documents.length})</span>
              )}
            </button>
          ))}
        </div>

        {/* Documents */}
        <div style={{ background: '#fff', borderRight: '1px solid #e2e8f0', overflowY: 'auto' }}>
          <div style={{ padding: '10px 12px', fontSize: 11, fontWeight: 600, color: '#64748b', textTransform: 'uppercase', borderBottom: '1px solid #e2e8f0' }}>Documents</div>
          {loading ? (
            <div style={{ padding: 20, textAlign: 'center', color: '#94a3b8', fontSize: 12 }}>Loading...</div>
          ) : documents.length === 0 ? (
            <div style={{ padding: 20, textAlign: 'center', color: '#94a3b8', fontSize: 12 }}>
              {selectedCollection ? 'No documents' : 'Select a collection'}
            </div>
          ) : documents.map(d => (
            <button key={d.id} onClick={() => loadDocument(d)} style={{
              display: 'block', width: '100%', textAlign: 'left',
              padding: '6px 12px', fontSize: 11, border: 'none', cursor: 'pointer',
              background: selectedDoc === d.id ? '#f0fdf4' : 'transparent',
              color: selectedDoc === d.id ? '#166534' : '#475569',
              fontWeight: selectedDoc === d.id ? 600 : 400,
              borderBottom: '1px solid #f1f5f9',
              fontFamily: 'monospace',
            }}>
              {d.id}
            </button>
          ))}
        </div>

        {/* Document Data */}
        <div style={{ background: '#fff', overflowY: 'auto', padding: 12 }}>
          <div style={{ padding: '0 0 8px', fontSize: 11, fontWeight: 600, color: '#64748b', textTransform: 'uppercase', borderBottom: '1px solid #e2e8f0', marginBottom: 8 }}>
            {selectedDoc ? selectedDoc : 'Fields'}
          </div>
          {docData ? (
            <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
              <tbody>
                {Object.entries(docData).sort(([a], [b]) => a.localeCompare(b)).map(([key, val]) => (
                  <tr key={key} style={{ borderBottom: '1px solid #f1f5f9' }}>
                    <td style={{ padding: '4px 8px 4px 0', fontWeight: 500, color: '#0f172a', fontFamily: 'monospace', fontSize: 11, verticalAlign: 'top', whiteSpace: 'nowrap' }}>{key}</td>
                    <td style={{ padding: '4px 0', color: typeof val === 'number' ? '#2563eb' : '#475569', fontFamily: 'monospace', fontSize: 11, wordBreak: 'break-all' }}>
                      {formatValue(val)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div style={{ color: '#94a3b8', fontSize: 12, padding: 20, textAlign: 'center' }}>Select a document</div>
          )}
        </div>
      </div>
    </div>
  )
}
