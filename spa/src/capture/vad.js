// Voice activity detection for the capture pipeline.
//
// Deepgram bills streaming by the audio actually sent, and in a kelabo any one
// participant is silent most of the time — with one mic per person, streaming
// wall-clock means paying to transcribe other people's silence. The gate
// decides, frame by frame, whether the mic carries speech; `useCapture` streams
// only those frames and holds the socket open with `KeepAlive` (free, and what
// Deepgram documents for exactly this) through the rest.
//
// The detector is a plain energy gate with an adaptive noise floor: no model, no
// bundle cost, and close-talk kelabo mics leave it a wide margin. Two details
// make it safe to put in front of an STT stream:
//   - **preroll** — frames from just before the gate opened are kept in a ring
//     buffer and sent first, so the word that tripped the gate is not clipped;
//   - **hangover** — the gate stays open a while after the level drops, so
//     trailing words survive and Deepgram still sees the trailing silence its
//     endpointer needs (`endpointing=300`) to emit `speech_final`.
//
// Cutting silence also breaks the assumption that Deepgram's word timestamps
// track wall clock — they count sent audio only. `useCapture` compensates by
// stamping each burst (see `opened`) against the wall clock.

export const VAD_DEFAULTS = {
  // Audio retained before speech onset. Two ScriptProcessor frames (~85ms each)
  // are enough for the attack of a word; four is comfortable.
  prerollMs: 400,
  // Kept open after the level drops. Must exceed Deepgram's endpointing window
  // (300ms) or Deepgram never sees a pause and never finalizes an utterance.
  hangoverMs: 900,
  // Level above the noise floor that opens the gate, and the lower level that
  // keeps it open (hysteresis, so a soft syllable does not chatter the gate).
  openDb: 10,
  closeDb: 6,
  // Absolute levels. `minSpeechDb` stops a very quiet room (low noise floor +
  // 10dB is still nothing) from opening the gate on fan noise; `noiseFloorDb`
  // stops digital silence from dragging the floor so low that anything opens it.
  minSpeechDb: -55,
  noiseFloorDb: -70,
  // How the floor climbs to meet a room noisier than it currently believes.
  //
  // The floor used to be frozen while the gate was open, so that speech could
  // not drag it up and close the gate mid-sentence. But that made a room louder
  // than the floor unrecoverable: room tone sat above `floor + closeDb`, every
  // pause frame counted as speech, and the gate latched open for the rest of the
  // kelabo — no seal trigger, and no audio skipped, so VAD saved nothing.
  //
  // Only frames within `floorTrackDb` of the floor pull it up. Room tone is a
  // few dB above the floor and adapts within a pause; speech is far above it and
  // still cannot move it, which is what the freeze was protecting.
  floorTrackDb: 12,
  floorRiseRate: 0.05,
}

// Frame level in dBFS. -Infinity is avoided so the floor tracker stays finite.
function frameDb(samples) {
  let sum = 0
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i]
  return 20 * Math.log10(Math.sqrt(sum / samples.length) + 1e-10)
}

/**
 * @param {{sampleRate?:number, frameSamples?:number}} opts
 * @returns gate with `push(samples, payload)` -> what to send now
 */
export function createSpeechGate({ sampleRate = 48000, frameSamples = 4096, ...overrides } = {}) {
  const cfg = { ...VAD_DEFAULTS, ...overrides }
  const frameMs = (frameSamples / sampleRate) * 1000
  const prerollFrames = Math.max(1, Math.round(cfg.prerollMs / frameMs))
  const hangoverFrames = Math.max(1, Math.round(cfg.hangoverMs / frameMs))

  // Seeded pessimistically (a quiet room, not digital silence): the floor falls
  // fast, so a wrong seed costs at most a second of extra audio, while a seed
  // that is too low would gate real speech out.
  let floorDb = -50
  let open = false
  let quietFrames = 0
  let ring = []
  // `cycles` and the open/shut frame totals exist to tune `hangoverMs`, which is
  // what decides message granularity: the gate close is the primary seal trigger
  // for a spoken message (useCapture), so how often it fires in a real room is
  // the difference between one message per thought and one per half-sentence.
  const stats = { framesSent: 0, framesSeen: 0, cycles: 0, openFrames: 0, shutFrames: 0 }
  let cycleFrames = 0
  const NOTHING = []

  return {
    frameMs,
    prerollFrames,

    /**
     * Feed one captured frame. `payload` is whatever the caller wants to send
     * for it (an encoded PCM buffer) — the gate only stores and hands it back.
     * @returns {{send:any[], opened:boolean, closed:boolean, active:boolean, db:number, floorDb:number}}
     */
    push(samples, payload) {
      stats.framesSeen += 1
      const db = frameDb(samples)
      // The floor follows the level down quickly and creeps up slowly, and only
      // creeps up while the gate is shut — otherwise speech raises the floor and
      // the gate closes on the speaker mid-sentence.
      if (db < floorDb) floorDb += (db - floorDb) * 0.25
      else if (db < floorDb + cfg.floorTrackDb) floorDb += (db - floorDb) * cfg.floorRiseRate
      else if (!open) floorDb += (db - floorDb) * 0.002
      if (floorDb < cfg.noiseFloorDb) floorDb = cfg.noiseFloorDb

      const threshold = open
        ? Math.max(floorDb + cfg.closeDb, cfg.minSpeechDb - 3)
        : Math.max(floorDb + cfg.openDb, cfg.minSpeechDb)
      const speech = db > threshold

      let opened = false
      let closed = false
      if (speech) {
        quietFrames = 0
        if (!open) {
          open = true
          opened = true
          stats.shutFrames += cycleFrames
          cycleFrames = 0
        }
      } else if (open) {
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
        // On open the ring buffer goes out ahead of the current frame, oldest
        // first, so Deepgram receives one contiguous stream.
        const send = opened ? [...ring, payload] : [payload]
        ring = []
        stats.framesSent += send.length
        return { send, opened, closed: false, active: true, db, floorDb }
      }
      ring.push(payload)
      if (ring.length > prerollFrames) ring.shift()
      return { send: NOTHING, opened: false, closed, active: false, db, floorDb }
    },

    // Called on (re)connect: a new socket restarts Deepgram's audio clock, and
    // buffered preroll from the old one would be transcribed twice.
    reset() {
      open = false
      quietFrames = 0
      ring = []
    },

    stats() {
      const { framesSent, framesSeen, cycles, openFrames, shutFrames } = stats
      const seenMs = Math.round(framesSeen * frameMs)
      return {
        framesSent,
        framesSeen,
        sentMs: Math.round(framesSent * frameMs),
        seenMs,
        // Share of captured audio never sent (and so never billed).
        skipped: framesSeen ? 1 - framesSent / framesSeen : 0,
        // Tuning signal for `hangoverMs`. A cycle is one open→shut pass, i.e.
        // one utterance and therefore (normally) one sealed message. If
        // `cyclesPerMin` is high and `meanOpenMs` is short, the gate is closing
        // inside sentences and the hangover wants raising.
        cycles,
        cyclesPerMin: seenMs ? +(cycles / (seenMs / 60000)).toFixed(1) : 0,
        meanOpenMs: cycles ? Math.round((openFrames * frameMs) / cycles) : 0,
        meanShutMs: cycles ? Math.round((shutFrames * frameMs) / cycles) : 0,
      }
    },
  }
}
