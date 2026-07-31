// Loopback listener on 127.0.0.1 (docs 16 §8).
//
// Exists for exactly one thing: an opencode plugin is a different process from
// this one, and it is the only place that knows the current TUI session's id and
// its server's base URL. The bridge cannot discover either on its own, so the
// plugin has to tell it. (And `--port` defaults to 0 — no HTTP server at all —
// so the URL the plugin reports may still be unreachable; the handover probes
// it rather than trusting it.)
//
// No auth: loopback only, and the payload is a session id belonging to a process
// already running as this user.
import http from "node:http";
import { writeFileSync, readFileSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const LOCK_DIR = join(homedir(), ".kelabo");
const LEGACY_LOCK_PATH = join(LOCK_DIR, "bridge.json");
const MAX_BODY = 64 * 1024;

/**
 * Where *this* opencode instance's bridge publishes its port.
 *
 * Keyed by the parent process id, because one shared `bridge.json` cannot
 * address N bridges. Every opencode instance spawns its own bridge over stdio,
 * so a laptop with three sessions open has three, all wanting port 4190; only
 * one gets it, and a single global lock is then last-writer-wins. The observed
 * failure is worse than losing the file: `/kstart` reaches *another session's*
 * bridge, which binds happily, while the bridge actually serving this session's
 * MCP tools still has no session — so the tools work, the handover reports
 * success, and `kelabo_join` insists you have not run `/kstart`.
 *
 * The MCP server is spawned directly by the opencode process that loads the
 * plugin, so the plugin's own `process.pid` is this bridge's `process.ppid`.
 * That makes the rendezvous exact rather than heuristic.
 */
export function lockPathForParent(pid) {
  return join(LOCK_DIR, `bridge-${pid}.json`);
}

export function createControl({ port, runtime, onSession, log = () => {}, lockPath }) {
  const ownLock = lockPath || process.env.KELABO_BRIDGE_LOCK || lockPathForParent(process.ppid);
  let wroteLock = false;
  const server = http.createServer(async (req, res) => {
    const json = (status, body) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.method !== "POST") return json(405, { error: "method_not_allowed" });
    let body;
    try {
      body = await readJson(req);
    } catch (err) {
      return json(400, { error: err.message });
    }
    if (req.url === "/session") {
      try {
        const result = await onSession(body || {});
        return json(200, result);
      } catch (err) {
        log("control_session_failed", { error: err.message });
        return json(500, { error: err.message });
      }
    }
    if (req.url === "/status") return json(200, { ok: true, runtime });
    return json(404, { error: "not_found" });
  });

  function listenOn(candidate) {
    return new Promise((resolve, reject) => {
      const onError = (err) => {
        server.removeListener("listening", onListening);
        reject(err);
      };
      const onListening = () => {
        server.removeListener("error", onError);
        resolve(server.address().port);
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(candidate, "127.0.0.1");
    });
  }

  async function start() {
    let actual = null;
    try {
      actual = await listenOn(port);
    } catch (err) {
      if (err.code !== "EADDRINUSE") {
        log("control_listen_failed", { error: err.message, port });
        return null;
      }
      // Another bridge already has the default port. Take any free one instead
      // of giving up: a bridge that cannot receive `/kstart` can never receive
      // transcript either, and it fails *silently* — the MCP tools keep working,
      // so from the kelabo it looks like a bridge that simply ignores everyone.
      log("control_port_busy", { port });
      try {
        actual = await listenOn(0);
      } catch (err2) {
        log("control_listen_failed", { error: err2.message, port: 0 });
        return null;
      }
    }
    writeLock({
      port: actual,
      pid: process.pid,
      ppid: process.ppid,
      runtime,
      cwd: process.cwd(),
      startedAt: Date.now(),
    });
    log("control_listening", { port: actual, lock: ownLock });
    return actual;
  }

  function stop() {
    try {
      server.close();
    } catch {}
    if (!wroteLock) return;
    try {
      rmSync(ownLock, { force: true });
    } catch {}
    // The shared file is a courtesy fallback, so only clear it if it is still
    // ours. Deleting it unconditionally is how one bridge shutting down used to
    // blind every other bridge on the machine.
    try {
      const current = JSON.parse(readFileSync(LEGACY_LOCK_PATH, "utf8"));
      if (current.pid === process.pid) rmSync(LEGACY_LOCK_PATH, { force: true });
    } catch {}
  }

  /** How the opencode plugin finds us. The per-parent file is authoritative;
   *  the shared one is written too, as a fallback for the case where the plugin
   *  cannot match on pid (a runtime that spawns MCP servers through a wrapper,
   *  so our `ppid` is not its `pid`). */
  function writeLock(value) {
    const body = JSON.stringify(value, null, 2);
    try {
      mkdirSync(dirname(ownLock), { recursive: true });
      writeFileSync(ownLock, body, { mode: 0o600 });
      wroteLock = true;
    } catch {}
    if (ownLock === LEGACY_LOCK_PATH) return;
    try {
      writeFileSync(LEGACY_LOCK_PATH, body, { mode: 0o600 });
    } catch {}
  }

  return { start, stop, lockPath: ownLock };
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (d) => {
      size += d.length;
      if (size > MAX_BODY) {
        reject(new Error("body_too_large"));
        req.destroy();
        return;
      }
      chunks.push(d);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve(null);
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("invalid_json"));
      }
    });
    req.on("error", reject);
  });
}

export { LEGACY_LOCK_PATH };
