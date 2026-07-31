// kelabo-mcp — the agent bridge (docs 16 §7).
//
// This module is `run`, and nothing else. The CLI that wraps it — setup, login,
// status, uninstall — is `cli.js`, which is the package's `bin`. Keeping the
// bridge importable without a command-line parser attached is what lets
// `test/smoke.mjs` drive it directly.
//
// One process, spawned by the developer's coding agent over stdio. It holds the
// MCP server (the tool surface every runtime sees), the WSS tunnel to the
// Gateway, the transcript queue, and the kelabo binding.
//
// Its lifetime is the agent session's lifetime, which matches how the feature is
// used: one agent, in one folder, for one kelabo.
//
// Nothing here reads or writes the developer's model configuration, MCP servers
// or permissions. Kelabo supplies a token and a channel; everything else is
// theirs.
import { loadConfig, readCredential } from "./config.js";
import { createTunnel } from "./tunnel.js";
import { createBinding } from "./binding.js";
import { createTools } from "./tools.js";
import { createApi } from "./api.js";
import { createMcpServer } from "./mcpServer.js";
import { createControl } from "./control.js";
// Which runtime spawned us. `setup` wrote `KELABO_RUNTIME` into the MCP entry it
// created, so this is the runtime's own answer rather than a guess.
import { adapterFor } from "./adapters/index.js";

/** stdout belongs to the MCP transport. Anything written there corrupts the
 *  protocol, so every log line goes to stderr, where the runtime shows it in its
 *  debug output. */
function makeLog(enabled) {
  return (event, extra = {}) => {
    if (!enabled) return;
    process.stderr.write(`${JSON.stringify({ ts: new Date().toISOString(), event, ...extra })}\n`);
  };
}

export async function startBridge({ config = loadConfig(), log = makeLog(true) } = {}) {
  // The opencode plugin hands these over at /kstart; for Claude Code they are
  // never used, because the channel targets the session that spawned us.
  let opencodeBaseUrl = config.opencodeBaseUrl;
  let opencodeSessionId = "";

  let mcp = null;
  // Throws on an unknown id rather than falling back. A default here would start
  // a bridge with the wrong injection path, which on both runtimes means every
  // tool works and no transcript ever arrives — the one failure shape this
  // whole design keeps trying to make loud.
  const runtimeAdapter = adapterFor(config.runtime);
  const isClaude = config.runtime === "claude-code";

  // One options bag for every adapter; each takes what it needs and ignores the
  // rest, which is what lets the call site stay runtime-agnostic.
  const adapter = runtimeAdapter.create({
    // Claude Code: the channel *is* this MCP server, so the adapter needs a way
    // back to it. Read lazily because the server is constructed below, from the
    // capabilities this same adapter decides.
    getServer: () => mcp?.server,
    // opencode: both supplied by the plugin at the /kstart handover.
    getBaseUrl: () => opencodeBaseUrl,
    getSessionId: () => opencodeSessionId,
    onReady: () => binding.notifyReady(),
    log,
  });

  const tunnel = createTunnel({
    gatewayUrl: config.gatewayUrl,
    getToken: async () => config.token || readCredential().agentToken || "",
    agent: { runtime: adapter.runtime, label: config.label },
    heartbeatMs: config.heartbeatMs,
    reconnectMaxMs: config.reconnectMaxMs,
    log,
  });

  // Assigned below; the binding only reaches for it once transcript is flowing,
  // by which time it exists.
  let tools = null;

  const binding = createBinding({
    tunnel,
    adapter,
    maxBacklog: config.maxBacklog,
    log,
    onBatch: () => tools?.sweep(),
  });

  const api = createApi({
    apiBaseUrl: config.apiBaseUrl,
    getToken: async () => config.token || readCredential().agentToken || "",
  });

  tools = createTools({ tunnel, binding, adapter, api, log });

  mcp = createMcpServer({
    name: "kelabo",
    capabilities: runtimeAdapter.capabilities,
    instructions: runtimeAdapter.instructions,
    handlers: tools,
  });

  const control = createControl({
    port: config.controlPort,
    runtime: adapter.runtime,
    log,
    onSession: async ({ sessionId, baseUrl }) => {
      // /kstart in opencode: the plugin is a different process and is the only
      // thing that knows the current session id and the URL of this instance's
      // own server.
      if (baseUrl) opencodeBaseUrl = baseUrl;
      if (sessionId) opencodeSessionId = sessionId;
      log("session_handover", { sessionId, baseUrl });
      await adapter.start?.();
      // Claude Code needs neither half — its channel targets the session that
      // spawned us — so the handover is a no-op there.
      if (isClaude) return { ok: true, runtime: adapter.runtime, bound: true };

      // Everything below is the difference between "/kstart said it worked" and
      // "transcript actually arrives". Injection is the only leg that needs a
      // reachable server, and its failures are swallowed so one bad turn cannot
      // kill the bridge — which meant a half-finished handover looked identical
      // to a working one until someone spoke and nothing happened.
      const fail = (reason) => ({ ok: true, runtime: adapter.runtime, bound: false, reason });
      if (!opencodeSessionId) return fail("no_session_id");
      if (!opencodeBaseUrl) return fail("no_server_url");
      try {
        await adapter.probe?.();
      } catch (err) {
        log("handover_probe_failed", { error: err.message });
        return fail("server_unreachable");
      }
      // Bound either way: a foreground-only opencode still hears the kelabo,
      // it just goes deaf while it works. That is a warning, not a failure.
      const background = await adapter.backgroundSubagents?.();
      log("session_bound", { background });
      return { ok: true, runtime: adapter.runtime, bound: true, background };
    },
  });

  tunnel.on("registered", (f) => log("registered", { agentId: f.agentId }));
  tunnel.on("rejected", (f) => log("rejected", { reason: f.reason }));
  tunnel.on("error", (err) => log("tunnel_error", { error: err.message }));

  // MCP first: if the tunnel is down the tools must still answer, with a real
  // explanation, rather than the runtime reporting a server that failed to start.
  await mcp.start();
  await control.start();
  await adapter.start?.();
  tunnel.connect();

  // Say it once at startup as well as at join. `claude --debug` shows an MCP
  // server's stderr, so this is the one place a developer who suspects the
  // bridge can confirm the channel state without joining a kelabo first.
  if (isClaude) {
    log("channel_state", {
      armed: adapter.channelArmed?.() ?? null,
      thirdPartyProvider: adapter.thirdPartyProvider?.() || null,
    });
  }

  const shutdown = async () => {
    tunnel.detach();
    tunnel.stop();
    control.stop();
    await adapter.detach?.();
    await mcp.stop();
  };
  process.on("SIGTERM", () => shutdown().finally(() => process.exit(0)));
  process.on("SIGINT", () => shutdown().finally(() => process.exit(0)));

  return { tunnel, binding, tools, mcp, shutdown };
}
