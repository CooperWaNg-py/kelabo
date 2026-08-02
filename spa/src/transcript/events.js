// Transcript concepts (docs 13). These five nouns are the whole vocabulary; every
// stage of the pipeline speaks in them and nothing invents its own shape.
//
//   Fragment       one confirmed piece from the STT provider. Client-internal — it
//                  never crosses
//                  a boundary on its own, only folded into a delta.
//   Message        what a speaker produces between two seals. The unit of display,
//                  persistence and LLM submission.
//   MessageDelta   an append to an open message. The live wire event.
//   MessageSealed  the authoritative final form; replaces whatever the deltas built.
//   Transcript     ordered messages — the only thing the view renders.
//
// `messageId` is minted by the speaker and is the SOLE grouping key, everywhere.
// Nothing downstream re-derives message boundaries from speaker identity,
// adjacency or timing: doing that in two places is what let a speaker and a
// listener disagree about where one message ended and the next began.

// A message is committed text plus a live tail. The tail is the words the
// provider has heard but not yet confirmed: shown and relayed immediately so the
// room sees speech as it happens, replaced wholesale on each revision, and
// folded into the committed text when the provider confirms them.
export const TAIL = 'tail'
export const DELTA = 'delta'
export const SEALED = 'sealed'

let seq = 0

/**
 * Mint a message id. Unique per speaker per kelabo; the random half keeps two
 * clients from colliding, the counter keeps one client's ids ordered.
 */
export function newMessageId() {
  const rand = globalThis.crypto?.randomUUID
    ? globalThis.crypto.randomUUID().slice(0, 8)
    : Math.random().toString(36).slice(2, 10)
  return `${rand}-${++seq}`
}

/** @returns {{type:'delta', messageId:string, speakerId:string, speakerLabel:string, seq:number, text:string, tStart:number, tEnd:number}} */
export function messageDelta({ messageId, speakerId, speakerLabel, seq: n, text, tStart, tEnd }) {
  return { type: DELTA, messageId, speakerId, speakerLabel, seq: n, text, tStart, tEnd }
}

/** Live, still-unconfirmed words. Replaces the previous tail rather than appending. */
export function messageTail({ messageId, speakerId, speakerLabel, text, tStart, tEnd }) {
  return { type: TAIL, messageId, speakerId, speakerLabel, text, tStart, tEnd }
}

/**
 * `source` is 'typed' for a message somebody wrote in the transcript panel and
 * absent for speech. It rides the sealed event, not a separate one, because a
 * typed message IS a message — same id, same reducer, same bubble — and giving
 * it its own event type would be the second implementation of grouping this
 * whole module exists to prevent.
 *
 * @returns {{type:'sealed', messageId:string, speakerId:string, speakerLabel:string, text:string, tStart:number, tEnd:number, reason:string, source?:string}}
 */
export function messageSealed({ messageId, speakerId, speakerLabel, text, tStart, tEnd, reason, source }) {
  return { type: SEALED, messageId, speakerId, speakerLabel, text, tStart, tEnd, reason, source }
}

/**
 * Map a caption fanned out by the gateway onto the same event a local composer
 * emits. This is the join point that makes one reducer serve both paths: after
 * this call nothing downstream can tell whether an event was spoken here or
 * received from someone else, which is precisely why the two views cannot drift.
 */
export function fromWire(utt) {
  if (!utt || !utt.messageId) return null
  const speakerId = utt.by || utt.speaker || ''
  if (!utt.text) return null
  const common = {
    messageId: utt.messageId,
    speakerId,
    speakerLabel: utt.speaker || '?',
    text: utt.text,
    tStart: utt.tStart ?? 0,
    tEnd: utt.tEnd ?? 0,
  }
  if (utt.kind === TAIL) return messageTail(common)
  if (utt.kind === DELTA || utt.partial) return messageDelta({ ...common, seq: utt.seq ?? 0 })
  return messageSealed({ ...common, reason: utt.reason || 'remote', source: utt.source })
}
