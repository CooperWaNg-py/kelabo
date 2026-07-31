// The uninstaller has one job: leave the developer's opencode config exactly as
// it found it. Everything here exists because the alternative — finding out on
// someone else's machine — means their config is already damaged.
import assert from "node:assert/strict";
import {
  applyInstall,
  removeInstall,
  inspectInstall,
  parseCommandMd,
  packageNameFromSpec,
  isEphemeralPath,
  hasNonJsonSyntax,
  detectIndent,
  mcpEntryFor,
  describePluginSpec,
  MCP_KEY,
} from "../src/install.js";
import { RUNTIMES } from "../src/runtimes.js";

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

const OPTS = {
  pkg: "@kelabome/agents",
  version: "0.3.0",
  mcpCommand: ["/usr/bin/node", "/usr/lib/node_modules/@kelabome/agents/cli.js", "run"],
  environment: { KELABO_RUNTIME: "opencode" },
  commands: {
    kstart: { description: "Connect this opencode session", template: "call kelabo_join" },
    kend: { description: "Release this opencode session", template: "call kelabo_leave" },
  },
};

/** The Claude Code install. One key — `mcpServers.kelabo` — and no plugin and no
 *  commands, because the channel targets the session that spawned the MCP
 *  server: there is no second process to load a plugin and nothing to hand
 *  over. */
const CLAUDE_OPTS = {
  pkg: "@kelabome/agents",
  version: "0.3.0",
  mcpCommand: ["/usr/bin/node", "/usr/lib/node_modules/@kelabome/agents/cli.js", "run"],
  environment: { KELABO_RUNTIME: "claude-code" },
  wiring: RUNTIMES["claude-code"].wiring,
};

/** apply -> remove must be the identity. This is the whole safety argument, so
 *  it is asserted against every shape of pre-existing config that matters, for
 *  both runtimes — the second one edits `~/.claude.json`, which is live state
 *  Claude Code writes itself and which holds an OAuth account record. */
function roundTrip(original, opts = OPTS) {
  const before = JSON.parse(JSON.stringify(original));
  const { config, created, wrote } = applyInstall(original, opts);
  assert.deepEqual(original, before, "applyInstall mutated its input");
  const { config: after, kept } = removeInstall(config, { created, wrote });
  assert.deepEqual(kept, [], "nothing should have been kept back");
  assert.deepEqual(after, before);
  return { installed: config, created, wrote };
}

test("round trip on an empty config", () => {
  roundTrip({});
});

test("round trip on a bare config that only has $schema", () => {
  roundTrip({ $schema: "https://opencode.ai/config.json" });
});

test("round trip on a config that already has other plugins, servers and commands", () => {
  roundTrip({
    $schema: "https://opencode.ai/config.json",
    plugin: ["opencode-claude-auth@latest", "opencode-wakatime"],
    mcp: {
      linear: { type: "remote", url: "https://mcp.linear.app/sse" },
      fs: { type: "local", command: ["npx", "-y", "@modelcontextprotocol/server-filesystem"] },
    },
    command: { test: { description: "run tests", template: "npm test" } },
    permission: { bash: "ask" },
    theme: "tokyonight",
  });
});

test("round trip when the containers exist but are empty", () => {
  // The distinction that matters: these were already here, so removal must
  // leave them behind rather than tidy them away.
  const { installed, created, wrote } = roundTrip({ plugin: [], mcp: {}, command: {} });
  assert.deepEqual(created, [], "nothing was created; all three already existed");
  const { config } = removeInstall(installed, { created, wrote });
  assert.deepEqual(config, { plugin: [], mcp: {}, command: {} });
});

test("containers we created are pruned, not left behind as empty husks", () => {
  const { config, created, wrote } = applyInstall({}, OPTS);
  assert.deepEqual(created.sort(), ["command", "mcp", "plugin"]);
  const { config: after } = removeInstall(config, { created, wrote });
  assert.deepEqual(after, {});
});

test("setup is idempotent — re-running does not append a second plugin spec", () => {
  const once = applyInstall({}, OPTS).config;
  const twice = applyInstall(once, OPTS).config;
  assert.deepEqual(twice.plugin, ["@kelabome/agents@0.3.0"]);
  assert.deepEqual(twice, once);
});

test("re-running at a new version re-pins rather than accumulating", () => {
  const old = applyInstall({}, OPTS).config;
  const { config, warnings } = applyInstall(old, { ...OPTS, version: "0.4.0" });
  assert.deepEqual(config.plugin, ["@kelabome/agents@0.4.0"]);
  assert.ok(warnings.some((w) => w.includes("plugin entry")));
});

test("other people's plugins survive an uninstall", () => {
  const original = { plugin: ["opencode-claude-auth@latest"] };
  const { config, created, wrote } = applyInstall(original, OPTS);
  assert.equal(config.plugin.length, 2);
  const { config: after } = removeInstall(config, { created, wrote });
  assert.deepEqual(after.plugin, ["opencode-claude-auth@latest"]);
});

test("other people's mcp servers and commands survive an uninstall", () => {
  const original = {
    mcp: { linear: { type: "remote", url: "https://mcp.linear.app/sse" } },
    command: { test: { description: "run tests", template: "npm test" } },
  };
  const { config, created, wrote } = applyInstall(original, OPTS);
  const { config: after } = removeInstall(config, { created, wrote });
  assert.deepEqual(after, original);
});

test("a command the developer has since edited is left alone, and said so", () => {
  const { config, created, wrote } = applyInstall({}, OPTS);
  config.command.kstart.template = "my own wording";
  const { config: after, kept, warnings } = removeInstall(config, { created, wrote });
  assert.deepEqual(kept, ["command.kstart"]);
  assert.equal(after.command.kstart.template, "my own wording");
  assert.equal(after.command.kend, undefined, "the untouched one still goes");
  assert.ok(warnings.some((w) => w.includes("kstart")));
});

test("an mcp entry the developer has since edited is left alone", () => {
  const { config, created, wrote } = applyInstall({}, OPTS);
  config.mcp[MCP_KEY].environment.KELABO_MAX_BACKLOG = "200";
  const { config: after, kept } = removeInstall(config, { created, wrote });
  assert.deepEqual(kept, [`mcp.${MCP_KEY}`]);
  assert.ok(after.mcp[MCP_KEY], "kept, so the container stays too");
});

test("uninstall twice is not an error", () => {
  const { config, created, wrote } = applyInstall({}, OPTS);
  const first = removeInstall(config, { created, wrote });
  const second = removeInstall(first.config, { created, wrote });
  assert.deepEqual(second.config, {});
  assert.deepEqual(second.kept, []);
});

test("an npx cache path is refused, because it will not be there tomorrow", () => {
  assert.ok(isEphemeralPath("/home/x/.npm/_npx/abc123/node_modules/.bin/kelabo"));
  assert.ok(!isEphemeralPath("/usr/lib/node_modules/@kelabome/agents/cli.js"));
  assert.throws(
    () => applyInstall({}, { ...OPTS, mcpCommand: ["/usr/bin/node", "/home/x/.npm/_npx/a/cli.js"] }),
    /npx cache/
  );
});

test("a spec parses back to its package name, scoped or not", () => {
  assert.equal(packageNameFromSpec("@kelabome/agents@0.3.0"), "@kelabome/agents");
  assert.equal(packageNameFromSpec("@kelabome/agents"), "@kelabome/agents");
  assert.equal(packageNameFromSpec("opencode-wakatime@latest"), "opencode-wakatime");
  assert.equal(packageNameFromSpec("opencode-wakatime"), "opencode-wakatime");
  assert.equal(packageNameFromSpec(["opencode-wakatime@1.0.0", { opt: 1 }]), "opencode-wakatime");
});

test("inspectInstall reports what is actually wired", () => {
  const { config, wrote } = applyInstall({}, OPTS);
  const found = inspectInstall(config, { wrote });
  assert.equal(found.complete, true);
  assert.equal(found.pluginPinnedTo, "0.3.0");
  assert.deepEqual(found.commands, ["kstart", "kend"]);
  assert.equal(inspectInstall({}, { wrote }).complete, false);
});

test("front matter becomes a description and a template", () => {
  const parsed = parseCommandMd(
    "---\ndescription: Connect this opencode session to the Kelabo bridge\n---\n\nCall `kelabo_join`.\n"
  );
  assert.equal(parsed.description, "Connect this opencode session to the Kelabo bridge");
  assert.equal(parsed.template, "Call `kelabo_join`.");
});

test("a markdown file with no front matter is still usable", () => {
  assert.deepEqual(parseCommandMd("just a prompt\n"), { description: "", template: "just a prompt" });
});

test("a url in a string is not mistaken for a comment", () => {
  // Getting this wrong refuses every config in existence: `$schema` is a URL.
  assert.equal(hasNonJsonSyntax('{"$schema": "https://opencode.ai/config.json"}'), null);
  assert.equal(hasNonJsonSyntax('{"a": "/* not a comment */"}'), null);
  assert.equal(hasNonJsonSyntax('{"a": "he said \\"//\\" loudly"}'), null);
});

test("real comments and trailing commas are detected", () => {
  assert.equal(hasNonJsonSyntax('{\n  // my plugins\n  "plugin": []\n}'), "comments");
  assert.equal(hasNonJsonSyntax('{\n  /* block */\n  "plugin": []\n}'), "comments");
  assert.equal(hasNonJsonSyntax('{\n  "plugin": ["a",],\n}'), "trailing commas");
  assert.equal(hasNonJsonSyntax('{\n  "plugin": ["a", "b"]\n}'), null);
});

test("a file: plugin spec round-trips too, so setup works before first publish", () => {
  // Run from a checkout there is no published package to name, so setup wires
  // the checkout's own built package. Removal has to recognise that form as
  // ours as well, or `uninstall` silently leaves it behind.
  const spec = "file:///home/dev/kelabo/connector/dist/agent";
  const original = { plugin: ["opencode-wakatime"] };
  const { config, created, wrote } = applyInstall(original, { ...OPTS, pluginSpec: spec });
  assert.deepEqual(config.plugin, ["opencode-wakatime", spec]);
  assert.equal(wrote.pluginSpec, spec);
  const { config: after, kept } = removeInstall(config, { created, wrote });
  assert.deepEqual(kept, []);
  assert.deepEqual(after, original);
});

test("switching between a file: spec and the published one does not leave both", () => {
  const spec = "file:///home/dev/kelabo/connector/dist/agent";
  const first = applyInstall({}, { ...OPTS, pluginSpec: spec });
  const fromNpm = applyInstall(first.config, { ...OPTS, previousSpecs: [first.wrote.pluginSpec] });
  assert.deepEqual(fromNpm.config.plugin, ["@kelabome/agents@0.3.0"]);
  // ...and back again, since a developer switches between the two all day.
  const back = applyInstall(fromNpm.config, {
    ...OPTS,
    pluginSpec: spec,
    previousSpecs: [fromNpm.wrote.pluginSpec],
  });
  assert.deepEqual(back.config.plugin, [spec]);
});

test("the file's own indentation is detected, so setup is not a whole-file diff", () => {
  assert.equal(detectIndent('{\n  "a": 1\n}'), 2);
  assert.equal(detectIndent('{\n    "a": 1\n}'), 4);
  assert.equal(detectIndent('{\n\t"a": 1\n}'), "\t");
  // A single-line file has no indentation to copy; 2 is opencode's own style.
  assert.equal(detectIndent('{"a": 1}'), 2);
  assert.equal(detectIndent(""), 2);
});

// --- Claude Code ------------------------------------------------------------
//
// A different config file, a different container key, a different entry shape,
// and one key instead of three. Everything else — the manifest, the round-trip
// invariant, the "left it alone because you edited it" rule — is the same code.

test("the mcp entry matches what each runtime writes for itself", () => {
  // Not invented: `claude mcp add` was run under a scratch HOME and the file it
  // produced was read back. An opencode-shaped entry in `~/.claude.json` is a
  // server Claude Code declines to start, and it does not say why.
  assert.deepEqual(mcpEntryFor("claude-code", ["/usr/bin/node", "/x/cli.js", "run"], { A: "1" }), {
    type: "stdio",
    command: "/usr/bin/node",
    args: ["/x/cli.js", "run"],
    env: { A: "1" },
  });
  assert.deepEqual(mcpEntryFor("opencode", ["/usr/bin/node", "/x/cli.js", "run"], { A: "1" }), {
    type: "local",
    command: ["/usr/bin/node", "/x/cli.js", "run"],
    environment: { A: "1" },
  });
});

test("round trip on an empty Claude Code config", () => {
  roundTrip({}, CLAUDE_OPTS);
});

test("round trip on a real ~/.claude.json, which is mostly not ours", () => {
  // The shape that actually exists on a developer's machine: a big pile of
  // client state, an OAuth account record, and per-project settings. All of it
  // has to come back byte-identical.
  roundTrip(
    {
      numStartups: 41,
      userID: "e5785bfc",
      oauthAccount: { accountUuid: "abc", emailAddress: "dev@example.com" },
      mcpServers: { linear: { type: "http", url: "https://mcp.linear.app/mcp" } },
      projects: { "/home/dev/app": { allowedTools: [], mcpServers: {} } },
      tipsHistory: { "new-user-warmup": 3 },
    },
    CLAUDE_OPTS
  );
});

test("Claude Code gets one key: no plugin, no commands, nothing else invented", () => {
  const { config, created } = applyInstall({}, CLAUDE_OPTS);
  assert.deepEqual(Object.keys(config), ["mcpServers"]);
  assert.deepEqual(created, ["mcpServers"]);
  assert.equal(config.plugin, undefined, "Claude Code has no plugin to load");
  assert.equal(config.command, undefined, "Claude Code has no inline command key");
  assert.deepEqual(config.mcpServers[MCP_KEY], {
    type: "stdio",
    command: "/usr/bin/node",
    args: ["/usr/lib/node_modules/@kelabome/agents/cli.js", "run"],
    env: { KELABO_RUNTIME: "claude-code" },
  });
});

test("the manifest records which container it wrote, so removal can find it", () => {
  // Removal happens later, from a different process, reading only the manifest.
  // Without this it would look under `mcp` — opencode's key — find nothing, and
  // report a clean uninstall while leaving the entry in place.
  const { wrote } = applyInstall({}, CLAUDE_OPTS);
  assert.equal(wrote.mcpContainer, "mcpServers");
  assert.equal(wrote.pluginSpec, undefined);
  assert.equal(wrote.commands, undefined);
});

test("a manifest from before mcpContainer existed still uninstalls", () => {
  // Every install that predates the field was an opencode one, so the default
  // has to be `mcp` rather than an error or a no-op.
  const { config, created, wrote } = applyInstall({}, OPTS);
  const legacy = { created, wrote: { ...wrote, mcpContainer: undefined } };
  const { config: after, kept } = removeInstall(config, legacy);
  assert.deepEqual(kept, []);
  assert.deepEqual(after, {});
});

test("uninstalling Claude Code leaves other people's MCP servers alone", () => {
  const original = {
    mcpServers: { linear: { type: "http", url: "https://mcp.linear.app/mcp" } },
  };
  const { config, created, wrote } = applyInstall(original, CLAUDE_OPTS);
  assert.deepEqual(Object.keys(config.mcpServers).sort(), ["kelabo", "linear"]);
  const { config: after } = removeInstall(config, { created, wrote });
  assert.deepEqual(after, original);
});

test("a Claude Code uninstall does not delete a /kstart the developer wrote", () => {
  // The bug this pins: iterating the fixed COMMAND_KEYS on removal rather than
  // the keys this install recorded. opencode's package writes `command.kstart`;
  // the Claude Code package never does — so finding one means it is theirs, in
  // a config we never touched.
  const original = { command: { kstart: { description: "mine", template: "my own thing" } } };
  const { config, created, wrote } = applyInstall(original, CLAUDE_OPTS);
  const { config: after, removed } = removeInstall(config, { created, wrote });
  assert.deepEqual(after, original);
  assert.ok(!removed.some((r) => r.startsWith("command.")), "no command of ours to remove");
});

test("an edited Claude Code entry is kept, and said so", () => {
  const { config, created, wrote } = applyInstall({}, CLAUDE_OPTS);
  config.mcpServers[MCP_KEY].env.KELABO_MAX_BACKLOG = "200";
  const { config: after, kept, warnings } = removeInstall(config, { created, wrote });
  assert.deepEqual(kept, [`mcpServers.${MCP_KEY}`]);
  assert.ok(after.mcpServers[MCP_KEY], "kept, so the container stays too");
  assert.ok(warnings.some((w) => w.includes("mcpServers.kelabo")));
});

test("Claude Code setup is idempotent, including across a version bump", () => {
  const once = applyInstall({}, CLAUDE_OPTS).config;
  assert.deepEqual(applyInstall(once, CLAUDE_OPTS).config, once);
  // Nothing here is version-pinned — there is no plugin to keep in lockstep —
  // so a new version must not change the config at all.
  assert.deepEqual(applyInstall(once, { ...CLAUDE_OPTS, version: "0.9.9" }).config, once);
});

test("inspectInstall does not want a plugin it was never asked to write", () => {
  // The regression this prevents: `complete` requiring a plugin spec
  // unconditionally, so `kelabo status` on Claude Code reports a broken install
  // forever and tells the developer to re-run a setup that already worked.
  const { config, wrote } = applyInstall({}, CLAUDE_OPTS);
  const found = inspectInstall(config, { wrote });
  assert.equal(found.complete, true);
  assert.equal(found.plugin, null);
  assert.equal(found.mcpContainer, "mcpServers");
  // Split shape reassembled, so `status` can name the script either runtime is
  // about to spawn without knowing which one it is looking at.
  assert.deepEqual(found.mcpCommand, [
    "/usr/bin/node",
    "/usr/lib/node_modules/@kelabome/agents/cli.js",
    "run",
  ]);
});

test("the npx cache refusal names the package you actually installed", () => {
  assert.throws(
    () => applyInstall({}, { ...CLAUDE_OPTS, mcpCommand: ["/usr/bin/node", "/home/x/.npm/_npx/a/cli.js"] }),
    /npx cache[\s\S]*@kelabome\/agents/
  );
});

test("the two runtimes cannot collide in one config file", () => {
  // Someone who uses both packages has two configs, but nothing stops them
  // pointing `--config` at one file. The containers differ, so both installs
  // coexist and each uninstall takes only its own.
  const both = applyInstall(applyInstall({}, OPTS).config, CLAUDE_OPTS);
  const openManifest = applyInstall({}, OPTS);
  assert.ok(both.config.mcp[MCP_KEY], "opencode entry survived");
  assert.ok(both.config.mcpServers[MCP_KEY], "Claude Code entry landed");
  const { config: afterClaude } = removeInstall(both.config, both);
  assert.equal(afterClaude.mcpServers, undefined, "ours went");
  assert.ok(afterClaude.mcp[MCP_KEY], "theirs stayed");
  const { config: afterBoth } = removeInstall(afterClaude, openManifest);
  assert.deepEqual(afterBoth, {});
});

// --- the plugin spec, and the silence around it ------------------------------
//
// A spec opencode cannot resolve is not an error anywhere. Measured against
// 1.18.6 with a probe plugin instrumented to record being called:
//
//   file:///…/node_modules/@kelabome/agents  -> server() called, serverUrl set
//   @kelabome/agents@0.3.0 (unpublished)     -> never called, empty cache dir,
//                                            nothing logged at any level
//
// The visible symptom was `kelabo_join` answering "No opencode session is bound.
// Run /kstart" — advice to repeat the thing that had silently done nothing —
// while the kelabo list was perfectly correct, because that goes over the
// tunnel. `describePluginSpec` is what lets `kelabo status` say so instead.

test("a file: spec is reported with the path to check", () => {
  const d = describePluginSpec("file:///home/dev/.npm/lib/node_modules/@kelabome/agents");
  assert.equal(d.kind, "file");
  assert.equal(d.path, "/home/dev/.npm/lib/node_modules/@kelabome/agents");
  assert.equal(d.why, null);
});

test("a percent-encoded path is decoded, because installs live in odd places", () => {
  // `pathToFileURL` encodes a space, and the prefix is the user's choice.
  assert.equal(describePluginSpec("file:///opt/my%20tools/agent").path, "/opt/my tools/agent");
});

test("a registry spec is flagged as the shape that fails invisibly", () => {
  const d = describePluginSpec("@kelabome/agents@0.3.0");
  assert.equal(d.kind, "registry");
  assert.equal(d.path, null);
  assert.match(d.why, /stays silent if that fails/);
});

test("a missing spec is named rather than passed over", () => {
  for (const empty of [null, undefined, ""]) {
    assert.equal(describePluginSpec(empty).kind, "none");
    assert.match(describePluginSpec(empty).why, /\/kstart cannot hand over/);
  }
});

test("an array spec — opencode's `[spec, opts]` form — is understood", () => {
  assert.equal(describePluginSpec(["file:///x/agent", { some: "option" }]).path, "/x/agent");
});

console.log(`\ninstall: ${passed} tests passed`);
