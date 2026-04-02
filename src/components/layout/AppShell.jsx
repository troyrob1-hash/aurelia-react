import { Outlet, NavLink, useNavigate } from 'react-router-dom'
import { useState } from 'react'
import { useAuthStore } from '@/store/authStore'
import { useLocations, cleanLocName } from '@/store/LocationContext'
import { usePeriod, getWeekLabel } from '@/store/PeriodContext'
import {
  LayoutDashboard, ShoppingCart, Package, TrendingUp,
  Trash2, FileText, PieChart, ArrowLeftRight,
  Users, Settings, LogOut, ChevronDown, Bell, MapPin, Menu, X
} from 'lucide-react'
import styles from './AppShell.module.css'

const NAV = [
  { to: '/',           icon: LayoutDashboard, label: 'Dashboard',    category: 'P&L' },
  { to: '/orders',     icon: ShoppingCart,    label: 'Order Hub',    category: 'Procurement' },
  { to: '/sales',      icon: TrendingUp,      label: 'Weekly Sales', category: 'Revenue' },
  { to: '/inventory',  icon: Package,         label: 'Inventory',    category: 'Stock' },
  { to: '/waste',      icon: Trash2,          label: 'Waste Log',    category: 'Shrinkage' },
  { to: '/purchasing', icon: FileText,        label: 'Purchasing',   category: 'AP' },
  { to: '/budgets',    icon: PieChart,        label: 'Budgets',      category: 'Planning' },
  { to: '/transfers',  icon: ArrowLeftRight,  label: 'Transfers',    category: 'Logistics' },
]

export default function AppShell() {
  const { user, signOut }                                            = useAuthStore()
  const { groupedLocations, selectedLocation, setSelectedLocation } = useLocations()
  const { year, period, week, weeks, setYear, setPeriod, setWeek, prevWeek, nextWeek } = usePeriod()
  const navigate                                                     = useNavigate()
  const [menuOpen, setMenuOpen]       = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(false)

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
          <div className={styles.brand}>
            <div className={styles.foodaLogo}>fooda</div>
            <div className={styles.brandText}>
              <span className={styles.brandName}>Aurelia</span>
              <span className={styles.brandSub}>A Fooda Management Suite</span>
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
              {Object.entries(groupedLocations).map(([director, locs]) => (
                <optgroup key={director} label={director}>
                  {locs.map(loc => (
                    <option key={loc} value={loc}>{cleanLocName(loc)}</option>
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
                {weeks.map((w,i)=><option key={i} value={i+1}>{getWeekLabel(w,i+1)}</option>)}
              </select>
            </div>
            <button className={styles.periodNav} onClick={nextWeek}>&rsaquo;</button>
          </div>
          <div className={styles.liveBadge}>
            <span className={styles.liveDot}/> live
          </div>
        </div>

        <div className={styles.topbarRight}>
          <button className={styles.notifBtn}><Bell size={16}/></button>
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
    </div>
  )
}

function formatRole(role) {
  return { admin:'Administrator', director:'Director', areaManager:'Area Manager', viewer:'Viewer' }[role] || role
}
