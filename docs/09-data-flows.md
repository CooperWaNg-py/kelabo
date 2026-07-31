# 09 — Data Flows

Sequence diagrams for every key flow. Components: **SPA**, **REST** (Lambda),
**Gateway** (ECS, hosts the server-agent worker), **agent bridge** + the developer's own coding agent (dev
laptop), **Deepgram**, **DynamoDB/S3**, **SES**, social **OIDC** providers.

Legend: `──▶` request, `◀──` response/event, `···` async/background.

---

## 1. OTP login

```
SPA            REST            SES         DynamoDB
 │  POST /auth/otp/request {email}          │
 │───────────────▶│ validate domain         │
 │                │ put OTP#<email>(ttl) ───▶│
 │                │ SendEmail ──▶ SES        │
 │◀───────────────│ 200 {resendInSeconds}    │
 │  (user reads code)                        │
 │  POST /auth/otp/verify {email,code}       │
 │───────────────▶│ get OTP#<email> ◀────────│
 │                │ check code/attempts       │
 │                │ delete OTP; upsert USER ─▶│
 │                │ establishSession: mint session JWT
 │                │   + put RT#<id> (refresh) ▶│
 │◀───────────────│ 200 {identity} +Set-Cookie ×2 (session+refresh)│
 │  navigate Home                            │
```
Failure branches: `domain_not_allowed` (403 at request), `invalid_code`/
`code_expired`/`too_many_attempts` (at verify), `rate_limited` (429).

## 1a. Social login (Google/Apple)

```
SPA              REST                 Provider(OIDC)      DynamoDB
 │ click "Continue with Google"        │                  │
 │ GET /auth/oidc/google/start ───────▶│ PKCE+state cookie │
 │◀ 302 to provider ───────────────────│                  │
 │ ───────────────────────────────────▶│ user consents     │
 │◀ 302 /auth/oidc/google/callback?code │                  │
 │ ───────────────────────────────────▶│ exchange code ───▶│ verify id_token
 │                REST: verified email; ENFORCE domain allow-list
 │                upsert USER; establishSession (+RT) ─────▶│
 │◀ 302 / +Set-Cookie ×2                │                  │
```
Disallowed domain → `domain_not_allowed` page (e.g. a random gmail on a
`@company.com` self-host).

## 1b. Silent refresh (no re-login every open)

```
SPA                         REST                    DynamoDB
 │ app load → GET /me                                │
 │───────────────▶│ 401 (session expired)            │
 │ POST /auth/refresh (kelabo_refresh cookie)         │
 │───────────────▶│ get RT#<id> (hash) ◀─────────────│
 │                │ valid? rotate: new RT, revoke old ▶│
 │                │ mint fresh session JWT            │
 │◀ 200 {identity} +Set-Cookie ×2                     │
 │ continue as logged-in                              │
 │ (reused/rotated token ⇒ revoke chain ⇒ 401 → Login)│
```
A background timer refreshes just before the ~1h session expiry; users re-auth only
~monthly (refresh expiry) or after logout.

---

## 2. Create kelabo (host)

```
SPA            REST            DynamoDB
 │ POST /kelabos {title}        │
 │──────────────▶│ conditional put META (guard activeHost) ─▶│
 │◀──────────────│ 200 {kelaboId,joinUrl,status:active}     │
 │ show share-link dialog; navigate /m/:id                    │
```
A host may run several live kelabos at once — a second create is a genuinely
new kelabo (the one-active-per-host `already_active` bounce was removed
2026-07-31).

---

## 3. Join (guest or registered)

```
SPA               REST              DynamoDB
 │ GET /kelabos/:id (public)        │
 │────────────────▶│ get META ◀──────│
 │◀────────────────│ {title,status}   │
 │ user picks name+mode              │
 │ POST /kelabos/:id/join {name,mode}│   mode ∈ {audio-board, board-only}
 │────────────────▶│ verify active    │
 │                 │ identity: session? else guest:<uuid>
 │                 │ append participants[] ─▶│
 │                 │ mint kelabo_participant  │
 │◀────────────────│ 200 {gatewayBaseUrl} +Cookie│
 │ navigate /m/:id                                             │
 │ save name → localStorage                                    │
```
*(No opencode-tab mode.)*

## 3a. Board backfill on entry (late-comer)

```
SPA                         REST                 Gateway
 │ enter /m/:id                                   │
 │ GET /kelabos/:id/board?limit=50 ─▶│ read CONTRIB# │
 │◀ {contributions, nextSince}        │            │
 │ render prior AI messages; note lastAt          │
 │ open EventSource /caption/replies?kelaboId ──▶│ live tail
 │◀ contribution (at > lastAt) ───────────────────│
 │ (de-dupe by at across handoff)                 │
```
A person joining at minute 20 sees earlier AI posts, then live ones.

---

## 4. Capture → board — SERVER-AGENT mode (no developer)

```
SPA          REST         Deepgram      Gateway       Agent        DynamoDB
 │ POST /kelabos/:id/stt-token          │             │            │
 │──────────▶│ mint temp token ◀─Secrets │             │            │
 │◀──────────│ {token,params}            │             │            │
 │ open WSS ─────────────▶│ (audio, direct)            │            │
 │ mic PCM ··············▶│                            │            │
 │◀── diarized results ───│                            │            │
 │ (interim → UI only)                                  │            │
 │ final Utterance                                      │            │
 │ POST /caption {kelaboId,text,isFinal} ▶│           │            │
 │                        Gateway: speaker from cookie  │            │
 │                        append UTT ───────────────────────────────▶│
 │                        hand to IN-TASK agent worker ▶│            │
 │                                    (same ECS task)   │ gate INFO_GAP?│
 │                                          │ main→sub-agents (web/MCP)│
 │                                          │  (long search OK, no 15m cap)
 │                                          │ synthesize Contribution  │
 │                        ◀ Contribution (local call) ·│ ([LLM_CON])     │
 │                        append CONTRIB ───────────────────────────▶│
 │◀ SSE contribution ─────│ fan-out to subscribers (partials stream)  │
 │ render on board; SW notify if unfocused                            │
```
Notes: the agent runs **in the Gateway ECS task** (worker thread) — no cross-service
hop, no 15-min limit, partials stream to the board. Only `[LLM_CON]`
contributions are fanned; the cheap gate keeps the agent idle on `NONE`; rolling
window kept in the worker (rehydrated from DynamoDB on restart).

---

## 5. Capture → board — DEVELOPER mode (an agent is attending)

```
SPA        Gateway        kelabo-mcp        the developer's agent
 │ POST /caption {text,isFinal} ▶│           │                     │
 │            speaker from cookie │           │                     │
 │            transcript frame ──▶│ queue.push│                     │
 │                                │ (coalesce while the agent is    │
 │                                │  busy — one batch in flight)    │
 │                                │ <kelabo-transcript> ───────────▶│
 │                                │           (silence-first; the   │
 │                                │            developer approves   │
 │                                │            each tool call)      │
 │                                │◀ kelabo_post tool call ─────────│
 │            contribution ◀──────│                                 │
 │◀ SSE contribution ─────────────│ (Gateway SSE hub)               │
 │ render "from local repo" chip                                    │
```

The trigger runs **inside the developer's agent**, not on the server. Code never
leaves the laptop; only transcript in and structured contributions out cross the
tunnel. Injection is the one runtime-specific step: `prompt_async` on opencode, a
`claude/channel` notification on Claude Code (docs 16 §4).

---

## 5a. Preparing for a kelabo that has not started

```
agent            kelabo-mcp        Gateway            DynamoDB
 │ kelabo_join(scheduledId) ▶│      │                  │
 │                           │ attach ────────────────▶│ status = "scheduled"
 │                           │      │ → prepByKelabo  │ (NOT tunnelByKelabo)
 │                           │◀ briefing (agenda, invitees, RSVPs)
 │◀ <kelabo-briefing> (silent, costs no turn)
 │ … investigates the local repo …
 │ kelabo_post(finding) ────▶│ contribution ─────────▶│ put CONTRIB# ▶│
                                     (no SSE subscribers yet — it just persists)
```

`caption.js` reads only `tunnelByKelabo`, so a preparing agent **cannot** receive
transcript, even once the kelabo goes live. When it starts, nothing happens
automatically: the developer calls `kelabo_join` again to attend, or does not, and
the findings are already at the top of the board either way (docs 16 §5).

---

## 6. Session handover (`/kstart`, opencode only)

```
dev(opencode)   plugin        kelabo-mcp(:4190)   Gateway
 │ types /kstart                │                  │
 │ command.execute.before ─────▶│ POST /session    │
 │        {sessionId, baseUrl}  │                  │
 │◀ push [kelabo-system]{bound} │                  │
 │ model relays one sentence, then calls kelabo_join
 │                              │ attach ─────────▶│ put PROMOTION ▶│
```

A **handover, not a join.** The plugin exists only because the bridge is a separate
process and cannot discover either value on its own: an opencode TUI assigns its
server a random port, and a plugin hook is the only place the session id is
available. Joining is `kelabo_join`, which the agent calls. Claude Code needs no
equivalent — its channel targets the session that spawned the bridge.

---

## 7. Collaboration-surface flow — not built

*(There is no collaboration-surface flow — the opencode-in-browser tab and its
HTTP/SSE proxy are not built. The tunnel carries transcript, contributions and
lifecycle only.)*

---

## 8. Minutes (host requests, any time)

```
SPA           REST              Gateway                  DynamoDB
 │ POST /kelabos/:id/minutes ▶│                         │
 │            (host only)      │ POST /internal/kelabos/:id/minutes
 │                             │────────────────▶│       │
 │                             │                 │ server: summarize via in-task worker
 │                             │                 │ dev: request{kind:"summary",requestId}
 │                             │                 │   ◀ summary{requestId, text}
 │                             │                 │ put MINUTES ─────────────▶│ (hasMinutes=true)
 │◀ 200 {queued}               │                 │       │
 │ (SPA polls record / shows when ready)                  │
```
Minutes are stored, **not** fanned to the board. In dev mode the agent returns
them through `kelabo_minutes`, correlated by `requestId` — a deliberate tool call
rather than a board post the Gateway intercepts, which is how a contribution sent
at the wrong moment used to become the minutes.

---

## 9. Kelabo end + archive

```
SPA        REST        Gateway        agent bridge/AgentWorker  DynamoDB   S3
 │ POST /kelabos/:id/end ▶│           │                    │          │
 │        (host) set status=ended ────────────────────────▶│          │
 │        POST /internal/kelabos/:id/end ▶│               │          │
 │                         │ dev: request{kind:"archive"}; ◀ archive   │
 │                         │      later request{kind:"summary"}; ◀ summary
 │                         │ server: ask in-task agent worker to summarize
 │                         │ build Archive                             │
 │                         │ put history row (+participant-index) ─────▶│
 │                         │ put full JSON ───────────────────────────────▶│
 │                         │ SSE 'ended' to subscribers; drop worker   │
 │◀ 200 {ended}            │ kelabo{event:"ended"} down; socket STAYS  │
 │                         │ open so a late summary still lands        │
 │ show 'ended' overlay + record link (registered)                     │
```

---

## 10. Board reconnect (SSE drop)

```
SPA                    REST                 Gateway
 │ EventSource error (drop)                   │
 │ GET /kelabos/:id/board?since=<lastAt> ▶ backfill gap
 │◀ missed contributions                       │
 │ re-open GET /caption/replies?kelaboId ───▶│ resume live tail
 │◀ contributions                              │
```
Gateway SSE has no replay, so the SPA closes the gap via the REST board endpoint
(`?since=<lastAt>`) before/around re-subscribing.

---

## 11. Tunnel reconnect (agent bridge)

```
kelabo-mcp                     Gateway
 │ ws close (unexpected)         │
 │ backoff ─▶ /rig register{token, agent}
 │◀ registered{agentId}          │
 │ re-send attach{kelaboId} if still bound
 │ (rejected: invalid_token / agent_token_revoked ⇒ stop, no reconnect)
```

Re-sending `attach` is what makes a dropped socket a non-event: the Gateway's
binding is in-process and does not survive a restart either, so without the replay
the developer would have to run `/kstart` again mid-kelabo.

---

## 12. Notification (SW)

```
SPA tab(unfocused)     ServiceWorker        OS
 │ SSE contribution        │                │
 │ postMessage ───────────▶│ showNotification│──▶ tray/banner
 │                         │◀ click          │
 │◀ focus + scroll board ──│                 │
```
Limit: only while a browser tab is open (browser-closed tray would need a
desktop app, which is not built).

---

## 13. Deepgram token refresh (long kelabo)

```
SPA                     REST/Deepgram
 │ token near expiry / socket closed          │
 │ POST /kelabos/:id/stt-token ▶ mint fresh   │
 │◀ {token} ; reopen WSS to Deepgram           │
```
Mute → close socket (stop billing); unmute → fresh token + reopen.
Between utterances the VAD gate stops streaming audio and the socket idles on
`KeepAlive` — billed audio ≈ speech, not kelabo length (06 §3.1).
