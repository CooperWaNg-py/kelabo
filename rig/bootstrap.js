import { readFile, writeFile, mkdir, cp, readdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { spawn } from "node:child_process";
import path from "node:path";
import { getSecretValue, awsCredentialsFromEnv } from "./awsSecrets.js";

const run = promisify(execFile);

const PROFILE_PATH = process.env.RIG_PROFILE_PATH || "/run/rig-profile.json";
const CONFIG_DIR = process.env.OPENCODE_CONFIG_DIR || "/root/.config/opencode";
const WORKSPACE = process.env.RIG_WORKSPACE || "/workspace";
const TEMPLATES = "/opt/rig/templates";
const CONNECTOR = process.env.RIG_CONNECTOR_DIR || "/opt/kelabo/connector";

const profile = JSON.parse(await readFile(PROFILE_PATH, "utf8"));
const awsCreds = awsCredentialsFromEnv();
const region = profile.awsRegion || process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-east-1";

async function resolveCredential(entry) {
  if (!entry) return null;
  if (entry.apiKey || entry.appPassword || entry.value) {
    return entry.apiKey || entry.appPassword || entry.value;
  }
  if (entry.secretName) {
    if (!awsCreds) {
      console.warn(`[bootstrap] secretName ${entry.secretName} set but no AWS credentials; skipping`);
      return null;
    }
    const secret = await getSecretValue({ secretName: entry.secretName, region, credentials: awsCreds });
    if (typeof secret === "string") return secret;
    return secret?.apiKey || secret?.key || secret?.token || JSON.stringify(secret);
  }
  return null;
}

function isPlainObject(v) {
  return v && typeof v === "object" && !Array.isArray(v);
}
function deepMerge(base, override) {
  const out = { ...base };
  for (const [k, v] of Object.entries(override || {})) {
    out[k] = isPlainObject(v) && isPlainObject(out[k]) ? deepMerge(out[k], v) : v;
  }
  return out;
}

function repoName(url) {
  const tail = url.replace(/\.git$/, "").split("/").pop();
  return tail || "repo";
}

async function checkoutRepos(repos) {
  await mkdir(WORKSPACE, { recursive: true });
  for (const repo of repos || []) {
    const dir = path.join(WORKSPACE, repoName(repo.url));
    try {
      await run("git", ["-C", dir, "rev-parse", "--git-dir"]);
      await run("git", ["-C", dir, "fetch", "--all", "--prune"]);
      if (repo.branch) await run("git", ["-C", dir, "checkout", repo.branch]);
      await run("git", ["-C", dir, "pull", "--ff-only"]);
      console.log(`[bootstrap] updated ${dir}`);
    } catch {
      const args = ["clone"];
      if (repo.branch) args.push("--branch", repo.branch);
      args.push(repo.url, dir);
      await run("git", args);
      console.log(`[bootstrap] cloned ${repo.url} -> ${dir}`);
    }
  }
}

async function writeOpencodeConfig() {
  const base = {
    $schema: "https://opencode.ai/config.json",
    autoshare: false,
    default_agent: "kelabo-bot",
    permission: { skill: { "*": "allow" } },
  };
  let merged = deepMerge(base, profile.opencodeConfig || {});
  const mcp = { ...(merged.mcp || {}) };
  // The Kelabo bridge is an MCP server opencode spawns over stdio, not a
  // daemon (docs 16 §7). Registering it here is what makes `kelabo_join` and
  // `kelabo_post` available inside the session.
  mcp.kelabo = {
    type: "local",
    // `cli.js run`, not `index.js`: index.js is the bridge module and has no
    // command-line entry of its own any more (docs 17 §5).
    command: ["node", path.join(CONNECTOR, "src", "cli.js"), "run"],
    environment: {
      KELABO_RUNTIME: "opencode",
      KELABO_AGENT_FILE: "/run/kelabo-agent.json",
      KELABO_GATEWAY_URL: profile.gatewayUrl || "",
      KELABO_API_BASE_URL: profile.apiBaseUrl || (profile.portalUrl ? `${profile.portalUrl}/api` : ""),
    },
  };
  for (const entry of profile.mcp || []) {
    const { name, ...rest } = entry;
    if (name && name !== "kelabo") mcp[name] = rest;
  }
  merged = { ...merged, mcp };
  await mkdir(CONFIG_DIR, { recursive: true });
  await writeFile(path.join(CONFIG_DIR, "opencode.json"), JSON.stringify(merged, null, 2));
}

/**
 * The plugin and the slash commands come from `connector/`, which the image
 * already copies — they are not rig assets and never were (docs 17 §7).
 *
 * They used to be duplicated under `rig/templates/`, and the copies drifted:
 * the rig's plugin lost the 5-second abort on the handover fetch, which is
 * precisely the guard whose absence turns `/kstart` into silence with no error
 * anywhere. One source, or this happens again.
 *
 * `commands` is plural. opencode scans `<config>/commands/`; this wrote to
 * `command/` (singular), which is not scanned at all — so `/kstart` and `/kend`
 * did not exist inside the rig.
 */
async function installTemplates() {
  const map = [
    [path.join(TEMPLATES, "agent"), path.join(CONFIG_DIR, "agent")],
    [path.join(CONNECTOR, "commands"), path.join(CONFIG_DIR, "commands")],
  ];
  for (const [srcDir, destDir] of map) {
    try {
      await readdir(srcDir);
      await mkdir(destDir, { recursive: true });
      await cp(srcDir, destDir, { recursive: true });
      console.log(`[bootstrap] installed ${srcDir} -> ${destDir}`);
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }
  }

  // A single file rather than a directory copy: `src/plugin/` is the bridge's
  // own source tree, and only this one file is an opencode plugin.
  const pluginDir = path.join(CONFIG_DIR, "plugins");
  await mkdir(pluginDir, { recursive: true });
  await cp(path.join(CONNECTOR, "src", "plugin", "opencode.js"), path.join(pluginDir, "kelabo-bridge.js"));
  console.log(`[bootstrap] installed kelabo-bridge.js -> ${pluginDir}`);
}

async function writeRuntimeFiles() {
  const modelKey = await resolveCredential(profile.credentials?.modelProvider);
  await writeFile("/run/model-auth.json", JSON.stringify({
    opencodeBaseUrl: "http://127.0.0.1:4096",
    provider: profile.credentials?.modelProvider?.provider || null,
    key: modelKey,
  }), { mode: 0o600 });

  // The agent bridge's credential, in the shape `kelabo login` writes (docs 16
  // §6). The rig fills it from the paired token in the profile so a
  // non-technical user never runs the pairing command themselves.
  await writeFile("/run/kelabo-agent.json", JSON.stringify({
    agentToken: profile.auth?.agentToken || null,
    identity: profile.hostEmail,
    gatewayBaseUrl: (profile.gatewayUrl || "").replace(/^ws/, "http"),
    apiBaseUrl: profile.apiBaseUrl || (profile.portalUrl ? `${profile.portalUrl}/api` : ""),
    label: "rig",
  }), { mode: 0o600 });

  for (const [name, entry] of Object.entries(profile.credentials || {})) {
    if (name === "modelProvider") continue;
    const value = await resolveCredential(entry);
    if (value) {
      process.env[`KELABO_CRED_${name.toUpperCase()}`] = value;
      await writeFile(`/run/cred-${name}`, value, { mode: 0o600 });
    }
  }
}

console.log(`[bootstrap] rig for ${profile.hostEmail || "unknown"} (${(profile.repos || []).length} repos)`);
await checkoutRepos(profile.repos);
await writeOpencodeConfig();
await installTemplates();
await writeRuntimeFiles();

console.log("[bootstrap] starting supervisord");
const sup = spawn("supervisord", ["-c", "/opt/rig/supervisord.conf"], { stdio: "inherit", env: { ...process.env, OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS: "true" } });
for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => sup.kill(sig));
}
sup.on("exit", (code) => process.exit(code ?? 0));
