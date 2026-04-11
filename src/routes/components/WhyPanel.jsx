// src/routes/components/WhyPanel.jsx
//
// Side drawer that slides in from the right when a P&L line is clicked.
// Shows an auto-generated narrative explaining what drove the number,
// along with contributing factors (transactions, deltas) and a 12-period
// trend chart for the specific line.
//
// Architecture:
// - Receives the clicked line object + current value + the whole pnl/priorPnl/history context
// - Dispatches to the right rules engine based on line.key via whyRules.js
// - Rules engines return a structured narrative: { headline, bullets[], factors[], drillTo? }
// - Rules engines can be sync (aggregate-only) or async (load from source collections)
// - Panel handles the loading state while async rules run

import { useState, useEffect } from 'react'
import { X, ExternalLink } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { buildWhyNarrative } from '@/lib/whyRules'

export default function WhyPanel({
  line,
  actual,
  budget,
  prior,
  periodKey,
  history,
  trailingKeys,
  orgId,
  location,
  isAllLocations,
  onClose,
}) {
  const navigate = useNavigate()
  const [narrative, setNarrative] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    ;(async () => {
      try {
        const result = await buildWhyNarrative({
          line, actual, budget, prior, periodKey,
          history, trailingKeys,
          orgId, location, isAllLocations,
        })
        if (!cancelled) {
          setNarrative(result)
          setLoading(false)
        }
      } catch (e) {
        console.error('buildWhyNarrative failed:', e)
        if (!cancelled) {
          setError(e.message || 'Unable to build narrative')
          setLoading(false)
        }
      }
    })()
    return () => { cancelled = true }
  }, [line?.key, periodKey, location, actual, budget, prior])

  // ESC to close
  useEffect(() => {
    const handler = e => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [onClose])

  if (!line) return null

  const fmt$ = v => {
    if (v == null || isNaN(v)) return '—'
    return '$' + Math.round(v).toLocaleString('en-US')
  }

  return (
    <>
      {/* Backdrop */}
      <div
        onClick={onClose}
        style={{
          position: 'fixed', inset: 0,
          background: 'rgba(15, 23, 42, 0.3)',
          zIndex: 2900,
          animation: 'whyFadeIn 120ms ease-out',
        }}
      />

      {/* Panel */}
      <aside
        style={{
          position: 'fixed', top: 0, right: 0, bottom: 0,
          width: 480, maxWidth: '90vw',
          background: '#fff',
          borderLeft: '0.5px solid #e5e7eb',
          boxShadow: '-20px 0 60px rgba(15, 23, 42, 0.1)',
          zIndex: 3000,
          display: 'flex', flexDirection: 'column',
          animation: 'whySlideIn 180ms cubic-bezier(0.16, 1, 0.3, 1)',
        }}
      >
        {/* Header */}
        <div style={{
          padding: '20px 24px 16px',
          borderBottom: '0.5px solid #e5e7eb',
          display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between',
          gap: 16,
        }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 11, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 500, marginBottom: 4 }}>
              Why
            </div>
            <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600, color: '#0f172a', letterSpacing: '-0.01em' }}>
              {line.label}
            </h2>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginTop: 8 }}>
              <span style={{ fontSize: 22, fontWeight: 500, color: '#0f172a', letterSpacing: '-0.01em' }}>
                {fmt$(actual)}
              </span>
              {budget != null && budget !== 0 && (
                <span style={{ fontSize: 12, color: '#64748b' }}>
                  budget {fmt$(budget)}
                </span>
              )}
              {prior != null && prior !== 0 && (
                <span style={{ fontSize: 12, color: '#64748b' }}>
                  prior {fmt$(prior)}
                </span>
              )}
            </div>
          </div>
          <button
            onClick={onClose}
            style={{
              background: 'none', border: 'none', cursor: 'pointer',
              padding: 4, color: '#94a3b8',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>

        {/* Body */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '20px 24px' }}>
          {loading && (
            <div style={{ color: '#94a3b8', fontSize: 13, padding: '20px 0' }}>
              Analyzing...
            </div>
          )}

          {!loading && error && (
            <div style={{ color: '#dc2626', fontSize: 13, padding: '12px 14px', background: '#fef2f2', borderRadius: 8, border: '0.5px solid #fecaca' }}>
              {error}
            </div>
          )}

          {!loading && narrative && (
            <>
              {/* Headline */}
              {narrative.headline && (
                <div style={{ fontSize: 14, color: '#0f172a', lineHeight: 1.55, marginBottom: 20 }}>
                  {narrative.headline}
                </div>
              )}

              {/* Bullets (key insights) */}
              {narrative.bullets?.length > 0 && (
                <div style={{ marginBottom: 24 }}>
                  <div style={{ fontSize: 11, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 500, marginBottom: 10 }}>
                    Key drivers
                  </div>
                  <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
                    {narrative.bullets.map((b, i) => (
                      <li key={i} style={{
                        display: 'flex', alignItems: 'flex-start', gap: 10,
                        fontSize: 13, color: '#0f172a', lineHeight: 1.5,
                      }}>
                        <span style={{
                          marginTop: 6,
                          width: 5, height: 5, borderRadius: '50%',
                          background: b.sign === 'up' ? '#dc2626' : b.sign === 'down' ? '#059669' : '#94a3b8',
                          flexShrink: 0,
                        }} />
                        <span>{b.text}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Contributing factors (structured breakdown) */}
              {narrative.factors?.length > 0 && (
                <div style={{ marginBottom: 24 }}>
                  <div style={{ fontSize: 11, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 500, marginBottom: 10 }}>
                    Contributing factors
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
                    {narrative.factors.map((f, i) => (
                      <div key={i} style={{
                        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                        padding: '10px 0',
                        borderBottom: i < narrative.factors.length - 1 ? '0.5px solid #f1f5f9' : 'none',
                      }}>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 13, color: '#0f172a', fontWeight: 500 }}>{f.label}</div>
                          {f.detail && (
                            <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 2 }}>{f.detail}</div>
                          )}
                        </div>
                        <div style={{
                          fontSize: 13, fontWeight: 500,
                          color: f.sign === 'up' ? '#dc2626' : f.sign === 'down' ? '#059669' : '#475569',
                          fontVariantNumeric: 'tabular-nums',
                        }}>
                          {f.value}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* No data state */}
              {!narrative.headline && !narrative.bullets?.length && !narrative.factors?.length && (
                <div style={{ fontSize: 13, color: '#94a3b8', padding: '20px 0' }}>
                  Not enough data yet to explain this line. Once activity flows into the tab, explanations will appear here.
                </div>
              )}

              {/* Drill-down link */}
              {(narrative.drillTo || line.drillTo) && (
                <button
                  onClick={() => { onClose(); navigate(narrative.drillTo || line.drillTo) }}
                  style={{
                    display: 'inline-flex', alignItems: 'center', gap: 6,
                    padding: '8px 14px', marginTop: 12,
                    fontSize: 12, fontWeight: 500,
                    color: '#475569',
                    background: '#fff',
                    border: '0.5px solid #e2e8f0',
                    borderRadius: 8,
                    cursor: 'pointer',
                  }}
                >
                  Open source tab <ExternalLink size={12} />
                </button>
              )}
            </>
          )}
        </div>
      </aside>

      <style>{`
        @keyframes whyFadeIn {
          from { opacity: 0 }
          to { opacity: 1 }
        }
        @keyframes whySlideIn {
          from { transform: translateX(100%) }
          to { transform: translateX(0) }
        }
      `}</style>
    </>
  )
}
