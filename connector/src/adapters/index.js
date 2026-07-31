// Contract C, dispatched (docs 16 §2.C).
//
// One package ships every adapter, and which one runs is decided when the bridge
// starts, from `KELABO_RUNTIME` — the variable `kelabo setup` writes into the MCP
// entry it creates. The runtime that spawned the bridge is therefore the runtime
// that tells it what it is; the bridge never sniffs or guesses.
//
// This used to be a build-time resolution with one package per runtime. That is
// gone: it forced two npm packages and two `kelabo` binaries that could not be
// installed side by side, to save shipping ~2 KB of the other adapter. The cost
// was in the wrong place.
//
// A wrong answer here is not a crash. It is the wrong injection path, and
// injection failures are silent on both runtimes — so `startBridge` refuses an
// unknown runtime rather than falling back to a default that would look like it
// was working.
import { createOpencodeAdapter, CAPABILITIES as OPENCODE_CAPS, INSTRUCTIONS as OPENCODE_INSTRUCTIONS } from "./opencode.js";
import {
  createClaudeCodeAdapter,
  CAPABILITIES as CLAUDE_CAPS,
  INSTRUCTIONS as CLAUDE_INSTRUCTIONS,
} from "./claudeCode.js";
import { RUNTIME_IDS } from "../runtimes.js";

const ADAPTERS = {
  opencode: {
    create: createOpencodeAdapter,
    capabilities: OPENCODE_CAPS,
    instructions: OPENCODE_INSTRUCTIONS,
  },
  "claude-code": {
    create: createClaudeCodeAdapter,
    capabilities: CLAUDE_CAPS,
    instructions: CLAUDE_INSTRUCTIONS,
  },
};

/**
 * @param {string} id  a key of RUNTIMES
 * @returns {{create: Function, capabilities: object, instructions: string}}
 */
export function adapterFor(id) {
  const found = ADAPTERS[id];
  if (!found) {
    throw new Error(
      `KELABO_RUNTIME is "${id}", which is not a runtime this bridge knows (${RUNTIME_IDS.join(", ")}). ` +
        "Re-run `kelabo setup` for the runtime that spawns this server."
    );
  }
  return found;
}

/** Every registered runtime has an adapter and vice versa. Asserted in
 *  `test/channel.mjs`, because a row added to the registry without an adapter
 *  would offer the developer a `kelabo setup --runtime x` that wires a bridge
 *  which then refuses to start. */
export const ADAPTER_IDS = Object.keys(ADAPTERS);
