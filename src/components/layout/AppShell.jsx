import { Outlet, NavLink, useNavigate } from 'react-router-dom'
import React, { useState, useEffect } from 'react'
import { useAuthStore } from '@/store/authStore'
import { useLocations, cleanLocName } from '@/store/LocationContext'
import { usePeriod, getWeekLabel } from '@/store/PeriodContext'
import { readPeriodClose, writePeriodClose } from '@/lib/pnl'
import {
  LayoutDashboard, ShoppingCart, Package, TrendingUp,
  Trash2, FileText, PieChart, ArrowLeftRight,
  Users, Settings, LogOut, ChevronDown, Bell, MapPin, Menu, X
} from 'lucide-react'
import AureliaChat from '@/components/AureliaChat'
import { db } from '@/lib/firebase'
import { collection, query, where, onSnapshot, doc, updateDoc, orderBy } from 'firebase/firestore'
import styles from './AppShell.module.css'

const NAV = [
  { to: '/dashboard',  icon: LayoutDashboard, label: 'P&L',          category: 'FINANCE' },
  { to: '/orders',     icon: ShoppingCart,    label: 'Order Hub',    category: 'Procurement' },
  { to: '/sales',      icon: TrendingUp,      label: 'Weekly Sales', category: 'Revenue' },
  { to: '/inventory',  icon: Package,         label: 'Inventory',    category: 'Stock' },
  { to: '/waste',      icon: Trash2,          label: 'Shrinkage',    category: 'Shrinkage' },
  { to: '/purchasing', icon: FileText,        label: 'Purchasing',   category: 'AP' },
  { to: '/budgets',    icon: PieChart,        label: 'Budgets',      category: 'Planning' },
  { to: '/transfers',  icon: ArrowLeftRight,  label: 'Operating Ledger', category: 'Finance' },
{ to: '/labor',      icon: Users,           label: 'Labor',        category: 'Labor' },
]

export default function AppShell() {
  const { user, signOut }                                            = useAuthStore()
  const { groupedLocations, selectedLocation, setSelectedLocation , getSubCafes, isParentLocation } = useLocations()
  const { year, period, week, weeks, setYear, setPeriod, setWeek, prevWeek, nextWeek } = usePeriod()
  const navigate                                                     = useNavigate()

  // Notification bell
  const [notifications, setNotifications] = useState([])
  const [showNotifs, setShowNotifs] = useState(false)
  const orgId = user?.tenantId || 'fooda'

  useEffect(() => {
    if (!orgId) return
    const q = query(
      collection(db, 'tenants', orgId, 'notifications'),
      where('read', '==', false)
    )
    const unsub = onSnapshot(q, snap => {
      const notifs = snap.docs.map(d => ({ id: d.id, ...d.data() }))
      notifs.sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0))
      setNotifications(notifs)
    })
    return unsub
  }, [orgId])

  async function markRead(notifId) {
    try {
      await updateDoc(doc(db, 'tenants', orgId, 'notifications', notifId), { read: true })
    } catch (e) { console.error(e) }
  }

  async function markAllRead() {
    for (const n of notifications) {
      try { await updateDoc(doc(db, 'tenants', orgId, 'notifications', n.id), { read: true }) } catch {}
    }
  }

  const [menuOpen, setMenuOpen]       = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [periodClosed, setPeriodClosed] = useState(false)
  const [closedBy, setClosedBy] = useState(null)
  const isDirector = /^(admin|director)$/i.test(user?.role || '')
  const periodKey = `${year}-P${String(period).padStart(2,'0')}-W${week}`

  useEffect(() => {
    if (!selectedLocation || selectedLocation === 'all') { setPeriodClosed(false); return }
    (async () => {
      try {
        const info = await readPeriodClose(selectedLocation, periodKey)
        setPeriodClosed(info.periodStatus === 'closed')
        setClosedBy(info.closedBy || null)
      } catch {}
    })()
  }, [selectedLocation, periodKey])

  async function handleClosePeriod() {
    if (!selectedLocation || selectedLocation === 'all') return
    if (!window.confirm(`Close period ${periodKey} for ${cleanLocName(selectedLocation)}?\n\nThis locks all data for this period across all tabs.`)) return
    try {
      const actor = user?.name || user?.email || 'unknown'
      await writePeriodClose(selectedLocation, periodKey, { status: 'closed', actor })
      setPeriodClosed(true)
      setClosedBy(actor)
    } catch (err) {
      alert('Failed to close period: ' + (err.message || ''))
    }
  }

  async function handleReopenPeriod() {
    if (!selectedLocation || selectedLocation === 'all') return
    const reason = window.prompt('Reason for reopening:')
    if (!reason?.trim()) return
    try {
      const actor = user?.name || user?.email || 'unknown'
      await writePeriodClose(selectedLocation, periodKey, { status: 'reopened', actor, reason: reason.trim() })
      setPeriodClosed(false)
      setClosedBy(null)
    } catch (err) {
      alert('Failed to reopen: ' + (err.message || ''))
    }
  }

  function handleSignOut() { signOut(); navigate('/login') }
  function handleNavClick() { setSidebarOpen(false) }

  return (
    <div className={styles.shell}>
      {/* Top Bar */}
      <header className={styles.topbar}>
        <div className={styles.topbarLeft}>
          <button className={styles.hamburger} onClick={() => setSidebarOpen(v => !v)}>
            {sidebarOpen ? <X size={18}/> : <Menu size={18}/>}
          </button>
          <div className={styles.brand} onClick={() => navigate('/')} style={{cursor:'pointer'}}>
            <div className={styles.foodaLogo} style={{background:'#0f172a',borderRadius:'50%',padding:0,width:32,height:32,display:'flex',alignItems:'center',justifyContent:'center',position:'relative'}}>
              <svg width="32" height="32" viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg" style={{position:'absolute',top:0,left:0}}>
                <circle cx="16" cy="16" r="14" fill="none" stroke="#F15D3B" strokeWidth="2"/>
                <circle cx="16" cy="16" r="11" fill="none" stroke="#F15D3B" strokeWidth="1" opacity="0.5"/>
              </svg>
              <svg width="18" height="18" viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg" style={{position:'relative',zIndex:1}}>
                <path d="M16 6 L26 27 L21 27 L19 22.5 L13 22.5 L11 27 L6 27 Z M14.3 18.5 L17.7 18.5 L16 14.8 Z" fill="#ffffff"/>
              </svg>
            </div>
            <div className={styles.brandText}>
              <span className={styles.brandName}>Aurelia</span>
              <span className={styles.brandSub}>Operations Management Suite</span>
            </div>
          </div>
        </div>

        <div className={styles.topbarCenter}>
          <div className={styles.locationPill}>
            <MapPin size={13}/>
            <select
              value={selectedLocation}
              onChange={e => setSelectedLocation(e.target.value)}
              className={styles.locationSelect}
            >
              <option value="all">All Locations</option>
              {Object.entries(groupedLocations).map(([regionName, locs]) => (
                <optgroup key={regionName} label={regionName}>
                  {locs.filter(loc => loc.type !== 'sub-cafe').map(loc => (
                    <option key={loc.name} value={loc.name}>{cleanLocName(loc.name)}</option>
                  ))}
                </optgroup>
              ))}
            </select>
          </div>
          <div className={styles.periodSelector}>
            <button className={styles.periodNav} onClick={prevWeek}>&lsaquo;</button>
            <div className={styles.periodDropdowns}>
              <select value={year} onChange={e=>{setYear(Number(e.target.value));setWeek(1)}} className={styles.periodSel}>
                {Array.from({length:10},(_,i)=>2024+i).map(y=><option key={y} value={y}>{y}</option>)}
              </select>
              <select value={period} onChange={e=>{setPeriod(Number(e.target.value));setWeek(1)}} className={styles.periodSel}>
                {Array.from({length:12},(_,i)=>i+1).map(p=><option key={p} value={p}>P{p}</option>)}
              </select>
              <select value={week} onChange={e=>setWeek(Number(e.target.value))} className={styles.periodSel}>
                <option value={0}>Monthly</option>
                {weeks.map((w,i)=><option key={i} value={i+1}>{getWeekLabel(w,i+1)}</option>)}
              </select>
            </div>
            <button className={styles.periodNav} onClick={nextWeek}>&rsaquo;</button>
          </div>
          <div className={styles.liveBadge}>
            <span className={styles.liveDot}/> live
          </div>
          {selectedLocation && selectedLocation !== 'all' && isDirector && !periodClosed && (
            <button onClick={handleClosePeriod} style={{
              display:'inline-flex', alignItems:'center', gap:5,
              padding:'6px 14px', fontSize:11, fontWeight:600,
              background:'#059669', color:'#fff',
              border:'none', borderRadius:8,
              cursor:'pointer', whiteSpace:'nowrap',
            }}>🔒 Close Period</button>
          )}
          {selectedLocation && selectedLocation !== 'all' && periodClosed && (
            <div style={{ display:'flex', alignItems:'center', gap:8 }}>
              <span style={{
                display:'inline-flex', alignItems:'center', gap:4,
                padding:'5px 10px', fontSize:11, fontWeight:500,
                background:'#dcfce7', color:'#166534',
                borderRadius:999, whiteSpace:'nowrap',
              }}>🔒 Closed{closedBy ? ` by ${closedBy.split(' ')[0]}` : ''}</span>
              {isDirector && (
                <button onClick={handleReopenPeriod} style={{
                  padding:'5px 10px', fontSize:11, fontWeight:500,
                  background:'#fff', color:'#dc2626',
                  border:'1px solid #fecaca', borderRadius:8,
                  cursor:'pointer', whiteSpace:'nowrap',
                }}>🔓 Reopen</button>
              )}
            </div>
          )}
        </div>

        <div className={styles.topbarRight}>

            {/* Notification bell */}
            <div style={{ position: 'relative' }}>
              <button onClick={() => setShowNotifs(!showNotifs)} 
                style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 6, position: 'relative' }}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" strokeWidth="2" strokeLinecap="round">
                  <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/>
                </svg>
                {notifications.length > 0 && (
                  <span style={{ position: 'absolute', top: 2, right: 2, width: 16, height: 16, borderRadius: '50%', background: '#F15D3B', color: '#fff', fontSize: 10, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    {notifications.length}
                  </span>
                )}
              </button>
              {showNotifs && (
                <div style={{ position: 'absolute', top: '100%', right: 0, width: 320, background: '#fff', borderRadius: 12, boxShadow: '0 8px 32px rgba(0,0,0,0.15)', border: '1px solid #e5e7eb', zIndex: 100, marginTop: 8 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 16px', borderBottom: '1px solid #f1f5f9' }}>
                    <span style={{ fontSize: 14, fontWeight: 700, color: '#0f172a' }}>Notifications</span>
                    {notifications.length > 0 && (
                      <button onClick={markAllRead} style={{ fontSize: 12, color: '#64748b', background: 'none', border: 'none', cursor: 'pointer' }}>Mark all read</button>
                    )}
                  </div>
                  <div style={{ maxHeight: 300, overflow: 'auto' }}>
                    {notifications.length === 0 ? (
                      <div style={{ padding: '20px 16px', textAlign: 'center', fontSize: 13, color: '#94a3b8' }}>No new notifications</div>
                    ) : notifications.map(n => (
                      <div key={n.id} onClick={() => { markRead(n.id); setShowNotifs(false); }} style={{ padding: '10px 16px', borderBottom: '1px solid #f8fafc', cursor: 'pointer', background: '#fffbeb' }}>
                        <div style={{ fontSize: 13, fontWeight: 600, color: '#0f172a' }}>{n.title}</div>
                        <div style={{ fontSize: 12, color: '#64748b', marginTop: 2 }}>{n.message}</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          <button className={styles.userBtn} onClick={() => setMenuOpen(v => !v)}>
            <div className={styles.avatar}>{(user?.name || 'U').charAt(0).toUpperCase()}</div>
            <span className={styles.userName}>{user?.name?.split(' ')[0]}</span>
            <ChevronDown size={13}/>
          </button>
          {menuOpen && (
            <div className={styles.userMenu}>
              <div className={styles.userMenuHeader}>
                <div className={styles.userMenuName}>{user?.name}</div>
                <div className={styles.userMenuRole}>{formatRole(user?.role)}</div>
              </div>
              <div className={styles.userMenuDivider}/>
              {(user?.role === 'admin' || user?.role === 'director') && (
                <button className={styles.userMenuItem} onClick={() => { navigate('/settings'); setMenuOpen(false) }}>
                  <Users size={14}/> Manage Users
                </button>
              )}
              <button className={styles.userMenuItem} onClick={() => { navigate('/settings'); setMenuOpen(false) }}>
                <Settings size={14}/> Settings
              </button>
              <div className={styles.userMenuDivider}/>
              <button className={`${styles.userMenuItem} ${styles.danger}`} onClick={handleSignOut}>
                <LogOut size={14}/> Sign Out
              </button>
            </div>
          )}
        </div>
      </header>

      {/* Mobile sidebar overlay */}
      {sidebarOpen && <div className={styles.overlay} onClick={() => setSidebarOpen(false)}/>}

      {/* Body */}
      <div className={styles.body}>
        <nav className={`${styles.sidebar} ${sidebarOpen ? styles.sidebarOpen : ''}`}>
          {NAV.map(({ to, icon: Icon, label, category }) => (
            <NavLink key={to} to={to} end={to === '/'}
              className={({ isActive }) => `${styles.navItem} ${isActive ? styles.active : ''}`}
              onClick={handleNavClick}
            >
              <div className={styles.navIcon}><Icon size={16}/></div>
              <div className={styles.navText}>
                <span className={styles.navCategory}>{category}</span>
                <span className={styles.navLabel}>{label}</span>
              </div>
            </NavLink>
          ))}
        </nav>

        <main className={styles.main} onClick={() => menuOpen && setMenuOpen(false)}>
          <Outlet/>
        </main>
      </div>

      {/* Bottom nav - mobile only */}
      <nav className={styles.bottomNav}>
        {NAV.slice(0, 5).map(({ to, icon: Icon, label }) => (
          <NavLink key={to} to={to} end={to === '/'}
            className={({ isActive }) => `${styles.bottomNavItem} ${isActive ? styles.bottomNavActive : ''}`}
          >
            <Icon size={20}/>
            <span>{label}</span>
          </NavLink>
        ))}
      </nav>
          <AureliaChat />
    </div>
  )
}

function formatRole(role) {
  return { admin:'Administrator', director:'Director', areaManager:'Area Manager', viewer:'Viewer' }[role] || role
}