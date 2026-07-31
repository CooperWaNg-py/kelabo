// The filesystem half of setup/uninstall (docs 17 §5).
//
// Everything that decides *what* to write lives in install.js and is pure.
// This file only finds the config, reads it, backs it up, writes it, and
// remembers what it did. The split is deliberate: the decisions are the part
// that can silently corrupt a developer's configuration, and they are the part
// `node test/install.mjs` can exercise without an opencode anywhere in sight.
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  copyFileSync,
  rmSync,
  readdirSync,
  statSync,
  renameSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseCommandMd, hasNonJsonSyntax, detectIndent, COMMAND_KEYS } from "./install.js";

/**
 * What `setup` wrote, per runtime.
 *
 * **Per runtime**, because a laptop can have both packages installed and both
 * wired, and this file is what `uninstall` reads to decide *which file to edit
 * and which keys are still ours*. One shared `install.json` meant the second
 * `setup` overwrote the first's record — and then `uninstall` for opencode read
 * a manifest describing the Claude Code install, followed its `configPath`, and
 * removed `mcpServers.kelabo` from `~/.claude.json` while leaving opencode fully
 * wired. Uninstalling one runtime uninstalled the other.
 *
 * The legacy path is still read for opencode (§ `readManifest`), so an install
 * made before the split still uninstalls cleanly.
 */
export function manifestPath(target = "opencode", env = process.env) {
  if (env.KELABO_INSTALL_FILE) return resolve(env.KELABO_INSTALL_FILE);
  return join(homedir(), ".kelabo", `install-${target}.json`);
}

export const LEGACY_MANIFEST_PATH = join(homedir(), ".kelabo", "install.json");

/** Kept for callers that only want a path to print. */
export const MANIFEST_PATH = manifestPath();

/**
 * Which runtimes look like they are on this machine.
 *
 * Used to turn `kelabo setup` into something a person can run without knowing
 * the flag: with one runtime present it is unambiguous, with two it drives the
 * prompt, with none it says so instead of wiring a config for something that
 * cannot spawn it.
 *
 * Two signals, either sufficient. A binary on PATH is the honest one. A config
 * file it has already written covers the case where the launcher is a shell
 * alias, a Homebrew shim outside this PATH, or an npx invocation — all of which
 * are normal, and none of which should make setup claim the runtime is absent.
 */
export function detectRuntimes(runtimes, { env = process.env, cwd = process.cwd() } = {}) {
  return Object.values(runtimes)
    .filter(
      (r) =>
        (r.detect?.bin && onPath(r.detect.bin, env)) ||
        existsSync(discoverConfigPath({ target: r.id, env, cwd }))
    )
    .map((r) => r.id);
}

function onPath(bin, env) {
  const dirs = String(env.PATH || "").split(process.platform === "win32" ? ";" : ":");
  const names = process.platform === "win32" ? [`${bin}.exe`, `${bin}.cmd`, bin] : [bin];
  return dirs.some((dir) => dir && names.some((n) => existsSync(join(dir, n))));
}

/**
 * Where the runtime will actually read from.
 *
 * opencode loads `opencode.json` **and** `opencode.jsonc` if both exist, so
 * "which one" is a real question rather than a fallback chain. When both are
 * present we edit the one already carrying `mcp` or `plugin` — that is the file
 * the developer thinks of as their config — and `.json` otherwise.
 *
 * Claude Code has no such ambiguity but a different layout, verified against
 * 2.1.220 by running `claude mcp add` at each scope under a scratch HOME:
 *
 *   user     ~/.claude.json          -> mcpServers.<name>      <- what we write
 *   project  ./.mcp.json             -> mcpServers.<name>      <- `--project`
 *   local    ~/.claude.json          -> projects[cwd].mcpServers
 *
 * `local` is deliberately not offered. It keys the server off an absolute
 * working directory, so the bridge exists in one checkout and silently does not
 * exist in another — and `$CLAUDE_CONFIG_DIR` relocates `.claude.json` whole,
 * which the same probe confirmed, so it is honoured here rather than assumed.
 */
export function discoverConfigPath({ explicit, project, target, env = process.env, cwd = process.cwd() } = {}) {
  if (explicit) return resolve(String(explicit));
  if (target === "claude-code") {
    // `.mcp.json` is the file Claude Code shares with a repository — it is meant
    // to be committed, and it is the only project-scope MCP config it reads.
    if (project) return join(cwd, ".mcp.json");
    const dir = env.CLAUDE_CONFIG_DIR ? resolve(env.CLAUDE_CONFIG_DIR) : homedir();
    return join(dir, ".claude.json");
  }
  if (project) return join(cwd, "opencode.json");
  if (env.OPENCODE_CONFIG) return resolve(env.OPENCODE_CONFIG);
  const dir = env.OPENCODE_CONFIG_DIR
    ? resolve(env.OPENCODE_CONFIG_DIR)
    : join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "opencode");
  const candidates = [join(dir, "opencode.json"), join(dir, "opencode.jsonc")];
  const present = candidates.filter((p) => existsSync(p));
  if (present.length === 0) return candidates[0];
  if (present.length === 1) return present[0];
  const carrying = present.find((p) => {
    try {
      const parsed = JSON.parse(readFileSync(p, "utf8"));
      return parsed && (parsed.mcp || parsed.plugin);
    } catch {
      return false;
    }
  });
  return carrying || present[0];
}

/**
 * Read and parse, or explain why not.
 *
 * The comment check has to come **before** the parse, not after it. A `.jsonc`
 * file with comments fails `JSON.parse` with "Expected property name at
 * position 4", which is both useless and wrong: the file is fine, it is our
 * parser that is too narrow. `nonJson` carries the real reason and lets the
 * caller print something a person can act on.
 */
export function readConfigFile(path) {
  if (!existsSync(path)) return { path, exists: false, text: "", indent: 2, config: {}, nonJson: null };
  const text = readFileSync(path, "utf8");
  const nonJson = hasNonJsonSyntax(text);
  const indent = detectIndent(text);
  if (nonJson) return { path, exists: true, text, indent, config: {}, nonJson };
  try {
    return {
      path,
      exists: true,
      text,
      indent,
      config: text.trim() ? JSON.parse(text) : {},
      nonJson: null,
    };
  } catch (err) {
    throw new Error(`${path} is not valid JSON (${err.message}). Fix it, or pass --config.`);
  }
}

/** Timestamped, and next to the original so it is obvious what it belongs to.
 *  Never overwritten: each setup leaves its own. */
export function backupConfigFile(path, now = new Date()) {
  if (!existsSync(path)) return null;
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  const backup = `${path}.kelabo-backup-${stamp}`;
  copyFileSync(path, backup);
  return backup;
}

/**
 * Replace the config, atomically, without widening who can read it.
 *
 * Both details are load-bearing on Claude Code and neither matters on opencode,
 * which is why they were not here before.
 *
 * `~/.claude.json` is mode 0600 and holds an OAuth account record and a user id.
 * A plain `writeFileSync` on a path that already exists keeps its mode — but if
 * the file is *absent* it creates one at 0644, so a `setup` that runs before the
 * first `claude` start would hand the world a file Claude Code then fills with a
 * credential. Copying the existing mode, and defaulting to 0600 for a file we
 * create, closes both cases.
 *
 * The write is tmp-then-rename because `~/.claude.json` is *live state* — Claude
 * Code rewrites it on its own schedule, not only when a user changes a setting.
 * A truncating write that loses the race leaves a half-written config that
 * neither side can parse; a rename either happens or does not. It cannot make
 * the read-modify-write atomic — a `claude` running during `setup` can still
 * overwrite our key with its own snapshot — which is why setup says to restart
 * it, and why there is a backup.
 */
export function writeConfigFile(path, config, indent = 2) {
  mkdirSync(dirname(path), { recursive: true });
  let mode = 0o600;
  try {
    mode = statSync(path).mode & 0o777;
  } catch {}
  const tmp = `${path}.kelabo-tmp-${process.pid}`;
  try {
    writeFileSync(tmp, JSON.stringify(config, null, indent) + "\n", { mode });
    renameSync(tmp, path);
  } catch (err) {
    try {
      rmSync(tmp, { force: true });
    } catch {}
    throw err;
  }
  return path;
}

function loadManifest(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/** Does this manifest describe the runtime asking for it?
 *
 *  The container name is the discriminator, and it is the one field that cannot
 *  be absent by accident: pre-split manifests have no `mcpContainer` at all, and
 *  every one of those was an opencode install. Guarding on it means a manifest
 *  can never be applied to the wrong config file even if the paths get crossed. */
function describes(manifest, target) {
  if (!manifest) return false;
  const container = manifest.wrote?.mcpContainer || "mcp";
  return container === (target === "claude-code" ? "mcpServers" : "mcp");
}

export function readManifest(path = MANIFEST_PATH, target) {
  const found = loadManifest(path);
  if (found) return found;
  // An install made before manifests were split. Only opencode can have one,
  // and `describes()` refuses to hand it to anything else.
  if (target && target !== "opencode") return null;
  const legacy = loadManifest(LEGACY_MANIFEST_PATH);
  return describes(legacy, target || "opencode") ? legacy : null;
}

export function writeManifest(manifest, path = MANIFEST_PATH) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600 });
  return path;
}

/** Clears the legacy file too, but only when it is this runtime's — otherwise
 *  an opencode uninstall would delete the record another install still needs. */
export function clearManifest(path = MANIFEST_PATH, target) {
  let removed = false;
  for (const candidate of [path, LEGACY_MANIFEST_PATH]) {
    if (candidate === LEGACY_MANIFEST_PATH && !describes(loadManifest(candidate), target || "opencode")) {
      continue;
    }
    try {
      rmSync(candidate);
      removed = true;
    } catch {}
  }
  return removed;
}

/**
 * The command opencode should spawn.
 *
 * An absolute interpreter and an absolute script, because an MCP server is
 * spawned by opencode and does not reliably inherit the PATH that had the npm
 * global bin on it. `["kelabo-mcp"]` works on the machine you tested it on.
 */
export function resolveMcpCommand(cliPath) {
  return [process.execPath, cliPath, "run"];
}

/** `commands/` sits beside cli.js in the published package and beside `src/` in
 *  the repository. Both are checked so `kelabo setup` behaves identically when
 *  run from a checkout. */
export function commandsDir(cliPath) {
  const here = dirname(cliPath);
  for (const candidate of [join(here, "commands"), join(here, "..", "commands")]) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`cannot find the slash command templates near ${here}`);
}

export function loadCommands(cliPath) {
  const dir = commandsDir(cliPath);
  const out = {};
  for (const key of COMMAND_KEYS) {
    const file = join(dir, `${key}.md`);
    if (!existsSync(file)) throw new Error(`missing command template: ${file}`);
    out[key] = parseCommandMd(readFileSync(file, "utf8"));
  }
  return out;
}

/**
 * Every bridge running on this machine.
 *
 * Plural, because there is one per opencode instance — each writes
 * `bridge-<its parent pid>.json` — and "is the bridge running?" is not a
 * yes/no question on a laptop with three sessions open. Dead entries are
 * reported rather than hidden: a lock left behind by a crashed bridge is
 * exactly the thing that used to misroute `/kstart`.
 */
export function readBridgeLocks() {
  const explicit = process.env.KELABO_BRIDGE_LOCK;
  const dir = join(homedir(), ".kelabo");
  const paths = explicit
    ? [explicit]
    : (() => {
        try {
          return readdirSync(dir)
            .filter((f) => /^bridge(-\d+)?\.json$/.test(f))
            .map((f) => join(dir, f));
        } catch {
          return [];
        }
      })();
  const seen = new Set();
  const locks = [];
  for (const path of paths) {
    try {
      const lock = JSON.parse(readFileSync(path, "utf8"));
      // bridge.json duplicates one of the per-pid files by design.
      const key = `${lock.pid}:${lock.port}`;
      if (seen.has(key)) continue;
      seen.add(key);
      locks.push({ path, ...lock, alive: isAlive(lock.pid) });
    } catch {}
  }
  return locks;
}

function isAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

export function listBackups(configPath) {
  try {
    const dir = dirname(configPath);
    const prefix = `${configPath.slice(dir.length + 1)}.kelabo-backup-`;
    return readdirSync(dir)
      .filter((f) => f.startsWith(prefix))
      .sort()
      .map((f) => join(dir, f));
  } catch {
    return [];
  }
}
