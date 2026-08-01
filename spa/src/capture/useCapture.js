import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../api'
import { useToast } from '../components/Toaster'
import { createSpeechGate } from './vad'
import { createComposer } from '../transcript/composer'
import { readResult } from '../transcript/deepgram'
import { createPublisher } from '../transcript/publisher'
import { fromWire, messageSealed, newMessageId } from '../transcript/events'
import { apply, emptyTranscript, messages, renameSpeaker as renameInTranscript } from '../transcript/transcriptStore'

// The Capture stage (docs 13), plus the React binding for the stages after it.
//
// This hook owns the microphone pipeline and the Deepgram socket, and turns
// their output into *fragments*. It owns no message logic: composing fragments
// into messages is `transcript/composer.js`, and projecting messages for display
// is `transcript/transcriptStore.js`.
//
// The binding below is the whole point of that split:
//
//     composer.emit(event)  ->  publisher.publish(event)   (to everyone else)
//                           ->  apply(transcript, event)   (to my own screen)
//
// My own view is built by the same reducer, from the same events, that every
// listener receives. A speaker and a listener cannot group speech differently
// because there is only one implementation of grouping. Previously there were
// two — a line per fragment here, a line per message for remote speech — and
// they disagreed.

const MAX_RECONNECTS = 3
// ScriptProcessor buffer size: ~85ms of audio at 48kHz.
const FRAME_SAMPLES = 4096
// Deepgram closes an idle socket after 10s of neither audio nor KeepAlive, and
// documents a 3-5s KeepAlive cadence. This is also the "is the stream idle?"
// threshold: while audio flows, KeepAlive is unnecessary.
const KEEPALIVE_MS = 4000
// The seal trigger: this much time with nothing at all from Deepgram closes the
// open message. It is the ONLY silence trigger — the VAD gate decides which
// audio is worth transcribing and nothing else (docs 13).
const SILENCE_TIMEOUT_MS = 1000
// How often that is evaluated. Well under the timeout, so the seal still lands
// within a beat of the speaker actually stopping.
const IDLE_POLL_MS = 200
// Deepgram returns per-token words for CJK languages; joining them with spaces
// corrupts the text by inserting spurious spaces between tokens.
const CJK_LANGS = new Set(['zh', 'ja', 'ko'])

function speakerLetter(n) {
  const num = Number.isInteger(n) ? n : 0
  return String.fromCharCode(65 + Math.min(Math.max(num, 0), 25))
}

function floatTo16BitPCM(input) {
  const out = new Int16Array(input.length)
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i]))
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff
  }
  return out.buffer
}

// `stream` is the shared microphone owned by useMicStream — this hook never
// calls getUserMedia itself, so the conference transport and Deepgram capture
// share exactly one device capture. `micError` carries that hook's failure
// ('mic_denied' | 'insecure_context') so the Capture pane still reports it.
export function useCapture({ kelaboId, enabled, finalOnly, startedAt, language = 'en', diarize = false, displayName = '', myIdentity = '', stream = null, micError = null, vad = true, startMuted = false }) {
  const toast = useToast()
  const clientId = useMemo(() => (crypto.randomUUID ? crypto.randomUUID() : String(Math.random())), [])
  const [state, setState] = useState('idle')
  // Somebody who chose to join muted is muted from the first frame, not a
  // second later: `start(skipSocket)` builds the analysis graph without opening
  // the Deepgram socket, so nothing is streamed or billed until they unmute.
  // Muting after the fact would have transcribed the moment they walked in.
  const [muted, setMuted] = useState(startMuted)
  // The projected transcript — every message, mine and everyone else's, built by
  // one reducer. A message carries its own live tail, so there is no separate
  // preview state: a second piece of UI state for in-progress speech is what
  // rendered two boxes for one utterance.
  const [transcript, setTranscript] = useState(emptyTranscript)
  // Gate open — i.e. the mic is currently carrying speech and audio is billing.
  // Always true when VAD is off, where every frame is streamed.
  const [speaking, setSpeaking] = useState(false)

  const languageRef = useRef(language)
  languageRef.current = language
  const diarizeRef = useRef(diarize)
  diarizeRef.current = diarize
  const streamPropRef = useRef(stream)
  streamPropRef.current = stream
  const displayNameRef = useRef(displayName)
  displayNameRef.current = displayName
  const myIdentityRef = useRef(myIdentity)
  myIdentityRef.current = myIdentity
  const vadRef = useRef(vad)
  vadRef.current = vad
  const finalOnlyRef = useRef(finalOnly)
  finalOnlyRef.current = finalOnly
  // Read by `sendTyped`, which must stay stable across renders and so cannot
  // close over the prop.
  const startedAtRef = useRef(startedAt)
  startedAtRef.current = startedAt

  // Label for a diarization speaker index. When diarization is off, everything
  // is attributed to me (displayName); when on, use the A/B voice labels.
  const labelFor = sp => (diarizeRef.current ? speakerLetter(sp) : (displayNameRef.current || 'You'))

  const streamRef = useRef(null)
  const ctxRef = useRef(null)
  const wsRef = useRef(null)
  const keepAliveRef = useRef(null)
  const reconnectsRef = useRef(0)
  const stoppedRef = useRef(false)
  const captureStartRef = useRef(0)
  // End of the audio span already finalized, per Deepgram's response-span model:
  // every response covers [start, start+duration] and is_final makes it
  // authoritative for that span. A later final whose span is already covered is
  // a re-emission (CJK models do this) and is ignored wholesale.
  const finalCursorRef = useRef(0)

  // VAD gate plus the bookkeeping that converts Deepgram's audio clock back to
  // wall clock. Deepgram timestamps count only the audio it received, so every
  // second of skipped silence shifts word times earlier; `bursts` records, for
  // each contiguous run of streamed audio, where its start sat on both clocks.
  const gateRef = useRef(null)
  const sentSamplesRef = useRef(0)
  const burstsRef = useRef([])
  const lastAudioAtRef = useRef(0)
  const lastPingAtRef = useRef(0)
  const speakingRef = useRef(false)

  const setSpeakingOnce = on => {
    if (speakingRef.current === on) return
    speakingRef.current = on
    setSpeaking(on)
  }

  const wallAt = sec => {
    const list = burstsRef.current
    let burst = list[0]
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i].audio <= sec + 1e-3) { burst = list[i]; break }
    }
    if (!burst) return captureStartRef.current + sec * 1000
    return burst.wall + (sec - burst.audio) * 1000
  }
  // Deepgram audio-clock seconds -> ms since the kelabo started, which is what
  // the transcript orders messages by.
  const stampFor = sec => Math.round(wallAt(sec) - (startedAt || captureStartRef.current))

  const joiner = () => (CJK_LANGS.has(languageRef.current) ? '' : ' ')

  // Verbose STT logging, enabled together with the Debug drawer.
  const dbg = (...args) => {
    if (localStorage.getItem('kelabo-debug') === '1') console.log('[stt]', new Date().toISOString().slice(11, 23), ...args)
  }
  const audioStatsRef = useRef({ frames: 0, pipelines: 0, lastLog: 0 })

  // --- Compose + Publish + Project, bound together --------------------------
  const publisherRef = useRef(null)
  if (!publisherRef.current) {
    publisherRef.current = createPublisher({
      kelaboId,
      clientId,
      displayName: () => displayNameRef.current,
      diarized: () => diarizeRef.current,
      // A rejected caption is dropped on purpose, but never silently: the
      // gateway returns the schema issues that rejected it, and without printing
      // them a payload bug is indistinguishable from a flaky network.
      onError: (payload, err) =>
        dbg(`caption ${payload.kind} FAILED ${err?.status ?? ''} ${err?.code ?? ''}`, err?.detail ?? err?.message ?? ''),
    })
  }

  const composerRef = useRef(null)
  if (!composerRef.current) {
    composerRef.current = createComposer({
      // Whatever identity the server will stamp on my captions, so my own echo
      // is recognisable. A guest has no email, which is why this is the
      // participant identity and not the signed-in address.
      speakerId: myIdentity,
      silenceTimeoutMs: SILENCE_TIMEOUT_MS,
      emit: event => {
        dbg(event.type, { messageId: event.messageId, text: event.text, reason: event.reason })
        // Everyone else...
        publisherRef.current.publish(event)
        // ...and me, through the identical reducer. This line is the invariant.
        setTranscript(prev => apply(prev, event, { mine: true }))
      },
    })
  }
  // The composer is created once but reads a changing identity.
  composerRef.current.speakerId = myIdentity


  // The seal clock is polled, not armed. As a one-shot timer it had to be
  // re-armed from every place a Deepgram result was handled, and the one place
  // that forgot (interim results in `finalOnly` mode) sealed messages while the
  // speaker was still talking. Polling asks the composer a question it can
  // always answer correctly instead of relying on every call site.
  useEffect(() => {
    const t = setInterval(() => {
      composerRef.current.sealIfIdle()
    }, IDLE_POLL_MS)
    return () => clearInterval(t)
  }, [])

  // Reading the wire is `transcript/deepgram.js` (pure, tested); this maps what
  // it read onto the composer and converts Deepgram's audio clock to wall time.
  const handleMessage = useCallback(ev => {
    let msg
    try { msg = JSON.parse(ev.data) } catch { return }

    const r = readResult(msg, {
      cursor: finalCursorRef.current,
      diarize: diarizeRef.current,
      joiner: joiner(),
    })
    // Only results carrying TEXT count as activity. Deepgram emits empty results
    // continuously while it receives audio containing no speech, and treating
    // those as activity kept the seal clock alive forever — a message then never
    // closed at all.
    composerRef.current.noteActivity(r.hasText)
    if (r.cursor != null) finalCursorRef.current = r.cursor

    if (r.kind === 'interim') {
      // Never persisted, never given to the LLM: liveness only.
      if (finalOnlyRef.current) return
      composerRef.current.setTail({
        text: r.text,
        speakerLabel: labelFor(r.speaker),
        key: diarizeRef.current ? speakerLetter(r.speaker) : '__me',
        tStart: stampFor(r.tStart),
        tEnd: stampFor(r.tEnd),
      })
      return
    }

    if (r.kind === 'covered') {
      if (r.text) dbg('final DROPPED (span already covered)', r.text)
      return
    }
    if (r.kind !== 'final') return

    dbg('final', r.text)
    // Straight to the composer, with nothing buffered in between. Consecutive
    // finals from one speaker join inside the open message and a diarized
    // speaker change seals it — both already the composer's rules.
    for (const seg of r.segments) {
      composerRef.current.addFragment({
        text: seg.text,
        speakerLabel: labelFor(seg.sp),
        key: diarizeRef.current ? speakerLetter(seg.sp) : '__me',
        tStart: stampFor(seg.start || 0),
        tEnd: stampFor(seg.end || 0),
      })
    }
  }, [startedAt]) // eslint-disable-line react-hooks/exhaustive-deps

  const clearKeepAlive = () => {
    if (keepAliveRef.current) {
      clearInterval(keepAliveRef.current)
      keepAliveRef.current = null
    }
  }

  const closeSocket = useCallback((graceful = true) => {
    clearKeepAlive()
    const ws = wsRef.current
    wsRef.current = null
    if (ws) {
      // Per-socket flag (not a shared ref): the old socket's onclose fires
      // asynchronously, possibly after a new socket already opened, and must
      // not trigger a spurious reconnect.
      ws._intentionalClose = true
      try {
        if (graceful && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'CloseStream' }))
        }
        ws.close()
      } catch {}
    }
  }, [])

  // Stream frames and advance the audio clock. `opened` marks the first send of
  // a burst: the frames handed over end at "now", so the burst starts that many
  // frame-durations earlier on the wall clock.
  const sendFrames = (buffers, opened) => {
    const ws = wsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    const rate = ctxRef.current?.sampleRate || 48000
    if (opened) {
      const bursts = burstsRef.current
      bursts.push({
        audio: sentSamplesRef.current / rate,
        wall: Date.now() - (buffers.length * FRAME_SAMPLES * 1000) / rate,
      })
      if (bursts.length > 400) bursts.splice(0, 200)
    }
    for (const buf of buffers) {
      try { ws.send(buf) } catch { return }
    }
    sentSamplesRef.current += buffers.length * FRAME_SAMPLES
    lastAudioAtRef.current = Date.now()
  }

  // KeepAlive holds the socket open through gated silence without streaming
  // (and without billing) audio. Driven from the audio callback as well as a
  // timer, because background tabs throttle timers well past Deepgram's 10s
  // idle close while the audio graph keeps running.
  const pingIfIdle = () => {
    const ws = wsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    const now = Date.now()
    if (now - lastAudioAtRef.current < KEEPALIVE_MS || now - lastPingAtRef.current < KEEPALIVE_MS) return
    lastPingAtRef.current = now
    try { ws.send(JSON.stringify({ type: 'KeepAlive' })) } catch {}
  }

  const connectSocket = useCallback(async () => {
    if (stoppedRef.current) return
    // Never hold two live connections: a previous socket must be closed
    // intentionally (and its messages ignored) before opening the next one,
    // otherwise both transcribe the same audio and duplicate every turn.
    closeSocket(true)
    setState(reconnectsRef.current > 0 ? 'reconnecting' : 'connecting')
    let tokenData
    try {
      tokenData = await api.sttToken(kelaboId, { language: languageRef.current, diarize: diarizeRef.current })
    } catch {
      if (reconnectsRef.current < MAX_RECONNECTS) {
        reconnectsRef.current += 1
        setState('reconnecting')
        setTimeout(() => connectSocket(), 1000 * reconnectsRef.current)
      } else {
        setState('stt_unavailable')
      }
      return
    }
    if (stoppedRef.current) return

    const params = { ...(tokenData.params || {}), sample_rate: String(ctxRef.current?.sampleRate || 16000) }
    const url = 'wss://api.deepgram.com/v1/listen?' + new URLSearchParams(params).toString()
    const ws = new WebSocket(url, ['bearer', tokenData.token])
    ws.binaryType = 'arraybuffer'
    ws._intentionalClose = false
    wsRef.current = ws

    ws.onopen = () => {
      reconnectsRef.current = 0
      captureStartRef.current = Date.now()
      // A fresh stream restarts Deepgram's audio clock at zero, so the
      // finalized-span cursor and the audio-clock mapping must restart with it
      // or every final on the new socket looks already covered.
      finalCursorRef.current = 0
      sentSamplesRef.current = 0
      burstsRef.current = [{ audio: 0, wall: captureStartRef.current }]
      lastAudioAtRef.current = captureStartRef.current
      lastPingAtRef.current = captureStartRef.current
      gateRef.current?.reset()
      composerRef.current.reset()
      setSpeakingOnce(false)
      setState('live')
      clearKeepAlive()
      keepAliveRef.current = setInterval(pingIfIdle, 2000)
    }
    // Ignore messages from any socket that has been superseded — otherwise a
    // stale connection injects the same finals a second time.
    ws.onmessage = ev => { if (wsRef.current === ws) handleMessage(ev) }
    ws.onclose = () => {
      clearKeepAlive()
      if (ws._intentionalClose || stoppedRef.current) return
      if (wsRef.current && wsRef.current !== ws) return // superseded
      if (reconnectsRef.current < MAX_RECONNECTS) {
        reconnectsRef.current += 1
        setState('reconnecting')
        toast('Transcription reconnecting…')
        setTimeout(() => connectSocket(), 1000 * reconnectsRef.current)
      } else {
        setState('stt_unavailable')
        toast('Transcription unavailable — board still works')
      }
    }
    ws.onerror = () => {}
  }, [kelaboId, handleMessage, toast, closeSocket])

  // Read by the start effect, which must see the current value without taking a
  // dependency on it.
  const mutedRef = useRef(startMuted)
  mutedRef.current = muted

  const startingRef = useRef(false)
  const start = useCallback(async (skipSocket = false) => {
    if (stoppedRef.current) return
    if (streamRef.current || startingRef.current) return // never build a second pipeline
    // The microphone belongs to useMicStream; without it there is nothing to
    // analyse yet, and the effect below re-runs once it arrives.
    const micStream = streamPropRef.current
    if (!micStream) return
    startingRef.current = true
    if (!skipSocket) setState('connecting')
    try {
      streamRef.current = micStream
      const AC = window.AudioContext || window.webkitAudioContext
      const ctx = new AC()
      ctxRef.current = ctx
      const source = ctx.createMediaStreamSource(micStream)
      const processor = ctx.createScriptProcessor(FRAME_SAMPLES, 1, 1)
      audioStatsRef.current.pipelines += 1
      processor.onaudioprocess = e => {
        const ws = wsRef.current
        if (!ws || ws.readyState !== WebSocket.OPEN) return
        const stats = audioStatsRef.current
        stats.frames += 1
        const samples = e.inputBuffer.getChannelData(0)
        const pcm = floatTo16BitPCM(samples)
        if (!vadRef.current) {
          gateRef.current = null
          setSpeakingOnce(true)
          // A gap (VAD just turned off, or the gate was shut) is a new burst.
          sendFrames([pcm], Date.now() - lastAudioAtRef.current > 250)
          return
        }
        if (!gateRef.current) {
          gateRef.current = createSpeechGate({ sampleRate: ctx.sampleRate, frameSamples: FRAME_SAMPLES })
        }
        const r = gateRef.current.push(samples, pcm)
        if (r.send.length) {
          setSpeakingOnce(true)
          sendFrames(r.send, r.opened)
          return
        }
        if (r.closed) {
          setSpeakingOnce(false)
          // Flush whatever Deepgram is still holding: with the trailing silence
          // cut, waiting for its endpointer could strand the last words.
          // Forces Deepgram to emit what it is holding. Not a seal: the answer
          // resets the seal clock like any other message, and the message closes
          // 1s later if nothing more arrives.
          try { ws.send(JSON.stringify({ type: 'Finalize' })) } catch {}
          dbg('gate closed', gateRef.current.stats())
        }
        pingIfIdle()
      }
      source.connect(processor)
      processor.connect(ctx.destination)
      if (!skipSocket) await connectSocket()
      startingRef.current = false
    } catch {
      startingRef.current = false
      setState('mic_denied')
    }
  }, [connectSocket])

  // Nothing is buffered ahead of the composer any more, so closing a message is
  // just the seal. (This used to flush a pending queue first — the queue is what
  // could strand a final that Deepgram had already confirmed.)
  const sealAndFlush = useCallback(reason => {
    composerRef.current.seal(reason)
  }, [])

  const mute = useCallback(() => {
    sealAndFlush('mute')
    closeSocket(true)
    setMuted(true)
    setState('muted')
    setSpeakingOnce(false)
  }, [closeSocket, sealAndFlush])

  const unmute = useCallback(() => {
    // Unmuting is a CALL action: `muted` is what gates the outgoing conference
    // track (useRtc), so it flips here, immediately and unconditionally — the
    // room hears the speaker the moment they ask. Transcription is a tap on the
    // same stream, restarted *afterwards* and only where this kelabo transcribes
    // at all; its failure demotes captions ("Transcription unavailable"), never
    // the audio. Flipping `muted` only inside the Deepgram socket's onopen —
    // the old behaviour — made "unmute" mean "successfully connect to
    // Deepgram", which froze the mic on every deployment where Deepgram was
    // absent, unconfigured or broken.
    setMuted(false)
    if (!enabled || stoppedRef.current) {
      setState(s => (s === 'muted' ? 'idle' : s))
      return
    }
    setState('connecting')
    reconnectsRef.current = 0
    // Analysis pipeline may have been torn down (e.g. the shared stream was
    // re-acquired while muted).
    if (!streamRef.current || !ctxRef.current) start()
    else connectSocket()
  }, [enabled, connectSocket, start])

  const stop = useCallback(() => {
    stoppedRef.current = true
    sealAndFlush('stop')
    closeSocket(true)
    // The MediaStream is not ours to stop — useMicStream owns the device and
    // the conference transport is still publishing from it.
    streamRef.current = null
    ctxRef.current?.close().catch(() => {})
    ctxRef.current = null
    gateRef.current = null
    setSpeakingOnce(false)
    setState('ended')
  }, [closeSocket, sealAndFlush])

  // Retroactively relabel a speaker (driven by the server `rename` SSE event so
  // every client stays consistent). Label only — never the text or boundaries.
  const renameSpeaker = useCallback((from, to) => {
    setTranscript(prev => renameInTranscript(prev, from, to))
  }, [])

  /**
   * A message the participant typed instead of said.
   *
   * It takes the composer's own exit — publish to everyone, apply to me —
   * rather than posting a caption of its own, so a typed line is grouped,
   * ordered and rendered by exactly the code that handles speech. The composer
   * is bypassed only because there is nothing to compose: the words arrived
   * whole and are sealed the moment they are sent, which is what a `SEALED`
   * event already means.
   *
   * Works with the microphone off. Someone who joined watch-only, or muted,
   * still has something to say — and typing it is the only way they can.
   */
  const sendTyped = useCallback(text => {
    const body = String(text || '').trim()
    if (!body) return null
    const at = Date.now() - (startedAtRef.current || captureStartRef.current || Date.now())
    const stamp = Math.max(0, at)
    const event = messageSealed({
      messageId: newMessageId(),
      speakerId: myIdentityRef.current,
      // Never a diarization letter: the typist is known, and attributing typed
      // words to whichever voice Deepgram happens to be labelling "B" would put
      // them in someone else's mouth.
      speakerLabel: displayNameRef.current || 'You',
      text: body,
      tStart: stamp,
      tEnd: stamp,
      reason: 'typed',
      source: 'typed',
    })
    publisherRef.current.publish(event)
    setTranscript(prev => apply(prev, event, { mine: true }))
    return event
  }, [])

  /**
   * Persisted messages fetched on (re)entry — the backfill that makes leaving
   * and re-entering a room show the conversation instead of an empty panel.
   *
   * Rows go through `fromWire` into the same reducer as live events, under the
   * same messageId the live event carried, and `apply` ignores a messageId that
   * is already sealed — so seeding after a reconnect cannot duplicate a message
   * that also arrived live. No `by`-echo filter here: my own past messages are
   * exactly what a backfill is for.
   */
  const seedHistory = useCallback(rows => {
    if (!Array.isArray(rows) || rows.length === 0) return
    setTranscript(prev => {
      let next = prev
      for (const utt of rows) {
        const event = fromWire(utt)
        if (!event) continue
        // Display only. Persisted rows carry no author identity, so fall back
        // to the display name the row was attributed to.
        const mine =
          (!!utt.by && utt.by === myIdentityRef.current) ||
          (!utt.by && !!utt.speaker && utt.speaker === displayNameRef.current)
        next = apply(next, event, { mine, at: utt.at })
      }
      return next
    })
  }, [])

  // Someone else's speech, arriving over SSE. It goes through `fromWire` into
  // the SAME reducer my own speech goes through — there is no separate remote
  // path to drift from the local one.
  const addRemoteUtterance = useCallback(utt => {
    if (!utt) return
    // My own captions echo back; they are already in the transcript.
    if (utt.by && utt.by === myIdentityRef.current) return
    const event = fromWire(utt)
    if (!event) return
    setTranscript(prev => apply(prev, event, { mine: false }))
  }, [])

  // Latest finalize routine for the unmount cleanup (which closes over the
  // first render's callbacks and would otherwise drop the open message).
  const finalizeRef = useRef(null)
  finalizeRef.current = () => sealAndFlush('unmount')

  // Re-runs when the shared microphone arrives or is replaced (useMicStream
  // re-acquires the device), which is what rebuilds the analysis graph around
  // the new stream.
  useEffect(() => {
    if (!enabled || !stream) return undefined
    stoppedRef.current = false
    // `mutedRef` rather than `muted`: this effect must not re-run on unmute —
    // that path goes through `unmute()`, which reuses the graph this built.
    start(mutedRef.current)
    if (mutedRef.current) setState('muted')
    return () => {
      stoppedRef.current = true
      finalizeRef.current?.()
      closeSocket(true)
      // Only the analysis graph is ours; the device belongs to useMicStream.
      streamRef.current = null
      ctxRef.current?.close().catch(() => {})
      ctxRef.current = null
      startingRef.current = false
    }
  }, [enabled, stream]) // eslint-disable-line react-hooks/exhaustive-deps

  // Surface the shared mic hook's failure through the same `state` the Capture
  // pane already renders banners for.
  useEffect(() => {
    if (micError) setState(micError)
  }, [micError])

  // Switching language or diarization mid-kelabo reconnects the Deepgram
  // socket with a fresh token carrying the new params (only while live).
  const firstParamRun = useRef(true)
  useEffect(() => {
    if (firstParamRun.current) { firstParamRun.current = false; return }
    if (!enabled || stoppedRef.current || muted) return
    if (!ctxRef.current) return
    reconnectsRef.current = 0
    closeSocket(true)
    connectSocket()
  }, [language, diarize]) // eslint-disable-line react-hooks/exhaustive-deps

  // `gateStats()` is a getter, not state: the ratio changes every frame and
  // nothing needs to re-render for it (the Debug drawer samples it).
  const gateStats = useCallback(() => gateRef.current?.stats() || null, [])

  const list = useMemo(() => messages(transcript), [transcript])

  return {
    state,
    muted,
    speaking,
    messages: list,
    mute,
    unmute,
    stop,
    renameSpeaker,
    addRemoteUtterance,
    seedHistory,
    sendTyped,
    gateStats,
  }
}
