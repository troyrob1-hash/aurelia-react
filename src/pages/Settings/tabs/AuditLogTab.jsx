import { useState, useEffect } from 'react'
import { useAuthStore } from '@/store/authStore'
import { db } from '@/lib/firebase'
import { collection, getDocs, query, orderBy, limit, where } from 'firebase/firestore'

function timeAgo(date) {
  if (!date) return ''
  const d = date.toDate ? date.toDate() : new Date(date)
  const seconds = Math.floor((Date.now() - d.getTime()) / 1000)
  if (seconds < 60) return 'Just now'
  if (seconds < 3600) return Math.floor(seconds / 60) + 'm ago'
  if (seconds < 86400) return Math.floor(seconds / 3600) + 'h ago'
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

const ACTION_COLORS = {
  'pnl.updated': '#2563eb', 'period.closed': '#059669', 'period.reopened': '#d97706',
  'invoice.created': '#7c3aed', 'invoice.approved': '#2563eb', 'invoice.paid': '#059669',
  'je.created': '#7c3aed', 'order.submitted': '#2563eb', 'order.received': '#059669',
  'inventory.counted': '#059669', 'labor.imported': '#2563eb', 'sales.imported': '#2563eb',
  'budget.uploaded': '#059669', 'user.login': '#64748b', 'data.exported': '#64748b',
  'settings.changed': '#d97706', 'integration.connected': '#059669', 'integration.synced': '#2563eb',
}

export default function AuditLogTab() {
  const user = useAuthStore(s => s.user)
  const orgId = user?.tenantId
  const [logs, setLogs] = useState([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState('all')

  useEffect(() => {
    if (!orgId) return
    setLoading(true)
    const q = query(
      collection(db, 'tenants', orgId, 'auditTrail'),
      orderBy('createdAt', 'desc'),
      limit(100)
    )
    getDocs(q).then(snap => {
      setLogs(snap.docs.map(d => ({ id: d.id, ...d.data() })))
    }).catch(err => {
      console.warn('Audit log load failed:', err.message)
      setLogs([])
    }).finally(() => setLoading(false))
  }, [orgId])

  const categories = ['all', 'pnl', 'invoice', 'order', 'inventory', 'labor', 'sales', 'user', 'settings']
  const filtered = filter === 'all' ? logs : logs.filter(l => l.action?.startsWith(filter))

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <div>
          <h2 style={{ fontSize: 18, fontWeight: 600, margin: 0 }}>Activity log</h2>
          <p style={{ fontSize: 13, color: '#64748b', margin: '4px 0 0' }}>All actions across the platform</p>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 6, marginBottom: 16, flexWrap: 'wrap' }}>
        {categories.map(cat => (
          <button key={cat} onClick={() => setFilter(cat)} style={{
            padding: '4px 12px', fontSize: 12, fontWeight: filter === cat ? 600 : 400,
            background: filter === cat ? '#0f172a' : '#f1f5f9',
            color: filter === cat ? '#fff' : '#475569',
            border: 'none', borderRadius: 6, cursor: 'pointer',
            textTransform: 'capitalize',
          }}>{cat}</button>
        ))}
      </div>

      {loading ? (
        <div style={{ textAlign: 'center', padding: 40, color: '#94a3b8' }}>Loading activity...</div>
      ) : filtered.length === 0 ? (
        <div style={{ textAlign: 'center', padding: 40, color: '#94a3b8' }}>No activity recorded yet</div>
      ) : (
        <div style={{ border: '1px solid #e2e8f0', borderRadius: 10, overflow: 'hidden' }}>
          {filtered.map((log, i) => {
            const color = ACTION_COLORS[log.action] || '#64748b'
            return (
              <div key={log.id} style={{
                padding: '10px 16px', fontSize: 12,
                borderBottom: i < filtered.length - 1 ? '1px solid #f1f5f9' : 'none',
                display: 'flex', alignItems: 'flex-start', gap: 10,
              }}>
                <div style={{
                  width: 6, height: 6, borderRadius: '50%', background: color,
                  marginTop: 5, flexShrink: 0,
                }}/>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                    <span style={{ fontWeight: 500, color: '#0f172a' }}>
                      {log.action?.replace(/\./g, ' · ')}
                    </span>
                    <span style={{ fontSize: 11, color: '#94a3b8', whiteSpace: 'nowrap', marginLeft: 8 }}>
                      {timeAgo(log.createdAt)}
                    </span>
                  </div>
                  <div style={{ color: '#64748b', marginTop: 2 }}>
                    {log.user && <span>{log.user}</span>}
                    {log.location && <span> · {log.location}</span>}
                    {log.periodKey && <span> · {log.periodKey}</span>}
                    {log.vendor && <span> · {log.vendor}</span>}
                    {log.amount && <span> · ${Number(log.amount).toLocaleString()}</span>}
                    {log.source && <span> · {log.source}</span>}
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
