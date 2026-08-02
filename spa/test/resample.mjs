// The capture rate -> 16kHz conversion, and the chunking into model frames.
//
// Both are pure, and both fail silently in production: a wrong ratio makes
// speech detection quietly worse, and a chunker that loses its remainder drops
// audio nobody can hear going missing. Which is why they are tested here rather
// than found in a live kelabo.

import assert from 'node:assert'
import {
  createResampler,
  createChunker,
  FRAME_SAMPLES,
  SAMPLE_RATE,
} from '../src/capture/resample.js'

let passed = 0
const ok = m => {
  passed++
  console.log('ok:', m)
}

// --- the rate conversion is actually a rate conversion -----------------------
{
  // The property that matters is not sample-by-sample fidelity, it is that a
  // second of input becomes a second of output. Get this wrong and every
  // formant moves; the model then sees a voice that does not exist.
  for (const inputRate of [48000, 44100, 32000, 16000]) {
    const r = createResampler({ inputRate })
    let produced = 0
    // Ten seconds, in the 4096-sample buffers the capture pipeline delivers.
    const buffers = Math.round((inputRate * 10) / 4096)
    for (let i = 0; i < buffers; i++) produced += r.push(new Float32Array(4096)).length
    const expected = ((buffers * 4096) / inputRate) * SAMPLE_RATE
    // Within one frame over ten seconds.
    assert.ok(
      Math.abs(produced - expected) < FRAME_SAMPLES,
      `${inputRate}Hz: produced ${produced}, expected ~${Math.round(expected)}`,
    )
  }
  ok('a second of audio in is a second of audio out, at every capture rate')
}

{
  // 44100 is the case that catches a resampler written for 48000. The ratio is
  // 2.75625 - not an integer, not even rational with a small denominator - so
  // an implementation that rounds anywhere accumulates drift instead of
  // carrying the remainder.
  const r = createResampler({ inputRate: 44100 })
  let produced = 0
  for (let i = 0; i < 1000; i++) produced += r.push(new Float32Array(4096)).length
  const expected = ((1000 * 4096) / 44100) * 16000
  const driftMs = ((produced - expected) / 16000) * 1000
  assert.ok(Math.abs(driftMs) < 1, `44.1kHz drifted ${driftMs.toFixed(1)}ms over 93 seconds`)
  ok('44.1kHz does not drift: the fractional remainder is carried, not rounded')
}

// --- it is a filter, not a decimator -----------------------------------------
{
  // Plain decimation (take every third sample) aliases everything above 8kHz
  // back down into the speech band. A 15kHz tone would come back as 1kHz -
  // right in the middle of the formants the model reads. The box filter has to
  // attenuate it instead.
  const inputRate = 48000
  const tone = f => {
    const a = new Float32Array(48000)
    for (let i = 0; i < a.length; i++) a[i] = Math.sin((2 * Math.PI * f * i) / inputRate)
    return a
  }
  const rms = a => Math.sqrt(a.reduce((s, v) => s + v * v, 0) / a.length)

  const low = createResampler({ inputRate }).push(tone(500))
  const high = createResampler({ inputRate }).push(tone(15000))

  assert.ok(rms(low) > 0.5, `500Hz should pass, got rms ${rms(low).toFixed(3)}`)
  assert.ok(
    rms(high) < 0.1,
    `15kHz should be attenuated, not aliased down into speech: rms ${rms(high).toFixed(3)}`,
  )
  ok('content above the new Nyquist is attenuated rather than aliased into speech')
}

{
  // Silence in, silence out - and specifically not NaN. The window weighting
  // divides by a total weight, and a zero-width window at a buffer edge would
  // make that a division by zero, which propagates NaN through the model and
  // comes back as a probability that fails every comparison silently.
  const r = createResampler({ inputRate: 44100 })
  for (let i = 0; i < 50; i++) {
    for (const v of r.push(new Float32Array(4096))) {
      assert.ok(Number.isFinite(v), 'resampler produced a non-finite sample')
    }
  }
  ok('never produces NaN, whatever the buffer boundaries land on')
}

{
  // A constant signal must survive at its own amplitude. An averaging filter
  // that mishandles partial-sample weights shows up here as a value that is
  // close to, but not, the input.
  const r = createResampler({ inputRate: 44100 })
  const dc = new Float32Array(4096).fill(0.5)
  r.push(dc)
  const out = r.push(dc)
  for (const v of out) assert.ok(Math.abs(v - 0.5) < 1e-6, `DC gain is wrong: ${v}`)
  ok('unity gain: a constant comes through unchanged')
}

// --- chunking ----------------------------------------------------------------
{
  // The model rejects any frame that is not exactly 512 samples, so the chunker
  // must never emit a short one - not on the first call, not on the last.
  const c = createChunker({ frameSamples: FRAME_SAMPLES })
  let total = 0
  for (let i = 0; i < 100; i++) {
    // 1365 is what 4096 samples at 48kHz becomes: not a multiple of 512, which
    // is the whole difficulty.
    for (const f of c.push(new Float32Array(1365))) {
      assert.equal(f.length, FRAME_SAMPLES, 'emitted a frame the model would reject')
      total++
    }
  }
  assert.equal(total, Math.floor((100 * 1365) / FRAME_SAMPLES), 'frames were lost')
  assert.ok(c.pending() < FRAME_SAMPLES)
  ok('every emitted frame is exactly the model frame size, and none are lost')
}

{
  // Sample order has to survive the boundary. A chunker that reuses its buffer
  // wrongly produces frames that are individually well-formed and collectively
  // scrambled, which the model reads as noise.
  const c = createChunker({ frameSamples: 4 })
  const got = []
  const fed = []
  // Deliberately not a multiple of the frame size, so every call leaves a
  // remainder that the next one has to pick up in the right place.
  let v = 0
  for (let call = 0; call < 20; call++) {
    const input = Float32Array.from({ length: 6 }, () => v++)
    fed.push(...input)
    for (const f of c.push(input)) got.push(...f)
  }
  // Whole frames only, so the output is the input minus whatever is still held.
  assert.deepEqual(got, fed.slice(0, got.length), 'samples came out reordered or duplicated')
  assert.equal(got.length + c.pending(), fed.length, 'samples were lost or invented')
  ok('the remainder is carried in order across calls, losing and inventing nothing')
}

{
  // Frames must be copies. They go onto an async inference queue that can still
  // hold one when the next audio callback lands; a view over a reused buffer
  // would have its contents change after it was handed over.
  const c = createChunker({ frameSamples: 4 })
  const src = Float32Array.from([1, 2, 3, 4])
  const [frame] = c.push(src)
  src[0] = 99
  assert.equal(frame[0], 1, 'the chunker handed out a view, not a copy')
  ok('frames are copies, so a queued frame cannot change underneath the model')
}

// --- the two together, at the real rates -------------------------------------
{
  // What the capture pipeline actually does, end to end.
  for (const inputRate of [48000, 44100]) {
    const r = createResampler({ inputRate })
    const c = createChunker({ frameSamples: FRAME_SAMPLES })
    let frames = 0
    const buffers = Math.round((inputRate * 30) / 4096)
    for (let i = 0; i < buffers; i++) frames += c.push(r.push(new Float32Array(4096))).length
    // 30 seconds at 32ms a frame.
    assert.ok(
      Math.abs(frames - 30_000 / 32) < 2,
      `${inputRate}Hz produced ${frames} frames for 30s, expected ~937`,
    )
  }
  ok('30 seconds of capture becomes 30 seconds of model frames, at 48k and 44.1k')
}

console.log(`\n${passed} resample tests passed`)
