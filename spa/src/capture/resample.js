// Native capture rate -> 16kHz, in exactly the frame size the model demands.
//
// Two conversions, deliberately in one place and deliberately pure.
//
// The AudioContext runs at whatever the hardware gives — 48000 on most
// desktops, 44100 on plenty of machines, occasionally 32000 or 16000. Silero is
// exported for 16kHz and rejects any frame that is not 512 samples outright, so
// "close enough" does not exist here: the rate has to be right and the frames
// have to be exact.
//
// Pure because both failures are silent. A ratio that is slightly wrong does
// not throw, it shifts every formant and hands the model audio of a person who
// does not exist — speech detection simply gets worse, in a way indistinguishable
// from a bad microphone. And a chunker that loses the remainder between callbacks
// drops ~1.3ms of every 85ms on the floor, which is inaudible, untraceable, and
// exactly the kind of thing that is only ever found by a test.

// The model's contract, stated on the pure side of the boundary.
//
// These are facts about Silero and they belong with it — but `silero.js`
// imports the runtime and the model as bundler URLs, so plain node cannot load
// it, and anything that needs these numbers in a test could not have them.
// They live here, in the module whose entire job is producing frames that
// satisfy them, and `silero.js` imports them back.
export const SAMPLE_RATE = 16000
// The hop: how much NEW audio each inference advances by. Not a default and not
// a preference — the model throws inside its LSTM on most other lengths
// (verified: 768 is rejected outright).
export const FRAME_SAMPLES = 512
export const FRAME_MS = (FRAME_SAMPLES / SAMPLE_RATE) * 1000 // 32
// Samples of the PREVIOUS hop that are fed again ahead of the current one, so
// the model sees 576 and advances 512.
//
// This is not a refinement, it is most of the accuracy. Measured over 33s of
// real speech, feeding bare 512-sample frames the way the common browser VAD
// library does gives 54.5% of frames detected at a median confidence of 0.721;
// the same audio and the same model with the context gives 61.2% at 0.982. On
// speech mixed with loud noise the gap is wider still (0.911 vs 0.634).
//
// Getting this wrong fails LOUDLY rather than subtly, which is the one mercy
// here: without the context this model scores real speech at 0.002, so the gate
// simply never opens. If nothing is ever transcribed and the probability meter
// reads flat zero through obvious speech, suspect this first.
export const CONTEXT_SAMPLES = 64
export const MODEL_INPUT_SAMPLES = CONTEXT_SAMPLES + FRAME_SAMPLES // 576

/**
 * Decimating resampler with a box filter.
 *
 * The box filter (averaging the input samples that fall in each output sample's
 * window) is the cheap choice, and the right one here. A proper windowed-sinc
 * would preserve the band better, but its benefit is in what a *listener*
 * hears; this audio is only ever read by a model that was trained on ordinary
 * telephone-grade speech. What matters is that the average is taken over the
 * true fractional window rather than by picking every Nth sample: plain
 * decimation aliases everything above 8kHz down into the speech band, which is
 * audible as a lisp and measurable as worse detection on sibilants.
 *
 * Carries its remainder across calls, because callbacks do not divide evenly:
 * at 44100 a 4096-sample buffer is 1486.6 output samples, and the .6 belongs to
 * the next one.
 *
 * @param {{inputRate:number, outputRate?:number}} opts
 */
export function createResampler({ inputRate, outputRate = 16000 }) {
  if (!(inputRate > 0)) throw new Error(`resampler: bad inputRate ${inputRate}`)
  const ratio = inputRate / outputRate

  // Fractional position in the input stream of the next output sample, kept
  // between calls. This is the whole reason this is a factory and not a
  // function.
  let pos = 0
  // Input samples from the previous call that a pending output window still
  // reaches back into.
  let tail = new Float32Array(0)

  return {
    ratio,
    inputRate,
    outputRate,

    /**
     * @param {Float32Array} input
     * @returns {Float32Array} the output samples that became available
     */
    push(input) {
      // Everything still in play: the unconsumed tail, then the new audio.
      const buf = tail.length ? concat(tail, input) : input
      const n = Math.max(0, Math.floor((buf.length - pos) / ratio))
      const out = new Float32Array(n)

      for (let i = 0; i < n; i++) {
        const start = pos + i * ratio
        const end = start + ratio
        // Average across the window, including the partial samples at each
        // edge weighted by how much of them the window covers. Without the
        // partial weighting the filter jitters by up to one input sample per
        // output sample, which at a non-integer ratio is a periodic artefact
        // rather than noise.
        let sum = 0
        let weight = 0
        const first = Math.floor(start)
        const last = Math.min(Math.ceil(end), buf.length)
        for (let j = first; j < last; j++) {
          const w = Math.min(end, j + 1) - Math.max(start, j)
          if (w <= 0) continue
          sum += buf[j] * w
          weight += w
        }
        out[i] = weight > 0 ? sum / weight : 0
      }

      // Advance, then keep only what a future window can still reach.
      pos += n * ratio
      const keepFrom = Math.floor(pos)
      tail = buf.slice(keepFrom)
      pos -= keepFrom
      return out
    },

    reset() {
      pos = 0
      tail = new Float32Array(0)
    },
  }
}

/**
 * Cuts a stream into fixed-size frames, holding the remainder until the next
 * call completes it. Separate from the resampler because the model's frame size
 * is the model's business, not the sample rate's.
 *
 * @param {{frameSamples:number}} opts
 */
export function createChunker({ frameSamples }) {
  if (!(frameSamples > 0)) throw new Error(`chunker: bad frameSamples ${frameSamples}`)
  let pending = new Float32Array(0)

  return {
    frameSamples,

    /**
     * @param {Float32Array} input
     * @returns {Float32Array[]} whole frames only; never a short one
     */
    push(input) {
      const buf = pending.length ? concat(pending, input) : input
      const frames = []
      let off = 0
      while (buf.length - off >= frameSamples) {
        // A copy, not a subarray view: these are handed to an async inference
        // queue that may still hold one when the next callback overwrites the
        // backing buffer. A view would silently change contents underneath it.
        frames.push(buf.slice(off, off + frameSamples))
        off += frameSamples
      }
      pending = buf.slice(off)
      return frames
    },

    pending: () => pending.length,

    reset() {
      pending = new Float32Array(0)
    },
  }
}

function concat(a, b) {
  const out = new Float32Array(a.length + b.length)
  out.set(a, 0)
  out.set(b, a.length)
  return out
}
