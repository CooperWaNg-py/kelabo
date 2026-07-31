import { useCallback, useEffect, useRef, useState } from 'react'
import { rtc as rtcApi } from '../api'
import { createSfuTransport } from './sfuTransport'
import { createMeshTransport } from './meshTransport'

// The conference call, independent of which transport carries it.
//
// Both transports expose `setLocalTrack(kind, track|null)` and report remote
// tracks through one callback, so everything above this line — the roster, the
// tiles, the mute button — is identical for `sfu` and `mesh`. Audio and video
// are published through exactly the same call; the only difference between them
// is that the camera track comes and goes.
//
// Signalling arrives on the kelabo's existing SSE stream (room/useBoard.js owns
// the EventSource and forwards `rtc` events here via `onServerEvent`), so a call
// adds no new connection.

/**
 * @param {{ kelaboId: string, enabled: boolean, stream: MediaStream|null,
 *           videoStream?: MediaStream|null, muted?: boolean,
 *           streamLive?: boolean }} opts
 */
export function useRtc({ kelaboId, enabled, stream, videoStream = null, screenStream = null, muted = false, streamLive = false }) {
  const [state, setState] = useState('idle') // idle | joining | live | full | unavailable | error
  const [mode, setMode] = useState(null)
  const [peers, setPeers] = useState([])
  const [error, setError] = useState(null)
  const [meshMax, setMeshMax] = useState(0)
  // Whether this deployment allows publishing a camera (config.rtc.video,
  // delivered on /rtc/join). Nothing about the transports depends on it — it is
  // the room's cue to not offer a control that would publish an unwanted track.
  //
  // Starts TRUE and only a server that explicitly says `video: false` turns it
  // off. Defaulting to false meant "we have not joined yet" and "the call is
  // unavailable" both read as "this deployment forbids video", which disabled
  // the camera button before anyone could press it — so the browser was never
  // asked for permission and there was nothing to see but a dead control.
  const [videoAllowed, setVideoAllowed] = useState(true)
  // participantId -> MediaStream of their remote camera and microphone.
  const [remoteStreams, setRemoteStreams] = useState(new Map())
  // participantId -> MediaStream of their shared screen, kept apart from the
  // above because a screen share is its own surface in the room, not a second
  // picture of the person sharing it.
  const [remoteScreens, setRemoteScreens] = useState(new Map())
  // RTCPeerConnection state, per peer in mesh and under '*' for the SFU's single
  // connection. Without this a tile can only say "no stream yet", which reads as
  // "connecting…" forever when the truth is that ICE failed.
  const [peerStates, setPeerStates] = useState(new Map())
  // Browsers block autoplay of remote audio until the page has been interacted
  // with; when that happens the UI offers a button that calls `unblock`.
  const [needsUnblock, setNeedsUnblock] = useState(false)
  // Bumped to rebuild the whole call around a new SFU session. The join effect
  // keys on it, so this tears the transport down and rejoins exactly as a page
  // reload would — which until now was the only way out of a dead session, and
  // nobody was ever told to try it.
  const [generation, setGeneration] = useState(0)

  const transportRef = useRef(null)
  const selfIdRef = useRef('')
  const peersRef = useRef(new Map())
  const audioElsRef = useRef(new Map())
  // participantId -> the one MediaStream we own for them. Held in a ref, not
  // state, so the object identity survives every re-render: the <audio> element
  // playing it and the <video> showing it both hold onto it by reference.
  const streamsRef = useRef(new Map())
  const screensRef = useRef(new Map())

  const syncPeers = useCallback(() => setPeers([...peersRef.current.values()]), [])

  // A rebuild is a teardown that must NOT tell the Gateway we left: `/rtc/leave`
  // and the `/rtc/join` that follows it are two independent requests, and the
  // leave losing that race deletes the seat the rejoin just took. Rejoining is
  // idempotent — the Gateway reuses the existing peer record — so the quiet
  // path is simply not to send it.
  const rebuildingRef = useRef(false)
  const rebuildsRef = useRef(0)
  const rebuildTimerRef = useRef(null)

  /**
   * The session is gone and cannot be revived. Build a new one.
   *
   * Backed off and capped, because the same symptom is also what a network that
   * will not carry a call at all looks like — and rebuilding in a tight loop is
   * worse than sitting still, for this participant and for everyone else, whose
   * roster churns on every attempt. Once the attempts are spent the call says
   * so instead of pretending to be live.
   */
  const onFatal = useCallback(err => {
    if (rebuildTimerRef.current) return
    if (rebuildsRef.current >= 3) {
      setError(err)
      setState('error')
      return
    }
    const attempt = rebuildsRef.current++
    rebuildingRef.current = true
    rebuildTimerRef.current = setTimeout(() => {
      rebuildTimerRef.current = null
      setGeneration(g => g + 1)
    }, 1000 * 2 ** attempt)
  }, [])

  useEffect(() => () => clearTimeout(rebuildTimerRef.current), [])

  /**
   * A remote track arrived. It joins that participant's stream — it never
   * becomes it.
   *
   * This used to adopt `ev.streams[0]` when the browser offered one. The SFU
   * gives every pulled track its own msid, so each arriving track came with a
   * *different* stream object and replaced the participant's previous one:
   * pulling someone's camera swapped out the very MediaStream their microphone
   * was playing through, and their audio stopped. One slot per participant,
   * last track wins — which is exactly why a two-person call could have two
   * microphones or one camera and one microphone, but never both cameras and
   * both microphones.
   *
   * So the stream is ours. `streams` is ignored for composition and the track
   * is added to the participant's stream, replacing any earlier track of the
   * same media kind (a republish) rather than accumulating dead ones.
   */
  const attachRemote = useCallback(({ participantId, kind, track }) => {
    const screen = kind === 'screen'
    const store = screen ? screensRef.current : streamsRef.current
    const publish = screen ? setRemoteScreens : setRemoteStreams
    let ms = store.get(participantId)
    if (!ms) {
      ms = new MediaStream()
      store.set(participantId, ms)
    }

    for (const existing of ms.getTracks()) {
      if (existing.kind === track.kind && existing.id !== track.id) ms.removeTrack(existing)
    }
    if (!ms.getTracks().some(t => t.id === track.id)) ms.addTrack(track)

    // A track that ends leaves the stream, so a tile falls back to the avatar
    // instead of holding a frozen last frame forever.
    track.addEventListener('ended', () => {
      const current = store.get(participantId)
      if (!current) return
      if (current.getTracks().some(t => t.id === track.id)) current.removeTrack(track)
      // A screen share that ends should leave no tile behind at all, unlike a
      // camera, where the person is still in the room.
      if (screen && !current.getTracks().length) store.delete(participantId)
      publish(new Map(store))
    }, { once: true })

    // The Map is new so React re-renders; the MediaStreams inside it are not,
    // so nothing that is already playing gets re-attached.
    publish(new Map(store))
  }, [])

  // --- join / leave ---------------------------------------------------------
  useEffect(() => {
    // Wait for the SSE stream: it is both how signalling arrives and how the
    // Gateway notices we left, so joining without it would strand a ghost peer
    // in the roster.
    if (!enabled || !kelaboId || !streamLive) return undefined

    let cancelled = false
    setState('joining')

    ;(async () => {
      let info
      try {
        info = await rtcApi.join(kelaboId)
      } catch (err) {
        if (cancelled) return
        if (err?.code === 'mesh_room_full') {
          setMeshMax(err.meshMax ?? 0)
          setState('full')
        } else if (err?.code === 'rtc_unavailable') {
          setState('unavailable')
        } else {
          setError(err)
          setState('error')
        }
        return
      }
      if (cancelled) return

      selfIdRef.current = info.self.participantId
      setMode(info.mode)
      setMeshMax(info.meshMax ?? 0)
      setVideoAllowed(info.video !== false)
      peersRef.current = new Map(info.peers.map(p => [p.participantId, p]))
      syncPeers()

      const common = {
        kelaboId,
        iceServers: info.iceServers,
        onRemoteTrack: attachRemote,
        onError: err => setError(err),
        onFatal,
        // `participantId` is null for the SFU, whose single PeerConnection
        // carries everyone; mesh reports per peer.
        onStateChange: (participantId, connState) => {
          // A connection that came up is a rebuild that worked, so the budget
          // refills: three tries in a row is a network that cannot carry a
          // call, but three over an hour-long kelabo is just an hour-long
          // kelabo, and the second must not spend the allowance of the first.
          if (connState === 'connected') rebuildsRef.current = 0
          setPeerStates(prev => {
            const next = new Map(prev)
            next.set(participantId ?? '*', connState)
            return next
          })
        },
      }
      const transport =
        info.mode === 'mesh'
          ? createMeshTransport({ ...common, selfId: info.self.participantId })
          : createSfuTransport(common)
      transportRef.current = transport
      setState('live')

      // Whoever was already publishing when we walked in is picked up by the
      // reconciler's first tick rather than here — one code path for "was
      // already here" and "arrived later" instead of two.
      //
      // This used to be load-bearing for a different reason: a pull could not
      // be the first operation on a new SFU session, so publishing had to win.
      // That guarantee was unenforceable — it rested on `getUserMedia`
      // resolving before the first reconcile tick, which on a reload it does
      // not, and on the participant having granted a microphone at all. The
      // session now negotiates when it is created (see `ensureSession` in
      // sfuTransport.js), so nothing here depends on the order any more.
      if (transport.mode === 'mesh') {
        for (const p of info.peers) transport.connectTo(p.participantId)
      }
    })()

    return () => {
      cancelled = true
      transportRef.current?.close()
      transportRef.current = null
      peersRef.current = new Map()
      streamsRef.current = new Map()
      screensRef.current = new Map()
      setPeers([])
      setRemoteStreams(new Map())
      setRemoteScreens(new Map())
      setPeerStates(new Map())
      setState('idle')
      if (rebuildingRef.current) rebuildingRef.current = false
      else rtcApi.leave(kelaboId).catch(() => {})
    }
  }, [enabled, kelaboId, streamLive, generation, attachRemote, syncPeers, onFatal])

  // --- publish local media --------------------------------------------------
  // Runs once the transport is up and the device has been granted. The same
  // audio track the Deepgram pipeline analyses is what peers hear, so there is
  // exactly one device capture (see useMicStream).
  useEffect(() => {
    const transport = transportRef.current
    if (state !== 'live' || !transport) return
    transport.setLocalTrack('audio', stream?.getAudioTracks()[0] ?? null)
  }, [state, stream])

  // The camera is published the first time it is switched on and then swapped
  // in and out of the same sender. `null` is not a no-op: it is how peers are
  // told the camera went off — and it is also what a deployment with video
  // disabled always sends, so that policy is enforced here rather than only in
  // a control that happens to be hidden.
  useEffect(() => {
    const transport = transportRef.current
    if (state !== 'live' || !transport) return
    const track = videoAllowed ? (videoStream?.getVideoTracks()[0] ?? null) : null
    transport.setLocalTrack('video', track)
  }, [state, videoStream, videoAllowed])

  // A shared screen is published exactly like the camera — same call, same
  // sender reuse — and cleared the same way when sharing stops.
  useEffect(() => {
    const transport = transportRef.current
    if (state !== 'live' || !transport) return
    const track = videoAllowed ? (screenStream?.getVideoTracks()[0] ?? null) : null
    transport.setLocalTrack('screen', track)
  }, [state, screenStream, videoAllowed])

  // --- reconcile ------------------------------------------------------------
  // The roster says what everyone publishes; the transport knows what actually
  // arrived. Every so often, compare the two and fix the difference.
  //
  // Without this the whole call rests on each one-shot working first time: the
  // Gateway announces a track once, so a pull that failed on a bad second — or
  // a peer whose `peer_joined` landed while this tab was asleep — stays missing
  // for the rest of the kelabo, and nothing will ever say so. Ten seconds is
  // slow enough to be free and fast enough that nobody finishes a sentence
  // before their microphone catches up.
  //
  // Still declared after the three publish effects, but only for readability
  // now. It used to be load-bearing — the first tick pulls the peers who were
  // already in the room, and a pull could not be the first operation on a new
  // SFU session — but effect order was never a real guarantee: on a reload the
  // microphone has not been acquired yet when these run, so the publish effects
  // published nothing and the pull went first anyway. The session is negotiated
  // when it is created instead.
  useEffect(() => {
    if (state !== 'live') return undefined
    const tick = () => transportRef.current?.reconcile?.([...peersRef.current.values()])
    tick()
    const t = setInterval(tick, 10000)
    // Also on the way back from a backgrounded tab, where timers were throttled
    // and connections may have been torn down under us.
    const onVisible = () => { if (document.visibilityState === 'visible') tick() }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      clearInterval(t)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [state])

  // Muting stops transmission at the source: peers hear nothing, and the track
  // stays in place so unmuting needs no renegotiation.
  useEffect(() => {
    const track = stream?.getAudioTracks()[0]
    if (track) track.enabled = !muted
  }, [muted, stream])

  // ...and tell the room, because that is the half the media cannot carry.
  // `track.enabled = false` is a local decision that never reaches the wire, and
  // a camera switched off is a sender that stopped sending on a transceiver that
  // is still negotiated. To everyone else both look identical to a bad network:
  // a muted peer was indistinguishable from a quiet one, and a camera going off
  // left its last frame frozen on the tile for the rest of the kelabo.
  //
  // Sent on every change including the first, so a peer who joins muted is
  // shown muted rather than having to speak to prove otherwise.
  const cameraOn = !!(videoAllowed && videoStream?.getVideoTracks()[0])
  useEffect(() => {
    if (state !== 'live') return
    rtcApi.media(kelaboId, { audio: !muted, video: cameraOn }).catch(() => {})
  }, [state, kelaboId, muted, cameraOn])

  // --- signalling from the kelabo's SSE stream -----------------------------
  const onServerEvent = useCallback(
    payload => {
      const transport = transportRef.current
      if (!payload || !transport) return
      const self = selfIdRef.current

      // Someone's microphone or camera was switched on or off. Roster-only —
      // no media changes hands, so there is nothing to pull or drop; the tiles
      // read it straight off the peer.
      if (payload.kind === 'media') {
        const p = payload.peer
        if (!p || p.participantId === self) return
        const known = peersRef.current.get(p.participantId)
        if (!known) return
        peersRef.current.set(p.participantId, { ...known, media: p.media })
        syncPeers()
        return
      }

      if (payload.kind === 'peer_joined' || payload.kind === 'tracks') {
        const p = payload.peer
        if (!p || p.participantId === self) return
        // A peer who rebuilt their SFU session is publishing on a new one, and
        // every subscription we hold points at the old. Forgetting them here is
        // what lets the pulls below start over; without it the transport sees a
        // slot it has already filled and skips the track for good.
        const prev = peersRef.current.get(p.participantId)
        if (prev?.sfuSessionId && p.sfuSessionId && prev.sfuSessionId !== p.sfuSessionId) {
          transport.dropPeer?.(p.participantId)
          streamsRef.current.delete(p.participantId)
          screensRef.current.delete(p.participantId)
          setRemoteStreams(new Map(streamsRef.current))
          setRemoteScreens(new Map(screensRef.current))
        }
        peersRef.current.set(p.participantId, p)
        syncPeers()
        if (transport.mode === 'sfu') {
          for (const [kind, trackName] of Object.entries(p.tracks || {})) {
            transport.pullTrack(p.participantId, kind, trackName, p.sfuSessionId)
          }
        } else if (payload.kind === 'peer_joined') {
          transport.connectTo(p.participantId)
        }
        return
      }

      if (payload.kind === 'peer_left') {
        const id = payload.participantId
        if (!id || id === self) return
        peersRef.current.delete(id)
        syncPeers()
        streamsRef.current.delete(id)
        screensRef.current.delete(id)
        setRemoteStreams(new Map(streamsRef.current))
        setRemoteScreens(new Map(screensRef.current))
        transport.dropPeer?.(id)
        return
      }

      if (payload.kind === 'signal' && transport.mode === 'mesh') {
        if (payload.to !== self) return
        transport.handleSignal(payload.from, payload.signal)
      }
    },
    [syncPeers],
  )

  // --- remote audio playback ------------------------------------------------
  // One <audio> element per peer, created imperatively so playback survives the
  // roster re-rendering and so autoplay rejection is observable.
  useEffect(() => {
    const els = audioElsRef.current
    for (const [participantId, ms] of remoteStreams) {
      let el = els.get(participantId)
      if (!el) {
        el = new Audio()
        el.autoplay = true
        el.playsInline = true
        els.set(participantId, el)
      }
      if (el.srcObject !== ms) el.srcObject = ms
      el.play().catch(() => setNeedsUnblock(true))
    }
    for (const [participantId, el] of els) {
      if (remoteStreams.has(participantId)) continue
      el.srcObject = null
      els.delete(participantId)
    }
  }, [remoteStreams])

  useEffect(() => {
    const els = audioElsRef.current
    return () => {
      for (const el of els.values()) el.srcObject = null
      els.clear()
    }
  }, [])

  const unblock = useCallback(() => {
    for (const el of audioElsRef.current.values()) el.play().catch(() => {})
    setNeedsUnblock(false)
  }, [])

  // What a tile should say about one peer. Having their media is the only proof
  // the call actually works, so it outranks the connection state.
  const peerStatus = useCallback(
    participantId => {
      if (remoteStreams.get(participantId)?.getAudioTracks().length) return 'live'
      const conn = peerStates.get(mode === 'mesh' ? participantId : '*')
      if (conn === 'failed' || conn === 'closed') return 'failed'
      if (conn === 'disconnected') return 'reconnecting'
      return 'connecting'
    },
    [remoteStreams, peerStates, mode],
  )

  // Whether a peer's camera has actually reached us. A roster that advertises
  // `video: "cam"` is a promise; the track arriving is the delivery, and the
  // gap between the two is exactly what the reconciler is closing.
  const peerHasVideo = useCallback(
    participantId => !!remoteStreams.get(participantId)?.getVideoTracks().length,
    [remoteStreams],
  )

  return { state, mode, peers, remoteStreams, remoteScreens, error, meshMax, videoAllowed, needsUnblock, unblock, onServerEvent, peerStatus, peerHasVideo, selfId: selfIdRef.current }
}
