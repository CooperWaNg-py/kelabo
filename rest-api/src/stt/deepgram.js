import { err } from "../errors.js";

// Deepgram, as an `SttProvider` (see ./interface.js). Everything Deepgram-shaped
// about the server side of transcription is in this file.
//
// Deepgram is configured entirely through the WebSocket URL, so `params` here is
// a query string in waiting; the client adds `sample_rate` (a property of the
// device's AudioContext, which the server cannot know) and forwards the rest
// unread. Model and feature selection therefore stay on the server, where a
// browser cannot raise the bill by editing them.

const LISTEN_URL = "wss://api.deepgram.com/v1/listen";
const GRANT_URL = "https://api.deepgram.com/v1/auth/grant";

// One grant is spent opening one socket, so it only has to outlive the
// handshake that follows it.
const DEFAULT_TTL_SECONDS = 60;

// Languages that work with nova-3 directly (English + code-switching multilingual +
// Mandarin). Others fall back to nova-2, which supports a broad discrete-language set.
const NOVA3_LANGS = new Set(["en", "multi", "zh"]);
const NOVA2_LANGS = new Set([
  "es", "fr", "de", "it", "pt", "nl", "ja", "ko", "ru", "hi", "id", "tr", "uk", "sv",
]);

function resolveLangModel(settings, requested) {
  const fallbackLang = "en";
  const lang = typeof requested === "string" && requested.trim() ? requested.trim() : fallbackLang;
  if (NOVA3_LANGS.has(lang)) return { language: lang, model: settings.model || "nova-3" };
  if (NOVA2_LANGS.has(lang)) return { language: lang, model: "nova-2" };
  // Unknown language -> safe default.
  return { language: fallbackLang, model: settings.model || "nova-3" };
}

/** @type {import("./interface.js").SttProvider} */
export const deepgramProvider = {
  id: "deepgram",

  async mint({ key, settings, opts, fetchImpl }) {
    let res;
    try {
      res = await fetchImpl(GRANT_URL, {
        method: "POST",
        headers: {
          Authorization: `Token ${key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ ttl_seconds: settings.tokenTtlSeconds || DEFAULT_TTL_SECONDS }),
      });
    } catch (e) {
      throw err(502, "stt_unavailable", String(e));
    }
    if (!res.ok) throw err(502, "stt_unavailable", `deepgram grant ${res.status}`);
    const data = await res.json();
    const token = data.access_token || data.token;
    if (!token) throw err(502, "stt_unavailable", "no token in grant response");

    const { language, model } = resolveLangModel(settings, opts.language);
    const params = {
      model,
      language,
      punctuate: "true",
      interim_results: "true",
      // Endpointing + utterance_end_ms make Deepgram emit speech_final /
      // UtteranceEnd. The reader ignores both — message boundaries are the
      // composer's — but they also shape when Deepgram finalizes, which it does
      // not do at all without them.
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
      if (settings.diarizeModel) params.diarize_model = settings.diarizeModel;
      else params.diarize = "true";
    }

    return {
      url: LISTEN_URL,
      token,
      expiresInSeconds: data.expires_in ?? settings.tokenTtlSeconds ?? DEFAULT_TTL_SECONDS,
      params,
    };
  },
};
