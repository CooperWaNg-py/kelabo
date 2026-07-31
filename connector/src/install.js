// Editing a file the developer owns (docs 17 §6).
//
// This is the dangerous part of the package. Not the network, not the MCP
// protocol — mutating somebody's coding-agent configuration, which they wrote by
// hand, which may have been working for a year, and which they will not diff
// after running our installer.
//
// So it follows the same rule as envelope.js, transcriptQueue.js and
// rtc/reconcile.js: no fs, no process, no clock. Plain data in, plain data out,
// and the property that matters — apply then remove is the identity — is
// checkable by `node test/install.mjs` with no opencode and no kelabo.
//
// The invariant every function here serves: `kelabo uninstall` must leave the
// config byte-equivalent to what it was before `kelabo setup` ran, and must
// never delete or overwrite something the developer has since changed.

/** The one MCP server we own. Anything else in the container is theirs.
 *
 *  It is also the *channel* name on Claude Code: `server:kelabo` is resolved
 *  against the configured MCP servers, so the two cannot drift apart. */
export const MCP_KEY = "kelabo";

/** The slash commands we own, in the order they are written. opencode only —
 *  Claude Code has no inline-command config key, and writing files into its
 *  commands directory is the kind of state §1 exists to avoid. */
export const COMMAND_KEYS = ["kstart", "kend"];

/**
 * How each runtime wants an MCP server described, and which top-level key holds
 * it. Both shapes are verified against the shipped binaries rather than docs.
 *
 * `opencode` (1.18.6): `mcp.<name> = {type:"local", command:[argv…],
 * environment:{}}` — one argv array, and the env key is `environment`.
 *
 * `claude-code` (2.1.220): `mcpServers.<name> = {type:"stdio", command:"…",
 * args:[…], env:{}}` — the interpreter is split from its arguments, and the env
 * key is `env`. Confirmed by running `claude mcp add` under a scratch HOME and
 * reading back what it wrote, because writing an opencode-shaped entry here
 * produces a server Claude Code silently declines to start.
 *
 * Pure, and separate from `applyInstall`, so the difference between the two
 * runtimes is one function a test can compare against a recorded fixture.
 */
export const MCP_SHAPES = ["opencode", "claude-code"];

export function mcpEntryFor(shape, command, environment = {}) {
  const hasEnv = Object.keys(environment).length > 0;
  if (shape === "claude-code") {
    const [interpreter, ...args] = command;
    return {
      type: "stdio",
      command: interpreter,
      args,
      ...(hasEnv ? { env: { ...environment } } : {}),
    };
  }
  return {
    type: "local",
    command: [...command],
    ...(hasEnv ? { environment: { ...environment } } : {}),
  };
}

/** What `applyInstall` writes when the caller does not say. Keeping opencode
 *  the default is what lets every pre-existing call site and test stand. */
export const OPENCODE_WIRING = {
  mcpContainer: "mcp",
  mcpShape: "opencode",
  plugin: true,
  commands: COMMAND_KEYS,
};

/** `@scope/name@1.2.3` -> `@scope/name`; `name@latest` -> `name`.
 *  Used so a re-pinned spec still matches the one we installed: opencode itself
 *  deduplicates plugin specs on the parsed package name, so two versions of us
 *  in that array is not a state either side considers legal.
 *
 *  A `file:` spec has no package name to parse and is returned whole; matching
 *  it is `isOurPluginSpec`'s job, not this one's. */
export function packageNameFromSpec(spec) {
  const s = String(Array.isArray(spec) ? spec[0] : spec);
  if (/^(file:|\.{0,2}\/)/.test(s)) return s;
  const at = s.indexOf("@", s.startsWith("@") ? 1 : 0);
  return at > 0 ? s.slice(0, at) : s;
}

/** Ours, whichever form it took: the published package at any version, or the
 *  `file:` spec `setup` writes when run from a checkout of this repository. */
export function isOurPluginSpec(spec, { pkg, pluginSpec }) {
  const s = String(Array.isArray(spec) ? spec[0] : spec);
  if (pkg && packageNameFromSpec(s) === pkg) return true;
  return Boolean(pluginSpec && s === String(pluginSpec));
}

/**
 * Will opencode actually be able to load this plugin spec?
 *
 * Pure, and separate, because the failure it describes is the worst kind this
 * package has: a spec opencode cannot resolve is not an error anywhere. It
 * creates an empty cache directory, logs nothing at any level, and runs without
 * the plugin — so `/kstart` has no hook, no session id reaches the bridge, and
 * `kelabo_join` reports "No opencode session is bound. Run /kstart", which is
 * advice to repeat exactly what just silently did nothing. Every tool still
 * works and the kelabo list is still correct, because those go over the tunnel.
 *
 * Whether the path exists is the caller's to answer — this stays free of `fs` —
 * and it is what turns the whole class into one visible line in `kelabo status`.
 *
 * @param {string|null} spec
 * @returns {{kind: "file"|"registry"|"none", path: string|null, why: string|null}}
 */
export function describePluginSpec(spec) {
  const s = spec == null ? "" : String(Array.isArray(spec) ? spec[0] : spec);
  if (!s) {
    return { kind: "none", path: null, why: "no plugin spec configured, so /kstart cannot hand over the session" };
  }
  if (s.startsWith("file:")) {
    let path = s.slice("file:".length).replace(/^\/\/+/, "/");
    try {
      path = decodeURIComponent(path);
    } catch {}
    return { kind: "file", path, why: null };
  }
  return {
    kind: "registry",
    path: null,
    // Not wrong — a published package resolves fine — but it is the shape that
    // fails invisibly when it is not, so name the check rather than pass it.
    why: `opencode fetches ${s} from npm and stays silent if that fails. Re-run \`kelabo setup\` to point it at the copy already installed here.`,
  };
}

/** A path that will not still be there tomorrow.
 *
 *  opencode spawns the MCP server by absolute path, so pointing it at an npx
 *  cache entry works exactly until the cache is pruned — and then the bridge
 *  stops existing with no error anyone can act on: the tools simply vanish from
 *  the session. Refusing at setup is the only place this is diagnosable. */
export function isEphemeralPath(path) {
  const p = String(path || "").replace(/\\/g, "/");
  return /\/_npx\//.test(p) || /\/\.npm\/_npx\//.test(p) || /\/npm-cache\/_npx\//.test(p);
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (typeof a !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => deepEqual(a[k], b[k]));
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

/** Front matter to `{description, template}`.
 *
 *  The `.md` files stay the authoring format — the Rig installs them as files,
 *  and a markdown file with front matter is what an opencode user expects to
 *  read — but `setup` inlines them into the config, because a key can be removed
 *  exactly and a file cannot. */
export function parseCommandMd(text) {
  const src = String(text).replace(/^\uFEFF/, "");
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(src);
  if (!match) return { description: "", template: src.trim() };
  const meta = {};
  for (const line of match[1].split(/\r?\n/)) {
    const at = line.indexOf(":");
    if (at < 1) continue;
    meta[line.slice(0, at).trim()] = line
      .slice(at + 1)
      .trim()
      .replace(/^["'](.*)["']$/, "$1");
  }
  return { description: meta.description || "", template: src.slice(match[0].length).trim() };
}

/**
 * Add our keys — three on opencode, one on Claude Code.
 *
 * @param {object} config  the parsed runtime config (not mutated)
 * @param {{pkg: string, version: string, mcpCommand: string[],
 *          environment?: object, wiring?: object,
 *          commands?: Record<string, {description: string, template: string}>}} opts
 * @returns {{config: object, wrote: object, created: string[], warnings: string[]}}
 */
export function applyInstall(
  config,
  {
    pkg,
    version,
    pluginSpec: pluginSpecOverride,
    // What a previous setup wrote, from the manifest. Needed because the spec
    // can legitimately change shape — a `file:` checkout spec today, the
    // published package tomorrow — and the new one does not match the old by
    // package name. Without this both survive and opencode loads the plugin
    // twice.
    previousSpecs = [],
    mcpCommand,
    environment = {},
    commands,
    wiring = OPENCODE_WIRING,
  }
) {
  const warnings = [];
  if (!pkg) throw new Error("applyInstall: pkg is required");
  if (!Array.isArray(mcpCommand) || mcpCommand.length < 2) {
    throw new Error("applyInstall: mcpCommand must be [interpreter, script, ...]");
  }
  for (const part of mcpCommand) {
    if (isEphemeralPath(part)) {
      throw new Error(
        `refusing to write an npx cache path into your config (${part}). ` +
          `Install the package properly first: npm i -g ${pkg}`
      );
    }
  }
  const container = wiring.mcpContainer || "mcp";

  const next = clone(config) || {};
  // Which containers did not exist before we touched the file. Removal uses this
  // to decide between deleting a key and leaving an empty one that was already
  // there — the difference between restoring the file and editing it.
  const created = [];

  // Pinned to the version of the CLI writing it, so the plugin (which opencode
  // fetches into its own bun cache) and the MCP server (installed by npm) stay
  // in lockstep — they share the loopback port published in bridge.json.
  // Overridable because `setup` run from a checkout has no published package to
  // point at and wires the checkout instead.
  //
  // Claude Code has no plugin to pin: the channel targets the session that
  // spawned the MCP server, so there is no second process and nothing to keep
  // in lockstep. `wiring.plugin` being false is what skips the key entirely
  // rather than writing an empty array into somebody's config.
  let pluginSpec = null;
  if (wiring.plugin) {
    pluginSpec = pluginSpecOverride || (version ? `${pkg}@${version}` : pkg);
    if (!Array.isArray(next.plugin)) {
      if (next.plugin !== undefined) {
        warnings.push(`replacing a non-array "plugin" value (${typeof next.plugin})`);
      } else {
        created.push("plugin");
      }
      next.plugin = [];
    }
    const known = [pluginSpec, ...previousSpecs].filter(Boolean);
    const others = next.plugin.filter(
      (s) => !known.some((spec) => isOurPluginSpec(s, { pkg, pluginSpec: spec }))
    );
    if (others.length !== next.plugin.length) {
      warnings.push(`replaced an existing ${pkg} plugin entry`);
    }
    next.plugin = [...others, pluginSpec];
  }

  const mcp = mcpEntryFor(wiring.mcpShape || "opencode", mcpCommand, environment);
  if (!next[container] || typeof next[container] !== "object" || Array.isArray(next[container])) {
    if (next[container] !== undefined) warnings.push(`replacing a non-object "${container}" value`);
    else created.push(container);
    next[container] = {};
  }
  if (next[container][MCP_KEY] && !deepEqual(next[container][MCP_KEY], mcp)) {
    warnings.push(`replaced an existing ${container}.${MCP_KEY} server`);
  }
  next[container] = { ...next[container], [MCP_KEY]: mcp };

  const commandKeys = wiring.commands || [];
  let wroteCommands;
  if (commandKeys.length) {
    wroteCommands = {};
    if (!next.command || typeof next.command !== "object" || Array.isArray(next.command)) {
      if (next.command !== undefined) warnings.push('replacing a non-object "command" value');
      else created.push("command");
      next.command = {};
    }
    const nextCommand = { ...next.command };
    for (const key of commandKeys) {
      const value = commands?.[key];
      if (!value) throw new Error(`applyInstall: missing command ${key}`);
      const entry = { description: value.description, template: value.template };
      if (nextCommand[key] && !deepEqual(nextCommand[key], entry)) {
        warnings.push(`replaced an existing /${key} command`);
      }
      nextCommand[key] = entry;
      wroteCommands[key] = entry;
    }
    next.command = nextCommand;
  }

  return {
    config: next,
    created,
    warnings,
    // Cloned, deliberately. The manifest is the baseline that later tells an
    // edited key from an untouched one; if it shared object identity with the
    // config it describes, editing the config would edit its own baseline and
    // every comparison would report "unchanged".
    //
    // `mcpContainer` rides along because removal happens later, from a different
    // process, reading only this manifest — it cannot re-derive which key it
    // wrote into from a package that may by then be a different version.
    wrote: clone({
      ...(pluginSpec ? { pluginSpec } : {}),
      pkg,
      mcpContainer: container,
      mcp,
      ...(wroteCommands ? { commands: wroteCommands } : {}),
    }),
  };
}

/**
 * Remove our three keys — and only ours, and only if they are still ours.
 *
 * Anything the developer has edited since is left exactly where it is and named
 * in `kept`, because silently reverting someone's change is worse than leaving
 * a stale key behind: the key is visible, the lost edit is not.
 *
 * @param {object} config
 * @param {{wrote: object, created?: string[]}} manifest
 * @returns {{config: object, kept: string[], removed: string[], warnings: string[]}}
 */
export function removeInstall(config, manifest) {
  const next = clone(config) || {};
  const kept = [];
  const removed = [];
  const warnings = [];
  const wrote = manifest?.wrote || {};
  const created = new Set(manifest?.created || []);
  const pkg = wrote.pkg || packageNameFromSpec(wrote.pluginSpec || "");
  // Defaulted, not required: a manifest written by an older version of this
  // package predates the field, and every one of those was an opencode install.
  const container = wrote.mcpContainer || "mcp";

  if (Array.isArray(next.plugin) && (pkg || wrote.pluginSpec)) {
    const remaining = next.plugin.filter(
      (s) => !isOurPluginSpec(s, { pkg, pluginSpec: wrote.pluginSpec })
    );
    if (remaining.length !== next.plugin.length) removed.push("plugin");
    next.plugin = remaining;
    if (next.plugin.length === 0 && created.has("plugin")) delete next.plugin;
  }

  const servers = next[container];
  if (servers && typeof servers === "object" && servers[MCP_KEY] !== undefined) {
    if (wrote.mcp && !deepEqual(servers[MCP_KEY], wrote.mcp)) {
      kept.push(`${container}.${MCP_KEY}`);
      warnings.push(`${container}.${MCP_KEY} has been edited since setup; left in place`);
    } else {
      const rest = { ...servers };
      delete rest[MCP_KEY];
      next[container] = rest;
      removed.push(`${container}.${MCP_KEY}`);
    }
    if (Object.keys(next[container]).length === 0 && created.has(container)) delete next[container];
  }

  // Only the commands this install actually wrote. Iterating COMMAND_KEYS
  // unconditionally would make a Claude Code uninstall delete a `/kstart` the
  // developer wrote for themselves, in a config we never touched.
  const commandKeys = Object.keys(wrote.commands || {});
  if (commandKeys.length && next.command && typeof next.command === "object") {
    const rest = { ...next.command };
    for (const key of commandKeys) {
      if (rest[key] === undefined) continue;
      if (wrote.commands?.[key] && !deepEqual(rest[key], wrote.commands[key])) {
        kept.push(`command.${key}`);
        warnings.push(`/${key} has been edited since setup; left in place`);
        continue;
      }
      delete rest[key];
      removed.push(`command.${key}`);
    }
    next.command = rest;
    if (Object.keys(next.command).length === 0 && created.has("command")) delete next.command;
  }

  return { config: next, kept, removed, warnings };
}

/**
 * Is our wiring present, and does it still point at this install?
 *
 * What counts as complete is read off the manifest rather than assumed: an
 * install that never wrote a plugin spec (Claude Code) must not be reported as
 * half-wired forever because a key it was never supposed to write is absent.
 */
export function inspectInstall(config, manifest) {
  const wrote = manifest?.wrote || {};
  const pkg = wrote.pkg || packageNameFromSpec(wrote.pluginSpec || "");
  const container = wrote.mcpContainer || "mcp";
  const wantsPlugin = wrote.pluginSpec !== undefined;
  const commandKeys = Object.keys(wrote.commands || {});

  const plugin = Array.isArray(config?.plugin)
    ? config.plugin.find((s) => isOurPluginSpec(s, { pkg, pluginSpec: wrote.pluginSpec }))
    : undefined;
  const mcp = config?.[container]?.[MCP_KEY];
  // Both shapes, so `status` can say which script is about to be spawned
  // without knowing which runtime it is looking at: opencode keeps the whole
  // argv in `command`, Claude Code splits it into `command` + `args`.
  const argv = Array.isArray(mcp?.command)
    ? mcp.command
    : typeof mcp?.command === "string"
      ? [mcp.command, ...(Array.isArray(mcp.args) ? mcp.args : [])]
      : null;

  return {
    plugin: plugin || null,
    pluginPinnedTo: plugin ? String(plugin).slice(String(pkg).length + 1) || null : null,
    mcp: mcp || null,
    mcpContainer: container,
    mcpCommand: argv,
    commands: commandKeys.filter((k) => config?.command?.[k] !== undefined),
    complete: Boolean(
      mcp &&
        (!wantsPlugin || plugin) &&
        commandKeys.every((k) => config?.command?.[k] !== undefined)
    ),
  };
}

/**
 * The indentation the file already uses.
 *
 * Re-serialising with `JSON.stringify(x, null, 2)` restores the *content*
 * exactly but rewrites every line of a file indented with four spaces or tabs,
 * which for anyone keeping their config in git turns `kelabo setup` into a
 * hundred-line diff with three real changes hidden in it. Matching what is
 * there costs ten lines.
 *
 * Compact objects written on one line are still expanded — JSON.stringify has
 * no setting for that — so this narrows the diff rather than eliminating it.
 */
export function detectIndent(text, fallback = 2) {
  const match = /^[ \t]+(?=["}\]])/m.exec(String(text).replace(/^\{[^\n]*\n/, "\n"));
  if (!match) return fallback;
  return match[0].includes("\t") ? "\t" : match[0].length;
}

/**
 * Does this config text carry things `JSON.parse` + `JSON.stringify` would
 * destroy?
 *
 * `.jsonc` is a first-class opencode config format and people put comments in
 * it. Round-tripping such a file through the JSON parser silently deletes every
 * one of them. Rather than do that, `setup` refuses and prints the block to
 * paste — so this scanner has to skip string literals, or the `//` in
 * `"$schema": "https://…"` reads as a comment and every config is refused.
 */
export function hasNonJsonSyntax(text) {
  const src = String(text);
  let inString = false;
  let escaped = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      continue;
    }
    if (c === "/" && (src[i + 1] === "/" || src[i + 1] === "*")) return "comments";
    if (c === "," ) {
      // A trailing comma is a comma whose next non-whitespace character closes
      // the container.
      let j = i + 1;
      while (j < src.length && /\s/.test(src[j])) j++;
      if (src[j] === "}" || src[j] === "]") return "trailing commas";
    }
  }
  return null;
}
