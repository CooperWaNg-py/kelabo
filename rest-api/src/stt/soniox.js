import { err } from "../errors.js";

// Soniox, as an `SttProvider` (see ./interface.js). Everything Soniox-shaped
// about the server side of transcription is in this file.
//
// The credential is a TEMPORARY API KEY minted from the long-lived one, which is
// the only thing Soniox supports for a client that connects directly.
//
// `single_use` IS DELIBERATELY FALSE, and this is not an oversight. The client
// opens a separate Soniox stream for every utterance — that is what keeps a
// silent participant free — and one connection carries exactly one stream, so a
// single-use key would authenticate the first utterance and 401 every one after
// it. The key is instead bounded by time and by session length, and the client
// refreshes it between utterances rather than minting one per stream, because a
// mint costs ~470ms and would land on the critical path of every single thing
// anybody says.
//
// What remains is still narrow: `expires_in_seconds` bounds how long a leaked
// key can open new streams at all, and `max_session_duration_seconds` bounds
// how long any one of them can run.
//
// `client_reference_id` is bound to the key at creation and cannot be overridden
// by whoever holds it, so every request it authenticates lands in Soniox's usage
// log under the kelabo it belongs to. That is per-kelabo cost attribution for
// free, and it is the only way to get it: the browser talks to Soniox directly
// and Kelabo never sees the stream.

const SOCKET_URL = "wss://stt-rt.soniox.com/transcribe-websocket";
const TEMP_KEY_URL = "https://api.soniox.com/v1/auth/temporary-api-key";

const DEFAULT_MODEL = "stt-rt-v5";
// Long enough that a client refreshing between utterances is never caught short
// on the critical path, and short enough that a leaked key is soon worthless.
const DEFAULT_TTL_SECONDS = 600;
// Soniox accepts 1..18000. Four hours is longer than any kelabo we have seen and
// far short of the 300-minute cap the socket has anyway; it exists to bound what
// a leaked key could spend, not to end kelabos.
const DEFAULT_MAX_SESSION_SECONDS = 14400;
// Soniox accepts 1..3600 for the mint itself.
const MAX_TTL_SECONDS = 3600;

const clamp = (n, lo, hi) => Math.min(Math.max(Math.round(n), lo), hi);

/**
 * Soniox has ONE model for every language and switches between them mid-sentence
 * on its own, so there is no model table here — the whole `resolveLangModel`
 * apparatus a per-language-model provider needs simply does not apply. A
 * language is a HINT that improves accuracy, and "multi" means "do not hint",
 * which is the native behaviour rather than a special mode.
 */
function languageHints(requested) {
  const lang = typeof requested === "string" ? requested.trim() : "";
  if (!lang || lang === "multi" || lang === "auto") return null;
  return [lang];
}

/** @type {import("./interface.js").SttProvider} */
export const sonioxProvider = {
  id: "soniox",

  async mint({ key, settings, opts, fetchImpl }) {
    const ttl = clamp(settings.tokenTtlSeconds || DEFAULT_TTL_SECONDS, 1, MAX_TTL_SECONDS);

    let res;
    try {
      res = await fetchImpl(TEMP_KEY_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          usage_type: "transcribe_websocket",
          expires_in_seconds: ttl,
          // See the header: one key, many streams, one per utterance.
          single_use: false,
          max_session_duration_seconds: clamp(
            settings.maxSessionSeconds || DEFAULT_MAX_SESSION_SECONDS,
            1,
            18000,
          ),
          // Bounded because Soniox rejects anything over 256 characters, and a
          // rejected mint would take transcription down for a kelabo whose only
          // sin was a long id.
          client_reference_id: String(opts.kelaboId || "").slice(0, 256),
        }),
      });
    } catch (e) {
      throw err(502, "stt_unavailable", String(e));
    }
    if (!res.ok) throw err(502, "stt_unavailable", `soniox temporary-api-key ${res.status}`);

    const data = await res.json();
    const token = data.api_key;
    if (!token) throw err(502, "stt_unavailable", "no api_key in temporary-api-key response");

    const hints = languageHints(opts.language);
    const params = {
      model: settings.model || DEFAULT_MODEL,
      // Raw PCM has no header for Soniox to sniff, so the encoding, the channel
      // count and (added by the client) the sample rate all have to be stated.
      audio_format: "pcm_s16le",
      num_channels: 1,
      ...(hints ? { language_hints: hints } : {}),
      enable_language_identification: true,
      // ALWAYS ON. It costs nothing extra, and one microphone in a room is
      // several people — which is the case this provider is here to serve.
      enable_speaker_diarization: true,
      // Semantic endpointing: the model decides when a speaker has finished
      // rather than waiting on a silence timer. It is what finalizes tokens
      // promptly, and the `<end>` marker it emits is the cleanest signal that
      // an utterance is over.
      //
      // A knob, because it is a genuine trade: Soniox documents that earlier
      // finalization costs some diarization accuracy. A room that cares more
      // about who-said-what than about latency turns it off in config.
      enable_endpoint_detection: settings.endpointDetection !== false,
      // Tuning measured against stt-rt-v5. `max_endpoint_delay_ms` is the hard
      // ceiling on how long the model may wait after speech stops;
      // `endpoint_latency_adjustment_level` (v5 only, 0..3) trades recognition
      // time for responsiveness; `endpoint_sensitivity` (-1..1) makes endpoints
      // more or less likely at that latency.
      ...(settings.endpointDetection !== false
        ? {
            max_endpoint_delay_ms: clamp(settings.maxEndpointDelayMs || 1500, 500, 3000),
            endpoint_latency_adjustment_level: clamp(settings.endpointLatencyLevel ?? 2, 0, 3),
            endpoint_sensitivity: Math.min(Math.max(settings.endpointSensitivity ?? 0.3, -1), 1),
          }
        : {}),
    };

    return {
      url: SOCKET_URL,
      token,
      // `expires_at` is absolute; the client wants a duration. Falls back to
      // what was asked for rather than trusting a clock we did not set.
      expiresInSeconds: expiresIn(data.expires_at, ttl),
      params,
    };
  },
};

function expiresIn(expiresAt, fallback) {
  const at = Date.parse(expiresAt || "");
  if (!Number.isFinite(at)) return fallback;
  const seconds = Math.round((at - Date.now()) / 1000);
  return seconds > 0 ? seconds : fallback;
}
