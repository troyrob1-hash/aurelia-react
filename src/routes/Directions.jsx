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
import { HelpCircle, Upload, AlertTriangle, ListChecks, Rocket, ClipboardList, Star, CalendarClock } from 'lucide-react'
import { INTRO, START_HERE, REPORTS_INTRO, REPORTS, CADENCE, TABS, FAQ } from '@/content/directions'

const C = {
  ink: '#0f172a', sub: '#475569', faint: '#64748b', line: '#e2e8f0',
  orange: '#F15D3B', troyBg: '#FEF3C7', troyBorder: '#F59E0B', troyInk: '#92400E',
  gotchaBg: '#FEF2F2', gotchaBorder: '#FCA5A5', gotchaInk: '#991B1B',
  liveBg: '#ECFDF5', liveBorder: '#6EE7B7', liveInk: '#047857',
  comeBg: '#FEF3C7', comeBorder: '#F59E0B', comeInk: '#92400E',
  mono: 'ui-monospace, SFMono-Regular, Menlo, monospace',
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
    return part.split('\n').map((line, j, arr) => (
      <span key={`${keyBase}-p${i}-${j}`}>{line}{j < arr.length - 1 ? <br /> : null}</span>
    ))
  })
}

// Live / Coming / Reference pill.
function Tag({ tag, manual, status }) {
  const reference = status === 'reference'
  const live = !reference && tag === 'live'
  const label = reference ? 'Reference only' : live ? 'Live in Aurelia' : manual ? 'Manual log · Coming' : 'Coming'
  const bg = reference ? '#f1f5f9' : live ? C.liveBg : C.comeBg
  const ink = reference ? '#64748b' : live ? C.liveInk : C.comeInk
  const border = reference ? '#e2e8f0' : live ? C.liveBorder : C.comeBorder
  return (
    <span style={{
      fontSize: 10.5, fontWeight: 700, letterSpacing: '0.03em', textTransform: 'uppercase',
      padding: '2px 8px', borderRadius: 999, whiteSpace: 'nowrap',
      background: bg, color: ink, border: `1px solid ${border}`,
    }}>{label}</span>
  )
}

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
                  padding: '6px 10px 6px 0', fontFamily: C.mono,
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

// ── Reports front-door table — ACTIVE reports Aurelia actually uses (file imports).
// The manual non-invoiced-purchases log and the reference-only reports render below. ──
function ReportsTable() {
  const rows = REPORTS.filter(r => r.status === 'active' && !r.manual)
  const th = { textAlign: 'left', fontSize: 10.5, fontWeight: 700, letterSpacing: '0.05em',
    textTransform: 'uppercase', color: C.faint, padding: '8px 10px', borderBottom: `1px solid ${C.line}` }
  const td = { fontSize: 12.5, color: C.sub, padding: '9px 10px', borderBottom: `1px solid ${C.line}`, verticalAlign: 'top', lineHeight: 1.4 }
  return (
    <div style={{ overflowX: 'auto', border: `1px solid ${C.line}`, borderRadius: 12, marginTop: 12 }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 720 }}>
        <thead>
          <tr>
            <th style={th}>Report</th>
            <th style={th}>Where</th>
            <th style={th}>Export as</th>
            <th style={th}>Cadence</th>
            <th style={th}>Feeds in Aurelia</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.id}>
              <td style={{ ...td, minWidth: 150 }}>
                <a href={`#${r.id}`} style={{ color: C.ink, fontWeight: 700, textDecoration: 'none' }}>
                  {r.num}. {r.name}
                </a>
                <div style={{ fontSize: 11.5, color: C.faint, marginTop: 2 }}>{r.report}</div>
              </td>
              <td style={td}>{r.where}</td>
              <td style={{ ...td, fontFamily: C.mono, fontSize: 11.5 }}>{r.format || '—'}</td>
              <td style={{ ...td, whiteSpace: 'nowrap' }}>{r.cadence}</td>
              <td style={td}>{r.feeds}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ── Reference-only strip: reports Aurelia does NOT ingest (covered elsewhere / not tracked). ──
function ReferenceReports() {
  const refs = REPORTS.filter(r => r.status === 'reference')
  if (!refs.length) return null
  return (
    <div style={{ marginTop: 16, padding: '12px 14px', border: `1px dashed ${C.line}`, borderRadius: 12, background: '#fafbfc' }}>
      <div style={{ fontSize: 12.5, fontWeight: 800, color: C.sub, textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 8 }}>
        Reference only — Aurelia doesn’t pull these
      </div>
      {refs.map(r => (
        <div key={r.id} style={{ fontSize: 12.5, color: C.sub, lineHeight: 1.5, marginBottom: 6 }}>
          <strong style={{ color: C.ink }}>{r.name}</strong> · <span style={{ fontFamily: C.mono, fontSize: 11.5 }}>{r.report}</span> ({r.where})
          <div style={{ color: C.faint, marginTop: 1 }}>{r.refNote}</div>
        </div>
      ))}
    </div>
  )
}

// ── Per-report detail card ──
function ReportCard({ r }) {
  const reference = r.status === 'reference'
  const live = !reference && r.tag === 'live'
  return (
    <section id={r.id} style={{ scrollMarginTop: 20, border: `1px solid ${C.line}`, borderRadius: 12, padding: '16px 18px', marginBottom: 12, opacity: reference ? 0.85 : 1 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 4 }}>
        <h3 style={{ fontSize: 16.5, fontWeight: 800, color: C.ink, margin: 0 }}>{r.num ? `${r.num}. ` : ''}{r.name}</h3>
        <Tag tag={r.tag} manual={r.manual} status={r.status} />
        <span style={{ fontSize: 12, color: C.faint }}>· {r.cadence}</span>
      </div>
      <div style={{ fontSize: 13, color: C.sub, marginBottom: 10 }}>
        <strong style={{ color: C.ink }}>{r.where}</strong>
        {r.report ? <> — <span style={{ fontFamily: C.mono, fontSize: 12.5 }}>{r.report}</span></> : null}
        {r.format && r.format !== '—' ? <> · export as <strong style={{ color: C.ink }}>{r.format}</strong></> : null}
      </div>

      <SectionLabel icon={ListChecks}>How to pull it</SectionLabel>
      <ol style={{ margin: 0, paddingLeft: 20 }}>
        {r.steps.map((s, i) => (
          <li key={i} style={{ fontSize: 13.5, color: C.sub, lineHeight: 1.55, marginBottom: 5 }}>{renderText(s, `${r.id}-s-${i}`)}</li>
        ))}
      </ol>

      {r.columns?.length > 0 && (
        <>
          <SectionLabel icon={ClipboardList}>Columns in the export</SectionLabel>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {r.columns.map((col, i) => (
              <span key={i} style={{
                fontFamily: C.mono, fontSize: 12, color: C.orange,
                background: '#FFF5F2', border: `1px solid #FBD5C9`, borderRadius: 6, padding: '2px 7px',
              }}>{col}</span>
            ))}
          </div>
        </>
      )}

      {r.notes?.length > 0 && (
        <div style={{ marginTop: 12 }}><CalloutList items={r.notes} variant="note" keyBase={`${r.id}-n`} /></div>
      )}

      <div style={{
        marginTop: 12, padding: '10px 14px', borderRadius: 10,
        background: reference ? '#f1f5f9' : live ? C.liveBg : C.comeBg,
        border: `1px solid ${reference ? '#e2e8f0' : live ? C.liveBorder : C.comeBorder}`,
        fontSize: 13.5, color: reference ? '#475569' : live ? C.liveInk : C.comeInk, lineHeight: 1.5,
      }}>
        <strong>{reference ? 'Reference only: ' : live ? 'What Aurelia does: ' : 'Not wired yet: '}</strong>{r.refNote || r.aurelia}
      </div>
    </section>
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

      {/* Start here */}
      <div style={{
        background: '#FEF7ED', border: `1.5px solid ${C.orange}`, borderRadius: 12,
        padding: '16px 18px', margin: '4px 0 12px',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
          <Rocket size={18} style={{ color: C.orange }} />
          <h2 style={{ fontSize: 17, fontWeight: 800, color: C.ink, margin: 0 }}>{START_HERE.heading}</h2>
        </div>
        {START_HERE.body.map((para, i) => (
          <p key={i} style={{ fontSize: 14, color: C.sub, lineHeight: 1.6, margin: i ? '8px 0 0' : 0 }}>
            {renderText(para, `start-${i}`)}
          </p>
        ))}
      </div>

      {/* ── Reports to pull (the front door) ── */}
      <section id="reports" style={{ scrollMarginTop: 20, paddingTop: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
          <ClipboardList size={20} style={{ color: C.orange }} />
          <h2 style={{ fontSize: 20, fontWeight: 800, color: C.ink, margin: 0 }}>{REPORTS_INTRO.heading}</h2>
        </div>
        <p style={{ fontSize: 14, color: C.sub, lineHeight: 1.6, margin: '0 0 8px' }}>{REPORTS_INTRO.lede}</p>

        {/* Tableau tip */}
        <div style={{
          display: 'flex', gap: 10, alignItems: 'flex-start',
          background: '#F8FAFC', border: `1px solid ${C.line}`, borderRadius: 10, padding: '10px 14px', marginBottom: 4,
        }}>
          <Star size={15} style={{ color: C.orange, flexShrink: 0, marginTop: 2 }} />
          <div style={{ fontSize: 13, color: C.sub, lineHeight: 1.5 }}>
            {REPORTS_INTRO.tableauTip}{' '}
            <a href={REPORTS_INTRO.tableauHome} target="_blank" rel="noreferrer" style={{ color: C.orange, fontWeight: 600 }}>
              Tableau home ↗
            </a>
          </div>
        </div>

        {/* Operating notes — Crosstab CSV, fiscal weeks, the 20th */}
        {REPORTS_INTRO.operatingNotes?.length > 0 && (
          <ul style={{ margin: '8px 0 0', paddingLeft: 20 }}>
            {REPORTS_INTRO.operatingNotes.map((n, i) => (
              <li key={i} style={{ fontSize: 13, color: C.sub, lineHeight: 1.5, marginBottom: 4 }}>{renderText(n, `opnote-${i}`)}</li>
            ))}
          </ul>
        )}

        <ReportsTable />
        <ReferenceReports />

        {/* Cadence */}
        <div style={{ display: 'grid', gap: 12, gridTemplateColumns: '1fr 1fr', marginTop: 16 }}>
          {[CADENCE.weekly, CADENCE.monthEnd].map((band, i) => (
            <div key={i} style={{ border: `1px solid ${C.line}`, borderRadius: 10, padding: '12px 14px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 700, color: C.ink, marginBottom: 6 }}>
                <CalendarClock size={13} style={{ color: C.faint }} /> {band.label}
              </div>
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {band.items.map((it, j) => (
                  <li key={j} style={{ fontSize: 13, color: C.sub, lineHeight: 1.5, marginBottom: 3 }}>{it}</li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        <p style={{ fontSize: 13, color: C.sub, lineHeight: 1.55, margin: '10px 0 16px' }}>{renderText(CADENCE.note, 'cadence-note')}</p>

        {/* Per-report detail — active reports (incl. the manual non-invoiced log); the
            reference-only reports are summarised in the strip above, no full card. */}
        {REPORTS.filter(r => r.status !== 'reference').map(r => <ReportCard key={r.id} r={r} />)}
      </section>

      {/* Jump nav */}
      <div style={{
        display: 'flex', flexWrap: 'wrap', gap: 8, padding: '16px 0 20px',
        borderTop: `1px solid ${C.line}`, borderBottom: `1px solid ${C.line}`, margin: '12px 0 8px',
      }}>
        <a href="#reports" style={{
          fontSize: 12.5, fontWeight: 600, color: C.orange, textDecoration: 'none',
          background: '#FEECE7', borderRadius: 999, padding: '5px 12px',
        }}>Reports</a>
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
