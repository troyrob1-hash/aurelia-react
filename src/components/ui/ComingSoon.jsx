import { Construction } from 'lucide-react'

export default function ComingSoon({ title }) {
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center',
      justifyContent: 'center', minHeight: '60vh', gap: 16, color: '#9ca3af'
    }}>
      <Construction size={40} strokeWidth={1.2} />
      <div style={{ fontSize: 20, fontWeight: 700, color: '#1a1a1a' }}>{title}</div>
      <div style={{ fontSize: 14 }}>This module is being migrated to React. Coming soon.</div>
    </div>
  )
}
