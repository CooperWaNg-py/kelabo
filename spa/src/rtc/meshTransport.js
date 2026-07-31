import { rtc as rtcApi } from '../api'
import { withRetry } from './retry.js'

// Full-mesh peer-to-peer transport — the "secure kelabo" mode.
//
// One RTCPeerConnection per remote participant, media flowing directly between
// browsers under DTLS-SRTP. No SFU is involved, so no server decrypts anything;
// the Gateway only relays offer/answer/ICE and never sees a media packet. When
// direct connectivity fails, Cloudflare TURN relays the encrypted packets — a
// relay cannot decrypt them, so the guarantee holds.
//
// Cost: each participant uploads their audio once per peer, which is why the
// Gateway caps the room at rtc.meshMaxParticipants and refuses joiners past it
// rather than quietly falling back to the SFU.
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

// A connection that has failed outright is rebuilt, but not forever: past this
// the network is not going to start working because we asked a fifth time.
const MAX_REBUILDS = 4
const REBUILD_DELAY_MS = 1500

export function createMeshTransport({ kelaboId, selfId, iceServers, onRemoteTrack, onStateChange, onError }) {
  /** participantId -> { pc, polite, makingOffer, ignoreOffer, pendingIce[], senders, … } */
  const peers = new Map()
  const localTracks = new Map() // kind -> MediaStreamTrack
  let closed = false

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
      if (pc.connectionState === 'failed') scheduleRebuild(participantId)
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
    if (entry.rebuilds >= MAX_REBUILDS) return
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
    for (const p of peerList) {
      const id = p?.participantId
      if (!id || id === selfId) continue
      const entry = peers.get(id)
      if (!entry) {
        connectTo(id)
        continue
      }
      if (entry.pc.connectionState === 'failed') scheduleRebuild(id)
      else if (entry.renegotiateWanted && entry.pc.signalingState === 'stable') negotiate(id)
    }
  }

  async function handleSignal(from, signal_) {
    if (closed) return
    if (signal_.type === 'bye') {
      dropPeer(from)
      return
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

  return { mode: 'mesh', setLocalTrack, connectTo, reconcile, handleSignal, dropPeer, close }
}
