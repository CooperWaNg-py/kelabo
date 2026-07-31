import { err } from "./errors.js";

// Languages that work with nova-3 directly (English + code-switching multilingual +
// Mandarin). Others fall back to nova-2, which supports a broad discrete-language set.
const NOVA3_LANGS = new Set(["en", "multi", "zh"]);
const NOVA2_LANGS = new Set([
  "es", "fr", "de", "it", "pt", "nl", "ja", "ko", "ru", "hi", "id", "tr", "uk", "sv",
]);

function resolveLangModel(config, requested) {
  const fallbackLang = config.deepgram.language || "en";
  const lang = typeof requested === "string" && requested.trim() ? requested.trim() : fallbackLang;
  if (NOVA3_LANGS.has(lang)) return { language: lang, model: config.deepgram.model || "nova-3" };
  if (NOVA2_LANGS.has(lang)) return { language: lang, model: "nova-2" };
  // Unknown language -> safe default.
  return { language: fallbackLang, model: config.deepgram.model || "nova-3" };
}

export function createDeepgramToken({ config, db, secrets, fetchImpl = fetch }) {
  async function mint({ kelaboId, participant, opts = {} }) {
    const meta = await db.getKelaboMeta(kelaboId);
    if (!meta) throw err(404, "kelabo_not_found");
    if (meta.status !== "active") throw err(410, "kelabo_ended");
    const isParticipant = (meta.participants || []).some((p) => p.identity === participant.identity);
    if (!isParticipant && meta.hostIdentity !== participant.identity) throw err(403, "forbidden");

    let key;
    try {
      key = await secrets.getDeepgramKey(config);
    } catch (e) {
      throw err(502, "stt_unavailable", String(e));
    }
    let res;
    try {
      res = await fetchImpl("https://api.deepgram.com/v1/auth/grant", {
        method: "POST",
        headers: {
          Authorization: `Token ${key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ ttl_seconds: config.deepgram.tokenTtlSeconds }),
      });
    } catch (e) {
      throw err(502, "stt_unavailable", String(e));
    }
    if (!res.ok) throw err(502, "stt_unavailable", `deepgram grant ${res.status}`);
    const data = await res.json();
    const token = data.access_token || data.token;
    if (!token) throw err(502, "stt_unavailable", "no token in grant response");
    const { language, model } = resolveLangModel(config, opts.language);
    const params = {
      model,
      language,
      punctuate: "true",
      interim_results: "true",
      // Endpointing + utterance_end_ms make Deepgram emit speech_final / UtteranceEnd
      // so the client can flush a whole utterance once instead of rendering each
      // committed fragment as a separate line.
      endpointing: "300",
      utterance_end_ms: "1000",
      encoding: "linear16",
      channels: "1",
    };
    // Diarization is off by default; only enable it when the client opts in.
    // Deepgram rejects requests that set both `diarize` and `diarize_model`, so
    // when a diarize model is configured we send only `diarize_model` (which also
    // enables diarization); otherwise fall back to the deprecated boolean flag.
    if (opts.diarize) {
      if (config.deepgram.diarizeModel) params.diarize_model = config.deepgram.diarizeModel;
      else params.diarize = "true";
    }
    return {
      token,
      expiresInSeconds: data.expires_in ?? config.deepgram.tokenTtlSeconds,
      params,
    };
  }

  return { mint };
}
