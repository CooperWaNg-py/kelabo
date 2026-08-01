import { useCallback, useEffect, useRef, useState } from 'react'
import { applyClaim, emptyClaim, holdsRoom } from './tabClaim.js'

/**
 * One tab per kelabo: the wiring half. The protocol — and the reasoning for it
 * — is in `tabClaim.js`.
 *
 * A `BroadcastChannel` named for the kelabo, so two tabs on *different* kelabos
 * never hear each other. Scope is one browser profile, which is the scope of
 * the problem: the harm is a second microphone and a stolen conference seat on
 * this machine.
 *
 * The caller must not merely hide the room while `held` is false — it must not
 * MOUNT it. Every connection the room owns is opened by a hook inside it, so a
 * hidden room is still a second `getUserMedia`, a second SSE stream and a
 * stolen seat. Unmounting is also what makes a takeover work: the losing tab's
 * cleanups run, the mic is released and the call leaves, before the winning tab
 * opens anything.
 */
export function useSingleTab(kelaboId) {
  const [phase, setPhase] = useState('checking')
  const stateRef = useRef(null)
  const channelRef = useRef(null)
  const timerRef = useRef(null)

  // `run` is recreated per kelabo but must be stable within one; the effect
  // below owns the channel and the timer, and nothing outside it may touch them.
  const dispatchRef = useRef(null)

  useEffect(() => {
    if (!kelaboId) return undefined
    // No BroadcastChannel (older Safari, some embedded webviews) means no way
    // to ask, and refusing to open a kelabo we cannot prove is open elsewhere
    // is the wrong trade — the room works, it is only duplicate tabs that do
    // not. Fail open, loudly enough for a developer and silently for everyone
    // else.
    if (typeof BroadcastChannel === 'undefined') {
      setPhase('holding')
      return undefined
    }

    // Random, not a counter: it is also the tie-break when two tabs open in the
    // same instant, so two tabs must never generate the same one.
    const tabId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
    const channel = new BroadcastChannel(`kelabo-tab-${kelaboId}`)
    channelRef.current = channel
    stateRef.current = emptyClaim(tabId)

    const clearTimer = () => {
      if (timerRef.current) clearTimeout(timerRef.current)
      timerRef.current = null
    }

    const dispatch = event => {
      const { state, effects } = applyClaim(stateRef.current, event)
      const changed = state.phase !== stateRef.current.phase
      stateRef.current = state
      for (const effect of effects) {
        if (effect.send) {
          try { channel.postMessage(effect.send) } catch {}
        }
        if (typeof effect.timer === 'number') {
          clearTimer()
          timerRef.current = setTimeout(() => {
            timerRef.current = null
            dispatch({ type: 'timeout' })
          }, effect.timer)
        }
      }
      // Any phase change settles the probe: a `held` answer that arrives inside
      // the window must not be overturned by the timeout that was still armed.
      if (changed && state.phase !== 'checking' && state.phase !== 'taking') clearTimer()
      if (changed) setPhase(state.phase)
    }
    dispatchRef.current = dispatch

    channel.onmessage = e => dispatch({ type: 'message', msg: e.data })
    dispatch({ type: 'start' })

    // A tab that is killed rather than closed never runs cleanup, which is
    // exactly why nothing here is persisted: the next tab's probe simply goes
    // unanswered and it opens the kelabo. This is only the polite path.
    //
    // `persisted` matters and is not defensive: on mobile Safari `pagehide`
    // fires for a bfcache suspend the page can come back from. Standing down
    // there would leave the restored tab showing "already open elsewhere" for a
    // kelabo it still holds. And this posts the message rather than dispatching
    // `stop`, because a state change during unload is a render nobody wants.
    const onUnload = e => {
      if (e.persisted) return
      try { channel.postMessage({ kind: 'release', tabId }) } catch {}
    }
    window.addEventListener('pagehide', onUnload)

    return () => {
      window.removeEventListener('pagehide', onUnload)
      dispatch({ type: 'stop' })
      clearTimer()
      channel.onmessage = null
      channel.close()
      channelRef.current = null
      dispatchRef.current = null
    }
  }, [kelaboId])

  const takeOver = useCallback(() => dispatchRef.current?.({ type: 'takeover' }), [])

  return { phase, held: holdsRoom({ phase }), takeOver }
}
