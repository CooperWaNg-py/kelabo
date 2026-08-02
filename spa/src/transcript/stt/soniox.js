// Imports inside spa/src/transcript/ carry the .js extension (unlike the rest of
// the SPA, which relies on Vite's resolution) because these modules are also
// loaded by plain node in spa/test/transcript.mjs, and node ESM requires it.

// Soniox's streaming wire format, in one pure reader — the front half of the
// Capture stage (docs 13). Reads to `SttRead` (spa/src/stt/interface.js); the
// caller cannot tell which provider produced it.
//
// WHAT SONIOX SENDS. Not spans of transcript but a stream of TOKENS — subwords,
// words, spaces — each carrying its own `is_final`:
//
//   {"tokens":[{"text":"How","is_final":true},{"text":" are","is_final":false}],
//    "final_audio_proc_ms":760,"total_audio_proc_ms":880}
//
//   is_final: false  provisional. Re-sent, revised or dropped as more audio
//                    arrives. Every response carries the COMPLETE current set of
//                    them, which is exactly what a tail is.
//   is_final: true   confirmed, sent ONCE and never repeated.
//
// That last property is why this reader is stateless where the Deepgram one is
// not. There is no span, no cursor, and no re-emission to detect: a final token
// is new words, always. The whole class of bug the Deepgram reader guards
// against — a CJK model re-finalizing a span and committing it twice — cannot
// be expressed here.
//
// TOKENS CARRY THEIR OWN SPACING (`"How"`, `" are"`, `" you"`), so a run is
// built by plain concatenation with no joiner, and the CJK special-casing the
// Deepgram reader needs does not arise. Each finished run is then trimmed,
// because `joinText` inserts the separator when the composer appends the run to
// what is already committed — without the trim, " you" arrives as a leading
// space AND a joined one, and every word after the first is doubly spaced.
//
// MARKER TOKENS. `<end>` (endpoint detected) and `<fin>` (answer to a manual
// `finalize`) are signals, not speech. They are stripped from the text and
// reported as `endpoint`.
//
// Pure: no React, no socket, no clock.

const MARKERS = new Set(['<end>', '<fin>'])

function empty(extra) {
  return { finals: [], tails: [], active: [], endpoint: false, error: null, finished: false, ...extra }
}

/** Consecutive tokens from one speaker become one segment, in stream order. */
function runs(tokens, diarize) {
  const segs = []
  for (const t of tokens) {
    const speaker = diarize ? String(t.speaker ?? '') : ''
    const last = segs[segs.length - 1]
    if (last && last.speaker === speaker) {
      last.text += t.text
      // A token without timestamps (a translation token) must not drag the end
      // of the run back to zero.
      if (Number.isFinite(t.end_ms)) last.end = Math.round(t.end_ms)
    } else {
      segs.push({
        speaker,
        text: t.text,
        start: Math.round(Number.isFinite(t.start_ms) ? t.start_ms : 0),
        end: Math.round(Number.isFinite(t.end_ms) ? t.end_ms : 0),
      })
    }
  }
  // Trimmed here, dropped if that leaves nothing: a response whose only content
  // is the space between two words is not speech and must not hold a message
  // open or open a new one.
  const out = []
  for (const s of segs) {
    const text = s.text.trim()
    if (text) out.push({ ...s, text })
  }
  return out
}

function speakersOf(...lists) {
  const seen = []
  for (const list of lists) for (const s of list) if (!seen.includes(s.speaker)) seen.push(s.speaker)
  return seen
}

/**
 * @param {{diarize?: boolean}} opts
 * @returns {import('../../stt/interface.js').SttReader}
 */
export function createReader({ diarize = false } = {}) {
  return {
    // Nothing to reset: a final token is never repeated, so there is no
    // per-stream bookkeeping to carry — or to wrongly carry — across a socket.
    reset() {},

    read(msg) {
      if (!msg || typeof msg !== 'object') return empty()

      // Soniox reports failure in-band and then closes, so the reason a stream
      // died is knowable here — unlike a socket that simply drops.
      if (msg.error_code) {
        return empty({
          error: {
            code: Number(msg.error_code) || 0,
            type: String(msg.error_type || ''),
            message: String(msg.error_message || ''),
          },
        })
      }

      const finalTokens = []
      const tailTokens = []
      let endpoint = false
      for (const t of msg.tokens || []) {
        const text = typeof t?.text === 'string' ? t.text : ''
        if (!text) continue
        if (MARKERS.has(text)) {
          endpoint = true
          continue
        }
        // Only reachable if translation is ever switched on; a translated token
        // repeats what a source token already said, so counting both would
        // transcribe every sentence twice.
        if (t.translation_status === 'translation') continue
        ;(t.is_final ? finalTokens : tailTokens).push(t)
      }

      const finals = runs(finalTokens, diarize)
      const tails = runs(tailTokens, diarize)
      return {
        finals,
        tails,
        active: speakersOf(finals, tails),
        endpoint,
        error: null,
        finished: msg.finished === true,
      }
    },
  }
}
