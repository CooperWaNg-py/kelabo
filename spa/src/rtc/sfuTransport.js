import { rtc as rtcApi } from '../api'
import { withRetry, isFatal } from './retry.js'
import { missingPulls, PULL_GRACE_MS } from './reconcile.js'
import { hasTurnServers } from './recovery.js'
import { callLog } from './callLog.js'

const LOG = 'sfu'

/**
 * Which candidate pair ICE selected — on a network that needs the relay, a
 * "connected" pair that is host/srflx-to-srflx tells a different story than a
 * relayed one. Logged once, when the connection comes up.
 */
async function logSelectedPair(pc) {
  try {
    const stats = await pc.getStats()
    let pair = null
    for (const r of stats.values()) {
      if (r.type === 'transport' && r.selectedCandidatePairId) pair = stats.get(r.selectedCandidatePairId)
    }
    if (!pair) {
      for (const r of stats.values()) {
        if (r.type === 'candidate-pair' && r.state === 'succeeded' && r.nominated) { pair = r; break }
      }
    }
    if (!pair) return
    const local = stats.get(pair.localCandidateId)
    callLog.info(LOG, 'selected pair', { local: local?.candidateType, protocol: local?.protocol })
  } catch {}
}

// Cloudflare Realtime SFU transport.
//
// One RTCPeerConnection and one Cloudflare session per participant: we publish
// our own tracks on it and pull every peer's tracks onto the same connection.
// The SFU alternates who offers — we offer when publishing, it offers when we
// pull — so every operation is serialized through a queue; two overlapping
// negotiations on one PeerConnection would collide in `have-local-offer`.
//
// Only the Gateway can talk to Cloudflare: it holds the app credentials and
// checks that a pulled session belongs to a peer of this kelabo.
//
// Every step here can fail on its own, and a call with four tracks in it does
// eight of them. So nothing is fire-and-forget: transient failures retry, and
// `reconcile()` re-checks the whole roster against what actually arrived, which
// is what turns "that track is gone for the rest of the kelabo" into "that
// track was late".

const TRACK_NAMES = { audio: 'mic', video: 'cam', screen: 'screen' }

// The SFU API is plain HTTPS with no trickle-ICE channel: whatever SDP we POST
// is all it will ever learn about how to reach us. `setLocalDescription()`
// resolves as soon as the description is applied, long before candidates have
// been gathered, so sending `pc.localDescription` straight away ships an SDP
// with no candidates in it — the session is created, the API returns 200, and
// then no media ever flows. Wait for gathering to finish first.
//
// Two caps, not one: on a network that needs the relay, TURN allocation is
// routinely the slowest gather of all — exactly the candidate the offer cannot
// go without. So when TURN servers are configured the wait stretches (up to
// the hard cap) until at least one relay candidate is in, instead of shipping
// a host/srflx-only offer that connects everywhere except where it matters.
const ICE_GATHER_TIMEOUT_MS = 3000
const ICE_GATHER_RELAY_TIMEOUT_MS = 8000

// How long an ICE restart may take before the session is declared dead and
// rebuilt from scratch.
const ICE_RESTART_TIMEOUT_MS = 10000

// Cloudflare refuses to touch a session whose PeerConnection is not up:
// `tracks/new` answers `410 session_error: "Session appears to be disconnected.
// Please check if the PeerConnection is connected."` and every later call on
// that session answers the same, for the rest of the kelabo. Publishing is
// what brings the connection up, so the first publish waits here — once — and
// everything queued behind it then runs against a live session.
const CONNECT_TIMEOUT_MS = 15000

// How long before the reconciler tries a failed publish again.
const REPUBLISH_INTERVAL_MS = 20000

function waitForIceGathering(pc, wantRelay = false) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve()
  return new Promise(resolve => {
    let done = false
    let relaySeen = false
    let softDeadlinePassed = false
    const finish = () => {
      if (done) return
      done = true
      pc.removeEventListener('icegatheringstatechange', onChange)
      pc.removeEventListener('icecandidate', onCandidate)
      clearTimeout(softTimer)
      clearTimeout(hardTimer)
      resolve()
    }
    const onChange = () => {
      if (pc.iceGatheringState === 'complete') finish()
    }
    const onCandidate = ev => {
      const c = ev.candidate
      if (!c) return
      callLog.debug(LOG, 'ice candidate', { type: c.type, protocol: c.protocol })
      if (c.type === 'relay' || / typ relay(\s|$)/.test(c.candidate ?? '')) {
        relaySeen = true
        if (softDeadlinePassed) finish()
      }
    }
    pc.addEventListener('icegatheringstatechange', onChange)
    pc.addEventListener('icecandidate', onCandidate)
    // Some networks leave a candidate source hanging (a TURN server that never
    // answers). The candidates gathered so far are usually enough, so cap the
    // wait rather than stalling the whole call on the slowest one — except
    // that when a relay is expected and has not arrived yet, cutting it off
    // here ships an offer that cannot work behind symmetric NAT. Then, and
    // only then, the hard cap takes over.
    const softTimer = setTimeout(() => {
      softDeadlinePassed = true
      if (!wantRelay || relaySeen) finish()
    }, ICE_GATHER_TIMEOUT_MS)
    const hardTimer = setTimeout(finish, ICE_GATHER_RELAY_TIMEOUT_MS)
  })
}

/** Resolve when the PeerConnection is up, or when waiting any longer is pointless. */
function waitForConnected(pc, timeoutMs = CONNECT_TIMEOUT_MS) {
  const settled = state => state === 'connected' || state === 'failed' || state === 'closed'
  if (settled(pc.connectionState)) return Promise.resolve(pc.connectionState === 'connected')
  return new Promise(resolve => {
    let done = false
    const finish = () => {
      if (done) return
      done = true
      pc.removeEventListener('connectionstatechange', onChange)
      clearTimeout(timer)
      resolve(pc.connectionState === 'connected')
    }
    const onChange = () => { if (settled(pc.connectionState)) finish() }
    pc.addEventListener('connectionstatechange', onChange)
    const timer = setTimeout(finish, timeoutMs)
  })
}

/**
 * The per-track error hiding inside a 200.
 *
 * `tracks/new` reports a rejected track *in the body*, not in the status:
 * pulling a track whose publisher is not sending yet comes back as
 * `200 { tracks: [{ mid: "", errorCode: "not_found_track_error", … }] }`.
 * Taking that at face value is what stored an empty mid, sent `{mid:""}` to
 * `tracks/close` (which the API rejects with "Missing mid in track") and left
 * the tile on "connecting…" for the rest of the kelabo.
 */
function trackError(res) {
  const bad = (res?.tracks ?? []).find(t => t?.errorCode)
  if (!bad) return null
  const err = new Error(`sfu_${bad.errorCode}: ${bad.errorDescription ?? ''}`)
  err.code = bad.errorCode
  return err
}

/** Mark an error as past retrying, so `report` escalates it. See `isFatal`. */
function fatal(err) {
  err.fatal = true
  return err
}

/**
 * The m-sections of an SDP, without the SDP. Raw SDP stays out of the log —
 * it carries ICE credentials and local addresses — but a mid/kind/direction/
 * codec/fmtp listing is exactly what "the SFU's answer does not fit our
 * offer" needs for a diagnosis: a payload-type collision or an fmtp mismatch
 * is visible here and nowhere else.
 */
function summarizeSdp(sdp) {
  const sections = []
  let cur = null
  for (const line of String(sdp ?? '').split('\r\n')) {
    if (line.startsWith('m=')) {
      cur = { mid: '', kind: line.split(' ')[0].slice(2), dir: '', codecs: [], fmtp: [] }
      sections.push(cur)
    } else if (cur) {
      if (line.startsWith('a=mid:')) cur.mid = line.slice(6)
      else if (line === 'a=sendonly' || line === 'a=recvonly' || line === 'a=sendrecv' || line === 'a=inactive') cur.dir = line.slice(2)
      else if (line.startsWith('a=rtpmap:')) cur.codecs.push(line.slice(9))
      else if (line.startsWith('a=fmtp:')) cur.fmtp.push(line.slice(7))
    }
  }
  return sections
}

/**
 * The video codecs we may offer the SFU: everything the browser can send
 * EXCEPT H.265.
 *
 * Cloudflare drops H.265 from its answer but echoes the paired RTX anyway —
 * `a=rtpmap:117 rtx/90000` with `a=fmtp:117 apt=116` and no 116 in the
 * m-section. A dangling apt reference is malformed, and Chrome refuses the
 * whole answer ("Failed to set remote video description send parameters"),
 * which until now killed every session the moment a camera was published:
 * the rebuild brought the session back, the budget refilled on `connected`,
 * the camera publish failed identically, and the call flickered up and down
 * for the rest of the kelabo (generation 32 in one log). Not offering H.265
 * leaves Cloudflare nothing to mangle. Returns null when capabilities are
 * unavailable, meaning "leave the browser's defaults alone".
 */
function publishableVideoCodecs() {
  try {
    const caps = RTCRtpSender.getCapabilities?.('video')
    if (!caps?.codecs?.length) return null
    const keep = caps.codecs.filter(c => !/\bh265\b/i.test(c.mimeType))
    return keep.length ? keep : null
  } catch {
    return null
  }
}

export function createSfuTransport({ kelaboId, iceServers, onRemoteTrack, onStateChange, onError, onFatal }) {
  const pc = new RTCPeerConnection({ iceServers, bundlePolicy: 'max-bundle' })
  // trackKey ("<participantId>/<kind>") -> { mid, live, lastAt }.
  // `live` is set by the `track` event and is the only proof a pull worked: the
  // API returning 200 says the SFU accepted the subscription, not that media
  // arrived. The reconciler trusts `live` and nothing else.
  const pulled = new Map()
  // kind -> RTCRtpSender for what we publish, so a camera toggle swaps the
  // track on an existing sender rather than publishing a second one.
  const published = new Map()
  // kind -> the track we have been *asked* to send, whether or not it ever got
  // published. A failed publish used to leave nothing behind that would try
  // again, and it is invisible to the person it happened to: their own camera
  // preview is local and keeps working while everyone else sees an empty tile.
  // The reconciler retries these for the same reason it retries pulls.
  const desired = new Map()
  const publishing = new Set()
  // kind -> when we last tried, so a publish that keeps failing renegotiates
  // occasionally rather than on every reconcile tick. Each attempt is a full
  // offer/answer on the shared PeerConnection; retrying that every ten seconds
  // against a session that is not going to accept it costs everyone else on the
  // call more than it could ever recover.
  const publishedAt = new Map()
  // mid -> a `track` event that arrived before the pull that asked for it had
  // recorded its mid. Claimed by `pullTrack` the moment it does.
  const orphaned = new Map()
  let closed = false
  let sessionReady = false
  // The recvonly transceiver `ensureSession` adds exists only to give the
  // session-creating offer an m-line. Added once ever: a session POST that
  // failed used to leave `sessionReady` false, and every retry stacked another
  // dead m-line into every future offer.
  let sessionTransceiverAdded = false
  let queue = Promise.resolve()
  // Reported at most once. Everything in flight when a session dies fails, and
  // a burst of identical "rebuild the call" requests would tear down the
  // replacement as fast as it was built.
  let died = false
  // One ICE-restart attempt at a time; a second failure while one is being
  // repaired escalates through the same attempt's timeout instead of queueing
  // another renegotiation behind it.
  let recovering = false
  // The credentials currently configured, kept fresh by setIceServers (the
  // re-mint timer in useRtc). Read both for `setConfiguration` and to decide
  // whether an SDP gather should hold out for a relay candidate.
  let currentIceServers = Array.isArray(iceServers) ? iceServers : []
  const wantRelay = () => hasTurnServers(currentIceServers)

  /**
   * Every SFU failure lands here. Most are a bad second and belong to whoever
   * retries them; a dead session belongs to the caller above, because fixing it
   * means replacing this transport.
   */
  function report(err) {
    if (isFatal(err) && !died && !closed) {
      died = true
      callLog.error(LOG, 'fatal — session reported dead', err)
      onFatal?.(err)
      return
    }
    callLog.warn(LOG, 'operation failed', err)
    onError?.(err)
  }

  // One PeerConnection carries every peer's media here, so its state applies to
  // all of them — unlike mesh, where each peer has its own.
  pc.addEventListener('connectionstatechange', () => {
    callLog.info(LOG, `connection: ${pc.connectionState}`)
    if (pc.connectionState === 'connected') logSelectedPair(pc)
    onStateChange?.(null, pc.connectionState)
    if (pc.connectionState === 'failed') recoverConnection('connection_failed')
  })
  pc.addEventListener('iceconnectionstatechange', () => {
    callLog.info(LOG, `ice connection: ${pc.iceConnectionState}`)
    if (pc.iceConnectionState === 'failed') recoverConnection('ice_failed')
  })
  pc.addEventListener('icegatheringstatechange', () => {
    callLog.debug(LOG, `ice gathering: ${pc.iceGatheringState}`)
  })
  pc.addEventListener('signalingstatechange', () => {
    callLog.debug(LOG, `signalling: ${pc.signalingState}`)
  })

  /**
   * A mid-call connection failure — network change, VPN toggle, a router blip
   * longer than ICE consent, a mobile OS killing the connection in background.
   *
   * The ladder: a real ICE restart first (fresh credentials, an
   * `iceRestart: true` offer through the serialized queue, the SFU's answer
   * applied), and the fatal whole-session rebuild only if that does not reach
   * `connected` in time. The old code called `pc.restartIce()` here and
   * nothing else — but that only *flags* that the next offer should restart
   * ICE, and no code path ever made that offer, so the "restart" was a no-op
   * and the call stayed dead until someone reloaded the page. This was the
   * single biggest violation of "the call must go on".
   */
  function recoverConnection(reason) {
    if (closed || died || recovering || !sessionReady) return
    recovering = true
    callLog.warn(LOG, `recovering connection (${reason}) — ICE restart`)
    onError?.(new Error(reason))
    run(async () => {
      try {
        if (closed || died) return
        // The blip may have healed itself while this waited in the queue.
        if (pc.connectionState === 'connected') return
        // Fresh TURN before regathering: past the credential TTL a restart
        // gathers host/srflx only and fails on exactly the networks that
        // needed the relay. Best-effort — the scheduled re-mint usually keeps
        // these fresh already.
        try {
          const out = await rtcApi.ice(kelaboId)
          if (Array.isArray(out?.iceServers) && out.iceServers.length) setIceServers(out.iceServers)
        } catch {}
        await pc.setLocalDescription(await pc.createOffer({ iceRestart: true }))
        await waitForIceGathering(pc, wantRelay())
        const res = await withRetry(() =>
          rtcApi.sfuRenegotiate(kelaboId, { type: 'offer', sdp: pc.localDescription.sdp }),
        )
        await applySignal(res)
        if (!(await waitForConnected(pc, ICE_RESTART_TIMEOUT_MS))) {
          throw fatal(new Error('sfu_recover_failed'))
        }
        callLog.info(LOG, 'connection recovered')
      } catch (err) {
        // Whatever went wrong — the SFU refusing the restart offer included —
        // the session is not coming back this way. Escalate to the rebuild.
        report(isFatal(err) ? err : fatal(err))
      } finally {
        recovering = false
      }
    })
  }

  /**
   * Fresh TURN credentials from the re-mint timer (useRtc). Applied to the
   * live connection so the next gather — an ICE restart above, or any
   * renegotiation — still has its relay.
   */
  function setIceServers(next) {
    if (closed || !Array.isArray(next) || !next.length) return
    currentIceServers = next
    try { pc.setConfiguration({ iceServers: next, bundlePolicy: 'max-bundle' }) } catch {}
  }

  pc.addEventListener('track', ev => {
    // The SFU labels each incoming transceiver with the mid we asked for, which
    // is how an arriving track is matched back to the peer that published it.
    const mid = ev.transceiver?.mid
    if (mid == null) return
    const entry = [...pulled.entries()].find(([, v]) => v.mid != null && String(v.mid) === String(mid))
    if (!entry) {
      // The subscription that explains this track has not recorded its mid yet.
      // That ordering is guaranteed by `pullTrack`, but it is guaranteed by one
      // line in the middle of an async function, and when it was last broken
      // every tile in the kelabo sat on "connecting" while the SFU did
      // everything right. Holding the track costs one map entry and makes the
      // guarantee unnecessary.
      callLog.debug(LOG, 'track arrived before its pull recorded a mid — held', { mid: String(mid), kind: ev.track.kind })
      orphaned.set(String(mid), ev)
      return
    }
    adopt(entry, ev)
  })

  /** Attach an arrived track to the subscription that asked for it. */
  function adopt([key, value], ev) {
    // The same track can surface twice — once held as an orphan when it beat
    // its pull's mid into the map, once from the `track` event the pull's own
    // answer then fires. Adopting it twice double-reports upstream.
    if (value.live && value.track === ev.track) return
    const [participantId, kind] = key.split('/')
    callLog.info(LOG, `remote track live: ${participantId}/${kind}`, { mid: String(ev.transceiver?.mid ?? '') })
    value.live = true
    value.track = ev.track
    // A track that ends has to stop counting as live or the reconciler will
    // never re-pull it.
    ev.track.addEventListener('ended', () => { value.live = false }, { once: true })
    // `streams` is deliberately still passed up, but useRtc ignores it — the
    // SFU gives each pulled track its own msid, so trusting it would make every
    // new track replace the participant's stream rather than join it.
    onRemoteTrack?.({ participantId, kind, track: ev.track, streams: ev.streams })
  }

  // Serialize: every SFU operation renegotiates the one PeerConnection.
  const run = fn => {
    const next = queue.then(fn, fn)
    queue = next.catch(() => {})
    return next
  }

  /**
   * Apply whatever the SFU said about the connection — and answer it when it is
   * waiting for one.
   *
   * The SFU alternates who offers, and it does not only offer when we pull. Any
   * response can come back with an offer instead of an answer once the session
   * has renegotiated behind our back, and **an offer we do not answer is
   * fatal**: the session sits in "the current signaling state is expecting a
   * remote answer", refuses every later call with a 406, and then reports
   * itself disconnected with a 410 for the rest of the kelabo. That is the
   * failure this whole file keeps arriving back at.
   *
   * Two of the three call sites could not answer one. The publish path assumed
   * every `sessionDescription` was an answer and fed an offer straight into
   * `setRemoteDescription` while holding a local offer of its own, which throws
   * and leaves the question hanging. Both `tracks/close` paths threw the
   * response away unread. So the handling lives here once, and every call site
   * routes through it.
   *
   * A renegotiation that cannot be completed is reported fatal rather than
   * swallowed: the session is already wedged by that point, and the only thing
   * that fixes it is a new one.
   */
  async function applySignal(res) {
    const desc = res?.sessionDescription
    if (!desc?.type) return
    callLog.debug(LOG, `apply ${desc.type}`, { sdpBytes: desc.sdp?.length ?? 0, signalling: pc.signalingState })
    try {
      if (desc.type === 'answer') {
        // Only while we are the one waiting for it. The SFU repeats the current
        // answer on responses that change nothing, and applying it in `stable`
        // is an InvalidStateError.
        if (pc.signalingState === 'have-local-offer') await pc.setRemoteDescription(desc)
        return
      }
      if (desc.type !== 'offer') return
      await pc.setRemoteDescription(desc)
      await pc.setLocalDescription(await pc.createAnswer())
      await waitForIceGathering(pc, wantRelay())
      await withRetry(() =>
        rtcApi.sfuRenegotiate(kelaboId, { type: 'answer', sdp: pc.localDescription.sdp }),
      )
    } catch (err) {
      callLog.error(LOG, `could not apply ${desc.type}`, { err: err?.message, m: summarizeSdp(desc.sdp) })
      throw fatal(err)
    }
  }

  /**
   * Create the Cloudflare session *and* bring its PeerConnection up, before any
   * other operation runs against it.
   *
   * Cloudflare refuses every call on a session whose PeerConnection is not
   * connected — `410 session_error` — and that session never recovers. So
   * something has to negotiate first. Letting the first *publish* do it made
   * that guarantee depend on the microphone winning a race against the roster,
   * and on a reload into a kelabo already in progress the microphone loses:
   * `getUserMedia` is still resolving when the reconciler's first tick fires,
   * so the first operation on the brand-new session is a pull, and the session
   * is dead seconds after it was born. Both sides then spend the kelabo
   * retrying against a corpse — the publisher cannot publish and the
   * subscriber's pulls come back `not_found_track_error` — which is what
   * "nobody can hear or see anybody" looks like from the inside. A participant
   * who denies the microphone had the same failure permanently, no race
   * needed.
   *
   * `/sessions/new` answers an offer in the same round trip, so the session is
   * connected from birth and the ordering stops mattering at all. The recvonly
   * transceiver is only there to give that offer a media section — an SDP with
   * no m-line is not a valid offer — and the SFU reuses it for the first track
   * we pull.
   *
   * The Gateway binds the session to this participant's peer record and
   * resolves it server-side on every later call, so the id never has to be sent.
   *
   * Always reached from inside `run`, so it is already serialized.
   */
  async function ensureSession() {
    if (sessionReady) return
    callLog.info(LOG, 'creating SFU session')
    // Once ever, even across failed attempts: each invocation past this guard
    // used to add another recvonly m-line, so a session POST that failed on a
    // bad network bloated every future offer.
    if (!sessionTransceiverAdded) {
      pc.addTransceiver('audio', { direction: 'recvonly' })
      sessionTransceiverAdded = true
    }
    await pc.setLocalDescription(await pc.createOffer())
    await waitForIceGathering(pc, wantRelay())
    const res = await withRetry(() =>
      rtcApi.sfuSession(kelaboId, { type: 'offer', sdp: pc.localDescription.sdp }),
    )
    if (res?.sessionDescription) await pc.setRemoteDescription(res.sessionDescription)
    // Set before the connection check: the session exists on Cloudflare's side
    // now, and retrying `ensureSession` would mint a second one and orphan the
    // first. If it never connects, that is a fatal condition for the whole
    // transport, not something to paper over here.
    sessionReady = true
    callLog.info(LOG, 'SFU session created — waiting for connect')
    if (!(await waitForConnected(pc))) throw fatal(new Error('sfu_connect_failed'))
    callLog.info(LOG, 'SFU session connected')
  }

  /**
   * Publish a local track of one kind, or clear it with `null`.
   *
   * The first track of a kind is published for real — a transceiver, an offer,
   * and a `tracks/new` call that makes the Gateway announce it to the room so
   * peers know to pull it. After that the sender is reused: toggling the camera
   * swaps the track on it and touches neither the SFU nor the roster. Doing it
   * the other way — closing and republishing the track — would churn the room's
   * roster on every click and make every peer re-pull.
   *
   * A cleared track therefore stays published-but-silent. That is deliberate:
   * peers keep their subscription, their receiving track fires `mute`, and the
   * tile falls back to the avatar. Nothing has to agree with anything else.
   */
  async function setLocalTrack(kind, track) {
    if (closed) return
    desired.set(kind, track ?? null)
    const sender = published.get(kind)
    if (sender) {
      try {
        await sender.replaceTrack(track)
      } catch (err) {
        onError?.(err)
      }
      return
    }
    if (!track || publishing.has(kind)) return
    publishing.add(kind)
    publishedAt.set(kind, Date.now())
    callLog.info(LOG, `publishing ${kind}`)
    return run(async () => {
      let transceiver
      try {
        if (closed) return
        await ensureSession()
        transceiver = pc.addTransceiver(track, { direction: 'sendonly' })
        if (kind !== 'audio' && transceiver.setCodecPreferences) {
          const codecs = publishableVideoCodecs()
          if (codecs) transceiver.setCodecPreferences(codecs)
        }
        published.set(kind, transceiver.sender)
        await pc.setLocalDescription(await pc.createOffer())
        await waitForIceGathering(pc, wantRelay())
        callLog.debug(LOG, `offer: publish ${kind}`, { m: summarizeSdp(pc.localDescription.sdp) })
        const res = await withRetry(() =>
          rtcApi.sfuTracks(kelaboId, {
            sessionDescription: { type: 'offer', sdp: pc.localDescription.sdp },
            tracks: [{ location: 'local', mid: transceiver.mid, trackName: TRACK_NAMES[kind] ?? kind, kind }],
          }),
        )
        await applySignal(res)
        const err = trackError(res)
        if (err) throw err
        callLog.info(LOG, `published ${kind}`, { mid: String(transceiver.mid ?? '') })
        // What was ASKED FOR may have moved while this publish was in flight —
        // a fast camera-off, or a device switch, lands in `desired` and then
        // hit the `publishing.has(kind)` early return above. The publish
        // completes with the track it captured at call time, so re-read
        // `desired` and swap; without this the stale track (sometimes an ended
        // one — dead camera hardware) stayed on the sender until the next
        // manual toggle, and the reconciler skipped the kind for good because
        // `published` said it was done.
        const wanted = desired.get(kind) ?? null
        if (wanted !== track) {
          try { await transceiver.sender.replaceTrack(wanted) } catch (e2) { onError?.(e2) }
        }
        // Hold the queue until the connection is actually up. Everything behind
        // this — every pull of every peer — is an API call on this session, and
        // Cloudflare rejects those with a 410 until the PeerConnection connects,
        // permanently souring the session. This is the one place that wait can
        // happen without deadlocking: nothing this publish needs is queued
        // behind it.
        await waitForConnected(pc)
      } catch (err) {
        // Leaving a half-published sender behind would make every later toggle
        // a silent no-op on a track the SFU never accepted, and leaving the
        // transceiver would put a dead m-line in every future offer. `desired`
        // still holds the track, so the reconciler will try again.
        callLog.error(LOG, `publish ${kind} failed`, err)
        published.delete(kind)
        if (transceiver) {
          try { transceiver.stop?.() } catch {}
        }
        report(err)
      } finally {
        publishing.delete(kind)
      }
    })
  }

  /**
   * Subscribe to one track another participant published.
   *
   * `sfuSessionId` is read as a readiness flag and nothing more — its presence
   * on the roster is how we know the peer has joined the SFU and has something
   * to subscribe to. The pull itself names the participant and lets the Gateway
   * resolve the session, so the value here never has to be current.
   */
  async function pullTrack(participantId, kind, trackName, sfuSessionId) {
    const key = `${participantId}/${kind}`
    if (closed || pulled.has(key) || !sfuSessionId) return
    // Reserve the slot before awaiting so a duplicate roster event cannot start
    // a second pull for the same track.
    pulled.set(key, { mid: null, live: false, lastAt: Date.now() })
    callLog.info(LOG, `pulling ${key}`)
    return run(async () => {
      if (closed) return
      try {
        await ensureSession()
        const res = await withRetry(() =>
          rtcApi.sfuTracks(kelaboId, {
            // Name the publisher, not their session. The Gateway resolves the
            // current session from its own roster, so a pull cannot be refused
            // merely because this tab's copy of the roster is a few seconds
            // behind — which is what a `403` on an ordinary reconnect was.
            tracks: [{ location: 'remote', participantId, trackName, kind }],
          }),
        )
        // Record the mid BEFORE applying the description, because applying it
        // is what fires `track` — and the handler above matches an arriving
        // track to its subscription by exactly this mid. Recorded afterwards,
        // every `track` event finds nothing, no stream is ever attached, and
        // the reconciler re-pulls a track that had in fact arrived: close,
        // re-pull, new mid, every ten seconds, for the whole kelabo, while
        // both tiles sit on "connecting". Nothing errors anywhere along the
        // way, which is what made it so hard to see — the SFU is behaving
        // perfectly and the only broken thing is our bookkeeping.
        //
        // Only a real mid counts. The rejected case carries `mid: ""`, and
        // storing that made the reconciler ask the SFU to close a track named
        // by an empty string — which it answers "Missing mid in track", every
        // ten seconds, forever.
        const mid = res?.tracks?.[0]?.mid
        const entry = pulled.get(key)
        if (entry && mid) {
          entry.mid = mid
          callLog.info(LOG, `pull accepted: ${key}`, { mid: String(mid) })
          const early = orphaned.get(String(mid))
          if (early) {
            orphaned.delete(String(mid))
            adopt([key, entry], early)
          }
        }

        // Pulling makes the SFU the offerer, so the answer goes back over
        // /rtc/sfu/renegotiate rather than in this response. Answer even when
        // the pull was rejected: Cloudflare has already moved its own
        // signalling state on, and leaving its offer unanswered is what wedges
        // a session for good. On a session that has published nothing yet this
        // is also the exchange that brings the PeerConnection up.
        await applySignal(res)

        const failed = trackError(res)
        if (failed) throw failed
      } catch (err) {
        // Drop the reservation so `reconcile` picks it up again rather than
        // seeing a slot that looks taken. One bad round trip should cost a few
        // seconds of that person's audio, not the whole kelabo's.
        callLog.error(LOG, `pull ${key} failed`, err)
        pulled.delete(key)
        report(err)
      }
    })
  }

  /**
   * Re-check the roster against what actually arrived, and pull whatever is
   * missing.
   *
   * This is the part that makes the transport self-healing. Every pull is one
   * shot at a moment when the network might be having a bad second, and the
   * Gateway only announces a track once — so without this, a single failure
   * silently costs that participant's audio or camera for the rest of the
   * kelabo, with no event that would ever fix it.
   */
  function reconcile(peers) {
    if (closed) return

    // Our own tracks first, and not only for symmetry: a peer cannot pull what
    // was never published, so a lost publish is the one failure that makes
    // *everyone else's* room wrong. It shows up as a tile with a name and
    // nothing in it.
    const now = Date.now()
    for (const [kind, track] of desired) {
      // A sender that drifted from what was asked for — the tail end of the
      // in-flight-publish race the repair in setLocalTrack usually catches.
      // Cheap to check, and it makes `desired` the truth on every tick rather
      // than only at publish time.
      const sender = published.get(kind)
      if (sender && !publishing.has(kind) && sender.track !== (track ?? null)) {
        sender.replaceTrack(track ?? null).catch(err => onError?.(err))
        continue
      }
      if (!track || sender || publishing.has(kind)) continue
      if (now - (publishedAt.get(kind) ?? 0) < REPUBLISH_INTERVAL_MS) continue
      setLocalTrack(kind, track)
    }

    const missing = missingPulls({ peers, pulled, now: Date.now(), graceMs: PULL_GRACE_MS })
    if (missing.length) callLog.info(LOG, `reconcile: ${missing.length} pull(s) to retry`, { missing: missing.map(m => `${m.participantId}/${m.kind}`) })
    for (const m of missing) {
      pulled.delete(`${m.participantId}/${m.kind}`)
      if (m.staleMid != null) {
        // The subscription exists as far as the SFU is concerned but no media
        // came of it. Close it before asking again, or the retry stacks another
        // dead transceiver onto the connection.
        run(async () => {
          try {
            await applySignal(await rtcApi.sfuCloseTracks(kelaboId, [{ mid: m.staleMid }]))
          } catch (err) {
            report(err)
          }
        })
      }
      pullTrack(m.participantId, m.kind, m.trackName, m.sfuSessionId)
    }
  }

  /** Stop receiving a departed peer's tracks. */
  async function dropPeer(participantId) {
    const mids = []
    for (const [key, value] of pulled) {
      if (!key.startsWith(`${participantId}/`)) continue
      pulled.delete(key)
      if (value.mid) mids.push({ mid: value.mid })
    }
    if (!mids.length || closed) return
    return run(async () => {
      try {
        await applySignal(await rtcApi.sfuCloseTracks(kelaboId, mids))
      } catch (err) {
        // The SFU stops forwarding a departed publisher's track anyway; this is
        // only tidying up our own transceivers — but a renegotiation left
        // half-done here wedges the session just as thoroughly as anywhere else.
        report(err)
      }
    })
  }

  /** What did and did not arrive — surfaced per kind so a tile can say which. */
  function trackStatus(participantId, kind) {
    return pulled.get(`${participantId}/${kind}`)?.live ? 'live' : 'pending'
  }

  function close() {
    closed = true
    callLog.info(LOG, 'transport closed')
    pulled.clear()
    published.clear()
    orphaned.clear()
    desired.clear()
    publishing.clear()
    publishedAt.clear()
    try { pc.close() } catch {}
  }

  return { mode: 'sfu', setLocalTrack, setIceServers, pullTrack, reconcile, dropPeer, trackStatus, close, trackNames: TRACK_NAMES }
}
