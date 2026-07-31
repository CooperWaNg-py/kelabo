# Component: Rig (prepackaged developer mode)

> **This is one way in, not the interface.** The interface between Kelabo and a
> developer's coding agent is
> [`16-agent-bridge.md`](./16-agent-bridge.md) — read that first. This document
> covers the **Rig**: a container that packages opencode, the bridge, repo
> checkouts and credentials for someone who does not want to configure a coding
> agent themselves.
>
> A developer who already runs opencode or Claude Code does not need any of this.
> They pair once with `kelabo login`, register the bridge as an MCP server in
> **their own** config, and keep their own model, MCP servers and permissions.

The Rig runs on the **developer's own machine** (Docker), not in the cloud. The
kelabo's transcript reaches a local **opencode** agent that can search the
developer's private codebase and local MCP servers; the agent posts back to the
kelabo board with `kelabo_post`. **The code never leaves the laptop.**

```
Cloud Gateway ──WSS /rig──► kelabo-mcp ──stdio MCP──► opencode serve :4096
 (transcript down,          (spawned BY opencode        (kelabo-bot agent,
  contributions up,          as an MCP server)           plugins, commands,
  lifecycle)                        ▲                    dev's repos + MCP)
                        loopback :4190 (/kstart handover)
```

> **The bridge is not a supervised daemon.** It is an MCP server opencode spawns
> over stdio, so its lifetime is the opencode session's lifetime. That is the
> point: one agent, one folder, one kelabo. Run as a daemon it would have a
> lifetime of its own and no session to inject into.

> **No HTTP/SSE reverse-proxy.** The tunnel carries transcript down and
> contributions up, plus lifecycle. There is no browser-facing opencode surface.
> (ARCHITECTURE §15.10.)

---

## 1. Rig — the developer's opencode host

**Rig = a container** running `opencode serve` under supervisord, checked out
against the developer's repos, authenticated as the developer, exposing **no
inbound port** (only the bridge dials out).

### 1.1 opencode server
- `opencode serve --hostname 127.0.0.1 --port 4096` (UI + JSON + SSE on one port).
- `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true` — enables the main-agent →
  `Task(background:true)` sub-agent pattern. **Not optional, and it fails
  silently.** The flag is undocumented and off by default; with it off,
  `background` is simply absent from the task tool's schema, so the argument is
  dropped on the way to the tool call with no error anywhere. The subagent then
  runs in the *foreground*, blocking the session — and therefore transcript
  delivery — for its entire duration. Set on the supervisord environment in
  `rig/bootstrap.js`. A developer running their own opencode has to set it
  themselves, which is why `/kstart` checks for it (§1.3).
- Base `opencode.json` generated per Rig, including the bridge as an MCP server:
  ```jsonc
  { "$schema": "https://opencode.ai/config.json",
    "autoshare": false, "default_agent": "kelabo-bot",
    "permission": { "skill": { "*": "allow" } },
    "mcp": {
      "kelabo": { "type": "local",
                  "command": ["node", "/opt/kelabo/connector/src/cli.js", "run"],
                  "environment": { "KELABO_RUNTIME": "opencode", "…": "…" } } } }
  ```
- Model auth handed off at runtime via `PUT /auth/:providerID` (payload
  `{type:'api', key}`), **not** stored in `opencode.json`.

> Provisioning a model credential and importing the host's MCP servers is a **Rig
> convenience**, and explicitly outside the agent interface. The bridge itself
> never reads or writes either. That is what makes "your agent's LLM and MCP
> configuration is yours" true for everyone who is not using the Rig.

### 1.2 The `kelabo-bot` agent
Installed as an opencode agent template (`<configDir>/agent/kelabo-bot.md`).
Also a Rig convenience: a developer running their own opencode gets the same
persona from the bridge's MCP `instructions`, and **their own** permission
settings apply rather than this frontmatter.

- **Silence-first**: no output unless directly addressed. This is the dev-mode
  trigger, and it runs **in opencode, not on the server**.
- **Transcript in:** `<kelabo-transcript untrusted="true">` batches (docs 16 §3).
- **Board out:** `kelabo_post`. Not `[LLM_CON]` — see docs 16 §2.A for why a text
  marker cannot survive a shared interactive session.
- **Sub-agents:** `Task(background:true)`; results return as `<task>` messages,
  as a separate turn, later. Requires the flag in §1.1.
- **While it works:** `kelabo_working` opens a board card before the answer
  exists, and `kelabo_post` with that card reference turns it into the answer
  (docs 16 §2.D).
- **Minutes:** `kelabo_minutes`, when Kelabo asks.
- **Permissions (frontmatter):** `read/glob/grep/list/webfetch/websearch/task/
  skill/todowrite: allow`; `bash: deny`, `edit: deny`.

### 1.3 Slash commands and the handover plugin

| Command | Purpose | Bridge call |
|---------|---------|-------------|
| `/kstart` | hand this session's id and server URL to the bridge | `POST 127.0.0.1:4190/session {sessionId, baseUrl}` |
| `/kend` | release the session | `POST 127.0.0.1:4190/session {sessionId: ""}` |

`/kstart` is a **handover, not a join**. Joining is `kelabo_join`, which the agent
calls. The plugin exists because the bridge is a separate process and cannot
discover either value on its own: a plugin hook is the only place the current
session id is available, and `ctx.serverUrl` the only place the instance's own
server URL is. Each bridge publishes its loopback port in
`~/.kelabo/bridge-<its opencode pid>.json`, so N sessions on one laptop cannot
misroute one another's handover.

`--port` does **not** default to a random port; it defaults to `0`, meaning
opencode serves nothing over HTTP at all. That is the failure this whole handshake
exists to detect, because it is invisible from the kelabo: tools go over the
tunnel and keep working, and only transcript — which needs HTTP — silently never
arrives.

The result is reported with `POST /tui/show-toast`. Pushing a text part onto the
hook's `output` does not work: that argument is typed `Part[]`, whose members
require `id`, `sessionID` and `messageID`, and opencode abandons the whole command
silently when given a `{type,text}` literal.

### 1.4 Rig setup (two-phase)
- **Phase 1 (host, once, `make -f rig/Makefile rig-setup`, from the repo root):** interactive; "copy, never mount" —
  copies host assets into docker volumes, discovers repo/MCP config, and runs the
  **device-code pairing flow** (docs 16 §6) so the container holds an agent token
  rather than a browser session. Produces `rig-profile.json`.
- **Phase 2 (in-container boot, `bootstrap.js`):** read the profile, resolve
  credentials, check out repos into `/workspace`, write `opencode.json` (including
  the `mcp.kelabo` entry), install command/plugin/agent files, write
  `/run/kelabo-agent.json`, then `supervisord` launches `opencode serve`.

> **The plugin and the slash commands are not Rig assets.** They come from
> `connector/` — `src/plugin/opencode.js` and `commands/*.md`, the same files the
> npm package ships (docs 17 §7). `rig/templates/` holds only `agent/kelabo-bot.md`.
> They *were* duplicated here, and the copies drifted: the Rig's plugin lost the
> 5-second abort on the handover fetch, which is exactly the guard whose absence
> turns `/kstart` into silence with no error anywhere.
>
> Commands install to `<configDir>/commands/` — **plural**. This wrote `command/`,
> which opencode does not scan, so `/kstart` and `/kend` did not exist in the Rig.

### 1.5 `rig-profile.json`
```jsonc
{ "version": 1,
  "hostEmail": "dev@company.com",
  "portalUrl": "https://kelabo.example.com",
  "apiBaseUrl": "https://kelabo.example.com/api",
  "gatewayUrl": "wss://gw.kelabo.example.com",
  "repos": [ { "url": "https://bitbucket.org/org/repo.git", "branch": "main" } ],
  "credentials": {
    "modelProvider": { "provider": "anthropic", "apiKey|secretName": "…" },
    "bitbucket": { "appPassword|secretName": "…" },
    "jira": { "secretName": "…" }, "confluence": { "secretName": "…" }
  },
  "auth": { "agentToken": "…" },
  "opencodeConfig": { /* deep-merged onto base */ },
  "mcp": [ /* imported from host opencode.json; absolute-path local servers dropped */ ]
}
```

---

## 2. The bridge inside the Rig

The Rig does not have a Connector daemon any more. It ships `@kelabome/agents`, and
opencode spawns it as an MCP server over stdio. Its design, protocol, tool surface
and security model are [`16-agent-bridge.md`](./16-agent-bridge.md); nothing about
it is Rig-specific.

What *is* Rig-specific: `bootstrap.js` writes `/run/kelabo-agent.json` from the
paired token in the profile, so a non-technical user never runs `kelabo login`
inside the container themselves.

---

## 3. Data flow

**Transcript in:** Gateway `transcript` frame → the bridge's queue coalesces →
`<kelabo-transcript>` envelope → `POST /session/:id/prompt_async` on the handed-over
session.

**Contribution out:** the agent calls `kelabo_post` → `contribution` frame up →
Gateway SSE hub → every browser.

*(No collaboration-surface flow — the opencode-in-browser tab/proxy is not built.)*

---

## 4. Interfaces summary

| Peer | Direction | Transport | Contract |
|------|-----------|-----------|----------|
| Gateway | both | WSS `/rig`, KAP frames | [16-agent-bridge.md](./16-agent-bridge.md) §2.A |
| opencode | in | stdio MCP (opencode spawns the bridge) | [16](./16-agent-bridge.md) §2.B |
| opencode | out | loopback HTTP :4096 (`prompt_async`, `/event`) | [16](./16-agent-bridge.md) §4.1 |
| opencode plugin | in | loopback HTTP :4190 (`/kstart` handover) | §1.3 |
| Secrets Manager / host assets | in | Rig setup + bootstrap | §1.4 |

---

## 5. Security properties

Full model: [`16-agent-bridge.md`](./16-agent-bridge.md) §6. Rig-specific points:

- Private source and credentials never leave the laptop. Only transcript in and
  structured contributions out cross the tunnel, and the browser cannot reach the
  local opencode at all.
- No inbound port on the Rig; the bridge dials out only.
- The tunnel is authenticated at `register` with a **revocable agent token**
  (`aud: kelabo-agent`), checked against its revocation row once per connection.
  Per-frame trust is the connection binding.
- **The Rig is the one place Kelabo still constrains the agent.** `bash: deny` and
  `edit: deny` in the `kelabo-bot` frontmatter hold here because the Rig writes
  the config. For a developer running their own agent they do not, and the
  compensating control is that every permission prompt appears in their own
  terminal. Do not read the Rig's defaults as a guarantee about dev mode
  generally.
- **Captions are untrusted input.** Any participant — including a name-only guest
  — can speak or type text that reaches an agent with read access to the
  developer's repositories. Every batch is wrapped in
  `<kelabo-transcript untrusted="true">` and the persona refuses instructions
  embedded in it. Recommended, still not implemented: a host allow-list or
  registered-only joins for kelabos with an agent attached.
