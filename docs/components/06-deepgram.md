# Component: Deepgram STT integration

Speech-to-text with **real-time speaker diarization**. Key property: **audio goes
browser → Deepgram directly**; it never touches Kelabo infra (cost + serverless +
privacy). Kelabo only mints a short-lived token and receives finalized transcripts.

Originally validated against a working prototype (since removed); the capture
behavior now lives in `spa/src/capture/`.

---

## 1. Split of responsibilities

| Piece | Where | Responsibility |
|-------|-------|----------------|
| Token minter | REST API Lambda `POST /kelabos/:id/stt-token` | mint a short-lived Deepgram token from the server key |
| Capture client | SPA (browser) | mic → PCM → WSS to Deepgram → diarized transcript |
| Utterance emitter | SPA (browser) | turn Deepgram words into `Utterance`s, POST finals to Gateway |
| Deepgram | external | STT + diarization |

The server **never** proxies audio and **never** holds a browser-visible long-lived
key.

---

## 2. Token minting (server)

`POST /kelabos/:id/stt-token` (participant cookie required, kelabo active):
- Server holds the Deepgram API key in **Secrets Manager**
  (`kelabo/<env>/deepgram`).
- Mints a **short-lived token** (Deepgram temporary token / scoped key) and returns
  it plus connection params.
- **Response:**
  ```json
  { "token": "<short-lived>",
    "expiresInSeconds": 60,
    "params": {
      "model": "nova-3",
      "diarize_model": "latest",
      "punctuate": "true",
      "interim_results": "true",
      "encoding": "linear16",
      "channels": "1"
    } }
  ```
- The browser fetches a fresh token per capture (re)connect (one cheap round-trip
  before streaming). Rate-limit + attribute usage per participant.

> **Multilingual (reserved):** when the kelabo has translation enabled, the token minter
> adds `"detect_language": "true"` (and drops any fixed `language`) so Deepgram
> auto-detects each speaker's language — participants configure nothing. The
> detected code is stamped on each `Utterance.lang`; server-side translation
> fills `Utterance.tr` in the host-chosen target language.

> The prototype pasted a raw key in the browser; production replaced that
> with this token endpoint (ARCHITECTURE §2, §15.6).

---

## 3. Capture client (browser)

The pipeline (`spa/src/capture/useCapture.js`, carried over from the prototype):
1. `getUserMedia({audio:true})` → `AudioContext` (device sample rate).
2. `ScriptProcessorNode` (or AudioWorklet later) → Float32 → **Int16 PCM**, ~4096
   frame chunks.
3. Fetch STT token, open
   `wss://api.deepgram.com/v1/listen?<params>&sample_rate=<ctxRate>` with the token
   as the `token` subprotocol (browser can't set Authorization headers on WS).
4. Send PCM buffers as binary frames **only while the VAD gate is open** (§3.1);
   during gated silence send a `KeepAlive` JSON instead (idle close is 10s; DG
   documents a 3–5s cadence, so the client pings at ~4s).
5. On stop/mute: send `CloseStream`, close socket (mute keeps the mic track alive to
   avoid re-prompting but stops billing).

### 3.1 VAD gate (`spa/src/capture/vad.js`)

Deepgram bills the audio actually streamed, and with one mic per participant each
client is silent for most of a kelabo. The capture pipeline runs an energy gate
with an adaptive noise floor over every frame and streams only speech:

| Knob | Default | Why |
|---|---|---|
| `prerollMs` | 400 | frames before the gate opened are ring-buffered and sent first, so the triggering word isn't clipped |
| `hangoverMs` | 900 | must exceed `endpointing=300` or DG never sees a pause and never emits `speech_final` |
| `openDb` / `closeDb` | +10 / +6 over floor | hysteresis, so a soft syllable doesn't chatter the gate |
| `minSpeechDb` | −55 | absolute floor: a very quiet room must not open the gate on fan noise |

On gate close the client sends `Finalize` (flushes DG's buffer; the response carries
`from_finalize: true`) because the trailing silence DG's endpointer would normally
wait for has been cut. False triggers cost preroll+hangover (~1.3s) of billed audio,
which is the deliberate bias — clipping a word is worse than paying for a blip.

**Timestamps:** DG word times count *streamed* audio only, so skipped silence would
pull every later utterance earlier. `useCapture` records `{audio, wall}` for each
burst and maps DG seconds back to wall clock before stamping `tStart`/`tEnd`.

Toggle: **Skip silence** in the mic chevron menu in the control bar (`kelabo-vad`,
default on, synced with the other user settings). Off = stream every frame, the pre-VAD behavior.

**Modes:**
- **Per-user capture** (remote, one mic per person): clean single-speaker audio.
  Diarization not strictly needed; `speaker` = the participant identity (Gateway
  stamps it). Still safe to leave diarization on.
- **Room capture** (one mic, many speakers): diarization on; each word carries a
  Deepgram `speaker` number → mapped to labels `A/B/C…` used as `speaker`.

---

## 4. Utterance production

Deepgram returns `Results` messages with word-level `speaker` numbers.

- **Grouping:** consecutive words with the same `speaker` form a segment
  (`segmentWords` in `spa/src/transcript/deepgram.js`).
- **Finalization:** only `is_final` results become durable `Utterance`s; interim
  results render live in the UI (unless "Final only") and are **not** sent to the
  Gateway.
- **Emit:** for each finalized segment, build an `Utterance`:
  ```js
  { kelaboId, clientId, speaker, text, tStart, tEnd, isFinal:true }
  ```
  and POST it to the Gateway `/caption` endpoint. `speaker` = diarization label
  (room) — the Gateway may override with the cookie identity in per-user mode. See
  [10-data-contracts.md](../10-data-contracts.md).

---

## 5. Diarization caveats (documented, not bugs)

- Streaming diarization is **provisional**: early labels can shift as the model
  accumulates voice context (~10–30s per speaker). Only finals are trusted; the UI's
  "Final only" toggle hides the flicker (carried over from the prototype).
- Room mode with cross-talk reduces accuracy; per-user capture is preferred where
  possible (clean audio, identity from cookie).
- Speaker labels are kelabo-local (`A/B/C`), not identities; naming is a later
  feature.

---

## 6. Failure handling

| Failure | Behavior |
|---------|----------|
| token mint fails | SPA shows `stt_unavailable`; retry with backoff |
| DG socket closes | reconnect up to N times with a fresh token; show `reconnecting` |
| mic denied | `mic_denied` banner; user can still watch the board |
| insecure context | app-wide banner (must use https/localhost) — a prototype-era lesson |
| silence | KeepAlive prevents DG idle-close (~10s) |

---

## 7. Cost controls

- Billing follows the audio streamed, so the **VAD gate** (§3.1) is the primary
  control: a participant who speaks a fifth of a kelabo streams roughly a fifth of
  it, and the socket idles on `KeepAlive` (free) in between.
- **Mute closes the socket** entirely.
- **Mute when tab is hidden** (`kelabo-mute-hidden`, opt-in, synced) does the
  same on every tab switch, and unmutes on return — but only ever undoes its own
  mute, never one the participant set by hand. See
  `spa/src/capture/useHiddenMute.js`.
- Only finalized utterances leave the browser (no server audio cost at all).
- Token TTL short; usage attributable per participant/kelabo.

---

## 8. Interfaces summary

| Peer | Direction | Transport | Contract |
|------|-----------|-----------|----------|
| REST API | in | HTTPS `POST /kelabos/:id/stt-token` | §2 |
| Deepgram | out | WSS direct | DG streaming API |
| Gateway | out | HTTPS `POST /caption` (finals only) | `Utterance` |

---

## 9. Swap-ability

STT is behind a conceptual `SttProvider` boundary (token mint + capture params). A
self-hoster could later swap Deepgram for local Whisper/`diart`; the `Utterance`
contract downstream is unchanged.
