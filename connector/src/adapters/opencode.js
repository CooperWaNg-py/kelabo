// Contract C for opencode (docs 16 §4.1).
//
// opencode can expose an HTTP server behind its TUI, so transcript is injected
// by posting a message into the session the developer already has open:
//
//   POST /session/:id/prompt_async   -> 204, fire-and-forget
//
// **The TUI does not listen on a port unless it is told to.** `--port` defaults
// to 0, which means "no server", not "a random one" — a plain `opencode` binds
// nothing, and the `serverUrl` a plugin reads then falls back to a
// `http://localhost:4096` that nothing answers. So the developer must run
// `opencode --port <n>`, and `probe()` below exists to say so at /kstart rather
// than let every injection fail into a log nobody reads.
//
// Two details of that API do real work here.
//
// `noReply: true` injects context without provoking a turn. The briefing and the
// lifecycle notices use it, so loading context costs nothing and a scheduled
// kelabo does not make the agent start talking to itself.
//
// `session.idle` on the event bus is the readiness signal. opencode has no
// notification queue of its own, so without it the bridge would fire a prompt per
// caption into a session that is blocked on a permission prompt, and the agent
// would work through a backlog of turns long after the moment passed.
import { PERSONA } from "../persona.js";

/** What `mcpServer.js` should advertise for this runtime. opencode gets nothing
 *  beyond `tools`: advertising a capability it cannot honour would make the
 *  bridge lie about itself in the initialize response. */
export const CAPABILITIES = {};

/** opencode puts the whole thing in front of the model — verified against a
 *  live instance — so there is nothing to hold back for the join. */
export const INSTRUCTIONS = PERSONA;

export function createOpencodeAdapter({ getBaseUrl, getSessionId, onReady, log = () => {}, fetchImpl = fetch }) {
  let idle = true;
  let abort = null;

  async function call(path, { method = "GET", body } = {}) {
    const base = getBaseUrl();
    if (!base) throw new Error("opencode server URL unknown — run /kstart in opencode");
    const res = await fetchImpl(`${base}${path}`, {
      method,
      headers: { "content-type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) throw new Error(`opencode_${path}_failed:${res.status}`);
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }

  /** Is the server actually there? A base URL is not evidence of one: opencode's
   *  own fallback hands out `http://localhost:4096` whether or not anything is
   *  listening. Throws with the remedy rather than returning a boolean, because
   *  every caller wants to surface the reason.
   *
   *  `/global/health` and not `/app`: the latter is no longer part of opencode's
   *  API (it is absent from `/doc` as of 1.18.6), and the same server also hosts
   *  the web client on a catch-all — so `/app` answers **200 with HTML**, which
   *  `call()` then fails to parse. That turned a healthy server into "Cannot
   *  reach the opencode server ... Unexpected token '<'", advice to add the
   *  `--port` that was already there, and a refused join. */
  async function probe() {
    const base = getBaseUrl();
    if (!base) {
      throw new Error("opencode server URL unknown — run /kstart in opencode");
    }
    try {
      await call("/global/health");
    } catch (err) {
      throw new Error(
        `Cannot reach the opencode server at ${base} (${err.message}). A plain \`opencode\` does not listen on a port — if you did not start it as \`opencode --port 4096\`, do that and run /kstart again.`
      );
    }
  }

  /**
   * Can this opencode run a subagent in the background?
   *
   * `background: true` on the task tool is gated behind the (undocumented)
   * `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS` environment variable. With the
   * flag off the parameter is simply not in the tool's schema, and an argument
   * that is not in the schema is dropped on the way to the model's tool call —
   * no error, anywhere. The subagent then runs in the FOREGROUND and blocks the
   * session for its entire duration, during which not one word of transcript
   * reaches the agent.
   *
   * That is invisible from both ends: the developer sees a normal subagent, and
   * the kelabo sees an assistant that is quiet, which is its normal state. So
   * it is reported at the handover, where somebody can act on it.
   *
   * Returns null when it cannot be determined — an unknown is not a fault, and
   * warning about one would train people to ignore the warning.
   */
  async function backgroundSubagents() {
    try {
      const providers = await call("/provider");
      const id = providers?.connected?.[0] ?? Object.keys(providers?.default ?? {})[0];
      const model = providers?.default?.[id];
      if (!id || !model) return null;
      const tools = await call(
        `/experimental/tool?provider=${encodeURIComponent(id)}&model=${encodeURIComponent(model)}`
      );
      const list = Array.isArray(tools) ? tools : Object.values(tools ?? {});
      const task = list.find((t) => (t?.id ?? t?.name) === "task");
      if (!task) return null;
      return Boolean(task.parameters?.properties?.background);
    } catch {
      return null;
    }
  }

  async function attach() {
    const sessionId = getSessionId();
    if (!sessionId) {
      throw new Error(
        "No opencode session is bound. Run /kstart in your opencode session first — the plugin hands this bridge the session id."
      );
    }
    // Before the binding, not after: an agent that attaches to a kelabo it
    // cannot be fed looks identical to one that is simply being quiet, and the
    // board still works, so nothing else would ever reveal it.
    await probe();
    // A missing session row is not fatal — `workspace` is decoration. An
    // unreachable server is, and `probe()` has already ruled it out.
    const session = await call(`/session/${sessionId}`).catch(() => null);
    return {
      sessionRef: sessionId,
      workspace: session?.directory || "",
    };
  }

  async function inject(text, { silent = false } = {}) {
    const sessionId = getSessionId();
    if (!sessionId) throw new Error("no bound opencode session");
    if (!silent) idle = false;
    await call(`/session/${sessionId}/prompt_async`, {
      method: "POST",
      body: {
        // Injecting context must not provoke a turn; asking a question must.
        noReply: silent,
        parts: [{ type: "text", text }],
      },
    });
  }

  /** Watch the event bus for readiness. Errors are logged and retried rather
   *  than thrown: losing this stream degrades pacing, it does not break the
   *  bridge, and it must not take the MCP server down with it.
   *
   *  Resolves once the stream is *connected*; the read loop runs detached. The
   *  /kstart handover awaits this, and its HTTP response is what the plugin's
   *  `command.execute.before` hook is blocked on — an opencode command does not
   *  execute until its hooks return. Awaiting the stream to completion here
   *  therefore held the handover open forever and made /kstart die silently on
   *  exactly the instances that were reachable. */
  async function watch() {
    const base = getBaseUrl();
    if (!base) return;
    // A repeated /kstart lands here with the previous stream still open; drop
    // it rather than accumulate readers that all flip `idle`.
    abort?.abort();
    const ctrl = new AbortController();
    abort = ctrl;
    let res;
    try {
      res = await fetchImpl(`${base}/event`, { signal: ctrl.signal });
      if (!res.ok || !res.body) throw new Error(`event_stream_${res.status}`);
    } catch (err) {
      onStreamLost(ctrl, err);
      return;
    }
    pump(res, ctrl);
  }

  /** Deliberately not awaited by watch(). */
  async function pump(res, ctrl) {
    try {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const data = block.match(/^data: (.*)$/m)?.[1];
          if (!data) continue;
          let evt;
          try {
            evt = JSON.parse(data);
          } catch {
            continue;
          }
          onEvent(evt);
        }
      }
    } catch (err) {
      onStreamLost(ctrl, err);
    }
  }

  function onStreamLost(ctrl, err) {
    if (ctrl.signal.aborted) return;
    log("event_stream_lost", { error: err.message });
    // Assume ready rather than wedging the queue forever on a lost stream.
    idle = true;
    onReady?.();
    setTimeout(watch, 2000).unref?.();
  }

  function onEvent(evt) {
    const type = evt?.type;
    if (type === "session.idle" || type === "session.error") {
      const id = evt.properties?.sessionID ?? evt.properties?.info?.id;
      if (!id || id === getSessionId()) {
        idle = true;
        onReady?.();
      }
    }
  }

  return {
    runtime: "opencode",
    // opencode's equivalent failure — a missing `--port` — is caught at the
    // /kstart handover, which reaches the developer as a toast. There is
    // nothing left to say at join time.
    caveat: () => null,
    // Nothing withheld from the instructions, so nothing to re-deliver.
    brief: () => null,
    attach,
    probe,
    backgroundSubagents,
    inject,
    ready: () => idle,
    start: watch,
    detach: async () => {
      abort?.abort();
      idle = true;
    },
  };
}
