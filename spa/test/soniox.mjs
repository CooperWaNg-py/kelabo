// The Soniox connection policy (spa/src/stt/sonioxPolicy.js), under plain node.
//
// Everything here is about money. Soniox bills the wall-clock lifetime of a
// stream from the start request, so a connection that has been opened and has
// sent nothing is free, and one that has had a start request is not — whether
// or not anybody is talking into it. The difference is a handful of booleans,
// and getting them wrong produces no symptom at all in a live kelabo: the
// transcript is perfect and the invoice is wrong a month later.
//
// So these are the assertions that cannot be made anywhere else.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { COMPOSER_DEFAULTS } from '../src/transcript/composer.js'
import { VAD_DEFAULTS } from '../src/capture/vad.js'
import {
  POOL_DEFAULTS,
  bufferCapacity,
  createBillingGuard,
  expiredConnections,
  keepaliveDue,
  pickConnection,
  prerollFrames,
  refillCount,
  shouldRefreshKey,
  silenceElapsed,
} from '../src/stt/sonioxPolicy.js'

let passed = 0
const ok = msg => {
  passed += 1
  console.log('ok:', msg)
}

// --- the billing guard ------------------------------------------------------
{
  // THE INVARIANT THIS WHOLE MODULE EXISTS FOR. In gated mode the only thing
  // that may open a billable stream is somebody speaking. A stream opened
  // because a socket happened to connect is a stream nobody asked for, billing
  // silence for as long as the kelabo lasts.
  const guard = createBillingGuard({ gated: true })
  assert.equal(guard.canStart('open'), false, 'a connection opening must not start billing')
  assert.equal(guard.canStart('reconnect'), false)
  assert.equal(guard.canStart('keepalive'), false)
  assert.equal(guard.canStart('speech'), true)
  assert.equal(guard.state, 'idle')
  ok('in gated mode only speech may start a billable stream')
}

{
  // Nothing may go out before the start request. A keepalive before it is a
  // protocol error, and ANY byte on a pooled connection ends the property that
  // makes the pool free.
  const guard = createBillingGuard({ gated: true })
  assert.equal(guard.canSend(), false, 'not before the start request')
  guard.start('speech')
  assert.equal(guard.canSend(), true)
  guard.end()
  assert.equal(guard.canSend(), false, 'not after the end frame either')
  ok('nothing may be sent before the start request or after the end frame')
}

{
  // One connection carries exactly one stream; Soniox closes it when that
  // stream ends and rejects a second start request on it.
  const guard = createBillingGuard({ gated: true })
  assert.equal(guard.start('speech'), true)
  assert.equal(guard.start('speech'), false, 'a second start request must be refused')
  assert.equal(guard.state, 'streaming')
  ok('one start request per connection, ever')
}

{
  // The end frame is idempotent and cannot resurrect a stream: billing stops
  // once.
  const guard = createBillingGuard({ gated: true })
  guard.start('speech')
  assert.equal(guard.end(), true)
  assert.equal(guard.end(), false, 'ending twice is not two stops')
  assert.equal(guard.start('speech'), false, 'and a finished stream never restarts')
  assert.equal(guard.state, 'ended')
  ok('billing stops exactly once and never restarts on the same connection')
}

{
  // Ungated (silence skipping off): there is no onset to wait for, so a stream
  // may start as soon as a connection exists — but the other three guarantees
  // are unchanged.
  const guard = createBillingGuard({ gated: false })
  assert.equal(guard.canStart('open'), true)
  assert.equal(guard.canSend(), false, 'still nothing before the start request')
  guard.start('open')
  assert.equal(guard.start('speech'), false, 'still one per connection')
  ok('ungated mode relaxes the trigger and nothing else')
}

// --- the pool ---------------------------------------------------------------
{
  // Oldest first: spend the connection nearest whatever the server's idle
  // tolerance turns out to be, and keep the young one in reserve, so the spare
  // left behind is the one most likely to still be alive.
  const entries = [
    { openedAt: 5000, open: true },
    { openedAt: 1000, open: true },
    { openedAt: 3000, open: true },
  ]
  assert.equal(pickConnection(entries), 1)
  ok('the oldest connection is spent first, the youngest kept in reserve')
}

{
  // A socket that is not OPEN is not a spare, however old it is. Picking one
  // would send the start request into nowhere and lose the utterance.
  assert.equal(pickConnection([{ openedAt: 1, open: false }, { openedAt: 9, open: true }]), 1)
  assert.equal(pickConnection([{ openedAt: 1, open: false }]), -1)
  assert.equal(pickConnection([]), -1, 'an empty pool is a cold start, not a crash')
  ok('only an OPEN connection can be spent; an empty pool reports itself')
}

{
  // Age eviction. An idle socket can be killed by a NAT or proxy without a
  // close frame and still report OPEN, so it is retired before that is likely.
  // Indices come back descending so the caller can splice back to front.
  const now = 100_000
  const entries = [
    { openedAt: now - 40_000 },
    { openedAt: now - 1_000 },
    { openedAt: now - 31_000 },
  ]
  assert.deepEqual(expiredConnections(entries, now, 30_000), [2, 0])
  assert.deepEqual(expiredConnections(entries, now, 60_000), [], 'nothing is stale yet')
  ok('connections past the age limit are evicted, newest-last so splicing is safe')
}

{
  // Refill counts what is already in flight. Without that, a burst of calls
  // opens a burst of sockets — each one a file descriptor and a TLS session on
  // somebody else's edge, even though none of them is billed.
  assert.equal(refillCount(0, 0, 2), 2)
  assert.equal(refillCount(1, 1, 2), 0, 'one open, one opening: the pool is full')
  assert.equal(refillCount(2, 0, 2), 0)
  assert.equal(refillCount(3, 0, 2), 0, 'never negative')
  ok('refill counts connections already in flight, so a burst opens one pool')
}

// --- ending the stream ------------------------------------------------------
{
  // The silence that stops the meter.
  assert.equal(silenceElapsed(10_000, 8_000, 3000), false)
  assert.equal(silenceElapsed(11_000, 8_000, 3000), true)
  assert.equal(silenceElapsed(11_000, 0, 3000), false, 'nobody has spoken yet — nothing to end')
  ok('the silence gate only fires once somebody has actually spoken')
}

{
  // THE ORDERING THAT MUST HOLD, end to end.
  //
  // A speaker stops. The gate keeps streaming for `hangoverMs` so the provider
  // can endpoint and revise from that audio. `silenceMs` later the billed
  // stream is ended, and `drainMs` after that the socket is finally dropped —
  // so the very latest a corrected final can arrive is the sum of all three.
  //
  // The composer must still have the message open when it does. Its stale
  // timeout is the one that applies, because an utterance waiting to be
  // corrected is by definition one with an unconfirmed tail.
  const latestCorrectionMs =
    VAD_DEFAULTS.hangoverMs + POOL_DEFAULTS.silenceMs + POOL_DEFAULTS.drainMs
  assert.ok(
    latestCorrectionMs <= COMPOSER_DEFAULTS.staleTimeoutMs,
    `a correction can arrive ${latestCorrectionMs}ms after the last word, but the ` +
      `composer seals an unconfirmed message after ${COMPOSER_DEFAULTS.staleTimeoutMs}ms — ` +
      `it would land on a sealed message and open a second bubble`,
  )
  ok('a late correction still finds its message open')
}

{
  // The stream must not be ended while the provider is still being sent audio,
  // or the hangover is pointless. Trivially true while silenceMs is positive
  // and measured from the last frame handed over, but stated so that setting
  // silenceMs to zero fails here rather than in a kelabo.
  assert.ok(POOL_DEFAULTS.silenceMs > 0, 'the stream would end on the same tick as the last frame')
  ok('the billed stream outlives the last frame of audio')
}

// --- keepalive --------------------------------------------------------------
{
  // Soniox closes a stream idle for more than 20s. A continuous stream is held
  // across pauses, and when the caller is gating there is no audio flowing
  // through those pauses to keep it alive — so without this the stream simply
  // dies mid-kelabo the first time somebody stops talking for twenty seconds.
  assert.ok(POOL_DEFAULTS.keepaliveMs < 20_000, 'must be well inside the 20s idle close')
  const opts = { pooled: false, streaming: true }
  assert.equal(keepaliveDue(10_000, 9_000, opts), false)
  assert.equal(keepaliveDue(10_000, 4_000, opts), true)
  ok('a continuous stream is kept alive inside the provider’s idle close')
}

{
  // A pooled stream never needs one: it lives for a single utterance and the
  // silence gate ends it long before 20s.
  assert.equal(keepaliveDue(10_000, 0, { pooled: true, streaming: true }), false)
  // And a keepalive before the start request is BOTH a protocol error and a
  // byte on a connection that is supposed to be free.
  assert.equal(keepaliveDue(10_000, 0, { pooled: false, streaming: false }), false)
  ok('no keepalive on a pooled stream, and never before the start request')
}

// --- what may be dropped while there is no stream ---------------------------
{
  // THE BUG THIS FIXES: the first words of a sentence disappearing, but only
  // sometimes. With a warm pool the stream accepts audio immediately and
  // nothing is ever buffered. With an EMPTY pool a full handshake goes by
  // first, and the gate has just handed over its own 400ms of pre-roll on top —
  // about a second of real speech arriving with nowhere to go. Trimming that to
  // a 427ms ring dropped the oldest frames, which are the start of the
  // sentence.
  const idle = bufferCapacity({ starting: false, prerollFrames: 5, maxFrames: 120 })
  const starting = bufferCapacity({ starting: true, prerollFrames: 5, maxFrames: 120 })
  assert.equal(idle, 5, 'idle keeps a small rolling pre-roll')
  assert.equal(starting, 120, 'a starting stream keeps everything already spoken')
  assert.ok(starting > idle)
  ok('speech captured while a stream is starting is never dropped as pre-roll')
}

{
  // The bound while starting exists only so a connection that never opens
  // cannot grow memory without limit — it must comfortably outlast a handshake,
  // or it is just the same bug with a bigger constant.
  const frameMs = (4096 / 48000) * 1000
  const maxFrames = prerollFrames(10_000, 4096, 48000)
  assert.ok(maxFrames * frameMs > 5000, 'must hold far more than one handshake')
  ok('the starting-buffer bound is a safety valve, not a trimming policy')
}

// --- the temporary key ------------------------------------------------------
{
  // Minting costs ~470ms. Doing it at the onset of an utterance spends more
  // than the entire latency budget this design exists to protect, so it happens
  // between them — and never while a stream is running.
  const ttl = 600
  const now = 1_000_000
  assert.equal(shouldRefreshKey(now, now - 100_000, ttl, false), false, 'still fresh')
  assert.equal(shouldRefreshKey(now, now - 550_000, ttl, false), true, 'at 90% of its life')
  assert.equal(shouldRefreshKey(now, now - 550_000, ttl, true), false, 'never mid-utterance')
  assert.equal(shouldRefreshKey(now, 0, ttl, false), false)
  ok('the key is refreshed between utterances, never on the critical path')
}

// --- pre-roll ---------------------------------------------------------------
{
  // Speech exists before the gate notices it. A stream that begins at the onset
  // has already missed the start of the word that opened it, so the ring buffer
  // is flushed straight after the start request.
  assert.equal(prerollFrames(300, 4096, 48000), 4, '~85ms frames: 4 covers 300ms')
  assert.equal(prerollFrames(300, 1024, 16000), 5, '64ms frames: 5 covers 300ms')
  assert.ok(prerollFrames(0, 4096, 48000) >= 1, 'always at least one frame')
  ok('the pre-roll ring is sized from the real frame duration, never assumed')
}

// --- the static check the design asks for -----------------------------------
{
  // "The only raw `.send(` calls in the codebase are the two inside
  // sendStartRequest and sendOnStream."
  //
  // Worth checking mechanically rather than trusting review, because a third
  // one is invisible: it would be a byte on a connection that is supposed to be
  // free, or a frame before the start request that fails the whole stream, and
  // neither shows up as a broken transcript. Both existing call sites are
  // guarded; a new unguarded one is the bug this catches.
  const src = readFileSync(new URL('../src/stt/soniox.js', import.meta.url), 'utf8')
  const sends = src.match(/\.send\(/g) || []
  assert.equal(
    sends.length,
    2,
    `soniox.js must contain exactly two raw .send( calls (sendStartRequest and ` +
      `sendOnStream); found ${sends.length}. Route the new one through a chokepoint.`,
  )
  // And they must be the two that are guarded.
  assert.match(src, /function sendStartRequest\([\s\S]*?guard\.start\(/)
  assert.match(src, /function sendOnStream\([\s\S]*?guard\.canSend\(\)/)
  ok('exactly two raw sends exist, and both are behind the billing guard')
}

console.log(`\n${passed} soniox policy tests passed`)
