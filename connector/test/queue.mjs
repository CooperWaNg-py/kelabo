// The transcript queue is what stands between a kelabo that never pauses and an
// agent that does. Everything asserted here is a thing that was, or would be,
// only visible in a live kelabo.
import assert from "node:assert/strict";
import { createTranscriptQueue } from "../src/transcriptQueue.js";

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

const msg = (i, over = {}) => ({
  messageId: `m${i}`,
  seq: 0,
  speaker: "Alice",
  text: `line ${i}`,
  at: 1000 + i,
  human: false,
  ...over,
});

test("nothing pending yields no batch", () => {
  const q = createTranscriptQueue();
  assert.equal(q.take(), null);
});

test("messages that arrive while a batch is in flight coalesce into the next one", () => {
  const q = createTranscriptQueue();
  q.push(msg(1));
  const first = q.take();
  assert.equal(first.messages.length, 1);

  // The developer is staring at a permission prompt; the kelabo keeps talking.
  q.push(msg(2));
  q.push(msg(3));
  assert.equal(q.take(), null, "exactly one batch in flight");
  assert.equal(q.isBusy(), true);

  q.done();
  const second = q.take();
  assert.deepEqual(second.messages.map((m) => m.text), ["line 2", "line 3"]);
});

test("a batch that is never released would wedge the queue, so done() is unconditional", () => {
  const q = createTranscriptQueue();
  q.push(msg(1));
  q.take();
  q.push(msg(2));
  assert.equal(q.take(), null);
  q.done();
  assert.ok(q.take(), "released");
});

test("the backlog is bounded and the loss is reported, never silent", () => {
  const q = createTranscriptQueue({ maxBacklog: 3 });
  for (let i = 1; i <= 6; i++) q.push(msg(i));
  const batch = q.take();
  // Oldest go: in a live conversation stale context is worse than absent
  // context. But the agent is told, because a gap it cannot see reads as a
  // speaker changing their mind mid-sentence.
  assert.deepEqual(batch.messages.map((m) => m.text), ["line 4", "line 5", "line 6"]);
  assert.equal(batch.dropped, 3);
});

test("the drop counter resets with the batch that reported it", () => {
  const q = createTranscriptQueue({ maxBacklog: 2 });
  for (let i = 1; i <= 5; i++) q.push(msg(i));
  assert.equal(q.take().dropped, 3);
  q.done();
  q.push(msg(6));
  assert.equal(q.take().dropped, 0);
});

test("a redelivered message is not appended twice", () => {
  // The tunnel reconnects and replays. Message boundaries belong to the speaker
  // (docs 13), so messageId+seq is the identity — nothing re-derives it.
  const q = createTranscriptQueue();
  assert.equal(q.push(msg(1)), true);
  assert.equal(q.push(msg(1)), false);
  assert.equal(q.size(), 1);
});

test("the same words spoken twice are two messages", () => {
  const q = createTranscriptQueue();
  q.push(msg(1, { text: "yes" }));
  q.push(msg(2, { text: "yes" }));
  assert.equal(q.size(), 2, "identity is the message id, not the text");
});

test("a message with no id is always accepted", () => {
  // Not every source stamps one; refusing them would drop real speech.
  const q = createTranscriptQueue();
  q.push({ speaker: "A", text: "hi", at: 1 });
  q.push({ speaker: "A", text: "hi", at: 1 });
  assert.equal(q.size(), 2);
});

test("reset clears the backlog, the gap counter and the in-flight flag", () => {
  const q = createTranscriptQueue();
  q.push(msg(1));
  q.take();
  q.push(msg(2));
  q.reset();
  assert.equal(q.size(), 0);
  assert.equal(q.isBusy(), false);
  assert.equal(q.take(), null);
});

console.log(`connector/queue: ${passed} passed`);
