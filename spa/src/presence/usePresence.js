import { useEffect, useMemo, useRef, useState } from 'react'
import { presenceStreamUrl } from '../api'
import { apply, emptyPresence, isOnline, isInKelabo } from './presenceStore.js'

/**
 * The one contact-presence stream (docs 18 §5), mounted once by AppShell.
 *
 * Like the board's EventSource (useBoard), this owns a single connection whose
 * lifetime must not be tied to any component that draws a list — a layout switch
 * or a route change must never re-subscribe. It is opened while signed in and
 * closed on sign-out.
 *
 * The browser's native EventSource reconnects on its own; the server sends a
 * fresh `snapshot` on every (re)connect, and the pure reducer treats a snapshot
 * as a full replace — so a reconnect re-syncs with no client bookkeeping. There
 * is no REST backfill because there is no durable presence to fetch.
 *
 * `identity` gates the connection: a signed-in user opens it, a guest (no
 * identity) does not.
 */
const RING_KINDS = new Set(['ring_incoming', 'ring_answer', 'ring_cancelled'])

export function usePresence(identity, onRing) {
  const [presence, setPresence] = useState(() => emptyPresence())
  const esRef = useRef(null)
  // Keep the latest onRing without re-opening the stream when it changes.
  const onRingRef = useRef(onRing)
  onRingRef.current = onRing

  useEffect(() => {
    if (!identity) {
      setPresence(emptyPresence())
      return undefined
    }
    let cancelled = false
    const es = new EventSource(presenceStreamUrl(), { withCredentials: true })
    esRef.current = es
    es.addEventListener('presence', e => {
      if (cancelled) return
      let evt
      try { evt = JSON.parse(e.data) } catch { return }
      // Ring events (docs 18 §6) ride the same stream — routed to the ring
      // handler, not the presence reducer, which stays about who-is-online only.
      if (RING_KINDS.has(evt.kind)) { onRingRef.current?.(evt); return }
      setPresence(prev => apply(prev, evt))
    })
    // On a dropped connection the browser reconnects and the server re-sends a
    // snapshot, which replaces the set — so nothing to do here but wait.
    return () => {
      cancelled = true
      es.close()
      esRef.current = null
    }
  }, [identity])

  return useMemo(() => ({
    presence,
    isOnline: id => isOnline(presence, id),
    inKelabo: id => isInKelabo(presence, id),
  }), [presence])
}
