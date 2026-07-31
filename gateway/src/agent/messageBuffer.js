// Buffers finalized caption fragments into per-speaker open messages before anything is
// submitted to the LLM (legacy path for clients that do not mark turnComplete). A message closes — and only then is it dispatched — when
// the speaker changes or when no new fragment arrives within the configured
// silence timeout. This keeps partial mid-sentence fragments away from the
// trigger gate and gives the agent whole, immutable messages.
const CJK_CHAR = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef\u3000-\u303f]/;

function joinTexts(a, b) {
  if (!a) return b;
  return CJK_CHAR.test(a.slice(-1)) || CJK_CHAR.test(b.charAt(0)) ? a + b : a + " " + b;
}

export function createMessageBuffer(c) {
  const openMessages = new Map();

  const timeoutMs = () => (c.config.gateway.agent.turnTimeoutSeconds ?? 1) * 1000;

  async function flush(kelaboId) {
    const turn = openMessages.get(kelaboId);
    if (!turn) return;
    openMessages.delete(kelaboId);
    clearTimeout(turn.timer);
    const text = turn.texts.filter(Boolean).reduce(joinTexts, "");
    if (!text) return;
    const utt = {
      kelaboId,
      clientId: turn.clientId,
      speaker: turn.speaker,
      text,
      tStart: turn.tStart,
      tEnd: turn.tEnd,
      isFinal: true,
      tenantId: turn.tenantId,
    };
    c.log("turn_completed", { kelaboId, speaker: turn.speaker, fragments: turn.texts.length, chars: text.length });
    try {
      await c.agentDispatcher.handleCaption(utt);
    } catch (err) {
      c.logError("agent_dispatch_failed", err, { kelaboId });
    }
  }

  function add(utt) {
    const open = openMessages.get(utt.kelaboId);
    // A different speaker closes the previous turn immediately.
    if (open && open.speaker !== utt.speaker) {
      flush(utt.kelaboId).catch((err) => c.logError("turn_flush_failed", err, { kelaboId: utt.kelaboId }));
    }
    let turn = openMessages.get(utt.kelaboId);
    if (!turn) {
      turn = {
        speaker: utt.speaker,
        texts: [],
        tStart: utt.tStart,
        tEnd: utt.tEnd,
        clientId: utt.clientId,
        tenantId: utt.tenantId,
        timer: null,
      };
      openMessages.set(utt.kelaboId, turn);
    }
    turn.texts.push(utt.text);
    if (typeof utt.tEnd === "number") turn.tEnd = utt.tEnd;
    if (typeof utt.tStart === "number" && (turn.tStart == null || utt.tStart < turn.tStart)) turn.tStart = utt.tStart;
    clearTimeout(turn.timer);
    turn.timer = setTimeout(() => {
      flush(utt.kelaboId).catch((err) => c.logError("turn_flush_failed", err, { kelaboId: utt.kelaboId }));
    }, timeoutMs());
    turn.timer.unref?.();
  }

  function drop(kelaboId) {
    const turn = openMessages.get(kelaboId);
    if (turn) {
      clearTimeout(turn.timer);
      openMessages.delete(kelaboId);
    }
  }

  return { add, flush, drop };
}
