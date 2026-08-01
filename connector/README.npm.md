# @kelabome/agents

Attach **your own** coding agent — [opencode](https://opencode.ai) or Claude Code
— to a [Kelabo](https://github.com/kelabome/kelabo) kelabo.

Kelabo supplies a token and a channel. Your model, your MCP servers, your
permissions and your working directory stay entirely yours, and this package
never reads or writes any of them.

```bash
npm i -g @kelabome/agents
kelabo setup            # asks which runtime, or --runtime <id> / --all
kelabo opencode         # …or `kelabo claude` — starts it with the right flags
```

One package, one `kelabo` command, every runtime. `setup` edits **one config
file per runtime** and records exactly what it wrote, so `uninstall` can put it
back. One pairing serves all of them: the token identifies you, not the agent.

| Runtime | `setup` writes | Then start it as |
|---|---|---|
| opencode | 3 keys in `opencode.json` — `plugin`, `mcp.kelabo`, `command.kstart`/`kend` | `kelabo opencode`, then `/kstart` |
| Claude Code | 1 key in `~/.claude.json` — `mcpServers.kelabo` | `kelabo claude` |

**Start them with `kelabo`, not by hand.** Both runtimes need a launch argument
that is easy to forget and silent when omitted — the agent joins, posts and reads
the board perfectly, and never hears a word of the kelabo. `kelabo opencode`
picks a free port and turns on background subagents (off by default, and without
them every subagent blocks the session, so the agent goes deaf for its whole
duration). `kelabo claude` passes the channel flag. Both echo the full command
they ran, shell-quoted, so you can always see and reproduce it.

### Passing your own arguments

Anything after `--` goes straight to the coding agent, untouched:

```bash
kelabo opencode -- ~/src/thing --model anthropic/claude-sonnet-4-5
kelabo claude   -- --resume --model opus
kelabo claude   -- -p "what changed in the gateway?"
```

Short form works too — `kelabo claude -p "…"` — but `--` is the one that stays
correct when your flag and ours share a name. Everything after it is passed
verbatim and never interpreted, so `kelabo opencode -- --dry-run` is *opencode's*
`--dry-run`.

`--dry-run` before the `--` is ours: it prints the command it would run and starts
nothing.

```bash
$ kelabo opencode --dry-run
  → OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true \
    OPENCODE_BASE_URL=http://127.0.0.1:40411 opencode --port 40411
```

**If you pass `--port` yourself, `kelabo` steps out of the way** rather than
adding its own — opencode binds a *random* port when `--port` appears twice, so
passing both would give you neither. The exported base URL follows yours.

Both can be installed and wired at the same time; they share nothing but the
pairing.

## Commands

| Command | What it does |
|---|---|
| `kelabo opencode [-- …]` | Start opencode: free port, background subagents on |
| `kelabo claude [-- …]` | Start Claude Code with the Kelabo channel enabled |
| `kelabo setup` | Wire a runtime (or `--all`), then pair |
| `kelabo login` | Pair (or re-pair) this machine; asks for the endpoint, Enter keeps the current one |
| `kelabo status` | What is paired, wired and running, per runtime |
| `kelabo uninstall` | Remove the wiring; `--purge` also drops the credential |
| `kelabo reset` | `uninstall --purge`, then `setup` |
| `kelabo runtimes` | List the runtimes this build knows |
| `kelabo run` | The MCP server itself. A runtime spawns this; not for humans |

Flags: `--runtime <id>` (comma-separated for several), `--all`, `--api URL`,
`--config PATH`, `--project`, `--no-pair`, `--dry-run`, `--plugin-spec S`.
For `opencode` and `claude`, everything after `--` is the coding agent's.

With one coding agent on the machine, `setup` uses it without asking. With
several and a terminal, it asks. With several and no terminal — a Makefile, CI —
it refuses and names the flag, rather than picking one and editing a config you
were not thinking about.

## opencode: `--port` is not optional

`--port` defaults to `0`, which means opencode serves nothing over HTTP — and
the HTTP server is how transcript gets into your session. Without it the agent
still joins, posts and reads the board (those all go over the tunnel to Kelabo)
and simply never hears anything. `/kstart` checks and tells you; so does
`kelabo status`.

## Claude Code: the channel flag is not optional

Claude Code has no API for pushing a turn into a running session. What it has is
**channels**: an MCP server that declares the `claude/channel` capability gets a
notification listener registered, and anything it emits as
`notifications/claude/channel` lands in the live session's context as

```
<channel source="kelabo" kelabo_id="…" speakers="…">
<kelabo-transcript kelabo="…" untrusted="true">
[10:04:12] Alice: what's our retry policy on the gateway?
</kelabo-transcript>
</channel>
```

So the MCP server *is* the injection path — which is why there is no `/kstart`
on this runtime: the channel already targets the session that spawned it.

`--dangerously-load-development-channels server:kelabo` is what registers the
listener. Custom channels are a research preview and are **off** without it, and
a notification whose listener was never registered is dropped with no error at
either end. The bridge therefore checks its own parent's command line at startup
and, when it can see the flag is missing, says so through `kelabo_join` rather
than letting you find out during a kelabo.

Two more preconditions, silent in the same way:

- **First-party auth only.** Channels are unavailable on Bedrock, Vertex and
  Foundry. If `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`,
  `CLAUDE_CODE_USE_FOUNDRY`, `CLAUDE_CODE_USE_ANTHROPIC_AWS`,
  `CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD` or `CLAUDE_CODE_USE_MANTLE` is set,
  no transcript can arrive. `kelabo status` checks this one.
- **Org policy.** On claude.ai Team and Enterprise, channels are off until an
  administrator sets `channelsEnabled: true` in managed settings.

## Tools the agent gets

Identical on every runtime — this is the surface a third-party adapter would be
written against.

| Tool | Behaviour |
|---|---|
| `kelabo_join` | Attach to a kelabo. With no argument, lists what you can join — live and scheduled. Returns the briefing |
| `kelabo_working` | Put a card on the board saying something is being looked into, before there is an answer |
| `kelabo_post` | Post to the kelabo's shared board — the only thing participants see |
| `kelabo_info` | What this session is attached to |
| `kelabo_board` | Read the board, including posts from an earlier prep session |
| `kelabo_minutes` | Submit minutes, when Kelabo asks |
| `kelabo_leave` | Detach |

There is deliberately no `kelabo_transcript`. Transcript is pushed, never polled.

## Uninstalling

`setup` records exactly what it wrote, per runtime, so `uninstall` removes those
keys and nothing else — and leaves anything you have edited since alone, saying
so rather than reverting your change.

```bash
kelabo uninstall --runtime opencode    # one runtime; the other stays wired
kelabo uninstall --all --purge         # everything, credential included
npm rm -g @kelabome/agents
```

`--purge` deletes the credential in `~/.kelabo/`. It refuses while another
runtime is still wired, because they share it. It cannot revoke the token
server-side — that needs a signed-in browser — so it prints the Settings URL.

## Environment

| Variable | Default | Purpose |
|---|---|---|
| `KELABO_RUNTIME` | written by `setup` | Which adapter `kelabo run` uses. Set in the MCP entry, not by you |
| `KELABO_AGENT_FILE` | `~/.kelabo/agent.json` | Credential location, shared by every runtime |
| `KELABO_GATEWAY_URL` | from the credential | Override the Gateway |
| `KELABO_API_BASE_URL` | from the credential | Override the control plane |
| `KELABO_MAX_BACKLOG` | `60` | Transcript messages held while the agent is busy |
| `KELABO_CONTROL_PORT` | `4190` | Loopback listener for the opencode `/kstart` handover |
| `OPENCODE_BASE_URL` | — | Override the opencode server URL `/kstart` discovers |
| `CLAUDE_CONFIG_DIR` | `~` | Where `.claude.json` lives; `setup` follows it |

## Security

Transcript is delivered inside a `<kelabo-transcript untrusted="true">` envelope:
kelabos can contain guests who joined by link, and what they say is data, not
instructions. Kelabo never auto-approves a tool call — every permission prompt
appears in your own terminal, as it would otherwise.

Claude Code's `claude/channel/permission` capability, which relays tool-approval
prompts out through the channel so they can be answered remotely, is
**deliberately not declared**. The far end of this channel is a kelabo room that
may contain link-joined guests, and anyone who can reply through a channel could
then approve tool use in your session. Kelabo declines the capability rather than
try to gate it.

MIT licensed.
