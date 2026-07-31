// The card book decides when the board stops waiting for an answer. Everything
// asserted here is invisible from the developer's terminal — a card that spins
// forever spins on other people's screens — so it can only be caught by a test.
import assert from "node:assert/strict";
import { createCardBook, DEFAULT_CARD_TTL_MS } from "../src/cards.js";

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
  } catch (err) {
    console.error(`FAIL ${name}`);
    throw err;
  }
}

test("an opened card is known, and carries its title", () => {
  const b = createCardBook();
  const ref = b.open({ title: "Retry policy", at: 1000 });
  assert.ok(ref, "a reference is returned");
  assert.equal(b.has(ref), true);
  assert.equal(b.title(ref), "Retry policy");
  assert.equal(b.size(), 1);
});

test("references are unique, so parallel lookups cannot collide", () => {
  // The whole point of background subagents is several at once. Two cards that
  // share a reference would render as one card overwriting itself.
  const b = createCardBook();
  const refs = new Set();
  for (let i = 0; i < 200; i++) refs.add(b.open({ title: `t${i}`, at: 1000 + i }));
  assert.equal(refs.size, 200);
  assert.equal(b.size(), 200);
});

test("a reference the book never issued is not accepted", () => {
  // An agent that invents a reference must be told, not silently written to a
  // card nobody is looking at.
  const b = createCardBook();
  assert.equal(b.has("c1made-up"), false);
  assert.equal(b.touch("c1made-up", { title: "x", at: 1 }), false);
  assert.equal(b.close("c1made-up"), false);
});

test("closing a card removes it, so the answer cannot land twice", () => {
  const b = createCardBook();
  const ref = b.open({ title: "One", at: 1000 });
  assert.equal(b.close(ref), true);
  assert.equal(b.has(ref), false);
  assert.equal(b.close(ref), false);
});

test("a card is abandoned only after the TTL, and named when it is", () => {
  const b = createCardBook({ ttlMs: 1000 });
  const ref = b.open({ title: "Slow lookup", at: 0 });

  assert.deepEqual(b.expire(999), [], "still within its time");
  assert.equal(b.size(), 1);

  const stale = b.expire(1000);
  assert.deepEqual(stale, [{ ref, title: "Slow lookup" }]);
  assert.equal(b.size(), 0, "an abandoned card is removed, not reported forever");
  assert.deepEqual(b.expire(10_000), [], "and never reported twice");
});

test("an update keeps a card alive", () => {
  // A long lookup that reports progress is working, not abandoned.
  const b = createCardBook({ ttlMs: 1000 });
  const ref = b.open({ title: "Long", at: 0 });
  assert.equal(b.touch(ref, { title: "Long", at: 900 }), true);
  assert.deepEqual(b.expire(1500), [], "the clock restarts on every update");
  assert.deepEqual(b.expire(1901).map((c) => c.ref), [ref]);
});

test("touch can rename a card but an empty title does not erase one", () => {
  const b = createCardBook();
  const ref = b.open({ title: "First", at: 0 });
  b.touch(ref, { title: "Second", at: 1 });
  assert.equal(b.title(ref), "Second");
  b.touch(ref, { title: "", at: 2 });
  assert.equal(b.title(ref), "Second", "a progress-only update keeps the heading");
});

test("only the stale cards expire", () => {
  const b = createCardBook({ ttlMs: 100 });
  const old = b.open({ title: "old", at: 0 });
  const fresh = b.open({ title: "fresh", at: 90 });
  assert.deepEqual(
    b.expire(100).map((c) => c.ref),
    [old]
  );
  assert.equal(b.has(fresh), true);
});

test("drain returns everything open and empties the book", () => {
  // Leaving a kelabo, or the kelabo ending: whatever is in flight is not
  // coming, and every one of them has to be landed.
  const b = createCardBook();
  const a = b.open({ title: "a", at: 0 });
  const c = b.open({ title: "c", at: 0 });
  const drained = b.drain();
  assert.deepEqual(drained.map((x) => x.ref).sort(), [a, c].sort());
  assert.deepEqual(drained.map((x) => x.title).sort(), ["a", "c"]);
  assert.equal(b.size(), 0);
  assert.deepEqual(b.drain(), []);
});

test("the default TTL is a backstop, not a deadline", () => {
  // If this ever drops near the length of a real lookup, slow answers start
  // being replaced by "the agent did not come back" while they are still running.
  assert.ok(DEFAULT_CARD_TTL_MS >= 10 * 60_000, "at least ten minutes");
  const b = createCardBook();
  const ref = b.open({ title: "t", at: 0 });
  assert.deepEqual(b.expire(9 * 60_000), [], "nine minutes is not abandonment");
  assert.deepEqual(b.expire(DEFAULT_CARD_TTL_MS).map((c) => c.ref), [ref]);
});

console.log(`cards: ${passed} tests passed`);
