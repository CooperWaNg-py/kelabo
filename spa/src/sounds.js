/**
 * Room sound effects: a short chime when somebody joins, leaves, or sends a
 * message. There are no audio assets — every sound is a couple of oscillator
 * notes scheduled on one shared AudioContext, so the whole feature is this
 * file and it costs the bundle nothing.
 *
 * The chime follows the appearance, not a fixed "ding": the active colour
 * scheme picks the waveform and register (matrix is a phosphor square-wave
 * blip, clay a warm triangle, mono a single flat tone, …), so a room sounds
 * the way it looks. Light/dark deliberately does not change the sound —
 * hearing is not dimmable, and a darker room is not a quieter one.
 *
 * `rosterDiff` and `soundPlan` are the pure halves (no DOM, no AudioContext)
 * so spa/test/sounds.mjs can check them under plain node; keep it that way.
 * The default-off check reads `kelabo-sounds` — the Settings toggle — on
 * every play, so flipping it mid-kelabo takes effect immediately.
 */

// Per-scheme voice: waveform, register and level. Gains stay low — these are
// nudges, not ringtones, and a kelabo can run for hours.
const VOICES = {
  clay:   { type: 'triangle', base: 523.25, gain: 0.05 },  // C5, warm
  slate:  { type: 'sine',     base: 440.0,  gain: 0.06 },  // A4, cool
  sage:   { type: 'triangle', base: 392.0,  gain: 0.05 },  // G4, soft
  plum:   { type: 'sine',     base: 493.88, gain: 0.05 },  // B4, mellow
  mono:   { type: 'sine',     base: 660.0,  gain: 0.04 },  // E5, flat
  matrix: { type: 'square',   base: 880.0,  gain: 0.022 }, // A5, phosphor blip
}
const DEFAULT_VOICE = 'clay'

// Melodies as semitone offsets from the voice's base. Joins rise, leaves fall
// — the interval is the same perfect fifth both ways, so the two events read
// as a pair rather than two unrelated noises. A message is one short note.
const MELODIES = {
  join:    [{ semi: 0, t: 0, d: 0.09 }, { semi: 7, t: 0.09, d: 0.16 }],
  leave:   [{ semi: 7, t: 0, d: 0.09 }, { semi: 0, t: 0.09, d: 0.18 }],
  message: [{ semi: 12, t: 0, d: 0.07 }],
}

/**
 * The notes for one event, as oscillator instructions:
 * `[{ freq, at, dur, type, gain }]`. `at`/`dur` are seconds relative to the
 * start of the sound. Unknown scheme falls back to clay; unknown kind is
 * silence (an empty plan), never an error.
 */
export function soundPlan(scheme, kind) {
  const voice = VOICES[scheme] || VOICES[DEFAULT_VOICE]
  const melody = MELODIES[kind]
  if (!melody) return []
  return melody.map(n => ({
    freq: voice.base * Math.pow(2, n.semi / 12),
    at: n.t,
    dur: n.d,
    type: voice.type,
    gain: voice.gain,
  }))
}

/**
 * Who arrived and who went between two roster snapshots (identity lists from
 * the SSE `roster` event). `selfId` is filtered out of both directions: your
 * own reconnects are not an event worth a chime, and on the first snapshot
 * after a resubscribe everyone — including you — looks "new".
 */
export function rosterDiff(prev, next, selfId) {
  const before = new Set(prev || [])
  const after = new Set(next || [])
  return {
    joined: [...after].filter(id => !before.has(id) && id !== selfId),
    left: [...before].filter(id => !after.has(id) && id !== selfId),
  }
}

/**
 * Does this SSE utterance event warrant the message chime? Only a sealed
 * message counts: the live `tail`/`delta` fragments (`partial: true`) stream
 * several times a second while somebody is still talking, so chiming them
 * would be a buzz, not a nudge. Your own echo never chimes — you know you
 * sent it. `by` absent (a very old gateway) stays silent rather than risk
 * chiming your own words back at you.
 */
export function shouldChimeUtterance(utt, selfId) {
  return !!utt && utt.partial === false && !!utt.by && utt.by !== selfId
}

// --- the impure half: one lazily-created AudioContext -----------------------

let ctx = null

function audioContext() {
  if (ctx) return ctx
  const AC = typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext)
  if (!AC) return null
  ctx = new AC()
  return ctx
}

export function soundsEnabled() {
  return localStorage.getItem('kelabo-sounds') !== '0'
}

/**
 * Play the chime for one event ('join' | 'leave' | 'message'). Silent — by
 * design, not by error — when the toggle is off, the browser has no WebAudio,
 * or the autoplay policy keeps the context suspended.
 */
export function playEventSound(kind) {
  if (!soundsEnabled()) return
  const ac = audioContext()
  if (!ac) return
  const scheme = document.documentElement.dataset.scheme || DEFAULT_VOICE
  const notes = soundPlan(scheme, kind)
  if (notes.length === 0) return
  const start = () => {
    const t0 = ac.currentTime + 0.01
    for (const n of notes) {
      const osc = ac.createOscillator()
      const env = ac.createGain()
      osc.type = n.type
      osc.frequency.value = n.freq
      env.gain.setValueAtTime(0.0001, t0 + n.at)
      env.gain.exponentialRampToValueAtTime(n.gain, t0 + n.at + 0.015)
      env.gain.exponentialRampToValueAtTime(0.0001, t0 + n.at + n.dur)
      osc.connect(env)
      env.connect(ac.destination)
      osc.start(t0 + n.at)
      osc.stop(t0 + n.at + n.dur + 0.02)
    }
  }
  // The context starts suspended until the page has seen a user gesture, and
  // entering a kelabo is clicks all the way down, so resume() succeeds in
  // practice. If it does not, the sound is skipped rather than queued to fire
  // late over some unrelated click.
  if (ac.state === 'running') start()
  else ac.resume().then(start).catch(() => {})
}
