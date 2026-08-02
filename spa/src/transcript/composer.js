import { messageDelta, messageSealed, messageTail, newMessageId } from './events.js'
import { joinText, mergeTail } from './transcriptStore.js'

// The Compose stage (docs 13): STT output -> messages.
//
// This is where "when does a message end?" is decided, and it is decided in
// exactly one place. Pure JS — no React, no fetch, and the clock is injected —
// so the rules can be tested under plain node instead of only in a live kelabo,
// which is how every previous boundary bug had to be found.
//
// A MESSAGE IS COMMITTED TEXT PLUS A LIVE TAIL.
//
//   The tail is what the provider has heard but not yet confirmed. It is
//   rendered and relayed the moment it exists, so the room sees speech as it
//   happens; it is replaced wholesale on every revision; and it folds into the
//   committed text when the provider finalizes it. One box, growing — not a
//   sealed box plus a separate preview box beside it.
//
// ONE OPEN MESSAGE PER SPEAKER, NOT ONE PER STREAM.
//
//   A single audio stream can carry several people — a room mic, a laptop on a
//   table — and a good diarizer separates them mid-sentence. Composing that into
//   one open message and sealing on every speaker change shredded both speakers
//   into fragments: A, B, A, B interleaving produced a seal per turn instead of
//   two messages. This is the same failure already recorded for remote speech
//   (sealing on it "shredded messages mid-sentence"); a shared microphone simply
//   moves it inside one stream.
//
//   So `open` is keyed by speaker and each message carries its OWN seal clock.
//   Speaker change is no longer a seal reason — a boundary is silence from that
//   speaker, which is what a speaker boundary actually is. Nothing downstream
//   needed changing for this: `apply()` is keyed by messageId and already folds
//   concurrent messages, and `insertOrdered` already places overlapping speakers
//   by when their speech started.
//
// THE SEAL RULE — the provider's output, and nothing else:
//
//   `silenceTimeoutMs` with no TEXT arriving for THAT SPEAKER seals their
//   message. Empty results do not count: providers emit those continuously while
//   receiving audio with no speech in it, and treating them as activity kept the
//   clock alive forever, so a message never closed.
//
//   A message that has only ever produced a tail — no confirmed words at all —
//   waits `staleTimeoutMs` instead. Reaching that means the provider or the
//   network failed mid-utterance, so the message is closed on what was heard
//   rather than left hanging.
//
//   Caps: open longer than `maxOpenMs`, or more than `maxWords` words, seals on
//   the next finalization.
//
// The VAD gate deliberately gets no vote. Letting it decide boundaries coupled
// the transcript to how a *room sounds*: where noise sits near speech level the
// gate latches open and a message never sealed.
//
// Other seals: mute, stop, kelabo end — all of which seal every open speaker.

export const COMPOSER_DEFAULTS = {
  silenceTimeoutMs: 1000,
  // Only unconfirmed text so far. Longer, because this is the failure path: give
  // a stalled transcription a real chance to recover before closing the message
  // on words it never confirmed.
  staleTimeoutMs: 5000,
  maxOpenMs: 60_000,
  // 250 words a minute is already very fast speech, so this and `maxOpenMs`
  // bound roughly the same thing from two directions. Both exist because the
  // failure they guard against — one unbounded message, so the agent hears
  // nothing for the rest of the kelabo and then receives everything at once —
  // is worth catching either way.
  maxWords: 250,
}

/** The key a message is filed under when the stream carries no speaker id. */
export const LOCAL_SPEAKER = '__me'

// CJK is not space-separated, so whitespace tokens alone would never reach the
// cap for Chinese, Japanese or Korean. Each CJK character is roughly a
// morpheme, which is the closest equivalent to a word here. Mixed text counts
// both.
const CJK_CHAR_G = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g
export function countWords(text) {
  if (!text) return 0
  const cjk = (text.match(CJK_CHAR_G) || []).length
  const rest = text.replace(CJK_CHAR_G, ' ').trim()
  return cjk + (rest ? rest.split(/\s+/).length : 0)
}

/**
 * @param {{ speakerId: string, emit: (event) => void,
 *           now?: () => number, ...Partial<typeof COMPOSER_DEFAULTS> }} opts
 */
export function createComposer({ speakerId, emit, now = () => Date.now(), ...overrides }) {
  const cfg = { ...COMPOSER_DEFAULTS, ...overrides }

  /** Open messages by speaker key, in the order their speakers first spoke.
   *  @type {Map<string, {id:string, key:string, speakerLabel:string, text:string,
   *                      tail:string, tStart:number, tEnd:number, openedAt:number,
   *                      lastTextAt:number, seq:number}>} */
  const open = new Map()

  function openMessage(key, speakerLabel, tStart) {
    const msg = {
      id: newMessageId(),
      key,
      speakerLabel,
      text: '',
      tail: '',
      tStart,
      tEnd: tStart,
      openedAt: now(),
      lastTextAt: now(),
      seq: 0,
    }
    open.set(key, msg)
    return msg
  }

  /**
   * The provider's current guess at the words one speaker is saying. Opens their
   * message if this is the first sign of speech, so the box appears — locally and
   * for everyone else — the instant there is anything to show.
   */
  function setTail({ text, speakerLabel, key = LOCAL_SPEAKER, tStart = 0, tEnd = 0 }) {
    if (!text) return
    const msg = open.get(key) ?? openMessage(key, speakerLabel, tStart)
    msg.speakerLabel = speakerLabel ?? msg.speakerLabel
    msg.tEnd = Math.max(msg.tEnd, tEnd)
    if (msg.tail === text) return // the provider re-sent an unchanged guess
    msg.tail = text
    msg.lastTextAt = now()
    emit(
      messageTail({
        messageId: msg.id,
        speakerId,
        speakerLabel: msg.speakerLabel,
        text,
        tStart: msg.tStart,
        tEnd: msg.tEnd,
      }),
    )
  }

  /**
   * The provider confirmed words for one speaker. They join that speaker's
   * committed text and their tail is cleared — those words are no longer a guess.
   */
  function addFragment({ text, speakerLabel, key = LOCAL_SPEAKER, tStart = 0, tEnd = 0 }) {
    if (!text) return
    const msg = open.get(key) ?? openMessage(key, speakerLabel, tStart)
    msg.speakerLabel = speakerLabel ?? msg.speakerLabel
    msg.lastTextAt = now()
    msg.text = joinText(msg.text, text)
    msg.tail = ''
    msg.tEnd = Math.max(msg.tEnd, tEnd)
    const seq = msg.seq++

    emit(
      messageDelta({
        messageId: msg.id,
        speakerId,
        speakerLabel: msg.speakerLabel,
        seq,
        text,
        tStart,
        tEnd: msg.tEnd,
      }),
    )

    // Caps seal on a finalization, never mid-fragment, so a message is always
    // cut at a boundary the provider considered complete.
    if (now() - msg.openedAt > cfg.maxOpenMs) seal('max_open_ms', key)
    else if (countWords(msg.text) > cfg.maxWords) seal('max_words', key)
  }

  /**
   * The speakers a provider result carried text for. Their clocks are held open;
   * every other open speaker's keeps running.
   *
   * This exists as its own call because text does not always reach `setTail`: in
   * `finalOnly` mode guesses are discarded before they are shown, and a provider
   * may confirm a span it has already committed. Both are still that speaker
   * talking, and both must keep their message open — the alternative is sealing
   * mid-sentence and posting half an utterance.
   *
   * @param {string[]} keys speaker keys carrying text; empty means idle.
   */
  function noteActivity(keys) {
    if (!keys || !keys.length) return
    const t = now()
    for (const key of keys) {
      const msg = open.get(key)
      if (msg) msg.lastTextAt = t
    }
  }

  /**
   * The seal rule, applied per speaker and polled rather than armed as a
   * one-shot. A one-shot had to be re-armed from every site that handled a
   * provider result, and the one site that forgot sealed messages mid-sentence;
   * asking a question the composer can always answer removes that class of bug.
   *
   * @returns {boolean} true when it sealed at least one message.
   */
  function sealIfIdle() {
    if (!open.size) return false
    const t = now()
    let sealed = false
    for (const [key, msg] of [...open]) {
      const idle = t - msg.lastTextAt
      if (msg.tail) {
        // The last segment is still a guess. It is normally confirmed within a
        // beat, so silence here means the provider or the network failed us
        // mid-utterance. Wait longer, then close on what was heard.
        if (idle < cfg.staleTimeoutMs) continue
        seal('stt_stalled', key)
      } else {
        // Everything is confirmed and this speaker has gone quiet — they
        // stopped. This is the ordinary path.
        if (idle < cfg.silenceTimeoutMs) continue
        seal('silence', key)
      }
      sealed = true
    }
    return sealed
  }

  /**
   * Seal one speaker's open message, or every open message when `key` is
   * omitted (mute, stop, kelabo end). Any tail still outstanding is folded in:
   * after the seal nothing more can arrive for that message, so unconfirmed
   * words are either kept now or lost. Idempotent.
   *
   * @returns {string[]} the message ids sealed, in order.
   */
  function seal(reason = 'silence', key = undefined) {
    const keys = key === undefined ? [...open.keys()] : [key]
    const ids = []
    for (const k of keys) {
      const msg = open.get(k)
      if (!msg) continue
      open.delete(k)
      // A message only ever opens on text, so there is always something to seal.
      const text = mergeTail(msg.text, msg.tail)
      if (!text) continue
      emit(
        messageSealed({
          messageId: msg.id,
          speakerId,
          speakerLabel: msg.speakerLabel,
          text,
          tStart: msg.tStart,
          tEnd: msg.tEnd,
          reason,
        }),
      )
      ids.push(msg.id)
    }
    return ids
  }

  function reset() {
    open.clear()
  }

  return {
    setTail,
    addFragment,
    seal,
    noteActivity,
    sealIfIdle,
    reset,
    openKeys: () => [...open.keys()],
    openMessageIds: () => [...open.values()].map(m => m.id),
    config: cfg,
  }
}
