// src/components/ThirdPartyLaborModal.jsx
//
// 3rd-Party Labor entry (New Entry → "3rd-Party Labor"). Agency/temp labor that
// just arrives as an invoice — the one labor cost Aurelia can neither derive
// (it's not payroll) nor pull weekly (no timekeeping/report feed). So it's a
// direct manual entry.
//
// Read-time JE on GL 50420 (cogs_3rd_party), same architecture as the salary FJE
// (GL-general computeLedgerContributions → enrichPnLLabor). NO BURDEN: an agency's
// bill already includes their own taxes/benefits, and computeLaborBurden only
// derives from salary + hourly — it never reads cogs_3rd_party, so 3rd-party is
// structurally burden-free. Default = this period only (posts to the selected
// week); optional amortization for a multi-period contract (daily-prorated).

import { useState, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { useAuthStore } from '@/store/authStore'
import { useLocations, cleanLocName } from '@/store/LocationContext'
import { usePeriod, getPeriodWeeks } from '@/store/PeriodContext'
import { useToast } from '@/components/ui/Toast'
import { db } from '@/lib/firebase'
import { collection, addDoc, serverTimestamp } from 'firebase/firestore'
import { invalidateLedgerJEs } from '@/lib/ledgerContributions'

const fmt$ = (v) => '$' + (Number(v) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

// A date inside the selected period's fiscal week — anchors the 'once' entry to
// that week (or the amortization window start).
function periodWeekStart(periodKey) {
  const m = String(periodKey).match(/(\d{4})-P(\d{2})-W(\d+)/)
  if (!m) return null
  const wk = getPeriodWeeks(+m[1], +m[2])[+m[3] - 1]
  if (!wk) return null
  const d = wk.start
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export default function ThirdPartyLaborModal({ open, onClose, onSaved }) {
  const { user } = useAuthStore()
  const orgId = user?.tenantId
  const { selectedLocation } = useLocations()
  const { periodKey } = usePeriod()
  const toast = useToast()

  const [amount, setAmount] = useState('')
  const [description, setDescription] = useState('')
  const [amortize, setAmortize] = useState(false)          // default OFF — this period only
  const [amortization, setAmortization] = useState('quarterly')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!open) return
    setAmount(''); setDescription(''); setAmortize(false); setAmortization('quarterly')
  }, [open])

  const amountNum = parseFloat(String(amount).replace(/[$,\s]/g, '')) || 0

  async function save() {
    const loc = selectedLocation && selectedLocation !== 'all' ? selectedLocation : null
    if (!loc) { toast.error('Pick a specific location (not All Locations).'); return }
    if (amountNum <= 0) { toast.error('Enter a positive amount.'); return }
    if (!description.trim()) { toast.error('Enter a description (e.g. the agency/invoice).'); return }
    const anchor = periodWeekStart(periodKey)
    if (!anchor) { toast.error('Pick a weekly period to post 3rd-party labor into.'); return }
    setSaving(true)
    try {
      const je = {
        jeType: 'thirdparty',
        glCode: 'cogs_3rd_party',          // GL 50420 — summed by computeOnsiteLabor; NO burden derived
        glLabel: '3rd Party Labor',
        totalAmount: Math.round(amountNum * 100) / 100,
        description: description.trim(),
        location: loc,
        createdBy: user?.name || user?.email || 'unknown',
        createdAt: serverTimestamp(),
        status: 'posted',
      }
      if (amortize) {
        je.amortization = amortization                       // annual / quarterly / monthly — daily-prorated
        je.windowStartDate = anchor
      } else {
        je.amortization = 'once'                             // full amount in THIS period's week
        je.entryDate = anchor
      }
      await addDoc(collection(db, 'tenants', orgId, 'journalEntries'), je)
      invalidateLedgerJEs()                                  // read-time cache picks it up immediately
      onClose?.()
      toast.success(`3rd-party labor posted — ${fmt$(amountNum)}${amortize ? ` amortized (${amortization})` : ` to ${periodKey}`}`)
      onSaved?.()
    } catch (e) {
      console.error('3rd-party labor save failed:', e)
      toast.error('Save failed — ' + (e?.message || ''))
    }
    setSaving(false)
  }

  const S = STYLES
  if (!open) return null
  return createPortal(
    <div style={S.overlay} onClick={() => !saving && onClose?.()}>
      <div style={S.modal} onClick={e => e.stopPropagation()}>
        <div style={S.head}>
          <div>
            <div style={S.title}>3rd-Party Labor</div>
            <div style={S.sub}>{selectedLocation && selectedLocation !== 'all' ? cleanLocName(selectedLocation) : '⚠ pick a location'} · {periodKey} · GL 50420 · no burden</div>
          </div>
          <button style={S.x} onClick={() => !saving && onClose?.()}><X size={18} /></button>
        </div>

        <div style={S.body}>
          <label style={S.label}>Description (agency / invoice)</label>
          <input style={S.input} value={description} onChange={e => setDescription(e.target.value)} placeholder="e.g. Acme Staffing — inv #4471" autoFocus />

          <label style={S.label}>Amount</label>
          <input style={S.input} value={amount} onChange={e => setAmount(e.target.value)} placeholder="2,500.00" inputMode="decimal" />

          <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12, fontSize: 13, color: '#334155', cursor: 'pointer' }}>
            <input type="checkbox" checked={amortize} onChange={e => setAmortize(e.target.checked)} />
            Multi-period contract — amortize over time
          </label>
          {amortize ? (
            <select style={{ ...S.input, marginTop: 8 }} value={amortization} onChange={e => setAmortization(e.target.value)}>
              <option value="monthly">Monthly</option>
              <option value="quarterly">Quarterly</option>
              <option value="annual">Annual</option>
            </select>
          ) : (
            <div style={{ fontSize: 12, color: '#94a3b8', marginTop: 8 }}>Posts the full amount to <b>{periodKey}</b> (this period only).</div>
          )}

          <div style={S.note}>3rd-party labor gets <b>no</b> taxes/benefits/401k/bonus — the agency's bill already includes their burden. It sums into Total Onsite Labor via the "3rd Party Labor" P&L row.</div>
        </div>

        <div style={S.foot}>
          <button style={S.cancel} onClick={() => onClose?.()} disabled={saving}>Cancel</button>
          <button style={{ ...S.confirm, opacity: (amountNum <= 0 || !description.trim() || saving) ? 0.5 : 1 }}
                  onClick={save} disabled={amountNum <= 0 || !description.trim() || saving}>
            {saving ? 'Saving…' : `Post ${fmt$(amountNum)}`}
          </button>
        </div>
      </div>
    </div>, document.body)
}

const STYLES = {
  overlay: { position: 'fixed', inset: 0, background: 'rgba(15,23,42,.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 10000, padding: 20 },
  modal: { background: '#fff', borderRadius: 14, width: 'min(520px,96vw)', maxHeight: '90vh', display: 'flex', flexDirection: 'column', boxShadow: '0 20px 60px rgba(0,0,0,.3)' },
  head: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', padding: '16px 20px', borderBottom: '1px solid #e2e8f0' },
  title: { fontSize: 16, fontWeight: 800, color: '#0f172a' }, sub: { fontSize: 12, color: '#64748b', marginTop: 2 },
  x: { background: 'none', border: 'none', cursor: 'pointer', color: '#64748b' },
  body: { padding: '14px 20px', overflow: 'auto' },
  label: { display: 'block', fontSize: 12, fontWeight: 600, color: '#475569', margin: '10px 0 4px' },
  input: { width: '100%', boxSizing: 'border-box', padding: '9px 12px', borderRadius: 8, border: '1px solid #cbd5e1', fontSize: 14 },
  note: { fontSize: 11, color: '#64748b', marginTop: 14, lineHeight: 1.5, background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 8, padding: '8px 10px' },
  foot: { display: 'flex', justifyContent: 'flex-end', gap: 10, padding: '14px 20px', borderTop: '1px solid #e2e8f0' },
  cancel: { padding: '8px 16px', borderRadius: 8, border: '1px solid #cbd5e1', background: '#fff', color: '#475569', fontWeight: 600, cursor: 'pointer' },
  confirm: { padding: '8px 16px', borderRadius: 8, border: 'none', background: '#0f766e', color: '#fff', fontWeight: 700, cursor: 'pointer' },
}
