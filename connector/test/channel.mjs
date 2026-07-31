// Contract C for Claude Code (docs 16 §4.2).
//
// Everything asserted here was read out of the Claude Code 2.1.220 binary
// rather than out of its documentation, because the documentation for channels
// is a research-preview page and the binary is what actually decides. The gate
// it applies, in order, is: the server declared `claude/channel`; the provider
// is first-party; the feature flag is on; org policy allows it; and the server
// is named in this session's `--channels` list. Three of those five are things
// this file can hold still.
//
// The reason to test any of it: **every failure mode on this path is silent.**
// A notification whose listener was never registered is dropped with no error at
// either end, a meta key that is not an identifier is discarded on arrival, and
// a session on Bedrock simply never receives anything. There is no exception to
// catch and no log line to read, so an integration test would pass while the
// bridge delivered nothing. What is left is to pin the shape.
import assert from "node:assert/strict";
import {
  createClaudeCodeAdapter,
  CLAUDE_CHANNEL_CAPABILITIES,
  channelArmed,
  thirdPartyProvider,
  metaFor,
  INSTRUCTIONS,
  THIRD_PARTY_PROVIDER_VARS,
} from "../src/adapters/claudeCode.js";
import { PERSONA, PERSONA_CORE, INSTRUCTIONS_MAX_CHARS } from "../src/persona.js";

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

/** Stands in for the MCP server. The adapter's only route to Claude Code is
 *  `server.notification()`, so recording those calls is the whole surface. */
function fakeServer() {
  const sent = [];
  return { sent, notification: async (n) => void sent.push(n) };
}

const adapterWith = (opts = {}) => {
  const server = fakeServer();
  return {
    server,
    adapter: createClaudeCodeAdapter({
      getServer: () => server,
      // Explicit, so the test never reads the real parent process or the real
      // environment — under `claude` those would both be live and the
      // assertions would flip depending on who ran the suite.
      // `in` and not `??`: an explicit null is the "could not read the parent's
      // command line" case and must reach the adapter as null, which `??` would
      // quietly replace with the armed default.
      argv: "argv" in opts ? opts.argv : ["claude", "--dangerously-load-development-channels", "server:kelabo"],
      env: opts.env ?? {},
      log: opts.log ?? (() => {}),
    }),
  };
};

// --- the capability ---------------------------------------------------------

await test("the capability is exactly the key that registers the listener", () => {
  // Claude Code checks `capabilities.experimental["claude/channel"]` and skips
  // with "server did not declare claude/channel capability" when it is absent.
  // The value is not inspected; the presence of the key is the whole signal.
  assert.deepEqual(CLAUDE_CHANNEL_CAPABILITIES, { experimental: { "claude/channel": {} } });
});

await test("the permission relay is deliberately NOT declared", () => {
  // `claude/channel/permission` relays tool-approval prompts out through the
  // channel so they can be answered remotely. The far end of this channel is a
  // kelabo room that may contain link-joined guests, so anyone who can reply
  // could approve tool use in the developer's session. Declining the capability
  // is the control; there is no gate that would make accepting it safe.
  const declared = JSON.stringify(CLAUDE_CHANNEL_CAPABILITIES);
  assert.ok(!declared.includes("permission"), "the permission relay must never be advertised");
});

// --- the notification -------------------------------------------------------

await test("inject sends the channel notification, with the envelope as content", async () => {
  const { server, adapter } = adapterWith();
  await adapter.inject("<kelabo-transcript>hi</kelabo-transcript>", { kelaboId: "m-1" });
  assert.equal(server.sent.length, 1);
  assert.equal(server.sent[0].method, "notifications/claude/channel");
  assert.equal(server.sent[0].params.content, "<kelabo-transcript>hi</kelabo-transcript>");
});

await test("meta keys are identifiers, because the others are dropped in flight", async () => {
  const { server, adapter } = adapterWith();
  await adapter.inject("x", { kelaboId: "m-1", speakers: ["Alice", "Bob"], silent: false });
  const { meta } = server.sent[0].params;
  // Each key becomes an attribute on the <channel> tag, and Claude Code
  // discards any that is not an identifier — silently, so a hyphen here would
  // cost the attribute with nothing anywhere to show for it.
  for (const key of Object.keys(meta)) {
    assert.match(key, /^[A-Za-z_][A-Za-z0-9_]*$/, `meta key ${key} would be dropped on arrival`);
  }
  assert.equal(meta.kelabo_id, "m-1");
  assert.equal(meta.speakers, "Alice, Bob");
  assert.equal(meta.silent, "false");
});

await test("metaFor drops what would not survive, rather than sending it", () => {
  assert.deepEqual(metaFor({ "kelabo-id": "m", ok_1: "y", empty: "", missing: undefined, n: 3 }), {
    ok_1: "y",
    n: "3",
  });
});

await test("a silent inject is marked, even though the runtime cannot honour it", async () => {
  // There is no equivalent of opencode's `noReply`: every channel event reaches
  // the model. The flag is passed anyway so the persona can see that a briefing
  // is context rather than a question — that is what carries the load here.
  const { server, adapter } = adapterWith();
  await adapter.inject("briefing", { silent: true, kelaboId: "m-1" });
  assert.equal(server.sent[0].params.meta.silent, "true");
});

await test("ready() is always true — the runtime does the pacing", () => {
  // Notifications that arrive mid-turn are batched by Claude Code and delivered
  // together on the next one, so the bridge's queue must not also hold back.
  assert.equal(adapterWith().adapter.ready(), true);
});

await test("injecting before the server exists fails loudly rather than vanishing", async () => {
  const adapter = createClaudeCodeAdapter({ getServer: () => null, argv: [], env: {} });
  await assert.rejects(() => adapter.inject("x"), /channel not connected/);
});

await test("attach resolves without a session id, because the channel already has one", async () => {
  // The channel targets whichever session spawned this process. There is
  // nothing to look up and nothing to hand over, which is why the protocol
  // accepts an empty sessionRef.
  const ref = await adapterWith().adapter.attach();
  assert.equal(ref.sessionRef, "");
  assert.ok(ref.workspace);
});

// --- the launch flag, which is the invisible failure -------------------------

await test("channelArmed sees the flag in every shape a shell produces", () => {
  const armed = (argv) => channelArmed(argv, "kelabo");
  assert.equal(armed(["claude", "--dangerously-load-development-channels", "server:kelabo"]), true);
  assert.equal(armed(["claude", "--dangerously-load-development-channels=server:kelabo"]), true);
  assert.equal(armed(["claude", "--channels", "server:kelabo"]), true);
  // Variadic: the flag takes a list, and ours may not be first in it.
  assert.equal(armed(["claude", "--channels", "server:other", "server:kelabo", "--debug"]), true);
  assert.equal(armed(["claude", "--dangerously-load-development-channels", "plugin:kelabo@mkt"]), true);
});

await test("channelArmed is false for a session that will hear nothing", () => {
  const armed = (argv) => channelArmed(argv, "kelabo");
  assert.equal(armed(["claude"]), false);
  assert.equal(armed(["claude", "--debug"]), false);
  // Named, but not us. Claude Code resolves `server:<name>` against the
  // configured MCP servers and skips the ones that do not match.
  assert.equal(armed(["claude", "--channels", "server:something-else"]), false);
  // A prefix is not a match: `server:kelabo-dev` is a different server.
  assert.equal(armed(["claude", "--channels", "server:kelabo-dev"]), false);
});

await test("an unreadable command line is null, never a warning", () => {
  // An unknown is not a fault. Warning on one trains people to ignore the
  // warning, which is exactly what would then hide the real case — the same
  // reasoning as `backgroundSubagents()` on the opencode side.
  assert.equal(channelArmed(null), null);
  assert.equal(channelArmed([]), null);
});

await test("the caveat names the remedy when the flag is missing", () => {
  const { adapter } = adapterWith({ argv: ["claude"] });
  assert.equal(adapter.channelArmed(), false);
  const caveat = adapter.caveat();
  assert.match(caveat, /--dangerously-load-development-channels server:kelabo/);
  // It has to say what still works, or the developer reads it as "Kelabo is
  // broken" when the board half is fine.
  assert.match(caveat, /Board tools work/i);
});

await test("no caveat when the session is armed and the provider is first-party", () => {
  assert.equal(adapterWith().adapter.caveat(), null);
});

await test("an unverifiable command line produces no caveat either", () => {
  // null, not false: claiming the flag is missing when we simply could not look
  // would send people to change a launch line that was already correct.
  const { adapter } = adapterWith({ argv: null });
  assert.equal(adapter.channelArmed(), null);
  assert.equal(adapter.caveat(), null);
});

// --- the provider gate ------------------------------------------------------

await test("every provider Claude Code refuses channels on is detected", () => {
  // Read straight off the binary's provider check: it returns "firstParty" only
  // when none of these is set, and the channel gate then skips with "channels
  // are not available on third-party providers".
  for (const v of THIRD_PARTY_PROVIDER_VARS) {
    assert.equal(thirdPartyProvider({ [v]: "1" }), v);
  }
  assert.equal(thirdPartyProvider({}), null);
  assert.equal(thirdPartyProvider({ ANTHROPIC_API_KEY: "sk-x" }), null);
});

await test("a third-party provider outranks the flag in the caveat", () => {
  // Both wrong is the confusing case: adding the flag would change nothing, so
  // naming the flag first would send the developer to fix the wrong thing.
  const { adapter } = adapterWith({ argv: ["claude"], env: { CLAUDE_CODE_USE_BEDROCK: "1" } });
  assert.match(adapter.caveat(), /CLAUDE_CODE_USE_BEDROCK/);
  assert.ok(!adapter.caveat().includes("--dangerously-load"));
});

// --- the persona, and the 2048-character cliff -------------------------------

await test("the adapter offers instructions Claude Code will not truncate", () => {
  // Sending the full persona here was silently costing two thirds of it, the
  // injection gate included. The DEBUG line that says so is the only evidence
  // the runtime produces, and nobody reads MCP debug output during a kelabo.
  assert.equal(INSTRUCTIONS, PERSONA_CORE);
  assert.ok(
    INSTRUCTIONS.length <= INSTRUCTIONS_MAX_CHARS,
    `${INSTRUCTIONS.length} chars would be cut to ${INSTRUCTIONS_MAX_CHARS}`
  );
});

await test("the rest of the brief is delivered where nothing truncates it", () => {
  // `kelabo_join` is the first moment it can matter — transcript does not flow
  // before a join — and its result is not capped.
  assert.equal(adapterWith().adapter.brief(), PERSONA);
  assert.ok(PERSONA.length > INSTRUCTIONS_MAX_CHARS, "if this ever fits, drop the split");
});

console.log(`\nchannel: ${passed} tests passed`);
