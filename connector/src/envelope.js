// What every runtime shows the agent (docs 16 §3).
//
// Pure — no MCP, no fetch, an injected clock — so `test/envelope.mjs` can run it
// under plain node. This is the module where a wording or framing mistake is
// otherwise only findable in a live kelabo, which is exactly the reason the
// transcript reducer in the SPA is pure too.
//
// One composer for both runtimes, deliberately: on Claude Code the result is the
// body of a channel notification, on opencode it is the text of an injected
// message. If each adapter formatted its own, the two would drift and the agent
// would behave differently depending on which one the developer happened to run.

/** Attributes are quoted and the value is escaped: a kelabo title or a
 *  participant's display name is attacker-controlled and must not be able to
 *  close the tag it sits in. */
function attrs(map) {
  return Object.entries(map)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => ` ${k}="${escapeAttr(String(v))}"`)
    .join("");
}

function escapeAttr(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function clock(at, now) {
  const d = new Date(at || now);
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * A batch of sealed speaker messages.
 *
 * `untrusted="true"` is not decoration. Anyone in the kelabo, including a
 * name-only guest, can speak text that lands here, in front of an agent with
 * read access to a private repository. The attribute plus the persona is the
 * only thing separating "someone said this" from "you were told to do this".
 *
 * @param {{kelaboId:string, messages:Array<{speaker:string,text:string,at?:number,human?:boolean}>,
 *          dropped?:number, now?:number}} input
 */
export function transcriptEnvelope({ kelaboId, messages, dropped = 0, now = Date.now() }) {
  const lines = messages.map((m) => {
    // A typed board note is not speech, and an agent that treats it as speech
    // will misattribute it in the minutes.
    const kind = m.human ? " (typed note)" : "";
    return `[${clock(m.at, now)}] ${m.speaker}${kind}: ${m.text}`;
  });
  // Say so when the backlog was trimmed. Silently losing the middle of a
  // conversation reads as the speaker changing their mind.
  if (dropped > 0) {
    lines.unshift(`[… ${dropped} earlier message${dropped === 1 ? "" : "s"} dropped: the agent was busy …]`);
  }
  return `<kelabo-transcript${attrs({ kelabo: kelaboId, untrusted: "true" })}>\n${lines.join("\n")}\n</kelabo-transcript>`;
}

/**
 * The kelabo briefing, delivered once on attach. For a scheduled kelabo this
 * is the whole of the agent's context: there is no transcript yet.
 *
 * Only `title` and `note` are host-authored. Invitee display names are supplied
 * by whoever RSVP'd, including link guests, so the whole thing carries the same
 * untrusted marking as transcript.
 */
export function briefingEnvelope(b, now = Date.now()) {
  const scheduled = b.status === "scheduled";
  const lines = [];
  lines.push(`Kelabo: ${b.title || "(untitled)"}`);
  lines.push(`Host: ${b.host || "(unknown)"}`);
  if (scheduled && b.scheduledAt) {
    lines.push(`Starts: ${new Date(b.scheduledAt).toISOString()} (${relative(b.scheduledAt, now)})`);
    if (b.durationMinutes) lines.push(`Duration: ${b.durationMinutes} minutes`);
  } else if (b.startedAt) {
    lines.push(`Started: ${relative(b.startedAt, now)}`);
  }
  if (b.note) lines.push(`Agenda note from the host: ${b.note}`);
  if (b.invitees?.length) {
    lines.push(
      `Invited: ${b.invitees.map((i) => `${i.displayName}${i.isHost ? " (host)" : ""} — ${i.response}`).join(", ")}`
    );
  }
  if (b.participants?.length) {
    lines.push(`In the room: ${b.participants.map((p) => p.displayName).join(", ")}`);
  }
  lines.push("");
  lines.push(
    scheduled
      ? "This kelabo has not started. There is no transcript. Investigate what would be useful and post findings with kelabo_post; they are on the board before the first participant arrives. Nothing you post reaches anyone until then."
      : "This kelabo is live. Transcript will arrive as it is spoken."
  );
  return `<kelabo-briefing${attrs({ kelabo: b.kelaboId, status: b.status, untrusted: "true" })}>\n${lines.join("\n")}\n</kelabo-briefing>`;
}

/** Lifecycle notices, and the summary/archive requests. Same wrapper so an agent
 *  has one shape to recognise rather than three. */
export function noticeEnvelope(kelaboId, text) {
  return `<kelabo-notice${attrs({ kelabo: kelaboId })}>\n${text}\n</kelabo-notice>`;
}

export function relative(at, now = Date.now()) {
  const ms = at - now;
  const abs = Math.abs(ms);
  const mins = Math.round(abs / 60000);
  if (mins < 1) return ms >= 0 ? "now" : "just now";
  const unit = mins < 60 ? `${mins} minute${mins === 1 ? "" : "s"}` : `${Math.round(mins / 60)} hour${Math.round(mins / 60) === 1 ? "" : "s"}`;
  return ms >= 0 ? `in ${unit}` : `${unit} ago`;
}
