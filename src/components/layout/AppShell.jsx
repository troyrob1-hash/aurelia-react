import { Outlet, NavLink, useNavigate } from 'react-router-dom'
import React, { useState, useEffect } from 'react'
import { useAuthStore } from '@/store/authStore'
import { changePassword } from '@/lib/auth'
import { useLocations, cleanLocName } from '@/store/LocationContext'
import { usePeriod, getWeekLabel } from '@/store/PeriodContext'
import { readPeriodClose, writePeriodClose, lockPeriod, unlockPeriod, isPeriodLocked } from '@/lib/pnl'
import {
  LayoutDashboard, ShoppingCart, Package, TrendingUp,
  Trash2, FileText, PieChart, ArrowLeftRight,
  Users, Settings, LogOut, ChevronDown, Bell, MapPin, Menu, X, HelpCircle, Scale, Boxes
} from 'lucide-react'
import AureliaChat from '@/components/AureliaChat'
import ErrorBoundary from '@/components/ErrorBoundary'
import { db } from '@/lib/firebase'
import { collection, query, where, onSnapshot, doc, updateDoc, orderBy } from 'firebase/firestore'
import styles from './AppShell.module.css'

// Shared fallback: contain a crash to its subtree AND surface the actual error
// (message + JS stack + React component stack) on screen, so a throw can be
// diagnosed without the console. `label` names the degraded subtree.
function crashBox(label) {
  return (err, reset, info) => (
    <div style={{ margin: 12, padding: 14, border: '1px solid #fecaca', background: '#fef2f2', borderRadius: 10, color: '#7f1d1d', fontSize: 12, maxWidth: 680 }}>
      <div style={{ fontWeight: 800, marginBottom: 6 }}>{label} hit an error (contained — the rest of the app is fine).</div>
      <div style={{ fontWeight: 700, fontFamily: 'monospace', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{String(err?.message || err)}</div>
      <details style={{ marginTop: 8 }}>
        <summary style={{ cursor: 'pointer' }}>stack</summary>
        <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 11, marginTop: 6 }}>{String(err?.stack || '')}</pre>
        <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 11, color: '#9a3412' }}>{String(info?.componentStack || '')}</pre>
      </details>
      <button onClick={reset} style={{ marginTop: 8, padding: '5px 12px', borderRadius: 8, border: '1px solid #cbd5e1', background: '#fff', cursor: 'pointer' }}>Retry</button>
    </div>
  )
}

const NAV = [
  { to: '/dashboard',  icon: LayoutDashboard, label: 'P&L',          category: 'FINANCE' },
  { to: '/orders',     icon: ShoppingCart,    label: 'Order Hub',    category: 'Procurement' },
  { to: '/sales',      icon: TrendingUp,      label: 'Weekly Sales', category: 'Revenue' },
  { to: '/inventory',  icon: Package,         label: 'Inventory',    category: 'Stock' },
  { to: '/waste',      icon: Trash2,          label: 'Waste Log',    category: 'Shrinkage' },
  { to: '/purchasing', icon: FileText,        label: 'Purchasing',   category: 'AP' },
  { to: '/budgets',    icon: PieChart,        label: 'Budgets',      category: 'Planning' },
  { to: '/transfers',  icon: ArrowLeftRight,  label: 'Operating Ledger', category: 'Finance' },
{ to: '/labor',      icon: Users,           label: 'Labor',        category: 'Labor' },
  { to: '/reconciliation', icon: Scale,      label: 'Reconciliation', category: 'Finance' },
  { to: '/shrinkage',  icon: Boxes,          label: 'Shrinkage Analysis', category: 'Finance' },
]

export default function AppShell() {
  const { user, signOut }                                            = useAuthStore()
  const { groupedLocations, selectedLocation, setSelectedLocation , getSubCafes, isParentLocation } = useLocations()
  const { year, period, week, weeks, setYear, setPeriod, setWeek, prevWeek, nextWeek } = usePeriod()
  const navigate                                                     = useNavigate()

  // Notification bell
  const [notifications, setNotifications] = useState([])
  const [showNotifs, setShowNotifs] = useState(false)

  // ESC key closes dropdowns and modals
  useEffect(() => {
    function handleEsc(e) {
      if (e.key === 'Escape') {
        setShowNotifs(false)
        setShowChangePw(false)
        setMenuOpen(false)
      }
    }
    window.addEventListener('keydown', handleEsc)
    return () => window.removeEventListener('keydown', handleEsc)
  }, [])
  const [showChangePw, setShowChangePw] = useState(false)
  const [pwForm, setPwForm] = useState({ current: '', newPw: '', confirm: '' })
  const [pwSaving, setPwSaving] = useState(false)
  const [pwError, setPwError] = useState(null)
  const [pwSuccess, setPwSuccess] = useState(false)
  const orgId = user?.tenantId

  // Defense-in-depth against the 'fooda' silent fallback class of bug: if a
  // user reached AppShell without a tenantId claim, don't quietly bucket them
  // into someone else's tenant — sign them out and bounce them to login.
  // mapUser (authStore) still has its own fallback today, so this code path
  // shouldn't fire in practice; this is the belt-and-suspenders that will
  // become the only line of defense once Phase B tightens the gateway.
  useEffect(() => {
    if (user && !user.tenantId) {
      console.error('AppShell: signed-in user has no tenantId claim — forcing sign-out')
      signOut()
      navigate('/login')
    }
  }, [user, signOut, navigate])

  // Notifications today are admin-only (the only writer is submitAccessRequest,
  // which mirrors access-request alerts here). Gate the subscription AND the
  // bell rendering on the admin role: skipping the subscription for non-admins
  // avoids permission-denied snapshot errors now that the rule is tightened,
  // and matches the UI behavior.
  const isAdmin = /^admin$/i.test(user?.role || '')

  useEffect(() => {
    if (!orgId || !isAdmin) return
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
  }, [orgId, isAdmin])

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
  // periodLocked is the canonical lock state read from periodLocks/{loc}__{period}.
  // periodClosed is read from the P&L doc's periodStatus field. The normal
  // close/reopen flow writes both in sync, but they can drift (interrupted
  // close, Cloud-Function write, direct Firestore edit). When they drift,
  // periodClosed=false but periodLocked=true — writes still throw, and the
  // old UI hid the Reopen button. Tracking both lets us surface Reopen in
  // the drift case too.
  const [periodLocked, setPeriodLocked] = useState(false)
  const isDirector = /^(admin|director)$/i.test(user?.role || '')
  const periodKey = `${year}-P${String(period).padStart(2,'0')}-W${week}`

  useEffect(() => {
    if (!selectedLocation || selectedLocation === 'all') {
      setPeriodClosed(false)
      setPeriodLocked(false)
      setClosedBy(null)
      return
    }
    (async () => {
      try {
        const [info, locked] = await Promise.all([
          readPeriodClose(selectedLocation, periodKey),
          isPeriodLocked(selectedLocation, periodKey),
        ])
        setPeriodClosed(info.periodStatus === 'closed')
        setClosedBy(info.closedBy || null)
        setPeriodLocked(!!locked)
      } catch {}
    })()
  }, [selectedLocation, periodKey])

  async function handleClosePeriod() {
    if (!selectedLocation || selectedLocation === 'all') return
    // Defensive: refuse to "close" a period that's already locked or closed —
    // would overwrite closedBy/closedAt metadata if a race lets the UI fall
    // out of sync with the actual state docs.
    if (periodClosed || periodLocked) return
    if (!window.confirm(`Close period ${periodKey} for ${cleanLocName(selectedLocation)}?\n\nThis locks all data for this period across all tabs.`)) return
    try {
      const actor = user?.name || user?.email || 'unknown'
      await writePeriodClose(selectedLocation, periodKey, { status: 'closed', actor })
      await lockPeriod(selectedLocation, periodKey, user)
      setPeriodClosed(true)
      setClosedBy(actor)
      setPeriodLocked(true)
    } catch (err) {
      alert('Failed to close period: ' + (err.message || ''))
    }
  }

  async function handleReopenPeriod() {
    if (!selectedLocation || selectedLocation === 'all') return
    const reason = window.prompt('Reason for reopening:')
    if (!reason?.trim()) return

    const actor = user?.name || user?.email || 'unknown'

    // 1. Clear the lock FIRST. Reopen is asymmetric to close: close can write
    //    status before locking (writePnL's lock-check sees lock=false at that
    //    moment), but reopen MUST clear the lock before writing anything that
    //    routes through writePnL — which includes writePeriodClose. Previous
    //    code did writePeriodClose first and the lock-check threw on its own
    //    write ("Period is locked. Use the 🔓 Reopen button…"), leaving the
    //    lock untouched and trapping the user.
    try {
      await unlockPeriod(selectedLocation, periodKey, user)
    } catch (err) {
      alert('Failed to reopen: ' + (err.message || ''))
      return
    }

    // Optimistic local-state update: the lock IS off — writes now succeed —
    // so reflect that in the badge immediately even if the status write below
    // fails. Otherwise the user stares at a "Closed" badge on an actually
    // unlocked period and has no signal that they can save data.
    setPeriodLocked(false)

    // 2. Update periodStatus to 'reopened' with actor + reason metadata.
    //    Routes through writePnL; the lock-check now passes since step 1
    //    cleared the lock. Only flip periodClosed/closedBy after this lands.
    try {
      await writePeriodClose(selectedLocation, periodKey, { status: 'reopened', actor, reason: reason.trim() })
      setPeriodClosed(false)
      setClosedBy(null)
    } catch (err) {
      alert('Period unlocked, but status display may be stale — refresh.')
      // Don't return — the per-tab approval-clearing loop below is idempotent
      // and worth running even when the status write failed.
    }

    // 3. Also clear the per-tab approval locks (sales + labor submissions).
    //    An 'approved' submission locks its tab independently of periodStatus;
    //    reopening the period must release those too, or the tab stays locked.
    //    No orderBy (client-side only) per data rules.
    try {
      const { collection, query, where, getDocs, updateDoc, doc: fbDoc, serverTimestamp } = await import('firebase/firestore')
      for (const coll of ['salesSubmissions', 'laborSubmissions']) {
        const qy = query(
          collection(db, 'tenants', orgId, coll),
          where('period', '==', periodKey),
          where('location', '==', selectedLocation),
          where('status', '==', 'approved')
        )
        const snap = await getDocs(qy)
        for (const d of snap.docs) {
          await updateDoc(fbDoc(db, 'tenants', orgId, coll, d.id), {
            status: 'reopened',
            reopenedBy: actor,
            reopenedAt: serverTimestamp(),
          })
        }
      }
    } catch (e) {
      console.error('Failed to clear approval locks on reopen:', e)
    }
  }

  function handleSignOut() { signOut(); navigate('/login') }

  async function handleChangePassword() {
    if (!pwForm.newPw || !pwForm.current) { setPwError('Enter current and new password'); return }
    if (pwForm.newPw !== pwForm.confirm) { setPwError('Passwords do not match'); return }
    if (pwForm.newPw.length < 8) { setPwError('Password must be at least 8 characters'); return }
    setPwSaving(true); setPwError(null)
    try {
      const session = useAuthStore.getState().session
      await changePassword(session.accessToken, pwForm.current, pwForm.newPw)
      setPwSuccess(true)
      setTimeout(() => { setShowChangePw(false); setPwSuccess(false); setPwForm({ current: '', newPw: '', confirm: '' }) }, 2000)
    } catch (err) {
      setPwError(err.message || 'Failed to change password')
    } finally { setPwSaving(false) }
  }
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
          {selectedLocation && selectedLocation !== 'all' && isDirector && !periodClosed && !periodLocked && (
            <button onClick={handleClosePeriod} style={{
              display:'inline-flex', alignItems:'center', gap:5,
              padding:'6px 14px', fontSize:11, fontWeight:600,
              background:'#059669', color:'#fff',
              border:'none', borderRadius:8,
              cursor:'pointer', whiteSpace:'nowrap',
            }}>🔒 Close Period</button>
          )}
          {selectedLocation && selectedLocation !== 'all' && (periodClosed || periodLocked) && (
            <div style={{ display:'flex', alignItems:'center', gap:8 }}>
              {periodClosed ? (
                // Normal close: green "Closed by X" badge with actor metadata.
                <span style={{
                  display:'inline-flex', alignItems:'center', gap:4,
                  padding:'5px 10px', fontSize:11, fontWeight:500,
                  background:'#dcfce7', color:'#166534',
                  borderRadius:999, whiteSpace:'nowrap',
                }}>🔒 Closed{closedBy ? ` by ${closedBy.split(' ')[0]}` : ''}</span>
              ) : (
                // Drift case: lock exists but periodStatus is not 'closed', so
                // we don't have actor metadata. Amber badge visually flags this
                // as out-of-band state (vs the green "normal close" badge).
                <span style={{
                  display:'inline-flex', alignItems:'center', gap:4,
                  padding:'5px 10px', fontSize:11, fontWeight:500,
                  background:'#fef3c7', color:'#92400e',
                  borderRadius:999, whiteSpace:'nowrap',
                }} title="Period is locked but has no close metadata — likely from an interrupted close or a direct Firestore write. Reopening will release the lock.">🔒 Locked</span>
              )}
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

            {/* Notification bell — admin-only. Today's only notification source
                is the access-request alert mirrored from submitAccessRequest,
                which is admin-only content. */}
            {isAdmin && (
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
                        <div key={n.id} onClick={() => { markRead(n.id); setShowNotifs(false); navigate('/settings'); }} style={{ padding: '10px 16px', borderBottom: '1px solid #f8fafc', cursor: 'pointer', background: '#fffbeb' }}>
                          <div style={{ fontSize: 13, fontWeight: 600, color: '#0f172a' }}>{n.title}</div>
                          <div style={{ fontSize: 12, color: '#64748b', marginTop: 2 }}>{n.message}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
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
              {user?.role === 'admin' && (
                <button className={styles.userMenuItem} onClick={() => { navigate('/settings'); setMenuOpen(false) }}>
                  <Settings size={14}/> Admin Settings
                </button>
              )}
              <button className={styles.userMenuItem} onClick={() => { setShowChangePw(true); setMenuOpen(false) }}>
                <Settings size={14}/> Change Password
              </button>
              <div className={styles.userMenuDivider}/>
              <button className={`${styles.userMenuItem} ${styles.danger}`} onClick={handleSignOut}>
                <LogOut size={14}/> Sign Out
              </button>
            </div>
          )}
        </div>
      {/* Change Password Modal */}
      {showChangePw && (
        <>
          <div onClick={() => setShowChangePw(false)} style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.4)', zIndex: 2900 }} />
          <div style={{
            position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%, -50%)',
            background: '#fff', borderRadius: 16, width: 400, maxWidth: '94vw', zIndex: 3000,
            boxShadow: '0 20px 60px rgba(15,23,42,0.15)',
          }}>
            <div style={{ padding: '24px 28px' }}>
              <h2 style={{ fontSize: 18, fontWeight: 600, margin: '0 0 4px' }}>Change password</h2>
              <p style={{ fontSize: 13, color: '#64748b', margin: '0 0 20px' }}>Enter your current password and choose a new one.</p>

              {pwError && <div style={{ padding: '10px 12px', background: '#fee2e2', color: '#991b1b', borderRadius: 8, marginBottom: 14, fontSize: 12 }}>{pwError}</div>}
              {pwSuccess && <div style={{ padding: '10px 12px', background: '#dcfce7', color: '#166534', borderRadius: 8, marginBottom: 14, fontSize: 12 }}>Password changed successfully!</div>}

              <label style={{ fontSize: 11, fontWeight: 600, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.05em', display: 'block', marginBottom: 6 }}>Current password</label>
              <input type="password" value={pwForm.current} onChange={e => setPwForm(f => ({ ...f, current: e.target.value }))}
                style={{ width: '100%', padding: '10px 12px', fontSize: 14, border: '1px solid #e2e8f0', borderRadius: 8, marginBottom: 14 }} />

              <label style={{ fontSize: 11, fontWeight: 600, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.05em', display: 'block', marginBottom: 6 }}>New password</label>
              <input type="password" value={pwForm.newPw} onChange={e => setPwForm(f => ({ ...f, newPw: e.target.value }))}
                style={{ width: '100%', padding: '10px 12px', fontSize: 14, border: '1px solid #e2e8f0', borderRadius: 8, marginBottom: 14 }} />

              <label style={{ fontSize: 11, fontWeight: 600, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.05em', display: 'block', marginBottom: 6 }}>Confirm new password</label>
              <input type="password" value={pwForm.confirm} onChange={e => setPwForm(f => ({ ...f, confirm: e.target.value }))}
                onKeyDown={e => { if (e.key === 'Enter') handleChangePassword() }}
                style={{ width: '100%', padding: '10px 12px', fontSize: 14, border: '1px solid #e2e8f0', borderRadius: 8, marginBottom: 20 }} />

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
                <button onClick={() => { setShowChangePw(false); setPwError(null); setPwForm({ current: '', newPw: '', confirm: '' }) }}
                  style={{ padding: '9px 18px', fontSize: 13, fontWeight: 500, border: '1px solid #e2e8f0', borderRadius: 8, background: '#fff', cursor: 'pointer', color: '#64748b' }}>Cancel</button>
                <button onClick={handleChangePassword} disabled={pwSaving}
                  style={{ padding: '9px 24px', fontSize: 13, fontWeight: 600, border: 'none', borderRadius: 8, background: '#F15D3B', color: '#fff', cursor: 'pointer' }}>
                  {pwSaving ? 'Saving...' : 'Change password'}
                </button>
              </div>
            </div>
          </div>
        </>
      )}

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
          {/* Help pinned to the bottom of the sidebar, separated from operational tabs */}
          <NavLink to="/directions"
            className={({ isActive }) => `${styles.navItem} ${isActive ? styles.active : ''}`}
            onClick={handleNavClick}
            style={{ marginTop: 'auto' }}
          >
            <div className={styles.navIcon}><HelpCircle size={16}/></div>
            <div className={styles.navText}>
              <span className={styles.navCategory}>Guide</span>
              <span className={styles.navLabel}>Help &amp; Directions</span>
            </div>
          </NavLink>
        </nav>

        <main className={styles.main} onClick={() => menuOpen && setMenuOpen(false)}>
          {/* Route crash stays contained to the page area — the shell/nav survive. */}
          <ErrorBoundary fallback={crashBox('This page')}>
            <Outlet/>
          </ErrorBoundary>
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
          {/* The chat widget is GLOBAL — a throw here previously blanked the whole app. Contain it. */}
          <ErrorBoundary fallback={crashBox('Aurelia chat')}>
            <AureliaChat />
          </ErrorBoundary>
    </div>
  )
}

function formatRole(role) {
  return { admin:'Administrator', director:'Director', areaManager:'Area Manager', viewer:'Viewer' }[role] || role
}