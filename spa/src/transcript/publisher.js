import { postCaption } from '../api'
import { DELTA, SEALED, TAIL } from './events.js'

// The Publish stage (docs 13): composer events -> POST /caption. The only module
// in the SPA that knows the caption wire format.
//
// A delta and a seal are different kinds of thing and say so on the wire
// (`kind: 'delta' | 'sealed'`) rather than being inferred from a combination of
// booleans. The gateway treats them very differently — a delta is relayed and
// forgotten, a seal is persisted and handed to the agent — and encoding that
// distinction as flags to be recombined at the far end is how a message ended
// up displayed twice.

/**
 * @param {{ kelaboId: string, clientId: string, displayName?: () => string,
 *           diarized?: () => boolean, onError?: (payload, err) => void }} opts
 */
// Deepgram revises its guess several times a second. Relaying every revision
// would be a POST per revision per speaker; the room cannot perceive the
// difference, so tails are rate-limited. The newest tail always wins, and a
// delta or seal flushes immediately, so nothing is lost — only intermediate
// guesses are skipped.
const TAIL_MIN_INTERVAL_MS = 250

export function createPublisher({ kelaboId, clientId, displayName = () => '', diarized = () => false, onError = null, now = () => Date.now() }) {
  let lastTailAt = 0
  let pendingTail = null
  let tailTimer = null

  // A caption POST that fails is dropped — the room misses a line, and the next
  // one heals it. But it must not fail *silently*: the reason (the gateway
  // returns the schema issues in `detail`) is the only way to tell a rejected
  // payload from a network blip, and swallowing it turned a one-field bug into
  // an unexplained 400 in the console.
  const post = payload => postCaption(payload).catch(err => onError?.(payload, err))

  // The wire carries ms since the kelabo started, and the schema requires that
  // to be non-negative. It can legitimately come out slightly negative — the
  // capture pipeline starts before the host presses start, and client and server
  // clocks are not the same clock — which is not worth losing a caption over.
  const stamp = v => (Number.isFinite(v) && v > 0 ? v : 0)

  function publish(event) {
    const base = {
      kelaboId,
      clientId,
      messageId: event.messageId,
      text: event.text,
      isFinal: true,
      speaker: event.speakerLabel,
      displayName: displayName() || undefined,
      diarized: diarized(),
      tStart: stamp(event.tStart),
      tEnd: stamp(event.tEnd),
    }

    if (event.type === TAIL) {
      // Coalesce: hold the newest guess and send it when the window opens.
      pendingTail = { ...base, kind: TAIL, turnComplete: false, ephemeral: true }
      const wait = TAIL_MIN_INTERVAL_MS - (now() - lastTailAt)
      if (wait > 0) {
        if (!tailTimer) tailTimer = setTimeout(flushTail, wait)
        return Promise.resolve()
      }
      return flushTail()
    }

    if (event.type === DELTA) {
      flushTail(true)
      // Relayed to the room for live display and nothing else: never persisted,
      // never buffered, never shown to the LLM. Sealing can be up to a minute
      // away and the room cannot wait that long, but the agent must still only
      // ever receive whole messages.
      return post({ ...base, kind: DELTA, seq: event.seq, turnComplete: false, ephemeral: true })
    }

    if (event.type === SEALED) {
      flushTail(true)
      return post({
        ...base,
        kind: SEALED,
        turnComplete: true,
        reason: event.reason,
        ...(event.source ? { source: event.source } : {}),
      })
    }

    return Promise.resolve()
  }

  // `drop` is used when a delta or seal supersedes the outstanding guess: those
  // words are confirmed (or the message is closed), so an older guess would only
  // flicker stale text back onto everyone's screen.
  function flushTail(drop = false) {
    if (tailTimer) {
      clearTimeout(tailTimer)
      tailTimer = null
    }
    const payload = pendingTail
    pendingTail = null
    if (!payload || drop) return Promise.resolve()
    lastTailAt = now()
    return post(payload)
  }

  return { publish }
}
