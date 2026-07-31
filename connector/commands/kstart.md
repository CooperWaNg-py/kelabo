---
description: Connect this opencode session to the Kelabo bridge
---

This session has just been handed to the Kelabo bridge; a toast reports whether
that worked.

Call `kelabo_join` with no arguments and show the user the kelabos they can
join, as a short list. Do not join one — the user picks.

If the tool returns an error, relay it **verbatim** and stop. It is the only
diagnosis available: it will say whether this session was never bound, whether
opencode is not serving HTTP (start it as `opencode --port 4096`), or whether
the agent is not paired with Kelabo at all.
