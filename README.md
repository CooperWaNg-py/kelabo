# Kelabo

Meetings and calls for one organisation — live rooms with transcription, an
AI assistant that answers into the meeting, minutes written for you, and a
searchable archive of everything your team decided. Each live room is a
**kelabo** — not quite a call, not quite a meeting, its own kind — and that is
the word the app, the code and the URLs use. Open source: self-host it
in your own AWS account.

- **Self-hosting guide:** [docs/self-hosting.md](docs/self-hosting.md) — from
  an empty AWS account to `kelabo.mycompany.com`.
- **Architecture:** [ARCHITECTURE.md](ARCHITECTURE.md), with per-component
  docs under [docs/](docs/).
- **Bring your own coding agent:** `npm i -g @kelabome/agents` attaches your
  opencode or Claude Code session to a kelabo — see
  [connector/README.md](connector/README.md).
- **Everything is a make target:** run `make help`.

## The five-minute tour

```bash
make bootstrap        # npm install in every package
make test             # every package's test suite, no AWS needed
```

Deploying for real needs an AWS account, a Route 53 domain, and API keys for
Deepgram (transcription) and DeepSeek (assistant/minutes) — the
[self-hosting guide](docs/self-hosting.md) is the path.

## License

MIT.
