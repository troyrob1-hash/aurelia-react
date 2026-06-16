import { useState } from 'react'
import { useLocations, cleanLocName } from '@/store/LocationContext'
import { usePeriod } from '@/store/PeriodContext'
import { useAuthStore } from '@/store/authStore'
import { useToast } from '@/components/ui/Toast'
import { parseBudgetWorkbook, writeLocationBudget } from '@/lib/budgetImport'
import { db } from '@/lib/firebase'
import { doc, setDoc, serverTimestamp } from 'firebase/firestore'
import { writePnL, weeksInPeriod } from '@/lib/pnl'
import { Upload } from 'lucide-react'

const fmt$ = v => (v == null || isNaN(v)) ? '—' : '$' + Math.round(v).toLocaleString('en-US')

export default function BudgetImport() {
  const { locationsByName } = useLocations()
  const { year } = usePeriod()
  const { user } = useAuthStore()
  const orgId = user?.tenantId
  const toast = useToast()

  const [parsed, setParsed]   = useState(null)   // { locations, errors }
  const [fileName, setFileName] = useState('')
  const [parsing, setParsing] = useState(false)
  const [overrides, setOverrides] = useState({})  // fileName -> appRawName | '' (skip)
  const [writing, setWriting] = useState(false)
  const [writeLog, setWriteLog] = useState([])
  const [confirmAll, setConfirmAll] = useState(false)

  const locId = n => (n || '').replace(/[^a-zA-Z0-9]/g, '_')  // MUST match Budgets.jsx/pnl.js locId (underscore, not strip)

  function resolveTarget(loc) {
    const m = matchLocation(loc.name)
    return (m.status === 'unmatched' || m.status === 'skip') ? null : m.appName
  }

  async function runWrite(which) {
    setConfirmAll(false)
    setWriting(true)
    setWriteLog([])
    const targets = which === 'test'
      ? parsed.locations.filter(l => resolveTarget(l)).slice(0, 1)
      : parsed.locations.filter(l => resolveTarget(l))
    const log = []
    let first = true
    for (const loc of targets) {
      const appName = resolveTarget(loc)
      try {
        const res = await writeLocationBudget({
          loc, appName, year: String(year), orgId,
          db, doc, setDoc, serverTimestamp,
          writePnL, weeksInPeriod, locId,
          submittedBy: user?.name || user?.email,
          writeSchema: first,
        })
        first = false
        log.push({ location: appName, status: 'ok', detail: res.weeksWritten + ' weeks' })
      } catch (err) {
        console.error('Budget write failed for', appName, err)
        log.push({ location: appName, status: 'error', detail: String(err.message || err) })
      }
      setWriteLog([...log])
    }
    setWriting(false)
    setConfirmAll(false)
    const ok = log.filter(l => l.status === 'ok').length
    const fail = log.filter(l => l.status === 'error').length
    if (fail) toast.error(ok + ' written, ' + fail + ' failed')
    else toast.success(ok + ' location' + (ok===1?'':'s') + ' written to ' + year + ' budget')
  }

  async function handleFile(e) {
    const file = e.target.files[0]
    if (!file) return
    setParsing(true)
    try {
      const XLSX = await import('xlsx')
      const ab = await file.arrayBuffer()
      const result = parseBudgetWorkbook(XLSX, ab)
      setParsed(result)
      setFileName(file.name)
      if (result.errors.length) toast.error(result.errors[0])
      else toast.success('Parsed ' + result.locations.length + ' locations')
    } catch (err) {
      console.error('Budget parse failed:', err)
      toast.error('Could not parse file. Check it is the correct .xlsm.')
    }
    setParsing(false)
    e.target.value = ''
  }

  // Match each parsed location to an app location. Compares against both the raw
  // stored name AND the cleaned display name (cleanLocName strips CR_/SO_ prefixes
  // and underscores), normalized to alphanumerics, so formatting differences match.
  const norm = str => String(str || '').toLowerCase().replace(/[^a-z0-9]/g, '')
  // Explicit aliases: file location name -> app raw location name, for cases
  // the normalizer can't catch (different wording, not just formatting).
  const ALIASES = {
    'EIP': 'CR_EIP Cafe',
  }
  const appNames = Object.keys(locationsByName)
  // Build a normalized lookup: normalized(cleanName) -> rawAppName
  const appLookup = {}
  appNames.forEach(raw => {
    appLookup[norm(raw)] = raw
    appLookup[norm(cleanLocName(raw))] = raw
  })
  if (typeof window !== 'undefined' && !window.__loggedAppNames) {
    window.__loggedAppNames = true
    console.log('[BudgetImport] app location names:', appNames)
    console.log('[BudgetImport] cleaned:', appNames.map(n => cleanLocName(n)))
  }
  function matchLocation(fileName) {
    // Manual override (admin picked a target in the dropdown) wins.
    if (overrides[fileName] !== undefined) {
      return overrides[fileName]
        ? { status: 'manual', appName: overrides[fileName] }
        : { status: 'skip', appName: null }
    }
    if (ALIASES[fileName] && locationsByName[ALIASES[fileName]]) return { status: 'alias', appName: ALIASES[fileName] }
    if (locationsByName[fileName]) return { status: 'exact', appName: fileName }
    const hit = appLookup[norm(fileName)] || appLookup[norm(cleanLocName(fileName))]
    if (hit) return { status: 'normalized', appName: hit }
    return { status: 'unmatched', appName: null }
  }

  return (
    <div style={{ padding: 24, maxWidth: 1100, margin: '0 auto' }}>
      <h1 style={{ fontSize: 24, fontWeight: 800, marginBottom: 4 }}>Budget Import</h1>
      <p style={{ color: '#64748b', fontSize: 14, marginBottom: 20 }}>
        Bulk-load the annual cafe budget file ({year}). Parses the Budget_Load sheet and
        maps each location to the P&amp;L budget lines. Upload first to preview &mdash; nothing
        is written until you review and confirm.
      </p>

      <label style={{
        display: 'inline-flex', alignItems: 'center', gap: 8, cursor: 'pointer',
        background: '#0f172a', color: '#fff', padding: '10px 18px', borderRadius: 8,
        fontSize: 14, fontWeight: 600,
      }}>
        <Upload size={15} /> {parsing ? 'Parsing…' : 'Upload Budget File (.xlsm)'}
        <input type="file" accept=".xlsm,.xlsx" style={{ display: 'none' }} onChange={handleFile} disabled={parsing} />
      </label>
      {fileName && <span style={{ marginLeft: 12, fontSize: 13, color: '#64748b' }}>{fileName}</span>}

      {parsed && parsed.locations.length > 0 && (
        <div style={{ marginTop: 24 }}>
          <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 10 }}>
            {parsed.locations.length} locations parsed · {year} budget
          </div>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ borderBottom: '2px solid #e2e8f0', textAlign: 'left', color: '#64748b' }}>
                <th style={{ padding: '8px 10px' }}>File Location</th>
                <th style={{ padding: '8px 10px' }}>App Match</th>
                <th style={{ padding: '8px 10px', textAlign: 'right' }}>GFS</th>
                <th style={{ padding: '8px 10px', textAlign: 'right' }}>Revenue</th>
                <th style={{ padding: '8px 10px', textAlign: 'right' }}>Labor</th>
                <th style={{ padding: '8px 10px', textAlign: 'right' }}>COGS</th>
                <th style={{ padding: '8px 10px', textAlign: 'right' }}>EBITDA</th>
              </tr>
            </thead>
            <tbody>
              {parsed.locations.map(loc => {
                const m = matchLocation(loc.name)
                const badge = m.status === 'exact' ? { t: 'Matched', c: '#059669', bg: '#f0fdf4' }
                  : m.status === 'alias' ? { t: 'Matched (' + cleanLocName(m.appName) + ')', c: '#059669', bg: '#f0fdf4' }
                  : m.status === 'normalized' ? { t: 'Matched (' + cleanLocName(m.appName) + ')', c: '#059669', bg: '#f0fdf4' }
                  : m.status === 'manual' ? { t: 'Mapped to ' + cleanLocName(m.appName), c: '#7c3aed', bg: '#f5f3ff' }
                  : m.status === 'skip' ? { t: 'Skipped', c: '#94a3b8', bg: '#f8fafc' }
                  : { t: 'No match', c: '#dc2626', bg: '#fef2f2' }
                const needsPick = m.status === 'unmatched' || m.status === 'manual' || m.status === 'skip'
                const s = loc.sectionAnnual
                return (
                  <tr key={loc.name} style={{ borderBottom: '1px solid #f1f5f9' }}>
                    <td style={{ padding: '7px 10px', fontWeight: 600 }}>{loc.name}</td>
                    <td style={{ padding: '7px 10px' }}>
                      <span style={{ fontSize: 11, fontWeight: 700, color: badge.c, background: badge.bg, padding: '2px 8px', borderRadius: 5 }}>{badge.t}</span>
                      {needsPick && (
                        <select
                          value={overrides[loc.name] !== undefined ? overrides[loc.name] : ''}
                          onChange={e => setOverrides(o => ({ ...o, [loc.name]: e.target.value }))}
                          style={{ marginLeft: 8, fontSize: 12, padding: '2px 4px', borderRadius: 5, border: '1px solid #e2e8f0' }}
                        >
                          <option value="">— skip —</option>
                          {appNames.slice().sort().map(n => (
                            <option key={n} value={n}>{cleanLocName(n)}</option>
                          ))}
                        </select>
                      )}
                    </td>
                    <td style={{ padding: '7px 10px', textAlign: 'right' }}>{fmt$(s.GFS)}</td>
                    <td style={{ padding: '7px 10px', textAlign: 'right' }}>{fmt$(s.Revenue)}</td>
                    <td style={{ padding: '7px 10px', textAlign: 'right' }}>{fmt$(s.Labor)}</td>
                    <td style={{ padding: '7px 10px', textAlign: 'right' }}>{fmt$(s.COGS)}</td>
                    <td style={{ padding: '7px 10px', textAlign: 'right', fontWeight: 700 }}>{fmt$(s.EBITDA)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>

          <div style={{ marginTop: 24, display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
            <button
              onClick={() => runWrite('test')}
              disabled={writing}
              style={{ padding: '10px 16px', fontSize: 13, fontWeight: 600, background: '#fff', color: '#0f172a', border: '1px solid #cbd5e1', borderRadius: 8, cursor: writing ? 'default' : 'pointer' }}
            >
              {writing ? 'Writing\u2026' : 'Write 1 location (test)'}
            </button>
            <button
              onClick={() => setConfirmAll(true)}
              disabled={writing}
              style={{ padding: '10px 16px', fontSize: 13, fontWeight: 700, background: '#0f172a', color: '#fff', border: 'none', borderRadius: 8, cursor: writing ? 'default' : 'pointer' }}
            >
              Write all matched ({parsed.locations.filter(l => resolveTarget(l)).length})
            </button>
            <span style={{ fontSize: 12, color: '#94a3b8' }}>
              Writes to {year} budgets &middot; overwrites existing &middot; skipped excluded
            </span>
          </div>

          {confirmAll && (
            <div style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
              <div style={{ background: '#fff', borderRadius: 12, padding: 28, maxWidth: 440, boxShadow: '0 20px 60px rgba(0,0,0,0.3)' }}>
                <h3 style={{ fontSize: 18, fontWeight: 800, margin: '0 0 8px' }}>Write all budgets?</h3>
                <p style={{ fontSize: 14, color: '#475569', lineHeight: 1.6, margin: '0 0 20px' }}>
                  This writes the {year} budget for {parsed.locations.filter(l => resolveTarget(l)).length} matched
                  locations to the live P&amp;L. Existing {year} budgets for these locations will be overwritten.
                </p>
                <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
                  <button onClick={() => setConfirmAll(false)} style={{ padding: '9px 16px', fontSize: 13, fontWeight: 600, background: '#f1f5f9', color: '#475569', border: 'none', borderRadius: 8, cursor: 'pointer' }}>Cancel</button>
                  <button onClick={() => runWrite('all')} style={{ padding: '9px 16px', fontSize: 13, fontWeight: 700, background: '#dc2626', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer' }}>Write all</button>
                </div>
              </div>
            </div>
          )}

          {writeLog.length > 0 && (
            <div style={{ marginTop: 20, fontSize: 13 }}>
              <div style={{ fontWeight: 700, marginBottom: 8 }}>Write results ({writeLog.filter(l=>l.status==='ok').length} ok, {writeLog.filter(l=>l.status==='error').length} failed)</div>
              {writeLog.map((l, i) => (
                <div key={i} style={{ display: 'flex', gap: 10, padding: '3px 0', color: l.status === 'ok' ? '#059669' : '#dc2626' }}>
                  <span style={{ fontWeight: 600, minWidth: 200 }}>{l.location}</span>
                  <span>{l.status === 'ok' ? '\u2713 ' + l.detail : '\u2717 ' + l.detail}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
