import { useState, useRef, useEffect } from 'react'
import { usePeriod } from '@/store/PeriodContext'
import { useLocations, cleanLocName } from '@/store/LocationContext'
import { usePnL } from '@/lib/usePnL'

const SYSTEM_PROMPT = `You are Aurelia, an AI financial assistant for Fooda restaurant operations. You help operators and directors understand their P&L, budget performance, and operational metrics.

You have access to the current period's P&L data. When answering:
- Be concise and direct — operators are busy
- Use dollar amounts and percentages
- Compare to budget when available
- Flag concerns proactively
- Suggest actions when relevant

Keep responses under 150 words unless asked for detail.`

export default function AureliaChat() {
  const [open, setOpen] = useState(false)
  const [messages, setMessages] = useState([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const scrollRef = useRef(null)
  const inputRef = useRef(null)

  const { periodKey, year, period } = usePeriod()
  const { selectedLocation } = useLocations()
  const location = selectedLocation === 'all' ? null : selectedLocation
  const { data: pnl } = usePnL(location, periodKey)

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight
  }, [messages])

  useEffect(() => {
    if (open && inputRef.current) inputRef.current.focus()
  }, [open])

  function buildContext() {
    const lines = []
    lines.push('Current period: ' + periodKey)
    lines.push('Location: ' + (location ? cleanLocName(location) : 'All Locations'))
    lines.push('')
    if (Object.keys(pnl).length > 0) {
      lines.push('P&L Data:')
      const fmt = v => typeof v === 'number' ? '$' + Math.round(v).toLocaleString() : String(v || '')
      if (pnl.gfs_popup) lines.push('  Popup GFS: ' + fmt(pnl.gfs_popup))
      if (pnl.gfs_catering) lines.push('  Catering GFS: ' + fmt(pnl.gfs_catering))
      if (pnl.gfs_retail) lines.push('  Retail GFS: ' + fmt(pnl.gfs_retail))
      if (pnl.gfs_total) lines.push('  Total GFS: ' + fmt(pnl.gfs_total))
      if (pnl.revenue_total) lines.push('  Net Revenue: ' + fmt(pnl.revenue_total))
      if (pnl.budget_gfs) lines.push('  Budget GFS: ' + fmt(pnl.budget_gfs))
      if (pnl.budget_revenue) lines.push('  Budget Revenue: ' + fmt(pnl.budget_revenue))
      if (pnl.budget_labor) lines.push('  Budget Labor: ' + fmt(pnl.budget_labor))
      if (pnl.budget_ebitda) lines.push('  Budget EBITDA: ' + fmt(pnl.budget_ebitda))
      // COGS
      const laborKeys = Object.keys(pnl).filter(k => k.startsWith('cogs_labor'))
      laborKeys.forEach(k => lines.push('  ' + k + ': ' + fmt(pnl[k])))
      // Expenses
      const expKeys = Object.keys(pnl).filter(k => k.startsWith('exp_'))
      expKeys.forEach(k => lines.push('  ' + k + ': ' + fmt(pnl[k])))
      // Budget fields
      const budgetKeys = Object.keys(pnl).filter(k => k.startsWith('budget_'))
      budgetKeys.forEach(k => {
        if (!lines.some(l => l.includes(k))) lines.push('  ' + k + ': ' + fmt(pnl[k]))
      })
    } else {
      lines.push('No P&L data loaded for this period/location.')
    }
    return lines.join('\n')
  }

  async function handleSend() {
    if (!input.trim() || loading) return
    const userMsg = input.trim()
    setInput('')
    setMessages(prev => [...prev, { role: 'user', text: userMsg }])
    setLoading(true)

    try {
      const context = buildContext()
      const response = await fetch('/api/claude', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 1000,
          system: SYSTEM_PROMPT + '\n\nCurrent financial data:\n' + context,
          messages: [
            ...messages.map(m => ({ role: m.role === 'user' ? 'user' : 'assistant', content: m.text })),
            { role: 'user', content: userMsg }
          ],
        })
      })
      const data = await response.json()
      const reply = data.content?.[0]?.text || 'Sorry, I could not process that request.'
      setMessages(prev => [...prev, { role: 'assistant', text: reply }])
    } catch (err) {
      setMessages(prev => [...prev, { role: 'assistant', text: 'Error: ' + (err.message || 'Failed to connect') }])
    }
    setLoading(false)
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        style={{
          position: 'fixed', bottom: 24, right: 24, zIndex: 9999,
          width: 56, height: 56, borderRadius: '50%',
          background: '#0f172a', color: '#fff', border: 'none',
          cursor: 'pointer', fontSize: 24, fontWeight: 700,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          boxShadow: '0 4px 20px rgba(0,0,0,0.15)',
          transition: 'transform 0.15s',
        }}
        onMouseEnter={e => e.currentTarget.style.transform = 'scale(1.08)'}
        onMouseLeave={e => e.currentTarget.style.transform = 'scale(1)'}
        title="Ask Aurelia"
      >
        A
      </button>
    )
  }

  return (
    <div style={{
      position: 'fixed', bottom: 24, right: 24, zIndex: 9999,
      width: 380, height: 520,
      background: '#fff', borderRadius: 16,
      border: '1px solid #e2e8f0',
      boxShadow: '0 8px 40px rgba(0,0,0,0.12)',
      display: 'flex', flexDirection: 'column',
      overflow: 'hidden',
    }}>
      <div style={{
        padding: '14px 18px', background: '#0f172a', color: '#fff',
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      }}>
        <div>
          <div style={{ fontSize: 15, fontWeight: 600 }}>Aurelia AI</div>
          <div style={{ fontSize: 11, opacity: 0.7 }}>{location ? cleanLocName(location) : 'All Locations'} · {periodKey}</div>
        </div>
        <button onClick={() => setOpen(false)} style={{
          background: 'none', border: 'none', color: '#fff', fontSize: 18,
          cursor: 'pointer', padding: 4, opacity: 0.7,
        }}>x</button>
      </div>

      <div ref={scrollRef} style={{
        flex: 1, overflowY: 'auto', padding: '12px 16px',
        display: 'flex', flexDirection: 'column', gap: 10,
      }}>
        {messages.length === 0 && (
          <div style={{ textAlign: 'center', padding: '40px 20px', color: '#94a3b8' }}>
            <div style={{ fontSize: 28, marginBottom: 8 }}>A</div>
            <div style={{ fontSize: 13, fontWeight: 500 }}>Ask me about your financials</div>
            <div style={{ fontSize: 12, marginTop: 8, lineHeight: 1.6 }}>
              Try: "How am I tracking vs budget?"<br/>
              "Why is labor high this week?"<br/>
              "Summarize my P&L"
            </div>
          </div>
        )}
        {messages.map((msg, i) => (
          <div key={i} style={{
            alignSelf: msg.role === 'user' ? 'flex-end' : 'flex-start',
            maxWidth: '85%',
            padding: '10px 14px',
            borderRadius: msg.role === 'user' ? '14px 14px 4px 14px' : '14px 14px 14px 4px',
            background: msg.role === 'user' ? '#0f172a' : '#f1f5f9',
            color: msg.role === 'user' ? '#fff' : '#0f172a',
            fontSize: 13, lineHeight: 1.5,
            whiteSpace: 'pre-wrap',
          }}>
            {msg.text}
          </div>
        ))}
        {loading && (
          <div style={{
            alignSelf: 'flex-start', padding: '10px 14px',
            background: '#f1f5f9', borderRadius: '14px 14px 14px 4px',
            fontSize: 13, color: '#94a3b8',
          }}>
            Thinking...
          </div>
        )}
      </div>

      <div style={{
        padding: '10px 12px', borderTop: '1px solid #e2e8f0',
        display: 'flex', gap: 8,
      }}>
        <input
          ref={inputRef}
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && handleSend()}
          placeholder="Ask about your P&L..."
          style={{
            flex: 1, padding: '10px 14px', fontSize: 13,
            border: '1px solid #e2e8f0', borderRadius: 10,
            outline: 'none', background: '#f8fafc',
          }}
        />
        <button
          onClick={handleSend}
          disabled={loading || !input.trim()}
          style={{
            padding: '10px 16px', fontSize: 13, fontWeight: 600,
            background: loading || !input.trim() ? '#e2e8f0' : '#0f172a',
            color: loading || !input.trim() ? '#94a3b8' : '#fff',
            border: 'none', borderRadius: 10, cursor: 'pointer',
          }}
        >
          Send
        </button>
      </div>
    </div>
  )
}
