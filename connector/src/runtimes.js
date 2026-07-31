// The runtime registry (docs 17 §2).
//
// One row per coding agent the bridge can attach to. It is the single place that
// knows a runtime's *name*: the config file to edit, the shape of an MCP entry
// inside it, how to tell whether it is installed, and the launch line a
// developer has to get right afterwards.
//
// There is **one npm package and one `kelabo` command**, and this table is what
// the command dispatches on. Adding a runtime is a row plus an adapter; nothing
// in the tools, the envelope, the queue, the persona or the tunnel changes, and
// nothing about how the package is built or published changes either.
//
// Selection happens at *run* time, in two different ways for two different
// callers, and the distinction matters:
//
//   * `kelabo setup|uninstall|status` — the human picks, with `--runtime`,
//     `--all`, an interactive prompt, or by having only one installed.
//   * `kelabo run` — the MCP server. It never guesses: `setup` writes
//     `KELABO_RUNTIME` into the MCP entry it creates, so the runtime that
//     spawned the bridge is the runtime that told it what it is. A wrong answer
//     here means the wrong injection path, and injection failures are silent on
//     both runtimes.

import { MCP_KEY } from "./install.js";
import { hasFlag, flagValue } from "./launch.js";

/** Every runtime, keyed by the id that appears in `KELABO_RUNTIME`. */
export const RUNTIMES = {
  opencode: {
    id: "opencode",
    display: "opencode",
    /** How `detectRuntimes()` decides this is worth offering. The binary on
     *  PATH is the honest signal; an existing config in the place this runtime
     *  keeps one is the fallback, for a launcher that is a shell alias, a shim
     *  outside this PATH, or an npx invocation. */
    detect: { bin: "opencode" },
    wiring: {
      configName: "opencode.json",
      mcpContainer: "mcp",
      mcpShape: "opencode",
      // opencode takes a plugin spec in `plugin[]` and slash commands inline
      // under `command`. Claude Code takes neither, which is why both are
      // optional in install.js rather than assumed.
      plugin: true,
      commands: ["kstart", "kend"],
    },
    launch: {
      /** `kelabo <cli>` starts it. */
      cli: "opencode",
      bin: "opencode",
      /** A port has to be chosen before the arguments exist — unless the
       *  developer named one, in which case we never allocate. */
      needsPort: true,
      /**
       * **Never pass `--port` twice.** Verified against opencode 1.18.6:
       * `--port A --port B` does not take the last one, it binds a *random*
       * port — yargs collects the repeats into an array and opencode cannot use
       * it, so it falls back. Measured twice: 39897, then 39983.
       *
       * That makes "ours first, theirs last, theirs wins" false for this flag,
       * and the consequence is worse than losing the argument: `OPENCODE_BASE_URL`
       * below would name a port nothing is listening on. So when the developer
       * supplies one, this stands aside completely.
       */
      args: ({ port, extra = [] }) => (hasFlag(extra, "port") ? [] : ["--port", String(port)]),
      env: ({ port, extra = [] }) => {
        const env = {
          // Undocumented, off by default, and the *only* thing that lets a
          // subagent run without blocking the session. With it off the parameter
          // is absent from the task tool's schema, so the model's `background:
          // true` is dropped on the way to the call — no error, correct answer,
          // and an agent that goes deaf for the whole lookup (docs 16 §4.1).
          OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS: "true",
        };
        // Belt and braces. The plugin reports the real URL at /kstart from its
        // own `serverUrl`, so this is not required — which is exactly why it is
        // omitted rather than guessed when the developer's own flags mean we
        // cannot know it. A wrong URL here is worse than no URL: `probe()` would
        // fail against a port nothing is on and blame the developer's setup.
        const chosen = hasFlag(extra, "port") ? flagValue(extra, "port") : String(port);
        const host = hasFlag(extra, "hostname") ? flagValue(extra, "hostname") : "127.0.0.1";
        if (chosen && /^\d+$/.test(chosen) && host) {
          env.OPENCODE_BASE_URL = `http://${host}:${chosen}`;
        }
        return env;
      },
      then: "/kstart",
      /** What starting it by hand gets wrong. Still true, and still the first
       *  thing to suspect if somebody bypasses the launcher. */
      why:
        "--port defaults to 0, which means opencode serves nothing over HTTP, and\n" +
        "     background subagents are off unless an undocumented variable is set. With\n" +
        "     either wrong the agent still joins and posts — that is the tunnel — and\n" +
        "     goes deaf. `kelabo opencode` sets both; `kelabo status` checks.",
    },
  },

  "claude-code": {
    id: "claude-code",
    display: "Claude Code",
    detect: { bin: "claude" },
    wiring: {
      configName: ".claude.json",
      // Verified against Claude Code 2.1.220 by running `claude mcp add` under a
      // scratch HOME: user scope writes `mcpServers` in `~/.claude.json`,
      // project scope writes `mcpServers` in `./.mcp.json`. Both use the same
      // key, which is why one container name covers both.
      mcpContainer: "mcpServers",
      mcpShape: "claude-code",
      // No plugin and no slash command: the channel targets the session that
      // spawned the MCP server, so there is no second process and nothing to
      // hand over (docs 16 §4.2).
      plugin: false,
      commands: null,
    },
    launch: {
      cli: "claude",
      bin: "claude",
      needsPort: false,
      // The MCP server name and the channel name are the same string by
      // necessity: Claude Code resolves `server:<name>` against the configured
      // MCP servers and refuses a name that matches none of them (verified in
      // 2.1.220 — "no MCP server configured with that name").
      args: () => ["--dangerously-load-development-channels", `server:${MCP_KEY}`],
      env: () => ({}),
      then: "",
      why:
        "Channels are a research preview and are off unless that flag names this\n" +
        "     server. Without it the agent still joins, posts and reads the board —\n" +
        "     that is the tunnel — and never hears a word, because a channel\n" +
        "     notification nobody registered a listener for is dropped silently.\n" +
        "     `kelabo claude` passes it for you.",
    },
  },
};

export const RUNTIME_IDS = Object.keys(RUNTIMES);

/** The one the bridge assumes when nothing said otherwise. Only reached by a
 *  `run` with no `KELABO_RUNTIME`, which means a hand-written MCP entry. */
export const DEFAULT_RUNTIME = "opencode";

/** Look up a row, or explain what the valid ids are. Used on every path that
 *  takes a `--runtime` from a human. */
export function runtime(id) {
  const found = RUNTIMES[id];
  if (!found) {
    throw new Error(`unknown runtime "${id}". Known: ${RUNTIME_IDS.join(", ")}`);
  }
  return found;
}

/** Accepts a comma-separated list, `all`, or a single id; always returns ids in
 *  registry order so output is stable regardless of how they were typed. */
export function parseRuntimeList(value) {
  const raw = String(value || "").trim();
  if (!raw) return [];
  if (raw === "all") return [...RUNTIME_IDS];
  const asked = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const id of asked) runtime(id);
  return RUNTIME_IDS.filter((id) => asked.includes(id));
}
