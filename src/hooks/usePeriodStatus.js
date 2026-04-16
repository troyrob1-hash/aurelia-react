import { useState, useEffect } from 'react'
import { db } from '@/lib/firebase'
import { collection, query, where, getDocs, doc, getDoc } from 'firebase/firestore'
import { useAuthStore } from '@/store/authStore'
import { readPnL, readPeriodClose, locId } from '@/lib/pnl'

// Check readiness of all 5 source tabs for a given location + period.
// Returns { sources: [...], allReady, periodStatus, closedBy, closedAt }
export function usePeriodStatus(location, periodKey) {
  const { user } = useAuthStore()
  const orgId = user?.tenantId || 'fooda'
  const [status, setStatus] = useState({
    sources: [],
    allReady: false,
    periodStatus: 'open',
    closedBy: null,
    closedAt: null,
    loading: true,
  })

  useEffect(() => {
    if (!location || !periodKey || location === 'all') {
      setStatus(prev => ({ ...prev, loading: false }))
      return
    }

    let cancelled = false

    async function check() {
      try {
        const lid = locId(location)

        // 1. Read P&L period doc for existing data + close status
        const pnl = await readPnL(location, periodKey)
        const closeInfo = await readPeriodClose(location, periodKey)

        // 2. Check each source
        const sources = []

        // Sales — check salesSubmissions for this location + period
        try {
          const salesQ = query(
            collection(db, 'tenants', orgId, 'salesSubmissions'),
            where('period', '==', periodKey),
            where('location', '==', location),
            where('status', 'in', ['approved'])
          )
          const salesSnap = await getDocs(salesQ)
          sources.push({
            key: 'sales',
            label: 'Weekly Sales',
            status: salesSnap.size > 0 ? 'approved' : 'missing',
          })
        } catch {
          sources.push({ key: 'sales', label: 'Weekly Sales', status: 'missing' })
        }

        // Labor — check laborSubmissions
        try {
          const laborQ = query(
            collection(db, 'tenants', orgId, 'laborSubmissions'),
            where('period', '==', periodKey),
            where('location', '==', location),
            where('status', 'in', ['approved'])
          )
          const laborSnap = await getDocs(laborQ)
          sources.push({
            key: 'labor',
            label: 'Labor',
            status: laborSnap.size > 0 ? 'approved' : 'missing',
          })
        } catch {
          sources.push({ key: 'labor', label: 'Labor', status: 'missing' })
        }

        // Purchasing — check if AP is formally closed or has data
        const purchasingStatus = pnl.source_purchasing === 'closed' ? 'approved'
          : pnl.cogs_purchases ? 'posted' : 'missing'
        sources.push({
          key: 'purchasing',
          label: 'Purchasing',
          status: purchasingStatus,
        })

        // Inventory — check if inventory fields exist on P&L doc
        sources.push({
          key: 'inventory',
          label: 'Inventory',
          status: (pnl.inv_closing !== undefined && pnl.inv_closing !== null) ? 'posted' : 'missing',
        })

        // Waste — check if any waste entries exist (read from entries or just check P&L doc)
        sources.push({
          key: 'waste',
          label: 'Waste Log',
          status: 'optional',  // Waste is operational, not required for close
        })

        const requiredSources = sources.filter(s => s.key !== 'waste')
        const allReady = requiredSources.every(s => s.status === 'approved' || s.status === 'posted')

        if (!cancelled) {
          setStatus({
            sources,
            allReady,
            periodStatus: closeInfo.periodStatus,
            closedBy: closeInfo.closedBy,
            closedAt: closeInfo.closedAt,
            reopenedBy: closeInfo.reopenedBy,
            reopenReason: closeInfo.reopenReason,
            loading: false,
          })
        }
      } catch (err) {
        console.error('usePeriodStatus error:', err)
        if (!cancelled) setStatus(prev => ({ ...prev, loading: false }))
      }
    }

    check()
    return () => { cancelled = true }
  }, [location, periodKey, orgId])

  return status
}
