// Wall-clock presentation for message streams. A kelabo used to be an hour, so
// "14:32" identified a moment; a guest room can run for months, and the same
// stamp then says nothing about WHICH day's 14:32. The answer is the chat
// convention: a divider row when the calendar day changes, hour:minute on the
// row, and the full moment in a hover.
//
// Plain node importable (no JSX, no React) so spa/test/time.mjs can exercise
// the day logic — "yesterday" and "needs dividers at all" are exactly the kind
// of boundaries that only ever break in a live room.

/** HH:MM for the row. Falsy `at` (rows persisted before wall clocks were
 *  stored) renders nothing rather than a fake time. */
export function fmtTime(at) {
  if (!at) return ''
  try {
    return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  } catch {
    return ''
  }
}

/** The full moment, for a hover: "Tue, 28 Jul 2026, 14:32". */
export function fmtFullAt(at) {
  if (!at) return ''
  try {
    return new Date(at).toLocaleString([], {
      weekday: 'short',
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
  } catch {
    return ''
  }
}

/** Viewer-local calendar-day key; null for rows with no wall clock. */
export function dayKey(at) {
  return at ? new Date(at).toDateString() : null
}

/** 'Today' | 'Yesterday' | 'Mon 28 Jul' (year added only when it is not this year). */
export function dayLabel(at, now = Date.now()) {
  const d = new Date(at)
  const key = d.toDateString()
  if (key === new Date(now).toDateString()) return 'Today'
  if (key === new Date(now - 86400000).toDateString()) return 'Yesterday'
  const opts = { weekday: 'short', month: 'short', day: 'numeric' }
  if (d.getFullYear() !== new Date(now).getFullYear()) opts.year = 'numeric'
  return d.toLocaleDateString([], opts)
}

/**
 * Pair each item with the divider that should precede it (or null).
 *
 * Dividers appear only when they would say something: the list spans more than
 * one calendar day, or sits on a day other than today, or mixes dated rows
 * with undated ones. A one-hour kelabo held today stays exactly as clean as it
 * was — "Today" over every message is a label for a distinction that does not
 * exist. Rows with no wall clock (persisted before it was stored) group under
 * one "Earlier" divider instead of borrowing a date they never had; a list
 * that is ENTIRELY undated gets no dividers, because there is nothing to
 * separate it from.
 */
export function annotateDays(items, getAt = m => m.at, now = Date.now()) {
  const keys = items.map(m => dayKey(getAt(m)))
  const dated = new Set(keys.filter(Boolean))
  const hasUndated = keys.some(k => k === null)
  const todayKey = new Date(now).toDateString()
  const needed =
    dated.size > 1 || (dated.size === 1 && (!dated.has(todayKey) || hasUndated))
  if (!needed) return items.map(item => ({ item, divider: null }))
  let last
  return items.map((item, i) => {
    const key = keys[i]
    const divider = key !== last ? (key === null ? 'Earlier' : dayLabel(getAt(items[i]), now)) : null
    last = key
    return { item, divider }
  })
}
