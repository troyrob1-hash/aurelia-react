/**
 * Directions.jsx — dumb renderer for the Help & Directions page (/directions).
 *
 * ALL copy lives in src/content/directions.js. This file only lays it out. If you
 * want to change wording, edit directions.js, not this component.
 *
 * The one bit of logic here: any `[TROY: ...]` marker in the copy is pulled out and
 * rendered as a visible highlighted callout so unanswered process questions are
 * obvious, never buried in a paragraph.
 */
import { HelpCircle, Upload, AlertTriangle, ListChecks } from 'lucide-react'
import { INTRO, TABS, FAQ } from '@/content/directions'

const C = {
  ink: '#0f172a', sub: '#475569', faint: '#64748b', line: '#e2e8f0',
  orange: '#F15D3B', troyBg: '#FEF3C7', troyBorder: '#F59E0B', troyInk: '#92400E',
  gotchaBg: '#FEF2F2', gotchaBorder: '#FCA5A5', gotchaInk: '#991B1B',
}

// Split a string on [TROY: ...] markers; return an array of text + highlighted nodes.
function renderText(text, keyBase) {
  const parts = String(text).split(/(\[TROY:[^\]]*\])/g)
  return parts.map((part, i) => {
    const m = part.match(/^\[TROY:\s*([\s\S]*?)\]$/)
    if (m) {
      return (
        <span key={`${keyBase}-t${i}`} style={{
          display: 'inline', background: C.troyBg, color: C.troyInk,
          borderBottom: `2px solid ${C.troyBorder}`, borderRadius: 3,
          padding: '1px 6px', fontWeight: 600, fontSize: '0.92em',
        }}>
          <strong style={{ letterSpacing: '0.03em' }}>TROY:</strong> {m[1]}
        </span>
      )
    }
    // preserve intentional line breaks in body copy
    return part.split('\n').map((line, j, arr) => (
      <span key={`${keyBase}-p${i}-${j}`}>{line}{j < arr.length - 1 ? <br /> : null}</span>
    ))
  })
}

// A standalone [TROY: ...] callout block (for tab.troy entries).
function TroyCallout({ text }) {
  const inner = String(text).replace(/^\[TROY:\s*/, '').replace(/\]$/, '')
  return (
    <div style={{
      display: 'flex', gap: 10, alignItems: 'flex-start',
      background: C.troyBg, border: `1px solid ${C.troyBorder}`,
      borderRadius: 10, padding: '10px 14px', margin: '8px 0',
    }}>
      <HelpCircle size={16} style={{ color: C.troyInk, flexShrink: 0, marginTop: 2 }} />
      <div style={{ fontSize: 13.5, color: C.troyInk, lineHeight: 1.5 }}>
        <strong style={{ letterSpacing: '0.04em' }}>TROY — needs your answer:</strong> {inner}
      </div>
    </div>
  )
}

function SectionLabel({ icon: Icon, children }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 6,
      fontSize: 11, fontWeight: 700, letterSpacing: '0.06em',
      textTransform: 'uppercase', color: C.faint, margin: '16px 0 8px',
    }}>
      <Icon size={13} /> {children}
    </div>
  )
}

function Upload_({ up, keyBase }) {
  return (
    <div style={{ border: `1px solid ${C.line}`, borderRadius: 10, padding: '12px 14px', marginBottom: 10 }}>
      <div style={{ fontSize: 14, fontWeight: 700, color: C.ink }}>{up.name}</div>
      {up.note && (
        <div style={{ fontSize: 13, color: C.sub, lineHeight: 1.5, marginTop: 4 }}>
          {renderText(up.note, `${keyBase}-note`)}
        </div>
      )}
      {up.columns?.length > 0 && (
        <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 10 }}>
          <tbody>
            {up.columns.map((col, i) => (
              <tr key={i} style={{ borderTop: i ? `1px solid ${C.line}` : 'none' }}>
                <td style={{
                  padding: '6px 10px 6px 0', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                  fontSize: 12.5, fontWeight: 600, color: C.orange, whiteSpace: 'nowrap', verticalAlign: 'top',
                }}>{col.col}</td>
                <td style={{ padding: '6px 0', fontSize: 13, color: C.sub, lineHeight: 1.45 }}>{col.desc}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

function CalloutList({ items, variant, keyBase }) {
  const isGotcha = variant === 'gotcha'
  return (
    <div style={{
      background: isGotcha ? C.gotchaBg : '#F8FAFC',
      border: `1px solid ${isGotcha ? C.gotchaBorder : C.line}`,
      borderRadius: 10, padding: '10px 14px',
    }}>
      {items.map((it, i) => (
        <div key={i} style={{ display: 'flex', gap: 9, alignItems: 'flex-start', padding: '4px 0' }}>
          {isGotcha && <AlertTriangle size={15} style={{ color: C.gotchaInk, flexShrink: 0, marginTop: 2 }} />}
          <div style={{ fontSize: 13.5, color: isGotcha ? C.gotchaInk : C.sub, lineHeight: 1.5 }}>
            {renderText(it, `${keyBase}-${i}`)}
          </div>
        </div>
      ))}
    </div>
  )
}

export default function Directions() {
  return (
    <div style={{ maxWidth: 860, margin: '0 auto', paddingBottom: 60 }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
        <div style={{
          width: 40, height: 40, borderRadius: 10, background: '#FEECE7',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <HelpCircle size={22} style={{ color: C.orange }} />
        </div>
        <h1 style={{ fontSize: 24, fontWeight: 800, color: C.ink, margin: 0 }}>{INTRO.heading}</h1>
      </div>
      <p style={{ fontSize: 15, color: C.sub, lineHeight: 1.6, margin: '0 0 20px' }}>{INTRO.lede}</p>

      {/* Intro blocks */}
      <div style={{ display: 'grid', gap: 10, marginBottom: 12 }}>
        {INTRO.blocks.map((b, i) => (
          <div key={i} style={{ border: `1px solid ${C.line}`, borderRadius: 12, padding: '14px 16px' }}>
            <div style={{ fontSize: 14.5, fontWeight: 700, color: C.ink, marginBottom: 4 }}>{b.h}</div>
            <div style={{ fontSize: 13.5, color: C.sub, lineHeight: 1.55 }}>{renderText(b.body, `intro-${i}`)}</div>
          </div>
        ))}
      </div>

      {/* Jump nav */}
      <div style={{
        display: 'flex', flexWrap: 'wrap', gap: 8, padding: '12px 0 20px',
        borderBottom: `1px solid ${C.line}`, marginBottom: 8,
      }}>
        {TABS.map(t => (
          <a key={t.id} href={`#${t.id}`} style={{
            fontSize: 12.5, fontWeight: 600, color: C.sub, textDecoration: 'none',
            background: '#F1F5F9', borderRadius: 999, padding: '5px 12px',
          }}>{t.navLabel}</a>
        ))}
        <a href="#faq" style={{
          fontSize: 12.5, fontWeight: 600, color: C.orange, textDecoration: 'none',
          background: '#FEECE7', borderRadius: 999, padding: '5px 12px',
        }}>FAQ</a>
      </div>

      {/* Per-tab sections */}
      {TABS.map(tab => (
        <section key={tab.id} id={tab.id} style={{ scrollMarginTop: 20, padding: '24px 0', borderBottom: `1px solid ${C.line}` }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
            <h2 style={{ fontSize: 20, fontWeight: 800, color: C.ink, margin: 0 }}>{tab.navLabel}</h2>
            <span style={{ fontSize: 12.5, color: C.faint }}>
              {tab.navLabel !== tab.urlName ? `“${tab.urlName}” · ` : ''}{tab.url}
            </span>
          </div>
          <p style={{ fontSize: 14.5, color: C.sub, lineHeight: 1.6, margin: '8px 0 4px' }}>
            {renderText(tab.purpose, `${tab.id}-purpose`)}
          </p>

          {tab.workflow?.length > 0 && (
            <>
              <SectionLabel icon={ListChecks}>How to use it</SectionLabel>
              <ol style={{ margin: 0, paddingLeft: 20 }}>
                {tab.workflow.map((step, i) => (
                  <li key={i} style={{ fontSize: 14, color: C.sub, lineHeight: 1.55, marginBottom: 5 }}>
                    {renderText(step, `${tab.id}-wf-${i}`)}
                  </li>
                ))}
              </ol>
            </>
          )}

          {tab.uploads?.length > 0 && (
            <>
              <SectionLabel icon={Upload}>Uploads it accepts</SectionLabel>
              {tab.uploads.map((up, i) => <Upload_ key={i} up={up} keyBase={`${tab.id}-up-${i}`} />)}
            </>
          )}

          {tab.extra?.length > 0 && tab.extra.map((ex, i) => (
            <div key={i} style={{ marginTop: 14 }}>
              <div style={{ fontSize: 14.5, fontWeight: 700, color: C.ink, marginBottom: 4 }}>{ex.h}</div>
              <div style={{ fontSize: 13.5, color: C.sub, lineHeight: 1.6 }}>{renderText(ex.body, `${tab.id}-ex-${i}`)}</div>
            </div>
          ))}

          {tab.gotchas?.length > 0 && (
            <>
              <SectionLabel icon={AlertTriangle}>Watch out</SectionLabel>
              <CalloutList items={tab.gotchas} variant="gotcha" keyBase={`${tab.id}-g`} />
            </>
          )}

          {tab.troy?.length > 0 && (
            <div style={{ marginTop: 12 }}>
              {tab.troy.map((t, i) => <TroyCallout key={i} text={t} />)}
            </div>
          )}
        </section>
      ))}

      {/* FAQ */}
      <section id="faq" style={{ scrollMarginTop: 20, paddingTop: 24 }}>
        <h2 style={{ fontSize: 20, fontWeight: 800, color: C.ink, margin: '0 0 12px' }}>FAQ</h2>
        <div style={{ display: 'grid', gap: 10 }}>
          {FAQ.map((f, i) => (
            <div key={i} style={{ border: `1px solid ${C.line}`, borderRadius: 12, padding: '14px 16px' }}>
              <div style={{ fontSize: 14.5, fontWeight: 700, color: C.ink, marginBottom: 5 }}>{f.q}</div>
              <div style={{ fontSize: 13.5, color: C.sub, lineHeight: 1.6 }}>{renderText(f.a, `faq-${i}`)}</div>
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}
