// `kelabo login` — device-code pairing (docs 16 §6).
//
// A one-off command, not part of the long-running bridge: the bridge is spawned
// by the coding agent over stdio and has nowhere to print a code or wait for a
// human. Pairing happens once, at a terminal, and leaves a credential file
// behind.
//
// The device-code shape rather than a copy-pasted secret means the token is
// never displayed, never lands in shell history, and the approval is an
// authenticated action taken by the person whose identity is being delegated.
import { createInterface } from "node:readline/promises";
import { writeCredential, CREDENTIAL_PATH } from "./config.js";
import { createApi } from "./api.js";

export async function login({
  apiBaseUrl,
  runtime = "opencode",
  label = "",
  out = process.stderr,
  fetchImpl = fetch,
  openBrowser = tryOpen,
} = {}) {
  if (!apiBaseUrl) throw new Error("Set KELABO_API_BASE_URL, e.g. https://kelabo.example.com/api");
  const api = createApi({ apiBaseUrl, getToken: async () => "", fetchImpl });

  const start = await api.requestDeviceCode({ runtime, label });
  out.write(
    [
      "",
      `  Open  ${start.verificationUri}`,
      `  Code  ${start.userCode}`,
      "",
      "  Waiting for approval… (Ctrl-C to cancel)",
      "",
    ].join("\n")
  );
  await openBrowser(start.verificationUri);

  const result = await api.awaitApproval(start.deviceCode, {
    onTick: (secondsLeft) => {
      if (secondsLeft % 60 === 0 && secondsLeft > 0) out.write(`  ${secondsLeft}s left…\n`);
    },
  });

  const path = writeCredential({
    agentToken: result.agentToken,
    identity: result.identity,
    tenantId: result.tenantId,
    gatewayBaseUrl: result.gatewayBaseUrl,
    apiBaseUrl,
    label: label || runtime,
    expiresAt: result.expiresAt,
    pairedAt: Date.now(),
  });
  out.write(`\n  Paired as ${result.identity}. Credential written to ${path}\n\n`);
  return { identity: result.identity, path };
}

async function tryOpen(url) {
  // Best effort. A headless box or a locked-down desktop is normal, and the URL
  // is already printed, so a failure here is not worth reporting.
  try {
    const { spawn } = await import("node:child_process");
    const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
    spawn(cmd, [url], { stdio: "ignore", detached: true }).unref();
  } catch {}
}

/** Interactive prompt used when `kelabo login` is run without --api.
 *
 *  Refuses outright when there is no terminal to ask in. `readline.question()`
 *  against a closed stdin never resolves — node then drains its event loop and
 *  **exits 0**, so a `make install-…-connector` printed half its output, paired
 *  nothing, said nothing, and reported success. A prompt that cannot be answered
 *  has to fail loudly rather than end the process mid-sentence. */
export async function promptApiBase(defaultUrl = "") {
  if (!process.stdin.isTTY) {
    throw new Error(
      "no terminal to ask for the Kelabo API base URL. Pass --api https://…/api, or set KELABO_API_BASE_URL."
    );
  }
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const answer = await rl.question(`Kelabo API base URL${defaultUrl ? ` [${defaultUrl}]` : ""}: `);
  rl.close();
  return answer.trim() || defaultUrl;
}

export { CREDENTIAL_PATH };
