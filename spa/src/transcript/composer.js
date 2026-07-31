import { messageDelta, messageSealed, messageTail, newMessageId } from './events.js'
import { joinText, mergeTail } from './transcriptStore.js'

// The Compose stage (docs 13): Deepgram output -> messages.
//
// This is where "when does a message end?" is decided, and it is decided in
// exactly one place. Pure JS — no React, no fetch, and the clock is injected —
// so the rules can be tested under plain node instead of only in a live kelabo,
// which is how every previous boundary bug had to be found.
//
// A MESSAGE IS COMMITTED TEXT PLUS A LIVE TAIL.
//
//   The tail is what Deepgram has heard but not yet confirmed. It is rendered
//   and relayed the moment it exists, so the room sees speech as it happens; it
//   is replaced wholesale on every revision; and it folds into the committed
//   text when Deepgram finalizes it. One box, growing — not a sealed box plus a
//   separate preview box beside it.
//
// THE SEAL RULE — Deepgram's output, and nothing else:
//
//   `silenceTimeoutMs` with no TEXT arriving seals the message. Empty results do
//   not count: Deepgram emits those continuously while it is receiving audio
//   with no speech in it, and treating them as activity kept the clock alive
//   forever, so a message never closed.
//
//   A message that has only ever produced a tail — no confirmed words at all —
//   waits `staleTimeoutMs` instead. Reaching that means Deepgram or the network
//   failed mid-utterance, so the message is closed on what was heard rather than
//   left hanging.
//
//   Caps: open longer than `maxOpenMs`, or more than `maxWords` words, seals on
//   the next finalization.
//
// The VAD gate deliberately gets no vote. It is a cost gate — it decides which
// audio is worth paying Deepgram to transcribe — and that is all. Letting it
// decide boundaries coupled the transcript to how a *room sounds*: where noise
// sits near speech level the gate latches open and a message never sealed.
//
// Other seals: speaker change (diarization), mute, stop, kelabo end. A remote
// participant speaking is deliberately NOT one: on a Kelabo call somebody is
// talking almost continuously, so sealing on remote speech shredded messages
// mid-sentence.

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

// CJK is not space-separated, so whitespace tokens alone would never reach the
// cap for Chinese, Japanese or Korean. Each CJK character is roughly a
// morpheme, which is the closest equivalent to a word here. Mixed text counts
// both.
const CJK_CHAR_G = /[぀-ヿ㐀-䶿一-鿿豈-﫿]/g
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

  /** @type {{id:string, key:string, speakerLabel:string, text:string, tail:string,
   *          tStart:number, tEnd:number, openedAt:number, seq:number}|null} */
  let open = null
  // When Deepgram last produced actual text. The only clock that matters.
  let lastTextAt = now()

  const isOpen = () => open !== null

  function openMessage(speakerLabel, key, tStart) {
    open = {
      id: newMessageId(),
      key,
      speakerLabel,
      text: '',
      tail: '',
      tStart,
      tEnd: tStart,
      openedAt: now(),
      seq: 0,
    }
    return open
  }

  /**
   * Deepgram's current guess at the words being spoken. Opens the message if this
   * is the first sign of speech, so the box appears — locally and for everyone
   * else — the instant there is anything to show.
   */
  function setTail({ text, speakerLabel, key = '__me', tStart = 0, tEnd = 0 }) {
    if (!text) return
    if (open && open.key !== key) seal('speaker_change')
    const msg = open ?? openMessage(speakerLabel, key, tStart)
    msg.speakerLabel = speakerLabel ?? msg.speakerLabel
    msg.tEnd = Math.max(msg.tEnd, tEnd)
    if (msg.tail === text) return // Deepgram re-sent an unchanged guess
    msg.tail = text
    lastTextAt = now()
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
   * Deepgram confirmed words. They join the committed text and the tail is
   * cleared — those words are no longer a guess.
   */
  function addFragment({ text, speakerLabel, key = '__me', tStart = 0, tEnd = 0 }) {
    if (!text) return
    if (open && open.key !== key) seal('speaker_change')
    const msg = open ?? openMessage(speakerLabel, key, tStart)
    msg.speakerLabel = speakerLabel ?? msg.speakerLabel
    lastTextAt = now()
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
    // cut at a boundary Deepgram considered complete.
    if (now() - msg.openedAt > cfg.maxOpenMs) seal('max_open_ms')
    else if (countWords(msg.text) > cfg.maxWords) seal('max_words')
  }

  /** Any Deepgram result carrying text. Empty results are not activity. */
  function noteActivity(hasText) {
    if (hasText) lastTextAt = now()
  }

  /**
   * The seal rule, polled rather than armed as a one-shot. A one-shot had to be
   * re-armed from every site that handled a Deepgram result, and the one site
   * that forgot sealed messages mid-sentence; asking a question the composer can
   * always answer removes that class of bug.
   *
   * @returns {boolean} true when it sealed.
   */
  function sealIfIdle() {
    if (!open) return false
    const idle = now() - lastTextAt
    // Everything Deepgram gave us is confirmed and it has gone quiet — the
    // speaker stopped. This is the ordinary path.
    if (!open.tail) {
      if (idle < cfg.silenceTimeoutMs) return false
      seal('silence')
      return true
    }
    // The last segment is still a guess. Deepgram normally confirms it within a
    // beat, so silence here means it or the network failed us mid-utterance.
    // Wait longer, then close on what was heard rather than hang forever.
    if (idle < cfg.staleTimeoutMs) return false
    seal('stt_stalled')
    return true
  }

  /**
   * Seal the open message. Any tail still outstanding is folded in: after the
   * seal nothing more can arrive for this message, so unconfirmed words are
   * either kept now or lost. Idempotent.
   */
  function seal(reason = 'silence') {
    const msg = open
    open = null
    if (!msg) return null
    // A message only ever opens on text, so there is always something to seal.
    const text = mergeTail(msg.text, msg.tail)
    if (!text) return null
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
    return msg.id
  }

  function reset() {
    open = null
    lastTextAt = now()
  }

  return {
    setTail,
    addFragment,
    seal,
    noteActivity,
    sealIfIdle,
    reset,
    isOpen,
    openMessageId: () => open?.id ?? null,
    config: cfg,
  }
}
