// Imports inside spa/src/transcript/ carry the .js extension (unlike the rest of
// the SPA, which relies on Vite's resolution) because these modules are also
// loaded by plain node in spa/test/transcript.mjs, and node ESM requires it.

// Deepgram's streaming wire format, in one pure reader — the front half of the
// Capture stage (docs 13). Reads to `SttRead` (spa/src/stt/interface.js); the
// caller cannot tell which provider produced it.
//
// WHAT DEEPGRAM SENDS (per its streaming docs):
//
//   is_final: false  an *interim*: its guess for the segment in progress,
//                    restated in full on every revision (about once a second)
//                    and free to change.
//   is_final: true   that segment is *finalized*. Deepgram will never revise it,
//                    and the next segment starts where this one ended. A whole
//                    utterance is the concatenation of its finals:
//
//                      0.000-3.260 is_final       "…my credit card number is two two"
//                      3.260-5.100 interim        "two two three three"
//                      3.260-5.500 is_final       "two two three three three three"
//
//   speech_final / UtteranceEnd   where Deepgram thinks the *speaker* paused.
//
// WHY THE PAUSE SIGNALS ARE IGNORED HERE, so `endpoint` is always false. Message
// boundaries are the composer's decision (docs 13, I5/I5a), and both signals are
// unreliable in this app by construction: the VAD gate removes silence before it
// is ever sent, so `endpointing` sees almost none, and `utterance_end_ms`
// measures gaps between word timings — on Deepgram's audio clock our words are
// contiguous even when the speaker stopped for a minute. `Finalize` (sent when
// the gate shuts) is no substitute either: Deepgram documents that its
// `from_finalize` answer is *not guaranteed* when little audio is buffered.
//
// Holding a final back until one of those arrived is what stranded them: the
// text stayed an unconfirmed tail for the whole utterance, so nothing was
// persisted or shown to the LLM until the message eventually sealed as stalled.
// A final is authoritative when it arrives, so it is read as settled here and
// committed immediately.
//
// Pure: no React, no socket, no clock. The span cursor is closure state rather
// than the caller's business — it is Deepgram's alone, and no other provider
// has one.

// Deepgram returns per-token words for CJK languages; joining them with spaces
// corrupts the text by inserting spurious spaces between tokens.
const CJK_LANGS = new Set(['zh', 'ja', 'ko'])

const secToMs = s => Math.round((s || 0) * 1000)

function empty() {
  return { finals: [], tails: [], active: [], endpoint: false, error: null, finished: false }
}

function speakersOf(segments) {
  const seen = []
  for (const s of segments) if (!seen.includes(s.speaker)) seen.push(s.speaker)
  return seen
}

/**
 * Group a result's words into runs by diarization speaker, with timestamps in
 * milliseconds. Speaker ids are stringified rather than normalised: what a "0"
 * should be called is `transcript/speakerLabels.js`'s decision, not a
 * provider's.
 */
export function segmentWords(words, joiner = ' ', diarize = false) {
  const segs = []
  for (const w of words || []) {
    const word = w.punctuated_word || w.word
    if (!word) continue
    const speaker = diarize ? String(w.speaker ?? 0) : ''
    const last = segs[segs.length - 1]
    if (last && last.speaker === speaker) {
      last.text += (last.text ? joiner : '') + word
      last.end = secToMs(w.end)
    } else {
      segs.push({ speaker, text: word, start: secToMs(w.start), end: secToMs(w.end) })
    }
  }
  return segs
}

/**
 * @param {{diarize?: boolean, language?: string}} opts
 * @returns {import('../../stt/interface.js').SttReader}
 */
export function createReader({ diarize = false, language = 'en' } = {}) {
  const joiner = CJK_LANGS.has(language) ? '' : ' '
  // End of the audio span already finalized. Every response covers
  // [start, start+duration] and `is_final` makes it authoritative for that span,
  // so the span is the identity of the finalized audio — which is what makes a
  // re-emission detectable. Seconds, on Deepgram's own clock.
  let cursor = 0

  return {
    reset() {
      cursor = 0
    },

    read(msg) {
      const alt = msg?.channel?.alternatives?.[0]
      // UtteranceEnd, SpeechStarted, Metadata: no transcript, nothing to read.
      if (!alt) return empty()

      const text = alt.transcript || ''
      const words = alt.words || []

      if (!msg.is_final) {
        if (!text) return empty()
        // ONE tail, even when diarized, even though the interface allows several.
        // Deepgram re-attributes words between revisions of the same interim, so
        // splitting a guess by speaker would open and abandon a message per
        // flicker — each then sealing five seconds later on words nobody said in
        // that order. The finals it later commits are attributed stably, and they
        // are what gets persisted. A provider whose guesses are stable per
        // speaker is free to return one tail each.
        const speaker = diarize && words.length ? String(words[0].speaker ?? 0) : ''
        const joined = diarize
          ? segmentWords(words, joiner, diarize).map(s => s.text).join(joiner) || text
          : text
        return {
          finals: [],
          tails: [
            {
              speaker,
              // An interim covers only the segment in progress. The finals before
              // it are already the composer's committed text, and joining the two
              // is `mergeTail`'s job alone — the same function the view and the
              // seal use, so all three agree by construction.
              text: joined,
              start: secToMs(words[0]?.start ?? 0),
              end: secToMs(words[words.length - 1]?.end ?? 0),
            },
          ],
          active: [speaker],
          endpoint: false,
          error: null,
          finished: false,
        }
      }

      const spanStart = typeof msg.start === 'number' ? msg.start : 0
      const spanEnd =
        typeof msg.duration === 'number'
          ? spanStart + msg.duration
          : (words.reduce((m, w) => Math.max(m, w.end || 0), 0) || 0)

      // Deepgram re-emits a final for a span it has already finalized (CJK models
      // do this routinely). Already covered means already committed — and the
      // cursor must NOT move backwards. The words were still spoken, so they hold
      // the speaker's message open even though nothing is surfaced.
      if (spanEnd <= cursor + 1e-3) {
        if (!text) return empty()
        const covered = segmentWords(words, joiner, diarize)
        return { ...empty(), active: covered.length ? speakersOf(covered) : [diarize ? '0' : ''] }
      }

      // An empty final still advances the cursor: that audio is settled, there
      // was just no speech in it.
      if (!text) {
        cursor = spanEnd
        return empty()
      }

      let finals
      if (!diarize && spanStart >= cursor - 1e-3) {
        // Non-diarized and the whole span is new: the response transcript is
        // authoritative. (zh word lists mix phrase- and token-level entries, so
        // re-joining words duplicates text; words are only needed for
        // diarization speaker labels.)
        finals = [{ speaker: '', text, start: secToMs(spanStart), end: secToMs(spanEnd) }]
      } else {
        // Partially covered, or diarized: rebuild from the words this result
        // adds, so text already committed by an earlier final is not repeated.
        finals = segmentWords(words.filter(w => (w.end ?? Infinity) > cursor + 1e-3), joiner, diarize)
        if (!finals.length && !words.length) {
          finals = [
            { speaker: diarize ? '0' : '', text, start: secToMs(spanStart), end: secToMs(spanEnd) },
          ]
        }
      }

      cursor = spanEnd
      return {
        finals,
        tails: [],
        active: speakersOf(finals),
        endpoint: false,
        error: null,
        finished: false,
      }
    },
  }
}
