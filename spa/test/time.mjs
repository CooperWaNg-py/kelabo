// Day-divider logic (src/time.js). Pure functions, plain node — the
// "yesterday" boundary and the "does this list need dividers at all" decision
// are exactly the kind of thing that only ever breaks live, at midnight.
import assert from 'node:assert/strict'
import { annotateDays, dayKey, dayLabel } from '../src/time.js'

let passed = 0
const ok = (cond, msg) => { assert.ok(cond, msg); passed++ }

// A fixed "now": a Wednesday, mid-afternoon local time.
const NOW = new Date(2026, 7, 5, 15, 0, 0).getTime() // 5 Aug 2026
const DAY = 86400000

// --- dayLabel ---------------------------------------------------------------
ok(dayLabel(NOW - 3600000, NOW) === 'Today', 'same day → Today')
ok(dayLabel(NOW - DAY, NOW) === 'Yesterday', 'one day back → Yesterday')
{
  const label = dayLabel(NOW - 3 * DAY, NOW)
  ok(/Aug/.test(label) && /2/.test(label), `this-year date names day+month: ${label}`)
  ok(!/2026/.test(label), 'this-year date omits the year')
}
ok(/2025/.test(dayLabel(NOW - 370 * DAY, NOW)), 'another year names the year')

// --- dayKey -----------------------------------------------------------------
ok(dayKey(0) === null, 'no wall clock → null key')
ok(dayKey(undefined) === null, 'undefined → null key')
ok(dayKey(NOW) === new Date(NOW).toDateString(), 'dated key is the local date string')

// --- annotateDays -----------------------------------------------------------
const msg = at => ({ at })

{
  // The common case: a one-hour kelabo held today. No dividers at all.
  const out = annotateDays([msg(NOW - 3600000), msg(NOW - 60000)], m => m.at, NOW)
  ok(out.every(e => e.divider === null), 'single today-only day → clean list')
}
{
  // A room that ran across midnight: one divider per day, on the first
  // message of each.
  const out = annotateDays([msg(NOW - DAY), msg(NOW - DAY + 60000), msg(NOW)], m => m.at, NOW)
  ok(out[0].divider === 'Yesterday', 'first day labelled')
  ok(out[1].divider === null, 'same-day follower has no divider')
  ok(out[2].divider === 'Today', 'day change labelled')
}
{
  // Entirely on a past day: labelled, so the reader knows it is not from now.
  const out = annotateDays([msg(NOW - 2 * DAY), msg(NOW - 2 * DAY + 1000)], m => m.at, NOW)
  ok(out[0].divider !== null && out[1].divider === null, 'single past day gets one divider')
}
{
  // Undated rows (persisted before wall clocks) group under "Earlier" when
  // mixed with dated ones…
  const out = annotateDays([msg(0), msg(0), msg(NOW)], m => m.at, NOW)
  ok(out[0].divider === 'Earlier', 'undated rows open under Earlier')
  ok(out[1].divider === null, 'one Earlier divider, not one per row')
  ok(out[2].divider === 'Today', 'dated rows resume normal labels')
}
{
  // …but an ENTIRELY undated list gets nothing: there is nothing to separate.
  const out = annotateDays([msg(0), msg(0)], m => m.at, NOW)
  ok(out.every(e => e.divider === null), 'all-undated list stays clean')
}
ok(annotateDays([], m => m.at, NOW).length === 0, 'empty list is fine')

console.log(`${passed} time assertions passed`)
