// `kelabo opencode` / `kelabo claude` — the launcher (docs 17 §5).
//
// This exists because both runtimes need a launch argument that is easy to
// forget and whose absence is **silent**: every tool still works, so the agent
// joins, posts, reads the board and never hears a word of the kelabo. Asking
// people to type them from memory is asking for that failure.
//
// Which makes the flags themselves the thing to pin. If one is dropped, renamed
// or reordered here, nothing throws and no test that merely starts the process
// would notice — the developer finds out mid-kelabo, and the symptom looks like
// an assistant being quiet.
import assert from "node:assert/strict";
import { freePort, whichBin, launchPlan, runChild, splitForward, hasFlag, flagValue } from "../src/launch.js";
import { RUNTIMES, RUNTIME_IDS } from "../src/runtimes.js";
import { MCP_KEY } from "../src/install.js";

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`ok - ${name}`);
  } catch (err) {
    console.error(`FAIL - ${name}`);
    console.error(err);
    process.exitCode = 1;
  }
}

const plan = (id, opts) => launchPlan(RUNTIMES[id], opts);

// --- every runtime is launchable --------------------------------------------

await test("every runtime declares how to start it", () => {
  // A row without this is a `kelabo <cli>` that does not exist, or worse a
  // subcommand that spawns nothing and exits 0.
  for (const id of RUNTIME_IDS) {
    const l = RUNTIMES[id].launch;
    assert.ok(l.cli, `${id} has no subcommand name`);
    assert.ok(l.bin, `${id} names no binary`);
    assert.equal(typeof l.args, "function", `${id} composes no arguments`);
    assert.equal(typeof l.env, "function", `${id} composes no environment`);
  }
});

await test("no two runtimes claim the same subcommand", () => {
  const names = RUNTIME_IDS.map((id) => RUNTIMES[id].launch.cli);
  assert.equal(new Set(names).size, names.length, `subcommands collide: ${names.join(", ")}`);
});

await test("no subcommand shadows a verb", () => {
  // `kelabo run` is how a runtime spawns the bridge over stdio. A runtime whose
  // binary was called `run`, `setup` or `status` would take that name and the
  // MCP server would silently start something else.
  const reserved = ["setup", "login", "status", "doctor", "uninstall", "reset", "run", "runtimes", "help", "version"];
  for (const id of RUNTIME_IDS) {
    assert.ok(!reserved.includes(RUNTIMES[id].launch.cli), `${id} shadows the \`${RUNTIMES[id].launch.cli}\` verb`);
  }
});

// --- opencode ----------------------------------------------------------------

await test("opencode gets a port, because 0 means no server at all", () => {
  // `--port` defaults to 0, which is "serve nothing over HTTP" and not "pick
  // one". Transcript is delivered over that HTTP server, so without a real port
  // the agent is deaf while looking completely healthy.
  const p = plan("opencode", { port: 41234 });
  assert.deepEqual(p.args, ["--port", "41234"]);
});

await test("opencode gets background subagents, which are off by default", () => {
  // Undocumented, off by default, and when off the `background` parameter is
  // absent from the task tool's schema — so the model's `background: true` is
  // dropped on the way to the call with no error, the subagent runs in the
  // foreground, and the session goes deaf for its entire duration.
  const p = plan("opencode", { port: 41234 });
  assert.equal(p.env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS, "true");
});

await test("opencode's base URL is exported so the bridge has it before /kstart", () => {
  const p = plan("opencode", { port: 41234 });
  assert.equal(p.env.OPENCODE_BASE_URL, "http://127.0.0.1:41234");
});

await test("the caller's environment survives — we add, never replace", () => {
  // The child is the developer's editor. Dropping their PATH, their API keys or
  // their terminal settings to inject two variables would be indefensible.
  const p = plan("opencode", { port: 1, env: { PATH: "/usr/bin", ANTHROPIC_API_KEY: "sk-x" } });
  assert.equal(p.env.PATH, "/usr/bin");
  assert.equal(p.env.ANTHROPIC_API_KEY, "sk-x");
  assert.equal(p.env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS, "true");
});

// --- Claude Code -------------------------------------------------------------

await test("Claude Code gets the channel flag, naming this exact server", () => {
  // Claude Code resolves `server:<name>` against the *configured* MCP servers
  // and skips any that matches none of them. The channel name and the MCP key
  // are therefore the same string by necessity, not by convention.
  const p = plan("claude-code");
  assert.deepEqual(p.args, ["--dangerously-load-development-channels", `server:${MCP_KEY}`]);
  assert.equal(MCP_KEY, "kelabo");
});

await test("Claude Code needs no port, and is not given one", () => {
  assert.equal(RUNTIMES["claude-code"].launch.needsPort, false);
  assert.deepEqual(plan("claude-code").env, {});
});

// --- passing the CLI back to the developer -----------------------------------

await test("extra arguments are forwarded, and come last", () => {
  // The launcher supplies a default nobody remembers; it does not take the CLI
  // away.
  const p = plan("opencode", { port: 41234, extra: ["~/src/thing", "--model", "x"] });
  assert.deepEqual(p.args, ["--port", "41234", "~/src/thing", "--model", "x"]);
  const c = plan("claude-code", { extra: ["-p", "hello"] });
  assert.deepEqual(c.args.slice(-2), ["-p", "hello"]);
});

// --- `--`, and the flag that cannot merely lose ------------------------------

await test("`--` splits ours from theirs, and theirs is never inspected", () => {
  assert.deepEqual(splitForward(["-p", "hi"]), { own: ["-p", "hi"], forward: [], separated: false });
  assert.deepEqual(splitForward(["--dry-run", "--", "--dry-run", "x"]), {
    own: ["--dry-run"],
    forward: ["--dry-run", "x"],
    separated: true,
  });
  // A bare `--` with nothing after it is still a separator, not an argument.
  assert.deepEqual(splitForward(["--"]), { own: [], forward: [], separated: true });
  // Only the *first* `--` splits; later ones belong to the runtime, which may
  // have its own passthrough convention.
  assert.deepEqual(splitForward(["--", "a", "--", "b"]).forward, ["a", "--", "b"]);
});

await test("flags are recognised in both spellings", () => {
  assert.ok(hasFlag(["--port", "5000"], "port"));
  assert.ok(hasFlag(["--port=5000"], "port"));
  assert.ok(!hasFlag(["--portal", "x"], "port"), "a prefix is not the flag");
  assert.equal(flagValue(["--port", "5000"], "port"), "5000");
  assert.equal(flagValue(["--port=5001"], "port"), "5001");
  assert.equal(flagValue(["-x"], "port"), null);
});

await test("a developer's own --port suppresses ours entirely", () => {
  // Verified against opencode 1.18.6: `--port A --port B` binds **neither** — it
  // binds a random port, because yargs collects the repeats into an array and
  // opencode falls back. Measured twice: 39897, then 39983. So "ours first,
  // theirs last, theirs wins" is false for this flag, and appending both would
  // leave OPENCODE_BASE_URL naming a port nothing is listening on.
  const p = plan("opencode", { port: 41234, extra: ["--port", "5000"] });
  assert.deepEqual(p.args, ["--port", "5000"], "ours must not also be passed");
  assert.equal(p.env.OPENCODE_BASE_URL, "http://127.0.0.1:5000", "the URL must follow theirs");
  const eq = plan("opencode", { port: 41234, extra: ["--port=5001"] });
  assert.deepEqual(eq.args, ["--port=5001"]);
  assert.equal(eq.env.OPENCODE_BASE_URL, "http://127.0.0.1:5001");
});

await test("a developer's own --hostname is reflected in the base URL", () => {
  const p = plan("opencode", { port: 41234, extra: ["--hostname", "0.0.0.0"] });
  assert.equal(p.env.OPENCODE_BASE_URL, "http://0.0.0.0:41234");
});

await test("an unparseable port means no base URL, rather than a wrong one", () => {
  // A wrong URL is worse than none: the plugin reports the truth at /kstart
  // anyway, but `probe()` against a port nothing is on would fail and blame the
  // developer's setup.
  const p = plan("opencode", { port: 41234, extra: ["--port", "$MYPORT"] });
  assert.equal(p.env.OPENCODE_BASE_URL, undefined);
  assert.equal(p.env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS, "true", "the other one still applies");
});

await test("the echoed command is pasteable — arguments stay one argument", () => {
  // `kelabo claude -p "two words"` spawns one argument. Printing it unquoted
  // would show a line that, pasted back, does something different from what
  // just ran — which is worse than printing nothing, because it looks checked.
  const p = plan("claude-code", { extra: ["-p", "Reply with exactly: launched"] });
  assert.match(p.display, /-p 'Reply with exactly: launched'$/);
  assert.match(plan("opencode", { port: 1, extra: ["/my dir/x"] }).display, /'\/my dir\/x'$/);
  // …and a quote inside one does not end it: `'\''` is how POSIX shells embed
  // a single quote inside single quotes.
  assert.ok(plan("claude-code", { extra: ["it's"] }).display.endsWith("'it'\\''s'"));
});

await test("the command is echoed in full, environment included", () => {
  // This command types arguments the developer did not. Hiding them makes it
  // magic, and magic is what turns "it cannot hear me" into a question nobody
  // can answer.
  const p = plan("opencode", { port: 41234 });
  assert.match(p.display, /OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true/);
  assert.match(p.display, /opencode --port 41234/);
  assert.match(plan("claude-code").display, /claude --dangerously-load-development-channels server:kelabo/);
});

// --- the impure edges --------------------------------------------------------

await test("freePort returns a port nothing is on, and a different one each time", async () => {
  const a = await freePort();
  const b = await freePort();
  assert.ok(a > 1024 && a < 65536, `${a} is not a usable port`);
  assert.ok(b > 1024 && b < 65536);
  // Not a guarantee the kernel makes, but a fixed port would collide
  // deterministically the moment a developer opens a second session, which is
  // the failure this replaced.
  assert.notEqual(a, b);
});

await test("whichBin finds an absolute path, or null", () => {
  // Absolute because the child is spawned without a shell — which is what stops
  // a directory containing a space from being re-split into two arguments.
  const node = whichBin("node");
  assert.ok(node && node.startsWith("/"), `expected an absolute path, got ${node}`);
  assert.equal(whichBin("kelabo-definitely-not-a-real-binary"), null);
  assert.equal(whichBin("node", { PATH: "" }), null);
});

await test("the child's exit code becomes ours", async () => {
  // `kelabo opencode && make deploy` has to behave like `opencode && make
  // deploy`, or the launcher quietly breaks every script it is dropped into.
  const code = await runChild(process.execPath, ["-e", "process.exit(7)"], process.env);
  assert.equal(code, 7);
});

await test("a child killed by a signal reports the shell's 128+n", async () => {
  const code = await runChild(process.execPath, ["-e", "process.kill(process.pid,'SIGTERM')"], process.env);
  assert.equal(code, 143);
});

await test("a missing binary rejects rather than exiting 0", async () => {
  await assert.rejects(() => runChild("/nonexistent/kelabo-nope", [], process.env));
});

console.log(`\nlaunch: ${passed} tests passed`);
