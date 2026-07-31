// Imports inside spa/src/transcript/ carry the .js extension (unlike the rest of
// the SPA, which relies on Vite's resolution) because these modules are also
// loaded by plain node in spa/test/transcript.mjs, and node ESM requires it.

// Deepgram's streaming wire format, in one pure function — the front half of
// the Capture stage (docs 13).
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
// WHY THE PAUSE SIGNALS ARE IGNORED HERE. Message boundaries are the composer's
// decision (docs 13, I5/I5a), and both signals are unreliable in this app by
// construction: the VAD gate removes silence before it is ever sent, so
// `endpointing` sees almost none, and `utterance_end_ms` measures gaps between
// word timings — on Deepgram's audio clock our words are contiguous even when
// the speaker stopped for a minute. `Finalize` (sent when the gate shuts) is no
// substitute either: Deepgram documents that its `from_finalize` answer is *not
// guaranteed* when little audio is buffered.
//
// Holding a final back until one of those arrived is what stranded them: the
// text stayed an unconfirmed tail for the whole utterance, so nothing was
// persisted or shown to the LLM until the message eventually sealed as stalled.
// A final is authoritative when it arrives, so it is read as settled here and
// committed immediately.
//
// Pure: no React, no socket, no clock. The caller maps segments onto the
// composer and converts Deepgram's audio clock to wall time.

/** Group a result's words into runs by diarization speaker. */
export function segmentWords(words, joiner = ' ') {
  const segs = []
  for (const w of words || []) {
    const word = w.punctuated_word || w.word
    if (!word) continue
    const sp = w.speaker ?? 0
    const last = segs[segs.length - 1]
    if (last && last.sp === sp) {
      last.text += (last.text ? joiner : '') + word
      last.end = w.end
    } else {
      segs.push({ sp, text: word, start: w.start, end: w.end })
    }
  }
  return segs
}

/**
 * Read one Deepgram websocket message.
 *
 * @param {any} msg parsed frame
 * @param {{cursor?:number, diarize?:boolean, joiner?:string}} opts `cursor` is
 *        the end of the audio span already finalized.
 * @returns {{kind:'final'|'interim'|'covered'|'idle'|'other', hasText:boolean,
 *            text?:string, cursor?:number, segments?:Array, speaker?:number,
 *            tStart?:number, tEnd?:number}}
 *   `hasText` drives the seal clock — empty results are not activity, and
 *   Deepgram emits them continuously while receiving audio with no speech in
 *   it. `cursor`, when present, is the caller's new cursor.
 */
export function readResult(msg, { cursor = 0, diarize = false, joiner = ' ' } = {}) {
  const alt = msg?.channel?.alternatives?.[0]
  // UtteranceEnd, SpeechStarted, Metadata: no transcript, nothing to read.
  if (!alt) return { kind: 'other', hasText: false }

  const text = alt.transcript || ''
  const words = alt.words || []

  if (!msg.is_final) {
    if (!text) return { kind: 'idle', hasText: false }
    return {
      kind: 'interim',
      hasText: true,
      // An interim covers only the segment in progress. The finals before it are
      // already the composer's committed text, and joining the two is
      // `mergeTail`'s job alone — the same function the view and the seal use,
      // so all three agree by construction.
      text: diarize ? segmentWords(words, joiner).map(s => s.text).join(joiner) || text : text,
      speaker: words.length ? (words[0].speaker ?? 0) : 0,
      tStart: words[0]?.start ?? 0,
      tEnd: words[words.length - 1]?.end ?? 0,
    }
  }

  // Every response covers [start, start + duration], and is_final makes it
  // authoritative for that span. The span is therefore the identity of the
  // finalized audio, which is what makes a re-emission detectable.
  const spanStart = typeof msg.start === 'number' ? msg.start : 0
  const spanEnd =
    typeof msg.duration === 'number'
      ? spanStart + msg.duration
      : words.reduce((m, w) => Math.max(m, w.end || 0), 0)

  // Deepgram re-emits a final for a span it has already finalized (CJK models do
  // this routinely). Already covered means already committed — and the cursor
  // must NOT move backwards.
  if (spanEnd <= cursor + 1e-3) return { kind: 'covered', hasText: !!text, text }
  // An empty final still advances the cursor: that audio is settled, there was
  // just no speech in it.
  if (!text) return { kind: 'idle', hasText: false, cursor: spanEnd }

  let segments
  if (!diarize && spanStart >= cursor - 1e-3) {
    // Non-diarized and the whole span is new: the response transcript is
    // authoritative. (zh word lists mix phrase- and token-level entries, so
    // re-joining words duplicates text; words are only needed for diarization
    // speaker labels.)
    segments = [{ sp: 0, text, start: spanStart, end: spanEnd }]
  } else {
    // Partially covered, or diarized: rebuild from the words this result adds,
    // so text already committed by an earlier final is not repeated.
    segments = segmentWords(words.filter(w => (w.end ?? Infinity) > cursor + 1e-3), joiner)
    if (!segments.length && !words.length) {
      segments = [{ sp: 0, text, start: spanStart, end: spanEnd }]
    }
  }

  return { kind: 'final', hasText: true, text, cursor: spanEnd, segments }
}
