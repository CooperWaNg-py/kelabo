// The speech gate and its feedback loop, under plain node.
//
// `hangoverMs` is the most consequential number in the capture pipeline: it
// decides where a message ends, whether the tail of a sentence survives, and —
// on a provider billed by stream duration — how much of every utterance is paid
// for after the speaker stopped. The right value belongs to the ROOM, so it is
// measured rather than configured, and a control loop that adjusts it while a
// kelabo runs is exactly the kind of thing that cannot be checked by using it:
// a loop that never fires and a loop that fires correctly look identical from
// the room, and a loop that fires WRONGLY looks like the transcript getting
// gradually worse for reasons nobody can attribute.
import assert from 'node:assert/strict'
import { VAD_DEFAULTS, createSpeechGate } from '../src/capture/vad.js'
import { TUNER_DEFAULTS, createGateTuner } from '../src/capture/gateTuner.js'

let passed = 0
const ok = msg => {
  passed += 1
  console.log('ok:', msg)
}

const FRAME_MS = (4096 / 48000) * 1000

// Cumulative counters, the way the gate reports them.
const counters = (c = {}) => ({
  cycles: 0, openFrames: 0, shutFrames: 0, framesSent: 0, framesSeen: 0, ...c,
})
// A window of `seconds` in which `cycles` utterances happened, each open for
// `openMs`, with `sentRatio` of the audio passed through.
function after(prev, { seconds, cycles, openMs, sentRatio }) {
  const frames = Math.round((seconds * 1000) / FRAME_MS)
  const openFrames = Math.round((cycles * openMs) / FRAME_MS)
  return counters({
    cycles: prev.cycles + cycles,
    openFrames: prev.openFrames + openFrames,
    shutFrames: prev.shutFrames + Math.max(0, frames - openFrames),
    framesSent: prev.framesSent + Math.round(frames * sentRatio),
    framesSeen: prev.framesSeen + frames,
  })
}

// --- the loop decides nothing on thin evidence -------------------------------
{
  const tuner = createGateTuner({ hangoverMs: 900, frameMs: FRAME_MS })
  // The first sample only establishes a baseline — there is no window yet.
  assert.equal(tuner.sample(counters()), null)
  // Five seconds of chopping is still not evidence: two people exchanging a few
  // words produce wild ratios, and retuning on those settles on nothing.
  const thin = after(counters(), { seconds: 5, cycles: 4, openMs: 400, sentRatio: 0.3 })
  assert.equal(tuner.sample(thin), null, 'below the minimum window, nothing is decided')
  assert.equal(tuner.hangoverMs, 900)
  ok('no correction is made on less audio than the minimum window')
}

// --- chopping ---------------------------------------------------------------
{
  // The signature of a gate closing INSIDE sentences: utterances arriving far
  // faster than anyone delivers separate thoughts, each of them short.
  const tuner = createGateTuner({ hangoverMs: 900, frameMs: FRAME_MS })
  let c = counters()
  tuner.sample(c)
  c = after(c, { seconds: 30, cycles: 13, openMs: 1300, sentRatio: 0.75 })
  const change = tuner.sample(c)
  assert.ok(change, 'a chopping room must be corrected')
  assert.equal(change.reason, 'chopping')
  assert.equal(change.kind, 'hangoverMs')
  assert.ok(change.value > change.from, 'hold the gate open longer')
  assert.equal(tuner.hangoverMs, change.value)
  ok('a gate closing inside sentences raises the hangover')
}

{
  // Convergence: repeated chopping keeps raising it, but never past the ceiling
  // — beyond which the billing tail and the delay before a message seals both
  // stop being acceptable, however badly the room behaves.
  const tuner = createGateTuner({ hangoverMs: 900, frameMs: FRAME_MS })
  let c = counters()
  tuner.sample(c)
  for (let i = 0; i < 40; i++) {
    c = after(c, { seconds: 30, cycles: 13, openMs: 1300, sentRatio: 0.75 })
    tuner.sample(c)
  }
  assert.equal(tuner.hangoverMs, TUNER_DEFAULTS.maxHangoverMs)
  ok('corrections stop at the ceiling, however persistent the signal')
}

// --- latched open -----------------------------------------------------------
{
  // Room tone sitting above the threshold: nearly nothing is skipped and the
  // gate hardly ever closes. The transcript then never seals on silence, and on
  // a per-second provider the meter never stops.
  const tuner = createGateTuner({ hangoverMs: 900, frameMs: FRAME_MS })
  let c = counters()
  tuner.sample(c)
  c = after(c, { seconds: 60, cycles: 1, openMs: 55_000, sentRatio: 0.99 })
  const change = tuner.sample(c)
  assert.ok(change, 'a latched gate must be corrected')
  assert.equal(change.reason, 'latched-open')
  assert.equal(change.kind, 'hangoverMs')
  assert.ok(change.value < change.from, 'let it shut again')
  ok('a gate that never closes lowers the hangover')
}

{
  const tuner = createGateTuner({ hangoverMs: 900, frameMs: FRAME_MS })
  let c = counters()
  tuner.sample(c)
  for (let i = 0; i < 40; i++) {
    c = after(c, { seconds: 60, cycles: 1, openMs: 55_000, sentRatio: 0.99 })
    tuner.sample(c)
  }
  // The floor is the shortest pause a speaker takes mid-sentence without
  // meaning to have stopped. Below it the gate chops however well it is tuned.
  assert.equal(tuner.hangoverMs, TUNER_DEFAULTS.minHangoverMs)
  ok('corrections stop at the floor, so the gate can never chop by construction')
}


// --- a click must not open the gate ------------------------------------------
{
  // THE REPORTED BUG. One frame is 85ms of RMS, so a single mouse click, a key
  // press or a knock on the desk lifts that frame over the threshold. Without
  // an attack requirement the gate opened on it and stayed open for the whole
  // hangover — starting an utterance, and on a per-second provider starting the
  // meter, because somebody clicked.
  const gate = createSpeechGate({ sampleRate: 48000, frameSamples: 4096, attackFrames: 2 })
  const quiet = new Float32Array(4096).fill(0.0004)
  const click = new Float32Array(4096)
  // A transient: loud, and over almost immediately.
  for (let i = 0; i < 60; i++) click[i] = 0.7

  for (let i = 0; i < 40; i++) gate.push(quiet, 'x') // settle the floor
  let opened = false
  for (let i = 0; i < 12; i++) {
    if (gate.push(click, 'x').opened) opened = true
    for (let j = 0; j < 8; j++) if (gate.push(quiet, 'x').opened) opened = true
  }
  assert.equal(opened, false, 'a lone transient must never open the gate')
  assert.ok(gate.stats().rejected > 0, 'and it should be counted as rejected')
  ok('an isolated click is rejected instead of starting an utterance')
}

{
  // ...while speech, which sustains, still opens it — one frame later than
  // before, which the pre-roll ring more than covers.
  const gate = createSpeechGate({ sampleRate: 48000, frameSamples: 4096, attackFrames: 2 })
  const quiet = new Float32Array(4096).fill(0.0004)
  const speech = new Float32Array(4096)
  for (let i = 0; i < 4096; i++) speech[i] = Math.sin(i / 7) * 0.25

  for (let i = 0; i < 40; i++) gate.push(quiet, 'x')
  let openedAt = -1
  for (let i = 0; i < 6; i++) {
    if (gate.push(speech, 'x').opened) { openedAt = i; break }
  }
  assert.equal(openedAt, 1, 'opens on the second sustained frame, not the tenth')
  ok('sustained speech still opens the gate, one frame later')
}

{
  // The count is CONSECUTIVE, not cumulative. If a stray frame never reset it,
  // a click a minute would eventually open the gate on its own and the attack
  // would be delaying the bug rather than fixing it.
  const gate = createSpeechGate({ sampleRate: 48000, frameSamples: 4096, attackFrames: 3 })
  const quiet = new Float32Array(4096).fill(0.0004)
  const click = new Float32Array(4096)
  for (let i = 0; i < 60; i++) click[i] = 0.7

  for (let i = 0; i < 40; i++) gate.push(quiet, 'x')
  let opened = false
  for (let i = 0; i < 30; i++) {
    if (gate.push(click, 'x').opened) opened = true
    for (let j = 0; j < 5; j++) if (gate.push(quiet, 'x').opened) opened = true
  }
  assert.equal(opened, false, 'isolated frames must never accumulate into an open')
  ok('the attack counter is consecutive, so scattered clicks never add up')
}

// --- the tuner tells transients from chopping --------------------------------
{
  // Both look like "too many cycles". They want OPPOSITE corrections, and
  // getting it backwards is actively harmful: lengthening the hangover in a
  // clicky room holds the gate — and the meter — open longer on every false
  // trigger.
  const tuner = createGateTuner({ hangoverMs: 900, attackFrames: 2, frameMs: FRAME_MS })
  let c = counters()
  tuner.sample(c)
  // Opened, sustained nothing, shut the moment the hangover expired — and the
  // room was silent throughout.
  c = after(c, { seconds: 60, cycles: 14, openMs: 1000, sentRatio: 0.02 })
  const change = tuner.sample(c)
  assert.ok(change, 'a clicky room must be corrected')
  assert.equal(change.reason, 'transient-triggering')
  assert.equal(change.kind, 'attackFrames', 'make it harder to trip, not longer to hold')
  assert.equal(change.value, 3)
  assert.equal(tuner.hangoverMs, 900, 'the hangover must not move')
  ok('a room full of clicks raises the attack, never the hangover')
}

{
  // At the ceiling it stops, and deliberately does NOT fall through to the
  // chopping rule — the answer to a room that is still clicking is not to start
  // lengthening the hangover instead.
  const tuner = createGateTuner({ hangoverMs: 900, attackFrames: 2, frameMs: FRAME_MS })
  let c = counters()
  tuner.sample(c)
  for (let i = 0; i < 20; i++) {
    c = after(c, { seconds: 60, cycles: 14, openMs: 1000, sentRatio: 0.02 })
    tuner.sample(c)
  }
  assert.equal(tuner.attackFrames, TUNER_DEFAULTS.maxAttackFrames)
  assert.equal(tuner.hangoverMs, 900, 'never falls through to the wrong correction')
  ok('attack corrections stop at the ceiling without changing the hangover')
}

// --- a healthy room is left alone -------------------------------------------
{
  // THE MOST IMPORTANT CASE. A loop that fiddles with a room that is working is
  // strictly worse than no loop: the transcript changes shape for no reason and
  // nobody can attribute it.
  const tuner = createGateTuner({ hangoverMs: 900, frameMs: FRAME_MS })
  let c = counters()
  tuner.sample(c)
  for (let i = 0; i < 10; i++) {
    // Six utterances a minute, four seconds each, two thirds of the audio
    // skipped: an ordinary person talking in an ordinary room.
    c = after(c, { seconds: 60, cycles: 6, openMs: 4000, sentRatio: 0.35 })
    assert.equal(tuner.sample(c), null, 'a healthy room must not be touched')
  }
  assert.equal(tuner.hangoverMs, 900)
  ok('a room that is already working is never adjusted')
}

// --- windowed, not cumulative -----------------------------------------------
{
  // The gate's counters run from the moment it was built. Feeding those to a
  // controller means that after ten minutes a single bad minute cannot move the
  // average, and the loop stops responding exactly as the room fills up.
  const tuner = createGateTuner({ hangoverMs: 900, frameMs: FRAME_MS })
  let c = counters()
  tuner.sample(c)
  // A long, healthy stretch first.
  for (let i = 0; i < 10; i++) {
    c = after(c, { seconds: 60, cycles: 6, openMs: 4000, sentRatio: 0.35 })
    tuner.sample(c)
  }
  assert.equal(tuner.hangoverMs, 900, 'still untouched after ten good minutes')
  // Now the room turns bad. A cumulative controller would barely notice.
  c = after(c, { seconds: 30, cycles: 13, openMs: 1300, sentRatio: 0.75 })
  const change = tuner.sample(c)
  assert.ok(change && change.reason === 'chopping', 'the recent window is what counts')
  ok('decisions follow the recent window, not the whole kelabo')
}

{
  // The gate is rebuilt on every new stream and whenever the microphone is
  // re-acquired, which sends the counters backwards. Reading that as a signal
  // would produce a correction out of nowhere.
  const tuner = createGateTuner({ hangoverMs: 900, frameMs: FRAME_MS })
  let c = after(counters(), { seconds: 120, cycles: 20, openMs: 3000, sentRatio: 0.4 })
  tuner.sample(c)
  const fresh = counters()
  assert.equal(tuner.sample(fresh), null, 'a rebuilt gate re-baselines instead of deciding')
  assert.equal(tuner.hangoverMs, 900)
  ok('a gate rebuilt mid-kelabo re-baselines rather than reading it as a change')
}

// --- the gate accepts the correction ----------------------------------------
{
  // The loop is worthless if the gate cannot actually be retuned while running.
  const gate = createSpeechGate({ sampleRate: 48000, frameSamples: 4096, hangoverMs: 900 })
  assert.equal(gate.hangoverMs(), 900)
  gate.setHangoverMs(1200)
  assert.equal(gate.hangoverMs(), 1200)

  // And it takes effect: with a long hangover the gate is still open well after
  // the level drops, where a short one has already shut.
  const loud = new Float32Array(4096).fill(0.3)
  const quiet = new Float32Array(4096).fill(0.00001)
  const runQuietFrames = hangoverMs => {
    const g = createSpeechGate({ sampleRate: 48000, frameSamples: 4096, hangoverMs })
    for (let i = 0; i < 20; i++) g.push(loud, 'x')
    let frames = 0
    while (frames < 200) {
      frames += 1
      if (g.push(quiet, 'x').closed) return frames
    }
    return frames
  }
  const short = runQuietFrames(500)
  const long = runQuietFrames(1500)
  assert.ok(long > short, `a longer hangover must hold longer (${long} vs ${short} frames)`)
  ok('the gate can be retuned while running, and the change takes effect')
}

// --- a pinned threshold ------------------------------------------------------
{
  // The adaptive floor is right for most rooms and wrong for some in ways no
  // tracking fixes. Pinning it has to actually override the tracker, survive
  // the floor moving, and keep its hysteresis — a threshold with no gap
  // between open and close chatters the gate on any syllable sitting on it.
  const gate = createSpeechGate({ sampleRate: 48000, frameSamples: 4096 })
  const quiet = new Float32Array(4096).fill(0.0004)
  for (let i = 0; i < 40; i++) gate.push(quiet, 'x')
  assert.equal(gate.level().manualThresholdDb, null, 'adaptive by default')

  gate.setThresholdDb(-40)
  gate.push(quiet, 'x')
  assert.equal(gate.level().threshold, -40, 'the pin overrides the tracked floor')
  assert.equal(gate.level().manualThresholdDb, -40)

  // Loud enough to be over a -40 line, so the gate opens...
  const loud = new Float32Array(4096)
  for (let i = 0; i < 4096; i++) loud[i] = Math.sin(i / 7) * 0.25
  gate.push(loud, 'x')
  gate.push(loud, 'x')
  assert.equal(gate.level().open, true)
  // ...and while open the line sits LOWER, by the same margin the adaptive
  // path uses, so a wobble across the pin does not chatter it. One more frame,
  // because the reading reports the threshold the LAST frame was judged
  // against — the frame that opened the gate was judged while it was shut.
  gate.push(loud, 'x')
  assert.ok(gate.level().threshold < -40, `hysteresis when pinned, got ${gate.level().threshold}`)

  gate.setThresholdDb(null)
  gate.push(quiet, 'x')
  assert.equal(gate.level().manualThresholdDb, null, 'and it can be handed back')
  ok('a pinned threshold overrides the tracker and keeps its hysteresis')
}

{
  // A pin far below the noise floor would hold the gate open for ever; one far
  // above it would never open. Both are the participant's business — the point
  // of the control is that they can see the meter — but the gate must still
  // behave consistently at the extremes rather than doing something undefined.
  const gate = createSpeechGate({ sampleRate: 48000, frameSamples: 4096, thresholdDb: -79 })
  const quiet = new Float32Array(4096).fill(0.0004)
  let opened = false
  for (let i = 0; i < 10; i++) if (gate.push(quiet, 'x').opened) opened = true
  assert.equal(opened, true, 'a pin under the room tone opens the gate, as asked')

  const shut = createSpeechGate({ sampleRate: 48000, frameSamples: 4096, thresholdDb: -3 })
  const loud = new Float32Array(4096)
  for (let i = 0; i < 4096; i++) loud[i] = Math.sin(i / 7) * 0.25
  let everOpened = false
  for (let i = 0; i < 10; i++) if (shut.push(loud, 'x').opened) everOpened = true
  assert.equal(everOpened, false, 'a pin above the speech never opens it, as asked')
  ok('a pinned threshold is obeyed at both extremes')
}

// --- the tuner can prove it is awake -----------------------------------------
{
  // A controller whose correct behaviour is to do nothing is indistinguishable
  // from one that is not running. It reports what it measured and what it
  // concluded, so "I don't think it's running" is answerable.
  const tuner = createGateTuner({ hangoverMs: 900, attackFrames: 2, frameMs: FRAME_MS })
  assert.equal(tuner.status().windows, 0)
  assert.equal(tuner.status().lastVerdict, null, 'nothing concluded before the first window')

  let c = counters()
  tuner.sample(c)
  c = after(c, { seconds: 60, cycles: 6, openMs: 4000, sentRatio: 0.35 })
  assert.equal(tuner.sample(c), null, 'a healthy room changes nothing')

  const st = tuner.status()
  assert.equal(st.windows, 1, 'but the window was still observed and counted')
  assert.equal(st.lastVerdict.reason, 'healthy', 'and the verdict is recorded, not merely absent')
  // Whole frames, so a 60s window lands a few ms short of the literal number.
  assert.ok(st.lastWindow.seenMs >= 59_000, `window was ${st.lastWindow.seenMs}ms`)
  ok('a loop that decides nothing still reports that it looked')
}

// --- the gate and the tuner actually fit together ----------------------------
{
  // THE GAP THE UNIT TESTS ABOVE CANNOT SEE. Every tuner test builds counters
  // by hand, so all of them passed while `stats()` did not return `openFrames`
  // or `shutFrames` at all — the tuner read undefined, computed a mean open
  // time of zero, and diagnosed every room on earth as full of clicks.
  //
  // So: drive a REAL gate and hand its REAL stats to the tuner.
  const gate = createSpeechGate({ sampleRate: 48000, frameSamples: 4096 })
  for (const key of ['cycles', 'openFrames', 'shutFrames', 'framesSent', 'framesSeen']) {
    assert.ok(key in gate.stats(), `the tuner reads stats().${key} — it must exist`)
  }

  const quiet = new Float32Array(4096).fill(0.0004)
  const speech = new Float32Array(4096)
  for (let i = 0; i < 4096; i++) speech[i] = Math.sin(i / 7) * 0.25

  // Two minutes of ordinary conversation: four seconds on, four seconds off.
  const tuner = createGateTuner({ hangoverMs: 900, attackFrames: 2, frameMs: FRAME_MS })
  tuner.sample(gate.stats())
  for (let turn = 0; turn < 16; turn++) {
    for (let i = 0; i < 47; i++) gate.push(speech, 'x')
    for (let i = 0; i < 47; i++) gate.push(quiet, 'x')
  }
  const live = gate.stats()
  assert.ok(live.cycles > 0, 'the gate must actually have cycled')
  assert.ok(live.meanOpenMs > 1000, `mean open should be seconds, got ${live.meanOpenMs}ms`)

  const change = tuner.sample(live)
  assert.equal(change, null, `a normal conversation must not be retuned (got ${change?.reason})`)
  assert.equal(tuner.hangoverMs, 900)
  assert.equal(tuner.attackFrames, 2)
  ok('a real gate driven by real speech is read correctly and left alone')
}

// --- the defaults are inside the bounds --------------------------------------
{
  assert.ok(VAD_DEFAULTS.hangoverMs >= TUNER_DEFAULTS.minHangoverMs)
  assert.ok(VAD_DEFAULTS.hangoverMs <= TUNER_DEFAULTS.maxHangoverMs)
  ok('the starting hangover is inside the range the loop may move it through')
}

console.log(`\n${passed} gate tests passed`)
