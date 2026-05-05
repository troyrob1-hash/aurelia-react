import { useState, useEffect } from 'react'
import { useAuthStore } from '@/store/authStore'
import { db } from '@/lib/firebase'
import { collection, getDocs, query, orderBy, limit, onSnapshot, doc } from 'firebase/firestore'
import { INTEGRATIONS } from '@/lib/integrations'

function timeAgo(date) {
  if (!date) return 'Never'
  const d = date.toDate ? date.toDate() : new Date(date)
  const seconds = Math.floor((Date.now() - d.getTime()) / 1000)
  if (seconds < 60) return 'Just now'
  if (seconds < 3600) return Math.floor(seconds / 60) + 'm ago'
  if (seconds < 86400) return Math.floor(seconds / 3600) + 'h ago'
  return Math.floor(seconds / 86400) + 'd ago'
}

export default function SyncStatusPanel() {
  const user = useAuthStore(s => s.user)
  const orgId = user?.tenantId
  const [statuses, setStatuses] = useState({})
  const [syncLog, setSyncLog] = useState([])

  useEffect(() => {
    if (!orgId) return
    // Subscribe to integration statuses
    const unsubs = Object.keys(INTEGRATIONS).map(id => {
      return onSnapshot(doc(db, 'tenants', orgId, 'integrations', id), snap => {
        if (snap.exists()) {
          setStatuses(prev => ({ ...prev, [id]: snap.data() }))
        }
      })
    })

    // Load recent sync log
    getDocs(query(
      collection(db, 'tenants', orgId, 'syncLog'),
      orderBy('createdAt', 'desc'),
      limit(20)
    )).then(snap => {
      setSyncLog(snap.docs.map(d => ({ id: d.id, ...d.data() })))
    }).catch(() => {})

    return () => unsubs.forEach(u => u())
  }, [orgId])

  const integrationList = Object.values(INTEGRATIONS)

  return (
    <div>
      <div style={{ marginBottom: 16 }}>
        <h2 style={{ fontSize: 18, fontWeight: 600, margin: 0 }}>Sync status</h2>
        <p style={{ fontSize: 13, color: '#64748b', margin: '4px 0 0' }}>Real-time status of all integrations</p>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 10, marginBottom: 24 }}>
        {integrationList.map(integ => {
          const status = statuses[integ.id] || {}
          const isConnected = status.connected
          const isSyncing = status.syncStatus === 'syncing'
          const hasError = status.syncStatus === 'error'

          return (
            <div key={integ.id} style={{
              padding: '12px 16px', background: '#fff',
              border: '1px solid ' + (hasError ? '#fecaca' : isConnected ? '#bbf7d0' : '#e2e8f0'),
              borderRadius: 10,
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                <span style={{ fontSize: 13, fontWeight: 500, color: '#0f172a' }}>{integ.name}</span>
                <span style={{
                  fontSize: 9, padding: '2px 6px', borderRadius: 10, fontWeight: 600,
                  background: hasError ? '#fef2f2' : isConnected ? '#f0fdf4' : '#f8fafc',
                  color: hasError ? '#dc2626' : isConnected ? '#059669' : '#94a3b8',
                }}>
                  {isSyncing ? 'Syncing...' : hasError ? 'Error' : isConnected ? 'Connected' : 'Not connected'}
                </span>
              </div>
              <div style={{ fontSize: 11, color: '#94a3b8' }}>
                {isConnected ? 'Last sync: ' + timeAgo(status.lastSync) : integ.authType === 'file_import' ? 'File import' : 'Needs API key'}
              </div>
              {hasError && (
                <div style={{ fontSize: 11, color: '#dc2626', marginTop: 4 }}>{status.error}</div>
              )}
            </div>
          )
        })}
      </div>

      {syncLog.length > 0 && (
        <div>
          <div style={{ fontSize: 14, fontWeight: 600, color: '#0f172a', marginBottom: 8 }}>Recent activity</div>
          <div style={{ border: '1px solid #e2e8f0', borderRadius: 10, overflow: 'hidden' }}>
            {syncLog.slice(0, 10).map((log, i) => (
              <div key={log.id} style={{
                padding: '8px 14px', fontSize: 12,
                borderBottom: i < 9 ? '1px solid #f1f5f9' : 'none',
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              }}>
                <div>
                  <span style={{ fontWeight: 500, color: '#0f172a' }}>
                    {INTEGRATIONS[log.integrationId]?.name || log.integrationId}
                  </span>
                  <span style={{ color: '#64748b', marginLeft: 8 }}>{log.type?.replace(/_/g, ' ')}</span>
                  {log.message && <span style={{ color: '#94a3b8', marginLeft: 8 }}>{log.message}</span>}
                </div>
                <span style={{ fontSize: 11, color: '#94a3b8', whiteSpace: 'nowrap' }}>
                  {timeAgo(log.createdAt)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
