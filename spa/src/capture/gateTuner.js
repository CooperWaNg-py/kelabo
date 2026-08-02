// Imports here carry the .js extension because this module is also loaded by
// plain node in spa/test/gate.mjs, and node ESM requires it.

// Closed-loop tuning for the speech gate's hangover.
//
// `hangoverMs` is how long the gate stays open after the level drops, and it is
// the single most consequential number in the capture pipeline because three
// different things hang off it:
//
//   MESSAGE GRANULARITY  the gate closing is what ends an utterance. Too short
//                        and one thought becomes four messages, each posted to
//                        the board and handed to the agent separately.
//   TRAILING WORDS       too short and the tail of a sentence is cut off before
//                        the provider ever hears it.
//   MONEY                on a provider billed by stream duration it is added to
//                        every utterance: end-of-speech to end-of-billing is
//                        `hangoverMs + silenceMs`. Every 100ms here is 100ms on
//                        every utterance of every kelabo.
//
// The right value is a property of the ROOM — its noise floor, its microphone,
// how the speaker paces their sentences — so it cannot be chosen once at build
// time. A close-talk headset in a quiet office and a laptop on a meeting-room
// table want different numbers by a factor of two, and neither of them is the
// number in `VAD_DEFAULTS`.
//
// So it is measured instead. This module reads the gate's own cycle statistics
// and proposes a correction; it never touches the gate itself.
//
// WINDOWED, NOT CUMULATIVE. The gate's stats run from the moment it was built.
// Feeding those to a controller means that after ten minutes a single bad
// minute cannot move the average, and the loop silently stops responding just
// as the room fills up and starts to matter. Every decision here is made on the
// DELTA since the last sample.
//
// Pure: no gate, no clock of its own, no React. `spa/test/gate.mjs` runs it.

export const TUNER_DEFAULTS = {
  // Nothing is decided on less than this much audio. Two people exchanging a
  // few words produce wild ratios, and reacting to them means the gate is
  // retuned constantly and settles on nothing.
  minWindowMs: 20_000,
  // Bounds. The floor is the shortest pause a speaker takes mid-sentence
  // without meaning to have stopped; below it the gate chops sentences however
  // well it is tuned. The ceiling is where the billing tail and the latency to
  // a sealed message both stop being acceptable.
  minHangoverMs: 500,
  maxHangoverMs: 1800,
  // One step. Small enough that a wrong move is cheap and self-correcting,
  // large enough to converge in a few windows rather than a few hours.
  stepMs: 150,
  // CHOPPING. Utterances arriving faster than this, each shorter than
  // `chopOpenMs`, is the signature of a gate closing inside sentences rather
  // than between them — nobody delivers twelve separate thoughts a minute.
  chopCyclesPerMin: 12,
  chopOpenMs: 1500,
  // TRANSIENT TRIGGERING, which looks exactly like chopping on cycle count and
  // wants the opposite correction. When the gate opens on a click rather than a
  // voice, nothing sustains, so it shuts again the moment the hangover expires
  // and the open time is the hangover and almost nothing else. Raising the
  // hangover there makes it strictly worse — every click would hold the gate
  // (and, on a per-second provider, the meter) open for longer. What is wrong
  // is how easily the gate trips, so the attack is what moves.
  transientOpenRatio: 1.35,
  // And a room being triggered by transients is a room that is mostly silent;
  // this separates it from one where somebody is genuinely talking in bursts.
  transientSkipped: 0.5,
  minAttackFrames: 1,
  maxAttackFrames: 4,
  // LATCHED OPEN. The gate is passing nearly everything and almost never
  // closing, which means room tone is sitting above the threshold. The
  // transcript then never seals on silence and, on a per-second provider, the
  // meter never stops.
  latchedSkipped: 0.05,
  latchedCyclesPerMin: 2,
}

/**
 * @typedef {{cycles:number, openFrames:number, shutFrames:number,
 *            framesSent:number, framesSeen:number}} GateCounters
 */

/**
 * Reads the gate's cumulative counters and proposes hangover corrections from
 * the change between samples.
 *
 * @param {{hangoverMs:number, frameMs:number} & Partial<TUNER_DEFAULTS>} opts
 */
export function createGateTuner({ hangoverMs, attackFrames = 2, frameMs, ...overrides }) {
  const cfg = { ...TUNER_DEFAULTS, ...overrides }
  let current = { hangoverMs, attackFrames }
  let prev = null
  // Observability. A controller whose correct behaviour in a healthy room is to
  // do nothing is indistinguishable from one that is not running at all, and
  // "I don't think it's running" is not a question anybody should have to
  // answer by reading the source.
  let windows = 0
  let lastWindow = null
  let lastVerdict = null

  /**
   * @param {GateCounters|null} counters the gate's cumulative `stats()`
   * @returns {{hangoverMs:number, from:number, reason:string, window:object}|null}
   *   a proposed change, or null to leave it alone.
   */
  function sample(counters) {
    if (!counters) return null
    const now = {
      cycles: counters.cycles || 0,
      openFrames: counters.openFrames || 0,
      shutFrames: counters.shutFrames || 0,
      framesSent: counters.framesSent || 0,
      framesSeen: counters.framesSeen || 0,
    }
    if (!prev) {
      prev = now
      return null
    }

    const d = {
      cycles: now.cycles - prev.cycles,
      openFrames: now.openFrames - prev.openFrames,
      shutFrames: now.shutFrames - prev.shutFrames,
      framesSent: now.framesSent - prev.framesSent,
      framesSeen: now.framesSeen - prev.framesSeen,
    }
    // The gate was rebuilt under us (a new stream, a new device): counters went
    // backwards. Re-baseline rather than reading the negative as a signal.
    if (d.cycles < 0 || d.framesSeen < 0) {
      prev = now
      return null
    }

    const seenMs = d.framesSeen * frameMs
    if (seenMs < cfg.minWindowMs) return null
    prev = now
    windows += 1

    const window = {
      seenMs: Math.round(seenMs),
      cycles: d.cycles,
      cyclesPerMin: +(d.cycles / (seenMs / 60000)).toFixed(1),
      meanOpenMs: d.cycles ? Math.round((d.openFrames * frameMs) / d.cycles) : 0,
      meanShutMs: d.cycles ? Math.round((d.shutFrames * frameMs) / d.cycles) : 0,
      skipped: d.framesSeen ? +(1 - d.framesSent / d.framesSeen).toFixed(3) : 0,
    }

    const busy = window.cyclesPerMin >= cfg.chopCyclesPerMin
    // Opened, sustained nothing, shut again as soon as the hangover expired.
    const unsustained = window.meanOpenMs <= current.hangoverMs * cfg.transientOpenRatio

    let kind = null
    let value = null
    let reason = null

    if (busy && unsustained && window.skipped >= cfg.transientSkipped) {
      // Clicks, keys, a knock on the desk. Make it harder to trip, never longer
      // to hold: a longer hangover would extend every false trigger.
      kind = 'attackFrames'
      value = current.attackFrames + 1
      reason = 'transient-triggering'
    } else if (busy && window.meanOpenMs < cfg.chopOpenMs) {
      // Genuinely closing inside sentences. Hold it open longer.
      kind = 'hangoverMs'
      value = current.hangoverMs + cfg.stepMs
      reason = 'chopping'
    } else if (window.skipped <= cfg.latchedSkipped && window.cyclesPerMin < cfg.latchedCyclesPerMin) {
      // Latched open: nearly nothing skipped and hardly any cycles. A shorter
      // hangover is what lets it shut between utterances again.
      kind = 'hangoverMs'
      value = current.hangoverMs - cfg.stepMs
      reason = 'latched-open'
    }

    lastWindow = window
    if (!kind) {
      // Explicitly recorded, not merely absent: "measured, nothing wrong" is a
      // different statement from "never looked".
      lastVerdict = { reason: 'healthy', at: windows, window }
      return null
    }
    value =
      kind === 'attackFrames'
        ? Math.min(Math.max(value, cfg.minAttackFrames), cfg.maxAttackFrames)
        : Math.min(Math.max(value, cfg.minHangoverMs), cfg.maxHangoverMs)
    // Already at the limit. Deliberately NOT falling through to another rule:
    // when the attack cannot go higher, the answer to a room full of clicks is
    // not to start lengthening the hangover instead.
    if (value === current[kind]) {
      lastVerdict = { reason: `${reason} (at limit)`, at: windows, window }
      return null
    }
    const from = current[kind]
    current = { ...current, [kind]: value }
    lastVerdict = { reason, at: windows, window }
    return { kind, value, from, reason, window }
  }

  return {
    sample,
    get hangoverMs() {
      return current.hangoverMs
    },
    get attackFrames() {
      return current.attackFrames
    },
    /** What the loop has seen, so a silent controller can prove it is awake. */
    status: () => ({
      windows,
      lastWindow,
      lastVerdict,
      minWindowMs: cfg.minWindowMs,
      hangoverMs: current.hangoverMs,
      attackFrames: current.attackFrames,
    }),

    /** A new gate starts from the value we have learned, not from the default. */
    reset() {
      prev = null
    },
    config: cfg,
  }
}
