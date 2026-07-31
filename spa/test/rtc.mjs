import assert from 'node:assert/strict'
import { missingPulls, PULL_GRACE_MS } from '../src/rtc/reconcile.js'
import { isRetryable, isFatal } from '../src/rtc/retry.js'

/**
 * The conference transports need a real RTCPeerConnection, so almost none of
 * them can be tested outside a browser. These two modules are the parts where
 * a wrong decision is invisible in a live kelabo — a track that never arrives
 * looks exactly like a bad network — so they are kept pure and checked here.
 */

let passed = 0
const tests = []
const test = (name, fn) => tests.push([name, fn])

const NOW = 1_700_000_000_000
const peer = (id, tracks, sessionId = 'sess_' + id) => ({
  participantId: id,
  sfuSessionId: sessionId,
  tracks,
})

// --- missingPulls ----------------------------------------------------------

test('a peer whose tracks are all live needs nothing', () => {
  const pulled = new Map([
    ['bob/audio', { mid: '1', live: true, lastAt: NOW - 60_000 }],
    ['bob/video', { mid: '2', live: true, lastAt: NOW - 60_000 }],
  ])
  const out = missingPulls({ peers: [peer('bob', { audio: 'mic', video: 'cam' })], pulled, now: NOW })
  assert.deepEqual(out, [])
})

test('a track that was never pulled is reported', () => {
  const pulled = new Map([['bob/audio', { mid: '1', live: true, lastAt: NOW }]])
  const out = missingPulls({ peers: [peer('bob', { audio: 'mic', video: 'cam' })], pulled, now: NOW })
  assert.equal(out.length, 1)
  assert.equal(out[0].kind, 'video')
  assert.equal(out[0].trackName, 'cam')
  assert.equal(out[0].sfuSessionId, 'sess_bob')
  assert.equal(out[0].staleMid, null)
})

test('a pull still in flight is left alone', () => {
  const pulled = new Map([['bob/video', { mid: null, live: false, lastAt: NOW - 1000 }]])
  const out = missingPulls({ peers: [peer('bob', { video: 'cam' })], pulled, now: NOW })
  assert.deepEqual(out, [], 'one second in is not a failure')
})

test('a pull past its grace with no media is retried', () => {
  const pulled = new Map([['bob/video', { mid: null, live: false, lastAt: NOW - PULL_GRACE_MS - 1 }]])
  const out = missingPulls({ peers: [peer('bob', { video: 'cam' })], pulled, now: NOW })
  assert.equal(out.length, 1)
  assert.equal(out[0].kind, 'video')
})

// The case the whole reconciler exists for: the SFU accepted the subscription
// and handed back a mid, so every signal short of the media itself says this
// worked — and no picture ever arrived.
test('a subscription that returned a mid but produced no media is retried, and its mid reported', () => {
  const pulled = new Map([['bob/video', { mid: '7', live: false, lastAt: NOW - PULL_GRACE_MS - 1 }]])
  const out = missingPulls({ peers: [peer('bob', { video: 'cam' })], pulled, now: NOW })
  assert.equal(out.length, 1)
  assert.equal(out[0].staleMid, '7', 'the caller must close the dead subscription before re-pulling')
})

// Cloudflare reports a refused pull inside a 200, as `mid: ""`. Treating that
// as a subscription had the transport ask the SFU to close a track named by an
// empty string — answered "Missing mid in track" — every ten seconds, for the
// rest of the kelabo.
test('an empty mid is not a subscription and is never closed', () => {
  const pulled = new Map([['bob/video', { mid: '', live: false, lastAt: NOW - PULL_GRACE_MS - 1 }]])
  const out = missingPulls({ peers: [peer('bob', { video: 'cam' })], pulled, now: NOW })
  assert.equal(out.length, 1, 'still needs re-pulling')
  assert.equal(out[0].staleMid, null, 'there is nothing to close')
})

test('a peer that has not joined the SFU yet is skipped', () => {
  const out = missingPulls({
    peers: [{ participantId: 'bob', tracks: { audio: 'mic' } }],
    pulled: new Map(),
    now: NOW,
  })
  assert.deepEqual(out, [], 'there is no session to subscribe to')
})

test('a track whose name is empty is skipped', () => {
  const out = missingPulls({ peers: [peer('bob', { audio: '' })], pulled: new Map(), now: NOW })
  assert.deepEqual(out, [])
})

test('every peer and every kind is covered, not just the first', () => {
  const out = missingPulls({
    peers: [peer('bob', { audio: 'mic', video: 'cam' }), peer('sam', { audio: 'mic' })],
    pulled: new Map(),
    now: NOW,
  })
  assert.equal(out.length, 3)
  assert.deepEqual(
    out.map(m => `${m.participantId}/${m.kind}`).sort(),
    ['bob/audio', 'bob/video', 'sam/audio'],
  )
})

test('a track that ended stops counting as live and comes back', () => {
  // `live` is cleared by the transport's `ended` listener; the entry stays.
  const pulled = new Map([['bob/audio', { mid: '1', live: false, lastAt: NOW - PULL_GRACE_MS - 1 }]])
  const out = missingPulls({ peers: [peer('bob', { audio: 'mic' })], pulled, now: NOW })
  assert.equal(out.length, 1)
})

test('a missing or malformed roster is not an error', () => {
  assert.deepEqual(missingPulls({ peers: undefined, pulled: new Map(), now: NOW }), [])
  assert.deepEqual(missingPulls({ peers: [null], pulled: new Map(), now: NOW }), [])
  assert.deepEqual(missingPulls({ peers: [peer('bob', undefined)], pulled: new Map(), now: NOW }), [])
})

// --- isRetryable -----------------------------------------------------------

test('a network failure with no response is retryable', () => {
  assert.equal(isRetryable(new TypeError('Failed to fetch')), true)
  assert.equal(isRetryable({}), true)
})

test('server-side failures are retryable', () => {
  for (const status of [500, 502, 503, 504]) {
    assert.equal(isRetryable({ status }), true, `${status} should retry`)
  }
})

test('timeouts and rate limits say "later", not "no"', () => {
  assert.equal(isRetryable({ status: 408 }), true)
  assert.equal(isRetryable({ status: 429 }), true)
})

// Retrying these only delays the error: the Gateway will reject the identical
// request identically, and a pull rejected as not-a-peer-of-this-kelabo is a
// permission decision, not a blip.
test('client errors are not retried', () => {
  for (const status of [400, 401, 403, 404, 409, 422]) {
    assert.equal(isRetryable({ status }), false, `${status} should not retry`)
  }
})

// --- isFatal ---------------------------------------------------------------
// The distinction the whole recovery path rests on. A dead Cloudflare session
// and a Gateway having a bad second both arrive as a 502; only `cfCode` tells
// them apart, and getting it wrong in the safe-looking direction is what left
// two people retrying against a session that was never going to answer again.

test('a disconnected Cloudflare session is fatal, not transient', () => {
  const err = { status: 502, code: 'rtc_unavailable', cfStatus: 410, cfCode: 'session_error' }
  assert.equal(isFatal(err), true)
  assert.equal(isRetryable(err), false, 'retrying a dead session only delays the rebuild')
})

test('other Cloudflare failures stay retryable', () => {
  for (const cfCode of ['invalid_session_description', 'transport_unavailable_error', undefined]) {
    const err = { status: 502, cfStatus: 406, cfCode }
    assert.equal(isFatal(err), false, `${cfCode} should not be fatal`)
    assert.equal(isRetryable(err), true, `${cfCode} should still retry`)
  }
})

test('an explicitly marked error is fatal whatever its shape', () => {
  const err = new Error('sfu_connect_failed')
  err.fatal = true
  assert.equal(isFatal(err), true)
})

test('nothing is not fatal', () => {
  assert.equal(isFatal(null), false)
  assert.equal(isFatal(undefined), false)
})

for (const [name, fn] of tests) {
  try {
    fn()
    passed++
    console.log('ok:', name)
  } catch (err) {
    console.error('FAIL:', name)
    console.error(err.message)
    process.exitCode = 1
  }
}
console.log(`\n${passed}/${tests.length} rtc tests passed`)
