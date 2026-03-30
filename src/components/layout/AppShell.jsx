import { Outlet, NavLink, useNavigate } from 'react-router-dom'
import { useState } from 'react'
import { useAuthStore } from '@/store/authStore'
import {
  LayoutDashboard, ShoppingCart, Package, TrendingUp,
  Trash2, FileText, PieChart, ArrowLeftRight, Users,
  Settings, LogOut, ChevronDown, Bell, MapPin
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
  const { user, signOut } = useAuthStore()
  const navigate = useNavigate()
  const [menuOpen, setMenuOpen] = useState(false)
  const [location, setLocation] = useState('All Locations')

  function handleSignOut() {
    signOut()
    navigate('/login')
  }

  return (
    <div className={styles.shell}>
      {/* Top Bar */}
      <header className={styles.topbar}>
        <div className={styles.brand}>
          <div className={styles.foodaLogo}>fooda</div>
          <div className={styles.brandText}>
            <span className={styles.brandName}>Aurelia</span>
            <span className={styles.brandSub}>A Fooda Management Suite</span>
          </div>
        </div>

        <div className={styles.topbarCenter}>
          <div className={styles.locationPill}>
            <MapPin size={13} />
            <select
              value={location}
              onChange={e => setLocation(e.target.value)}
              className={styles.locationSelect}
            >
              <option>All Locations</option>
            </select>
          </div>
          <div className={styles.liveBadge}>
            <span className={styles.liveDot} />
            live
          </div>
        </div>

        <div className={styles.topbarRight}>
          <button className={styles.notifBtn}>
            <Bell size={16} />
          </button>
          <button
            className={styles.userBtn}
            onClick={() => setMenuOpen(v => !v)}
          >
            <div className={styles.avatar}>
              {(user?.name || 'U').charAt(0).toUpperCase()}
            </div>
            <span className={styles.userName}>{user?.name?.split(' ')[0]}</span>
            <ChevronDown size={13} />
          </button>

          {menuOpen && (
            <div className={styles.userMenu}>
              <div className={styles.userMenuHeader}>
                <div className={styles.userMenuName}>{user?.name}</div>
                <div className={styles.userMenuRole}>{formatRole(user?.role)}</div>
              </div>
              <div className={styles.userMenuDivider} />
              {(user?.role === 'admin' || user?.role === 'director') && (
                <button className={styles.userMenuItem}
                  onClick={() => { navigate('/settings'); setMenuOpen(false) }}>
                  <Users size={14} /> Manage Users
                </button>
              )}
              <button className={styles.userMenuItem}
                onClick={() => { navigate('/settings'); setMenuOpen(false) }}>
                <Settings size={14} /> Settings
              </button>
              <div className={styles.userMenuDivider} />
              <button className={`${styles.userMenuItem} ${styles.danger}`}
                onClick={handleSignOut}>
                <LogOut size={14} /> Sign Out
              </button>
            </div>
          )}
        </div>
      </header>

      {/* Main layout */}
      <div className={styles.body}>
        {/* Sidebar */}
        <nav className={styles.sidebar}>
          {NAV.map(({ to, icon: Icon, label, category }) => (
            <NavLink
              key={to}
              to={to}
              end={to === '/'}
              className={({ isActive }) =>
                `${styles.navItem} ${isActive ? styles.active : ''}`
              }
            >
              <div className={styles.navIcon}><Icon size={16} /></div>
              <div className={styles.navText}>
                <span className={styles.navCategory}>{category}</span>
                <span className={styles.navLabel}>{label}</span>
              </div>
            </NavLink>
          ))}
        </nav>

        {/* Page content */}
        <main className={styles.main}>
          <Outlet />
        </main>
      </div>
    </div>
  )
}

function formatRole(role) {
  const map = {
    admin: 'Administrator',
    director: 'Director',
    areaManager: 'Area Manager',
    viewer: 'Viewer',
  }
  return map[role] || role
}
