/**
 * Retry policy shared by both conference transports.
 *
 * Every signalling call in a call setup is a single HTTP request over whatever
 * network the participant happens to be on, and until now one failure anywhere
 * meant that track was gone for the rest of the kelabo: nothing re-tried, and
 * nothing noticed afterwards that it was missing. A dropped publish lost your
 * microphone; a dropped pull lost someone else's.
 */

export const RETRY_DELAYS = [400, 1200, 3000]

export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/**
 * Worth trying again? A network error (no `status` at all) or a server-side
 * failure is transient. A 4xx is us sending something the Gateway rejects —
 * a malformed body, a session that is not ours — and will be rejected
 * identically forever, so retrying it only delays the error. 408 and 429 are
 * the two exceptions that say "later" rather than "no".
 */
export function isRetryable(err) {
  // A dead session is a 502, which the rule below would retry four times before
  // giving up — four full round trips, per call, per reconcile tick, for the
  // rest of the kelabo.
  if (isFatal(err)) return false
  const status = err?.status
  if (!status) return true
  if (status === 408 || status === 429) return true
  return status >= 500
}

/**
 * Past retrying — this session is over.
 *
 * Cloudflare answers `410 session_error` for a session whose PeerConnection is
 * not up, and every later call on that session answers the same for the rest of
 * the kelabo. The Gateway forwards its `errorCode` as `cfCode`, which is the
 * only way to tell it apart from the transient failures above: both arrive as a
 * 502. Treating it as transient is what turned one bad negotiation into a
 * nine-minute outage that nobody was told about, with both participants
 * retrying against a session that was never going to answer.
 *
 * The cure is a new session, which means a new PeerConnection, which means the
 * transport has to be replaced — so this is reported up rather than handled.
 */
export function isFatal(err) {
  return !!err && (err.fatal === true || err.cfCode === 'session_error')
}

/**
 * Run `fn`, retrying transient failures with a fixed backoff. Gives up by
 * rethrowing, so the caller still decides what a permanent failure means —
 * for a pull it means "leave it for the reconciler", for a publish it means
 * "undo the half-added transceiver".
 */
export async function withRetry(fn, { onRetry } = {}) {
  let lastErr
  for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      if (!isRetryable(err) || attempt === RETRY_DELAYS.length) break
      onRetry?.(err, attempt + 1)
      await sleep(RETRY_DELAYS[attempt])
    }
  }
  throw lastErr
}
