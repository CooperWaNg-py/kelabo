// Imports inside spa/src/transcript/ carry the .js extension (unlike the rest of
// the SPA, which relies on Vite's resolution) because these modules are also
// loaded by plain node in spa/test/transcript.mjs, and node ESM requires it.

// Provider speaker ids -> the A/B/C labels the rest of Kelabo speaks in.
//
// WHY THIS IS NOT THE PROVIDER'S JOB. Every STT provider numbers speakers
// differently: Deepgram emits 0-based integers, Soniox 1-based strings, and
// nothing stops the next one using names or uuids. If each provider did its own
// arithmetic, the mapping would be reimplemented per provider and the labels
// would drift between them — the same class of bug that one transcript reducer
// exists to prevent. Providers therefore emit an OPAQUE speaker id and this
// module, shared and pure, is the only place that decides what to call it.
//
// WHY FIRST-SEEN ORDER, NOT THE PROVIDER'S INDEX. The index is the provider's
// internal numbering and it is not stable in the way a reader assumes. After a
// reconnect Soniox may hand back speaker "3" for the first person who talks;
// mapping the index straight to a letter would label them "C" and leave "A" and
// "B" belonging to nobody. Assigning in order of first appearance means the
// first voice in a stream is always A, whatever the provider called it.
//
// A label is a single uppercase letter because that is what the gateway accepts
// as a diarization label (`DIARIZATION_LABEL` in gateway/src/caption.js) and
// what the host's rename flow renames. Beyond 26 speakers every further voice
// is labelled Z rather than falling off the alphabet into a label the gateway
// would reject; no real-time provider supports anywhere near that many (Soniox
// caps at 15), so the clamp is a guard, not a path anyone should reach.

const FIRST = 'A'.charCodeAt(0)
export const MAX_LABELS = 26

/**
 * @returns {{labelFor: (id: string) => string, known: () => Map<string,string>,
 *            count: () => number, reset: () => void}}
 */
export function createSpeakerLabels() {
  /** @type {Map<string,string>} */
  const byId = new Map()

  return {
    /**
     * The label for a provider speaker id, assigning one on first sight.
     * Stable for the lifetime of this labeller.
     */
    labelFor(id) {
      const key = String(id ?? '')
      const seen = byId.get(key)
      if (seen) return seen
      const label = String.fromCharCode(FIRST + Math.min(byId.size, MAX_LABELS - 1))
      byId.set(key, label)
      return label
    },

    known: () => new Map(byId),
    count: () => byId.size,

    /**
     * Forget every assignment. Called when the socket is replaced: a provider
     * renumbers its speakers on a new stream, so holding the old map would
     * silently attach an existing label — and any rename the host has already
     * applied to it — to a different person. Starting over is not correct
     * either, but it is honestly wrong rather than invisibly wrong.
     */
    reset() {
      byId.clear()
    },
  }
}
