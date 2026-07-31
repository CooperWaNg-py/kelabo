#!/usr/bin/env node
// `kelabo` — the command-line half of the package (docs 17 §5).
//
// **One command, every runtime.** `setup`, `uninstall`, `status` and `reset` all
// take a selection — `--runtime <id>`, `--all`, an interactive pick, or the
// obvious one when only one coding agent is installed — and loop over it. A
// laptop with opencode and Claude Code on it runs `kelabo setup --all` once and
// has both wired, from one `npm i -g` and one pairing.
//
// The bridge itself is `index.js`; this file is only the wrapper a human types
// at, plus the `run` verb a runtime spawns over stdio. They are separate so that
// `startBridge()` stays importable without an argument parser attached, which is
// what lets test/smoke.mjs drive the whole bridge in-process.
//
// `run` is the one verb that does **not** take a selection: it reads
// `KELABO_RUNTIME` out of its own environment, which `setup` wrote into the MCP
// entry. The runtime that spawned the bridge is the one that says what it is.
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, sep } from "node:path";
import { existsSync, realpathSync, rmSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { readCredential, CREDENTIAL_PATH } from "./config.js";
import { login, promptApiBase } from "./login.js";
import { startBridge } from "./index.js";
import { BRIDGE_VERSION } from "./version.js";
import { applyInstall, removeInstall, inspectInstall, describePluginSpec, MCP_KEY } from "./install.js";
import { RUNTIMES, RUNTIME_IDS, runtime as runtimeRow, parseRuntimeList } from "./runtimes.js";
import { thirdPartyProvider } from "./adapters/claudeCode.js";
import { freePort, whichBin, launchPlan, runChild, splitForward, hasFlag } from "./launch.js";
import {
  discoverConfigPath,
  detectRuntimes,
  readConfigFile,
  backupConfigFile,
  writeConfigFile,
  readManifest,
  writeManifest,
  clearManifest,
  resolveMcpCommand,
  loadCommands,
  readBridgeLocks,
  manifestPath,
} from "./installer.js";

const CLI_PATH = fileURLToPath(import.meta.url);
const PKG = "@kelabome/agents";

const USAGE = `kelabo ${BRIDGE_VERSION} — attach your own coding agent to a kelabo

  kelabo opencode [-- …]    start opencode, wired, on a free port
  kelabo claude   [-- …]    start Claude Code with the Kelabo channel on
  kelabo setup              wire a runtime (or all of them), then pair
  kelabo login              pair (or re-pair) this machine with Kelabo
  kelabo status             what is paired, wired and running
  kelabo uninstall          remove the wiring; --purge also drops the credential
  kelabo reset              uninstall --purge, then setup
  kelabo run                the MCP server (a runtime spawns this; not for humans)

  --runtime ID    ${RUNTIME_IDS.join(", ")}; comma-separated for several
  --all           every runtime this machine has
  --api URL       Kelabo API base, e.g. https://kelabo.example.com/api
  --config PATH   config file to edit (implies a single --runtime)
  --project       edit the project-local config instead of the global one
  --no-pair       skip pairing during setup
  --dry-run       print what would change, write nothing
  --plugin-spec S override the opencode plugin spec (default: this package, pinned)

  One pairing serves every runtime: the token identifies you, not the agent.

  Anything after \`--\` goes straight to the coding agent, untouched:
    kelabo opencode -- ~/src/thing --model anthropic/claude-sonnet-4-5
    kelabo claude   -- --resume --model opus
  Add \`--dry-run\` before the \`--\` to print the command without running it.
`;

const out = (s) => process.stdout.write(s);

/** Long flags only, `--k v` and `--k=v` and bare booleans. A dependency for this
 *  would be a dependency shipped to every user of the package. */
export function parseArgs(argv) {
  const [cmd = "run", ...rest] = argv;
  const flags = {};
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i];
    if (!token.startsWith("--")) continue;
    const eq = token.indexOf("=");
    if (eq > -1) {
      flags[token.slice(2, eq)] = token.slice(eq + 1);
      continue;
    }
    const key = token.slice(2);
    const next = rest[i + 1];
    if (next && !next.startsWith("--")) {
      flags[key] = next;
      i++;
    } else {
      flags[key] = true;
    }
  }
  return { cmd, flags };
}

// --- choosing which runtimes to act on ---------------------------------------

/**
 * Resolve the selection, asking only when there is a real question.
 *
 * Order matters, and each step exists for a case that came up:
 *
 *  1. `--runtime` / `--all` — explicit always wins, and is the only form that
 *     works in a Makefile or a script.
 *  2. `--config PATH` — naming one file means one runtime; guessing which would
 *     be worse than refusing, because writing an opencode-shaped MCP entry into
 *     `~/.claude.json` produces a server Claude Code declines to start and does
 *     not say why.
 *  3. `installed` — what is already wired. For `uninstall` and `status` this is
 *     the right default: remove what we put there, not what happens to exist.
 *  4. detection — one coding agent on the machine is not a question.
 *  5. the prompt — two or more, and a terminal to ask in.
 *  6. refuse, naming the flag. Never a silent default: picking one for someone
 *     who has both means `uninstall` edits a config they were not thinking about.
 */
async function selectRuntimes(flags, { verb, installed = [] } = {}) {
  if (flags.all) return [...RUNTIME_IDS];
  if (flags.runtime && flags.runtime !== true) {
    const ids = parseRuntimeList(flags.runtime);
    if (!ids.length) throw new Error(`--runtime named no known runtime (${RUNTIME_IDS.join(", ")})`);
    return ids;
  }
  if (flags.config) {
    throw new Error(
      `--config names one file, so it needs one --runtime (${RUNTIME_IDS.join(", ")}) to say what shape to write into it.`
    );
  }

  if (installed.length === 1) return installed;
  if (installed.length > 1) return promptFor(installed, verb);

  const present = detectRuntimes(RUNTIMES);
  if (present.length === 1) {
    out(`  Only ${RUNTIMES[present[0]].display} found on this machine.\n`);
    return present;
  }
  if (present.length > 1) return promptFor(present, verb);

  throw new Error(
    `No coding agent found on this machine (looked for ${RUNTIME_IDS.map((id) => RUNTIMES[id].detect.bin).join(", ")}). ` +
      `Install one, or say which anyway: kelabo ${verb} --runtime ${RUNTIME_IDS[0]}`
  );
}

/** Ask, but only where asking works. A non-interactive shell gets an error that
 *  names the flag rather than a prompt into a closed stdin, which would hang a
 *  Makefile or a CI step forever. */
async function promptFor(ids, verb) {
  if (!process.stdin.isTTY) {
    throw new Error(
      `Several runtimes are available (${ids.join(", ")}) and this is not an interactive terminal. ` +
        `Pass --runtime <id> or --all.`
    );
  }
  out(`\n  Which runtime should \`${verb}\` act on?\n\n`);
  ids.forEach((id, i) => out(`    ${i + 1}. ${RUNTIMES[id].display}\n`));
  out(`    ${ids.length + 1}. all of them\n\n`);
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const answer = (await rl.question(`  Choose [1-${ids.length + 1}]: `)).trim();
  rl.close();
  const n = Number(answer);
  if (n === ids.length + 1) return [...ids];
  if (Number.isInteger(n) && n >= 1 && n <= ids.length) return [ids[n - 1]];
  // A typo must not silently become "all". Naming the id is unambiguous.
  const named = parseRuntimeList(answer);
  if (named.length) return named;
  throw new Error(`"${answer}" is not one of the choices.`);
}

/** Runtimes this machine has actually had `setup` run for. */
function installedRuntimes() {
  return RUNTIME_IDS.filter((id) => readManifest(manifestPath(id), id));
}

const heading = (id) => out(`\n  ── ${RUNTIMES[id].display} ${"─".repeat(Math.max(0, 46 - RUNTIMES[id].display.length))}\n`);

// --- setup -------------------------------------------------------------------

/**
 * What to put in `plugin[]` — the copy of this package that is already on disk.
 *
 * A `file:` URL, not `@kelabome/agents@x.y.z`, and this is the fix for a real bug:
 * a registry spec makes opencode fetch the package from npm into its own bun
 * cache, and when that fetch produces nothing it **says nothing**. It creates
 * `~/.cache/opencode/packages/@kelabome/agents@0.3.0/`, leaves it empty, logs no
 * error at any level, and carries on. The plugin is then simply absent, so
 * `/kstart` has no `command.execute.before` hook to fire, so no session id ever
 * reaches the bridge — and `kelabo_join` fails with "No opencode session is
 * bound. Run /kstart", which is advice to repeat the thing that just silently
 * did nothing. Meanwhile every tool works and the kelabo list is correct,
 * because those travel the tunnel. Confirmed against 1.18.6 with an empty cache
 * directory, and a probe plugin proved a `file:` spec loads and populates
 * `serverUrl`.
 *
 * Pointing at the installed directory is better than a pinned registry spec on
 * its own terms, too. docs 17 §3 pinned the version because the plugin and the
 * MCP server were two copies of this package on disk that had to stay in
 * lockstep; with a `file:` spec they are the *same* copy, so they cannot drift,
 * there is nothing to re-pin, and the first `opencode` start after `setup` no
 * longer needs the network (a known cost in §12).
 */
function resolvePluginSpec(flags, row) {
  // Claude Code has no plugin: the channel targets the session that spawned the
  // MCP server, so there is no second process to load anything.
  if (!row.wiring.plugin) return { spec: null, note: null };
  if (flags["plugin-spec"]) return { spec: String(flags["plugin-spec"]), note: null };

  // Installed: the package root sits beside cli.js and already declares
  // `exports["./server"]`, which is what opencode imports.
  const here = dirname(CLI_PATH);
  if (existsSync(join(here, "server.js")) && existsSync(join(here, "package.json"))) {
    return { spec: pathToFileURL(here).href, note: null };
  }

  // A checkout: src/cli.js has no sibling package to point at, so use the built
  // one. It is the same files the published package would carry.
  const built = join(CLI_PATH, "..", "..", "dist", "agent");
  if (existsSync(join(built, "server.js"))) {
    return {
      spec: pathToFileURL(built).href,
      note: `running from a checkout: plugin wired to ${built} (rebuild with \`npm run pack\`)`,
    };
  }

  // Refused rather than guessed. The only remaining candidate is a registry
  // spec, and writing one produces exactly the silent no-plugin install this
  // function exists to prevent.
  throw new Error(
    `no built plugin to point opencode at (looked beside ${here} and in ${built}).\n` +
      `  Run \`npm run pack\` in connector/ first, or pass --plugin-spec <spec>.`
  );
}

/** Wire one runtime. Returns false when nothing was written, so the caller can
 *  decide whether pairing and next-steps are still worth printing. */
async function setupRuntime(id, flags) {
  const row = runtimeRow(id);
  const wiring = row.wiring;
  const path = discoverConfigPath({ explicit: flags.config, project: flags.project, target: id });
  const file = readConfigFile(path);

  // `.jsonc` is a supported opencode config format and people put comments in
  // it. Round-tripping through JSON.parse/stringify deletes every one of them,
  // so we do not: we print the block and let the developer paste it. Destroying
  // someone's annotated config to save them a copy-paste is not a trade worth
  // making. `file.config` is `{}` in that case, so what gets printed is our own
  // keys with nothing of theirs mixed in — which is what you want to paste.
  const unsafe = file.nonJson;

  const plugin = resolvePluginSpec(flags, row);
  const manifestFile = manifestPath(id);
  const previous = readManifest(manifestFile, id);
  const { config, created, warnings, wrote } = applyInstall(file.config, {
    pkg: PKG,
    version: BRIDGE_VERSION,
    pluginSpec: plugin.spec,
    previousSpecs: [previous?.wrote?.pluginSpec].filter(Boolean),
    mcpCommand: resolveMcpCommand(CLI_PATH),
    // How `run` will know which adapter to use. Without it the bridge would
    // have to guess, and a wrong guess is a silent injection failure.
    environment: { KELABO_RUNTIME: id },
    commands: wiring.commands ? loadCommands(CLI_PATH) : undefined,
    wiring,
  });

  const block = {
    ...(wiring.plugin ? { plugin: config.plugin } : {}),
    [wiring.mcpContainer]: { [MCP_KEY]: config[wiring.mcpContainer][MCP_KEY] },
    ...(wiring.commands
      ? { command: Object.fromEntries(wiring.commands.map((k) => [k, config.command[k]])) }
      : {}),
  };

  if (unsafe) {
    out(
      `  ${path}\n  contains ${unsafe}, which rewriting would delete. Nothing was written.\n\n` +
        `  Merge this into it by hand${wiring.plugin ? ' (append to "plugin" if you already have one)' : ""}:\n\n` +
        `${JSON.stringify(block, null, 2)}\n\n` +
        `  Or point setup at a plain JSON file: kelabo setup --runtime ${id} --config <path>\n`
    );
    process.exitCode = 1;
    return false;
  }

  if (flags["dry-run"]) {
    out(`  would edit ${path}\n\n${JSON.stringify(block, null, 2)}\n`);
    for (const w of warnings) out(`  note: ${w}\n`);
    return false;
  }

  const backup = backupConfigFile(path);
  writeConfigFile(path, config, file.indent);
  writeManifest(
    {
      configPath: path,
      runtime: id,
      pkg: PKG,
      version: BRIDGE_VERSION,
      cliPath: CLI_PATH,
      created,
      wrote,
      backup,
      installedAt: new Date().toISOString(),
    },
    manifestFile
  );

  out(`  Wired into ${path}\n`);
  if (backup) out(`  Backup     ${backup}\n`);
  if (plugin.note) out(`  note: ${plugin.note}\n`);
  for (const w of warnings) out(`  note: ${w}\n`);
  return true;
}

/** The part that differs per runtime once it is wired: how to start it, and the
 *  failure that follows from not doing so. */
function printNextSteps(id) {
  const row = runtimeRow(id);
  out(`\n  Next, for ${row.display}:\n    1. kelabo ${row.launch.cli}\n`);
  if (row.launch.then) {
    out(`    2. ${row.launch.then}   inside the session you want in the kelabo\n`);
  } else {
    out(`    2. ask it to join your kelabo — it calls kelabo_join and lists them\n`);
  }
  // Why the launcher exists at all, rather than a line telling them to type the
  // flags. Both runtimes fail *silently* without them, so "you could also start
  // it yourself" needs the caveat attached to it.
  out(`\n     Starting it yourself works too, but:\n     ${row.launch.why}\n`);
  if (id === "claude-code") {
    out(
      `\n     Restart any Claude Code you already have open: it reads MCP servers at\n` +
        `     startup, and the channel flag is a launch argument.\n`
    );
    const provider = thirdPartyProvider();
    if (provider) {
      out(
        `\n  WARNING  ${provider} is set in this shell. Claude Code offers channels only on\n` +
          `           first-party auth, so transcript will never arrive while it is. Tools\n` +
          `           still work. \`kelabo status\` re-checks.\n`
      );
    }
  }
}

async function cmdSetup(flags) {
  const ids = await selectRuntimes(flags, { verb: "setup" });
  const wired = [];
  for (const id of ids) {
    if (ids.length > 1) heading(id);
    else out("\n");
    if (await setupRuntime(id, flags)) wired.push(id);
  }
  if (!wired.length) return;

  // One pairing for all of them: the token identifies the developer, not the
  // coding agent, so a second runtime never asks again.
  //
  // A pairing failure is reported, not thrown. The wiring above already
  // happened and is already recorded in the manifest, so aborting here would
  // leave a config edited, an uninstaller that knows about it, and a developer
  // told only that something went wrong — and would fail a `make
  // install-*-connector` whose actual job succeeded. What is left undone is one
  // recoverable command, so it is named.
  const credential = readCredential();
  let paired = Boolean(credential.agentToken);
  let pairError = null;
  if (!paired && !flags["no-pair"]) {
    try {
      const apiBaseUrl =
        flags.api || process.env.KELABO_API_BASE_URL || credential.apiBaseUrl || (await promptApiBase());
      await login({ apiBaseUrl, runtime: wired.join(","), label: flags.label || "" });
      paired = true;
    } catch (err) {
      pairError = err.message;
    }
  } else if (paired) {
    out(`\n  Paired as  ${credential.identity} (one pairing serves every runtime)\n`);
  }

  for (const id of wired) printNextSteps(id);

  if (!paired) {
    // Loud, and last, because nothing else in the output hints at it: an
    // unpaired bridge starts, serves its tools and fails every join.
    out(
      `\n  NOT PAIRED — the bridge cannot join a kelabo until it is.\n` +
        (pairError ? `  ${pairError}\n` : `  Skipped with --no-pair.\n`) +
        `  Run:  kelabo login --api https://<your-kelabo>/api\n`
    );
  }
  out("\n");
}

// --- uninstall ---------------------------------------------------------------

/**
 * What to remove when there is no manifest to say what was written.
 *
 * `~/.kelabo/install-<runtime>.json` can be gone — a purge, a new machine, a
 * dotfile repository that never carried it — and `uninstall` still has to clean
 * up. Describing this runtime's wiring gets the right keys removed; the absent
 * `wrote` values mean nothing is treated as "edited since setup", which is the
 * correct call when there is no baseline to compare against.
 */
function fallbackManifest(id) {
  const { mcpContainer, commands } = runtimeRow(id).wiring;
  return {
    wrote: {
      pkg: PKG,
      mcpContainer,
      ...(commands ? { commands: Object.fromEntries(commands.map((k) => [k, undefined])) } : {}),
    },
  };
}

async function uninstallRuntime(id, flags) {
  const row = runtimeRow(id);
  const manifestFile = manifestPath(id);
  const manifest = readManifest(manifestFile, id);
  const path =
    flags.config ||
    manifest?.configPath ||
    discoverConfigPath({ explicit: flags.config, project: flags.project, target: id });
  const file = readConfigFile(path);

  if (!file.exists) {
    out(`  Nothing to remove: ${path} does not exist.\n`);
  } else {
    const unsafe = file.nonJson;
    if (unsafe) {
      out(
        `  ${path}\n  contains ${unsafe}; rewriting would delete them, so nothing was changed.\n` +
          `  Remove the "${MCP_KEY}" entries under ${[
            row.wiring.plugin ? "plugin" : null,
            row.wiring.mcpContainer,
            row.wiring.commands ? "command" : null,
          ]
            .filter(Boolean)
            .join(", ")} by hand.\n`
      );
      process.exitCode = 1;
      return;
    }
    const { config, kept, removed, warnings } = removeInstall(file.config, manifest || fallbackManifest(id));
    if (flags["dry-run"]) {
      out(`  would edit ${path}\n  removing: ${removed.join(", ") || "nothing"}\n`);
      for (const w of warnings) out(`  note: ${w}\n`);
      return;
    }
    if (removed.length) {
      const backup = backupConfigFile(path);
      writeConfigFile(path, config, file.indent);
      out(`  Removed ${removed.join(", ")} from ${path}\n`);
      if (backup) out(`  Backup  ${backup}\n`);
    } else {
      out(`  Nothing of ours found in ${path}\n`);
    }
    for (const k of kept) out(`  Kept    ${k} — you have edited it since setup\n`);
  }
  if (!flags["dry-run"]) clearManifest(manifestFile, id);
}

async function cmdUninstall(flags) {
  // Default to what we actually installed rather than what exists: removing our
  // own wiring is the job, and a machine can have a runtime installed that we
  // never touched.
  const installed = installedRuntimes();
  const ids = await selectRuntimes(flags, { verb: "uninstall", installed });

  for (const id of ids) {
    if (ids.length > 1) heading(id);
    else out("\n");
    await uninstallRuntime(id, flags);
  }
  if (flags["dry-run"]) return;

  // Locks are not per runtime — each is per *instance* of whatever spawned a
  // bridge — so they are only cleared once everything is gone. Removing them
  // while another runtime is still wired would misroute its next `/kstart`.
  const remaining = installedRuntimes();
  if (!remaining.length) {
    for (const lock of readBridgeLocks()) {
      try {
        rmSync(lock.path);
        out(`\n  Removed ${lock.path}${lock.alive ? ` (bridge pid ${lock.pid} still running)` : ""}\n`);
      } catch {}
    }
  } else {
    out(`\n  Still wired: ${remaining.map((id) => RUNTIMES[id].display).join(", ")}\n`);
  }

  if (flags.purge) {
    if (remaining.length) {
      // The credential is shared, so purging it would silently break the
      // runtimes still wired.
      out(
        `  Not purging the credential: ${remaining.map((id) => RUNTIMES[id].display).join(", ")} still uses it.\n` +
          `  Run \`kelabo uninstall --all --purge\` to remove everything.\n`
      );
    } else {
      const credential = readCredential();
      try {
        rmSync(CREDENTIAL_PATH);
        out(`  Removed ${CREDENTIAL_PATH}\n`);
      } catch {}
      // Honest about the limit: revoking needs a signed-in browser, because
      // DELETE /agent/tokens/:jti authenticates with a session cookie and not
      // with the agent token itself. Deleting the file locally does not stop the
      // token working, so say where to actually kill it.
      const portal = (credential.apiBaseUrl || "").replace(/\/api\/?$/, "");
      out(
        `\n  The agent token is deleted locally but NOT revoked — that needs a signed-in\n` +
          `  browser. Revoke it at ${portal ? `${portal}/settings` : "your Kelabo Settings page"}\n`
      );
    }
  }

  if (!remaining.length) out(`\n  Finally: npm rm -g ${PKG}\n`);
  out("\n");
}

// --- status ------------------------------------------------------------------

async function probe(url, timeoutMs = 3000) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return { ok: res.ok, status: res.status };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

const mark = (ok) => (ok ? "ok  " : "FAIL");

async function statusRuntime(id, flags) {
  const row = runtimeRow(id);
  const manifestFile = manifestPath(id);
  const manifest = readManifest(manifestFile, id);
  const path =
    flags.config || manifest?.configPath || discoverConfigPath({ project: flags.project, target: id });
  const file = existsSync(path) ? readConfigFile(path) : { config: {}, exists: false };
  const found = inspectInstall(file.config, manifest || fallbackManifest(id));

  out(`  ${mark(found.complete)} wired in ${path}${file.exists ? "" : " (missing)"}\n`);

  // The plugin, checked rather than printed. An unresolvable spec is the one
  // failure here with no symptom of its own: opencode loads no plugin, logs
  // nothing, `/kstart` does nothing, and `kelabo_join` then blames the developer
  // for not running `/kstart`. Only opencode has a plugin at all.
  if (row.wiring.plugin) {
    const spec = describePluginSpec(found.plugin);
    if (spec.kind === "file") {
      const ok = existsSync(join(spec.path, "server.js"));
      out(`  ${mark(ok)} plugin  ${spec.path}${ok ? "" : " — server.js is not there"}\n`);
      if (!ok) {
        out(
          `       Without it opencode loads no plugin, silently, and \`/kstart\` cannot hand\n` +
            `       over the session — kelabo_join then says you never ran it. Re-run\n` +
            `       \`kelabo setup --runtime ${id}\`.\n`
        );
      }
    } else {
      out(`  ---- plugin  ${found.plugin ?? "(none)"}\n       ${spec.why}\n`);
    }
  }
  if (found.mcpCommand) {
    const script = found.mcpCommand[1];
    const present = script && existsSync(script);
    out(
      `  ${mark(present)} ${found.mcpContainer}.${MCP_KEY} -> ${script}${present ? "" : " (does not exist)"}\n`
    );
  }
  if (!found.complete) {
    out(`       run \`kelabo setup --runtime ${id}\`\n`);
    return;
  }

  // Can transcript actually be delivered? The invisible failure on every
  // runtime: tools travel the tunnel and keep working, so an agent that hears
  // nothing looks exactly like an agent choosing to stay quiet.
  if (id === "claude-code") {
    // Not probeable from here — a channel is registered at Claude Code's
    // startup from its own argv, and nothing about it is observable over a
    // socket or from the config. So report the precondition that *is* checkable
    // and name the other rather than implying it is fine.
    const provider = thirdPartyProvider();
    out(
      `  ${mark(!provider)} first-party auth${provider ? ` — ${provider} is set` : ""}\n` +
        (provider
          ? `       Claude Code does not offer channels on Bedrock, Vertex or Foundry, so no\n` +
            `       transcript can arrive. Unset ${provider} to use channels.\n`
          : "")
    );
    out(
      `  ---- channel flag: cannot be checked from here\n` +
        `       Start the session with \`kelabo claude\`, which passes it.\n` +
        `       A notification sent to a channel nobody enabled is dropped with no error\n` +
        `       at either end, so this is the first thing to suspect when tools work and\n` +
        `       no transcript arrives. The bridge checks its own parent's command line at\n` +
        `       startup and says so through kelabo_join when it can see the flag missing.\n`
    );
  } else {
    const baseUrl = (process.env.OPENCODE_BASE_URL || "http://127.0.0.1:4096").replace(/\/+$/, "");
    const health = await probe(`${baseUrl}/global/health`);
    out(
      `  ${mark(health.ok)} opencode serving at ${baseUrl}\n` +
        (health.ok
          ? ""
          : `       not reachable. Transcript is delivered over HTTP, so without this the\n` +
            `       agent hears nothing. Start it as \`opencode --port 4096\`.\n`)
    );
  }
}

async function cmdStatus(flags) {
  const credential = readCredential();
  out(`\n  kelabo ${BRIDGE_VERSION}\n\n`);

  // 1. Paired. One credential, every runtime.
  if (!credential.agentToken) {
    out(`  ${mark(false)} not paired — run \`kelabo login\`\n`);
  } else {
    const expiry = credential.expiresAt ? new Date(credential.expiresAt) : null;
    const expired = expiry && expiry.getTime() < Date.now();
    out(
      `  ${mark(!expired)} paired as ${credential.identity} (${credential.label || "agent"})` +
        `${expiry ? `, token ${expired ? "EXPIRED" : "valid until"} ${expiry.toISOString().slice(0, 10)}` : ""}\n`
    );
    if (credential.apiBaseUrl) {
      // Generous, because the control plane is a Lambda and a cold start alone
      // can outlast a tight timeout — reporting "your token is broken" when the
      // truth is "nobody has called this in an hour" sends people to the wrong
      // problem entirely.
      const res = await fetch(`${credential.apiBaseUrl}/agent/kelabos`, {
        headers: { authorization: `Bearer ${credential.agentToken}` },
        signal: AbortSignal.timeout(15000),
      }).catch((err) => ({ ok: false, status: 0, error: err.message }));
      out(
        `  ${mark(res.ok)} control plane ${credential.apiBaseUrl}` +
          `${res.ok ? "" : ` — ${res.status === 401 ? "token rejected" : res.error || `HTTP ${res.status}`}`}\n`
      );
    }
  }

  // 2. Every runtime, wired or not — `status` is the place to find out that the
  //    one you meant was never set up, so it never asks which one.
  const installed = installedRuntimes();
  const detected = detectRuntimes(RUNTIMES);
  const explicit = flags.all || (flags.runtime && flags.runtime !== true) ? await selectRuntimes(flags, { verb: "status" }) : null;
  const ids = explicit || [...new Set([...installed, ...detected])];

  if (!ids.length) {
    out(`\n  ---- no coding agent found and nothing wired — run \`kelabo setup\`\n`);
  }
  for (const id of ids) {
    heading(id);
    if (!installed.includes(id) && !explicit) {
      out(`  ---- installed on this machine, not wired — \`kelabo setup --runtime ${id}\`\n`);
      continue;
    }
    await statusRuntime(id, flags);
  }

  // 3. Which bridges are up? One per runtime *instance*, so this is a list and
  //    not a per-runtime fact.
  out("\n");
  const locks = readBridgeLocks();
  if (locks.length === 0) out(`  ---- no bridge running (a runtime spawns it when it starts)\n`);
  for (const lock of locks) {
    out(
      `  ${mark(lock.alive)} bridge port ${lock.port} pid ${lock.pid}` +
        `${lock.runtime ? ` [${lock.runtime}]` : ""}${lock.ppid ? ` (parent ${lock.ppid})` : ""}` +
        `${lock.alive ? "" : " — STALE, delete " + lock.path}\n`
    );
  }

  out(`\n  credential ${CREDENTIAL_PATH}\n`);
  for (const id of installed) out(`  manifest   ${manifestPath(id)}\n`);
  out("\n");
}

// --- kelabo opencode | kelabo claude -----------------------------------------

/**
 * Start the coding agent with the flags that make it work.
 *
 * The whole point is that nobody should have to remember these. Both runtimes
 * need a launch argument that is easy to forget and whose absence is *silent*:
 * every tool keeps working, so the agent joins, posts, reads the board, and
 * never hears a word of the kelabo.
 *
 * Everything after the subcommand is forwarded to the child, after ours, so
 * `kelabo opencode ~/src/thing` and `kelabo claude --model …` behave as
 * expected and can override what we chose.
 */
async function cmdLaunch(id, argv) {
  const row = runtimeRow(id);

  // `kelabo opencode [ours] -- [theirs]`. Everything after `--` is handed over
  // verbatim and never inspected, even if it looks like one of ours — which is
  // the point: `kelabo opencode -- --dry-run` is opencode's flag, not this one.
  // Without a `--`, unrecognised tokens still forward, because `kelabo claude
  // -p hi` is what people actually type.
  const { own, forward } = splitForward(argv);
  const OURS = ["dry-run"];
  const mine = {};
  const loose = [];
  for (const token of own) {
    const bare = token.startsWith("--") ? token.slice(2).split("=")[0] : null;
    if (bare && OURS.includes(bare)) mine[bare] = true;
    else loose.push(token);
  }
  // Tokens written before `--` keep their position relative to those after it,
  // so the runtime sees them in the order they were typed.
  const extra = [...loose, ...forward];

  const bin = whichBin(row.launch.bin);
  if (!bin) {
    throw new Error(
      `${row.launch.bin} is not on your PATH, so there is nothing to start. Install ${row.display} first.`
    );
  }

  // Wiring is checked, not assumed. Starting the runtime without it produces an
  // agent with no Kelabo tools at all, which looks like the launcher failed
  // when it is setup that never ran.
  if (!readManifest(manifestPath(id), id)) {
    out(
      `\n  ${row.display} is not wired to Kelabo yet — starting it anyway, but it will\n` +
        `  have no kelabo tools. Run:  kelabo setup --runtime ${id}\n\n`
    );
  } else if (!readCredential().agentToken) {
    // Not fatal: their editor is still their editor, and refusing to start it
    // because Kelabo is unpaired would be taking something away that has
    // nothing to do with us.
    out(`\n  Not paired with Kelabo — the tools will load but cannot join a kelabo.\n  Run:  kelabo login\n\n`);
  }

  if (id === "claude-code") {
    const provider = thirdPartyProvider();
    if (provider) {
      out(
        `\n  WARNING  ${provider} is set. Claude Code offers channels only on first-party\n` +
          `           auth, so no kelabo transcript can reach this session however it is\n` +
          `           started. Board tools still work.\n\n`
      );
    }
  }

  // No point allocating one the developer has already chosen — and on opencode
  // passing both would bind neither (see `args` in runtimes.js).
  const port = row.launch.needsPort && !hasFlag(extra, "port") ? await freePort() : undefined;
  const plan = launchPlan(row, { port, extra, env: process.env });

  // Echoed, always. This command exists to supply arguments the developer did
  // not type, and hiding them would make it magic — the one property that turns
  // "it does not hear me" into an unanswerable question.
  out(`  → ${plan.display}\n\n`);
  if (mine["dry-run"]) {
    out(`  --dry-run: nothing was started. Pass \`-- --dry-run\` to give it to ${row.display}.\n\n`);
    return;
  }
  process.exitCode = await runChild(bin, plan.args, plan.env);
}

// --- the rest ----------------------------------------------------------------

async function cmdLogin(flags) {
  const stored = readCredential();
  const apiBaseUrl =
    flags.api || process.env.KELABO_API_BASE_URL || stored.apiBaseUrl || (await promptApiBase());
  // No runtime selection: one credential serves all of them. What goes on the
  // wire is a label for the Settings page, not a binding.
  await login({
    apiBaseUrl,
    runtime: flags.runtime && flags.runtime !== true ? String(flags.runtime) : installedRuntimes().join(",") || "agent",
    label: flags.label || "",
  });
}

export async function main(argv) {
  const rest = argv.slice(2);
  const { cmd, flags } = parseArgs(rest);

  // `kelabo opencode` / `kelabo claude` — dispatched off the registry, so a new
  // runtime brings its own subcommand with it. Handled before anything reads
  // `flags`, because every remaining argument belongs to the child and must not
  // be interpreted here.
  const launching = RUNTIME_IDS.find((id) => RUNTIMES[id].launch.cli === cmd);
  if (launching) return cmdLaunch(launching, rest.slice(1));

  switch (cmd) {
    case "setup":
      return cmdSetup(flags);
    case "uninstall":
      return cmdUninstall(flags);
    case "reset": {
      // Same selection for both halves, resolved once — otherwise the uninstall
      // prompt is answered and then the setup prompt asks again.
      const ids = await selectRuntimes(flags, { verb: "reset", installed: installedRuntimes() });
      const pinned = { ...flags, runtime: ids.join(","), all: false };
      await cmdUninstall({ ...pinned, purge: true });
      return cmdSetup(pinned);
    }
    case "login":
      return cmdLogin(flags);
    case "status":
    case "doctor":
      return cmdStatus(flags);
    case "run":
      await startBridge();
      return;
    case "runtimes":
      out(`\n${RUNTIME_IDS.map((id) => `  ${id.padEnd(14)}${RUNTIMES[id].display}`).join("\n")}\n\n`);
      return;
    case "help":
    case "--help":
    case "-h":
      return out(USAGE);
    case "version":
    case "--version":
    case "-v":
      return out(`${BRIDGE_VERSION}\n`);
    default:
      process.stderr.write(`unknown command: ${cmd}\n\n${USAGE}`);
      process.exitCode = 1;
  }
}

/** Was this file run, rather than imported?
 *
 *  `import.meta.url === "file://" + process.argv[1]` is the usual spelling and
 *  it is wrong for a `bin`. npm installs a bin as a **symlink**
 *  (`prefix/bin/kelabo -> lib/node_modules/@kelabome/agents/cli.js`);
 *  Node resolves the main module to its real path for `import.meta.url` but
 *  leaves `process.argv[1]` as the symlink it was invoked through, so the two
 *  never match and `kelabo <anything>` exits 0 having done nothing at all.
 *  That is the entire published CLI, silently inert, for every user who
 *  installs it the documented way.
 *
 *  `fileURLToPath` rather than string concatenation for the same class of
 *  reason: a path containing a space is percent-encoded in the URL and is not. */
function invokedDirectly() {
  try {
    return realpathSync(process.argv[1]) === realpathSync(CLI_PATH);
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  main(process.argv).catch((err) => {
    process.stderr.write(`kelabo: ${err.message}\n`);
    process.exit(1);
  });
}
