// Kelabo Agent Protocol (KAP) — the frames carried over WSS /rig between the
// Gateway and a developer's local agent bridge (docs 16).
//
// The protocol is deliberately runtime-agnostic: nothing here names opencode,
// Claude Code or any other coding agent. `sessionRef` and `workspace` are opaque
// strings the Gateway stores and never interprets, so adding a runtime is an
// adapter in the bridge rather than a change to this file.
//
// Two things are absent on purpose:
//   * `[LLM_CON]`. A contribution is structured. Marker parsing cannot tell a
//     deliberate board post from the agent answering the developer's own typed
//     question, and in an interactive session both happen in one transcript.
//   * `:KELABO-END`. Summary and archive are requestId-correlated `request`
//     frames. As an in-band caption token it fired on any caption merely
//     *containing* the string, and the reply had to be stolen off the board.
import { z } from "zod";
import { archiveSchema, contributionSourceSchema, kelaboParticipantSchema } from "./schemas.js";

// ---------------------------------------------------------------------------
// Up: bridge -> Gateway
// ---------------------------------------------------------------------------

/** Who is on the other end. Free-form strings: the Gateway logs and displays
 *  these, and must not branch on them. */
export const agentInfoSchema = z.object({
  runtime: z.string().min(1).max(64),
  version: z.string().max(64).default(""),
  // Shown on the board next to the agent's posts, e.g. "alice's opencode".
  label: z.string().max(80).default(""),
});

export const frameRegisterSchema = z.object({
  type: z.literal("register"),
  token: z.string().min(1),
  agent: agentInfoSchema,
});

export const frameHeartbeatSchema = z.object({
  type: z.literal("heartbeat"),
});

/** Bind this agent session to a kelabo. Whether the binding receives transcript
 *  is decided by the kelabo's status on the Gateway, never by the client. */
export const frameAttachSchema = z.object({
  type: z.literal("attach"),
  kelaboId: z.string().min(1),
  runtime: z.string().min(1).max(64),
  // Opaque handle for the runtime's own session. Empty is legal: a runtime that
  // pushes into "the session that spawned me" (a Claude Code channel) has no id
  // to give, and the previous protocol rejected those frames outright.
  sessionRef: z.string().max(256).default(""),
  workspace: z.string().max(1024).default(""),
});

// A board card, in any of its states. One lookup is one card: it appears as
// `working` the moment the agent takes the question, and the same frame type
// later carries the answer. That is the same lifecycle the in-ECS agent already
// publishes (docs 14 §5) — a dev agent joins the existing channel rather than
// getting a second one.
//
// `markdown` is optional here because a `working` card has no body yet. The
// "a finished card must say something" rule is enforced at the Gateway, not in
// this schema: a discriminated-union member has to stay a plain object.
export const frameContributionSchema = z.object({
  type: z.literal("contribution"),
  kelaboId: z.string().min(1),
  markdown: z.string().default(""),
  to: z.string().max(80).default("all"),
  title: z.string().max(200).default(""),
  kind: z.enum(["answer", "link", "code", "clarify", "note"]).default("answer"),
  sources: z.array(contributionSourceSchema).max(20).optional(),
  // Which card this frame writes to. Stable across a card's updates, and scoped
  // to the sending connection: the Gateway maps it to the real contribution id,
  // so an agent can only ever address a card it opened itself.
  card: z.string().min(1).max(128).optional(),
  status: z.enum(["working", "done", "skipped"]).default("done"),
  // The live status line, and the trail of what has been done so far. Both are
  // dropped when the card finishes — see the SPA's board reducer.
  progress: z.string().max(200).optional(),
  steps: z.array(z.string().max(200)).max(6).optional(),
  // Why nothing is coming, on a `skipped` card.
  reason: z.string().max(300).optional(),
  // Client-side idempotency key, so a retry after a dropped socket does not
  // double-post.
  ref: z.string().max(128).optional(),
});

export const frameSummarySchema = z.object({
  type: z.literal("summary"),
  requestId: z.string().min(1),
  kelaboId: z.string().min(1),
  // Raw model output. The Gateway parses it with the same tolerant reader it
  // uses for the server agent, so a half-formed answer still yields minutes.
  text: z.string(),
});

export const frameArchiveSchema = z.object({
  type: z.literal("archive"),
  requestId: z.string().min(1),
  archive: archiveSchema,
});

export const frameRenameSchema = z.object({
  type: z.literal("rename"),
  kelaboId: z.string().min(1),
  title: z.string().min(1).max(200),
});

/** Read the kelabo's board. Served over the tunnel rather than the REST board
 *  route, whose participant cookie cannot exist before a kelabo starts — and
 *  seeing its own earlier posts is exactly what a preparing agent needs. */
export const frameBoardRequestSchema = z.object({
  type: z.literal("board_request"),
  requestId: z.string().min(1),
  kelaboId: z.string().min(1),
});

/** Read the minutes of the host's past kelabos. Answered only when the host
 *  opted in at creation (`historyEnabled`) — the same gate, and the same
 *  minutes-not-transcripts reduction, as the in-ECS agent's memory of earlier
 *  kelabos, so the tunnel never widens what the host already granted. */
export const frameHistoryRequestSchema = z.object({
  type: z.literal("history_request"),
  requestId: z.string().min(1),
  kelaboId: z.string().min(1),
});

export const frameDetachSchema = z.object({
  type: z.literal("detach"),
  kelaboId: z.string().min(1).optional(),
});

/** Discriminated union of all bridge -> Gateway frames. Unknown fields ignored. */
export const upFrameSchema = z.discriminatedUnion("type", [
  frameRegisterSchema,
  frameHeartbeatSchema,
  frameAttachSchema,
  frameContributionSchema,
  frameSummarySchema,
  frameArchiveSchema,
  frameRenameSchema,
  frameBoardRequestSchema,
  frameHistoryRequestSchema,
  frameDetachSchema,
]);

// ---------------------------------------------------------------------------
// Down: Gateway -> bridge
// ---------------------------------------------------------------------------

export const frameRegisteredSchema = z.object({
  type: z.literal("registered"),
  agentId: z.string(),
  // The kelabo this agent is already bound to, if the Gateway restored one.
  // Empty means "nothing bound yet"; the bridge attaches explicitly.
  kelaboId: z.string().default(""),
});

export const frameRejectedSchema = z.object({
  type: z.literal("rejected"),
  reason: z.string(),
});

export const briefingInviteeSchema = z.object({
  displayName: z.string(),
  email: z.string().optional(),
  response: z.enum(["accepted", "declined", "pending"]).default("pending"),
  isHost: z.boolean().default(false),
});

/** Everything the agent needs to start working, delivered once on attach. For a
 *  scheduled kelabo this is the whole of its context: there is no transcript. */
export const frameBriefingSchema = z.object({
  type: z.literal("briefing"),
  kelaboId: z.string().min(1),
  status: z.enum(["scheduled", "active"]),
  title: z.string().default(""),
  host: z.string().default(""),
  scheduledAt: z.number().optional(),
  durationMinutes: z.number().optional(),
  startedAt: z.number().optional(),
  // The host's free-text agenda note. Host-authored, unlike everything else here.
  note: z.string().default(""),
  invitees: z.array(briefingInviteeSchema).default([]),
  participants: z.array(kelaboParticipantSchema).default([]),
});

/** One sealed speaker message. `messageId`/`seq` carry the speaker's own message
 *  boundaries (docs 13) so the bridge can coalesce without re-deriving them. */
export const frameTranscriptSchema = z.object({
  type: z.literal("transcript"),
  kelaboId: z.string().min(1),
  messageId: z.string().default(""),
  seq: z.number().default(0),
  speaker: z.string(),
  text: z.string(),
  at: z.number(),
  final: z.boolean().default(true),
  // True for a participant's typed board note rather than spoken words.
  human: z.boolean().default(false),
});

export const frameKelaboSchema = z.object({
  type: z.literal("kelabo"),
  kelaboId: z.string().min(1),
  // `cancelled`/`rescheduled` reach an agent that was *preparing* for a
  // scheduled kelabo (docs 18 §2.4, §3.3): it must learn the kelabo is gone or
  // has moved, since it will otherwise sit on a briefing that no longer holds.
  event: z.enum(["started", "ended", "renamed", "cancelled", "rescheduled"]),
  title: z.string().optional(),
  // Present on `rescheduled`: the new intended start (epoch ms).
  scheduledAt: z.number().optional(),
});

export const frameRequestSchema = z.object({
  type: z.literal("request"),
  kind: z.enum(["summary", "archive"]),
  requestId: z.string().min(1),
  kelaboId: z.string().min(1),
});

export const frameBoardSchema = z.object({
  type: z.literal("board"),
  requestId: z.string().min(1),
  kelaboId: z.string().min(1),
  contributions: z.array(z.object({
    id: z.string(),
    title: z.string(),
    to: z.string(),
    markdown: z.string(),
    author: z.string(),
    at: z.number(),
  })).default([]),
});

export const frameHistorySchema = z.object({
  type: z.literal("history"),
  requestId: z.string().min(1),
  kelaboId: z.string().min(1),
  // False when the host never opted in — distinct from opted-in-but-empty,
  // so the agent can tell the developer which of the two it is.
  enabled: z.boolean().default(true),
  entries: z.array(z.object({
    kelaboId: z.string(),
    title: z.string(),
    endedAt: z.number().nullable().default(null),
    summary: z.string().default(""),
    decisions: z.array(z.string()).default([]),
    actionItems: z.array(z.string()).default([]),
  })).default([]),
});

export const framePingSchema = z.object({
  type: z.literal("ping"),
});

/** Discriminated union of all Gateway -> bridge frames. */
export const downFrameSchema = z.discriminatedUnion("type", [
  frameRegisteredSchema,
  frameRejectedSchema,
  frameBriefingSchema,
  frameTranscriptSchema,
  frameKelaboSchema,
  frameRequestSchema,
  frameBoardSchema,
  frameHistorySchema,
  framePingSchema,
]);

/** @param {string|Buffer} raw @returns {{ok:true, frame:object}|{ok:false, error:string}} */
export function parseUpFrame(raw) {
  return parseFrame(raw, upFrameSchema);
}

/** @param {string|Buffer} raw @returns {{ok:true, frame:object}|{ok:false, error:string}} */
export function parseDownFrame(raw) {
  return parseFrame(raw, downFrameSchema);
}

function parseFrame(raw, schema) {
  let obj;
  try {
    obj = JSON.parse(String(raw));
  } catch {
    return { ok: false, error: "invalid_json" };
  }
  const r = schema.safeParse(obj);
  return r.success ? { ok: true, frame: r.data } : { ok: false, error: r.error.message };
}
