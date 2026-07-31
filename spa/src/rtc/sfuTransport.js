import { rtc as rtcApi } from '../api'
import { withRetry, isFatal } from './retry.js'
import { missingPulls, PULL_GRACE_MS } from './reconcile.js'

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
const ICE_GATHER_TIMEOUT_MS = 3000

// Cloudflare refuses to touch a session whose PeerConnection is not up:
// `tracks/new` answers `410 session_error: "Session appears to be disconnected.
// Please check if the PeerConnection is connected."` and every later call on
// that session answers the same, for the rest of the kelabo. Publishing is
// what brings the connection up, so the first publish waits here — once — and
// everything queued behind it then runs against a live session.
const CONNECT_TIMEOUT_MS = 15000

// How long before the reconciler tries a failed publish again.
const REPUBLISH_INTERVAL_MS = 20000

function waitForIceGathering(pc) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve()
  return new Promise(resolve => {
    let done = false
    const finish = () => {
      if (done) return
      done = true
      pc.removeEventListener('icegatheringstatechange', onChange)
      clearTimeout(timer)
      resolve()
    }
    const onChange = () => {
      if (pc.iceGatheringState === 'complete') finish()
    }
    pc.addEventListener('icegatheringstatechange', onChange)
    // Some networks leave a candidate source hanging (a TURN server that never
    // answers). The candidates gathered so far are usually enough, so cap the
    // wait rather than stalling the whole call on the slowest one.
    const timer = setTimeout(finish, ICE_GATHER_TIMEOUT_MS)
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
  let queue = Promise.resolve()
  // Reported at most once. Everything in flight when a session dies fails, and
  // a burst of identical "rebuild the call" requests would tear down the
  // replacement as fast as it was built.
  let died = false

  /**
   * Every SFU failure lands here. Most are a bad second and belong to whoever
   * retries them; a dead session belongs to the caller above, because fixing it
   * means replacing this transport.
   */
  function report(err) {
    if (isFatal(err) && !died && !closed) {
      died = true
      onFatal?.(err)
      return
    }
    onError?.(err)
  }

  // One PeerConnection carries every peer's media here, so its state applies to
  // all of them — unlike mesh, where each peer has its own.
  pc.addEventListener('connectionstatechange', () => onStateChange?.(null, pc.connectionState))
  pc.addEventListener('iceconnectionstatechange', () => {
    if (pc.iceConnectionState === 'failed') {
      // An ICE restart is the only thing that recovers a failed checklist, and
      // it costs one renegotiation. Without it the call sits on "connecting"
      // forever with no explanation and no way back.
      try { pc.restartIce?.() } catch {}
      onError?.(new Error('ice_failed'))
    }
  })

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
      orphaned.set(String(mid), ev)
      return
    }
    adopt(entry, ev)
  })

  /** Attach an arrived track to the subscription that asked for it. */
  function adopt([key, value], ev) {
    const [participantId, kind] = key.split('/')
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
      await waitForIceGathering(pc)
      await withRetry(() =>
        rtcApi.sfuRenegotiate(kelaboId, { type: 'answer', sdp: pc.localDescription.sdp }),
      )
    } catch (err) {
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
    pc.addTransceiver('audio', { direction: 'recvonly' })
    await pc.setLocalDescription(await pc.createOffer())
    await waitForIceGathering(pc)
    const res = await withRetry(() =>
      rtcApi.sfuSession(kelaboId, { type: 'offer', sdp: pc.localDescription.sdp }),
    )
    if (res?.sessionDescription) await pc.setRemoteDescription(res.sessionDescription)
    // Set before the connection check: the session exists on Cloudflare's side
    // now, and retrying `ensureSession` would mint a second one and orphan the
    // first. If it never connects, that is a fatal condition for the whole
    // transport, not something to paper over here.
    sessionReady = true
    if (!(await waitForConnected(pc))) throw fatal(new Error('sfu_connect_failed'))
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
    return run(async () => {
      let transceiver
      try {
        if (closed) return
        await ensureSession()
        transceiver = pc.addTransceiver(track, { direction: 'sendonly' })
        published.set(kind, transceiver.sender)
        await pc.setLocalDescription(await pc.createOffer())
        await waitForIceGathering(pc)
        const res = await withRetry(() =>
          rtcApi.sfuTracks(kelaboId, {
            sessionDescription: { type: 'offer', sdp: pc.localDescription.sdp },
            tracks: [{ location: 'local', mid: transceiver.mid, trackName: TRACK_NAMES[kind] ?? kind, kind }],
          }),
        )
        await applySignal(res)
        const err = trackError(res)
        if (err) throw err
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
      if (!track || published.has(kind) || publishing.has(kind)) continue
      if (now - (publishedAt.get(kind) ?? 0) < REPUBLISH_INTERVAL_MS) continue
      setLocalTrack(kind, track)
    }

    const missing = missingPulls({ peers, pulled, now: Date.now(), graceMs: PULL_GRACE_MS })
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
    pulled.clear()
    published.clear()
    orphaned.clear()
    desired.clear()
    publishing.clear()
    publishedAt.clear()
    try { pc.close() } catch {}
  }

  return { mode: 'sfu', setLocalTrack, pullTrack, reconcile, dropPeer, trackStatus, close, trackNames: TRACK_NAMES }
}
