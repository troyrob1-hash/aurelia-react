import { useNavigate } from 'react-router-dom'
import { useAuthStore } from '@/store/authStore'
import { useLocations, cleanLocName } from '@/store/LocationContext'
import { usePeriod } from '@/store/PeriodContext'
import {
  BarChart2, ShoppingCart, TrendingUp, Package,
  Trash2, FileText, LayoutGrid, ArrowLeftRight, Settings, Users
} from 'lucide-react'
import styles from './Home.module.css'

const MODULES = [
  {
    path: '/dashboard',
    section: 'P&L',
    label: 'Dashboard',
    desc: 'Income statement · Actual vs Budget · EBITDA',
    icon: BarChart2,
    color: '#059669',
    bg: '#E1F5EE',
  },
  {
    path: '/orders',
    section: 'Procurement',
    label: 'Order Hub',
    desc: 'Purchase orders · Vendors · PAR levels',
    icon: ShoppingCart,
    color: '#185FA5',
    bg: '#E6F1FB',
  },
  {
    path: '/sales',
    section: 'Revenue',
    label: 'Weekly Sales',
    desc: 'Sales entry · Import · Submit to P&L',
    icon: TrendingUp,
    color: '#854F0B',
    bg: '#FAEEDA',
  },
  {
    path: '/inventory',
    section: 'Stock',
    label: 'Inventory',
    desc: 'Count · Value · COGS tracking',
    icon: Package,
    color: '#534AB7',
    bg: '#EEEDFE',
  },
  {
    path: '/waste',
    section: 'Shrinkage',
    label: 'Waste Log',
    desc: 'Diversion · Landfill · Shrinkage',
    icon: Trash2,
    color: '#A32D2D',
    bg: '#FCEBEB',
  },
  {
    path: '/purchasing',
    section: 'AP',
    label: 'Purchasing',
    desc: 'Invoices · Aging · Approval workflow',
    icon: FileText,
    color: '#185FA5',
    bg: '#E6F1FB',
  },
  {
    path: '/budgets',
    section: 'Planning',
    label: 'Budgets',
    desc: 'Annual plan · Variance · Upload',
    icon: LayoutGrid,
    color: '#0F6E56',
    bg: '#E1F5EE',
  },
  {
    path: '/transfers',
    section: 'Logistics',
    label: 'Transfers',
    desc: 'Inter-location · Status · Approval',
    icon: ArrowLeftRight,
    color: '#854F0B',
    bg: '#FAEEDA',
  },
  {
    path: '/labor',
    section: 'Labor',
    label: 'Labor',
    desc: 'GL codes · Actual vs Budget · Approval',
    icon: Users,
    color: '#993C1D',
    bg: '#FAECE7',
  },
  {
    path: '/settings',
    section: 'Admin',
    label: 'Settings',
    desc: 'Users · Roles · Locations · SSO',
    icon: Settings,
    color: '#5F5E5A',
    bg: '#F1EFE8',
  },
]

function greeting() {
  const h = new Date().getHours()
  if (h < 12) return 'Good morning'
  if (h < 17) return 'Good afternoon'
  return 'Good evening'
}

export default function Home() {
  const navigate              = useNavigate()
  const { user }              = useAuthStore()
  const { selectedLocation }  = useLocations()
  const { year, period, currentWeek } = usePeriod()

  const name      = user?.name?.split(' ')[0] || user?.email?.split('@')[0] || 'there'
  const location  = selectedLocation === 'all' ? 'All Locations' : cleanLocName(selectedLocation)
  const weekLabel = currentWeek
    ? `${currentWeek.start.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} – ${currentWeek.end.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`
    : null

  return (
    <div className={styles.page}>
      <div className={styles.greeting}>
        <div className={styles.greetingText}>{greeting()}, {name}</div>
        <div className={styles.greetingSub}>
          {location} · P{period} {year}{weekLabel ? ` · ${weekLabel}` : ''}
        </div>
      </div>

      <div className={styles.grid}>
        {MODULES.map(mod => {
          const Icon = mod.icon
          return (
            <button
              key={mod.path}
              className={styles.card}
              onClick={() => navigate(mod.path)}
            >
              <div className={styles.cardIcon} style={{ background: mod.bg }}>
                <Icon size={18} style={{ color: mod.color }} strokeWidth={1.5} />
              </div>
              <div className={styles.cardSection}>{mod.section}</div>
              <div className={styles.cardLabel}>{mod.label}</div>
              <div className={styles.cardDesc}>{mod.desc}</div>
            </button>
          )
        })}
      </div>
    </div>
  )
}