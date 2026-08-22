// Journey report generation (docs 20 §6) — direct calls into
// generateJourneyReport, the same "call the function, not the HTTP route"
// style test/agent.mjs already uses for createLlmProvider. Offline: `c.llm`
// is injected, so no secret and no network call is needed.
import assert from "node:assert/strict";
import { generateJourneyReport, journeyPk } from "../src/journeys.js";

function makeStore(seed = {}) {
  const items = new Map(Object.entries(seed));
  const key = (k) => `${k.PK}|${k.SK}`;
  return {
    items,
    send: async (cmd) => {
      const name = cmd.constructor.name;
      if (name === "GetCommand") {
        return { Item: items.get(key(cmd.input.Key)) };
      }
      if (name === "QueryCommand") {
        const pk = cmd.input.ExpressionAttributeValues[":pk"];
        const skPrefix = cmd.input.ExpressionAttributeValues[":sk"];
        const out = [...items.values()].filter((i) => i.PK === pk && String(i.SK).startsWith(skPrefix));
        return { Items: out };
      }
      if (name === "UpdateCommand") {
        const k = key(cmd.input.Key);
        const existing = items.get(k);
        if (cmd.input.ConditionExpression === "attribute_exists(PK)" && !existing) {
          const e = new Error("ConditionalCheckFailedException");
          e.name = "ConditionalCheckFailedException";
          throw e;
        }
        // Minimal SET-only interpreter, enough for this module's two updates.
        const item = { ...existing };
        const sets = cmd.input.UpdateExpression.replace(/^SET /, "").split(", ");
        for (const clause of sets) {
          const [lhs, rhs] = clause.split(" = ").map((s) => s.trim());
          const attr = cmd.input.ExpressionAttributeNames?.[lhs] || lhs;
          item[attr] = cmd.input.ExpressionAttributeValues[rhs];
        }
        item.PK = cmd.input.Key.PK;
        item.SK = cmd.input.Key.SK;
        items.set(k, item);
        return {};
      }
      throw new Error(`unhandled command ${name}`);
    },
  };
}

function baseSeed(journeyId) {
  return {
    [`${journeyPk(journeyId)}|META`]: { PK: journeyPk(journeyId), SK: "META", journeyId, title: "Q3 Launch", health: "yellow", progress: 40 },
    [`${journeyPk(journeyId)}|REPORT#r1`]: { PK: journeyPk(journeyId), SK: "REPORT#r1", reportId: "r1", question: "Where are we?", requestedBy: "alice@example.com", requestedAt: Date.now(), status: "pending" },
  };
}

function makeContainer({ store, llm, secretValue }) {
  return {
    config: { tableNames: { journeys: "j" }, secrets: { llm: "kelabo/dev/llm" }, llm: { provider: "fake", model: "m" }, openaiBaseUrl: "" },
    db: store,
    llm,
    getSecret: async () => secretValue,
    log: () => {},
    logError: () => {},
  };
}

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`ok - ${name}`);
  } catch (e) {
    console.error(`FAIL - ${name}`);
    console.error(e);
    process.exitCode = 1;
  }
}

await test("journey not found: fails without ever consulting the LLM", async () => {
  const store = makeStore({});
  let called = false;
  const c = makeContainer({ store, llm: { complete: async () => { called = true; return "x"; } } });
  const result = await generateJourneyReport(c, "nope", { reportId: "r1", question: "q" });
  assert.equal(result.body.status, "failed");
  assert.equal(result.body.error, "journey_not_found");
  assert.equal(called, false);
});

await test("success: assembles description + linked kelabo minutes + board into the prompt, persists the answer", async () => {
  const journeyId = "j1";
  const seed = baseSeed(journeyId);
  seed[`${journeyPk(journeyId)}|DESC#000001`] = { PK: journeyPk(journeyId), SK: "DESC#000001", version: 1, markdown: "This project ships the Q3 redesign." };
  seed[`${journeyPk(journeyId)}|LINK#k1`] = { PK: journeyPk(journeyId), SK: "LINK#k1", kelaboId: "k1", titleSnapshot: "Kickoff", linkedAt: 1 };
  seed[`${journeyPk(journeyId)}|BOARDMSG#m1`] = { PK: journeyPk(journeyId), SK: "BOARDMSG#m1", msgId: "m1", content: "Ship date is fixed", removed: false, createdAt: 1 };
  // A removed message must never reach the prompt.
  seed[`${journeyPk(journeyId)}|BOARDMSG#m2`] = { PK: journeyPk(journeyId), SK: "BOARDMSG#m2", msgId: "m2", content: "SECRET stale note", removed: true, createdAt: 2 };
  seed["KELABO#k1|MINUTES"] = { PK: "KELABO#k1", SK: "MINUTES", kelaboId: "k1", summary: "Decided to use React.", decisions: ["Use React"], actionItems: [] };
  const store = makeStore(seed);

  let promptSeen = null;
  const llm = { complete: async (req) => { promptSeen = req.messages[0].content; return "The project ships in Q3, using React per the kickoff decision."; } };
  const c = makeContainer({ store, llm });

  const result = await generateJourneyReport(c, journeyId, { reportId: "r1", question: "What did we decide about the framework?" });
  assert.equal(result.body.status, "ready");
  assert.ok(result.body.answer.includes("React"));

  assert.ok(promptSeen.includes("This project ships the Q3 redesign"), "description reached the prompt");
  assert.ok(promptSeen.includes("Ship date is fixed"), "active board message reached the prompt");
  assert.equal(promptSeen.includes("SECRET stale note"), false, "a removed board message must not reach the prompt");
  assert.ok(promptSeen.includes("Decided to use React"), "the linked kelabo's minutes reached the prompt");
  assert.ok(promptSeen.includes("health=yellow"), "health/progress reached the prompt");

  const persisted = store.items.get(`${journeyPk(journeyId)}|REPORT#r1`);
  assert.equal(persisted.status, "ready");
  assert.equal(persisted.answer, result.body.answer);
  assert.ok(typeof persisted.generatedAt === "number");
});

await test("llm failure: the report row is marked failed with a reason, not left pending", async () => {
  const journeyId = "j2";
  const store = makeStore(baseSeed(journeyId));
  const llm = { complete: async () => { throw new Error("provider unreachable"); } };
  const c = makeContainer({ store, llm });
  const result = await generateJourneyReport(c, journeyId, { reportId: "r1", question: "q" });
  assert.equal(result.body.status, "failed");
  assert.equal(result.body.error, "llm_failed");
  assert.equal(store.items.get(`${journeyPk(journeyId)}|REPORT#r1`).status, "failed");
});

await test("no LLM configured: fails cleanly instead of throwing", async () => {
  const journeyId = "j3";
  const store = makeStore(baseSeed(journeyId));
  const c = makeContainer({ store, llm: undefined, secretValue: null });
  const result = await generateJourneyReport(c, journeyId, { reportId: "r1", question: "q" });
  assert.equal(result.body.status, "failed");
  assert.equal(result.body.error, "llm_not_configured");
});

console.log(`\n${passed} passed`);
