import { createReader } from '../transcript/stt/deepgram.js'

// Deepgram, as an `SttClient` (see ./interface.js). Everything Deepgram-shaped
// about the browser side of capture is in this file and the reader it exports.
//
// ONE SOCKET FOR THE WHOLE CAPTURE SESSION, opened on connect and held until
// mute or the end of the kelabo. Deepgram bills the AUDIO IT RECEIVES, so an
// open socket with nothing flowing through it is free — which makes the simple
// shape also the cheap one, and is exactly why the other provider in this
// directory looks nothing like it.
//
// Configuration rides the URL, so there is no start request and no window in
// which the socket is open but unusable. Auth is the WebSocket subprotocol pair
// `['bearer', token]`, which is how a browser sends a bearer credential on a
// handshake it cannot put headers on.

const MAX_RECONNECTS = 3
// Deepgram closes an idle socket after 10s of neither audio nor KeepAlive and
// documents a 3-5s cadence. Also the "is the stream idle?" threshold: while
// audio flows a keepalive is unnecessary.
const KEEPALIVE_MS = 4000

/** @type {import('./interface.js').SttClient} */
export const deepgramClient = {
  id: 'deepgram',
  label: 'Deepgram',

  capabilities: {
    // Costed, and a separate model: worth asking for rather than assuming.
    diarization: 'optional',
    maxSpeakers: 26,
  },

  // Billing follows the audio, so skipping silence is a direct saving and the
  // gate pays for itself.
  prefersVad: true,

  createReader,

  connect(ctx) {
    const { sampleRate, diarize, language, renew, onRead, onStreamStart, onState, log } = ctx

    const reader = createReader({ diarize, language })
    let ws = null
    let closed = false
    let reconnects = 0
    let keepAliveTimer = null
    let lastAudioAt = 0
    let lastPingAt = 0

    const clearKeepAlive = () => {
      if (keepAliveTimer) clearInterval(keepAliveTimer)
      keepAliveTimer = null
    }

    const canSend = () => !!ws && ws.readyState === WebSocket.OPEN

    // Holds the socket open through gated silence without streaming (and so
    // without paying for) audio. Driven from the audio callback as well as a
    // timer, because a background tab throttles timers well past the 10s idle
    // close while the audio graph keeps running.
    const pingIfIdle = () => {
      if (!canSend()) return
      const now = Date.now()
      if (now - lastAudioAt < KEEPALIVE_MS || now - lastPingAt < KEEPALIVE_MS) return
      lastPingAt = now
      try { ws.send(JSON.stringify({ type: 'KeepAlive' })) } catch {}
    }

    const open = async () => {
      if (closed) return
      onState(reconnects > 0 ? 'reconnecting' : 'connecting')

      let session
      try {
        session = await renew()
      } catch {
        if (reconnects < MAX_RECONNECTS) {
          reconnects += 1
          onState('reconnecting')
          setTimeout(open, 1000 * reconnects)
        } else {
          onState('stt_unavailable')
        }
        return
      }
      if (closed) return

      const params = { ...(session.params || {}), sample_rate: String(sampleRate) }
      const url = `${session.url}?${new URLSearchParams(params).toString()}`
      const sock = new WebSocket(url, ['bearer', session.token])
      sock.binaryType = 'arraybuffer'
      sock._intentionalClose = false
      ws = sock

      sock.onopen = () => {
        reconnects = 0
        lastAudioAt = Date.now()
        lastPingAt = lastAudioAt
        // A fresh stream restarts Deepgram's audio clock at zero, so the
        // reader's finalized-span cursor and the caller's clock mapping restart
        // with it — otherwise every final on the new socket looks already
        // covered and is dropped.
        reader.reset()
        onStreamStart()
        onState('live')
        clearKeepAlive()
        keepAliveTimer = setInterval(pingIfIdle, 2000)
      }

      // Ignore anything from a socket that has been superseded, or a stale
      // connection injects the same finals a second time.
      sock.onmessage = ev => {
        if (ws !== sock) return
        let msg
        try { msg = JSON.parse(ev.data) } catch { return }
        onRead(reader.read(msg))
      }

      sock.onclose = () => {
        clearKeepAlive()
        if (sock._intentionalClose || closed) return
        if (ws && ws !== sock) return // superseded
        if (reconnects < MAX_RECONNECTS) {
          reconnects += 1
          onState('reconnecting')
          setTimeout(open, 1000 * reconnects)
        } else {
          onState('stt_unavailable')
        }
      }

      sock.onerror = () => {}
    }

    open()

    return {
      sendAudio(pcm) {
        if (!canSend()) return
        try { ws.send(pcm) } catch { return }
        lastAudioAt = Date.now()
      },

      setSpeaking(speaking) {
        if (speaking || !canSend()) {
          if (!speaking) pingIfIdle()
          return
        }
        // The gate shut. Flush whatever Deepgram is still holding: with the
        // trailing silence cut, waiting for its own endpointer could strand the
        // last words. Not a seal — the answer resets the composer's clock like
        // any other message.
        try { ws.send(JSON.stringify({ type: 'Finalize' })) } catch {}
        pingIfIdle()
      },

      close() {
        closed = true
        clearKeepAlive()
        const sock = ws
        ws = null
        if (!sock) return
        sock._intentionalClose = true
        try {
          if (sock.readyState === WebSocket.OPEN) {
            sock.send(JSON.stringify({ type: 'CloseStream' }))
          }
          sock.close()
        } catch {}
      },

      // Same two facts as every provider, but they mean the opposite thing
      // here: the socket is open for the whole kelabo and costs nothing while
      // idle, because Deepgram bills the audio it receives rather than the
      // time the socket is held.
      stats: () => ({
        mode: 'single',
        streaming: canSend(),
        sending: Date.now() - lastAudioAt < 400,
        billing: canSend() && Date.now() - lastAudioAt < 400,
        billedBy: 'audio sent',
      }),
    }
  },
}
