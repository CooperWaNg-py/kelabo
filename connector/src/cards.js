// Which board cards this session has open, and when to give up on one.
//
// Pure — no tunnel, no clock of its own — because the failure it prevents is
// invisible from the terminal. A card is opened the moment the agent takes a
// question and finished when it answers; if the agent never comes back (a
// background subagent that dies, a turn the developer interrupts, a kelabo
// that ends mid-lookup) the card spins on every participant's board for the
// rest of the kelabo. Nobody at the developer's terminal can see that, so it
// cannot be caught by using the thing — only by a test.
//
// Sweeping is deliberately lazy: `expire()` is called from the paths that
// already run (a tool call, a transcript batch) rather than from a timer. A
// timer here would be a second thing to shut down and would keep the bridge's
// event loop alive after the kelabo.

/** How long a card may stay open with no update before it is abandoned. Longer
 *  than any sane lookup — this is a backstop, not a deadline. */
export const DEFAULT_CARD_TTL_MS = 15 * 60_000;

export function createCardBook({ ttlMs = DEFAULT_CARD_TTL_MS } = {}) {
  /** @type {Map<string, {title: string, at: number}>} */
  const open = new Map();
  let seq = 0;

  /** Open a card and return the reference the agent uses to update it. The
   *  reference is ours, not the agent's: an agent that invents one gets an
   *  error it can act on rather than silently writing to a card nobody sees. */
  function open_({ title = "", at }) {
    seq += 1;
    const ref = `c${seq.toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    open.set(ref, { title, at });
    return ref;
  }

  function touch(ref, { title, at }) {
    const card = open.get(ref);
    if (!card) return false;
    if (title) card.title = title;
    card.at = at;
    return true;
  }

  function close(ref) {
    return open.delete(ref);
  }

  function has(ref) {
    return open.has(ref);
  }

  function title(ref) {
    return open.get(ref)?.title || "";
  }

  function size() {
    return open.size;
  }

  /** Cards untouched for longer than the TTL, removed and returned so the
   *  caller can land them on the board. */
  function expire(at) {
    const stale = [];
    for (const [ref, card] of open) {
      if (at - card.at >= ttlMs) stale.push({ ref, title: card.title });
    }
    for (const { ref } of stale) open.delete(ref);
    return stale;
  }

  /** Every open card, removed. Used when the kelabo ends or the agent leaves:
   *  whatever was in flight is not coming, and saying so beats a spinner. */
  function drain() {
    const all = [...open].map(([ref, card]) => ({ ref, title: card.title }));
    open.clear();
    return all;
  }

  return { open: open_, touch, close, has, title, size, expire, drain };
}
