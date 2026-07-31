import { ASSISTANT_NAME } from "./persona.js";

/**
 * Addressing the assistant in **typed** text.
 *
 * Deliberately nothing like the speech path. Spoken address is fuzzy and has to
 * be — `ADDRESSED_NOTE` lists a dozen ways speech-to-text mangles "Kelabo", and
 * a model weighs them against context. Typed text has no such excuse: the person
 * saw what they wrote. So this is an exact match on an explicit mention, and it
 * is a *decision*, not a hint — an addressed message skips the trigger gate
 * entirely and always gets an answer.
 *
 * That is the whole reason the two must not share an implementation. Making the
 * typed matcher tolerant would mean typing "our book club" in the transcript
 * panel forced a lookup that nobody asked for, with no gate left to stop it.
 */

const NAME = ASSISTANT_NAME.toLowerCase();

// `@kelabo` anywhere, or the bare name in vocative position at the very start
// ("kelabo, what's …" / "kelabo: check …"). A bare name mid-sentence is not an
// address — "I asked kelabo yesterday" is a remark about it, not to it.
const AT_MENTION = new RegExp(`(^|[^\\p{L}\\p{N}_])@${NAME}\\b`, "iu");
const VOCATIVE = new RegExp(`^\\s*${NAME}\\s*[,:—-]\\s*\\S`, "iu");

/** Is this typed message addressed to the assistant? */
export function addressesAssistant(text) {
  const s = String(text || "");
  return AT_MENTION.test(s) || VOCATIVE.test(s);
}

/**
 * The message without the address, for use as a question on its own.
 *
 * The mention is how you got the assistant's attention, not part of what you
 * asked — leaving it in produced board cards titled "@kelabo what is the retry
 * policy". If stripping leaves nothing (someone typed just "@kelabo"), the
 * original is returned rather than an empty string: an empty query downstream is
 * far worse than a redundant one.
 */
export function stripAddress(text) {
  const s = String(text || "");
  const out = s
    .replace(AT_MENTION, (m) => (m[0] === "@" ? "" : m[0]))
    .replace(VOCATIVE, (m) => m.slice(m.length - 1))
    // Removing a mention from the middle of a sentence leaves the space on
    // either side of it behind.
    .replace(/\s{2,}/g, " ")
    .trim();
  return out || s.trim();
}
