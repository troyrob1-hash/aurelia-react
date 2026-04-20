import { useState, useEffect, useMemo, useCallback } from 'react'
import { useAuthStore } from '@/store/authStore'
import { useLocations, cleanLocName } from '@/store/LocationContext'
import { usePeriod } from '@/store/PeriodContext'
import { readPeriodClose, getPriorKey } from '@/lib/pnl'
import { db } from '@/lib/firebase'
import { useInventory, fmt$, sanitizeDocId } from '@/hooks/useInventory'
import { getTopVarianceIssues, calcParStatus } from '@/lib/variance'
import { Search, Download, RefreshCw, Eye, EyeOff, TrendingUp, TrendingDown, Minus, AlertTriangle } from 'lucide-react'
import { useToast } from '@/components/ui/Toast'
import AllLocationsGrid from '@/components/AllLocationsGrid'
import styles from './Inventory.module.css'

// ─── Helpers ─────────────────────────────────────────────────────────────
function formatLastCounted(iso) {
  if (!iso) return null
  const then = new Date(iso)
  if (isNaN(then.getTime())) return null
  const days = Math.floor((Date.now() - then.getTime()) / 86400000)
  if (days < 1) return { label: 'today', tone: 'fresh' }
  if (days === 1) return { label: '1d ago', tone: 'fresh' }
  if (days < 7) return { label: days + 'd ago', tone: 'fresh' }
  if (days < 14) return { label: days + 'd ago', tone: 'warn' }
  if (days < 60) return { label: days + 'd ago', tone: 'stale' }
  return { label: '60d+ ago', tone: 'stale' }
}

// Confidence score for an item — surfaces in a per-row badge so directors
// scanning the count sheet know what to trust. Combines staleness + variance.
function calcConfidence(item) {
  if (item.qty == null || item.qty === 0) return null
  const lc = formatLastCounted(item.lastCountedAt)
  const stale = lc?.tone === 'stale'
  const warn  = lc?.tone === 'warn'
  const varClass = item._varClass || 'neutral'
  if (stale || varClass === 'alert') return { level: 'low', label: 'low confidence', color: '#dc2626', bg: '#fef2f2' }
  if (warn  || varClass === 'warn')  return { level: 'med', label: 'medium', color: '#b45309', bg: '#fef3c7' }
  return { level: 'high', label: 'high', color: '#059669', bg: '#f0fdf4' }
}

// ═══════════════════════════════════════════════════════════════════════════
// Inventory Component - Aurelia FMS
// ═══════════════════════════════════════════════════════════════════════════

export default function Inventory() {
  const toast = useToast()
  const { user } = useAuthStore()
  
  // FIXED: Consistent orgId pattern
  const orgId = user?.tenantId || null
  
  const { selectedLocation, setSelectedLocation } = useLocations()
  const [isMobile, setIsMobile] = useState(window.innerWidth < 768)
  useEffect(() => {
    const onResize = () => setIsMobile(window.innerWidth < 768)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  const { periodKey } = usePeriod()

  // ─── Local UI State ────────────────────────────────────────────────────────
  const [search, setSearch] = useState('')
  const [activeCat, setActiveCat] = useState('all')
  const [collapsed, setCollapsed] = useState({})
  const [blindMode, setBlindMode] = useState(false)
  const [showVariance, setShowVariance] = useState(true)
  const [showParPanel, setShowParPanel] = useState(false)
  const [countMode, setCountMode] = useState('full')  // 'quick' | 'section' | 'full'
  const [showManage, setShowManage] = useState(false)
  const [customDraft, setCustomDraft] = useState({ name: '', vendor: '', unitCost: '', packSize: '' })
  const [manageSearch, setManageSearch] = useState('')
  const [whyItem, setWhyItem] = useState(null)
  const [showBuddySetup, setShowBuddySetup] = useState(false)
  const [buddyDraft, setBuddyDraft] = useState({ caller: '', marker: '' })

  const [periodClosed, setPeriodClosed] = useState(false)
  useEffect(() => {
    if (!selectedLocation || selectedLocation === 'all' || !periodKey) return
    (async () => {
      try {
        const close = await readPeriodClose(selectedLocation, setSelectedLocation, periodKey)
        setPeriodClosed(close.periodStatus === 'closed')
      } catch {}
    })()
  }, [selectedLocation, periodKey])

  const [tabClosed, setTabClosed] = useState(false)
  useEffect(() => {
    if (!selectedLocation || selectedLocation === 'all' || !periodKey) return
    (async () => {
      try {
        const { getDoc, doc: fbDoc } = await import('firebase/firestore')
        const oid = user?.tenantId || 'fooda'
        const ref = fbDoc(db, 'tenants', oid, 'inventoryClose', `${(selectedLocation||'').replace(/[^a-zA-Z0-9]/g,'_')}-${periodKey}`)
        const snap = await getDoc(ref)
        if (snap.exists()) setTabClosed(true)
      } catch {}
    })()
  }, [selectedLocation, periodKey])

  async function handleCloseTab() {
    if (!selectedLocation || selectedLocation === 'all') return
    if (!window.confirm(`Close Inventory for ${periodKey}?`)) return
    try {
      const { setDoc, doc: fbDoc, serverTimestamp } = await import('firebase/firestore')
      const oid = user?.tenantId || 'fooda'
      await setDoc(fbDoc(db, 'tenants', oid, 'inventoryClose', `${(selectedLocation||'').replace(/[^a-zA-Z0-9]/g,'_')}-${periodKey}`), {
        location: selectedLocation, period: periodKey,
        closedBy: user?.name || user?.email, closedAt: serverTimestamp(),
      })
      const { writePnL: wp } = await import('@/lib/pnl')
      await wp(selectedLocation, periodKey, { source_inventory: 'closed' })
      setTabClosed(true)
      toast.success('Inventory closed for ' + periodKey)
    } catch (err) {
      toast.error('Failed: ' + (err.message || ''))
    }
  }

  const location = selectedLocation === 'all' ? null : selectedLocation

  // ─── Use Inventory Hook ────────────────────────────────────────────────────
  const {
    items,
    categories,
    catStats,
    totals,
    varianceAlerts,
    itemsBelowPar,
    session,
    loading,
    saving,
    dirty,
    error,
    load,
    adjust,
    setQty,
    copyPrior,
    toggleKey,
    removeItem,
    restoreItem,
    addCustomItem,
    removedItems,
    loadRemovedItems,
    buddyMode,
    setBuddyMode,
    buddyNames,
    setBuddyNames,
    markSectionComplete,
    save
  } = useInventory(orgId, location, periodKey, user)

  // ─── Handlers ──────────────────────────────────────────────────────────────
  async function seedPriorPeriod() {
    if (!location || !orgId) { toast.error('Select a location first'); return }
    if (!window.confirm('Seed inventory counts for the prior period? This creates realistic opening inventory data.')) return
    try {
      const { setDoc, doc: fbDoc, serverTimestamp } = await import('firebase/firestore')
      const priorPK = getPriorKey(periodKey)
      if (!priorPK) { toast.error('No prior period for ' + periodKey); return }
      const locKey = (location || '').replace(/[^a-zA-Z0-9]/g, '_')

      // Generate realistic quantities for each item based on category
      const catQtyRanges = {
        'Beverages': [2, 15], 'Bar/Barista': [1, 8], 'Pantry/Snacks': [3, 20],
        'Dairy': [2, 10], 'Frozen': [1, 8], 'Proteins': [1, 6],
        'Produce': [2, 12], 'General': [1, 10],
      }

      const seededItems = items.map(item => {
        const range = catQtyRanges[item.category] || [1, 10]
        const qty = Math.round((range[0] + Math.random() * (range[1] - range[0])) * 2) / 2
        return { ...item, qty }
      })

      // Save each item count to the prior period
      // Write counts in batches of 50 to avoid overwhelming Firestore
      for (let b = 0; b < seededItems.length; b += 50) {
        const chunk = seededItems.slice(b, b + 50)
        await Promise.all(chunk.map(item =>
          setDoc(
            fbDoc(db, 'tenants', orgId, 'inventory', locKey, 'items', item.id),
            { qty: item.qty, updatedAt: new Date(), updatedBy: 'seed-script' },
            { merge: true }
          )
        ))
      }

      // Compute closing value
      const closingValue = seededItems.reduce((sum, item) => sum + (item.qty * (item.unitCost || 0)), 0)

      // Write to PNL period doc
      await setDoc(
        fbDoc(db, 'tenants', orgId, 'pnl', locKey, 'periods', priorPK),
        {
          closingValue: Math.round(closingValue * 100) / 100,
          openingValue: 0,
          cogs_inventory: 0,
          inventoryCountedAt: new Date(),
          inventoryCountedBy: 'seed-script',
        },
        { merge: true }
      )

      // Save as prior period snapshot (path that useInventory reads from)
      const cleanItems = seededItems.map(i => ({ id: String(i.id), name: String(i.name || ''), qty: Number(i.qty || 0), unitCost: Number(i.unitCost || 0), category: String(i.category || '') }))
      await setDoc(
        fbDoc(db, 'tenants', orgId, 'locations', locKey, 'inventory', priorPK),
        {
          items: cleanItems,
          closingValue: Math.round(closingValue * 100) / 100,
          countedAt: new Date(),
          countedBy: 'seed-script',
          location: location,
          periodKey: priorPK,
        }
      )
      // Also write to inventorySessions for Path B
      await setDoc(
        fbDoc(db, 'tenants', orgId, 'inventorySessions', locKey + '_' + priorPK),
        {
          items: cleanItems,
          closingValue: Math.round(closingValue * 100) / 100,
          countedAt: new Date(),
          countedBy: 'seed-script',
          location: location,
          periodKey: priorPK,
        }
      )

      toast.success('Prior period seeded: ' + seededItems.length + ' items, closing value $' + Math.round(closingValue).toLocaleString() + ' for ' + priorPK)

      // Reload to pick up new opening value
      window.location.reload()
    } catch (err) {
      toast.error('Seed failed: ' + (err.message || ''))
    }
  }

  const handleSave = useCallback(async () => {
    if (!orgId) {
      toast.error('No organization found. Please log in again.')
      return
    }
    
    try {
      const success = await save()
      if (success) {
        toast.success('Inventory saved — period closed')
      } else {
        toast.error('Save failed. Please try again.')
      }
    } catch (err) {
      console.error('Save error:', err)
      toast.error('Save failed: ' + err.message)
    }
  }, [save, toast, orgId])

  const toggleCollapse = useCallback((key) => {
    setCollapsed(prev => ({ ...prev, [key]: !prev[key] }))
  }, [])

  const handleExport = useCallback(async () => {
    if (!location) {
      toast.error('Please select a location first')
      return
    }
    
    try {
      const XLSX = await import('xlsx')
      const wb = XLSX.utils.book_new()

      // Summary sheet
      const summaryRows = [
        ['Aurelia FMS — Inventory Count Report'],
        ['Location:', cleanLocName(location) || 'Unknown'],
        ['Period:', periodKey || 'N/A'],
        ['Date:', new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })],
        [],
        ['COGS CALCULATION'],
        ['Opening Inventory', (totals.openingValue || 0).toFixed(2)],
        ['+ Purchases', (totals.purchases || 0).toFixed(2)],
        ['- Closing Inventory', (totals.closingValue || 0).toFixed(2)],
        ['= COGS (Inventory Usage)', (totals.liveCOGS || 0).toFixed(2)],
        [],
        ['SUMMARY'],
        ['Total Items', items.length],
        ['Items Counted', totals.counted || 0],
        ['Inventory Value', (totals.closingValue || 0).toFixed(2)],
        ['Progress', (totals.progress || 0) + '%'],
      ]
      const wsSummary = XLSX.utils.aoa_to_sheet(summaryRows)
      XLSX.utils.book_append_sheet(wb, wsSummary, 'Summary')

      // Detail sheet
      const header = ['#', 'Item', 'Vendor', 'Category', 'Pack Size', 'Unit Cost', 'Count', 'Prior Count', 'Variance', 'Total Value', 'Par Level', 'Days On Hand']
      const detailRows = items.map((item, idx) => [
        idx + 1, 
        item.name || '', 
        item.vendor || '',
        categories.find(c => c.key === item._cat)?.label || 'General',
        item.packSize || '', 
        item.unitCost || 0, 
        item.qty || 0,
        item._priorQty || 0, 
        item._variance || 0, 
        +((item.qty || 0) * (item.unitCost || 0)).toFixed(2),
        item.parLevel || '', 
        item._daysOnHand || ''
      ])
      const wsDetail = XLSX.utils.aoa_to_sheet([header, ...detailRows])
      wsDetail['!cols'] = [
        { wch: 4 }, { wch: 40 }, { wch: 15 }, { wch: 18 }, { wch: 10 }, 
        { wch: 10 }, { wch: 8 }, { wch: 10 }, { wch: 10 }, { wch: 12 }, 
        { wch: 10 }, { wch: 12 }
      ]
      XLSX.utils.book_append_sheet(wb, wsDetail, 'All Items')

      XLSX.writeFile(wb, `inventory-${sanitizeDocId(location)}-${periodKey}.xlsx`)
      toast.success('Exported to Excel')
    } catch (err) {
      console.error('Export failed:', err)
      toast.error('Export failed: ' + err.message)
    }
  }, [items, categories, totals, location, periodKey, toast])

  const handleRefresh = useCallback(() => {
    load()
    toast.info('Refreshing inventory...')
  }, [load, toast])

  // ─── Filtered Items ────────────────────────────────────────────────────────
  const q = search.toLowerCase()
  const displayItems = useMemo(() => items.filter(i => {
    // Count mode filter — the most aggressive scope cut
    if (countMode === 'quick' && !i.isKey) return false
    if (countMode === 'section' && activeCat === 'all') return false  // section mode requires a category pick
    const matchCat = activeCat === 'all' || i._cat === activeCat
    const matchSearch = !q || i.name?.toLowerCase().includes(q) || i.vendor?.toLowerCase().includes(q)
    return matchCat && matchSearch
  }), [items, activeCat, q, countMode])

  const keyItemCount = useMemo(() => items.filter(i => i.isKey).length, [items])

  const displayGroups = useMemo(() => {
    const cats = activeCat === 'all' ? categories : categories.filter(c => c.key === activeCat)
    return cats.map(cat => ({
      ...cat,
      items: displayItems.filter(i => i._cat === cat.key),
    })).filter(g => g.items.length > 0)
  }, [displayItems, activeCat, categories])

  // ─── Top Variance Alerts ───────────────────────────────────────────────────
  const topVariance = useMemo(() => getTopVarianceIssues(items, 3), [items])

  // ─── Empty State ───────────────────────────────────────────────────────────
  if (!location) {
    return (
      <AllLocationsGrid
        title="Inventory"
        subtitle="Select a location to begin counting"
        onSelectLocation={name => setSelectedLocation(name)}
        statusLabel="Not counted"
      />
    )
  }

  // ─── Auth Check ────────────────────────────────────────────────────────────
  if (!orgId) {
    return (
      <div className={styles.empty}>
        <div className={styles.emptyIcon}>🔒</div>
        <p className={styles.emptyTitle}>Not authenticated</p>
        <p className={styles.emptySub}>Please log in to access inventory</p>
      </div>
    )
  }

  // ─── Render ────────────────────────────────────────────────────────────────
  return (
    <div className={styles.pageWrap}>
      {/* Category Chips */}
      <div className={styles.chipBar}>
        <button 
          className={`${styles.chip} ${activeCat === 'all' ? styles.chipActive : ''}`} 
          onClick={() => setActiveCat('all')}
        >
          All Items
          <span className={styles.chipBadge}>{totals.counted || 0}/{totals.total || 0}</span>
        </button>
        {categories.map(cat => {
          const cc = catStats[cat.key] || { total: 0, counted: 0 }
          const done = cc.counted === cc.total && cc.total > 0
          const pct = cc.total > 0 ? cc.counted / cc.total : 0
          return (
            <button 
              key={cat.key}
              className={`${styles.chip} ${activeCat === cat.key ? styles.chipActive : ''}`}
              onClick={() => setActiveCat(cat.key)}
              style={activeCat === cat.key 
                ? { borderColor: cat.color, color: cat.color, background: cat.bg } 
                : { borderColor: cat.color + '40', color: cat.color }
              }
            >
              <svg width="14" height="14" viewBox="0 0 14 14" style={{ flexShrink: 0 }}>
                <circle cx="7" cy="7" r="5" fill="none" stroke={cat.color + '30'} strokeWidth="2" />
                <circle 
                  cx="7" cy="7" r="5" fill="none" 
                  stroke={done ? '#10b981' : cat.color} 
                  strokeWidth="2"
                  strokeDasharray={`${pct * 31.4} 31.4`} 
                  strokeLinecap="round"
                  transform="rotate(-90 7 7)" 
                  style={{ transition: 'stroke-dasharray .4s' }} 
                />
              </svg>
              {cat.label}
              <span className={styles.chipBadge} style={{ background: done ? '#10b981' : cat.color + '99' }}>
                {cc.counted}/{cc.total}
              </span>
            </button>
          )
        })}
      </div>

      <div className={styles.invContent}>
        {/* Header */}
        <div className={styles.header}>
          <div>
            <h1 className={styles.title}>{cleanLocName(location) || 'Unknown Location'}</h1>
            <p className={styles.subtitle}>
              Inventory Count · {periodKey || 'No period selected'}
              {session && (
                <span className={styles.sessionBadge}>
                  Session active · {session.sectionsCompleted?.length || 0}/{categories.length} sections
                </span>
              )}
            </p>
          </div>
          <div className={styles.headerActions}>
            <button 
              className={`${styles.btnMode} ${blindMode ? styles.btnModeActive : ''}`} 
              onClick={() => setBlindMode(v => !v)} 
              title="Blind count mode"
            >
              {blindMode ? <EyeOff size={14} /> : <Eye size={14} />}
              {blindMode ? 'Blind' : 'Show prior'}
            </button>
            <button
              className={styles.btnMode}
              onClick={() => { setShowManage(true); loadRemovedItems() }}
              title="Add or remove items for this location"
            >
              ⚙ Manage items
            </button>
            <button
              className={`${styles.btnMode} ${buddyMode ? styles.btnModeActive : ''}`}
              onClick={() => {
                if (buddyMode) {
                  setBuddyMode(false)
                  setBuddyNames({ caller: '', marker: '' })
                } else {
                  setBuddyDraft({ caller: '', marker: '' })
                  setShowBuddySetup(true)
                }
              }}
              title={buddyMode ? 'Exit buddy mode' : 'Start a team count with two people'}
            >
              {buddyMode ? `👥 ${buddyNames.caller || '?'} + ${buddyNames.marker || '?'}` : '👥 Buddy mode'}
            </button>
            <button 
              className={`${styles.btnMode} ${showParPanel ? styles.btnModeActive : ''}`} 
              onClick={() => setShowParPanel(v => !v)} 
              title="Par levels"
            >
              <AlertTriangle size={14} />
              Par ({totals.belowPar || 0})
            </button>
            {dirty && (
              <button className={styles.btnSave} onClick={handleSave} disabled={saving}>
                {saving ? 'Saving...' : 'Save & Close Period'}
              </button>
            )}
            <button onClick={seedPriorPeriod} style={{
              padding: '6px 12px', fontSize: 12, fontWeight: 500,
              background: '#7c3aed', color: '#fff', border: 'none', borderRadius: 6,
              cursor: 'pointer',
            }} title="Seed prior period inventory counts">
              Seed Prior
            </button>
            <button className={styles.btnIcon} onClick={handleExport} title="Export Excel">
              <Download size={15} />
            </button>
            <button className={styles.btnIcon} onClick={handleRefresh} title="Refresh">
              <RefreshCw size={15} className={loading ? styles.spin : ''} />
            </button>
          </div>
        </div>

        {/* KPI Bar */}
        <div className={styles.kpiBar}>
          <div className={`${styles.kpi} ${styles.kpiDark}`}>
            <div className={styles.kpiLabel}>Live COGS</div>
            <div className={styles.kpiValue} style={{ color: '#6ee7b7' }}>{fmt$(totals.liveCOGS)}</div>
            <div className={styles.cogsFormula}>
              {fmt$(totals.openingValue)} + {fmt$(totals.purchases)} − {fmt$(totals.closingValue)}
            </div>
          </div>
          <div className={styles.kpi}>
            <div className={styles.kpiLabel}>Closing Value</div>
            <div className={styles.kpiValue}>{fmt$(totals.closingValue)}</div>
            <div className={styles.kpiSub}>Current count</div>
          </div>
          <div className={styles.kpi}>
            <div className={styles.kpiLabel}>Opening Value</div>
            <div className={styles.kpiValue} style={{ color: '#888' }}>{fmt$(totals.openingValue)}</div>
            <div className={styles.kpiSub}>Prior week closing</div>
          </div>
          <div className={styles.kpi}>
            <div className={styles.kpiLabel}>Progress</div>
            <div className={styles.kpiValue}>
              {totals.counted || 0} <span className={styles.kpiOf}>of {totals.total || 0}</span>
            </div>
            <div className={styles.progressWrap}>
              <div className={styles.progressBar}>
                <div className={styles.progressFill} style={{ width: (totals.progress || 0) + '%' }} />
              </div>
              <span className={styles.kpiPct}>{totals.progress || 0}%</span>
            </div>
          </div>
          <div className={styles.kpi}>
            <div className={styles.kpiLabel}>Purchases</div>
            <div className={styles.kpiValue} style={{ color: '#888' }}>{fmt$(totals.purchases)}</div>
            <div className={styles.kpiSub}>From AP this period</div>
          </div>
        </div>

        {/* Variance Alerts */}
        {topVariance.length > 0 && !blindMode && (
          <div className={styles.alertsBox}>
            <p className={styles.alertsTitle}>Variance alerts</p>
            <div className={styles.alertsList}>
              {topVariance.map(item => (
                <div key={item.id} className={styles.alertItem}>
                  <span className={`${styles.alertDot} ${styles['alert_' + item.status]}`} />
                  <span className={styles.alertName}>{item.name}:</span>
                  <span className={styles.alertDetail}>
                    {item.direction === 'down' ? '−' : '+'}{Math.abs(item.variance)} ({item.pct}%)
                  </span>
                  <span className={`${styles.alertAction} ${styles['action_' + item.status]}`}>
                    {item.status === 'alert' ? 'Investigate' : 'Review'}
                  </span>
                </div>
              ))}
              {items.filter(i => i._varClass === 'good').length > 0 && (
                <div className={styles.alertItem}>
                  <span className={`${styles.alertDot} ${styles.alert_good}`} />
                  <span className={styles.alertDetail}>
                    {items.filter(i => i._varClass === 'good').length} items within normal variance (±10%)
                  </span>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Par Level Panel */}
        {showParPanel && itemsBelowPar && itemsBelowPar.length > 0 && (
          <div className={styles.parPanel}>
            <p className={styles.parTitle}>Items below par ({itemsBelowPar.length})</p>
            <div className={styles.parList}>
              {itemsBelowPar.slice(0, 5).map(item => {
                const par = calcParStatus(item)
                return (
                  <div key={item.id} className={styles.parItem}>
                    <div className={styles.parItemHeader}>
                      <div>
                        <p className={styles.parItemName}>{item.name}</p>
                        <p className={styles.parItemVendor}>{item.vendor}</p>
                      </div>
                      <div className={styles.parItemStats}>
                        <span className={styles.parQty}>{item.qty || 0}</span>
                        <span className={styles.parOf}>/ {item.parLevel} par</span>
                        {par?.daysOnHand && (
                          <span className={`${styles.parDays} ${par.status === 'critical' ? styles.parDaysCrit : ''}`}>
                            {par.daysOnHand} days
                          </span>
                        )}
                      </div>
                    </div>
                    <div className={styles.parBar}>
                      <div 
                        className={`${styles.parFill} ${styles['parFill_' + (par?.status || 'normal')]}`}
                        style={{ width: (par?.fillPct || 0) + '%' }}
                      />
                      {par?.reorderPct > 0 && (
                        <div 
                          className={styles.parReorderMark}
                          style={{ left: par.reorderPct + '%' }}
                        />
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {/* Toolbar */}
        <div className={styles.toolbar}>
          {/* Count mode selector */}
          <div style={{
            display: 'inline-flex',
            background: '#f1f5f9',
            borderRadius: 8,
            padding: 3,
            marginRight: 12,
            gap: 2,
          }}>
            {[
              { key: 'quick',   label: 'Quick',   sub: keyItemCount > 0 ? `${keyItemCount} key items` : 'key items' },
              { key: 'section', label: 'Section', sub: 'one category' },
              { key: 'full',    label: 'Full',    sub: `${items.length} items` },
            ].map(m => {
              const active = countMode === m.key
              return (
                <button
                  key={m.key}
                  onClick={() => setCountMode(m.key)}
                  style={{
                    background: active ? '#fff' : 'transparent',
                    border: 'none',
                    borderRadius: 6,
                    padding: '6px 14px',
                    cursor: 'pointer',
                    boxShadow: active ? '0 1px 3px rgba(15,23,42,0.08)' : 'none',
                    fontFamily: 'inherit',
                    textAlign: 'left',
                    minWidth: 90,
                    transition: 'all 0.15s',
                  }}
                >
                  <div style={{
                    fontSize: 12,
                    fontWeight: 500,
                    color: active ? '#0f172a' : '#64748b',
                    lineHeight: 1.2,
                  }}>
                    {m.label}
                  </div>
                  <div style={{
                    fontSize: 9,
                    color: active ? '#94a3b8' : '#94a3b8',
                    textTransform: 'uppercase',
                    letterSpacing: '0.04em',
                    marginTop: 1,
                  }}>
                    {m.sub}
                  </div>
                </button>
              )
            })}
          </div>
          <div className={styles.searchWrap}>
            <Search size={14} className={styles.searchIcon} />
            <input 
              type="text" 
              value={search} 
              onChange={e => setSearch(e.target.value)}
              placeholder="Search items or vendor..." 
              className={styles.searchInput} 
            />
          </div>
          <button 
            className={`${styles.btnVariance} ${showVariance ? styles.btnVarianceActive : ''}`}
            onClick={() => setShowVariance(v => !v)}
          >
            {showVariance ? <TrendingDown size={13} /> : <TrendingUp size={13} />}
            Variance
          </button>
        </div>

        {/* Loading State */}
        {loading && <div className={styles.loading}>Loading inventory...</div>}

        {/* Error State */}
        {error && (
          <div className={styles.error}>
            {error}
            <button onClick={handleRefresh} style={{ marginLeft: 12 }}>Retry</button>
          </div>
        )}

        {/* Empty Items State */}
        {!loading && !error && items.length === 0 && (
          <div className={styles.emptyItems}>
            <p>No inventory items found for this location.</p>
            <p style={{ fontSize: 12, color: '#888', marginTop: 4 }}>
              Items may need to be seeded or assigned to this location.
            </p>
          </div>
        )}

        {/* Category Sections */}
        {!loading && displayGroups.map(cat => (
          <div key={cat.key} className={styles.section}>
            <div 
              className={styles.catHeader} 
              style={{ background: cat.bg, borderBottomColor: cat.color + '40', cursor: 'pointer' }}
              onClick={() => toggleCollapse(cat.key)}
            >
              <div className={styles.catTitle} style={{ color: cat.color }}>
                {cat.label}
                <span className={styles.catCount} style={{ background: cat.color }}>{cat.items.length}</span>
                <span className={styles.catCounted}>
                  {cat.items.filter(i => i.qty != null && i.qty > 0).length} counted
                </span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <div className={styles.catTotal} style={{ color: cat.color }}>
                  {fmt$(cat.items.reduce((s, i) => s + (i._value || 0), 0))}
                </div>
                <span style={{ color: cat.color, fontSize: 11 }}>
                  {collapsed[cat.key] ? '▶' : '▼'}
                </span>
              </div>
            </div>

            {!collapsed[cat.key] && (
              <table className={styles.table}>
                <thead>
                  <tr className={styles.thead}>
                    {!isMobile && <th className={styles.thNum}>#</th>}
                    <th className={styles.th}>Item</th>
                    {!isMobile && <th className={styles.thCenter}>Pack</th>}
                    {!isMobile && <th className={styles.thRight}>Unit Cost</th>}
                    {!isMobile && !blindMode && showVariance && <th className={styles.thCenter}>Prior</th>}
                    <th className={styles.thCenter} style={{ width: isMobile ? 120 : 160 }}>Count</th>
                    {!isMobile && showVariance && !blindMode && <th className={styles.thCenter}>△ Variance</th>}
                    {!isMobile && <th className={styles.thRight}>Value</th>}
                  </tr>
                </thead>
                <tbody>
                  {cat.items.map((item, idx) => {
                    const isCounted = item.qty != null && item.qty > 0
                    const varDir = (item._variance || 0) > 0 ? 'up' : (item._variance || 0) < 0 ? 'down' : 'neutral'

                    return (
                      <tr
                        key={item.id}
                        className={`${styles.row} ${idx % 2 === 0 ? '' : styles.rowAlt}`}
                        onClick={(e) => {
                          // Don't open the panel if the click was inside an input,
                          // button, or any interactive control
                          const t = e.target
                          if (t.tagName === 'INPUT' || t.tagName === 'BUTTON' || t.closest('button') || t.closest('input')) return
                          setWhyItem(item)
                        }}
                        style={{ cursor: 'pointer' }}>
                        <td className={styles.tdNum}>{idx + 1}</td>
                        <td className={styles.tdName}>
                          <div className={styles.nameRow}>
                            <button
                              onClick={() => toggleKey(item.id)}
                              title={item.isKey ? 'Unmark as key item' : 'Mark as key item (shows in Quick count mode)'}
                              style={{
                                background: 'none',
                                border: 'none',
                                cursor: 'pointer',
                                padding: 0,
                                marginRight: 4,
                                fontSize: 13,
                                lineHeight: 1,
                                color: item.isKey ? '#f59e0b' : '#cbd5e1',
                                transition: 'color 0.15s, transform 0.1s',
                              }}
                              onMouseEnter={e => { e.currentTarget.style.transform = 'scale(1.2)' }}
                              onMouseLeave={e => { e.currentTarget.style.transform = 'scale(1)' }}
                            >
                              {item.isKey ? '★' : '☆'}
                            </button>
                            <button
                              onClick={() => {
                                if (window.confirm(`Remove "${item.name}" from this location's count sheet? You can restore it from Manage Items.`)) {
                                  removeItem(item.id)
                                }
                              }}
                              title="Remove from this location"
                              style={{
                                background: 'none',
                                border: 'none',
                                cursor: 'pointer',
                                padding: '0 4px',
                                marginRight: 4,
                                fontSize: 11,
                                lineHeight: 1,
                                color: '#cbd5e1',
                                transition: 'color 0.15s',
                              }}
                              onMouseEnter={e => { e.currentTarget.style.color = '#dc2626' }}
                              onMouseLeave={e => { e.currentTarget.style.color = '#cbd5e1' }}
                            >
                              ×
                            </button>
                            <div 
                              className={`${styles.heatDot} ${isCounted ? styles['heat_' + (item._varClass || 'neutral')] : styles.heat_empty}`} 
                              title={isCounted 
                                ? `${item._varClass === 'good' ? 'Within 10%' : item._varClass === 'warn' ? '10-25% variance' : '>25% variance'}` 
                                : 'Not counted'
                              } 
                            />
                            <div>
                              <div className={styles.name}>
                                {item.name}
                                {item._belowPar && <span className={styles.parFlag}>↓ Par</span>}
                              </div>
                              {item.vendor && <div className={styles.vendor}>{item.vendor}</div>}
                            </div>
                          </div>
                        </td>
                        {!isMobile && <td className={styles.tdCenter}>
                          {item.packSize && <span className={styles.badge}>{item.packSize}</span>}
                        </td>}
                        {!isMobile && <td className={styles.tdRight}>${(item.unitCost || 0).toFixed(2)}</td>}
                        {!isMobile && !blindMode && showVariance && (
                          <td className={styles.tdCenter} style={{ color: '#bbb', fontSize: 12 }}>
                            {(item._priorQty || 0) > 0 ? item._priorQty : '—'}
                          </td>
                        )}
                        <td className={styles.tdCount}>
                          <div className={styles.countRow}>
                            <button className={styles.adjBtn} onClick={() => adjust(item.id, -1)}>−</button>
                            <input 
                              type="number" 
                              min="0" 
                              step="0.5"
                              value={item.qty ?? ''}
                              onChange={e => setQty(item.id, e.target.value)}
                              onDoubleClick={() => !blindMode && copyPrior(item.id)}
                              className={`${styles.countInput} ${isCounted ? styles['counted_' + (item._varClass || 'neutral')] : ''}`}
                              placeholder={blindMode ? '0' : (item._priorQty || 0) > 0 ? String(item._priorQty) : '0'}
                              title="Double-click to copy prior count"
                            />
                            <button className={styles.adjBtn} onClick={() => adjust(item.id, 1)}>+</button>
                          </div>
                        </td>
                        {!isMobile && showVariance && !blindMode && (
                          <td className={styles.tdCenter}>
                            {isCounted && (item._priorQty || 0) > 0 ? (
                              <span className={`${styles.varBadge} ${styles['var_' + varDir]}`}>
                                {varDir === 'up' ? <TrendingUp size={10} /> : varDir === 'down' ? <TrendingDown size={10} /> : <Minus size={10} />}
                                {(item._variance || 0) > 0 ? '+' : ''}{(item._variance || 0).toFixed(1)}
                              </span>
                            ) : <span style={{ color: '#ddd' }}>—</span>}
                          </td>
                        )}
                        {!isMobile && <td className={styles.tdRight} style={{ fontWeight: 700, color: (item._value || 0) > 0 ? '#059669' : '#bbb' }}>
                          {(item._value || 0) > 0 ? fmt$(item._value) : '—'}
                        </td>}
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            )}
          </div>
        ))}

        {/* Sticky COGS Footer */}
        {dirty && (
          <div className={styles.cogsFooter}>
            <div className={styles.cogsFooterLeft}>
              <span className={styles.cogsLabel}>Live COGS</span>
              <span className={styles.cogsValue}>{fmt$(totals.liveCOGS)}</span>
              <span className={styles.cogsBreakdown}>
                {fmt$(totals.openingValue)} opening + {fmt$(totals.purchases)} purchases − {fmt$(totals.closingValue)} closing
              </span>
            </div>
            <button className={styles.btnSaveFooter} onClick={handleSave} disabled={saving}>
              {saving ? 'Saving...' : 'Save & Close Period'}
            </button>
          </div>
        )}

        {/* ── Why panel — item-level explanation drawer ── */}
        {whyItem && (() => {
          // Build the narrative inline. The data is already in the item — we
          // just package it into a friendly story. No Firestore reads needed.
          const item = whyItem
          const cur = item.qty
          const prior = item._priorQty || 0
          const variance = item._variance || 0
          const varClass = item._varClass || 'neutral'
          const value = item._value || 0
          const lastCounted = formatLastCounted(item.lastCountedAt)

          // Headline
          let headline
          if (cur == null) {
            headline = `${item.name} hasn't been counted yet for this period.`
          } else if (prior === 0) {
            headline = `${item.name} is at ${cur} this period (no prior count to compare against).`
          } else if (Math.abs(variance) < 0.5) {
            headline = `${item.name} is essentially flat: ${cur} this period vs ${prior} prior.`
          } else {
            const dir = variance > 0 ? 'up' : 'down'
            const pct = Math.round(Math.abs(variance) / prior * 100)
            headline = `${item.name} is ${dir} ${Math.abs(variance).toFixed(1)} units (${pct}%) vs prior period — ${cur} now, ${prior} then.`
          }

          // Bullets — what we actually know about this item
          const bullets = []
          if (varClass === 'alert') {
            bullets.push({ sign: 'up', text: `Variance >25% — flagged for investigation` })
          } else if (varClass === 'warn') {
            bullets.push({ sign: 'up', text: `Variance 10-25% — worth a second look` })
          }
          if (item._daysOnHand != null) {
            const dohColor = item._daysOnHand < 3 ? 'up' : item._daysOnHand < 7 ? 'neutral' : 'down'
            bullets.push({ sign: dohColor, text: `${item._daysOnHand} days on hand at current usage` })
          }
          if (item._belowPar) {
            bullets.push({ sign: 'up', text: `Below par level (${item.parLevel || 'N/A'}) — reorder needed` })
          } else if (item._atReorder) {
            bullets.push({ sign: 'up', text: `At reorder point (${item.reorderPoint || 'N/A'})` })
          }
          if (lastCounted) {
            const tone = lastCounted.tone === 'fresh' ? 'down' : lastCounted.tone === 'warn' ? 'neutral' : 'up'
            bullets.push({ sign: tone, text: `Last counted ${lastCounted.label}${lastCounted.tone === 'stale' ? ' — count may be unreliable' : ''}` })
          }
          if (item.vendor) {
            bullets.push({ sign: 'neutral', text: `Sourced from ${item.vendor}` })
          }

          // Factors — the supporting numbers
          const factors = [
            { label: 'Current count', detail: `${cur ?? '—'} units`, value: '$' + (value || 0).toFixed(2), sign: cur != null ? 'down' : 'neutral' },
            { label: 'Prior count', detail: `${prior} units`, value: prior > 0 ? '$' + (prior * (item.unitCost || 0)).toFixed(2) : '—', sign: 'neutral' },
            { label: 'Unit cost', detail: 'from last invoice', value: '$' + (item.unitCost || 0).toFixed(2), sign: 'neutral' },
          ]
          if (item.parLevel) {
            factors.push({ label: 'Par level', detail: 'target on hand', value: String(item.parLevel), sign: 'neutral' })
          }
          if (item._daysOnHand != null && item.avgDailyUsage) {
            factors.push({ label: 'Avg daily usage', detail: 'rolling estimate', value: item.avgDailyUsage.toFixed(1) + ' /day', sign: 'neutral' })
          }

          const signColor = (s) => s === 'up' ? '#dc2626' : s === 'down' ? '#059669' : '#94a3b8'

          return (
            <>
              <div
                onClick={() => setWhyItem(null)}
                style={{
                  position: 'fixed', inset: 0,
                  background: 'rgba(15, 23, 42, 0.3)',
                  zIndex: 2900,
                }}
              />
              <aside style={{
                position: 'fixed', top: 0, right: 0, bottom: 0,
                width: 480, maxWidth: '90vw',
                background: '#fff',
                borderLeft: '0.5px solid #e5e7eb',
                boxShadow: '-20px 0 60px rgba(15, 23, 42, 0.1)',
                zIndex: 3000,
                display: 'flex', flexDirection: 'column',
              }}>
                {/* Header */}
                <div style={{
                  padding: '20px 24px 16px',
                  borderBottom: '0.5px solid #e5e7eb',
                  display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between',
                }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 11, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 500, marginBottom: 4 }}>
                      Why
                    </div>
                    <div style={{ fontSize: 18, color: '#0f172a', fontWeight: 500, lineHeight: 1.3 }}>
                      {item.name}
                    </div>
                    <div style={{ fontSize: 22, color: '#0f172a', fontWeight: 500, marginTop: 6, letterSpacing: '-0.01em' }}>
                      {value > 0 ? '$' + value.toFixed(2) : '—'}
                    </div>
                    {item.vendor && (
                      <div style={{ fontSize: 12, color: '#64748b', marginTop: 2 }}>{item.vendor}</div>
                    )}
                  </div>
                  <button
                    onClick={() => setWhyItem(null)}
                    style={{
                      background: 'none', border: 'none', cursor: 'pointer',
                      fontSize: 22, color: '#94a3b8', padding: 0, lineHeight: 1, marginLeft: 12,
                    }}
                  >
                    ×
                  </button>
                </div>

                {/* Body */}
                <div style={{ flex: 1, overflowY: 'auto', padding: '20px 24px' }}>
                  {/* Headline narrative */}
                  <div style={{ fontSize: 14, color: '#0f172a', lineHeight: 1.55, marginBottom: 18 }}>
                    {headline}
                  </div>

                  {/* Bullets */}
                  {bullets.length > 0 && (
                    <div style={{ marginBottom: 22 }}>
                      <div style={{ fontSize: 11, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 500, marginBottom: 10 }}>
                        Key signals
                      </div>
                      {bullets.map((b, i) => (
                        <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 6, fontSize: 13, color: '#475569', lineHeight: 1.5 }}>
                          <span style={{ color: signColor(b.sign), fontWeight: 600, marginTop: 1, fontSize: 11 }}>
                            {b.sign === 'up' ? '▲' : b.sign === 'down' ? '▼' : '•'}
                          </span>
                          <span>{b.text}</span>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Factors */}
                  <div>
                    <div style={{ fontSize: 11, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 500, marginBottom: 10 }}>
                      Details
                    </div>
                    <div>
                      {factors.map((f, i) => (
                        <div key={i} style={{
                          display: 'flex', alignItems: 'baseline', justifyContent: 'space-between',
                          padding: '8px 0',
                          borderBottom: i < factors.length - 1 ? '0.5px solid #f1f5f9' : 'none',
                          fontSize: 13,
                        }}>
                          <div>
                            <div style={{ color: '#475569', fontWeight: 500 }}>{f.label}</div>
                            {f.detail && <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 1 }}>{f.detail}</div>}
                          </div>
                          <div style={{ color: '#0f172a', fontWeight: 500, fontVariantNumeric: 'tabular-nums' }}>
                            {f.value}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </aside>
            </>
          )
        })()}

        {/* ── Manage items drawer ── */}
        {showManage && (
          <>
            <div
              onClick={() => setShowManage(false)}
              style={{
                position: 'fixed', inset: 0,
                background: 'rgba(15, 23, 42, 0.3)',
                zIndex: 2900,
              }}
            />
            <aside style={{
              position: 'fixed', top: 0, right: 0, bottom: 0,
              width: 480, maxWidth: '90vw',
              background: '#fff',
              borderLeft: '0.5px solid #e5e7eb',
              boxShadow: '-20px 0 60px rgba(15, 23, 42, 0.1)',
              zIndex: 3000,
              display: 'flex', flexDirection: 'column',
            }}>
              {/* Drawer header */}
              <div style={{
                padding: '20px 24px 16px',
                borderBottom: '0.5px solid #e5e7eb',
                display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between',
              }}>
                <div>
                  <div style={{ fontSize: 11, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 500, marginBottom: 4 }}>
                    Manage items
                  </div>
                  <div style={{ fontSize: 16, color: '#0f172a', fontWeight: 500 }}>
                    {cleanLocName(location)}
                  </div>
                  <div style={{ fontSize: 12, color: '#64748b', marginTop: 2 }}>
                    Customize what shows on this unit's count sheet
                  </div>
                </div>
                <button
                  onClick={() => setShowManage(false)}
                  style={{
                    background: 'none', border: 'none', cursor: 'pointer',
                    fontSize: 22, color: '#94a3b8', padding: 0, lineHeight: 1,
                  }}
                >
                  ×
                </button>
              </div>

              {/* Drawer body — scrollable */}
              <div style={{ flex: 1, overflowY: 'auto', padding: '20px 24px' }}>
                {/* Section 1: Add custom item */}
                <div style={{ marginBottom: 28 }}>
                  <div style={{ fontSize: 11, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 500, marginBottom: 10 }}>
                    Add a custom item
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 8 }}>
                    <input
                      type="text"
                      placeholder="Item name *"
                      value={customDraft.name}
                      onChange={e => setCustomDraft(d => ({ ...d, name: e.target.value }))}
                      style={{ gridColumn: '1 / -1', padding: '8px 10px', fontSize: 13, border: '0.5px solid #e2e8f0', borderRadius: 6, fontFamily: 'inherit' }}
                    />
                    <input
                      type="text"
                      placeholder="Vendor"
                      value={customDraft.vendor}
                      onChange={e => setCustomDraft(d => ({ ...d, vendor: e.target.value }))}
                      style={{ padding: '8px 10px', fontSize: 13, border: '0.5px solid #e2e8f0', borderRadius: 6, fontFamily: 'inherit' }}
                    />
                    <input
                      type="text"
                      placeholder="Pack size"
                      value={customDraft.packSize}
                      onChange={e => setCustomDraft(d => ({ ...d, packSize: e.target.value }))}
                      style={{ padding: '8px 10px', fontSize: 13, border: '0.5px solid #e2e8f0', borderRadius: 6, fontFamily: 'inherit' }}
                    />
                    <input
                      type="number"
                      step="0.01"
                      placeholder="Unit cost ($)"
                      value={customDraft.unitCost}
                      onChange={e => setCustomDraft(d => ({ ...d, unitCost: e.target.value }))}
                      style={{ gridColumn: '1 / -1', padding: '8px 10px', fontSize: 13, border: '0.5px solid #e2e8f0', borderRadius: 6, fontFamily: 'inherit' }}
                    />
                  </div>
                  <button
                    onClick={async () => {
                      if (!customDraft.name) return
                      await addCustomItem(customDraft)
                      setCustomDraft({ name: '', vendor: '', unitCost: '', packSize: '' })
                    }}
                    disabled={!customDraft.name}
                    style={{
                      padding: '8px 16px', fontSize: 13, fontWeight: 500,
                      background: customDraft.name ? '#0f172a' : '#e2e8f0',
                      color: customDraft.name ? '#fff' : '#94a3b8',
                      border: 'none', borderRadius: 6,
                      cursor: customDraft.name ? 'pointer' : 'not-allowed',
                      fontFamily: 'inherit',
                    }}
                  >
                    + Add to this location
                  </button>
                </div>

                {/* Section 2: Currently active items — searchable */}
                <div style={{ marginBottom: 28 }}>
                  <div style={{ fontSize: 11, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 500, marginBottom: 10 }}>
                    Active at this location ({items.length})
                  </div>
                  <div style={{ position: 'relative', marginBottom: 10 }}>
                    <input
                      type="text"
                      value={manageSearch}
                      onChange={e => setManageSearch(e.target.value)}
                      placeholder="Search items to remove..."
                      style={{
                        width: '100%',
                        padding: '8px 10px 8px 32px',
                        fontSize: 13,
                        border: '0.5px solid #e2e8f0',
                        borderRadius: 6,
                        fontFamily: 'inherit',
                      }}
                    />
                    <Search size={13} style={{
                      position: 'absolute',
                      left: 10, top: '50%',
                      transform: 'translateY(-50%)',
                      color: '#94a3b8',
                      pointerEvents: 'none',
                    }} />
                  </div>
                  {(() => {
                    const ms = manageSearch.trim().toLowerCase()
                    const filtered = ms
                      ? items.filter(i =>
                          (i.name || '').toLowerCase().includes(ms) ||
                          (i.vendor || '').toLowerCase().includes(ms)
                        )
                      : items
                    if (!ms) {
                      return (
                        <div style={{ fontSize: 11, color: '#94a3b8', fontStyle: 'italic', padding: '8px 0' }}>
                          Start typing to find items to remove from this location.
                        </div>
                      )
                    }
                    if (filtered.length === 0) {
                      return (
                        <div style={{ fontSize: 12, color: '#cbd5e1', padding: '12px 0', fontStyle: 'italic' }}>
                          No matches.
                        </div>
                      )
                    }
                    return (
                      <div style={{ maxHeight: 280, overflowY: 'auto', border: '0.5px solid #f1f5f9', borderRadius: 6 }}>
                        {filtered.slice(0, 50).map(it => (
                          <div key={it.id} style={{
                            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                            padding: '8px 10px',
                            borderBottom: '0.5px solid #f1f5f9',
                            fontSize: 13,
                          }}>
                            <div style={{ minWidth: 0, flex: 1, marginRight: 8 }}>
                              <div style={{
                                color: '#475569', fontWeight: 500,
                                whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                              }}>
                                {it.name}
                                {it.custom && <span style={{ fontSize: 9, marginLeft: 6, padding: '1px 5px', background: '#f1f5f9', color: '#64748b', borderRadius: 3, textTransform: 'uppercase', letterSpacing: '0.04em' }}>custom</span>}
                                {it.isKey && <span style={{ fontSize: 11, marginLeft: 4, color: '#f59e0b' }}>★</span>}
                              </div>
                              {it.vendor && <div style={{ color: '#94a3b8', fontSize: 11, marginTop: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{it.vendor}</div>}
                            </div>
                            <button
                              onClick={async () => {
                                if (window.confirm(`Remove "${it.name}" from ${cleanLocName(location)}'s count sheet?`)) {
                                  await removeItem(it.id)
                                  await loadRemovedItems()
                                }
                              }}
                              style={{
                                padding: '4px 10px', fontSize: 11, fontWeight: 500,
                                background: '#fff', border: '0.5px solid #fecaca', borderRadius: 4,
                                color: '#dc2626', cursor: 'pointer', fontFamily: 'inherit',
                                flexShrink: 0,
                              }}
                            >
                              Remove
                            </button>
                          </div>
                        ))}
                        {filtered.length > 50 && (
                          <div style={{ padding: '8px 10px', fontSize: 11, color: '#94a3b8', textAlign: 'center', fontStyle: 'italic' }}>
                            Showing first 50 of {filtered.length} matches — refine search to narrow.
                          </div>
                        )}
                      </div>
                    )
                  })()}
                </div>

                {/* Section 3: Removed items */}
                <div>
                  <div style={{ fontSize: 11, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 500, marginBottom: 10 }}>
                    Removed from this location ({removedItems.length})
                  </div>
                  {removedItems.length === 0 ? (
                    <div style={{ fontSize: 12, color: '#cbd5e1', padding: '12px 0', fontStyle: 'italic' }}>
                      No removed items.
                    </div>
                  ) : (
                    <div>
                      {removedItems.map(ri => (
                        <div key={ri.id} style={{
                          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                          padding: '8px 10px',
                          borderBottom: '0.5px solid #f1f5f9',
                          fontSize: 13,
                        }}>
                          <div>
                            <div style={{ color: '#475569', fontWeight: 500 }}>
                              {ri.name}
                              {ri.custom && <span style={{ fontSize: 9, marginLeft: 6, padding: '1px 5px', background: '#f1f5f9', color: '#64748b', borderRadius: 3, textTransform: 'uppercase', letterSpacing: '0.04em' }}>custom</span>}
                            </div>
                            {ri.vendor && <div style={{ color: '#94a3b8', fontSize: 11, marginTop: 1 }}>{ri.vendor}</div>}
                          </div>
                          <button
                            onClick={async () => {
                              await restoreItem(ri.id)
                              await loadRemovedItems()
                            }}
                            style={{
                              padding: '4px 10px', fontSize: 11, fontWeight: 500,
                              background: '#fff', border: '0.5px solid #cbd5e1', borderRadius: 4,
                              color: '#475569', cursor: 'pointer', fontFamily: 'inherit',
                            }}
                          >
                            Restore
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </aside>
          </>
        )}

        {/* ── Buddy mode setup modal ── */}
        {showBuddySetup && (
          <>
            <div
              onClick={() => setShowBuddySetup(false)}
              style={{
                position: 'fixed', inset: 0,
                background: 'rgba(15, 23, 42, 0.4)',
                zIndex: 3500,
              }}
            />
            <div style={{
              position: 'fixed',
              top: '50%', left: '50%',
              transform: 'translate(-50%, -50%)',
              width: 420, maxWidth: '90vw',
              background: '#fff',
              borderRadius: 12,
              boxShadow: '0 25px 80px rgba(15, 23, 42, 0.25)',
              zIndex: 3600,
              padding: '24px 28px',
            }}>
              <div style={{ fontSize: 11, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 500, marginBottom: 4 }}>
                Buddy mode
              </div>
              <div style={{ fontSize: 18, fontWeight: 500, color: '#0f172a', marginBottom: 4 }}>
                Start a team count
              </div>
              <div style={{ fontSize: 12, color: '#64748b', lineHeight: 1.5, marginBottom: 18 }}>
                One person calls counts, the other marks them on the device. Both names get attributed to every count taken in this session.
              </div>

              <div style={{ marginBottom: 12 }}>
                <label style={{ fontSize: 11, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.04em', fontWeight: 500, display: 'block', marginBottom: 4 }}>
                  Caller (walks the cooler)
                </label>
                <input
                  type="text"
                  value={buddyDraft.caller}
                  onChange={e => setBuddyDraft(d => ({ ...d, caller: e.target.value }))}
                  placeholder="Name or initials"
                  autoFocus
                  style={{
                    width: '100%', padding: '10px 12px', fontSize: 14,
                    border: '0.5px solid #e2e8f0', borderRadius: 6,
                    fontFamily: 'inherit',
                  }}
                />
              </div>
              <div style={{ marginBottom: 22 }}>
                <label style={{ fontSize: 11, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.04em', fontWeight: 500, display: 'block', marginBottom: 4 }}>
                  Marker (enters on device)
                </label>
                <input
                  type="text"
                  value={buddyDraft.marker}
                  onChange={e => setBuddyDraft(d => ({ ...d, marker: e.target.value }))}
                  placeholder="Name or initials"
                  style={{
                    width: '100%', padding: '10px 12px', fontSize: 14,
                    border: '0.5px solid #e2e8f0', borderRadius: 6,
                    fontFamily: 'inherit',
                  }}
                />
              </div>

              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                <button
                  onClick={() => setShowBuddySetup(false)}
                  style={{
                    padding: '9px 18px', fontSize: 13, fontWeight: 500,
                    background: '#fff', color: '#64748b',
                    border: '0.5px solid #e2e8f0', borderRadius: 6,
                    cursor: 'pointer', fontFamily: 'inherit',
                  }}
                >
                  Cancel
                </button>
                <button
                  onClick={() => {
                    if (!buddyDraft.caller || !buddyDraft.marker) return
                    setBuddyNames(buddyDraft)
                    setBuddyMode(true)
                    setShowBuddySetup(false)
                    toast.success(`Buddy mode active — ${buddyDraft.caller} + ${buddyDraft.marker}`)
                  }}
                  disabled={!buddyDraft.caller || !buddyDraft.marker}
                  style={{
                    padding: '9px 18px', fontSize: 13, fontWeight: 500,
                    background: (buddyDraft.caller && buddyDraft.marker) ? '#0f172a' : '#e2e8f0',
                    color: (buddyDraft.caller && buddyDraft.marker) ? '#fff' : '#94a3b8',
                    border: 'none', borderRadius: 6,
                    cursor: (buddyDraft.caller && buddyDraft.marker) ? 'pointer' : 'not-allowed',
                    fontFamily: 'inherit',
                  }}
                >
                  Start counting
                </button>
              </div>
            </div>
          </>
        )}

        {/* ── Persistent buddy banner ── */}
        {buddyMode && (
          <div style={{
            position: 'fixed',
            bottom: 24, left: '50%',
            transform: 'translateX(-50%)',
            background: '#0f172a',
            color: '#fff',
            padding: '10px 18px',
            borderRadius: 999,
            fontSize: 12,
            fontWeight: 500,
            boxShadow: '0 8px 24px rgba(15, 23, 42, 0.25)',
            display: 'flex', alignItems: 'center', gap: 12,
            zIndex: 2500,
          }}>
            <span style={{ fontSize: 14 }}>👥</span>
            <span>
              <span style={{ color: '#94a3b8', fontWeight: 400 }}>Team count: </span>
              <span style={{ color: '#fff' }}>{buddyNames.caller}</span>
              <span style={{ color: '#475569', margin: '0 6px' }}>calls</span>
              <span style={{ color: '#fff' }}>{buddyNames.marker}</span>
              <span style={{ color: '#475569', margin: '0 6px' }}>marks</span>
            </span>
            <button
              onClick={() => {
                setBuddyMode(false)
                setBuddyNames({ caller: '', marker: '' })
                toast.info('Buddy mode ended')
              }}
              style={{
                background: 'transparent', border: '0.5px solid #475569',
                color: '#cbd5e1', padding: '3px 10px', borderRadius: 999,
                fontSize: 10, fontWeight: 500, cursor: 'pointer',
                fontFamily: 'inherit', marginLeft: 4,
              }}
            >
              END
            </button>
          </div>
        )}
      </div>
    </div>
  )
}