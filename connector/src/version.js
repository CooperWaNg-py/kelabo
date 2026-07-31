// The bridge version announced to the Gateway in the `register` frame.
//
// It was a literal `"1.0.0"` next to the frame builder, which meant every
// release since said 1.0.0 — the one field whose entire purpose is telling the
// Gateway which build it is talking to.
//
// Two ways in, because there are two ways to run this code:
//   - published: `build/pack.mjs` replaces `__KELABO_VERSION__` with the version
//     it stamped into the generated package.json, so the bundle carries no I/O.
//   - from source: no define, so fall back to reading connector/package.json.
// The fallback is deliberately never reached in a published bundle; esbuild
// eliminates the branch along with the fs import.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

function fromPackageJson() {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    return JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")).version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export const BRIDGE_VERSION =
  typeof __KELABO_VERSION__ === "string" ? __KELABO_VERSION__ : fromPackageJson();
