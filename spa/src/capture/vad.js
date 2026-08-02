// The capture gate: given how likely it is that someone is speaking, decide
// what audio to send.
//
// A provider bills for the audio it receives — Deepgram by the second of audio,
// Soniox by the wall-clock life of a stream — and in a kelabo any one
// participant is silent most of the time. With one microphone per person,
// streaming continuously means paying to transcribe other people's silence.
//
// The judgement of what is speech is not made here. `silero.js` runs a model
// over the audio and produces a probability per 32ms; this module takes that
// number and decides what to do about it. The split is deliberate:
//
//   - Detection needs a WebAssembly runtime and 13MB of binaries, so it can
//     only be exercised in a live kelabo.
//   - The decisions here are where words get lost — a hangover a beat too
//     short clips the end of a sentence, an attack a frame too long eats the
//     first syllable — and they are testable, so they are pure and tested.
//
// Three things make the gate safe to put in front of an STT stream:
//   - **pre-roll** — frames from before the gate opened are kept and sent
//     first, so the word that tripped it is not clipped;
//   - **hangover** — it stays open a while after speech stops, so trailing
//     words survive and a provider's endpointer still sees the silence it
//     needs to finalise;
//   - **hysteresis** — the level that keeps it open is lower than the level
//     that opens it, so a moment of doubt mid-word does not chatter it.
//
// Cutting silence breaks the assumption that provider word timestamps track
// wall clock — they count sent audio only. `useCapture` compensates by stamping
// each burst against the wall clock (see `opened`).

export const VAD_DEFAULTS = {
  // Audio retained before speech onset. Comfortably longer than the attack
  // delay, which is what makes waiting to be sure cost nothing.
  prerollMs: 400,
  // How long the gate KEEPS SENDING AUDIO after speech stops.
  //
  // This is not politeness at the end of a sentence, it is the mechanism by
  // which the last words of an utterance become correct. A provider's
  // endpointer decides that a speaker has finished by listening to the silence
  // that follows them, and it finalises — and revises — its unconfirmed guess
  // using that audio. Cut the audio off at the last syllable and the endpointer
  // never fires from sound; the tail stays a guess, and whatever the provider
  // had at that instant is what the transcript keeps.
  //
  // So the floor is the provider's own endpoint delay: Soniox is configured
  // with `max_endpoint_delay_ms` of 1500 (rest-api/src/stt/soniox.js), which is
  // the longest it will wait before forcing an endpoint. Streaming less than
  // that guarantees the case this is meant to prevent. 2000 clears it with
  // margin and matches the two seconds of silence that ends an utterance.
  //
  // It is billed. On Soniox the stream is charged by wall clock, so every
  // utterance pays for this — which is the price of a correct ending, and is
  // why it is not larger.
  hangoverMs: 2000,
  // Consecutive frames over the threshold before the gate opens at all.
  //
  // One, now. This existed because an energy gate cannot tell a mouse click
  // from a syllable - both are simply loud - so it needed a transient to prove
  // itself over two frames before being believed. A model does not have that
  // problem: a click scores near zero because it does not sound like a voice.
  // Measured, a loud 440Hz tone reads 0.0008 and white noise 0.0020, where an
  // energy gate opens on both.
  //
  // The knob stays because the pre-roll makes it nearly free, so if a room
  // turns out to fool the model repeatedly there is somewhere to turn.
  attackFrames: 1,
  // Probability that opens the gate, and the lower one that keeps it open.
  // 0.5 is the model's own natural operating point; measured over 33s of real
  // speech, 61.4% of frames clear it at a median confidence of 0.997, so the
  // margin either side of the line is wide and the exact value is not delicate.
  openThreshold: 0.5,
  closeThreshold: 0.35,
  // A FIXED threshold, or null to use the pair above.
  //
  // Far less necessary than it was. The old gate compared loudness against a
  // noise floor it had to estimate, so it was wrong in any room whose noise sat
  // near speech level, and pinning the line by hand was the only escape. A
  // probability means the same thing in every room and on every microphone, so
  // this is now a diagnostic rather than a workaround.
  threshold: null,
}

/**
 * @param {{sampleRate?:number, frameSamples?:number}} opts — the CALLER's frame
 *   size, not the model's. The gate runs at the cadence audio arrives in
 *   (~85ms), reducing the several model frames inside each one to a single
 *   probability, so that hangover, pre-roll and the burst clock all stay
 *   expressed in the units the audio pipeline actually delivers.
 * @returns gate with `push(probability, payload)` -> what to send now
 */
export function createSpeechGate({ sampleRate = 48000, frameSamples = 4096, ...overrides } = {}) {
  const cfg = { ...VAD_DEFAULTS, ...overrides }
  const frameMs = (frameSamples / sampleRate) * 1000
  const prerollFrames = Math.max(1, Math.round(cfg.prerollMs / frameMs))
  // Not const: adjustable while running, and a change takes effect on the next
  // quiet frame - never mid-close, which would drop the trailing words of
  // whatever is being said at that instant.
  let hangoverFrames = Math.max(1, Math.round(cfg.hangoverMs / frameMs))

  let open = false
  let quietFrames = 0
  let ring = []
  // `cycles` and the open/shut totals are how the gate's effect on the
  // transcript is seen: a cycle is one open->shut pass, normally one utterance.
  const stats = {
    framesSent: 0,
    framesSeen: 0,
    cycles: 0,
    openFrames: 0,
    shutFrames: 0,
    // Gate openings, and runs that cleared the threshold without lasting long
    // enough to become one. With attackFrames at 1 the second is always zero;
    // it becomes meaningful only if the attack is raised.
    attacks: 0,
    rejected: 0,
  }
  // The last frame's reading, kept so the room can be shown what the gate is
  // deciding on. Without it the gate is a black box, and "it is not picking me
  // up" has no answer.
  let lastP = 0
  let lastThreshold = cfg.openThreshold
  // Consecutive frames over the threshold while shut.
  let hot = 0
  let manualThreshold = cfg.threshold ?? null
  let cycleFrames = 0
  const NOTHING = []

  return {
    frameMs,
    prerollFrames,

    /** Bounded by the caller; clamped to a frame here. */
    setHangoverMs(ms) {
      cfg.hangoverMs = ms
      hangoverFrames = Math.max(1, Math.round(ms / frameMs))
    },
    hangoverMs: () => cfg.hangoverMs,

    /**
     * Pin the threshold, or hand it back with null. Hysteresis is preserved
     * either way: the probability needed to KEEP the gate open stays the same
     * distance below the one needed to open it, or a frame sitting exactly on
     * the line chatters the gate open and shut.
     */
    setThreshold(p) {
      manualThreshold = p == null || !Number.isFinite(p) ? null : Math.min(1, Math.max(0, p))
    },
    threshold: () => manualThreshold,

    setAttackFrames(n) {
      cfg.attackFrames = Math.max(1, Math.round(n))
    },
    attackFrames: () => cfg.attackFrames,

    /**
     * Everything the gate is currently deciding on. All of it, not a summary:
     * a live readout exists to explain a decision already made, and "the gate
     * opened" with no probability and no threshold beside it explains nothing.
     *
     * A getter rather than a callback: this changes ~12 times a second and
     * nothing should re-render at that rate.
     */
    level: () => ({
      p: lastP,
      threshold: lastThreshold,
      // Where the line comes from. A meter should draw them differently,
      // because "the model decided" and "you decided" fail differently.
      manualThreshold,
      // How far over the line this frame is. Speech should clear it widely; a
      // room where it hovers near zero is one where the gate is a coin toss.
      margin: lastP - lastThreshold,
      open,
      hot,
      attackFrames: cfg.attackFrames,
      quietFrames,
      hangoverFrames,
      hangoverMs: cfg.hangoverMs,
      frameMs,
      openThreshold: cfg.openThreshold,
      closeThreshold: cfg.closeThreshold,
    }),

    /**
     * Feed one captured frame's verdict. `payload` is whatever the caller wants
     * sent for it (an encoded PCM buffer) — the gate only stores it and hands
     * it back.
     *
     * @param {number} probability 0..1 that this frame is speech
     * @param {any} payload
     * @returns {{send:any[], opened:boolean, closed:boolean}}
     */
    push(probability, payload) {
      stats.framesSeen += 1
      // A model that has not loaded, or a frame it has not reached yet, must
      // not read as speech. Treated as silence so the failure is a gate that
      // stays shut, which `useCapture` can see and fall back from - rather than
      // one that latches open and streams the whole kelabo.
      const p = Number.isFinite(probability) ? probability : 0

      const threshold =
        manualThreshold != null
          ? open
            ? // Same gap the automatic pair uses, kept proportional so a pin
              // near either end of the range does not lose its hysteresis.
              manualThreshold * (cfg.closeThreshold / cfg.openThreshold)
            : manualThreshold
          : open
            ? cfg.closeThreshold
            : cfg.openThreshold
      lastP = p
      lastThreshold = threshold
      const speech = p > threshold

      let opened = false
      let closed = false
      if (speech) {
        quietFrames = 0
        if (!open) {
          hot += 1
          if (hot >= cfg.attackFrames) {
            open = true
            opened = true
            hot = 0
            stats.attacks += 1
            stats.shutFrames += cycleFrames
            cycleFrames = 0
          }
        }
      } else {
        // Below the threshold: whatever run was building is over. Without this
        // the count is cumulative rather than consecutive, so an occasional
        // stray frame eventually opens the gate on its own.
        if (hot > 0) stats.rejected += 1
        hot = 0
      }
      if (!speech && open) {
        quietFrames += 1
        if (quietFrames > hangoverFrames) {
          open = false
          closed = true
          stats.cycles += 1
          stats.openFrames += cycleFrames
          cycleFrames = 0
        }
      }
      cycleFrames += 1

      if (open) {
        // On open the ring goes out ahead of the current frame, oldest first,
        // so the provider receives one contiguous stream.
        const send = opened ? [...ring, payload] : [payload]
        ring = []
        stats.framesSent += send.length
        return { send, opened, closed: false }
      }
      ring.push(payload)
      if (ring.length > prerollFrames) ring.shift()
      return { send: NOTHING, opened: false, closed }
    },

    // Called on (re)connect: a new stream restarts the provider's audio clock,
    // and pre-roll buffered against the old one would be transcribed twice.
    reset() {
      open = false
      quietFrames = 0
      hot = 0
      ring = []
    },

    stats() {
      const { framesSent, framesSeen, cycles, openFrames, shutFrames, attacks, rejected } = stats
      const seenMs = Math.round(framesSeen * frameMs)
      return {
        framesSent,
        framesSeen,
        openFrames,
        shutFrames,
        attacks,
        rejected,
        sentMs: Math.round(framesSent * frameMs),
        seenMs,
        // Share of captured audio never sent, and so never billed. The number
        // that says whether any of this is worth doing.
        skipped: framesSeen ? 1 - framesSent / framesSeen : 0,
        // A cycle is one open->shut pass, i.e. one utterance. How often it
        // fires in a real room is the difference between one message per
        // thought and one per half-sentence.
        cycles,
        cyclesPerMin: seenMs ? +(cycles / (seenMs / 60000)).toFixed(1) : 0,
        meanOpenMs: cycles ? Math.round((openFrames * frameMs) / cycles) : 0,
        meanShutMs: cycles ? Math.round((shutFrames * frameMs) / cycles) : 0,
      }
    },
  }
}
