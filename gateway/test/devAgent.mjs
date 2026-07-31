#!/usr/bin/env node
// Local dev harness for the main/sub agent pipeline.
//
// Drives the REAL TriggerGate → MainAgent → SubAgent flow (the exact classes the
// gateway worker runs) against a chosen LLM provider, feeding a scripted or
// interactive transcript. It renders the debug stream grouped by orchestration
// turn — the same grouping the front-page DebugPanel uses — and prints board
// contributions as they are produced. No AWS, no server, no worker thread.
//
// Usage:
//   node test/devAgent.mjs [--provider fake|scripted|anthropic|openai] [--file transcript.txt]
//                          [--interactive] [--model M] [--small-model M]
//                          [--wire] [--json]
//
// Env:
//   KELABO_LLM_API_KEY      provider api key (anthropic/openai)
//   KELABO_BRAVE_API_KEY    brave key → enables web_search (currently a no-op:
//                           web_search is disabled via WEB_SEARCH_ENABLED)
//   KELABO_OPENAI_BASE_URL  base url for openai-compatible providers
//   KELABO_LLM_MODEL        strong (sub-agent) model
//   KELABO_LLM_SMALL_MODEL  small (main + gate) model
//
// Examples:
//   node test/devAgent.mjs --provider scripted  # offline, exercises main→sub→board
//   node test/devAgent.mjs                       # fake provider, built-in script
//   KELABO_LLM_API_KEY=sk-... node test/devAgent.mjs --provider anthropic \
//       --model claude-3-5-sonnet-latest --small-model claude-3-5-haiku-latest \
//       --file ./my-transcript.txt --wire
//
// A transcript file is one utterance per line: "Speaker: text". Lines starting
// with '#' are ignored. Without --file a built-in demo script is used.

import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { createLlmProvider } from "../src/agent/llm.js";
import { makeScriptedProvider } from "./scriptedProvider.mjs";
import { TriggerGate } from "../src/agent/gate.js";
import { MainAgent } from "../src/agent/mainAgent.js";
import { createWebSearch, createWebFetch, createMcpQuery, WEB_SEARCH_ENABLED } from "../src/agent/subagents.js";

// ---- args -----------------------------------------------------------------
function parseArgs(argv) {
  const a = { provider: process.env.KELABO_LLM_PROVIDER || "fake", interactive: false, wire: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === "--provider") a.provider = argv[++i];
    else if (t === "--file") a.file = argv[++i];
    else if (t === "--model") a.model = argv[++i];
    else if (t === "--small-model") a.smallModel = argv[++i];
    else if (t === "--interactive" || t === "-i") a.interactive = true;
    else if (t === "--wire") a.wire = true;
    else if (t === "--json") a.json = true;
    else if (t === "--help" || t === "-h") a.help = true;
  }
  return a;
}

const DEMO_SCRIPT = [
  "Alice: Morning everyone, let's kick off the planning sync.",
  "Bob: Before we start — does anyone know the latest stable Node.js LTS version?",
  "Alice: Good question, we should pin it in CI.",
  "Bob: And what's the current weather in Melbourne this weekend? I'm flying in Saturday.",
];

// ---- pretty printing ------------------------------------------------------
const C = process.stdout.isTTY
  ? { dim: (s) => `\x1b[2m${s}\x1b[0m`, b: (s) => `\x1b[1m${s}\x1b[0m`, cyan: (s) => `\x1b[36m${s}\x1b[0m`, green: (s) => `\x1b[32m${s}\x1b[0m`, yellow: (s) => `\x1b[33m${s}\x1b[0m`, red: (s) => `\x1b[31m${s}\x1b[0m` }
  : new Proxy({}, { get: () => (s) => s });

function clip(s, n = 600) {
  s = String(s ?? "");
  return s.length > n ? s.slice(0, n) + C.dim(` …(+${s.length - n} chars)`) : s;
}

function fmtTokens(n) {
  const v = Number(n) || 0;
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(v >= 10_000_000 ? 0 : 1)}M`;
  if (v >= 1000) return `${(v / 1000).toFixed(v >= 10_000 ? 0 : 1)}k`;
  return String(v);
}

function tokenTag(u) {
  if (!u || !u.total) return "";
  return C.dim(`tokens ${fmtTokens(u.cacheRead)}/${fmtTokens(u.input)}/${fmtTokens(u.output)}`);
}

// Group the flat debug stream by orchestration turn, mirroring the DebugPanel.
function makeDebugPrinter({ json }) {
  return function debug(kelaboId, entry) {
    if (json) {
      console.log(JSON.stringify({ type: "debug", ...entry }));
      return;
    }
    const tag = entry.turnId ? C.dim(`[turn ${entry.turnId.slice(0, 8)}]`) : "";
    if (entry.kind === "gate") {
      if (entry.phase === "request") console.log(`\n${C.yellow("● gate")} ${C.dim("classifying transcript…")}`);
      else console.log(`  ${C.yellow("gate →")} ${C.b(entry.verdict)} conf=${entry.confidence} ${C.dim(entry.reason || "")}${entry.query ? `\n    query: ${C.cyan(entry.query)}` : ""} ${tokenTag(entry.usage)}`);
      return;
    }
    if (entry.kind === "main") {
      if (entry.phase === "request") {
        console.log(`\n${C.cyan("■ main agent")} ${tag} ${C.dim(`model=${entry.model} thread=${entry.threadLen ?? "?"} msgs`)}`);
        if (entry.query) console.log(`  ${C.dim("trigger:")} ${C.cyan(entry.query)}`);
      } else {
        const tcs = entry.toolCalls || [];
        if (tcs.length) console.log(`  ${C.cyan("main →")} dispatch ${tcs.length}: ${tcs.map((t) => t.input?.task_id || t.input?.objective || t.name).join(", ")} ${tokenTag(entry.usage)}`);
        else console.log(`  ${C.cyan("main →")} ${C.dim("no dispatch")} ${clip(entry.raw, 120)} ${tokenTag(entry.usage)}`);
      }
      return;
    }
    if (entry.kind === "subagent") {
      const who = `${C.green("◆ sub")} ${C.dim(entry.taskId || "")} ${tag}`;
      if (entry.phase === "request") console.log(`    ${who} ${C.dim(`#${entry.iteration} ${entry.objective ? "· " + clip(entry.objective, 60) : ""}`)}`);
      else if (entry.phase === "response") {
        const tcs = entry.toolCalls || [];
        if (tcs.length) console.log(`    ${C.green("sub →")} tools: ${tcs.map((t) => `${t.name}(${clip(JSON.stringify(t.input), 80)})`).join(", ")} ${tokenTag(entry.usage)}`);
        else console.log(`    ${C.green("sub →")} concluded: ${clip(entry.raw, 200)} ${tokenTag(entry.usage)}`);
      } else if (entry.phase === "conclude_request") console.log(`    ${C.green("sub →")} ${C.dim("force-conclude…")}`);
      else if (entry.phase === "conclude_response") console.log(`    ${C.green("sub →")} ${C.dim("concluded:")} ${clip(entry.raw, 200)} ${tokenTag(entry.usage)}`);
      else if (entry.phase === "conclude_error") console.log(`    ${C.red("sub → conclude error:")} ${entry.raw}`);
      return;
    }
    if (entry.kind === "turn_usage") {
      console.log(`  ${C.dim("─ turn total —")} ${C.cyan("tokens")} ${C.b(`${fmtTokens(entry.usage?.total ?? 0)}`)} ${C.dim(`(${fmtTokens(entry.usage?.input ?? 0)} in / ${fmtTokens(entry.usage?.output ?? 0)} out) · ${entry.subAgents} sub-agent${entry.subAgents === 1 ? "" : "s"}`)}`);
      return;
    }
    if (entry.kind === "minutes") {
      console.log(`\n${C.b("▣ minutes")} ${entry.phase}${entry.raw ? `: ${clip(entry.raw, 300)}` : ""}`);
    }
  };
}

function makeLogPrinter({ json }) {
  return function log(event, fields = {}) {
    if (json) {
      console.log(JSON.stringify({ type: "log", event, ...fields }));
      return;
    }
    if (event.startsWith("llm_wire")) console.log(C.dim(`  ~ ${event}: ${clip(JSON.stringify(fields), 400)}`));
    else console.log(C.dim(`  · ${event} ${JSON.stringify(fields)}`));
  };
}

// ---- transcript sources ---------------------------------------------------
async function loadTranscript(file) {
  const raw = await readFile(file, "utf8");
  return raw
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map((line, i) => {
      const m = line.match(/^([^:]+):\s*(.*)$/);
      const speaker = m ? m[1].trim() : "speaker";
      const text = m ? m[2] : line;
      return { speaker, text, tStart: i + 1, tEnd: i + 1, isFinal: true };
    });
}

function scriptToCaptions(lines) {
  return lines.map((line, i) => {
    const m = line.match(/^([^:]+):\s*(.*)$/);
    return { speaker: m ? m[1].trim() : "speaker", text: m ? m[2] : line, tStart: i + 1, tEnd: i + 1, isFinal: true };
  });
}

// ---- harness --------------------------------------------------------------
async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(await readFile(new URL(import.meta.url)).then((b) => b.toString().split("\n").slice(1, 30).map((l) => l.replace(/^\/\/ ?/, "")).join("\n")));
    return;
  }
  if (args.wire) process.env.KELABO_LLM_WIRE_LOG = "1";

  const kelaboId = "dev-" + Date.now();
  const modelConfig = {
    provider: args.provider,
    model: args.model || process.env.KELABO_LLM_MODEL || "strong",
    smallModel: args.smallModel || process.env.KELABO_LLM_SMALL_MODEL || "small",
  };
  const apiKey = process.env.KELABO_LLM_API_KEY || null;
  const braveKey = process.env.KELABO_BRAVE_API_KEY || null;
  const openaiBaseUrl = process.env.KELABO_OPENAI_BASE_URL;

  const debug = makeDebugPrinter(args);
  const log = makeLogPrinter(args);

  // "scripted" is a fully offline provider that DOES exercise the main→sub path
  // (unlike "fake", which always returns NONE at the gate). Useful to demo the
  // grouped debug output and board posts without any API key.
  const makeProvider = (cfg) =>
    args.provider === "scripted"
      ? makeScriptedProvider(cfg)
      : createLlmProvider(cfg, { apiKey, openaiBaseUrl, log });
  const strong = makeProvider(modelConfig);
  const small = makeProvider({ ...modelConfig, model: modelConfig.smallModel });

  // Capabilities mirror runner.js: web_fetch always (plain fetch), web_search
  // only when WEB_SEARCH_ENABLED (currently false project-wide) AND a Brave key.
  const capabilities = ["web"];
  if (WEB_SEARCH_ENABLED && (braveKey || args.provider === "fake")) capabilities.push("web_search");

  const gate = new TriggerGate({
    llm: small,
    smallModel: modelConfig.smallModel,
    knobs: { sensitivity: "medium", cooldownSeconds: 0, maxContributionsPerMinute: 100 },
    log,
    debug,
  });

  const mcp = { servers: [] };
  const mainAgent = new MainAgent({
    llm: small,
    smallModel: modelConfig.smallModel,
    subAgentModel: modelConfig.model,
    subAgentDeps: {
      strong,
      webSearch: createWebSearch({ apiKey: braveKey, log }),
      webFetch: createWebFetch({ log }),
      makeMcpQuery: () => createMcpQuery({ mcp, log }),
      capabilities,
      mcp,
    },
    log,
    debug,
  });

  const transcript = [];

  async function feed(caption) {
    console.log(`\n${C.b("┌─ caption")} ${C.dim(`${caption.speaker}:`)} ${caption.text}`);
    transcript.push(caption);
    const decision = await gate.decide(kelaboId, caption, transcript);
    if (decision.verdict === "NONE") {
      console.log(C.dim("└─ (gate: NONE — no turn)"));
      return;
    }
    for await (const contribution of mainAgent.runTurn({
      kelaboId,
      trigger: caption,
      query: decision.query,
      transcript: [...transcript],
    })) {
      if (contribution.status === "working") console.log(`  ${C.dim("… board card (working):")} ${contribution.title}`);
      else if (contribution.markdown) console.log(`\n${C.green("┏━ BOARD POST")} → ${contribution.to}\n${C.b(contribution.title)}\n${contribution.markdown}${contribution.sources?.length ? `\n${C.dim("sources: " + contribution.sources.map((s) => s.url).join(", "))}` : ""}\n${C.green("┗━")}`);
      else console.log(C.dim("  (card cleared — nothing posted)"));
    }
    console.log(C.dim("└─ turn complete"));
  }

  console.log(C.b(`kelabo dev agent harness`) + C.dim(` — provider=${args.provider} model=${modelConfig.model} small=${modelConfig.smallModel} caps=[${capabilities}]${args.wire ? " wire=on" : ""}`));

  if (args.interactive) {
    const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: C.cyan("you> ") });
    console.log(C.dim("Interactive mode. Type 'Speaker: text' (or just text). Ctrl-D to end + summarize.\n"));
    rl.prompt();
    for await (const line of rl) {
      const l = line.trim();
      if (!l) { rl.prompt(); continue; }
      const [c] = scriptToCaptions([l]);
      c.tStart = transcript.length + 1;
      c.tEnd = c.tStart;
      await feed(c);
      rl.prompt();
    }
  } else {
    const lines = args.file ? (await loadTranscript(args.file)).map((u) => `${u.speaker}: ${u.text}`) : DEMO_SCRIPT;
    for (const c of scriptToCaptions(lines)) await feed(c);
  }

  console.log(`\n${C.b("▣ generating minutes…")}`);
  try {
    const minutes = await mainAgent.summarize({ kelaboId, transcript });
    console.log(JSON.stringify(minutes, null, 2));
  } catch (err) {
    console.log(C.red(`minutes failed: ${err.message}`));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
