// Imports here carry the .js extension because this module is also loaded by
// plain node in spa/test/soniox.mjs, and node ESM requires it.

// The decisions that cost money, separated from the sockets that carry them.
//
// Soniox bills the WALL-CLOCK LIFETIME of a stream, not the audio it receives,
// and that clock starts at the start request rather than at connection setup. A
// connection that has been opened but has sent NOTHING produces no usage-log
// entry and no charge:
//
//   idle configured stream   30,000 in-audio tokens/hr   ~$0.06/hr
//   connected, unconfigured  no usage record at all      $0
//
// So the difference between "free while nobody is talking" and "billed for the
// length of the kelabo, per participant" comes down to a handful of booleans:
// has this connection already had a start request, is this frame allowed out
// yet, has this one been idle long enough to be suspect.
//
// Those are precisely the decisions that cannot be checked in a live kelabo.
// The symptom of getting them wrong is not a broken transcript — it is a
// perfectly good transcript and a surprise on the invoice. So they live here,
// pure, and `spa/test/soniox.mjs` runs them under node. The socket wiring in
// `spa/src/stt/soniox.js` does no arithmetic of its own.

export const POOL_DEFAULTS = {
  // 1 + ceil(refillTime / minimumGapBetweenUtterances). A refill is one
  // handshake (~615ms measured) and the silence gate means two utterances can
  // never start closer together than `silenceMs`, so the second connection is
  // insurance against a spare dying at the wrong moment rather than throughput.
  poolSize: 2,
  // An idle socket can be killed by a NAT or a proxy without a close frame and
  // still report OPEN, so it is retired well before that becomes likely. Soniox
  // has a `Start request timeout` in its error catalogue but does not document
  // the duration, so this stays conservative until it has been measured.
  poolMaxAge: 30_000,
  // How long after the last frame of audio the billed stream is ended.
  //
  // Measured from `lastVoiceAt`, which is the last frame actually HANDED OVER —
  // not the last frame containing speech. The gate goes on sending for its
  // whole hangover (vad.js, 2000ms) precisely so the endpointer hears the
  // silence it needs, so by the time this timer starts the provider has already
  // been given everything it is going to get.
  //
  // Short, therefore. Its only job is to not cut the stream in the same instant
  // as the final frame; anything still in flight is caught by `drainMs` below,
  // which keeps listening for trailing finals after the end frame. This used to
  // be 1100ms, back when the gate stopped sending at 900ms — which meant the
  // stream sat open and billed for over a second receiving nothing at all, and
  // the endpointer never got its silence either.
  silenceMs: 300,
  // No response this long after a start request means the socket was already
  // dead when it came out of the pool.
  watchdogMs: 1500,
  // Soniox closes a stream that has seen neither audio nor a keepalive for more
  // than 20s. Comfortably inside that, because the timer driving it is throttled
  // in a background tab.
  keepaliveMs: 5000,
  // How long a finished stream keeps listening for trailing final tokens after
  // the end frame. The connection cannot be reused either way — one connection
  // carries exactly one stream — so this is only about not losing the last few
  // words.
  drainMs: 2500,
}

// The server's endpointing cap, restated here because the coupling it creates
// is enforced on this side.
//
// `rest-api/src/stt/soniox.js` sends `max_endpoint_delay_ms` in the start
// request: the longest Soniox will wait, listening, before forcing an endpoint
// and finalising what it has. The gate must go on streaming audio for longer
// than this, or that wait expires against no audio at all and the tail of every
// utterance stays whatever the last interim guess happened to be.
//
// Duplicated across the client/server boundary on purpose. It is set there and
// depended on here, and a silent disagreement costs the end of every sentence,
// so it is asserted in `test/gate.mjs` rather than left as a comment.
export const MAX_ENDPOINT_DELAY_MS = 1500

/**
 * Which pooled connection to spend.
 *
 * Oldest first: consume the one nearest whatever the server's idle tolerance
 * turns out to be, and keep the young one in reserve, so the spare left behind
 * is the one most likely to still be alive. The risk that takes on — an old
 * socket that is half-open and still claims to be OPEN — is covered by age
 * eviction below and by the start-request watchdog.
 *
 * @param {{openedAt:number, open:boolean}[]} entries
 * @returns {number} index into `entries`, or -1 when nothing is usable.
 */
export function pickConnection(entries) {
  let best = -1
  for (let i = 0; i < entries.length; i++) {
    if (!entries[i].open) continue
    if (best < 0 || entries[i].openedAt < entries[best].openedAt) best = i
  }
  return best
}

/**
 * Which pooled connections are too old to trust — descending, so a caller can
 * splice them out back to front without invalidating its own indices.
 *
 * @param {{openedAt:number}[]} entries
 * @returns {number[]}
 */
export function expiredConnections(entries, now, maxAge = POOL_DEFAULTS.poolMaxAge) {
  const out = []
  for (let i = entries.length - 1; i >= 0; i--) {
    if (now - entries[i].openedAt >= maxAge) out.push(i)
  }
  return out
}

/**
 * How many connections to start opening.
 *
 * Counts the ones already in flight, or a burst of calls opens a burst of
 * sockets — each one a file descriptor and a TLS session on somebody else's
 * edge, even though none of them is billed.
 */
export function refillCount(poolLength, opening, size = POOL_DEFAULTS.poolSize) {
  return Math.max(0, size - poolLength - opening)
}

/**
 * The billing guard: one per connection, and the only thing that may say yes to
 * a start request or to a frame.
 *
 * Enforces in code, rather than by convention:
 *
 *   1. In gated mode a start request goes out for exactly one reason — somebody
 *      spoke. A stream opened for any other reason is a stream nobody asked
 *      for, billing silence until the kelabo ends.
 *   2. Nothing may be sent before the start request. Not audio, not a
 *      keepalive: a keepalive before the start request is a protocol error, and
 *      anything at all on a pooled connection ends the property that makes the
 *      pool free.
 *   3. One start request per connection. Soniox carries exactly one stream per
 *      connection and closes it when that stream ends.
 *   4. Nothing may be sent after the end frame.
 *
 * @param {{gated?: boolean}} opts `gated` false means the caller is handing
 *   over every frame rather than only speech, so there is no onset to wait for
 *   and the stream may start as soon as a connection exists.
 */
export function createBillingGuard({ gated = true } = {}) {
  let started = false
  let ended = false

  const canStart = reason => {
    if (started || ended) return false
    return gated ? reason === 'speech' : reason === 'speech' || reason === 'open'
  }

  return {
    canStart,
    /** Record that one went out. Billing starts at this instant and nowhere else. */
    start(reason) {
      if (!canStart(reason)) return false
      started = true
      return true
    },
    /** May anything else go on the wire? */
    canSend() {
      return started && !ended
    },
    /** Record the end frame. Billing stops here. */
    end() {
      if (!started || ended) return false
      ended = true
      return true
    },
    get state() {
      return ended ? 'ended' : started ? 'streaming' : 'idle'
    },
  }
}

/**
 * Whether an utterance has gone long enough without speech to end the billed
 * stream. Its own function because a wrong comparison here does not break
 * anything visible — it just quietly keeps the meter running.
 */
export function silenceElapsed(now, lastVoiceAt, silenceMs = POOL_DEFAULTS.silenceMs) {
  return lastVoiceAt > 0 && now - lastVoiceAt >= silenceMs
}

/**
 * How many captured frames to keep when there is no stream to send them on yet.
 *
 * Two different situations, and conflating them is exactly what clips the first
 * word of a sentence:
 *
 *   idle      nobody is speaking. A small rolling ring, holding audio that
 *             MIGHT turn out to precede an onset. Dropping the oldest frame is
 *             correct — it is silence nobody will ever want.
 *
 *   starting  a stream has been asked for and speech is ALREADY HAPPENING. On
 *             the warm path this lasts no time at all, but with an empty pool
 *             it lasts a full handshake (~615ms measured) — and the gate has
 *             just handed over its own 400ms of pre-roll on top. Dropping the
 *             oldest frame here discards the beginning of the sentence, which
 *             is the one thing pre-roll exists to protect.
 *
 * So while starting, nothing is dropped until a bound that only exists so a
 * connection that never opens cannot grow memory without limit.
 */
export function bufferCapacity({ starting, prerollFrames, maxFrames }) {
  return starting ? maxFrames : prerollFrames
}

/**
 * Whether a keepalive is due.
 *
 * Only a continuous stream ever needs one. A pooled stream lives for a single
 * utterance and the silence gate ends it long before Soniox's 20s idle close;
 * a continuous stream is held across pauses, and when the caller is gating
 * there is no audio flowing through those pauses to keep it alive. Sending one
 * before the start request is a protocol error, so this only ever answers true
 * for a stream that is already running.
 */
export function keepaliveDue(now, lastSentAt, { pooled, streaming, keepaliveMs = POOL_DEFAULTS.keepaliveMs }) {
  if (pooled || !streaming) return false
  return now - lastSentAt >= keepaliveMs
}

/**
 * A temporary key is refreshed BETWEEN utterances, never at the onset of one:
 * minting costs about half a second, which is more than the entire latency
 * budget this design exists to protect. Refreshed at 90% of its life, so a
 * refresh that fails still leaves time to try again before the key dies.
 */
export function shouldRefreshKey(now, mintedAt, ttlSeconds, streaming) {
  if (streaming || !mintedAt || !ttlSeconds) return false
  return now - mintedAt >= ttlSeconds * 1000 * 0.9
}

/**
 * How many pre-roll frames to keep.
 *
 * Speech exists before the gate notices it, and a stream that begins at the
 * onset has already missed the start of the word that triggered it. The ring
 * buffer is flushed straight after the start request.
 */
export function prerollFrames(preRollMs, frameSamples, sampleRate) {
  const frameMs = (frameSamples / (sampleRate || 48000)) * 1000
  return Math.max(1, Math.ceil(preRollMs / frameMs))
}
