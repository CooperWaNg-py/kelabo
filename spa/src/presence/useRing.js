import { useCallback, useRef, useState } from 'react'
import { notifyBoard } from '../notify'

/**
 * Incoming-ring state (docs 18 §6). A ring is a few seconds of "X is calling you
 * into <kelabo>" delivered over the presence stream. This hook holds the one
 * incoming ring currently showing (a later ring replaces it) and clears it when
 * the ringer cancels, it times out, or the user answers.
 *
 * `handleRingEvent` is fed the ring_* events routed out of usePresence. It is
 * intentionally not a reducer module: it drives a modal and an OS notification,
 * both side effects.
 */
export function useRing() {
  const [incoming, setIncoming] = useState(null)
  // Guard against an answer arriving for a ring we already dismissed.
  const currentRef = useRef(null)

  const clear = useCallback(() => {
    currentRef.current = null
    setIncoming(null)
  }, [])

  const handleRingEvent = useCallback(evt => {
    if (evt.kind === 'ring_incoming') {
      const ring = {
        kelaboId: evt.kelaboId,
        from: evt.from,
        fromName: evt.fromName || evt.from,
        fromAvatar: evt.fromAvatar || 0,
        title: evt.title || '',
        at: Date.now(),
      }
      currentRef.current = ring.kelaboId
      setIncoming(ring)
      // A ring is exactly the case an OS notification is for: the tab may be in
      // the background. notifyBoard already gates on hidden + permission; a
      // distinct tag so it does not collapse onto the board's.
      notifyBoard(`${ring.fromName} is calling you`, ring.title || 'Join the kelabo', 'kelabo-ring')
    } else if (evt.kind === 'ring_cancelled') {
      // The ringer hung up or it timed out — drop the modal if it is this ring.
      if (currentRef.current === evt.kelaboId) clear()
    }
    // ring_answer is for the RINGER, handled where the dial was started.
  }, [clear])

  return { incoming, handleRingEvent, clearRing: clear }
}
