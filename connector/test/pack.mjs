// What the registry would receive.
//
// Everything asserted here is a mistake that is invisible in this repository and
// only fails on someone else's laptop, after `npm i -g`, with no useful message:
// a `file:` dependency npm cannot resolve, an unbundled `@kelabo/contracts`
// import, a plugin that does not have the shape opencode 1.18+ demands, or a
// `files` list that omits something the CLI reads at runtime.
import assert from "node:assert/strict";
import { readFile, stat, mkdtemp, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { pack } from "../build/pack.mjs";
import { RUNTIMES, RUNTIME_IDS } from "../src/runtimes.js";
import { ADAPTER_IDS } from "../src/adapters/index.js";

const execFile = promisify(execFileCb);

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
  } catch (err) {
    console.error(`FAIL ${name}`);
    throw err;
  }
}

const built = await pack();
const out = built.out;
const read = (f) => readFile(join(out, f), "utf8");
const manifest = JSON.parse(await read("package.json"));
const cli = await read("cli.js");
const server = await read("server.js");

await test("the manifest npm sees has no unresolvable dependency", () => {
  for (const [name, spec] of Object.entries(manifest.dependencies || {})) {
    assert.ok(!spec.startsWith("file:"), `${name} is ${spec}; npm cannot resolve that off this machine`);
    assert.ok(!spec.startsWith("link:"), `${name} is ${spec}`);
  }
  assert.ok(!manifest.private, "a private manifest cannot be published");
  assert.equal(manifest.publishConfig?.access, "public", "a scoped package defaults to restricted");
});

await test("contracts and zod are inlined, not imported", () => {
  for (const [what, code] of [["cli", cli], ["plugin", server]]) {
    assert.ok(!/from\s*["']@kelabo\/contracts/.test(code), `${what} still imports @kelabo/contracts`);
    assert.ok(!/from\s*["']zod["']/.test(code), `${what} still imports zod`);
  }
  // ...but the symbols it needs did come along.
  assert.ok(cli.includes("parseDownFrame") || cli.includes("kelabo-transcript"), "contracts content missing");
});

await test("only genuinely external deps are left external, and all are declared", () => {
  const imports = [...cli.matchAll(/from\s*["']([^."'][^"']*)["']/g)].map((m) => m[1]);
  const bare = imports.filter((i) => !i.startsWith("node:"));
  for (const i of bare) {
    const pkg = i.startsWith("@") ? i.split("/").slice(0, 2).join("/") : i.split("/")[0];
    assert.ok(manifest.dependencies?.[pkg], `${i} is imported but not a dependency`);
  }
});

await test("the bridge announces the built version, not a literal", () => {
  assert.ok(cli.includes(JSON.stringify(manifest.version)), "version was not injected");
  assert.ok(!/const VERSION = "1\.0\.0"/.test(cli), "the hard-coded version came back");
});

await test("the plugin has the shape opencode 1.18+ requires", async () => {
  // Verified against opencode 1.18.6: an npm plugin is imported through
  // exports["./server"] and must default-export an object carrying exactly one
  // of server() or tui(). A named export alone is only honoured by the
  // directory scanner, so publishing one would fail for every npm user.
  assert.equal(manifest.exports["./server"], "./server.js");
  const mod = await import(pathToFileURL(join(out, "server.js")).href);
  assert.ok(mod.default, "no default export");
  assert.equal(typeof mod.default.server, "function", "default export has no server()");
  assert.equal(mod.default.tui, undefined, "server() and tui() may not both be present");
  assert.ok(mod.default.id, "plugin has no id");
});

await test("no engines.opencode, which opencode enforces against itself", () => {
  // It semver-checks that field against the running opencode and throws on a
  // mismatch, so a guessed floor turns into a hard failure on their next
  // release rather than a warning.
  assert.equal(manifest.engines?.opencode, undefined);
  assert.ok(manifest.engines?.node, "node engine should be declared");
});

await test("every file the package promises is present", async () => {
  for (const entry of manifest.files) {
    const s = await stat(join(out, entry.replace(/\/$/, "")));
    assert.ok(s.isFile() || s.isDirectory(), `${entry} missing`);
  }
  for (const bin of Object.values(manifest.bin)) {
    assert.ok((await read(bin)).startsWith("#!"), `${bin} has no shebang`);
  }
});

await test("the CLI still runs when invoked through a bin symlink", async () => {
  // npm installs a bin as a symlink, and Node resolves the main module's real
  // path for import.meta.url while leaving process.argv[1] as the symlink. The
  // usual `import.meta.url === "file://" + process.argv[1]` guard therefore
  // never matches, and the whole CLI exits 0 having done nothing — for every
  // user who installs it the documented way, and for nobody who runs it from a
  // checkout. This is the only test that can see the difference.
  const dir = await mkdtemp(join(tmpdir(), "kelabo-bin-"));
  const link = join(dir, "kelabo");
  await symlink(join(out, "cli.js"), link);
  const { stdout } = await execFile(process.execPath, [link, "--version"]);
  assert.equal(stdout.trim(), manifest.version);
  await rm(dir, { recursive: true, force: true });
});

await test("the slash commands ship, and parse", async () => {
  for (const name of ["kstart.md", "kend.md"]) {
    const md = await read(join("commands", name));
    assert.match(md, /^---\n[\s\S]*?description:.*\n[\s\S]*?---\n/, `${name} has no front matter`);
  }
});

// --- one package, every runtime ---------------------------------------------

await test("one package and one binary, whatever runtimes it supports", () => {
  // Two packages was tried and reverted. Both declared the same `bin`, so npm
  // refused the second global install outright:
  //
  //     npm error EEXIST: file already exists
  //
  // and naming them apart left two commands that each silently covered half the
  // machine. A developer with opencode and Claude Code installs once.
  assert.equal(manifest.name, "@kelabome/agents");
  assert.deepEqual(Object.keys(manifest.bin), ["kelabo"]);
});

await test("every runtime in the registry ships an adapter", () => {
  // The registry is what `kelabo setup --runtime <id>` offers. A row without an
  // adapter wires a config whose bridge then refuses to start, which surfaces
  // as an MCP server that will not connect and no explanation of why.
  assert.deepEqual([...RUNTIME_IDS].sort(), [...ADAPTER_IDS].sort());
  for (const id of RUNTIME_IDS) {
    assert.ok(RUNTIMES[id].wiring?.mcpContainer, `${id} has no config wiring`);
    assert.ok(RUNTIMES[id].launch?.cli, `${id} has no launch subcommand`);
  }
});

await test("both injection paths are in the bundle, because the choice is made at run time", () => {
  // `KELABO_RUNTIME` decides, and it is written into the MCP entry by setup. If
  // either adapter were tree-shaken out, the runtime that needs it would get an
  // MCP server that dies on start.
  assert.ok(cli.includes("createOpencodeAdapter"), "opencode adapter missing");
  assert.ok(cli.includes("createClaudeCodeAdapter"), "Claude Code adapter missing");
  assert.ok(cli.includes("prompt_async"), "opencode injection path missing");
  assert.ok(cli.includes("notifications/claude/channel"), "channel injection path missing");
});

await test("the channel capability survives bundling", () => {
  // It is the entire registration handshake: Claude Code reads it out of the
  // initialize response and only then registers a notification listener. If it
  // were dropped or renamed, nothing would error — transcript would just never
  // arrive, in every install.
  assert.ok(cli.includes("claude/channel"), "the capability key is gone");
  assert.ok(
    !cli.includes("claude/channel/permission"),
    "the permission relay must never be advertised"
  );
});

await test("the CLI knows both runtimes when installed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kelabo-rt-"));
  const link = join(dir, "kelabo");
  await symlink(join(out, "cli.js"), link);
  const { stdout } = await execFile(process.execPath, [link, "runtimes"]);
  for (const id of RUNTIME_IDS) assert.match(stdout, new RegExp(id));
  await rm(dir, { recursive: true, force: true });
});

console.log(`pack: ${passed} tests passed`);
