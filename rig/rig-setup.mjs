import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rigDir = path.dirname(fileURLToPath(import.meta.url));
const PROFILE_PATH = path.join(rigDir, "rig-profile.json");

const rl = readline.createInterface({ input: stdin, output: stdout });

async function ask(question, def) {
  const suffix = def ? ` [${def}]` : "";
  const answer = (await rl.question(`${question}${suffix}: `)).trim();
  return answer || def || "";
}

async function askYesNo(question, def = false) {
  const answer = (await ask(`${question} (y/n)`, def ? "y" : "n")).toLowerCase();
  return answer === "y" || answer === "yes";
}

function hostMcpImport(candidatePaths) {
  for (const p of candidatePaths) {
    try {
      const raw = JSON.parse(readFileSync(p, "utf8"));
      const mcp = raw.mcp;
      if (!mcp || typeof mcp !== "object") return [];
      return Object.entries(mcp)
        .filter(([, v]) => {
          if (v.type === "local" || v.command) {
            const cmd = v.command?.[0];
            if (cmd && path.isAbsolute(cmd)) return false;
          }
          return true;
        })
        .map(([name, v]) => ({ name, ...v }));
    } catch {
      continue;
    }
  }
  return [];
}

/**
 * Device-code pairing (docs 16 §6). The rig runs it on the host's behalf so a
 * non-technical user never has to run `kelabo login` inside the container.
 *
 * Note the /api prefix: the REST API is served under it on the portal host.
 */
async function pairAgent(apiBaseUrl, label) {
  const post = async (path, body) => {
    const res = await fetch(`${apiBaseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    const parsed = text ? JSON.parse(text) : null;
    if (!res.ok) {
      const err = new Error(parsed?.error || `http_${res.status}`);
      err.code = parsed?.error;
      throw err;
    }
    return parsed;
  };

  const start = await post("/agent/device/code", { runtime: "opencode", label });
  console.log(`\n  Open  ${start.verificationUri}`);
  console.log(`  Code  ${start.userCode}\n`);
  console.log("  Waiting for approval…");

  const deadline = Date.now() + start.expiresInSeconds * 1000;
  while (Date.now() < deadline) {
    try {
      return await post("/agent/device/token", { deviceCode: start.deviceCode });
    } catch (err) {
      // 428 authorization_pending is a real "not yet"; anything else means the
      // code is gone, and polling on would just hide that.
      if (err.code !== "authorization_pending") throw err;
      await new Promise((r) => setTimeout(r, start.intervalSeconds * 1000));
    }
  }
  throw new Error("device_code_expired");
}

const profile = { version: 1 };

console.log("Kelabo Rig setup — writes rig/rig-profile.json (gitignored).\n");

profile.portalUrl = (await ask("Portal URL", "https://kelabo.example.com")).replace(/\/$/, "");
profile.gatewayUrl = (await ask("Gateway WSS URL", "wss://gw.kelabo.example.com")).replace(/\/$/, "");
profile.hostEmail = await ask("Your email (Kelabo account)");

profile.repos = [];
while (await askYesNo("Add a repo to check out in the Rig?", profile.repos.length === 0)) {
  const url = await ask("  Repo git URL");
  if (!url) break;
  const branch = await ask("  Branch", "main");
  profile.repos.push({ url, branch });
}

const provider = await ask("Model provider (opencode provider id)", "anthropic");
profile.credentials = { modelProvider: { provider } };
if (await askYesNo("Store the model API key inline in the profile? (n = use AWS Secrets Manager)", true)) {
  profile.credentials.modelProvider.apiKey = await ask("  Model API key");
} else {
  profile.credentials.modelProvider.secretName = await ask("  Secrets Manager secret name");
  profile.awsRegion = await ask("  AWS region", "ap-southeast-2");
}

for (const svc of ["bitbucket", "jira", "confluence"]) {
  if (await askYesNo(`Add a ${svc} credential (Secrets Manager secret name)?`)) {
    profile.credentials[svc] = { secretName: await ask(`  ${svc} secret name`) };
    if (!profile.awsRegion) profile.awsRegion = await ask("  AWS region", "ap-southeast-2");
  }
}

if (await askYesNo("Import MCP entries from host opencode config?", true)) {
  const hostCfg = path.join(os.homedir(), ".config", "opencode", "opencode.json");
  profile.mcp = hostMcpImport([hostCfg]);
  console.log(`  imported ${profile.mcp.length} MCP entr${profile.mcp.length === 1 ? "y" : "ies"} (host-local absolute-path servers dropped)`);
}

profile.apiBaseUrl = `${profile.portalUrl}/api`;

if (await askYesNo("Pair this rig with your Kelabo account now?", true)) {
  try {
    const result = await pairAgent(profile.apiBaseUrl, `rig (${profile.hostEmail})`);
    profile.auth = { agentToken: result.agentToken };
    profile.hostEmail = result.identity || profile.hostEmail;
    console.log(`  paired as ${result.identity}. Revoke it any time in Settings → Agents.`);
  } catch (err) {
    console.error(`  pairing failed: ${err.message}`);
    console.log("  Re-run rig-setup, or run `kelabo login` inside the container later.");
  }
}

await writeFile(PROFILE_PATH, JSON.stringify(profile, null, 2), { mode: 0o600 });
console.log(`\nWrote ${PROFILE_PATH}`);
console.log("Next: make rig-build && make rig-up");
rl.close();
