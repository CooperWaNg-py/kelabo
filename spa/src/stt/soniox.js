import { createReader } from '../transcript/stt/soniox.js'
import {
  POOL_DEFAULTS,
  createBillingGuard,
  expiredConnections,
  pickConnection,
  bufferCapacity,
  keepaliveDue,
  prerollFrames,
  refillCount,
  shouldRefreshKey,
  silenceElapsed,
} from './sonioxPolicy.js'

// Soniox, as an `SttClient` (see ./interface.js).
//
// THE ONE FACT THAT SHAPES EVERYTHING: Soniox bills the wall-clock lifetime of a
// stream, not the audio it receives, and the clock starts at the START REQUEST
// rather than at connection setup. Their own wording, on
// `max_session_duration_seconds`: "The timer starts when the stream is opened
// (not when the underlying connection is established)." A connection that has
// been opened and has sent nothing at all produces no usage-log entry and no
// charge.
//
// So a socket held open for a whole kelabo would bill the whole kelabo, per
// participant, whether or not anybody spoke — about $0.06/hr each of pure
// silence. Instead:
//
//        pool: 2 connections, OPEN, 0 bytes sent          $0, no usage record
//          |
//   speech ├─ take the oldest, send the start request     <- billing starts
//          |  flush pre-roll, then live audio
//          |  refill the pool IMMEDIATELY, not at the end
//          v
//   3s silence ─ send the empty frame                     <- billing stops
//               retire the socket to `draining` for its trailing finals
//
// The handshake is off the critical path because it was paid during silence:
// ~615ms of connect becomes 0, leaving only the ~385ms the service itself takes.
// Refilling on acquisition rather than at the end of the utterance is what keeps
// a spare warm for someone who starts talking again immediately.
//
// TWO STRATEGIES, because the pool is not always right:
//
//   gated       silence skipping on AND diarization off. The design above.
//   continuous  one stream for the session, started at connect. Used when the
//               caller is not gating (no speech edge to trigger on) or when
//               diarization is on — Soniox numbers speakers PER STREAM, so
//               per-utterance streams would make "1" a different person every
//               time, and the host's rename would follow the label onto the
//               wrong voice. Continuity beats the saving there, and a room with
//               diarization on is a room where somebody is nearly always
//               talking, so there was little saving to have.
//
// Every decision that costs money is in ./sonioxPolicy.js, pure and tested.
// This file is wiring: it does no arithmetic of its own.

// Rolling pre-roll while nobody is speaking: audio that might turn out to
// precede an onset.
const PREROLL_MS = 300
// The ceiling on what is held while a stream is being established. Only a
// safety valve — a connection that never opens must not grow memory without
// limit — never a trimming policy for speech that has already happened.
const MAX_BUFFERED_MS = 10_000

/** @type {import('./interface.js').SttClient} */
export const sonioxClient = {
  id: 'soniox',
  label: 'Soniox',

  capabilities: {
    // Bundled in the rate rather than sold as an add-on, and good enough to be
    // the reason to reach for this provider. There is no case for asking.
    diarization: 'always',
    maxSpeakers: 15,
  },

  // The gate is what makes a stream start and stop, so it is not a cost control
  // here — it IS the cost control. Without it every kelabo is one continuous
  // billed stream.
  prefersVad: true,

  createReader,

  connect(ctx) {
    const {
      session: firstSession,
      sampleRate,
      diarize,
      language,
      gated,
      renew,
      onRead,
      onStreamStart,
      onState,
      log,
    } = ctx

    // Per-utterance streams destroy cross-utterance speaker identity, so they
    // are only used where identity does not matter.
    const pooled = gated && !diarize
    const cfg = { ...POOL_DEFAULTS, ...(firstSession.params?.kelaboPool || {}) }
    const reader = createReader({ diarize })

    let session = firstSession
    let sessionAt = Date.now()
    let closed = false

    /** Connected, unconfigured, unbilled. @type {{sock:WebSocket, openedAt:number}[]} */
    let pool = []
    let opening = 0
    /** The connection carrying the current stream, and its guard. */
    let ws = null
    let guard = null
    let watchdog = null
    let sawResponse = false
    /** Frames captured before the stream could accept them. */
    let preroll = []
    // A stream has been asked for but cannot take audio yet. On the warm path
    // this is never true for longer than a function call; with an empty pool it
    // spans a whole handshake, and everything captured in that window is speech
    // the speaker has already said.
    let starting = false
    let lastVoiceAt = 0
    let lastAudioSentAt = 0
    // Audio only, never keepalives: this answers "are frames leaving right
    // now", which is a different question from "is a stream open".
    let lastFrameAt = 0
    let sweeper = null

    const ttlSeconds = session.expiresInSeconds || 600

    // ---- the two chokepoints ------------------------------------------------
    // Every byte this provider puts on the wire goes through one of these. That
    // is what makes "a pooled connection is never billed" a property of the code
    // rather than of everybody remembering.

    function sendStartRequest(sock, reason) {
      if (!sock || sock.readyState !== WebSocket.OPEN) return false
      if (!guard || !guard.start(reason)) return false

      sock.send(
        JSON.stringify({
          api_key: session.token,
          ...session.params,
          // The real AudioContext rate. Asking for 16000 is a hint browsers are
          // free to ignore, and claiming a rate we do not have produces
          // chipmunk audio and a garbage transcript.
          sample_rate: sampleRate,
        }),
      )
      log('stream start', reason)
      onStreamStart()
      onState('live')

      // A socket can be killed by a NAT without a close frame and still report
      // OPEN. If the start request draws no answer at all, it was already dead
      // when it came out of the pool.
      sawResponse = false
      clearTimeout(watchdog)
      watchdog = setTimeout(() => {
        if (!sawResponse && ws === sock) {
          log('start request watchdog: half-open connection')
          abortStream()
        }
      }, cfg.watchdogMs)
      return true
    }

    function sendOnStream(payload) {
      if (!ws || ws.readyState !== WebSocket.OPEN) return false
      if (!guard || !guard.canSend()) return false
      try {
        ws.send(payload)
      } catch {
        return false
      }
      return true
    }

    // Soniox closes a stream that has seen neither audio nor a keepalive for
    // more than 20s, and a keepalive is only legal AFTER the start request —
    // which is why it goes through the chokepoint like everything else and can
    // never reach a pooled connection.
    //
    // Only continuous mode needs it. A pooled stream lives for one utterance
    // and is ended by the silence gate long before 20s; a continuous one is
    // held open across pauses, and when the caller is gating there is no audio
    // flowing through them to keep it alive.
    function keepaliveIfIdle(now) {
      const due = keepaliveDue(now, lastAudioSentAt, {
        pooled,
        streaming: !!ws && !!guard?.canSend(),
        keepaliveMs: cfg.keepaliveMs,
      })
      if (due && sendOnStream(JSON.stringify({ type: 'keepalive' }))) lastAudioSentAt = now
    }

    // ---- the pool -----------------------------------------------------------

    function openPoolConn() {
      opening += 1
      let entry = null
      let sock
      try {
        sock = new WebSocket(session.url)
      } catch {
        opening -= 1
        return
      }
      sock.binaryType = 'arraybuffer'

      sock.onopen = () => {
        opening -= 1
        if (closed) {
          try { sock.close() } catch {}
          return
        }
        // Send NOTHING. No config, no keepalive — a keepalive before the start
        // request is a protocol error, and anything at all here ends the
        // property that makes this connection free.
        entry = { sock, openedAt: Date.now() }
        pool.push(entry)
      }
      sock.onclose = () => {
        if (!entry) opening -= 1
        const i = pool.indexOf(entry)
        if (i >= 0) pool.splice(i, 1)
        if (!closed) setTimeout(ensurePool, 300)
      }
      sock.onerror = () => {}
      // A pooled connection has sent nothing, so the server has nothing to
      // answer. Anything arriving here is a bug worth seeing.
      sock.onmessage = () => log('unconfigured pool connection received data — bug')
    }

    function ensurePool() {
      if (closed || !pooled) return
      let n = refillCount(pool.length, opening, cfg.poolSize)
      while (n-- > 0) openPoolConn()
    }

    function acquireConn() {
      const idx = pickConnection(pool.map(e => ({ openedAt: e.openedAt, open: e.sock.readyState === WebSocket.OPEN })))
      if (idx < 0) return null
      const entry = pool.splice(idx, 1)[0]
      // Refill NOW, during this utterance, so somebody who starts talking again
      // three seconds from now still finds a warm connection.
      setTimeout(ensurePool, 0)
      return entry.sock
    }

    // ---- stream lifecycle ---------------------------------------------------

    function attach(sock) {
      sock.onmessage = ev => {
        if (typeof ev.data !== 'string') return
        sawResponse = true
        clearTimeout(watchdog)
        let msg
        try { msg = JSON.parse(ev.data) } catch { return }
        const read = reader.read(msg)
        if (read.error) {
          log('provider error', read.error.code, read.error.type, read.error.message)
          // An expired or rejected key is recoverable, but only with a new one.
          if (read.error.code === 401 || read.error.code === 403) refreshSession()
          if (read.error.code === 402) onState('stt_unavailable')
        }
        onRead(read)
      }
      sock.onclose = () => {
        if (sock === ws) {
          ws = null
          guard = null
          if (!closed && !pooled) startContinuous()
        }
      }
      sock.onerror = () => {}
    }

    function beginStream(reason) {
      if (closed || ws) return false
      // From here until the start request has gone out, nothing captured may be
      // dropped: it is already-spoken words, not speculative pre-roll.
      starting = true
      const sock = pooled ? acquireConn() : null
      if (pooled && !sock) {
        // Pool empty — a burst of utterances, or the network went away. Never
        // drop the audio: open now and pay the handshake this design normally
        // avoids.
        log('pool empty, cold start')
        coldStart(reason)
        return false
      }
      ws = sock
      guard = createBillingGuard({ gated: pooled })
      attach(sock)
      if (!sendStartRequest(sock, reason)) {
        abortStream()
        return false
      }
      lastAudioSentAt = Date.now()
      flushPreroll()
      return true
    }

    function coldStart(reason) {
      starting = true
      const sock = new WebSocket(session.url)
      sock.binaryType = 'arraybuffer'
      ws = sock
      guard = createBillingGuard({ gated: pooled })
      attach(sock)
      onState('connecting')
      sock.onopen = () => {
        if (closed || ws !== sock) {
          try { sock.close() } catch {}
          return
        }
        if (!sendStartRequest(sock, reason)) return abortStream()
        flushPreroll()
      }
    }

    // Not gated: there is no speech edge to start on, so one stream runs for the
    // session and is held open with keepalives.
    function startContinuous() {
      if (closed || ws) return
      starting = true
      onState('connecting')
      const sock = new WebSocket(session.url)
      sock.binaryType = 'arraybuffer'
      ws = sock
      guard = createBillingGuard({ gated: false })
      attach(sock)
      sock.onopen = () => {
        if (closed || ws !== sock) {
          try { sock.close() } catch {}
          return
        }
        if (!sendStartRequest(sock, 'open')) return abortStream()
        flushPreroll()
      }
    }

    function flushPreroll() {
      for (const buf of preroll) sendOnStream(buf)
      preroll = []
      starting = false
    }

    /** End the billed stream cleanly and keep listening for trailing finals. */
    function endStream() {
      const sock = ws
      if (!sock || !guard) return
      // Empty frame = end of audio. Through the chokepoint like everything
      // else, so there are exactly two raw sends in this file and both are
      // guarded — a property `spa/test/soniox.mjs` checks by reading the source.
      sendOnStream('')
      guard.end()
      log('stream end')
      ws = null
      guard = null
      clearTimeout(watchdog)
      // One connection carries exactly one stream: the server closes it after
      // `finished`. Hold the reference only so trailing finals still land.
      setTimeout(() => {
        try { sock.close() } catch {}
      }, cfg.drainMs)
      ensurePool()
    }

    /** Give up on a stream without pretending it ended properly. */
    function abortStream() {
      const sock = ws
      ws = null
      guard = null
      clearTimeout(watchdog)
      starting = false
      if (sock) {
        try { sock.close() } catch {}
      }
      ensurePool()
    }

    async function refreshSession() {
      try {
        session = await renew()
        sessionAt = Date.now()
        log('session renewed')
      } catch {
        log('session renew failed')
      }
    }

    // ---- the clock ----------------------------------------------------------
    // One timer: end a stream that has gone quiet, retire stale pool
    // connections, and refresh the key between utterances rather than at the
    // start of one.
    sweeper = setInterval(() => {
      if (closed) return
      const now = Date.now()

      if (pooled && ws && guard?.canSend() && silenceElapsed(now, lastVoiceAt, cfg.silenceMs)) {
        endStream()
      }

      if (pooled) {
        for (const i of expiredConnections(pool, now, cfg.poolMaxAge)) {
          const entry = pool.splice(i, 1)[0]
          try { entry.sock.close() } catch {}
        }
        ensurePool()
      }

      keepaliveIfIdle(now)

      if (shouldRefreshKey(now, sessionAt, ttlSeconds, !!ws)) refreshSession()
    }, 200)

    if (pooled) {
      ensurePool()
      onState('live')
    } else {
      startContinuous()
    }

    return {
      sendAudio(pcm) {
        if (closed) return
        if (ws && guard?.canSend()) {
          if (sendOnStream(pcm)) {
            lastAudioSentAt = Date.now()
            lastFrameAt = lastAudioSentAt
          }
          return
        }
        // No stream can take this yet. Whether it may be dropped depends
        // entirely on which of those two situations we are in — see
        // `bufferCapacity`. Trimming a starting stream's buffer is what ate the
        // first words of a sentence whenever the pool happened to be empty.
        preroll.push(pcm)
        const frameSamples = pcm.byteLength / 2
        const cap = bufferCapacity({
          starting,
          prerollFrames: prerollFrames(PREROLL_MS, frameSamples, sampleRate) + 1,
          maxFrames: prerollFrames(MAX_BUFFERED_MS, frameSamples, sampleRate),
        })
        while (preroll.length > cap) preroll.shift()
      },

      setSpeaking(speaking) {
        if (closed) return
        if (speaking) {
          lastVoiceAt = Date.now()
          // The only thing in this file that may open a billable stream.
          if (pooled && !ws) beginStream('speech')
        }
      },

      close() {
        closed = true
        clearInterval(sweeper)
        clearTimeout(watchdog)
        endStream()
        for (const entry of pool) {
          try { entry.sock.close() } catch {}
        }
        pool = []
      },

      // Two facts, deliberately separate, because they disagree for seconds at
      // a time and only one of them is money. After the gate shuts, frames stop
      // immediately but the stream stays open until the silence gate expires —
      // so `sending` goes false a second before `billing` does. A panel showing
      // one of them and a light showing the other is how they came to look
      // like they contradicted each other.
      stats: () => ({
        mode: pooled ? 'pooled' : 'continuous',
        pool: pool.length,
        opening,
        streaming: !!ws && !!guard?.canSend(),
        sending: Date.now() - lastFrameAt < 400,
        // Soniox charges for the wall-clock life of the stream, whether or not
        // any audio is going through it.
        billing: !!ws && !!guard?.canSend(),
        billedBy: 'stream duration',
      }),
    }
  },
}
