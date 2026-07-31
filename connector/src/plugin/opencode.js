// opencode plugin: hand the Kelabo bridge this session's id and server URL.
//
// Reaches opencode two ways, and this file is the only copy of it (docs 17 §2):
//   - as an npm plugin, `"plugin": ["@kelabome/agents@x.y.z"]`, where the
//     package's `exports["./server"]` points at the built bundle of this file.
//     `kelabo setup` writes that key.
//   - as a file in `~/.config/opencode/plugins/` (or `.opencode/plugins/`),
//     which is how the Rig installs it.
// The default-export shape below is required by the first and accepted by the
// second, which is what lets one file serve both.
//
// It carries no model, MCP or permission configuration — those stay entirely
// yours (docs 16).
//
// Why a plugin at all: the bridge runs as an MCP server in a separate process
// and cannot discover either value on its own. A plugin hook is the only place
// the current session id is available, and `serverUrl` is the only place the
// instance's own server URL is. So `/kstart` is a handover, not a command that
// does the joining — the joining is `kelabo_join`, which the agent calls.
//
// Note `--port` defaults to 0, which means opencode serves **nothing** over
// HTTP. Transcript injection needs a real server, so the developer must run
// `opencode --port <n>`; the bridge checks and says so at /kstart.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Where to look for *our* bridge's port, most specific first.
 *
 * `bridge-<pid>.json` is keyed by the pid of the process reading it — this one.
 * opencode spawns the MCP server directly, so this process is that bridge's
 * parent, and the file it wrote is named after us. That matters because a
 * laptop with three opencode sessions has three bridges, all of which wanted
 * port 4190 and only one of which got it. Reading a shared `bridge.json`, or
 * falling back to the default port, hands this session over to *somebody else's*
 * bridge: it accepts happily, while the bridge actually serving this session's
 * tools never gets a session and reports that `/kstart` was never run.
 *
 * The shared file and the fixed port remain as fallbacks for a runtime that
 * spawns MCP servers through a wrapper, where our pid is not the bridge's ppid.
 */
function lockCandidates() {
  if (process.env.KELABO_BRIDGE_LOCK) return [process.env.KELABO_BRIDGE_LOCK];
  const dir = join(homedir(), ".kelabo");
  return [join(dir, `bridge-${process.pid}.json`), join(dir, "bridge.json")];
}

function bridgeUrl() {
  for (const path of lockCandidates()) {
    try {
      const { port } = JSON.parse(readFileSync(path, "utf8"));
      if (port) return `http://127.0.0.1:${port}`;
    } catch {}
  }
  return `http://127.0.0.1:${process.env.KELABO_CONTROL_PORT || 4190}`;
}

/** The URL of *this* opencode instance's own server — the one the bridge posts
 *  transcript to. `serverUrl` on the plugin input is the only reliable source:
 *  the SDK client is constructed with the base URL but does not expose it
 *  (`client.baseUrl` and `client.options` are both undefined), and
 *  `OPENCODE_BASE_URL` is not in a plugin's environment. Reading either of those
 *  yielded "", which the bridge then quietly ignored — `/kstart` reported
 *  success and no transcript ever arrived. */
function serverBaseUrl({ serverUrl }) {
  // A URL object, and `toString()` adds a trailing slash the adapter would
  // concatenate into `//session/...`.
  const raw = serverUrl ? String(serverUrl) : process.env.OPENCODE_BASE_URL || "";
  return raw.replace(/\/+$/, "");
}

/** A refused handover has to say which half is missing. Both are silent at the
 *  point they are used — a missing server URL only shows up as transcript that
 *  never arrives, long after `/kstart` said it was fine. */
function explainUnbound(reason) {
  if (reason === "server_unreachable" || reason === "no_server_url") {
    // The common one, and the one with a non-obvious remedy: `--port` defaults
    // to 0, which means opencode serves nothing over HTTP, so the bridge has
    // nowhere to post transcript. Tools still work — they go over the tunnel —
    // which is why this looks like a Kelabo problem and is not one.
    return "Kelabo bridge reached, but this opencode instance is not serving HTTP, so transcript cannot be delivered to it. Restart it as `opencode --port 4096` and run /kstart again. Board tools work without this; receiving transcript does not.";
  }
  if (reason === "no_session_id") {
    return "Kelabo bridge reached, but no session id came with the handover. Run /kstart from inside a session.";
  }
  return "Kelabo bridge reached, but it did not accept the session. Check its stderr.";
}

async function handover(sessionID, baseUrl) {
  const res = await fetch(`${bridgeUrl()}/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId: sessionID, baseUrl }),
    // opencode does not execute a command until its hooks return, so a bridge
    // that never answers turns /kstart into silence with no error anywhere. A
    // timeout converts that into the catch-branch toast below.
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`bridge responded ${res.status}`);
  return res.json();
}

/** opencode ≥1.18 requires an npm plugin to default-export an object carrying
 *  exactly one of `server()` or `tui()`; a bare named export is only accepted
 *  by the directory scanner. `server` is the right half: the hook we need
 *  (`command.execute.before`) fires in the server, and `ctx.serverUrl` — the
 *  value this whole file exists to obtain — is only on the server context. */
const server = async (plugin) => {
  // Read once: this instance's server URL is fixed for the life of the process.
  const baseUrl = serverBaseUrl(plugin);

  /** The only way the human sees the result.
   *
   *  Do **not** be tempted to push a text part onto `output` instead. That hook
   *  argument is typed `Part[]`, whose members require `id`, `sessionID` and
   *  `messageID`; a `{type,text}` literal is rejected and opencode abandons the
   *  whole command silently — no message, no turn, no error. That is precisely
   *  what made `/kstart` look like it did nothing while the handover underneath
   *  it was succeeding every time.
   *
   *  A direct request beats the SDK client here: the endpoint is stable, and
   *  going through `plugin.client` couples this file to whichever SDK version
   *  the running opencode bundles. The client is kept only as the fallback for
   *  the case that matters most — no `--port`, so no URL to fetch. */
  /** `level` is one of opencode's toast variants: info, success, warning, error.
   *  A caveat gets `warning` rather than `success` on purpose — a green toast
   *  that says something is wrong is read as a green toast. */
  async function toast(message, level = "success") {
    const body = {
      title: "Kelabo",
      message,
      variant: level,
      duration: level === "success" ? 4000 : 15000,
    };
    if (baseUrl) {
      try {
        const res = await fetch(`${baseUrl}/tui/show-toast`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        if (res.ok) return;
      } catch {}
    }
    try {
      await plugin.client?.tui?.showToast({ body });
    } catch {
      // No TUI at all (`opencode run`). The command template still tells the
      // model to call kelabo_join, whose own error text carries the reason.
    }
  }

  return {
    "command.execute.before": async (input) => {
      if (input.command !== "kstart" && input.command !== "kend") return;
      let text;
      let level = "success";
      try {
        if (input.command === "kstart") {
          const result = await handover(input.sessionID, baseUrl);
          if (!result.bound) {
            level = "error";
            text = explainUnbound(result.reason);
          } else if (result.background === false) {
            // Bound, and it will work — but every lookup will deafen it for the
            // duration, and nothing downstream can tell that from discretion.
            level = "warning";
            text =
              "Kelabo bridge connected — but this opencode cannot run subagents in the background, so the assistant stops hearing the kelabo while it works. Restart it with OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true.";
          } else {
            text = "Kelabo bridge connected to this session.";
          }
        } else {
          await handover("", baseUrl);
          text = "Kelabo bridge released this session.";
        }
      } catch (err) {
        level = "error";
        text = `Could not reach the Kelabo bridge (${err.message}). Is it configured as an MCP server in this opencode instance, and did you run \`kelabo-opencode login\`?`;
      }
      await toast(text, level);
    },
  };
};

export default { id: "kelabo", server };
