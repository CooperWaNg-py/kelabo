// Two bridges on one laptop.
//
// This is not hypothetical: every opencode session spawns its own bridge, they
// all want port 4190, and one gets it. What used to happen then was that the
// loser gave up its listener entirely and the winner's shared lock file sent
// `/kstart` to the wrong process — so the tools worked, the handover reported
// success, and `kelabo_join` insisted `/kstart` had never been run.
//
// Real sockets and real files, in a temp HOME. No opencode required.
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createControl, lockPathForParent } from "../src/control.js";

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`ok - ${name}`);
  } catch (err) {
    console.error(`FAIL ${name}`);
    throw err;
  }
}

const dir = await mkdtemp(join(tmpdir(), "kelabo-control-"));
const lockFor = (name) => join(dir, `${name}.json`);
const post = (port, path, body) =>
  fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(3000),
  });

const started = [];
function make(name, port, onSession = async () => ({ ok: true })) {
  const c = createControl({ port, runtime: "opencode", onSession, lockPath: lockFor(name) });
  started.push(c);
  return c;
}

await test("a bridge publishes the port it actually got", async () => {
  const c = make("a", 0);
  const port = await c.start();
  assert.ok(port > 0);
  const lock = JSON.parse(await readFile(lockFor("a"), "utf8"));
  assert.equal(lock.port, port);
  assert.equal(lock.pid, process.pid);
  assert.equal(lock.ppid, process.ppid);
});

await test("a second bridge on a busy port takes another one instead of giving up", async () => {
  const first = make("busy1", 0);
  const taken = await first.start();

  const second = make("busy2", taken);
  const port = await second.start();

  // The old behaviour resolved null here, leaving a bridge that could never
  // receive /kstart and therefore never receive transcript — silently, because
  // every MCP tool kept working.
  assert.ok(port, "the second bridge must still get a listener");
  assert.notEqual(port, taken, "and it must not be pretending to own the busy one");

  const lock = JSON.parse(await readFile(lockFor("busy2"), "utf8"));
  assert.equal(lock.port, port);
});

await test("each bridge answers on its own port, so a handover cannot be misrouted", async () => {
  const hits = [];
  const one = make("one", 0, async (body) => {
    hits.push(["one", body.sessionId]);
    return { ok: true, bound: true };
  });
  const two = make("two", 0, async (body) => {
    hits.push(["two", body.sessionId]);
    return { ok: true, bound: true };
  });
  const p1 = await one.start();
  const p2 = await two.start();

  await post(p1, "/session", { sessionId: "ses_one", baseUrl: "http://127.0.0.1:4096" });
  await post(p2, "/session", { sessionId: "ses_two", baseUrl: "http://127.0.0.1:4097" });

  assert.deepEqual(hits, [
    ["one", "ses_one"],
    ["two", "ses_two"],
  ]);
});

await test("stopping a bridge does not delete another bridge's lock", async () => {
  const keep = make("keep", 0);
  await keep.start();
  const loser = make("loser", 0);
  await loser.start();

  loser.stop();
  assert.ok(!existsSync(lockFor("loser")), "its own lock goes");
  assert.ok(existsSync(lockFor("keep")), "somebody else's does not");
});

await test("a bridge that never listened does not delete the lock it never wrote", async () => {
  // stop() used to remove the lock path unconditionally, so a bridge that
  // failed to start would take the healthy one's file down with it.
  await writeFile(lockFor("victim"), JSON.stringify({ port: 4190, pid: -1 }));
  const neverStarted = createControl({
    port: 0,
    runtime: "opencode",
    onSession: async () => ({}),
    lockPath: lockFor("victim"),
  });
  neverStarted.stop();
  assert.ok(existsSync(lockFor("victim")));
});

await test("the lock path is derived from the parent pid, not a fixed name", () => {
  assert.match(lockPathForParent(4321), /bridge-4321\.json$/);
  assert.notEqual(lockPathForParent(1), lockPathForParent(2));
});

await test("only POST is accepted, and an unknown path is a 404", async () => {
  const c = make("methods", 0);
  const port = await c.start();
  const get = await fetch(`http://127.0.0.1:${port}/session`, { signal: AbortSignal.timeout(3000) });
  assert.equal(get.status, 405);
  const unknown = await post(port, "/nope", {});
  assert.equal(unknown.status, 404);
});

for (const c of started) c.stop();
await rm(dir, { recursive: true, force: true });
console.log(`\ncontrol: ${passed} tests passed`);
