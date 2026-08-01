import { randomUUID } from "node:crypto";
import {
  addressesAssistant,
  captionPostSchema,
  captionRenameSchema,
  COOKIE_PARTICIPANT,
  SSE_EVENT_RENAME,
  stripAddress,
} from "@kelabo/contracts";
import { parseCookies, verifyParticipantCookie } from "./cookies.js";
import { putUtt, getMeta, updateMeta, renameSpeakerUtts } from "./db.js";

const DIARIZATION_LABEL = /^[A-Z]$/;

// Text comparison that ignores case, whitespace and punctuation, so
// "Population of Australia." and "population of australia," compare equal.
const normalizeText = (s) => String(s || "").toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");

export async function readJson(req, limit = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error("payload_too_large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

export async function handleCaptionPost(c, req, res) {
  const cookies = parseCookies(req);
  const key = await c.getCookieKey();
  const participant = verifyParticipantCookie(cookies[COOKIE_PARTICIPANT], key);
  if (!participant) return send(res, 401, { error: "unauthenticated" });

  let body;
  try {
    body = await readJson(req);
  } catch {
    return send(res, 400, { error: "bad_request" });
  }
  const parsed = captionPostSchema.safeParse(body);
  if (!parsed.success) return send(res, 400, { error: "bad_request", detail: parsed.error.issues });
  const post = parsed.data;

  if (post.kelaboId !== participant.kelaboId) return send(res, 403, { error: "forbidden" });

  // Determine the display label for this utterance.
  // - Diarized stream: the capturer sends the Deepgram A/B label; we then apply
  //   any host-assigned rename so it shows as a real name.
  // - Non-diarized: attribute to the capturing participant (their display name),
  //   falling back to their identity.
  const meta = await getMeta(c, post.kelaboId).catch(() => null);
  const nameMap = meta?.speakerNames ?? {};
  let speaker;
  if (post.diarized && DIARIZATION_LABEL.test(post.speaker ?? "")) {
    speaker = nameMap[post.speaker] ?? post.speaker;
  } else {
    speaker = (post.displayName ?? "").trim() || participant.identity;
  }

  // A delta is an append to a message the speaker is still producing: relay it
  // to the room for live display and stop. Never persisted, never buffered,
  // never handed to the agent — the sealed message that follows does all three.
  //
  // Deliberately ahead of the duplicate check below: a one-delta message has the
  // same text as its own sealed post, so running deltas through that cache would
  // make every short message suppress itself and never reach the LLM.
  // Everything except a sealed message is liveness only: relay to the room and
  // stop. A `tail` is Deepgram's current guess at what is being said; a `delta`
  // is words it confirmed. Neither is persisted, buffered or handed to the
  // agent — the sealed message does all three.
  const isLive =
    post.kind === "tail" ||
    post.kind === "delta" ||
    (post.kind === undefined && post.ephemeral);
  if (isLive && !post.human) {
    c.sseHub.utterance(post.kelaboId, {
      speaker,
      text: post.text,
      tStart: post.tStart,
      tEnd: post.tEnd,
      by: participant.identity,
      at: Date.now(),
      messageId: post.messageId,
      seq: post.seq,
      kind: post.kind ?? "delta",
      partial: true,
    });
    return send(res, 202, { ok: true, kind: post.kind ?? "delta" });
  }

  // A message somebody typed into the transcript panel rather than spoke. It is
  // handled exactly like a sealed spoken message from here on — persisted,
  // fanned out, handed to the agent — with two deliberate differences: it skips
  // duplicate suppression (saying the same short thing twice on purpose is a
  // normal thing to type and never a re-emission), and an explicit `@kelabo`
  // makes it a direct address, which bypasses the trigger gate.
  const typed = post.source === "typed";
  const addressed = typed && addressesAssistant(post.text);

  // Drop exact-duplicate consecutive turns from the same speaker: late STT
  // re-emissions and two devices in the same room both transcribing one voice
  // would otherwise persist, fan out and submit the same message twice.
  // In-memory and marked before any await, so near-simultaneous posts from
  // the same gateway process race-free.
  const norm = normalizeText(post.text);
  if (!post.human && !typed && norm) {
    const prev = c.state.lastCaption.get(post.kelaboId);
    if (prev && prev.speaker === speaker && prev.norm === norm) {
      c.log("caption_duplicate_skipped", { kelaboId: post.kelaboId, speaker });
      return send(res, 202, { ok: true, duplicate: true });
    }
    c.state.lastCaption.set(post.kelaboId, { speaker, norm });
  }

  const utt = {
    kelaboId: post.kelaboId,
    clientId: "gateway",
    speaker,
    text: post.text,
    tStart: post.tStart,
    tEnd: post.tEnd,
    isFinal: true,
    tenantId: participant.tenantId,
    // Persisted, so the record and its download can tell a typed line from a
    // transcribed one. Absent means speech — the pre-2026-08 rows say so.
    ...(typed ? { source: "typed" } : {}),
  };

  try {
    await putUtt(c, utt);
  } catch (err) {
    c.logError("utt_append_failed", err, { kelaboId: post.kelaboId });
    return send(res, 500, { error: "internal_error" });
  }
  c.log("caption_appended", { kelaboId: post.kelaboId, speaker, human: !!post.human });

  // Fan out the sealed utterance to all participants. It carries the same
  // `messageId` as the fragments that preceded it, so each receiver replaces
  // its provisional text with this authoritative version and closes the message
  // at exactly the point the speaker closed it — rather than being left to
  // guess boundaries from a fragment stream.
  if (!post.human) {
    c.sseHub.utterance(post.kelaboId, {
      speaker,
      text: post.text,
      tStart: post.tStart,
      tEnd: post.tEnd,
      by: participant.identity,
      at: Date.now(),
      messageId: post.messageId,
      reason: post.reason,
      kind: "sealed",
      partial: false,
      // Carried through so the room can mark a typed line as typed. The sender
      // is the one participant who filters their own echo out, so without this
      // riding the wire only *they* would know they had typed it.
      ...(typed ? { source: "typed" } : {}),
    });
  }

  if (post.human) {
    const note = {
      id: randomUUID(),
      kelaboId: post.kelaboId,
      tag: "note",
      kind: "note",
      title: post.text.split("\n")[0].slice(0, 80),
      to: "all",
      markdown: post.text,
      author: participant.identity,
      at: Date.now(),
      tenantId: participant.tenantId,
    };
    await c.sseHub.publish(post.kelaboId, note);
  }

  // Routing, per caption, from live in-process state: a developer's attached
  // agent takes the kelabo, otherwise the in-task server agent does. Note this
  // reads `tunnelByKelabo` only — an agent that is merely *preparing* for a
  // scheduled kelabo lives in `prepByKelabo` and is structurally unable to
  // receive transcript (docs 16 §5).
  const attached = c.tunnel.sendTranscript(post.kelaboId, {
    messageId: post.messageId,
    seq: post.seq,
    speaker,
    text: post.text,
    at: Date.now(),
    human: !!post.human,
  });
  if (!attached && addressed) {
    // Typing "@kelabo …" is an instruction, not a hint, so it goes straight to
    // the agent with the gate skipped. The gate exists to decide whether the
    // kelabo *would want* an answer to something nobody asked it for; someone
    // who typed its name has already answered that question, and letting a
    // classifier overrule them (or a 45-second cooldown swallow them) is how
    // "the bot ignores me" happens.
    c.agentDispatcher
      .handleCaption(utt, { addressed: true, query: stripAddress(post.text) })
      .catch((err) => c.logError("agent_dispatch_failed", err, { kelaboId: post.kelaboId }));
  } else if (!attached && !post.human) {
    if (post.turnComplete) {
      // A complete speaker turn (a closed chat bubble) — the only kind of
      // message the LLM should see. Dispatch immediately, no buffering.
      c.agentDispatcher.handleCaption(utt).catch((err) =>
        c.logError("agent_dispatch_failed", err, { kelaboId: post.kelaboId })
      );
    } else {
      // Legacy fragment posts: buffer into a per-speaker turn and only submit
      // once it closes (speaker change or silence timeout).
      c.messageBuffer.add(utt);
    }
  }

  return send(res, 202, { ok: true });
}

export async function handleCaptionRename(c, req, res) {
  const cookies = parseCookies(req);
  const key = await c.getCookieKey();
  const participant = verifyParticipantCookie(cookies[COOKIE_PARTICIPANT], key);
  if (!participant) return send(res, 401, { error: "unauthenticated" });

  let body;
  try {
    body = await readJson(req);
  } catch {
    return send(res, 400, { error: "bad_request" });
  }
  const parsed = captionRenameSchema.safeParse(body);
  if (!parsed.success) return send(res, 400, { error: "bad_request", detail: parsed.error.issues });
  const { kelaboId, from, to } = parsed.data;

  if (kelaboId !== participant.kelaboId) return send(res, 403, { error: "forbidden" });

  // Flush any buffered turn so it carries the old label and the rename only
  // applies to persisted rows + future turns.
  await c.messageBuffer?.flush?.(kelaboId).catch(() => {});

  const meta = await getMeta(c, kelaboId).catch(() => null);
  if (!meta) return send(res, 404, { error: "kelabo_not_found" });

  // Resolve the current stored label for `from` in case it was already renamed,
  // so repeated renames chain correctly.
  const existing = meta.speakerNames ?? {};
  const resolvedFrom = existing[from] || from;
  const target = to.trim();

  // 1) Retroactively rewrite persisted transcript rows.
  let updated = 0;
  try {
    updated = await renameSpeakerUtts(c, kelaboId, resolvedFrom, target || from);
  } catch (err) {
    c.logError("speaker_rename_utt_failed", err, { kelaboId });
    return send(res, 500, { error: "internal_error" });
  }

  // 2) Persist the mapping on META so future captions + rehydration use it.
  const speakerNames = { ...existing };
  if (target) speakerNames[from] = target;
  else delete speakerNames[from];
  await updateMeta(c, kelaboId, { speakerNames }).catch((err) =>
    c.logError("speaker_rename_meta_failed", err, { kelaboId })
  );

  // 3) Update the in-memory agent window so future LLM context reflects the name.
  c.agentDispatcher.renameSpeaker?.(kelaboId, resolvedFrom, target || from);

  // 4) Fan out to all connected clients so their transcript UIs update.
  c.sseHub.rename(kelaboId, { from, to: target || from });

  c.log("speaker_renamed", { kelaboId, from, to: target, updated });
  return send(res, 200, { ok: true, updated });
}

export function send(res, status, obj, headers = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(body);
}
