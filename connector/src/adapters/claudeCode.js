// Contract C for Claude Code (docs 16 §4.2).
//
// Claude Code has no API for injecting a turn into a running session. What it
// has is *channels*: an MCP server that declares the `claude/channel` capability
// gets a notification listener registered, and anything it emits as
// `notifications/claude/channel` lands in the live session's context as
//
//   <channel source="kelabo" kelabo_id="...">…</channel>
//
// So the bridge's MCP server *is* the injection path. There is no second
// connection and no separate process.
//
// Three consequences of that design worth knowing before changing anything here:
//
//  * `meta` keys must be identifiers — letters, digits, underscore. A key with a
//    hyphen is dropped silently, which is why these are `kelabo_id`, not
//    `kelabo-id`.
//  * Notifications are unacknowledged. If the session was not started with the
//    channel enabled, they vanish with no error, so nothing may depend on
//    delivery.
//  * The runtime already batches: notifications that arrive while Claude is busy
//    are delivered together on the next turn. `ready()` is therefore always true
//    and the bridge's queue does no pacing on this path.
//
// Deliberately NOT declared: `claude/channel/permission`. That capability relays
// tool-approval prompts out through the channel so they can be answered
// remotely. The far end of this channel is a kelabo room that may contain
// link-joined guests, and anyone who can reply through a channel can approve
// tool use in the developer's session. Kelabo declines the capability rather
// than try to gate it (docs 16 §6).
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { PERSONA, PERSONA_CORE } from "../persona.js";

export const CLAUDE_CHANNEL_CAPABILITIES = {
  experimental: { "claude/channel": {} },
};

/** What `mcpServer.js` advertises for this runtime. Declaring the capability is
 *  not decoration — it is the entire registration handshake: Claude Code reads
 *  it out of the initialize response and only then registers a notification
 *  listener for us (verified in 2.1.220, whose gate skips with "server did not
 *  declare claude/channel capability"). */
export const CAPABILITIES = CLAUDE_CHANNEL_CAPABILITIES;

/** Claude Code truncates `instructions` to 2048 characters at connect time —
 *  verified against 2.1.220, which logs it once at DEBUG and carries on. The
 *  full persona is 5820, so sending it here silently discarded the prompt-
 *  injection gate along with most of the operating brief. Only the core goes in
 *  the system prompt; the rest is delivered by `kelabo_join` (persona.js). */
export const INSTRUCTIONS = PERSONA_CORE;

/** Providers on which Claude Code refuses to register a channel at all.
 *
 *  Read straight out of the 2.1.220 binary's own provider check, which returns
 *  "firstParty" only when none of these is set (plus a gateway mode) and the
 *  channel gate then skips with "channels are not available on third-party
 *  providers". Naming all six matters because the error is not one of them —
 *  there is no error; transcript simply never arrives. */
export const THIRD_PARTY_PROVIDER_VARS = [
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_USE_ANTHROPIC_AWS",
  "CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD",
  "CLAUDE_CODE_USE_MANTLE",
];

export function thirdPartyProvider(env = process.env) {
  return THIRD_PARTY_PROVIDER_VARS.find((v) => env[v]) || null;
}

/**
 * The argv of the process that spawned this one.
 *
 * Claude Code spawns a stdio MCP server directly, so our parent *is* the
 * `claude` the developer launched, and its command line is the only evidence
 * available anywhere for whether channels were switched on for this session.
 * `/proc` on Linux, `ps` everywhere else; null when neither answers, because an
 * unknown is not a fault.
 */
export function parentCommandLine(pid = process.ppid) {
  if (!pid) return null;
  try {
    // NUL-separated, with a trailing NUL — split rather than replace, so an
    // argument containing a space stays one argument.
    return readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean);
  } catch {}
  try {
    const out = execFileSync("ps", ["-o", "args=", "-p", String(pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    // `ps` has already lost the argv boundaries; splitting on whitespace is
    // enough for the flag-and-value shape we are looking for.
    return out.trim() ? out.trim().split(/\s+/) : null;
  } catch {}
  return null;
}

/**
 * Was this session started with the channel switched on for *us*?
 *
 * This is the Claude Code counterpart of opencode's missing `--port`, and it
 * fails the same invisible way: every tool still works, because tools travel
 * the tunnel, so the agent joins, posts and reads the board perfectly and simply
 * never hears a word. A channel notification whose listener was never registered
 * is dropped with no error at either end (docs 16 §4.2).
 *
 * Unlike `--port` it cannot be probed over a socket, so the evidence is the
 * parent's command line. Both flags count: `--channels` is the allowlisted path
 * and `--dangerously-load-development-channels` the research-preview one, and
 * the entry has to name this server — Claude Code resolves `server:<name>`
 * against the configured MCP servers and skips any that does not match.
 *
 * Returns null when the command line cannot be read. That is not a fault and
 * must not be reported as one: warning on an unknown teaches people to ignore
 * the warning, which is precisely what would then hide the real case.
 */
export function channelArmed(argv, serverName = "kelabo") {
  if (!argv || !argv.length) return null;
  const FLAGS = ["--channels", "--dangerously-load-development-channels"];
  const wanted = [`server:${serverName}`, `plugin:${serverName}`];
  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = splitFlag(argv[i]);
    if (!FLAGS.includes(flag)) continue;
    // Variadic: `--channels a b c -- …`, so consume until the next flag.
    const values = inline ? [inline] : [];
    for (let j = i + 1; j < argv.length && !argv[j].startsWith("-"); j++) values.push(argv[j]);
    if (values.some((v) => wanted.some((w) => v === w || v.startsWith(`${w}@`)))) return true;
  }
  return false;
}

function splitFlag(token) {
  const eq = token.indexOf("=");
  return eq > 0 ? [token.slice(0, eq), token.slice(eq + 1)] : [token, null];
}

/** Drop what Claude Code would drop, here, where it is testable.
 *
 *  A key that is not an identifier is discarded on arrival with no error, and an
 *  empty value renders as a bare `attr=""` that says nothing. Filtering at the
 *  source means the notification we send is the notification that arrives, so a
 *  future key that breaks the rule fails a unit test rather than going missing
 *  in a live kelabo. */
export function metaFor(map) {
  const out = {};
  for (const [key, value] of Object.entries(map)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    if (value === undefined || value === null || value === "") continue;
    out[key] = String(value);
  }
  return out;
}

export function createClaudeCodeAdapter({ getServer, log = () => {}, env = process.env, argv }) {
  // Read once, at construction: the parent's command line is fixed for the life
  // of this process, and re-reading /proc per transcript batch would be a
  // syscall per caption for a value that cannot change.
  const parentArgv = argv === undefined ? parentCommandLine() : argv;
  const armed = channelArmed(parentArgv);
  const provider = thirdPartyProvider(env);

  async function notify(content, meta = {}) {
    const server = getServer();
    if (!server) throw new Error("channel not connected");
    await server.notification({
      method: "notifications/claude/channel",
      params: { content, meta },
    });
  }

  return {
    runtime: "claude-code",

    channelArmed: () => armed,
    thirdPartyProvider: () => provider,

    /** The part of the persona the system prompt could not hold, delivered
     *  where nothing truncates it and at the first moment it can matter — a
     *  join is the only thing that starts transcript flowing. */
    brief: () => PERSONA,

    /**
     * What is wrong that nothing else will reveal, in one line, or null.
     *
     * Surfaced through `kelabo_join`'s result rather than a log, because the
     * only person who can fix it is the developer at this terminal and the only
     * thing they reliably read is what the agent tells them. Silence here is a
     * claim that transcript will arrive.
     */
    caveat() {
      if (provider) {
        return `Kelabo is attached, but ${provider} is set and Claude Code does not offer channels on third-party providers — no kelabo transcript will reach this session. Board tools still work.`;
      }
      if (armed === false) {
        return "Kelabo is attached, but this session was not started with the Kelabo channel enabled, so no kelabo transcript will reach it. Restart as `claude --dangerously-load-development-channels server:kelabo`. Board tools work without it; hearing the kelabo does not.";
      }
      return null;
    },

    // The channel targets whichever session spawned this process, so there is
    // no id to resolve and nothing to look up. The empty sessionRef is why the
    // protocol accepts one (contracts/src/frames.js).
    attach: async () => ({ sessionRef: "", workspace: process.cwd() }),

    async inject(text, { silent = false, kelaboId = "", speakers = [] } = {}) {
      // `silent` cannot be honoured: every channel event reaches the model, and
      // there is no equivalent of opencode's noReply. The persona carries the
      // load instead — silence is the default, and a briefing is not a question.
      await notify(text,
        metaFor({
          // Every key here is an identifier — letters, digits, underscore —
          // because each becomes an attribute on the <channel> tag and Claude
          // Code drops the ones that are not, silently. `kelabo_id`, never
          // `kelabo-id`; `silent`, never `is-silent`.
          silent: silent ? "true" : "false",
          kelabo_id: kelaboId,
          speakers: speakers.join(", "),
        })
      );
      log("channel_notified", { silent, chars: text.length });
    },

    // The runtime batches notifications that arrive mid-turn and delivers them
    // together on the next one, so the bridge's queue does no pacing here.
    ready: () => true,

    start: async () => {},
    detach: async () => {},
  };
}
