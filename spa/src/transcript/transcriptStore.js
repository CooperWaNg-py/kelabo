// Imports inside spa/src/transcript/ carry the .js extension (unlike the rest of
// the SPA, which relies on Vite's resolution) because these modules are also
// loaded by plain node in spa/test/transcript.mjs, and node ESM requires it.
import { DELTA, SEALED, TAIL } from './events.js'

// The Project stage (docs 13): events -> Transcript. One pure reducer, used by
// BOTH the local composer's output and the events arriving over SSE.
//
// That sharing is the point. Previously the speaker's own view was assembled by
// one piece of code (a line per fragment, merged afterwards by the renderer) and
// the listener's by another (a line per message, mutated in place). Two
// implementations of one concept meant a speaker and a listener could group the
// same speech differently — and they did. With a single `apply` they cannot.
//
// Pure: no React, no fetch, no clock. Every field it needs is on the event, so
// it can be exercised under plain node (spa/test/transcript.mjs).

const CJK_CHAR = /[぀-ヿ㐀-䶿一-鿿豈-﫿＀-￯　-〿]/

// CJK text is not space-separated; inserting a space between fragments corrupts it.
export function joinText(a, b) {
  if (!a) return b || ''
  if (!b) return a
  return CJK_CHAR.test(a.slice(-1)) || CJK_CHAR.test(b.charAt(0)) ? a + b : `${a} ${b}`
}

const NOISE = /[\s\p{P}\p{S}]+/gu
const SEPARATOR = /^[\s\p{P}\p{S}]+/u
const bare = s => String(s || '').toLowerCase().replace(NOISE, '')

/**
 * The full text of a message: confirmed words plus the outstanding guess.
 *
 * Deepgram's interims often restate the *whole* utterance rather than only the
 * new tail — CJK models do it routinely — so a naive append shows every word
 * twice. When the guess already contains the confirmed text, it replaces it
 * wholesale; otherwise it is appended.
 *
 * Used by both the view and the composer's seal, so what is displayed and what
 * is finally recorded can never disagree.
 */
export function mergeTail(text, tail) {
  if (!tail) return text || ''
  if (!text) return tail
  return bare(tail).startsWith(bare(text)) ? tail : joinText(text, tail)
}

/** Everything a reader should see for this message. */
export function messageText(message) {
  return message ? mergeTail(message.text, message.tail) : ''
}

/**
 * Split what a reader sees into the part that is settled and the part that is
 * still a guess, with `settled + live === messageText(message)` always.
 *
 * The view needs this because a long message is mostly confirmed: only its last
 * few words are outstanding. Styling the whole box as provisional made a
 * minute of settled transcript flicker as if it were about to change, and hid
 * the one thing the live style is for — where Deepgram has actually got to.
 *
 * It cannot be done in the view, because a tail may *restate* the confirmed
 * words rather than follow them (see `mergeTail`), so the boundary is not
 * `text.length`. It is found by walking the tail until it has covered as much
 * bare text as `message.text` holds; the separating whitespace goes to the
 * settled side so the live part starts on a word.
 */
export function messageParts(message) {
  const text = message?.text || ''
  const tail = message?.tail || ''
  if (!tail) return { settled: text, live: '' }
  if (!text) return { settled: '', live: tail }

  const target = bare(text)
  // Appended, not restated: the tail is exactly the new words, plus whatever
  // separator joinText would have inserted.
  if (!bare(tail).startsWith(target)) {
    const whole = joinText(text, tail)
    return { settled: text, live: whole.slice(text.length) }
  }

  let seen = ''
  let i = 0
  for (const ch of tail) {
    if (seen.length >= target.length) break
    seen += bare(ch)
    i += ch.length
  }
  // Alignment failed (a character whose lowercase form is longer than itself
  // overshot). Rather than cut the text in the wrong place, show it all as live.
  if (seen !== target) return { settled: '', live: tail }
  // Whatever `bare` strips — the separating space, the comma the guess added —
  // belongs to the words before it, so the live part starts on a real word.
  const sep = SEPARATOR.exec(tail.slice(i))
  if (sep) i += sep[0].length
  return { settled: tail.slice(0, i), live: tail.slice(i) }
}

/** A message is committed text plus a live `tail` of words Deepgram has heard
 *  but not confirmed. The view renders `text + tail` as one growing box; only
 *  `text` is ever persisted or shown to the LLM.
 *  @typedef {{messageId:string, speakerId:string, speakerLabel:string, text:string,
 *             tail:string, tStart:number, tEnd:number, state:'open'|'sealed',
 *             mine:boolean, deltas:number, at:number, seenSeq:number[]}} Message */

export function emptyTranscript() {
  return { byId: new Map(), order: [] }
}

/** Messages in transcript order — what the view renders, and nothing else. */
export function messages(state) {
  return state.order.map(id => state.byId.get(id)).filter(Boolean)
}

export function getMessage(state, messageId) {
  return state.byId.get(messageId) ?? null
}

// Ordered by when the speech started, falling back to arrival. Insertion keeps
// the array sorted so a late-arriving message from an overlapping speaker lands
// in the right place rather than at the end.
function insertOrdered(order, byId, message) {
  const key = m => (m.tStart ?? 0) * 1e6 + (m.at ?? 0) % 1e6
  const k = key(message)
  let lo = 0
  let hi = order.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    const other = byId.get(order[mid])
    if (other && key(other) <= k) lo = mid + 1
    else hi = mid
  }
  order.splice(lo, 0, message.messageId)
}

/**
 * Fold one event into the transcript.
 *
 * @param {ReturnType<typeof emptyTranscript>} state
 * @param {{type:string, messageId:string}} event
 * @param {{mine?:boolean, at?:number}} [meta] `mine` marks locally composed speech
 *        (display only — it never affects grouping).
 * @returns a new state when something changed, otherwise the state unchanged.
 */
export function apply(state, event, meta = {}) {
  if (!event || !event.messageId) return state
  const existing = state.byId.get(event.messageId)

  if (event.type === TAIL) {
    // A guess, replaced wholesale each revision — never appended, or every
    // revision would pile the same words up again.
    if (existing && existing.state === 'sealed') return state
    const message = existing
      ? { ...existing, tail: event.text, tEnd: Math.max(existing.tEnd, event.tEnd ?? 0) }
      : {
          messageId: event.messageId,
          speakerId: event.speakerId,
          speakerLabel: event.speakerLabel,
          text: '',
          tail: event.text,
          tStart: event.tStart ?? 0,
          tEnd: event.tEnd ?? 0,
          state: 'open',
          mine: !!meta.mine,
          deltas: 0,
          at: meta.at ?? Date.now(),
          seenSeq: [],
        }
    return commit(state, message, !existing)
  }

  if (event.type === DELTA) {
    // A delta that arrives after its seal is stale — the sealed text is
    // authoritative and must never be appended to or reopened. This happens
    // routinely: the seal is posted while the last delta is still in flight.
    if (existing && existing.state === 'sealed') return state
    // Deltas can be redelivered; `seq` makes that detectable, and re-applying
    // one would duplicate its words inside the message.
    if (existing && event.seq != null && existing.seenSeq.includes(event.seq)) return state

    const message = existing
      ? {
          ...existing,
          text: joinText(existing.text, event.text),
          // These words are confirmed now, so they are no longer a guess.
          tail: '',
          tEnd: Math.max(existing.tEnd, event.tEnd ?? 0),
          deltas: existing.deltas + 1,
          seenSeq: event.seq == null ? existing.seenSeq : [...existing.seenSeq, event.seq],
        }
      : {
          messageId: event.messageId,
          speakerId: event.speakerId,
          speakerLabel: event.speakerLabel,
          text: event.text,
          tail: '',
          tStart: event.tStart ?? 0,
          tEnd: event.tEnd ?? 0,
          state: 'open',
          mine: !!meta.mine,
          deltas: 1,
          at: meta.at ?? Date.now(),
          seenSeq: event.seq == null ? [] : [event.seq],
        }
    return commit(state, message, !existing)
  }

  if (event.type === SEALED) {
    // The sealed text is the whole message, so it REPLACES whatever the deltas
    // built. That is what makes a dropped or duplicated delta self-healing
    // rather than a permanently corrupted line.
    if (existing && existing.state === 'sealed') return state
    const message = {
      messageId: event.messageId,
      speakerId: event.speakerId ?? existing?.speakerId ?? '',
      speakerLabel: event.speakerLabel ?? existing?.speakerLabel ?? '?',
      text: event.text,
      // The sealed text is the whole message, guesses included or discarded by
      // the composer. Nothing is outstanding any more.
      tail: '',
      tStart: event.tStart ?? existing?.tStart ?? 0,
      tEnd: Math.max(event.tEnd ?? 0, existing?.tEnd ?? 0),
      state: 'sealed',
      mine: existing ? existing.mine : !!meta.mine,
      deltas: existing?.deltas ?? 0,
      at: existing?.at ?? meta.at ?? Date.now(),
      seenSeq: existing?.seenSeq ?? [],
      reason: event.reason,
      // 'typed' when a participant wrote this instead of saying it. Display
      // only — it changes nothing about grouping, ordering or persistence.
      source: event.source,
    }
    return commit(state, message, !existing)
  }

  return state
}

function commit(state, message, isNew) {
  const byId = new Map(state.byId)
  byId.set(message.messageId, message)
  let order = state.order
  if (isNew) {
    order = [...state.order]
    insertOrdered(order, byId, message)
  }
  return { byId, order }
}

/** Drop every message of a kelabo — used when the transcript is reset. */
export function clear() {
  return emptyTranscript()
}

/**
 * Relabel a speaker across the transcript (the `rename` SSE event). Label only:
 * message text and boundaries are immutable once sealed.
 */
export function renameSpeaker(state, from, to) {
  if (!from || !to || from === to) return state
  let changed = false
  const byId = new Map()
  for (const [id, m] of state.byId) {
    if (m.speakerLabel === from) {
      byId.set(id, { ...m, speakerLabel: to })
      changed = true
    } else {
      byId.set(id, m)
    }
  }
  return changed ? { byId, order: state.order } : state
}
