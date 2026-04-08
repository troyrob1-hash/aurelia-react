import { useState, useMemo, useCallback } from 'react'
import { useAuthStore } from '@/store/authStore'
import { useLocations, cleanLocName } from '@/store/LocationContext'
import { usePeriod } from '@/store/PeriodContext'
import { useInventory, fmt$, sanitizeDocId } from '@/hooks/useInventory'
import { getTopVarianceIssues, calcParStatus } from '@/lib/variance'
import { Search, Download, RefreshCw, Eye, EyeOff, TrendingUp, TrendingDown, Minus, Mic, AlertTriangle } from 'lucide-react'
import { useToast } from '@/components/ui/Toast'
import styles from './Inventory.module.css'

// ═══════════════════════════════════════════════════════════════════════════
// Inventory Component - Aurelia FMS
// ═══════════════════════════════════════════════════════════════════════════

export default function Inventory() {
  const toast = useToast()
  const { user } = useAuthStore()
  const orgId = user?.tenantId || 'fooda'
  const { selectedLocation } = useLocations()
  const { periodKey } = usePeriod()

  // ─── Local UI State ────────────────────────────────────────────────────────
  const [search, setSearch] = useState('')
  const [activeCat, setActiveCat] = useState('all')
  const [collapsed, setCollapsed] = useState({})
  const [blindMode, setBlindMode] = useState(false)
  const [showVariance, setShowVariance] = useState(true)
  const [showParPanel, setShowParPanel] = useState(false)

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
    markSectionComplete,
    save
  } = useInventory(orgId, location, periodKey, user)

  // ─── Handlers ──────────────────────────────────────────────────────────────
  const handleSave = useCallback(async () => {
    const success = await save()
    if (success) {
      toast.success('Inventory saved & COGS posted to P&L')
    } else {
      toast.error('Save failed. Please try again.')
    }
  }, [save, toast])

  const toggleCollapse = useCallback((key) => {
    setCollapsed(prev => ({ ...prev, [key]: !prev[key] }))
  }, [])

  const handleExport = useCallback(async () => {
    try {
      const XLSX = await import('xlsx')
      const wb = XLSX.utils.book_new()

      // Summary sheet
      const summaryRows = [
        ['Aurelia FMS — Inventory Count Report'],
        ['Location:', cleanLocName(location)],
        ['Period:', periodKey],
        ['Date:', new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })],
        [],
        ['COGS CALCULATION'],
        ['Opening Inventory', totals.openingValue.toFixed(2)],
        ['+ Purchases', totals.purchases.toFixed(2)],
        ['- Closing Inventory', totals.closingValue.toFixed(2)],
        ['= COGS (Inventory Usage)', totals.liveCOGS.toFixed(2)],
        [],
        ['SUMMARY'],
        ['Total Items', items.length],
        ['Items Counted', totals.counted],
        ['Inventory Value', totals.closingValue.toFixed(2)],
        ['Progress', totals.progress + '%'],
      ]
      const wsSummary = XLSX.utils.aoa_to_sheet(summaryRows)
      XLSX.utils.book_append_sheet(wb, wsSummary, 'Summary')

      // Detail sheet
      const header = ['#', 'Item', 'Vendor', 'Category', 'Pack Size', 'Unit Cost', 'Count', 'Prior Count', 'Variance', 'Total Value', 'Par Level', 'Days On Hand']
      const detailRows = items.map((item, idx) => [
        idx + 1, item.name, item.vendor || '',
        categories.find(c => c.key === item._cat)?.label || 'General',
        item.packSize || '', item.unitCost || 0, item.qty || 0,
        item._priorQty || 0, item._variance || 0, 
        +((item.qty || 0) * (item.unitCost || 0)).toFixed(2),
        item.parLevel || '', item._daysOnHand || ''
      ])
      const wsDetail = XLSX.utils.aoa_to_sheet([header, ...detailRows])
      wsDetail['!cols'] = [{ wch: 4 }, { wch: 40 }, { wch: 15 }, { wch: 18 }, { wch: 10 }, { wch: 10 }, { wch: 8 }, { wch: 10 }, { wch: 10 }, { wch: 12 }, { wch: 10 }, { wch: 12 }]
      XLSX.utils.book_append_sheet(wb, wsDetail, 'All Items')

      XLSX.writeFile(wb, `inventory-${sanitizeDocId(location)}-${periodKey}.xlsx`)
      toast.success('Exported to Excel')
    } catch (err) {
      console.error('Export failed:', err)
      toast.error('Export failed.')
    }
  }, [items, categories, totals, location, periodKey, toast])

  // ─── Filtered Items ────────────────────────────────────────────────────────
  const q = search.toLowerCase()
  const displayItems = useMemo(() => items.filter(i => {
    const matchCat = activeCat === 'all' || i._cat === activeCat
    const matchSearch = !q || i.name?.toLowerCase().includes(q) || i.vendor?.toLowerCase().includes(q)
    return matchCat && matchSearch
  }), [items, activeCat, q])

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
      <div className={styles.empty}>
        <div className={styles.emptyIcon}>📦</div>
        <p className={styles.emptyTitle}>Select a location to begin counting</p>
        <p className={styles.emptySub}>Choose a location from the dropdown above</p>
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
          <span className={styles.chipBadge}>{totals.counted}/{totals.total}</span>
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
            <h1 className={styles.title}>{cleanLocName(location)}</h1>
            <p className={styles.subtitle}>
              Inventory Count · {periodKey}
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
              className={`${styles.btnMode} ${showParPanel ? styles.btnModeActive : ''}`} 
              onClick={() => setShowParPanel(v => !v)} 
              title="Par levels"
            >
              <AlertTriangle size={14} />
              Par ({totals.belowPar})
            </button>
            {dirty && (
              <button className={styles.btnSave} onClick={handleSave} disabled={saving}>
                {saving ? 'Saving...' : 'Save & Post to P&L'}
              </button>
            )}
            <button className={styles.btnIcon} onClick={handleExport} title="Export Excel">
              <Download size={15} />
            </button>
            <button className={styles.btnIcon} onClick={load} title="Refresh">
              <RefreshCw size={15} />
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
              {totals.counted} <span className={styles.kpiOf}>of {totals.total}</span>
            </div>
            <div className={styles.progressWrap}>
              <div className={styles.progressBar}>
                <div className={styles.progressFill} style={{ width: totals.progress + '%' }} />
              </div>
              <span className={styles.kpiPct}>{totals.progress}%</span>
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
        {showParPanel && itemsBelowPar.length > 0 && (
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
                        {par.daysOnHand && (
                          <span className={`${styles.parDays} ${par.status === 'critical' ? styles.parDaysCrit : ''}`}>
                            {par.daysOnHand} days
                          </span>
                        )}
                      </div>
                    </div>
                    <div className={styles.parBar}>
                      <div 
                        className={`${styles.parFill} ${styles['parFill_' + par.status]}`}
                        style={{ width: par.fillPct + '%' }}
                      />
                      <div 
                        className={styles.parReorderMark}
                        style={{ left: par.reorderPct + '%' }}
                      />
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {/* Toolbar */}
        <div className={styles.toolbar}>
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
        {error && <div className={styles.error}>{error}</div>}

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
                  {fmt$(cat.items.reduce((s, i) => s + i._value, 0))}
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
                    <th className={styles.thNum}>#</th>
                    <th className={styles.th}>Item</th>
                    <th className={styles.thCenter}>Pack</th>
                    <th className={styles.thRight}>Unit Cost</th>
                    {!blindMode && showVariance && <th className={styles.thCenter}>Prior</th>}
                    <th className={styles.thCenter} style={{ width: 160 }}>Count</th>
                    {showVariance && !blindMode && <th className={styles.thCenter}>△ Variance</th>}
                    <th className={styles.thRight}>Value</th>
                  </tr>
                </thead>
                <tbody>
                  {cat.items.map((item, idx) => {
                    const isCounted = item.qty != null && item.qty > 0
                    const varDir = item._variance > 0 ? 'up' : item._variance < 0 ? 'down' : 'neutral'

                    return (
                      <tr key={item.id} className={`${styles.row} ${idx % 2 === 0 ? '' : styles.rowAlt}`}>
                        <td className={styles.tdNum}>{idx + 1}</td>
                        <td className={styles.tdName}>
                          <div className={styles.nameRow}>
                            <div 
                              className={`${styles.heatDot} ${isCounted ? styles['heat_' + item._varClass] : styles.heat_empty}`} 
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
                        <td className={styles.tdCenter}>
                          {item.packSize && <span className={styles.badge}>{item.packSize}</span>}
                        </td>
                        <td className={styles.tdRight}>${(item.unitCost || 0).toFixed(2)}</td>
                        {!blindMode && showVariance && (
                          <td className={styles.tdCenter} style={{ color: '#bbb', fontSize: 12 }}>
                            {item._priorQty > 0 ? item._priorQty : '—'}
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
                              className={`${styles.countInput} ${isCounted ? styles['counted_' + item._varClass] : ''}`}
                              placeholder={blindMode ? '0' : item._priorQty > 0 ? String(item._priorQty) : '0'}
                              title="Double-click to copy prior count"
                            />
                            <button className={styles.adjBtn} onClick={() => adjust(item.id, 1)}>+</button>
                          </div>
                        </td>
                        {showVariance && !blindMode && (
                          <td className={styles.tdCenter}>
                            {isCounted && item._priorQty > 0 ? (
                              <span className={`${styles.varBadge} ${styles['var_' + varDir]}`}>
                                {varDir === 'up' ? <TrendingUp size={10} /> : varDir === 'down' ? <TrendingDown size={10} /> : <Minus size={10} />}
                                {item._variance > 0 ? '+' : ''}{item._variance.toFixed(1)}
                              </span>
                            ) : <span style={{ color: '#ddd' }}>—</span>}
                          </td>
                        )}
                        <td className={styles.tdRight} style={{ fontWeight: 700, color: item._value > 0 ? '#059669' : '#bbb' }}>
                          {item._value > 0 ? fmt$(item._value) : '—'}
                        </td>
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
              {saving ? 'Saving...' : 'Save & Post to P&L'}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}