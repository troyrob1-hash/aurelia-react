// src/components/SalaryFjeModal.jsx
//
// GATE 3 — salary FJE entry. A GM enters an annual salary; this creates an
// amortizing journal entry on GL 50410 (cogs_labor_salaries) with a 364-day,
// week-aligned window (fiscal-year anchor, continuously chained year-over-year).
//
// STORES ONLY THE BASE SALARY. Burden (taxes/benefits/401k/bonus) is NEVER stored
// — it's derived at read-time by computeLaborBurden. The form PREVIEWS the loaded
// weekly cost so the entrant sees the full picture, but writes only the base.
//
// Read-time model: the JE is a journalEntries doc — it does NOT writePnL, so there
// is no per-week P&L write and thus no period-lock conflict (a closed week's salary
// just computes on read). On save we invalidateLedgerJEs() so every P&L reader
// picks the new salary up immediately.

import { useState } from 'react'
import { createPortal } from 'react-dom'
import { X, UserPlus } from 'lucide-react'
import { useAuthStore } from '@/store/authStore'
import { useLocations, cleanLocName } from '@/store/LocationContext'
import { usePeriod } from '@/store/PeriodContext'
import { useToast } from '@/components/ui/Toast'
import { db } from '@/lib/firebase'
import { collection, addDoc, getDocs, query, where, serverTimestamp } from 'firebase/firestore'
import { getLaborRates, computeLaborBurden, LABOR_RATE_FALLBACK } from '@/lib/pnl'
import { invalidateLedgerJEs, fiscalYearAnchor, nextAnnualWindowStart } from '@/lib/ledgerContributions'

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '')
const fmt$ = (v) => '$' + (Number(v) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

export default function SalaryFjeModal({ onSaved }) {
  const { user } = useAuthStore()
  const orgId = user?.tenantId
  const { selectedLocation } = useLocations()
  const { year } = usePeriod()
  const toast = useToast()

  const [open, setOpen] = useState(false)
  const [rates, setRates] = useState(LABOR_RATE_FALLBACK)
  const [annual, setAnnual] = useState('')
  const [person, setPerson] = useState('')
  const [fiscalYear, setFiscalYear] = useState(year || new Date().getFullYear())
  const [saving, setSaving] = useState(false)

  async function openForm() {
    setAnnual(''); setPerson(''); setFiscalYear(year || new Date().getFullYear())
    setRates(await getLaborRates().catch(() => LABOR_RATE_FALLBACK))
    setOpen(true)
  }

  // ── Burden PREVIEW (display only; derived, never written) ──
  const annualNum = parseFloat(String(annual).replace(/[$,\s]/g, '')) || 0
  const weeklyWages = annualNum / 52                                   // a full 7-day fiscal week = annual/52
  const b = computeLaborBurden(weeklyWages, 0, rates)                  // salary-only base (hourly = 0)
  const loaded = weeklyWages + b.cogs_labor_taxes + b.cogs_labor_benefits + b.cogs_labor_401k + b.cogs_labor_bonus
  const pct = (r) => (r * 100).toFixed(r < 0.05 ? 3 : 1).replace(/\.0+$/, '') + '%'

  async function save() {
    const loc = selectedLocation && selectedLocation !== 'all' ? selectedLocation : null
    if (!loc) { toast.error('Pick a specific location (not All Locations) to enter a salary.'); return }
    if (annualNum <= 0) { toast.error('Enter a positive annual salary.'); return }
    if (!person.trim()) { toast.error('Enter a person or role label.'); return }
    setSaving(true)
    try {
      // Continuous year-chaining: if this person already has a salary JE at this
      // location, anchor the new window to the day AFTER the latest one ends
      // (nextAnnualWindowStart = +364 → zero gap/overlap). Otherwise anchor to the
      // fiscal year's first Sun–Sat week (a Sunday → full weeks = annual/52).
      const personKey = norm(loc + '|' + person)
      const snap = await getDocs(query(
        collection(db, 'tenants', orgId, 'journalEntries'),
        where('jeType', '==', 'salary'), where('salaryPersonKey', '==', personKey),
      ))
      let windowStartDate = fiscalYearAnchor(Number(fiscalYear))
      const priors = snap.docs.map(d => d.data().windowStartDate).filter(Boolean).sort()
      if (priors.length) windowStartDate = nextAnnualWindowStart(priors[priors.length - 1])

      // BASE-ONLY write. No burden, no periods[], no writePnL — read-time model.
      await addDoc(collection(db, 'tenants', orgId, 'journalEntries'), {
        jeType: 'salary',
        glCode: 'cogs_labor_salaries',                 // ≡ NetSuite 50410
        glLabel: 'Onsite Labor (Fooda) Salaries and Wages',
        personLabel: person.trim(),
        salaryPersonKey: personKey,
        totalAmount: Math.round(annualNum * 100) / 100,   // ANNUAL base salary only
        amortization: 'annual',
        windowStartDate,                                // 364-day, week-aligned, chained
        fiscalYear: Number(fiscalYear),
        location: loc,
        description: `Salary FJE: ${person.trim()} (FY${fiscalYear})`,
        createdBy: user?.name || user?.email || 'unknown',
        createdAt: serverTimestamp(),
        status: 'posted',
      })

      invalidateLedgerJEs()                             // read-time cache picks it up immediately
      setOpen(false)
      toast.success(`Salary FJE saved — ${fmt$(annualNum)}/yr → ${fmt$(loaded)}/wk loaded, derived to the weekly P&L`)
      onSaved?.()
    } catch (e) {
      console.error('Salary FJE save failed:', e)
      toast.error('Save failed — ' + (e?.message || ''))
    }
    setSaving(false)
  }

  const S = STYLES
  return (
    <>
      <button style={S.btn} onClick={openForm}><UserPlus size={14} /> Add Salary (FJE)</button>

      {open && createPortal(
        <div style={S.overlay} onClick={() => !saving && setOpen(false)}>
          <div style={S.modal} onClick={e => e.stopPropagation()}>
            <div style={S.head}>
              <div>
                <div style={S.title}>Salaried person — annual FJE</div>
                <div style={S.sub}>{selectedLocation && selectedLocation !== 'all' ? cleanLocName(selectedLocation) : '⚠ pick a location'} · amortizes to GL 50410 weekly</div>
              </div>
              <button style={S.x} onClick={() => !saving && setOpen(false)}><X size={18} /></button>
            </div>

            <div style={S.body}>
              <label style={S.label}>Person / role</label>
              <input style={S.input} value={person} onChange={e => setPerson(e.target.value)} placeholder="e.g. Café Manager — J. Rivera" autoFocus />

              <div style={{ display: 'flex', gap: 12 }}>
                <div style={{ flex: 2 }}>
                  <label style={S.label}>Annual salary</label>
                  <input style={S.input} value={annual} onChange={e => setAnnual(e.target.value)} placeholder="80,000" inputMode="decimal" />
                </div>
                <div style={{ flex: 1 }}>
                  <label style={S.label}>Fiscal year</label>
                  <input style={S.input} value={fiscalYear} onChange={e => setFiscalYear(e.target.value)} inputMode="numeric" />
                </div>
              </div>

              {/* ── Loaded-cost preview (derived; NOT written) ── */}
              <div style={S.preview}>
                <div style={S.previewHead}>Loaded weekly cost <span style={S.derivedTag}>derived · not stored</span></div>
                {annualNum > 0 ? (
                  <>
                    <div style={S.big}>{fmt$(annualNum)}/yr → <b>{fmt$(loaded)}/wk loaded</b></div>
                    <table style={S.tbl}><tbody>
                      <tr><td style={S.tdL}>Wages (base — the ONLY thing stored)</td><td style={S.tdR}><b>{fmt$(weeklyWages)}</b></td><td style={S.tdP}>annual/52</td></tr>
                      <tr><td style={S.tdL}>+ Benefits</td><td style={S.tdR}>{fmt$(b.cogs_labor_benefits)}</td><td style={S.tdP}>{pct(rates.benefitsRate)} · salary+hourly</td></tr>
                      <tr><td style={S.tdL}>+ Taxes</td><td style={S.tdR}>{fmt$(b.cogs_labor_taxes)}</td><td style={S.tdP}>{pct(rates.taxRate)} · salary+hourly</td></tr>
                      <tr><td style={S.tdL}>+ 401k</td><td style={S.tdR}>{fmt$(b.cogs_labor_401k)}</td><td style={S.tdP}>{pct(rates.retirement401kRate)} · salary+hourly</td></tr>
                      <tr><td style={S.tdL}>+ Bonus</td><td style={S.tdR}>{fmt$(b.cogs_labor_bonus)}</td><td style={S.tdP}>{pct(rates.bonusRate)} · salary only</td></tr>
                      <tr><td style={S.tdLt}><b>= Loaded / week</b></td><td style={S.tdRt}><b>{fmt$(loaded)}</b></td><td style={S.tdP}></td></tr>
                    </tbody></table>
                    <div style={S.note}>Full 7-day weeks post {fmt$(weeklyWages)}; month-boundary weeks split by day. Rates from settings/laborRates.</div>
                  </>
                ) : <div style={S.muted}>Enter an annual salary to preview the loaded weekly cost.</div>}
              </div>
            </div>

            <div style={S.foot}>
              <button style={S.cancel} onClick={() => setOpen(false)} disabled={saving}>Cancel</button>
              <button style={{ ...S.confirm, opacity: (annualNum <= 0 || !person.trim() || saving) ? 0.5 : 1 }}
                      onClick={save} disabled={annualNum <= 0 || !person.trim() || saving}>
                {saving ? 'Saving…' : `Save salary base (${fmt$(annualNum)}/yr)`}
              </button>
            </div>
          </div>
        </div>, document.body)}
    </>
  )
}

const STYLES = {
  btn: { display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer', background: '#7c3aed', color: '#fff', padding: '8px 14px', borderRadius: 8, fontSize: 13, fontWeight: 600, border: 'none' },
  overlay: { position: 'fixed', inset: 0, background: 'rgba(15,23,42,.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 10000, padding: 20 },
  modal: { background: '#fff', borderRadius: 14, width: 'min(560px,96vw)', maxHeight: '90vh', display: 'flex', flexDirection: 'column', boxShadow: '0 20px 60px rgba(0,0,0,.3)' },
  head: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', padding: '16px 20px', borderBottom: '1px solid #e2e8f0' },
  title: { fontSize: 16, fontWeight: 800, color: '#0f172a' }, sub: { fontSize: 12, color: '#64748b', marginTop: 2 },
  x: { background: 'none', border: 'none', cursor: 'pointer', color: '#64748b' },
  body: { padding: '14px 20px', overflow: 'auto' },
  label: { display: 'block', fontSize: 12, fontWeight: 600, color: '#475569', margin: '10px 0 4px' },
  input: { width: '100%', boxSizing: 'border-box', padding: '9px 12px', borderRadius: 8, border: '1px solid #cbd5e1', fontSize: 14 },
  preview: { marginTop: 16, background: '#faf5ff', border: '1px solid #e9d5ff', borderRadius: 10, padding: '12px 14px' },
  previewHead: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 13, fontWeight: 700, color: '#0f172a' },
  derivedTag: { fontSize: 10, fontWeight: 700, color: '#7c3aed', background: '#f3e8ff', padding: '2px 8px', borderRadius: 999, textTransform: 'uppercase', letterSpacing: .4 },
  big: { fontSize: 15, color: '#0f172a', margin: '8px 0 6px' },
  tbl: { width: '100%', borderCollapse: 'collapse', fontSize: 13 },
  tdL: { padding: '3px 0', color: '#334155' }, tdR: { padding: '3px 0', textAlign: 'right', color: '#0f172a', fontVariantNumeric: 'tabular-nums' },
  tdP: { padding: '3px 0 3px 12px', color: '#94a3b8', fontSize: 11 },
  tdLt: { padding: '6px 0 0', color: '#0f172a', borderTop: '1px solid #e9d5ff' }, tdRt: { padding: '6px 0 0', textAlign: 'right', color: '#7c3aed', borderTop: '1px solid #e9d5ff', fontVariantNumeric: 'tabular-nums' },
  note: { fontSize: 11, color: '#7c3aed', marginTop: 8 }, muted: { color: '#94a3b8', fontSize: 13, padding: '6px 0' },
  foot: { display: 'flex', justifyContent: 'flex-end', gap: 10, padding: '14px 20px', borderTop: '1px solid #e2e8f0' },
  cancel: { padding: '8px 16px', borderRadius: 8, border: '1px solid #cbd5e1', background: '#fff', color: '#475569', fontWeight: 600, cursor: 'pointer' },
  confirm: { padding: '8px 16px', borderRadius: 8, border: 'none', background: '#7c3aed', color: '#fff', fontWeight: 700, cursor: 'pointer' },
}
