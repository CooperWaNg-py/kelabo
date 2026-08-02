// Silero VAD: the speech detector behind the capture gate.
//
// This module answers exactly one question — "is the voice in this 32ms of
// audio a human speaking?" — and answers it with a model rather than a
// loudness threshold. It decides nothing about what to send; that is
// `vad.js`, which is pure and takes the probability this produces.
//
// The split matters. What is here needs a WebAssembly runtime and 13MB of
// binaries, so it can only be exercised in a live kelabo. What is in `vad.js`
// — threshold, attack, hangover, pre-roll — is where the bugs that cost words
// live, so it stays pure and testable. Same reason `rtc/reconcile.js` is
// separate from the transports.
//
// The model is Silero VAD v6.2.1, vendored at silero_vad.onnx (MIT). Pinned to
// a tagged release deliberately: the file on the project's master branch is a
// different model with the same name, size and tensor signature, and it scores
// real speech at 0.002 through this exact code path.
//
// Measured against it (steady state, one thread, a laptop CPU):
//   inference        0.45ms p50, 0.60ms p95, per 32ms frame
//   loud 440Hz tone  p = 0.0008
//   loud white noise p = 0.0020
//   33s real speech  61.4% of frames over 0.5, median confidence 0.997
//   the same + noise 59.2%, median 0.982
// The tone and the noise are the point. Both sit around -13dBFS, far above any
// noise floor, and an energy gate opens on both.

// The URL, not the bytes: Vite emits each as a hashed file in `assets/` and
// inlines only the string here, so importing this module does not pull 13MB
// into the bundle. The fetch happens in `load()`.
import modelUrl from './silero_vad.onnx?url'
// Aliased in vite.config.js — onnxruntime-web's exports map has no path to its
// own binaries, and the alias derives them from the installed package. Both are
// needed: the runtime resolves the loader module and the binary separately.
import wasmUrl from '@kelabo/ort-wasm?url'
import wasmMjsUrl from '@kelabo/ort-wasm-mjs?url'
// The frame contract lives on the pure side so tests can reach it; see there.
import {
  FRAME_SAMPLES,
  SAMPLE_RATE,
  FRAME_MS,
  CONTEXT_SAMPLES,
  MODEL_INPUT_SAMPLES,
} from './resample.js'

// Frames kept waiting for inference. At 0.45ms a frame against 32ms of arrival
// there is normally nothing here at all; the bound exists for a main thread
// stalled by something else. Dropping the oldest is right because a VAD is only
// ever asked about the present — an old frame answered late is worse than no
// answer, since the gate would act on it as if it were now.
const MAX_QUEUE = 16

/**
 * @returns a detector. `push` is fire-and-forget; `take` reports what the model
 *   has concluded since the last call.
 */
export function createSileroVad({
  modelPath = modelUrl,
  wasmPath = wasmUrl,
  wasmMjsPath = wasmMjsUrl,
} = {}) {
  /** @type {'idle'|'loading'|'ready'|'failed'} */
  let status = 'idle'
  let error = null
  let ort = null
  let session = null
  let sr = null
  let state = null
  let loading = null

  const queue = []
  // The tail of the previous hop, fed again ahead of the current one. Model
  // state in every sense that matters: it must be threaded in order and reset
  // with everything else.
  let context = new Float32Array(CONTEXT_SAMPLES)
  let pumping = false
  // The last probability the model produced, and the highest since `take`.
  // Both, because the gate wants the peak over its own longer frame while a
  // meter wants the instantaneous value.
  let last = 0
  let peak = -1
  let frames = 0
  let dropped = 0
  // A ring of recent inference times. Kept because the decision to move this
  // to a Worker should be made from a number measured on the machine it is
  // slow on, not from a benchmark on a fast one.
  const times = []

  function freshState() {
    // [2, batch, 128] — the LSTM's hidden and cell state, threaded from one
    // frame to the next. It is why frames must be fed strictly in order.
    return new ort.Tensor('float32', new Float32Array(2 * 128), [2, 1, 128])
  }

  async function pump() {
    if (pumping || !session) return
    pumping = true
    try {
      while (queue.length) {
        const frame = queue.shift()
        // 64 samples of the previous hop, then 512 new ones.
        const input = new Float32Array(MODEL_INPUT_SAMPLES)
        input.set(context, 0)
        input.set(frame, CONTEXT_SAMPLES)
        const t0 = performance.now()
        const out = await session.run({
          input: new ort.Tensor('float32', input, [1, MODEL_INPUT_SAMPLES]),
          state,
          sr,
        })
        context = frame.slice(FRAME_SAMPLES - CONTEXT_SAMPLES)
        // Thread the state forward. Skipping this does not error — it silently
        // turns a sequence model into a per-frame one, which still returns
        // plausible probabilities and detects speech noticeably worse.
        state = out.stateN
        const p = out.output.data[0]
        last = p
        if (p > peak) peak = p
        frames += 1
        times.push(performance.now() - t0)
        if (times.length > 200) times.shift()
      }
    } catch (e) {
      // A failure here is not recoverable frame by frame: the state is now of
      // unknown vintage. Fail the detector so the caller falls back to
      // streaming ungated rather than gating on a number that means nothing.
      status = 'failed'
      error = e
      session = null
    } finally {
      pumping = false
    }
  }

  return {
    frameSamples: FRAME_SAMPLES,
    sampleRate: SAMPLE_RATE,
    frameMs: FRAME_MS,

    /**
     * Fetch the runtime and the model. Idempotent and safe to call early —
     * the point is that it is already done before anyone speaks.
     */
    load() {
      if (loading) return loading
      status = 'loading'
      loading = (async () => {
        // `onnxruntime-web/wasm` rather than the default entry: the default
        // carries WebGL and WebGPU backends we will never reach for, and the
        // whole reason this is a dynamic import is to keep the weight off the
        // page until capture starts.
        ort = await import('onnxruntime-web/wasm')
        // One thread deliberately. Multi-threaded wasm needs SharedArrayBuffer,
        // which needs COOP/COEP on the document, which would break every
        // cross-origin subresource the room loads. At 0.45ms a frame there is
        // nothing to win.
        ort.env.wasm.numThreads = 1
        // Both, explicitly. `wasmPaths` is read key by key, and a missing `mjs`
        // is not inherited from `wasm` — it falls back to a conventional
        // filename next to the loading script, which under content-hashed
        // assets is a 403 and surfaces only in the network tab.
        ort.env.wasm.wasmPaths = { wasm: wasmPath, mjs: wasmMjsPath }
        // Otherwise a rejected frame prints four lines of C++ stack per
        // occurrence to the user's console.
        ort.env.logLevel = 'fatal'

        const res = await fetch(modelPath)
        if (!res.ok) throw new Error(`silero: model fetch ${res.status}`)
        const bytes = new Uint8Array(await res.arrayBuffer())
        session = await ort.InferenceSession.create(bytes)
        sr = new ort.Tensor('int64', [BigInt(SAMPLE_RATE)])
        state = freshState()

        // Warm up on silence. The first inference costs ~30ms against 0.45ms
        // for every one after it, and paying that on the first frame of real
        // speech is paying it exactly where it is most visible.
        await session.run({
          input: new ort.Tensor('float32', new Float32Array(MODEL_INPUT_SAMPLES), [
            1,
            MODEL_INPUT_SAMPLES,
          ]),
          state,
          sr,
        })
        status = 'ready'
      })().catch(e => {
        status = 'failed'
        error = e
        // Swallowed on purpose: a model that will not load must degrade to
        // ungated capture, not break the kelabo. `status()` is how it is seen.
      })
      return loading
    },

    /** Queue one 512-sample frame at 16kHz. Never throws, never blocks. */
    push(frame) {
      if (status !== 'ready') return
      if (queue.length >= MAX_QUEUE) {
        queue.shift()
        dropped += 1
      }
      queue.push(frame)
      pump()
    },

    /**
     * The highest probability the model has produced since the last call, or
     * the most recent one if it has produced none. The peak, because the
     * caller's frame is longer than the model's: over 85ms of audio, "did
     * speech start anywhere in here" is the question, and an average would let
     * a quiet lead-in cancel out the syllable that follows it.
     */
    take() {
      const p = peak < 0 ? last : peak
      peak = -1
      return p
    },

    /** Instantaneous, for a meter. Does not consume the peak. */
    probability: () => last,

    ready: () => status === 'ready',

    /**
     * Drop the model's memory of what came before. Called when a provider
     * stream restarts, for the same reason the gate's pre-roll ring is
     * cleared: the audio either side of the gap is not continuous, and an LSTM
     * carried across it is reasoning about a moment that never happened.
     */
    reset() {
      queue.length = 0
      peak = -1
      last = 0
      context = new Float32Array(CONTEXT_SAMPLES)
      if (ort && session) state = freshState()
    },

    status() {
      const sorted = [...times].sort((a, b) => a - b)
      return {
        state: status,
        error: error ? String(error.message || error) : null,
        frames,
        dropped,
        queued: queue.length,
        meanMs: times.length ? +(times.reduce((a, b) => a + b, 0) / times.length).toFixed(2) : 0,
        p95Ms: sorted.length ? +sorted[Math.floor(sorted.length * 0.95)].toFixed(2) : 0,
      }
    },
  }
}
