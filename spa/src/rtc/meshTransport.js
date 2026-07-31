import { rtc as rtcApi } from '../api'
import { withRetry } from './retry.js'
import { MAX_PEER_REBUILDS, shouldRebuildCall, shouldRebuildPeer } from './recovery.js'

// Full-mesh peer-to-peer transport — the "secure kelabo" mode.
//
// One RTCPeerConnection per remote participant, media flowing directly between
// browsers under DTLS-SRTP. No SFU is involved, so no server decrypts anything;
// the Gateway only relays offer/answer/ICE and never sees a media packet. When
// direct connectivity fails, Cloudflare TURN relays the encrypted packets — a
// relay cannot decrypt them, so the guarantee holds.
//
// Cost: each participant uploads their audio once per peer — and a shared
// screen is one more video uplink to every peer — which is why the Gateway
// caps the room at rtc.meshMaxParticipants units (participants plus active
// screen shares) and refuses joiners and shares past it rather than quietly
// falling back to the SFU.
//
// Glare (both sides offering at once) is handled with the standard perfect-
// negotiation pattern: the peer with the lexicographically greater id is
// "polite" and rolls back its own offer when it collides with an incoming one.
//
// The failure that matters here is a lost offer. `setLocalDescription` puts the
// connection into `have-local-offer` and only the answer takes it out, so if the
// POST carrying that offer never lands, the connection is wedged for the rest of
// the kelabo and every later change — turning a camera on, most obviously —
// silently does nothing. So the send retries, and a send that cannot be made to
// work rolls the offer back rather than leaving the connection stuck.

// A connection that has failed outright is rebuilt, but not forever in a row:
// past MAX_PEER_REBUILDS (recovery.js) the network is not going to start
// working because we asked a fifth time. The budget refills on `connected`,
// so it bounds a losing streak rather than the life of the kelabo.
const REBUILD_DELAY_MS = 1500

export function createMeshTransport({ kelaboId, selfId, iceServers, onRemoteTrack, onStateChange, onError, onFatal }) {
  /** participantId -> { pc, polite, makingOffer, ignoreOffer, pendingIce[], senders, … } */
  const peers = new Map()
  const localTracks = new Map() // kind -> MediaStreamTrack
  let closed = false
  let fatalReported = false

  // The whole call is beyond per-peer repair — every connection failed at
  // once, which is our own network changing, not N unlucky peers. Reported
  // upward exactly once; useRtc rebuilds the call around a clean rejoin, the
  // same machinery the SFU transport has always had (this transport used to
  // silently drop the `onFatal` it was handed, so mesh had no whole-call
  // recovery path at all).
  function reportFatal(err) {
    if (fatalReported || closed) return
    fatalReported = true
    onFatal?.(err)
  }

  const signal = (to, payload) => withRetry(() => rtcApi.signal(kelaboId, to, payload))

  function peerFor(participantId) {
    const existing = peers.get(participantId)
    if (existing) return existing

    const pc = new RTCPeerConnection({ iceServers, bundlePolicy: 'max-bundle' })
    const entry = {
      pc,
      polite: selfId > participantId,
      makingOffer: false,
      ignoreOffer: false,
      pendingIce: [],
      // kind -> RTCRtpTransceiver, so a later camera toggle can swap the track
      // on the one we already negotiated instead of adding another — and so its
      // `mid` can be read back when labelling what we send.
      transceivers: new Map(),
      // The peer's own mid -> kind map, from their last offer/answer. Without it
      // a shared screen and a camera are two identical `video` m-lines.
      remoteKinds: {},
      // Set when a negotiation could not be delivered, so it can be tried again
      // the moment the connection is back in a state that allows one.
      renegotiateWanted: false,
      rebuilds: 0,
      rebuildTimer: 0,
    }
    peers.set(participantId, entry)

    // Adding these fires `negotiationneeded`, which is what actually dials the
    // peer. A participant with no microphone adds nothing and waits to be dialled.
    for (const [kind, track] of localTracks) {
      try {
        entry.transceivers.set(kind, pc.addTransceiver(track, { direction: 'sendrecv' }))
      } catch (err) {
        onError?.(err)
      }
    }

    pc.addEventListener('track', ev => {
      // A camera and a shared screen are both `video` on the wire. The sender
      // says which is which in the `kinds` map on its offer, so consult that
      // first and only fall back to the media type when there is no label —
      // an older client, or an audio track, where there is nothing to confuse.
      const mid = ev.transceiver?.mid
      const labelled = mid != null ? entry.remoteKinds?.[mid] : null
      onRemoteTrack?.({
        participantId,
        kind: labelled ?? (ev.track.kind === 'video' ? 'video' : 'audio'),
        track: ev.track,
        streams: ev.streams,
      })
    })

    pc.addEventListener('icecandidate', ev => {
      if (!ev.candidate) return
      // A lost candidate is survivable — the others usually still produce a
      // working pair — so this one stays best-effort rather than retrying and
      // delivering candidates out of order.
      rtcApi
        .signal(kelaboId, participantId, {
          type: 'ice',
          candidate: ev.candidate.candidate,
          sdpMid: ev.candidate.sdpMid,
          sdpMLineIndex: ev.candidate.sdpMLineIndex,
        })
        .catch(() => {})
    })

    pc.addEventListener('negotiationneeded', () => { negotiate(participantId) })

    pc.addEventListener('signalingstatechange', () => {
      // A negotiation we could not deliver earlier gets its chance as soon as
      // the connection is willing to take one.
      if (pc.signalingState === 'stable' && entry.renegotiateWanted) {
        entry.renegotiateWanted = false
        negotiate(participantId)
      }
    })

    pc.addEventListener('connectionstatechange', () => {
      onStateChange?.(participantId, pc.connectionState)
      // A connection that came up is a rebuild that worked: the budget bounds
      // a losing streak, not the kelabo. Without this reset the fourth blip of
      // an hour-long call spent the allowance forever and the peer stayed dark
      // until a page reload.
      if (pc.connectionState === 'connected') entry.rebuilds = 0
      if (pc.connectionState === 'failed') {
        // Several peers failing at once is our own network, not N unlucky
        // peers — escalate straight to the whole-call rebuild. A single peer
        // failing (even if it is the only peer) gets the cheaper per-peer
        // rebuild first; scheduleRebuild escalates when that budget runs out.
        const states = [...peers.values()].map(e => e.pc.connectionState)
        if (states.length > 1 && shouldRebuildCall(states)) {
          reportFatal(new Error('mesh_call_failed'))
          return
        }
        scheduleRebuild(participantId)
      }
    })
    pc.addEventListener('iceconnectionstatechange', () => {
      if (pc.iceConnectionState !== 'failed') return
      onStateChange?.(participantId, 'failed')
      // Cheaper than rebuilding and usually enough: gather again and re-offer.
      try { pc.restartIce?.() } catch {}
    })

    return entry
  }


  /**
   * What each of our transceivers carries, keyed by `mid`.
   *
   * Only meaningful once a local description has been set — `mid` is null until
   * then — so this is always read straight after `setLocalDescription` and sent
   * with the description it describes.
   */
  function localKinds(entry) {
    const kinds = {}
    for (const [kind, transceiver] of entry.transceivers) {
      const mid = transceiver.mid
      if (mid != null) kinds[String(mid)] = kind
    }
    return kinds
  }

  /**
   * Offer to one peer. Isolated from the event handler so a failed attempt can
   * be repeated, and so a negotiation that arrives while the connection is
   * mid-exchange is deferred instead of throwing.
   */
  async function negotiate(participantId) {
    const entry = peers.get(participantId)
    if (closed || !entry) return
    const { pc } = entry
    if (pc.signalingState !== 'stable') {
      entry.renegotiateWanted = true
      return
    }
    try {
      entry.makingOffer = true
      await pc.setLocalDescription(await pc.createOffer())
      await signal(participantId, { type: 'offer', sdp: pc.localDescription.sdp, kinds: localKinds(entry) })
    } catch (err) {
      // The offer is applied locally but the peer never heard about it, so the
      // connection would sit in `have-local-offer` until the kelabo ended.
      // Roll back to `stable` and leave a flag: whatever wanted this
      // negotiation still wants it.
      if (pc.signalingState === 'have-local-offer') {
        try { await pc.setLocalDescription({ type: 'rollback' }) } catch {}
      }
      entry.renegotiateWanted = true
      onError?.(err)
    } finally {
      entry.makingOffer = false
    }
  }

  /**
   * Tear a dead connection down and dial again from scratch. ICE restarts fix
   * a bad candidate pair; they do not fix a PeerConnection that has given up.
   */
  function scheduleRebuild(participantId) {
    const entry = peers.get(participantId)
    if (closed || !entry || entry.rebuildTimer) return
    if (!shouldRebuildPeer({ connectionState: entry.pc.connectionState, rebuilds: entry.rebuilds })) {
      // Budget spent. If everyone is in the same state the call itself is the
      // patient — escalate instead of leaving this peer dark forever.
      if (
        entry.rebuilds >= MAX_PEER_REBUILDS &&
        shouldRebuildCall([...peers.values()].map(e => e.pc.connectionState))
      ) {
        reportFatal(new Error('mesh_rebuilds_exhausted'))
      }
      return
    }
    entry.rebuilds += 1
    entry.rebuildTimer = setTimeout(() => {
      const current = peers.get(participantId)
      if (closed || !current || current.pc.connectionState !== 'failed') {
        if (current) current.rebuildTimer = 0
        return
      }
      const rebuilds = current.rebuilds
      dropPeer(participantId)
      const next = peerFor(participantId)
      next.rebuilds = rebuilds
      // A rebuilt connection with no local tracks has nothing to trigger
      // `negotiationneeded`, so nudge it.
      if (!localTracks.size) negotiate(participantId)
    }, REBUILD_DELAY_MS)
  }

  /**
   * Publish a local track of one kind to every current and future peer, or
   * clear it by passing `null`.
   *
   * Once a transceiver exists for a kind it is reused for the life of the call:
   * turning the camera on and off swaps the track on the sender we already
   * negotiated (`replaceTrack`), which needs no offer/answer round at all.
   * Adding and removing transceiver instead would renegotiate with every peer
   * on every toggle — in a mesh that is one full negotiation per participant,
   * per click.
   *
   * Clearing to `null` is what tells peers the camera went off: the RTP flow
   * stops, and their receiving track fires `mute`, which is what the tile
   * watches (see ParticipantCard). There is no separate camera-state message,
   * so the signal cannot disagree with the media.
   */
  function setLocalTrack(kind, track) {
    if (closed) return
    if (track) localTracks.set(kind, track)
    else localTracks.delete(kind)

    for (const [participantId, entry] of peers) {
      const transceiver = entry.transceivers.get(kind)
      if (transceiver) {
        transceiver.sender.replaceTrack(track).catch(err => onError?.(err))
        continue
      }
      if (!track) continue
      try {
        entry.transceivers.set(kind, entry.pc.addTransceiver(track, { direction: 'sendrecv' }))
      } catch (err) {
        // The transceiver is what fires `negotiationneeded`; if adding it threw,
        // nothing is going to renegotiate on its own.
        entry.renegotiateWanted = true
        onError?.(err)
        void participantId
      }
    }
  }

  /**
   * Open a connection to a peer. Both sides call this for each other; if they
   * offer simultaneously, the perfect-negotiation rollback in handleSignal
   * resolves the collision rather than leaving two half-built connections.
   */
  function connectTo(participantId) {
    if (closed || participantId === selfId) return
    peerFor(participantId)
  }

  /**
   * Make sure every peer on the roster has a live connection.
   *
   * Same job as the SFU's reconciler: a `peer_joined` event that arrived while
   * the page was backgrounded, or a connection that failed past its rebuild
   * budget, otherwise leaves someone permanently silent with nothing left to
   * trigger a retry.
   */
  function reconcile(peerList) {
    if (closed || !Array.isArray(peerList)) return
    const rostered = new Set()
    for (const p of peerList) {
      const id = p?.participantId
      if (!id || id === selfId) continue
      rostered.add(id)
      const entry = peers.get(id)
      if (!entry) {
        connectTo(id)
        continue
      }
      if (entry.pc.connectionState === 'failed') scheduleRebuild(id)
      else if (entry.renegotiateWanted && entry.pc.signalingState === 'stable') negotiate(id)
    }
    // The other half of the same job: a `peer_left` that landed while this tab
    // was throttled left a connection uploading media to someone who was gone,
    // for the rest of the kelabo — real uplink, in the one mode where uplink
    // is the scarce resource the cap exists to protect.
    for (const id of [...peers.keys()]) {
      if (!rostered.has(id)) dropPeer(id)
    }
  }

  /**
   * Fresh TURN credentials, applied to every live connection and to every
   * connection built from here on. Without this an ICE restart past the
   * credential TTL gathers host/srflx only and fails on exactly the networks
   * that needed the relay.
   */
  function setIceServers(next) {
    if (closed || !Array.isArray(next) || !next.length) return
    iceServers = next
    for (const entry of peers.values()) {
      try { entry.pc.setConfiguration({ iceServers: next, bundlePolicy: 'max-bundle' }) } catch {}
    }
  }

  async function handleSignal(from, signal_) {
    if (closed) return
    if (signal_.type === 'bye') {
      dropPeer(from)
      return
    }
    // A fresh offer aimed at a connection we know has failed is the other side
    // re-dialling — their rebuild must not land on our dead PeerConnection, or
    // neither side can ever heal. Start clean; this path spends none of our
    // own rebuild budget because the initiative (and the backoff) is theirs.
    const existing = peers.get(from)
    if (existing && signal_.type === 'offer' && existing.pc.connectionState === 'failed') {
      dropPeer(from)
    }
    const entry = peerFor(from)
    const { pc } = entry
    try {
      if (signal_.type === 'offer' || signal_.type === 'answer') {
        const description = { type: signal_.type, sdp: signal_.sdp }
        const collision =
          description.type === 'offer' && (entry.makingOffer || pc.signalingState !== 'stable')
        entry.ignoreOffer = !entry.polite && collision
        if (entry.ignoreOffer) return
        if (collision) {
          // Polite side: abandon our own in-flight offer and take theirs. What
          // we wanted to renegotiate still needs saying, so ask again once this
          // exchange settles.
          await pc.setLocalDescription({ type: 'rollback' })
          entry.renegotiateWanted = true
        }
        // Before, not after: applying the description is what fires the `track`
        // events these labels exist to explain.
        if (signal_.kinds) entry.remoteKinds = signal_.kinds
        await pc.setRemoteDescription(description)
        for (const candidate of entry.pendingIce.splice(0)) {
          await pc.addIceCandidate(candidate).catch(() => {})
        }
        if (description.type === 'offer') {
          await pc.setLocalDescription(await pc.createAnswer())
          await signal(from, { type: 'answer', sdp: pc.localDescription.sdp, kinds: localKinds(entry) })
        }
        return
      }
      if (signal_.type === 'ice') {
        const candidate = {
          candidate: signal_.candidate,
          sdpMid: signal_.sdpMid ?? null,
          sdpMLineIndex: signal_.sdpMLineIndex ?? null,
        }
        // Candidates can arrive before the description they belong to.
        if (!pc.remoteDescription) entry.pendingIce.push(candidate)
        else await pc.addIceCandidate(candidate).catch(() => {})
      }
    } catch (err) {
      if (!entry.ignoreOffer) onError?.(err)
    }
  }

  function dropPeer(participantId) {
    const entry = peers.get(participantId)
    if (!entry) return
    peers.delete(participantId)
    clearTimeout(entry.rebuildTimer)
    try { entry.pc.close() } catch {}
  }

  function close() {
    closed = true
    for (const [id, entry] of peers) {
      // Best-effort courtesy so peers tear down immediately instead of waiting
      // for ICE to fail.
      rtcApi.signal(kelaboId, id, { type: 'bye' }).catch(() => {})
      clearTimeout(entry.rebuildTimer)
      try { entry.pc.close() } catch {}
    }
    peers.clear()
    localTracks.clear()
  }

  return { mode: 'mesh', setLocalTrack, setIceServers, connectTo, reconcile, handleSignal, dropPeer, close }
}
