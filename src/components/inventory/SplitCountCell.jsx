import { catBucketKey } from '@/lib/buckets'

// Count cell for a SPLIT item — one counted on more than one category sheet.
//
// On a category sheet (`sheetKeys` = [that category]) it shows just THAT
// sheet's packs + eaches, writing into the item's 'cat:<key>' bucket via
// onChange (useInventory.setZoneValue — the same per-bucket path, with the same
// multi-device-safe writes). In the flat/All view (`sheetKeys` = every sheet)
// it shows one line per sheet. Never the top-level inputs: for a split item the
// top-level is the DERIVED total and must not be typed into.

export default function SplitCountCell({ item, sheetKeys, allKeys, categories, done, locked, onChange, inputClass }) {
  const labelOf = k => categories.find(c => c.key === k)?.label || k
  const others = allKeys.filter(k => !sheetKeys.includes(k))
  const single = sheetKeys.length === 1
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      {sheetKeys.map(k => {
        const b = catBucketKey(k)
        const e = item.zones?.[b] || {}
        const isDone = done.includes(b)
        return (
          <div key={k} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            {!single && (
              <span title={isDone ? 'Sheet done — blank counts as zero' : 'Sheet not done — blank is unknown'}
                style={{ fontSize: 9, width: 64, color: '#64748b', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {isDone ? '✓ ' : ''}{labelOf(k)}
              </span>
            )}
            <input type="text" inputMode="decimal" disabled={locked}
              aria-label={`Packs on the ${labelOf(k)} sheet`}
              value={e._qtyRaw ?? (e.qty ?? '')}
              onChange={ev => onChange(item.id, b, 'qty', ev.target.value)}
              placeholder="cs" className={inputClass} style={{ width: single ? 56 : 42 }}
              title={`Cases on the ${labelOf(k)} sheet`} />
            <input type="text" inputMode="decimal" disabled={locked}
              aria-label={`Eaches on the ${labelOf(k)} sheet`}
              value={e._eachesRaw ?? (e.eaches ?? '')}
              onChange={ev => onChange(item.id, b, 'eaches', ev.target.value)}
              placeholder="ea" className={inputClass} style={{ width: single ? 56 : 42 }}
              title={`Eaches on the ${labelOf(k)} sheet`} />
          </div>
        )
      })}
      {others.length > 0 && (
        <div style={{ fontSize: 9, color: '#7c3aed', fontWeight: 600 }}
          title="This item is counted separately on each of its category sheets; the sheets add up to its total.">
          also on {others.map(labelOf).join(', ')}
        </div>
      )}
    </div>
  )
}
