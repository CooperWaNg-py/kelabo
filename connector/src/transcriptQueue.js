// Backpressure between a kelabo that never pauses and an agent that does
// (docs 16 §1).
//
// Pure — no MCP, no fetch, an injected clock — so `test/queue.mjs` can run it
// under plain node.
//
// The problem this exists for: the developer's session is interactive. A
// permission prompt stops the agent until a human answers it, and the kelabo
// keeps talking meanwhile. The previous implementation fired one prompt per
// caption with no coordination at all, which piles up a queue of turns the agent
// works through long after the moment has passed.
//
// So: exactly one batch in flight, everything that arrives meanwhile coalesces
// into the next one, and the backlog is bounded. Dropping the oldest is the
// right trade for a live conversation — stale context is worse than absent
// context — but it is never silent, because a gap the agent cannot see reads as
// a speaker changing their mind mid-sentence.

const DEFAULT_MAX = 60;

export function createTranscriptQueue({ maxBacklog = DEFAULT_MAX } = {}) {
  /** @type {Array<{messageId:string,seq:number,speaker:string,text:string,at:number,human:boolean}>} */
  let buffer = [];
  let dropped = 0;
  let inFlight = false;
  // Sealed messages are the unit here (docs 13), so redelivery after a socket
  // reconnect is detectable rather than being appended a second time.
  const seen = new Set();

  function push(msg) {
    const key = msg.messageId ? `${msg.messageId}:${msg.seq ?? 0}` : "";
    if (key) {
      if (seen.has(key)) return false;
      seen.add(key);
      // The window only needs to outlive a reconnect, not the kelabo.
      if (seen.size > maxBacklog * 4) {
        const it = seen.values();
        for (let i = 0; i < maxBacklog; i++) seen.delete(it.next().value);
      }
    }
    buffer.push(msg);
    if (buffer.length > maxBacklog) {
      dropped += buffer.length - maxBacklog;
      buffer = buffer.slice(-maxBacklog);
    }
    return true;
  }

  /** Take everything pending, if nothing is already in flight. Returns null when
   *  there is nothing to send or a batch is still outstanding — the caller does
   *  not have to track either. */
  function take() {
    if (inFlight || buffer.length === 0) return null;
    const messages = buffer;
    const gap = dropped;
    buffer = [];
    dropped = 0;
    inFlight = true;
    return { messages, dropped: gap };
  }

  /** The in-flight batch finished (or failed). Call in a `finally`: a batch that
   *  is never released wedges the queue for the rest of the kelabo. */
  function done() {
    inFlight = false;
  }

  function size() {
    return buffer.length;
  }

  function isBusy() {
    return inFlight;
  }

  function reset() {
    buffer = [];
    dropped = 0;
    inFlight = false;
    seen.clear();
  }

  return { push, take, done, size, isBusy, reset };
}
