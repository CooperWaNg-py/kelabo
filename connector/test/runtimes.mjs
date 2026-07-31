// One package, one `kelabo`, several runtimes (docs 17 §2).
//
// The registry is what `setup`, `uninstall` and `status` dispatch on, and the
// two things that can go wrong with it are both quiet:
//
//  * a row without an adapter — `setup --runtime x` wires a config whose bridge
//    then refuses to start, which the developer sees as an MCP server that will
//    not connect and no reason given;
//  * two rows that write to the same place — one runtime's uninstall removing
//    the other's wiring, which is the failure a shared install manifest already
//    caused once.
import assert from "node:assert/strict";
import { RUNTIMES, RUNTIME_IDS, DEFAULT_RUNTIME, runtime, parseRuntimeList } from "../src/runtimes.js";
import { ADAPTER_IDS, adapterFor } from "../src/adapters/index.js";
import { manifestPath, discoverConfigPath } from "../src/installer.js";

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`ok - ${name}`);
  } catch (err) {
    console.error(`FAIL ${name}`);
    throw err;
  }
}

test("every runtime has an adapter, and every adapter a runtime", () => {
  assert.deepEqual([...RUNTIME_IDS].sort(), [...ADAPTER_IDS].sort());
});

test("every row carries what setup and status need from it", () => {
  for (const id of RUNTIME_IDS) {
    const r = runtime(id);
    assert.equal(r.id, id, "the row must know its own key");
    assert.ok(r.display, `${id} has no display name`);
    assert.ok(r.detect?.bin, `${id} cannot be detected`);
    assert.ok(r.wiring?.mcpContainer, `${id} has no config container`);
    assert.ok(r.wiring?.mcpShape, `${id} has no MCP entry shape`);
    // Both halves: how `kelabo <cli>` starts it, and what silently breaks if
    // somebody starts it by hand instead. Every runtime so far has a way to be
    // wired correctly and hear nothing. test/launch.mjs pins the flags.
    assert.ok(r.launch?.cli, `${id} has no launch subcommand`);
    assert.ok(r.launch?.why, `${id} does not say what goes wrong`);
  }
});

test("an adapter declares its own capabilities and instructions", () => {
  for (const id of RUNTIME_IDS) {
    const a = adapterFor(id);
    assert.equal(typeof a.create, "function", `${id} has no factory`);
    assert.ok(a.instructions, `${id} offers the model no instructions`);
    assert.equal(typeof a.capabilities, "object");
  }
});

test("an unknown runtime is refused, not defaulted", () => {
  // A default here would start a bridge with the wrong injection path: every
  // tool would work and no transcript would ever arrive, which is the exact
  // failure shape the rest of this design keeps trying to make loud.
  assert.throws(() => adapterFor("emacs"), /not a runtime this bridge knows/);
  assert.throws(() => adapterFor(undefined), /not a runtime this bridge knows/);
  assert.throws(() => runtime("emacs"), /unknown runtime/);
});

test("the default runtime is a real one", () => {
  assert.ok(RUNTIMES[DEFAULT_RUNTIME], "the fallback names a runtime that does not exist");
});

test("--runtime accepts one, several or all, always in registry order", () => {
  assert.deepEqual(parseRuntimeList("opencode"), ["opencode"]);
  assert.deepEqual(parseRuntimeList("claude-code"), ["claude-code"]);
  assert.deepEqual(parseRuntimeList("all"), [...RUNTIME_IDS]);
  // Order is the registry's, not the order they were typed, so output and
  // manifests are stable however the flag was written.
  assert.deepEqual(parseRuntimeList("claude-code,opencode"), [...RUNTIME_IDS]);
  assert.deepEqual(parseRuntimeList(" opencode , claude-code "), [...RUNTIME_IDS]);
  assert.deepEqual(parseRuntimeList(""), []);
  assert.throws(() => parseRuntimeList("opencode,emacs"), /unknown runtime/);
});

test("no two runtimes share a manifest", () => {
  // A single `install.json` meant the second setup overwrote the first's record,
  // and uninstalling opencode then followed the Claude Code manifest's
  // configPath and removed its key instead. Uninstalling one uninstalled the
  // other, and said it had succeeded.
  const paths = RUNTIME_IDS.map((id) => manifestPath(id));
  assert.equal(new Set(paths).size, paths.length, `manifests collide: ${paths.join(", ")}`);
});

test("no two runtimes edit the same config file", () => {
  // They may legally share one if a user points `--config` at it — the
  // containers differ, which install.mjs covers — but the *defaults* must not
  // collide, or `setup --all` would have the second runtime overwrite the first.
  const env = { HOME: "/home/dev", PATH: "" };
  const paths = RUNTIME_IDS.map((id) => discoverConfigPath({ target: id, env, cwd: "/tmp/p" }));
  assert.equal(new Set(paths).size, paths.length, `configs collide: ${paths.join(", ")}`);
});

test("project scope is distinct per runtime too", () => {
  const paths = RUNTIME_IDS.map((id) =>
    discoverConfigPath({ target: id, project: true, env: {}, cwd: "/tmp/p" })
  );
  assert.equal(new Set(paths).size, paths.length, `project configs collide: ${paths.join(", ")}`);
});

console.log(`\nruntimes: ${passed} tests passed`);
