import { useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { notifyBoard } from '../notify'

/**
 * "Your kelabo starts in 30 seconds" (notes #9).
 *
 * A scheduled kelabo has one failure mode that dwarfs every other: everybody
 * agreed to be there and nobody was, because the calendar reminder was in
 * another app and this one said nothing. So the app that owns the kelabo is the
 * one that knocks — and it does not knock, it walks you in. Thirty seconds
 * before the start this navigates to the kelabo's own page (the pre-start
 * lobby: the host's "Start now", the invitee's "Join now", and it polls), once
 * per kelabo per browser session. A modal asking "go to the lobby?" was tried
 * first; the answer is always yes, and a question you always answer the same
 * way is a click tax.
 *
 * Thirty seconds, deliberately: long enough to put a coffee down, short enough
 * that the page you land on is about something genuinely imminent.
 *
 * Lives in the shell rather than on the home page, because the whole point is
 * that it finds you wherever you are. It deliberately does NOT fire while you
 * are in a kelabo (`/m/…`): yanking someone out of the room they are speaking
 * in to show them the next one is the one place this would be actively hostile.
 */

const LEAD_MS = 30_000
// How long after the start time it is still worth acting. Past this the kelabo
// is not "about to start", it is "already running" — and the live list on the
// home page is a better way to find it than being teleported mid-thought.
const STALE_MS = 5 * 60_000

const POPPED_KEY = 'kelabo-soon-popped'

/** Pops are per browser session: a new day is a new kelabo to be at. */
function loadPopped() {
  try {
    return new Set(JSON.parse(sessionStorage.getItem(POPPED_KEY) || '[]'))
  } catch {
    return new Set()
  }
}

function savePopped(set) {
  try {
    sessionStorage.setItem(POPPED_KEY, JSON.stringify([...set]))
  } catch {}
}

export function StartingSoon({ scheduled }) {
  const navigate = useNavigate()
  const location = useLocation()
  const [, tick] = useState(0)
  const [popped, setPopped] = useState(loadPopped)
  const notifiedRef = useRef(new Set())

  // One second, and only while there is a list to check: a minute-resolution
  // timer could miss the 30-second window entirely.
  useEffect(() => {
    if (!scheduled?.length) return undefined
    const t = setInterval(() => tick(n => n + 1), 1000)
    return () => clearInterval(t)
  }, [scheduled])

  // A kelabo you said you would be at, or one you are hosting. Somebody who
  // declined does not want to be walked into it, and somebody who never
  // answered has already been asked once on the home page.
  const due = (scheduled || [])
    .filter(m => m.status === 'scheduled' && (m.isHost || m.myResponse === 'accepted'))
    .filter(m => {
      const delta = m.scheduledAt - Date.now()
      return delta <= LEAD_MS && delta > -STALE_MS
    })
    .filter(m => !popped.has(m.kelaboId))
    .sort((a, b) => a.scheduledAt - b.scheduledAt)

  const m = due[0]
  const inKelabo = location.pathname.startsWith('/m/')

  // The tab is very often not the one in front. Only the browser can interrupt
  // then, and `notifyBoard` already respects the user's notification setting
  // and stays silent when the page is visible.
  useEffect(() => {
    if (!m || notifiedRef.current.has(m.kelaboId)) return
    notifiedRef.current.add(m.kelaboId)
    notifyBoard(`${m.title} is starting`, 'Opening the lobby', `soon:${m.kelaboId}`)
  }, [m])

  // The pop itself. Marked before navigating so leaving the page afterwards is
  // respected — being walked in once is a service, twice is a trap.
  useEffect(() => {
    if (!m || inKelabo) return
    const next = new Set(popped)
    next.add(m.kelaboId)
    savePopped(next)
    setPopped(next)
    navigate(`/scheduled/${m.kelaboId}`)
  }, [m, inKelabo])

  return null
}
