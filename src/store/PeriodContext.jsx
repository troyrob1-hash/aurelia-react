import { createContext, useContext, useState, useMemo } from 'react'

// ── Fiscal Calendar ───────────────────────────────────────────
// Fooda weeks run SUNDAY–SATURDAY (weeks END on Saturday).
// Week 1 = starts on the 1st of the month regardless of day, ends the first Saturday (partial).
// Week 2+ = Sun–Sat.
// Last week = ends on the last day of the month (may be short).
// A week never crosses a month boundary — it is chopped at the 1st and last of the month.

function daysInMonth(year, month) {
  return new Date(year, month, 0).getDate()
}

export function getPeriodWeeks(year, period) {
  const month  = period
  const first  = new Date(year, month - 1, 1)
  const last   = new Date(year, month - 1, daysInMonth(year, month))
  const weeks  = []
  let current  = new Date(first)

  while (current <= last) {
    const wkStart = new Date(current)
    // Find the next Saturday — weeks run Sun–Sat, so a week ends on Saturday.
    const daysToSat = (6 - current.getDay() + 7) % 7
    const wkEnd = new Date(current)
    wkEnd.setDate(current.getDate() + daysToSat)
    // Cap at end of month
    const end = wkEnd > last ? new Date(last) : wkEnd
    weeks.push({ start: new Date(wkStart), end: new Date(end) })
    current = new Date(end)
    current.setDate(current.getDate() + 1)
  }

  return weeks
}

export function formatPeriodKey(year, period, week) {
  if (week === 0) return `${year}-P${String(period).padStart(2,'0')}-MONTHLY`
  return `${year}-P${String(period).padStart(2,'0')}-W${week}`
}

// Any calendar date (YYYY-MM-DD string or Date) → its fiscal-week periodKey
// (YYYY-PMM-Wn) via the Sun–Sat calendar. A week never crosses a month boundary,
// so the date's month picks the period and its day picks the week. Returns null if
// the date is missing/unparseable (caller decides the fallback). This is the
// canonical "posting date → the week it belongs to" — an invoice's date decides
// its week, independent of what period is on screen.
export function dateToKey(val) {
  if (!val) return null
  let y, m, d
  if (val instanceof Date) { y = val.getFullYear(); m = val.getMonth() + 1; d = val.getDate() }
  else {
    const mt = String(val).match(/^(\d{4})-(\d{2})-(\d{2})/)
    if (!mt) return null
    y = +mt[1]; m = +mt[2]; d = +mt[3]
  }
  const wks = getPeriodWeeks(y, m)
  for (let i = 0; i < wks.length; i++) {
    if (d >= wks[i].start.getDate() && d <= wks[i].end.getDate()) return formatPeriodKey(y, m, i + 1)
  }
  return null
}

export function getPeriodLabel(year, period) {
  const months = ['January','February','March','April','May','June',
                  'July','August','September','October','November','December']
  return `P${period} — ${months[period-1]} ${year}`
}

export function getWeekLabel(weekObj, weekNum) {
  const opts = { month:'short', day:'numeric' }
  const start = weekObj.start.toLocaleDateString('en-US', opts)
  const end   = weekObj.end.toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' })
  const days  = Math.round((weekObj.end - weekObj.start) / 86400000) + 1
  const short = days < 7 ? ` (${days}d)` : ''
  return `Wk ${weekNum}: ${start} – ${end}${short}`
}

// Find current period and week based on today
function getCurrentPeriodWeek() {
  const today  = new Date()
  const year   = today.getFullYear()
  const period = today.getMonth() + 1
  const weeks  = getPeriodWeeks(year, period)
  let week = 1
  for (let i = 0; i < weeks.length; i++) {
    if (today >= weeks[i].start && today <= weeks[i].end) {
      week = i + 1
      break
    }
  }
  return { year, period, week }
}

// ── Context ───────────────────────────────────────────────────
const PeriodContext = createContext(null)

export function PeriodProvider({ children }) {
  const current = getCurrentPeriodWeek()
  const [year, setYear]     = useState(current.year)
  const [period, setPeriod] = useState(current.period)
  const [week, setWeek]     = useState(current.week)

  const weeks = useMemo(() => getPeriodWeeks(year, period), [year, period])

  const currentWeek = week === 0
    ? { start: weeks[0]?.start || new Date(), end: (weeks[weeks.length - 1] || weeks[0])?.end || new Date() }
    : (weeks[week - 1] || weeks[0])

  const periodKey = formatPeriodKey(year, period, week)

  // Date range strings for Firestore queries
  const dateStart = currentWeek?.start.toISOString().slice(0, 10)
  const dateEnd   = currentWeek?.end.toISOString().slice(0, 10)

  function prevWeek() {
    if (week > 1) {
      setWeek(w => w - 1)
    } else if (period > 1) {
      const newPeriod = period - 1
      const newWeeks  = getPeriodWeeks(year, newPeriod)
      setPeriod(newPeriod)
      setWeek(newWeeks.length)
    } else {
      const newYear   = year - 1
      const newWeeks  = getPeriodWeeks(newYear, 12)
      setYear(newYear)
      setPeriod(12)
      setWeek(newWeeks.length)
    }
  }

  function nextWeek() {
    if (week < weeks.length) {
      setWeek(w => w + 1)
    } else if (period < 12) {
      setPeriod(p => p + 1)
      setWeek(1)
    } else {
      setYear(y => y + 1)
      setPeriod(1)
      setWeek(1)
    }
  }

  return (
    <PeriodContext.Provider value={{
      year, period, week, weeks,
      currentWeek, periodKey, dateStart, dateEnd,
      setYear, setPeriod, setWeek,
      prevWeek, nextWeek,
      isCurrentPeriod: year === current.year && period === current.period,
      isCurrentWeek: year === current.year && period === current.period && week === current.week,
    }}>
      {children}
    </PeriodContext.Provider>
  )
}

export function usePeriod() {
  const ctx = useContext(PeriodContext)
  if (!ctx) throw new Error('usePeriod must be used within PeriodProvider')
  return ctx
}
