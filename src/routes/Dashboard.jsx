import { useAuthStore } from '@/store/authStore'
import styles from './Dashboard.module.css'

export default function Dashboard() {
  const { user } = useAuthStore()

  const hour = new Date().getHours()
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening'

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <h1 className={styles.greeting}>
          {greeting}, <span className={styles.name}>{user?.name?.split(' ')[0]}.</span>
        </h1>
        <p className={styles.sub}>Here's what's happening across your locations today.</p>
      </div>

      <div className={styles.grid}>
        {MODULES.map(mod => (
          <ModuleCard key={mod.title} {...mod} />
        ))}
      </div>
    </div>
  )
}

function ModuleCard({ icon, category, title, description, color, to }) {
  return (
    <a href={to} className={styles.card}>
      <div className={styles.iconWell} style={{ background: color + '18' }}>
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none"
          stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
          dangerouslySetInnerHTML={{ __html: icon }}
        />
      </div>
      <div className={styles.cardCategory}>{category}</div>
      <div className={styles.cardTitle}>{title}</div>
      <div className={styles.cardDesc}>{description}</div>
      <div className={styles.arrow} style={{ color }}>→</div>
    </a>
  )
}

const MODULES = [
  {
    to: '/orders',
    icon: '<circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"/>',
    category: 'Procurement', title: 'Order Hub',
    description: 'Place orders via Sysco, GFS, or guide. Track history and reorder past items.',
    color: '#2563eb',
  },
  {
    to: '/sales',
    icon: '<line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>',
    category: 'Revenue', title: 'Weekly Sales',
    description: 'Log weekly sales by category. Track popup, catering, retail and delivery.',
    color: '#16a34a',
  },
  {
    to: '/inventory',
    icon: '<path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/>',
    category: 'Stock', title: 'Inventory',
    description: 'Count and track inventory across locations. Monitor value and variances.',
    color: '#7c3aed',
  },
  {
    to: '/waste',
    icon: '<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/>',
    category: 'Shrinkage', title: 'Waste Log',
    description: 'Record and analyze waste. Identify trends and reduce shrinkage.',
    color: '#ea580c',
  },
  {
    to: '/purchasing',
    icon: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>',
    category: 'Accounts Payable', title: 'Purchasing',
    description: 'Track invoices and vendor payments. Manage accounts payable.',
    color: '#0891b2',
  },
  {
    to: '/budgets',
    icon: '<circle cx="12" cy="12" r="10"/><path d="M12 8v4l3 3"/>',
    category: 'Planning', title: 'Budgets',
    description: 'Set and track weekly budgets. Monitor spend vs targets.',
    color: '#d97706',
  },
  {
    to: '/transfers',
    icon: '<polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/>',
    category: 'Logistics', title: 'Transfers',
    description: 'Record stock transfers between locations.',
    color: '#db2777',
  },
  {
    to: '/labor',
    icon: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
    category: 'Workforce', title: 'Labor Planner',
    description: 'Plan and track labor hours, costs and schedules.',
    color: '#0f766e',
  },
]
