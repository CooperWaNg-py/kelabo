/**
 * Which of a peer's advertised tracks have not actually reached us.
 *
 * Deliberately pure, and deliberately not inside the transport: everything else
 * in `sfuTransport.js` needs a real `RTCPeerConnection`, so it can only be
 * exercised in a live kelabo — which is the one place this class of bug is
 * hardest to see, because "someone's camera didn't come through" looks like a
 * bad network rather than a decision made wrongly. The decision lives here, and
 * `spa/test/rtc.mjs` runs it in plain node. (Hence the `.js` extension on the
 * import in the transport, like the transcript modules.)
 *
 * The rule the transport enforces:
 *
 *   The roster is a promise, the `track` event is the delivery, and a 200 from
 *   the SFU is neither.
 *
 * A pull that returned success but produced no media is the interesting case —
 * it looks finished from every angle except the one that matters — so it is
 * re-pulled once its grace period is up, and its stale subscription is reported
 * so the caller can close it first instead of stacking another dead transceiver
 * onto the connection.
 */

/** How long a pull may be in flight before it is treated as having failed. */
export const PULL_GRACE_MS = 6000

/**
 * @param {object} args
 * @param {Array<{participantId:string, sfuSessionId?:string, tracks?:Record<string,string>}>} args.peers
 *   the roster, as delivered by `/rtc/join` and the `rtc` SSE events
 * @param {Map<string, {mid?:any, live?:boolean, lastAt:number}>} args.pulled
 *   what the transport has tried, keyed `"<participantId>/<kind>"`
 * @param {number} args.now
 * @param {number} [args.graceMs]
 * @returns {Array<{participantId:string, kind:string, trackName:string,
 *                  sfuSessionId:string, staleMid: any}>}
 */
export function missingPulls({ peers, pulled, now, graceMs = PULL_GRACE_MS }) {
  const out = []
  if (!Array.isArray(peers)) return out

  for (const peer of peers) {
    // No session means the peer has joined the room but not the SFU yet. There
    // is nothing to subscribe to, and asking would be rejected.
    if (!peer?.participantId || !peer.sfuSessionId) continue

    for (const [kind, trackName] of Object.entries(peer.tracks || {})) {
      if (!trackName) continue
      const key = `${peer.participantId}/${kind}`
      const entry = pulled.get(key)

      // Media is flowing. Nothing to do — this is the only condition that counts
      // as done.
      if (entry?.live) continue

      // In flight. A slow round trip is not a failure yet.
      if (entry && now - entry.lastAt < graceMs) continue

      out.push({
        participantId: peer.participantId,
        kind,
        trackName,
        sfuSessionId: peer.sfuSessionId,
        // Present when a previous attempt got as far as a real subscription
        // that never delivered; the caller closes it before trying again.
        // Falsy covers the empty string as well as null: a pull the SFU
        // rejected reports `mid: ""`, and asking it to close that comes back
        // "Missing mid in track" on every tick for the rest of the kelabo.
        staleMid: entry?.mid || null,
      })
    }
  }
  return out
}
