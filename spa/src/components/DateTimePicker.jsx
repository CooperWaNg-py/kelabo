import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Icon } from './ui/Icon'

/**
 * A date and time picker that belongs to this app.
 *
 * The native `<input type="date">` / `type="time"` pair was correct and
 * unpleasant: each browser draws its own control, on its own schedule, in its
 * own palette, so on a dark theme you get a white calendar with black text and
 * a scroll wheel that matches nothing around it. Everything here is built from
 * the same tokens as the rest of the app, so it follows the theme — including
 * dark — by construction rather than by hoping the OS agrees.
 *
 * The panel is one popover holding a month grid and a list of quarter-hours,
 * because date and time are one decision and splitting them across two controls
 * makes people answer it twice.
 */

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const MINUTE_STEP = 15
const DAY = 86400000

const startOfDay = d => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x }
const sameDay = (a, b) =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
const pad = n => String(n).padStart(2, '0')

/** Monday-first, because the week starts on Monday everywhere this is used. */
function monthGrid(year, month) {
  const first = new Date(year, month, 1)
  const lead = (first.getDay() + 6) % 7
  const days = new Date(year, month + 1, 0).getDate()
  const cells = Array.from({ length: lead }, () => null)
  for (let d = 1; d <= days; d++) cells.push(new Date(year, month, d))
  while (cells.length % 7) cells.push(null)
  return cells
}

const TIMES = Array.from({ length: (24 * 60) / MINUTE_STEP }, (_, i) => {
  const mins = i * MINUTE_STEP
  return { value: mins, label: `${pad(Math.floor(mins / 60))}:${pad(mins % 60)}` }
})

function formatTrigger(d) {
  return `${d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })} · ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function DateTimePicker({ value, onChange, disabled, minDate }) {
  const selected = useMemo(() => new Date(value), [value])
  const floor = useMemo(() => startOfDay(minDate ?? new Date()), [minDate])

  const [open, setOpen] = useState(false)
  const [view, setView] = useState(() => new Date(selected.getFullYear(), selected.getMonth(), 1))
  const wrapRef = useRef(null)
  const timeListRef = useRef(null)
  const triggerRef = useRef(null)

  // Reopening on a different month than the one selected is disorienting.
  useEffect(() => {
    if (open) setView(new Date(selected.getFullYear(), selected.getMonth(), 1))
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!open) return undefined
    const onDown = e => { if (!wrapRef.current?.contains(e.target)) setOpen(false) }
    const onKey = e => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      setOpen(false)
      triggerRef.current?.focus()
    }
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  // The chosen time is halfway down a 96-row list; opening at the top would
  // make it look unset.
  useLayoutEffect(() => {
    if (!open) return
    const el = timeListRef.current?.querySelector('[data-selected="true"]')
    if (el) el.scrollIntoView({ block: 'center' })
  }, [open])

  const minutesOf = d => d.getHours() * 60 + d.getMinutes()

  const setDate = day => {
    const next = new Date(day)
    next.setHours(selected.getHours(), selected.getMinutes(), 0, 0)
    onChange(next.getTime())
  }

  const setTime = mins => {
    const next = new Date(selected)
    next.setHours(Math.floor(mins / 60), mins % 60, 0, 0)
    onChange(next.getTime())
    setOpen(false)
  }

  const cells = monthGrid(view.getFullYear(), view.getMonth())
  const today = startOfDay(new Date())
  const presets = [
    { label: 'Today', at: today },
    { label: 'Tomorrow', at: new Date(today.getTime() + DAY) },
    { label: 'Next week', at: new Date(today.getTime() + 7 * DAY) },
  ]
  // A month entirely before the floor has nothing to offer.
  const canGoBack = new Date(view.getFullYear(), view.getMonth(), 0) >= floor

  return (
    <div className="dtp" ref={wrapRef}>
      <button
        type="button"
        ref={triggerRef}
        className={'dtp-trigger' + (open ? ' is-open' : '')}
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(o => !o)}
      >
        <Icon name="calendar" size={16} />
        <span className="dtp-value">{formatTrigger(selected)}</span>
        <Icon name={open ? 'chevron-up' : 'chevron-down'} size={14} />
      </button>

      {open && (
        <div className="dtp-panel" role="dialog" aria-label="Choose a date and time">
          <div className="dtp-presets">
            {presets.map(p => (
              <button
                key={p.label}
                type="button"
                className={'chip chip-btn' + (sameDay(selected, p.at) ? ' is-on' : '')}
                onClick={() => setDate(p.at)}
              >
                {p.label}
              </button>
            ))}
          </div>

          <div className="dtp-body">
            <div className="dtp-cal">
              <div className="dtp-month">
                <button
                  type="button"
                  className="dtp-nav"
                  disabled={!canGoBack}
                  aria-label="Previous month"
                  onClick={() => setView(v => new Date(v.getFullYear(), v.getMonth() - 1, 1))}
                >
                  <Icon name="chevron-right" size={15} className="dtp-flip" />
                </button>
                <span className="dtp-month-label">
                  {view.toLocaleDateString([], { month: 'long', year: 'numeric' })}
                </span>
                <button
                  type="button"
                  className="dtp-nav"
                  aria-label="Next month"
                  onClick={() => setView(v => new Date(v.getFullYear(), v.getMonth() + 1, 1))}
                >
                  <Icon name="chevron-right" size={15} />
                </button>
              </div>

              <div className="dtp-week">
                {WEEKDAYS.map(d => <span key={d}>{d}</span>)}
              </div>

              <div className="dtp-days">
                {cells.map((d, i) => {
                  if (!d) return <span key={i} className="dtp-day is-blank" />
                  const isPast = d < floor
                  const isSel = sameDay(d, selected)
                  return (
                    <button
                      key={i}
                      type="button"
                      className={
                        'dtp-day' +
                        (isSel ? ' is-selected' : '') +
                        (sameDay(d, today) ? ' is-today' : '')
                      }
                      disabled={isPast}
                      aria-pressed={isSel}
                      onClick={() => setDate(d)}
                    >
                      {d.getDate()}
                    </button>
                  )
                })}
              </div>
            </div>

            <div className="dtp-times" ref={timeListRef} role="listbox" aria-label="Start time">
              {TIMES.map(t => {
                const isSel = minutesOf(selected) === t.value
                return (
                  <button
                    key={t.value}
                    type="button"
                    role="option"
                    aria-selected={isSel}
                    data-selected={isSel}
                    className={'dtp-time' + (isSel ? ' is-selected' : '')}
                    onClick={() => setTime(t.value)}
                  >
                    {t.label}
                  </button>
                )
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
