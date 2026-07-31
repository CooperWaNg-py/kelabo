import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DEFAULT_RUNTIME } from "./runtimes.js";

// Kelabo supplies the bridge with exactly two things: a token and a gateway URL
// (docs 16). Everything about the agent — model, MCP servers, permissions,
// working directory — is the developer's own and is never read, written or
// inspected here.
export const CREDENTIAL_PATH = process.env.KELABO_AGENT_FILE || join(homedir(), ".kelabo", "agent.json");

export function loadConfig(env = process.env) {
  const stored = readCredential();
  return {
    // Env wins so a second environment can be driven without re-pairing.
    gatewayUrl: env.KELABO_GATEWAY_URL || wsFrom(stored.gatewayBaseUrl) || "",
    apiBaseUrl: env.KELABO_API_BASE_URL || stored.apiBaseUrl || "",
    token: env.KELABO_AGENT_TOKEN || stored.agentToken || "",
    identity: stored.identity || "",
    // Which coding agent is on the other side, and therefore which adapter runs.
    // `kelabo setup` writes it into the MCP entry it creates, so this is the
    // runtime's own answer rather than a guess; the fallback only covers a
    // hand-written entry that predates it.
    runtime: env.KELABO_RUNTIME || DEFAULT_RUNTIME,
    label: env.KELABO_AGENT_LABEL || stored.label || "",
    // Loopback listener the opencode plugin posts the session id to. Fixed
    // rather than random because the plugin is a separate process that has to
    // find us; the lockfile carries the actual value in case it is taken.
    controlPort: Number(env.KELABO_CONTROL_PORT || 4190),
    opencodeBaseUrl: env.OPENCODE_BASE_URL || "",
    heartbeatMs: Number(env.KELABO_HEARTBEAT_MS || 30000),
    reconnectMaxMs: Number(env.KELABO_RECONNECT_MAX_MS || 60000),
    maxBacklog: Number(env.KELABO_MAX_BACKLOG || 60),
  };
}

function wsFrom(httpsUrl) {
  if (!httpsUrl) return "";
  return httpsUrl.replace(/^http/, "ws");
}

export function readCredential(path = CREDENTIAL_PATH) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}

export function writeCredential(value, path = CREDENTIAL_PATH) {
  mkdirSync(dirname(path), { recursive: true });
  // 0600: this is a long-lived credential that can read a kelabo's transcript
  // and post to its board.
  writeFileSync(path, JSON.stringify(value, null, 2), { mode: 0o600 });
  return path;
}
