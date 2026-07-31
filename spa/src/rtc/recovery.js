/**
 * When to give a connection another chance — the decisions, not the plumbing.
 *
 * Pure, in the style of reconcile.js and retry.js: everything else in the
 * transports needs a real RTCPeerConnection, so it can only be exercised in a
 * live kelabo — where "the call went dark and never came back" looks like a
 * bad network rather than a budget that was spent and never refilled. That
 * exact bug shipped once: the mesh rebuild cap was a lifetime cap while the
 * SFU's refilled on success, and nothing could say so outside a live call.
 * The decisions live here so spa/test/rtc.mjs pins them under plain node, and
 * so the two transports read the same rules instead of drifting apart again.
 * (Imports carry `.js` for the same reason as the other pure modules.)
 */

/**
 * How many times a single peer connection may be rebuilt *per run of bad luck*.
 * The counter must be reset to 0 whenever the connection reaches `connected`:
 * four failures in a row is a network that will not carry the call, but four
 * across an hour-long kelabo is just an hour-long kelabo.
 */
export const MAX_PEER_REBUILDS = 4

/**
 * Tear down and re-dial one peer? Only a connection that has failed outright,
 * and only while its budget lasts — ICE restarts handle the cheaper cases.
 */
export function shouldRebuildPeer({ connectionState, rebuilds }) {
  return connectionState === 'failed' && rebuilds < MAX_PEER_REBUILDS
}

/**
 * Is the whole call beyond per-peer repair? Every peer failing at once is not
 * N unlucky peers — it is our own network interface changing, a resumed
 * laptop, or a Gateway that lost the room. The correct response is a full
 * rejoin, which per-peer rebuilds can never achieve.
 *
 * @param {string[]} states  connectionState of every current peer connection
 */
export function shouldRebuildCall(states) {
  return states.length > 0 && states.every(s => s === 'failed')
}

/**
 * When to re-mint ICE credentials, as a delay from when they were issued.
 * 80% of the TTL: early enough that an ICE restart never gathers with dead
 * TURN credentials, late enough not to hammer the endpoint. Floored so a
 * short/absent TTL cannot melt into a busy loop.
 */
export function iceRefreshDelayMs(ttlSeconds) {
  const ttl = Number(ttlSeconds)
  if (!Number.isFinite(ttl) || ttl <= 0) return ICE_REFRESH_RETRY_MS
  return Math.max(30_000, Math.floor(ttl * 0.8) * 1000)
}

/** A failed re-mint is retried on a short fixed delay rather than waiting out the TTL. */
export const ICE_REFRESH_RETRY_MS = 120_000

/**
 * Backoff for retrying a failed `/rtc/join`. Capped rather than unbounded:
 * `error` must mean "retrying in the background", never "gave up forever" —
 * a passive banner over a dead call was the old behaviour, and the only way
 * out of it was a manual reload.
 */
export function joinRetryDelayMs(attempt) {
  const n = Number.isFinite(attempt) && attempt > 0 ? attempt : 0
  return Math.min(30_000, 2000 * 2 ** n)
}
