// The capture gate's policy: what to send, given how likely each frame is to
// be speech.
//
// The detector is a model and cannot run here. That is exactly why this file
// exists: everything the model does NOT decide - when to open, how long to
// hold, what to send first - is decided here, is where words actually get lost,
// and is scriptable as a list of probabilities.

import assert from 'node:assert'
import { createSpeechGate, VAD_DEFAULTS } from '../src/capture/vad.js'
import { POOL_DEFAULTS, MAX_ENDPOINT_DELAY_MS } from '../src/stt/sonioxPolicy.js'
import { COMPOSER_DEFAULTS } from '../src/transcript/composer.js'

let passed = 0
const ok = m => {
  passed++
  console.log('ok:', m)
}

const FRAME_MS = (4096 / 48000) * 1000 // 85.33
const gate = (o = {}) => createSpeechGate({ sampleRate: 48000, frameSamples: 4096, ...o })
/** Feed a run of frames at one probability; return everything sent. */
const feed = (g, p, n, tag = 'x') => {
  const sent = []
  let opened = 0
  let closed = 0
  for (let i = 0; i < n; i++) {
    const r = g.push(p, tag)
    sent.push(...r.send)
    if (r.opened) opened++
    if (r.closed) closed++
  }
  return { sent, opened, closed }
}

// --- opening and closing -----------------------------------------------------
{
  const g = gate()
  assert.equal(feed(g, 0.01, 20).sent.length, 0, 'silence must send nothing')
  const speech = feed(g, 0.9, 1)
  assert.equal(speech.opened, 1, 'one confident frame opens the gate at the default attack')
  ok('nothing is sent until the model says someone is speaking')
}

{
  // The close is on the hangover, not on the first quiet frame. This is what
  // keeps a pause for breath from cutting a sentence in half.
  const g = gate()
  feed(g, 0.9, 3)
  const hangoverFrames = Math.round(VAD_DEFAULTS.hangoverMs / FRAME_MS)
  const during = feed(g, 0.01, hangoverFrames)
  assert.equal(during.closed, 0, 'closed inside the hangover')
  assert.ok(during.sent.length > 0, 'audio must keep flowing through the hangover')
  const after = feed(g, 0.01, 2)
  assert.equal(after.closed, 1, 'never closed after the hangover elapsed')
  ok('the gate holds through a pause and closes only after the hangover')
}

{
  // Hysteresis. A frame sitting between the two thresholds keeps the gate open
  // but would not have opened it. Without this a syllable hovering on the line
  // chatters the gate, and on a per-stream-billed provider each chatter is a
  // new billable stream.
  const g = gate()
  const between = (VAD_DEFAULTS.openThreshold + VAD_DEFAULTS.closeThreshold) / 2
  assert.equal(feed(g, between, 10).opened, 0, 'a middling frame must not open the gate')
  feed(g, 0.9, 1)
  assert.equal(feed(g, between, 30).closed, 0, 'the same frame must keep it open')
  ok('the level that keeps the gate open is lower than the level that opens it')
}

// --- pre-roll ----------------------------------------------------------------
{
  // The word that trips the gate is in the audio from BEFORE it tripped. If
  // that is not sent, every utterance loses its first syllable - and it is the
  // syllable that carries the consonant a transcript needs most.
  const g = gate()
  for (let i = 0; i < 20; i++) g.push(0.01, `quiet${i}`)
  const r = g.push(0.9, 'first-word')
  assert.ok(r.send.length > 1, 'the opening frame was sent alone; pre-roll was dropped')
  assert.equal(r.send[r.send.length - 1], 'first-word', 'the current frame must come last')
  const preroll = Math.round(VAD_DEFAULTS.prerollMs / FRAME_MS)
  assert.equal(r.send.length, preroll + 1, 'wrong amount of pre-roll')
  assert.equal(r.send[0], `quiet${20 - preroll}`, 'pre-roll must be oldest first and contiguous')
  ok('the audio from before the gate opened is sent first, oldest first')
}

{
  // The ring is bounded, or a long silence would send the whole of it at the
  // next word - paying for exactly the audio the gate exists to avoid.
  const g = gate()
  for (let i = 0; i < 500; i++) g.push(0.01, i)
  const r = g.push(0.9, 'now')
  const prerollFrames = Math.round(VAD_DEFAULTS.prerollMs / FRAME_MS)
  assert.equal(r.send.length, prerollFrames + 1, `sent ${r.send.length} frames of pre-roll`)
  ok('pre-roll is bounded, so a long silence is not billed at the next word')
}

{
  // Pre-roll is sent once, not on every frame of an utterance.
  const g = gate()
  for (let i = 0; i < 20; i++) g.push(0.01, 'q')
  g.push(0.9, 'a')
  for (let i = 0; i < 5; i++) {
    assert.equal(g.push(0.9, 'b').send.length, 1, 'pre-roll was replayed mid-utterance')
  }
  ok('pre-roll is flushed once per opening')
}

// --- the attack --------------------------------------------------------------
{
  // The attack is not needed against clicks any more - the model scores those
  // near zero - but it still has to work, because it is the one lever left if
  // some room does fool it.
  const g = gate({ attackFrames: 3 })
  assert.equal(feed(g, 0.9, 2).opened, 0, 'opened before the attack was satisfied')
  assert.equal(feed(g, 0.9, 1).opened, 1, 'never opened once it was')
  ok('a raised attack requires that many consecutive frames')
}

{
  // Consecutive, not cumulative. If the run resets only on opening, a single
  // stray frame every so often eventually opens the gate on its own, and the
  // attack merely delays what it was supposed to prevent.
  const g = gate({ attackFrames: 3 })
  for (let i = 0; i < 20; i++) {
    feed(g, 0.9, 2)
    feed(g, 0.01, 2)
  }
  assert.equal(g.stats().attacks, 0, 'stray frames accumulated into an opening')
  assert.ok(g.stats().rejected > 0, 'rejected runs are not being counted')
  ok('the attack counts consecutive frames, so stray frames never add up to one')
}

// --- a model that is not there -----------------------------------------------
{
  // Before the model loads, and if it fails, the caller has no probability. It
  // must read as silence: a gate stuck shut is visible and recoverable, and
  // `useCapture` falls back to streaming ungated. A gate stuck OPEN would
  // stream the entire kelabo and bill for it, and look like it was working.
  const g = gate()
  for (const bad of [undefined, null, NaN, 'yes']) {
    const r = g.push(bad, 'x')
    assert.equal(r.send.length, 0, `a ${String(bad)} probability opened the gate`)
  }
  assert.equal(g.level().open, false)
  ok('a missing or malformed probability reads as silence, never as speech')
}

// --- pinning -----------------------------------------------------------------
{
  const g = gate()
  assert.equal(g.level().manualThreshold, null, 'automatic by default')
  g.setThreshold(0.9)
  g.push(0.6, 'x')
  assert.equal(g.level().threshold, 0.9, 'the pin must override the default')
  assert.equal(g.level().open, false, 'a frame under the pin must not open the gate')
  g.push(0.95, 'x')
  assert.equal(g.level().open, true)
  g.push(0.95, 'x')
  assert.ok(g.level().threshold < 0.9, 'hysteresis must survive a pin')
  g.setThreshold(null)
  assert.equal(g.level().manualThreshold, null, 'and it can be handed back')
  ok('a pinned threshold overrides the default and keeps its hysteresis')
}

{
  // Out-of-range pins are clamped rather than obeyed. A probability above 1
  // can never be reached, so the gate would never open again and nothing would
  // say why.
  const g = gate()
  g.setThreshold(5)
  assert.equal(g.level().manualThreshold, 1)
  g.setThreshold(-2)
  assert.equal(g.level().manualThreshold, 0)
  ok('a pin outside 0..1 is clamped, so the gate can never be made unopenable')
}

// --- what the room is shown --------------------------------------------------
{
  const g = gate()
  feed(g, 0.9, 10)
  feed(g, 0.01, 40)
  const s = g.stats()
  assert.equal(s.cycles, 1, 'one utterance should be one cycle')
  assert.ok(s.skipped > 0 && s.skipped < 1, `skipped ratio is nonsense: ${s.skipped}`)
  assert.ok(s.meanOpenMs > 0, 'meanOpenMs must be derivable')
  assert.ok(s.sentMs < s.seenMs, 'the gate sent everything it saw')
  for (const k of ['framesSent', 'framesSeen', 'openFrames', 'shutFrames', 'attacks', 'rejected']) {
    assert.ok(k in s, `stats().${k} is read by the debug panel and must exist`)
  }
  ok('the stats describe one utterance as one cycle, with audio actually skipped')
}

{
  // A live meter has to explain a decision that has already been taken, so
  // every input to that decision has to be readable.
  const g = gate()
  g.push(0.77, 'x')
  const l = g.level()
  assert.equal(l.p, 0.77)
  assert.equal(l.margin, 0.77 - l.threshold)
  for (const k of ['p', 'threshold', 'manualThreshold', 'margin', 'open', 'hot', 'quietFrames', 'hangoverFrames', 'frameMs']) {
    assert.ok(k in l, `level().${k} is drawn by the meter and must exist`)
  }
  ok('the meter can read every number the gate decided on')
}

// --- couplings that live outside this file -----------------------------------
{
  // THE REASON THE HANGOVER EXISTS, stated as a number.
  //
  // The gate goes on streaming audio after speech stops so the provider can
  // hear the silence, decide the speaker has finished, and finalise the guess
  // it was still holding. Soniox will wait at most `max_endpoint_delay_ms`
  // before forcing that decision — so if the audio stops first, the wait
  // expires against nothing and the tail of the utterance is never revised.
  //
  // This is the single most expensive constant in the capture path (every
  // utterance is billed for it) and the one whose failure is least visible:
  // shortening it does not break anything, it just quietly makes the last few
  // words of every sentence worse.
  assert.ok(
    VAD_DEFAULTS.hangoverMs > MAX_ENDPOINT_DELAY_MS,
    `the gate stops sending after ${VAD_DEFAULTS.hangoverMs}ms but the provider ` +
      `waits up to ${MAX_ENDPOINT_DELAY_MS}ms for silence before finalising`,
  )
  ok('the gate streams silence for longer than the provider waits to endpoint')
}

{
  // And the stream is ended only after that audio has been sent, not during it.
  assert.ok(
    POOL_DEFAULTS.silenceMs > 0,
    'the billed stream must outlast the last frame the gate hands over',
  )
  ok('the billed stream is ended after the trailing audio, never during it')
}

{
  // The gate must not be given a vote on message boundaries; that belongs to
  // the composer (docs 13). What it may do is close, and closing must not be
  // mistaken for a seal - so the only thing `closed` reports is that audio
  // stopped flowing.
  const g = gate()
  feed(g, 0.9, 3)
  const r = feed(g, 0.01, 40)
  assert.equal(r.closed, 1)
  assert.equal(r.sent.length > 0, true, 'the hangover must still have sent audio')
  ok('closing reports only that audio stopped, never that a message ended')
}

console.log(`\n${passed} gate tests passed`)
