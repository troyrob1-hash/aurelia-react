import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuthStore } from '@/store/authStore'
import { useLocations, cleanLocName } from '@/store/LocationContext'
import {
  BarChart2, ShoppingCart, TrendingUp, Package,
  Trash2, FileText, Users, ArrowRight, Check
} from 'lucide-react'

const STEPS = [
  {
    title: 'Welcome to Aurelia',
    subtitle: 'Your operations command center',
    content: 'Aurelia brings your P&L, ordering, inventory, labor, and purchasing into one place — so you always know where your numbers stand.',
  },
  {
    title: 'Your weekly workflow',
    subtitle: 'Three steps, every week',
    items: [
      { icon: TrendingUp, label: 'Enter daily sales', desc: 'Popup, catering, and retail — by day' },
      { icon: Package, label: 'Count inventory', desc: 'Closing counts flow into COGS automatically' },
      { icon: FileText, label: 'Review your P&L', desc: 'Dashboard updates in real time as you enter data' },
    ],
  },
  {
    title: 'Key tabs',
    subtitle: 'Everything you need',
    items: [
      { icon: BarChart2, label: 'Dashboard', desc: 'Your P&L — actual vs budget, EBITDA, trends' },
      { icon: TrendingUp, label: 'Sales', desc: 'Daily sales entry with prior week comparison' },
      { icon: Package, label: 'Inventory', desc: 'Item counts, valuations, COGS calculation' },
      { icon: ShoppingCart, label: 'Order Hub', desc: 'Place orders, track deliveries, manage vendors' },
      { icon: Users, label: 'Labor', desc: 'Import labor data, track labor % of GFS' },
      { icon: FileText, label: 'Purchasing', desc: 'Invoice entry, AP tracking, GL coding' },
    ],
  },
  {
    title: "You're all set",
    subtitle: 'Start by entering this week\'s sales',
    content: 'Select your location from the dropdown at the top, then head to the Sales tab to enter your daily numbers. Your P&L will build itself from there.',
    final: true,
  },
]

export default function Onboarding({ onComplete }) {
  const [step, setStep] = useState(0)
  const { user } = useAuthStore()
  const { visibleLocations } = useLocations()
  const navigate = useNavigate()
  const current = STEPS[step]
  const isLast = step === STEPS.length - 1

  function next() {
    if (isLast) {
      localStorage.setItem('aurelia_onboarded', 'true')
      onComplete()
      navigate('/sales')
    } else {
      setStep(step + 1)
    }
  }

  function skip() {
    localStorage.setItem('aurelia_onboarded', 'true')
    onComplete()
  }

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 9999,
      background: 'rgba(15,23,42,0.6)', backdropFilter: 'blur(8px)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: 20,
    }}>
      <div style={{
        background: '#fff', borderRadius: 20, maxWidth: 520, width: '100%',
        boxShadow: '0 24px 80px rgba(0,0,0,0.2)', overflow: 'hidden',
      }}>
        {/* Header */}
        <div style={{
          background: '#0f172a', padding: '32px 32px 28px',
          position: 'relative',
        }}>
          {/* Logo */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20 }}>
            <div style={{
              width: 40, height: 40, borderRadius: '50%', background: '#1e293b',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              border: '2px solid #F15D3B',
            }}>
              <svg width="22" height="22" viewBox="0 0 32 32">
                <path d="M16 6 L26 27 L21 27 L19 22.5 L13 22.5 L11 27 L6 27 Z M14.3 18.5 L17.7 18.5 L16 14.8 Z" fill="#fff"/>
              </svg>
            </div>
            <div>
              <div style={{ fontSize: 18, fontWeight: 800, color: '#fff', letterSpacing: -0.4 }}>
                {current.title}
              </div>
              <div style={{ fontSize: 13, color: '#94a3b8' }}>
                {current.subtitle}
              </div>
            </div>
          </div>

          {/* Step dots */}
          <div style={{ display: 'flex', gap: 6 }}>
            {STEPS.map((_, i) => (
              <div key={i} style={{
                width: i === step ? 24 : 8, height: 8, borderRadius: 4,
                background: i === step ? '#F15D3B' : i < step ? '#1D9E75' : '#334155',
                transition: 'all 0.3s',
              }} />
            ))}
          </div>
        </div>

        {/* Body */}
        <div style={{ padding: '28px 32px' }}>
          {step === 0 && (
            <div>
              <p style={{ fontSize: 15, color: '#334155', lineHeight: 1.7, margin: '0 0 16px' }}>
                {current.content}
              </p>
              <p style={{ fontSize: 14, color: '#64748b', lineHeight: 1.6, margin: 0 }}>
                Hi {user?.name?.split(' ')[0] || 'there'} — let's take a quick look at how Aurelia works.
                {visibleLocations.length > 0 && (
                  <span> You have access to <strong>{visibleLocations.length} location{visibleLocations.length > 1 ? 's' : ''}</strong>.</span>
                )}
              </p>
            </div>
          )}

          {current.items && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {current.items.map((item, i) => {
                const Icon = item.icon
                return (
                  <div key={i} style={{
                    display: 'flex', alignItems: 'flex-start', gap: 14,
                    padding: '12px 14px', borderRadius: 12,
                    background: '#f8fafc', border: '1px solid #f1f5f9',
                  }}>
                    <div style={{
                      width: 36, height: 36, borderRadius: 10,
                      background: '#0f172a', display: 'flex', alignItems: 'center', justifyContent: 'center',
                      flexShrink: 0,
                    }}>
                      <Icon size={18} color="#F15D3B" />
                    </div>
                    <div>
                      <div style={{ fontSize: 14, fontWeight: 600, color: '#0f172a' }}>{item.label}</div>
                      <div style={{ fontSize: 13, color: '#64748b', marginTop: 2 }}>{item.desc}</div>
                    </div>
                  </div>
                )
              })}
            </div>
          )}

          {current.final && (
            <div>
              <p style={{ fontSize: 15, color: '#334155', lineHeight: 1.7, margin: '0 0 16px' }}>
                {current.content}
              </p>
              <div style={{
                padding: '14px 18px', borderRadius: 12,
                background: '#f0fdf4', border: '1px solid #bbf7d0',
                display: 'flex', alignItems: 'center', gap: 10,
              }}>
                <Check size={18} color="#1D9E75" />
                <span style={{ fontSize: 14, color: '#166534', fontWeight: 500 }}>
                  You're ready to go. Your P&L builds itself as you enter data.
                </span>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div style={{
          padding: '16px 32px 28px', display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        }}>
          <button onClick={skip} style={{
            fontSize: 13, color: '#94a3b8', background: 'none', border: 'none', cursor: 'pointer',
          }}>
            Skip tour
          </button>
          <button onClick={next} style={{
            display: 'flex', alignItems: 'center', gap: 8,
            padding: '10px 24px', fontSize: 14, fontWeight: 600,
            background: isLast ? '#1D9E75' : '#0f172a', color: '#fff',
            border: 'none', borderRadius: 10, cursor: 'pointer',
            transition: 'background 0.2s',
          }}>
            {isLast ? 'Go to Sales' : 'Next'}
            <ArrowRight size={16} />
          </button>
        </div>
      </div>
    </div>
  )
}
