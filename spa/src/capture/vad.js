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
  // Kept open after the level drops. Long enough that a provider still sees the
  // trailing silence its endpointer needs, and — where a stream is billed by
  // duration — added to every utterance, so it is not free.
  hangoverMs: 900,
  // ATTACK: consecutive frames that must clear the threshold before the gate
  // opens at all.
  //
  // Without this, ONE frame over the line opens the gate for the whole
  // hangover, and a frame is 85ms of RMS — so a single mouse click, a key
  // press, or a knock on the desk starts an utterance and holds it open for
  // most of a second. On a provider billed by stream duration it also starts
  // the meter. Speech sustains for hundreds of milliseconds; a transient does
  // not, and that is the whole difference between them at this resolution.
  //
  // Two frames (~170ms) costs nothing in practice because the pre-roll ring is
  // longer than the delay: the audio that opened the gate is sent anyway, so
  // waiting to be sure loses no words.
  attackFrames: 2,
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
  // A FIXED threshold in dBFS, or null for the adaptive one above.
  //
  // The adaptive floor is right for most rooms and wrong for some in ways no
  // amount of tracking fixes: a constant hum a few dB under speech, a mic with
  // its own gain control, a room where the useful margin is two decibels wide.
  // In those, watching the meter and pinning the line where it obviously
  // belongs beats any amount of automatic correction — the person can see the
  // answer and the algorithm cannot.
  thresholdDb: null,
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
  // Not const: the right hangover is a property of the room, so it is measured
  // and corrected while the kelabo runs (capture/gateTuner.js). A change takes
  // effect on the next quiet frame — never mid-close, which would drop the
  // trailing words of whatever is being said at that instant.
  let hangoverFrames = Math.max(1, Math.round(cfg.hangoverMs / frameMs))

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
  const stats = {
    framesSent: 0, framesSeen: 0, cycles: 0, openFrames: 0, shutFrames: 0,
    // Gate openings, and frames that cleared the threshold but did not sustain
    // long enough to be one. A room full of the second is a room full of
    // clicks, keyboards and door knocks — which is a different problem from a
    // gate tuned too tight, and wants a different correction.
    attacks: 0, rejected: 0,
  }
  // The last frame's readings, kept so the room can be shown what the gate is
  // actually deciding on. Without them the gate is a black box: a participant
  // whose speech sits 2dB over the threshold and one whose speech sits 25dB
  // over it behave completely differently and look identical from outside.
  let lastDb = cfg.noiseFloorDb
  let lastThreshold = cfg.minSpeechDb
  // Consecutive frames over the threshold while the gate is shut. This is what
  // a transient cannot sustain.
  let hot = 0
  // null = follow the noise floor. A number = the participant put the line
  // there by hand and it stays there.
  let manualThresholdDb = cfg.thresholdDb ?? null
  let cycleFrames = 0
  const NOTHING = []

  return {
    frameMs,
    prerollFrames,

    /** The tuner's correction. Bounded by the caller; clamped to a frame here. */
    setHangoverMs(ms) {
      cfg.hangoverMs = ms
      hangoverFrames = Math.max(1, Math.round(ms / frameMs))
    },
    hangoverMs: () => cfg.hangoverMs,

    /**
     * Pin the threshold, or hand it back to the noise-floor tracker with null.
     * Hysteresis is preserved either way: the level needed to KEEP the gate open
     * stays the same distance below the level needed to open it, or a syllable
     * sitting exactly on the line chatters the gate open and shut.
     */
    setThresholdDb(db) {
      manualThresholdDb = db == null || !Number.isFinite(db) ? null : db
    },
    thresholdDb: () => manualThresholdDb,

    /** The tuner's other correction: how hard it is to trip the gate at all. */
    setAttackFrames(n) {
      cfg.attackFrames = Math.max(1, Math.round(n))
    },
    attackFrames: () => cfg.attackFrames,

    /**
     * What the gate is seeing right now, for a live meter. A getter rather than
     * a callback: this changes every frame (~12/s) and nothing should re-render
     * at that rate — the caller samples it when it has somewhere to draw it.
     */
    /**
     * Everything the adaptive gate is currently deciding on. All of it, not a
     * summary: the point of a live readout is to explain a decision that has
     * already been made, and "the gate opened" with no threshold, no floor and
     * no headroom beside it explains nothing.
     */
    level: () => ({
      db: lastDb,
      floorDb,
      threshold: lastThreshold,
      // Where the line is coming from. The meter draws them differently,
      // because "the algorithm chose this" and "you chose this" fail in
      // completely different ways.
      manualThresholdDb,
      // The number that actually decides, and the one worth watching: how far
      // over the line this frame is. Speech should clear it by a wide margin;
      // a room where it hovers near zero is a room where the gate is a coin
      // toss frame to frame.
      headroomDb: lastDb - lastThreshold,
      open,
      hot,
      attackFrames: cfg.attackFrames,
      quietFrames,
      hangoverFrames,
      hangoverMs: cfg.hangoverMs,
      frameMs,
      floorFloorDb: cfg.noiseFloorDb,
      minSpeechDb: cfg.minSpeechDb,
      openDb: cfg.openDb,
      closeDb: cfg.closeDb,
    }),

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

      const hysteresisDb = Math.max(0, cfg.openDb - cfg.closeDb)
      const threshold =
        manualThresholdDb != null
          ? open
            ? manualThresholdDb - hysteresisDb
            : manualThresholdDb
          : open
            ? Math.max(floorDb + cfg.closeDb, cfg.minSpeechDb - 3)
            : Math.max(floorDb + cfg.openDb, cfg.minSpeechDb)
      lastDb = db
      lastThreshold = threshold
      const speech = db > threshold

      let opened = false
      let closed = false
      if (speech) {
        quietFrames = 0
        if (!open) {
          // Sustained, not merely loud. A click clears the threshold on one
          // frame and is gone on the next, so it never reaches the count.
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
        // the count is cumulative rather than consecutive, so a click a minute
        // eventually opens the gate on its own — the attack would reject
        // nothing and merely delay it.
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
        // On open the ring buffer goes out ahead of the current frame, oldest
        // first, so the provider receives one contiguous stream.
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
      const { framesSent, framesSeen, cycles, openFrames, shutFrames, attacks, rejected } = stats
      const seenMs = Math.round(framesSeen * frameMs)
      return {
        framesSent,
        framesSeen,
        // The RAW counters as well as the derived figures. The tuner works on
        // deltas between samples, so it needs the totals it can subtract — it
        // was reading the means instead, which are already averaged over the
        // whole gate lifetime and cannot be differenced. Every window then had
        // `meanOpenMs: 0`, which matches "opened and sustained nothing", so a
        // perfectly healthy room was diagnosed as full of clicks.
        openFrames,
        shutFrames,
        // Gate openings, and runs that cleared the threshold without lasting
        // long enough to become one. A high `rejected` is the attack doing its
        // job; a high `rejected` with a low `attacks` is a room where something
        // other than speech keeps hitting the microphone.
        attacks,
        rejected,
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
