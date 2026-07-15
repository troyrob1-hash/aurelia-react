// src/components/JournalEntryModal.jsx
//
// The ONE journal-entry form. Supersedes the old type-picker + SalaryFjeModal +
// ThirdPartyLaborModal (three separate flows). A journal entry is: pick a GL,
// enter an amount, and choose whether to amortize and for how many months.
// Behavior follows the GL, not a "type":
//   - GL 50410 (salaries) + amortized  → daily-prorated AND burden auto-derives
//     (computeLaborBurden derives from cogs_labor_salaries + hourly at read-time).
//   - GL 50420 (3rd-party)             → posts to cogs_3rd_party, NO burden.
//   - GL 50430 (equipment) + N months  → amortized over the window, no burden.
// All the same form, one write path.
//
// WINDOW RULE (locked): amortization STARTS at the selected period's fiscal week
// and runs N calendar months forward, daily-prorated (conserves to the penny),
// then FALLS TO 0. No start-date picker (posts where you are), no year-chaining.
//
// ONE WRITE PATH: every entry is the same read-time JE —
//   { glCode, glLabel, totalAmount, amortizeMonths (0=once), entryPeriod,
//     location, description }. glCode carries the meaning; the engine
//   (jeContribution → enrichPnLLabor) does the rest. Nothing is written to pnl.

import { useState, useEffect, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { useAuthStore } from '@/store/authStore'
import { useLocations, cleanLocName } from '@/store/LocationContext'
import { usePeriod } from '@/store/PeriodContext'
import { useToast } from '@/components/ui/Toast'
import { db } from '@/lib/firebase'
import { collection, addDoc, serverTimestamp } from 'firebase/firestore'
import { invalidateLedgerJEs, weekRangeOf } from '@/lib/ledgerContributions'
import { computeLaborBurden } from '@/lib/pnl'

const fmt$ = (v) => '$' + (Number(v) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

// Every GL a journal entry can post to. Labor codes carry the burden/derivation
// behavior; the rest mirror the codes the old Standard entry offered. NOTE: the
// derived burden lines (401k / benefits / taxes / bonus, GL 50411-50414) are NOT
// here — they auto-derive from salaries+hourly at read-time, so a manual JE on
// them would just be overwritten. Onsite hourly is not here either — it comes
// from the Café import (a JE would double-count it).
export const JE_GL_OPTIONS = [
  { code: 'cogs_labor_salaries', label: 'Onsite Labor — Salaries & Wages', gl: '50410', group: 'Labor', salary: true },
  { code: 'cogs_3rd_party',      label: '3rd Party Labor',                  gl: '50420', group: 'Labor' },
  { code: 'exp_comp_benefits',   label: 'Compensation & Benefits',          gl: '68xxx', group: 'Labor' },
  { code: 'exp_office_supplies', label: 'Office Supplies & Equipment',      group: 'Expenses' },
  { code: 'exp_mktg_cashier',    label: 'Cashier Discounts',                group: 'Expenses' },
  { code: 'exp_mktg_coupons',    label: 'Coupons',                          group: 'Expenses' },
  { code: 'exp_mktg_marketing',  label: 'Marketing',                        group: 'Expenses' },
  { code: 'exp_mktg_other',      label: 'Other Marketing & Advertising',    group: 'Expenses' },
  { code: 'exp_technology',      label: 'Technology Services',              group: 'Expenses' },
  { code: 'exp_travel',          label: 'Travel and Entertainment',         group: 'Expenses' },
  { code: 'exp_professional',    label: 'Professional Fees',                group: 'Expenses' },
  { code: 'exp_facilities',      label: 'Facilities',                       group: 'Expenses' },
  { code: 'exp_licenses',        label: 'Licenses, Permits and Fines',      group: 'Expenses' },
  { code: 'exp_other',           label: 'Other Expenses',                   group: 'Expenses' },
  { code: 'cogs_cleaning',       label: 'Cleaning Supplies & Chemicals',    group: 'COGS' },
  { code: 'cogs_equipment',      label: 'Onsite Equipment',                 group: 'COGS' },
  { code: 'cogs_paper',          label: 'Paper Products & Consumables',     group: 'COGS' },
  { code: 'cogs_supplies',       label: 'Onsite Supplies',                  group: 'COGS' },
  { code: 'cogs_uniforms',       label: 'Onsite Uniforms',                  group: 'COGS' },
  { code: 'cogs_maintenance',    label: 'Onsite Other / Maintenance',       group: 'COGS' },
  { code: 'cogs_payment_processing', label: 'Bank Charges, Merchant Fees',  group: 'COGS' },
]
const GROUPS = ['Labor', 'Expenses', 'COGS']

export default function JournalEntryModal({ open, onClose, onSaved }) {
  const { user } = useAuthStore()
  const orgId = user?.tenantId
  const { selectedLocation } = useLocations()
  const { periodKey } = usePeriod()
  const toast = useToast()

  const [glCode, setGlCode] = useState('')
  const [description, setDescription] = useState('')
  const [amount, setAmount] = useState('')
  const [months, setMonths] = useState('')            // blank/0 → post once to the current period
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!open) return
    setGlCode(''); setDescription(''); setAmount(''); setMonths('')
  }, [open])

  const amountNum = parseFloat(String(amount).replace(/[$,\s]/g, '')) || 0
  const monthsNum = parseInt(months) || 0
  const glMeta = JE_GL_OPTIONS.find(g => g.code === glCode)

  // Burden preview — only for salaries (50410) + amortized. Wages/wk over the
  // window, plus the read-time-derived burden (illustrative; live rates apply).
  const burdenPreview = useMemo(() => {
    if (!glMeta?.salary || monthsNum < 1 || amountNum <= 0) return null
    const wr = weekRangeOf(periodKey); if (!wr) return null
    const dt = new Date(wr.start * 86400000)
    const endEx = Math.floor(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth() + monthsNum, dt.getUTCDate()) / 86400000)
    const windowDays = endEx - wr.start; if (windowDays <= 0) return null
    const weeks = windowDays / 7
    const wagesWk = amountNum / weeks
    const b = computeLaborBurden(wagesWk, 0)          // derived burden on this week's wages
    const burdenWk = b.cogs_labor_taxes + b.cogs_labor_benefits + b.cogs_labor_401k + b.cogs_labor_bonus
    return { wagesWk, loadedWk: wagesWk + burdenWk, weeks }
  }, [glMeta, monthsNum, amountNum, periodKey])

  async function save() {
    const loc = selectedLocation && selectedLocation !== 'all' ? selectedLocation : null
    if (!loc) { toast.error('Pick a specific location (not All Locations).'); return }
    if (!glCode) { toast.error('Pick a GL account.'); return }
    if (amountNum <= 0) { toast.error('Enter a positive amount.'); return }
    if (!description.trim()) { toast.error('Enter a description.'); return }
    setSaving(true)
    try {
      await addDoc(collection(db, 'tenants', orgId, 'journalEntries'), {
        glCode,
        glLabel: glMeta?.label || glCode,
        totalAmount: Math.round(amountNum * 100) / 100,
        amortizeMonths: monthsNum,                     // 0 = once (this period); N = N months forward
        entryPeriod: periodKey,                        // window anchors to THIS fiscal week
        description: description.trim(),
        location: loc,
        createdBy: user?.name || user?.email || 'unknown',
        createdByUid: user?.uid || null,               // for delete permission (creator OR director+)
        createdAt: serverTimestamp(),
        status: 'posted',
      })
      invalidateLedgerJEs()                            // read-time cache picks it up immediately
      onClose?.()
      toast.success(`Posted ${fmt$(amountNum)} to ${glMeta?.label || glCode}${monthsNum >= 1 ? ` over ${monthsNum} mo` : ` (${periodKey})`}`)
      onSaved?.()
    } catch (e) {
      console.error('Journal entry save failed:', e)
      toast.error('Save failed — ' + (e?.message || ''))
    }
    setSaving(false)
  }

  const S = STYLES
  if (!open) return null
  const disabled = !glCode || amountNum <= 0 || !description.trim() || saving
  return createPortal(
    <div style={S.overlay} onClick={() => !saving && onClose?.()}>
      <div style={S.modal} onClick={e => e.stopPropagation()}>
        <div style={S.head}>
          <div>
            <div style={S.title}>New journal entry</div>
            <div style={S.sub}>{selectedLocation && selectedLocation !== 'all' ? cleanLocName(selectedLocation) : '⚠ pick a location'} · {periodKey}</div>
          </div>
          <button style={S.x} onClick={() => !saving && onClose?.()}><X size={18} /></button>
        </div>

        <div style={S.body}>
          <label style={S.label}>Description</label>
          <input style={S.input} value={description} onChange={e => setDescription(e.target.value)} placeholder="e.g. Store Manager salary — FY26 · or Acme Staffing inv #4471" autoFocus />

          <label style={S.label}>GL account</label>
          <select style={S.input} value={glCode} onChange={e => setGlCode(e.target.value)}>
            <option value="">Select GL account…</option>
            {GROUPS.map(grp => (
              <optgroup key={grp} label={grp}>
                {JE_GL_OPTIONS.filter(g => g.group === grp).map(g => (
                  <option key={g.code} value={g.code}>{g.label}{g.gl ? ` (${g.gl})` : ''}</option>
                ))}
              </optgroup>
            ))}
          </select>

          <label style={S.label}>Amount</label>
          <input style={S.input} value={amount} onChange={e => setAmount(e.target.value)} placeholder="0.00" inputMode="decimal" />

          <label style={S.label}>Amortize over how many months?</label>
          <input style={{ ...S.input, width: 140 }} value={months} onChange={e => setMonths(e.target.value.replace(/[^0-9]/g, ''))} placeholder="0" inputMode="numeric" />
          <div style={{ fontSize: 12, color: '#94a3b8', marginTop: 6 }}>
            {monthsNum >= 1
              ? <>Spreads daily over <b>{monthsNum}</b> month{monthsNum > 1 ? 's' : ''} from <b>{periodKey}</b>, then stops.</>
              : <>Blank or 0 posts the full amount once to <b>{periodKey}</b>.</>}
          </div>

          {burdenPreview && (
            <div style={S.preview}>
              {fmt$(amountNum)} over {monthsNum}mo → <b>{fmt$(burdenPreview.wagesWk)}/wk</b> wages + derived burden ≈ <b>{fmt$(burdenPreview.loadedWk)}/wk loaded</b>. Taxes/benefits/401k/bonus derive automatically at read-time.
            </div>
          )}
          {glMeta && !glMeta.salary && (
            <div style={S.note}>
              {glMeta.code === 'cogs_3rd_party'
                ? 'No burden — an agency bill already carries its own taxes/benefits.'
                : 'Posts to this GL only — no labor burden is derived.'}
            </div>
          )}
        </div>

        <div style={S.foot}>
          <button style={S.cancel} onClick={() => onClose?.()} disabled={saving}>Cancel</button>
          <button style={{ ...S.confirm, opacity: disabled ? 0.5 : 1 }} onClick={save} disabled={disabled}>
            {saving ? 'Saving…' : `Post ${fmt$(amountNum)}`}
          </button>
        </div>
      </div>
    </div>, document.body)
}

const STYLES = {
  overlay: { position: 'fixed', inset: 0, background: 'rgba(15,23,42,.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 10000, padding: 20 },
  modal: { background: '#fff', borderRadius: 14, width: 'min(540px,96vw)', maxHeight: '90vh', display: 'flex', flexDirection: 'column', boxShadow: '0 20px 60px rgba(0,0,0,.3)' },
  head: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', padding: '16px 20px', borderBottom: '1px solid #e2e8f0' },
  title: { fontSize: 16, fontWeight: 800, color: '#0f172a' }, sub: { fontSize: 12, color: '#64748b', marginTop: 2 },
  x: { background: 'none', border: 'none', cursor: 'pointer', color: '#64748b' },
  body: { padding: '14px 20px', overflow: 'auto' },
  label: { display: 'block', fontSize: 12, fontWeight: 600, color: '#475569', margin: '12px 0 4px' },
  input: { width: '100%', boxSizing: 'border-box', padding: '9px 12px', borderRadius: 8, border: '1px solid #cbd5e1', fontSize: 14 },
  preview: { fontSize: 12, color: '#0f766e', marginTop: 14, lineHeight: 1.5, background: '#f0fdfa', border: '1px solid #99f6e4', borderRadius: 8, padding: '8px 10px' },
  note: { fontSize: 11, color: '#64748b', marginTop: 14, lineHeight: 1.5, background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 8, padding: '8px 10px' },
  foot: { display: 'flex', justifyContent: 'flex-end', gap: 10, padding: '14px 20px', borderTop: '1px solid #e2e8f0' },
  cancel: { padding: '8px 16px', borderRadius: 8, border: '1px solid #cbd5e1', background: '#fff', color: '#475569', fontWeight: 600, cursor: 'pointer' },
  confirm: { padding: '8px 16px', borderRadius: 8, border: 'none', background: '#0f766e', color: '#fff', fontWeight: 700, cursor: 'pointer' },
}
