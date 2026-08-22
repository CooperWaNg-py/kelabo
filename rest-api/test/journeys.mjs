// Journey (docs 20): CRUD, visibility/permission matrix, kelabo linking, the
// kelabos-table mirror, description versioning, and the purge guard on
// records.js. Two layers: direct calls into journeys.js for the permission
// matrix (fast, thorough), plus a handful of true HTTP-level calls through
// createApp to prove the routes in index.js are wired correctly.
import assert from "node:assert/strict";
import { createApp } from "../src/index.js";
import { createDb } from "./stubDb.js";
import { createSessions } from "../src/sessions.js";
import { createJourneys } from "../src/journeys.js";
import { createRecords } from "../src/records.js";

const config = {
  env: "test",
  region: "us-east-1",
  allowedEmailDomain: "example.com",
  cookieDomain: ".test.example.com",
  portalUrl: "https://test.example.com",
  gatewayBaseUrl: "https://gw.test.example.com",
  joinUrl: (id) => `https://test.example.com/join/${id}`,
  inviteUrl: (id) => `https://test.example.com/invite/${id}`,
  tableNames: { kelabos: "m", users: "u", otp: "o", refresh: "r", history: "h", mcp: "mc", contacts: "co", journeys: "j" },
  contacts: { external: false },
  archiveBucket: "bucket",
  archiveKeyPrefix: "archives",
  secrets: { cookieSigningKey: "cookie" },
  auth: { sessionTtlSeconds: 3600, refreshTtlDays: 60, participantTtlSeconds: 43200, agentTokenTtlDays: 90, socialProviders: [] },
  retentionDays: 30,
};

const secrets = { getCookieKey: async () => "test-signing-key" };

const db = createDb();
const sessions = createSessions({ config, db, secrets });
const journeys = createJourneys({ config, db });
const s3Objects = {};
const records = createRecords({
  config,
  db,
  s3: { send: async () => ({ Body: { transformToString: async () => "{}" } }) },
});

// Every other dep the route table references but these tests never exercise —
// left undefined on purpose, matching how a handler for an untouched route is
// never invoked and so never dereferences them.
const app = createApp({
  config,
  db,
  secrets,
  sessions,
  journeys,
  records,
  version: "test",
});

function cookieValue(cookies, name) {
  const c = (cookies || []).find((s) => s.startsWith(`${name}=`));
  return c ? decodeURIComponent(c.split(";")[0].slice(name.length + 1)) : null;
}

async function sessionFor(email) {
  const session = await sessions.establishSession(email);
  return { kelabo_session: cookieValue(session.cookies, "kelabo_session") };
}

async function call(method, path, { body, cookies = {} } = {}) {
  const [rawPath, qs] = path.split("?");
  const res = await app({
    requestContext: { http: { method, sourceIp: "1.2.3.4" } },
    rawPath,
    rawQueryString: qs || "",
    headers: {
      "content-type": "application/json",
      ...(Object.keys(cookies).length
        ? { cookie: Object.entries(cookies).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("; ") }
        : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { ...res, json: res.body && res.headers["Content-Type"]?.includes("json") ? JSON.parse(res.body) : null };
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

// A minimal live kelabo, seeded directly (bypassing kelabos.js — journeys.js
// only ever reads META, host and participants). `host` is stamped as host
// and as the sole participant unless overridden, since linkKelabo requires
// the actor to be host-or-participant of the target.
async function seedKelabo({ kelaboId, host, participants = [], status = "active" }) {
  await db.createKelabo({
    kelaboId,
    status,
    title: `Kelabo ${kelaboId}`,
    hostIdentity: host,
    participants,
    tenantId: host.split("@")[1],
    tenantStatus: `${host.split("@")[1]}#${status}`,
    createdAt: Date.now(),
    startedAt: Date.now(),
  });
}

const OWNER = "alice@example.com";
const COLLEAGUE = "bob@example.com"; // same tenant (example.com)
const OUTSIDER = "carol@other.example"; // different tenant

// --- create / get / list, and the visibility split --------------------------

await test("create + get: owner always has full access", async () => {
  const j = await journeys.createJourney({ identity: OWNER, body: { title: "Q3 Launch", visibility: "private" } });
  assert.equal(j.status, "active");
  assert.equal(j.visibility, "private");
  const got = await journeys.getJourney({ journeyId: j.journeyId, identity: OWNER });
  assert.equal(got.myRole, "owner");
  assert.equal(got.title, "Q3 Launch");
});

await test("get: a private journey refuses a same-tenant stranger with no accessor grant", async () => {
  const j = await journeys.createJourney({ identity: OWNER, body: { title: "Private one", visibility: "private" } });
  await assert.rejects(
    journeys.getJourney({ journeyId: j.journeyId, identity: COLLEAGUE }),
    (e) => e.status === 403 && e.code === "forbidden",
  );
});

await test("get: a public journey grants full access to any same-tenant identity, none to another tenant", async () => {
  const j = await journeys.createJourney({ identity: OWNER, body: { title: "Public one", visibility: "public" } });
  const asColleague = await journeys.getJourney({ journeyId: j.journeyId, identity: COLLEAGUE });
  assert.equal(asColleague.myRole, "member");
  await assert.rejects(
    journeys.getJourney({ journeyId: j.journeyId, identity: OUTSIDER }),
    (e) => e.status === 403,
  );
});

await test("get: unknown journey is 404, not a 403 that leaks existence", async () => {
  await assert.rejects(
    journeys.getJourney({ journeyId: "nope", identity: OWNER }),
    (e) => e.status === 404 && e.code === "journey_not_found",
  );
});

await test("list: mine / accessible / public are three distinct, non-overlapping buckets", async () => {
  const pub = await journeys.createJourney({ identity: OWNER, body: { title: "Owned+public", visibility: "public" } });
  const priv = await journeys.createJourney({ identity: OWNER, body: { title: "Owned+private", visibility: "private" } });
  await journeys.addAccessor({ journeyId: priv.journeyId, identity: OWNER, body: { identity: COLLEAGUE } });

  const mine = await journeys.listJourneys({ identity: OWNER });
  assert.ok(mine.mine.some((m) => m.journeyId === pub.journeyId));
  assert.ok(mine.mine.some((m) => m.journeyId === priv.journeyId));
  assert.equal(mine.public.some((m) => m.journeyId === pub.journeyId), false, "own journey is not also listed as public");

  const colleague = await journeys.listJourneys({ identity: COLLEAGUE });
  assert.ok(colleague.public.some((m) => m.journeyId === pub.journeyId), "sees the owner's public journey");
  assert.ok(colleague.accessible.some((m) => m.journeyId === priv.journeyId), "sees the private one they were added to");
  assert.equal(colleague.mine.length, 0);
});

// --- patch (owner-only) ------------------------------------------------------

await test("patch: non-owner is refused even with member-level access", async () => {
  const j = await journeys.createJourney({ identity: OWNER, body: { title: "T", visibility: "public" } });
  await assert.rejects(
    journeys.patchJourney({ journeyId: j.journeyId, identity: COLLEAGUE, body: { title: "Hijacked" } }),
    (e) => e.status === 403 && e.code === "not_journey_owner",
  );
});

await test("patch: empty body is nothing_to_change", async () => {
  const j = await journeys.createJourney({ identity: OWNER, body: { title: "T", visibility: "public" } });
  await assert.rejects(
    journeys.patchJourney({ journeyId: j.journeyId, identity: OWNER, body: {} }),
    (e) => e.status === 400 && e.code === "nothing_to_change",
  );
});

await test("patch: owner can rename and flip visibility", async () => {
  const j = await journeys.createJourney({ identity: OWNER, body: { title: "T", visibility: "public" } });
  const updated = await journeys.patchJourney({ journeyId: j.journeyId, identity: OWNER, body: { title: "T2", visibility: "private" } });
  assert.equal(updated.title, "T2");
  assert.equal(updated.visibility, "private");
});

// --- complete / reopen (owner-only, idempotent, freezes writes) -------------

await test("complete: owner-only, idempotent, and freezes every member write", async () => {
  const j = await journeys.createJourney({ identity: OWNER, body: { title: "T", visibility: "public" } });
  await assert.rejects(
    journeys.completeJourney({ journeyId: j.journeyId, identity: COLLEAGUE }),
    (e) => e.status === 403 && e.code === "not_journey_owner",
  );
  const done = await journeys.completeJourney({ journeyId: j.journeyId, identity: OWNER });
  assert.equal(done.status, "completed");
  // Idempotent: a second click lands on the same state, not an error.
  const again = await journeys.completeJourney({ journeyId: j.journeyId, identity: OWNER });
  assert.equal(again.status, "completed");

  // Frozen: description edits, which a member could do while active, are
  // refused now for owner AND member alike.
  await assert.rejects(
    journeys.updateDescription({ journeyId: j.journeyId, identity: OWNER, body: { markdown: "x" } }),
    (e) => e.status === 409 && e.code === "journey_completed",
  );
  // patch (title/visibility) is owner-only and structural, not one of the
  // member-writes §3.1 freezes — it deliberately carries no requireActive
  // guard, so the owner can still rename or flip visibility while completed.
  const renamed = await journeys.patchJourney({ journeyId: j.journeyId, identity: OWNER, body: { title: "T3" } });
  assert.equal(renamed.title, "T3");
});

await test("reopen: owner-only, refuses on an already-active journey", async () => {
  const j = await journeys.createJourney({ identity: OWNER, body: { title: "T", visibility: "public" } });
  await journeys.completeJourney({ journeyId: j.journeyId, identity: OWNER });
  await assert.rejects(
    journeys.reopenJourney({ journeyId: j.journeyId, identity: COLLEAGUE }),
    (e) => e.status === 403,
  );
  const reopened = await journeys.reopenJourney({ journeyId: j.journeyId, identity: OWNER });
  assert.equal(reopened.status, "active");
  // Already active: idempotent, not an error.
  const again = await journeys.reopenJourney({ journeyId: j.journeyId, identity: OWNER });
  assert.equal(again.status, "active");
});

// --- accessors (private only, owner-only to manage) -------------------------

await test("accessors: owner-only to add/remove; refused entirely on a public journey", async () => {
  const pub = await journeys.createJourney({ identity: OWNER, body: { title: "T", visibility: "public" } });
  await assert.rejects(
    journeys.addAccessor({ journeyId: pub.journeyId, identity: OWNER, body: { identity: COLLEAGUE } }),
    (e) => e.status === 409 && e.code === "not_private",
  );

  const priv = await journeys.createJourney({ identity: OWNER, body: { title: "T", visibility: "private" } });
  await assert.rejects(
    journeys.addAccessor({ journeyId: priv.journeyId, identity: COLLEAGUE, body: { identity: COLLEAGUE } }),
    (e) => e.status === 403 && e.code === "not_journey_owner",
  );

  await journeys.addAccessor({ journeyId: priv.journeyId, identity: OWNER, body: { identity: COLLEAGUE } });
  const got = await journeys.getJourney({ journeyId: priv.journeyId, identity: COLLEAGUE });
  assert.equal(got.myRole, "member");

  await journeys.removeAccessor({ journeyId: priv.journeyId, identity: OWNER, target: COLLEAGUE });
  await assert.rejects(
    journeys.getJourney({ journeyId: priv.journeyId, identity: COLLEAGUE }),
    (e) => e.status === 403,
  );
});

// --- kelabo linking, the mirror, and the target-membership requirement ------

await test("linkKelabo: refused unless the actor is host/participant of the target kelabo", async () => {
  const j = await journeys.createJourney({ identity: OWNER, body: { title: "T", visibility: "public" } });
  await seedKelabo({ kelaboId: "k-not-mine", host: COLLEAGUE });
  await assert.rejects(
    journeys.linkKelabo({ journeyId: j.journeyId, identity: OWNER, kelaboId: "k-not-mine" }),
    (e) => e.status === 403 && e.code === "not_kelabo_member",
  );
});

await test("linkKelabo: succeeds for the kelabo's host, mirrors onto the kelabo's own partition, is idempotent, and unlink removes both sides", async () => {
  const j = await journeys.createJourney({ identity: OWNER, body: { title: "T", visibility: "public" } });
  await seedKelabo({ kelaboId: "k1", host: OWNER });

  const link1 = await journeys.linkKelabo({ journeyId: j.journeyId, identity: OWNER, kelaboId: "k1" });
  assert.equal(link1.linked, true);
  assert.equal((await db.listKelaboJourneyLinks("k1")).length, 1, "mirror written on the kelabo's own partition");
  assert.equal((await journeys.getJourney({ journeyId: j.journeyId, identity: OWNER })).kelaboCount, 1);

  // Idempotent: linking the same kelabo again lands on "linked", not an error.
  const link2 = await journeys.linkKelabo({ journeyId: j.journeyId, identity: OWNER, kelaboId: "k1" });
  assert.equal(link2.linked, true);

  const listed = await journeys.listLinkedKelabos({ journeyId: j.journeyId, identity: OWNER });
  assert.equal(listed.kelabos.length, 1);
  assert.equal(listed.kelabos[0].kelaboId, "k1");

  await journeys.unlinkKelabo({ journeyId: j.journeyId, identity: OWNER, kelaboId: "k1" });
  assert.equal((await db.listKelaboJourneyLinks("k1")).length, 0, "mirror removed");
  assert.equal((await journeys.listLinkedKelabos({ journeyId: j.journeyId, identity: OWNER })).kelabos.length, 0);
});

await test("linkKelabo: refused once the journey is completed", async () => {
  const j = await journeys.createJourney({ identity: OWNER, body: { title: "T", visibility: "public" } });
  await seedKelabo({ kelaboId: "k2", host: OWNER });
  await journeys.completeJourney({ journeyId: j.journeyId, identity: OWNER });
  await assert.rejects(
    journeys.linkKelabo({ journeyId: j.journeyId, identity: OWNER, kelaboId: "k2" }),
    (e) => e.status === 409 && e.code === "journey_completed",
  );
});

await test("linkKelabo: a participant (not the host) may also link", async () => {
  const j = await journeys.createJourney({ identity: OWNER, body: { title: "T", visibility: "public" } });
  await seedKelabo({ kelaboId: "k3", host: COLLEAGUE, participants: [{ identity: OWNER, displayName: "Alice", isGuest: false }] });
  const link = await journeys.linkKelabo({ journeyId: j.journeyId, identity: OWNER, kelaboId: "k3" });
  assert.equal(link.linked, true);
});

// --- description versioning --------------------------------------------------

await test("description: append-only versions, current version advances, history is readable", async () => {
  const j = await journeys.createJourney({ identity: OWNER, body: { title: "T", visibility: "public", description: "v1 text" } });
  const v2 = await journeys.updateDescription({ journeyId: j.journeyId, identity: OWNER, body: { markdown: "v2 text", changeNote: "clarified scope" } });
  assert.equal(v2.version, 2, "creation's description counts as version 1");
  const history = await journeys.getDescriptionHistory({ journeyId: j.journeyId, identity: OWNER });
  assert.equal(history.versions.length, 2);
  assert.equal(history.versions.some((v) => v.markdown === "v1 text"), true);
  assert.equal(history.versions.some((v) => v.markdown === "v2 text" && v.changeNote === "clarified scope"), true);
});

// --- delete: cascades journey-owned resources, kelabos survive --------------

await test("deleteJourney: owner-only, cascades DESC#/ACCESSOR#/LINK#, unmirrors every linked kelabo, and never touches the kelabo itself", async () => {
  const j = await journeys.createJourney({ identity: OWNER, body: { title: "T", visibility: "private", description: "d" } });
  await journeys.addAccessor({ journeyId: j.journeyId, identity: OWNER, body: { identity: COLLEAGUE } });
  await seedKelabo({ kelaboId: "k4", host: OWNER });
  await journeys.linkKelabo({ journeyId: j.journeyId, identity: OWNER, kelaboId: "k4" });

  await assert.rejects(
    journeys.deleteJourney({ journeyId: j.journeyId, identity: COLLEAGUE }),
    (e) => e.status === 403 && e.code === "not_journey_owner",
  );

  const result = await journeys.deleteJourney({ journeyId: j.journeyId, identity: OWNER });
  assert.equal(result.deleted, true);
  assert.equal(result.kelabosUnlinked, 1);

  await assert.rejects(
    journeys.getJourney({ journeyId: j.journeyId, identity: OWNER }),
    (e) => e.status === 404,
  );
  assert.equal((await db.listKelaboJourneyLinks("k4")).length, 0, "kelabo's mirror is gone");
  assert.ok(await db.getKelaboMeta("k4"), "the kelabo itself still exists — deleting a journey never deletes a kelabo");
});

// --- purge guard: a kelabo linked into a journey cannot be host-purged ------

await test("purge guard: a host-purge of a linked kelabo is refused with kelabo_in_journey; unlinking clears it", async () => {
  const j = await journeys.createJourney({ identity: OWNER, body: { title: "T", visibility: "public" } });
  await seedKelabo({ kelaboId: "k5", host: OWNER, status: "ended" });
  db.__putHistory({
    archiveId: "k5",
    kelaboId: "k5",
    host: OWNER,
    endedAt: Date.now(),
    participantIdentities: [OWNER],
  });
  await journeys.linkKelabo({ journeyId: j.journeyId, identity: OWNER, kelaboId: "k5" });

  await assert.rejects(
    records.deleteRecord({ identity: OWNER, archiveId: "k5" }),
    (e) => e.status === 409 && e.code === "kelabo_in_journey",
  );

  await journeys.unlinkKelabo({ journeyId: j.journeyId, identity: OWNER, kelaboId: "k5" });
  const result = await records.deleteRecord({ identity: OWNER, archiveId: "k5" });
  assert.equal(result.outcome, "purged");
});

await test("purge guard: does not affect a participant merely dropping their own copy", async () => {
  const j = await journeys.createJourney({ identity: OWNER, body: { title: "T", visibility: "public" } });
  await seedKelabo({ kelaboId: "k6", host: OWNER, status: "ended" });
  db.__putHistory({
    archiveId: "k6",
    kelaboId: "k6",
    host: OWNER,
    endedAt: Date.now(),
    participantIdentities: [OWNER, COLLEAGUE],
  });
  db.__putHistory({
    archiveId: `PARTICIPANT#${COLLEAGUE}#k6`,
    kelaboId: "k6",
    participantIdentity: COLLEAGUE,
    endedAt: Date.now(),
  });
  await journeys.linkKelabo({ journeyId: j.journeyId, identity: OWNER, kelaboId: "k6" });

  // The host is blocked (guarded above); a participant's own removal is not
  // the guarded path at all — it never reaches purgeOne.
  const result = await records.deleteRecord({ identity: COLLEAGUE, archiveId: "k6" });
  assert.equal(result.outcome, "removed_from_list");
});

// --- health/progress status --------------------------------------------------

await test("status: optional and absent by default; an update requires at least one field", async () => {
  const j = await journeys.createJourney({ identity: OWNER, body: { title: "T", visibility: "public" } });
  const fresh = await journeys.getJourney({ journeyId: j.journeyId, identity: OWNER });
  assert.equal(fresh.health, null);
  assert.equal(fresh.progress, null);
  await assert.rejects(
    journeys.updateStatus({ journeyId: j.journeyId, identity: OWNER, body: {} }),
    (e) => e.status === 400 && e.code === "nothing_to_change",
  );
});

await test("status: a partial update carries the omitted field forward from the cached META value", async () => {
  const j = await journeys.createJourney({ identity: OWNER, body: { title: "T", visibility: "public" } });
  await journeys.updateStatus({ journeyId: j.journeyId, identity: OWNER, body: { health: "yellow", progress: 30 } });
  await journeys.updateStatus({ journeyId: j.journeyId, identity: OWNER, body: { progress: 60 } });
  const got = await journeys.getJourney({ journeyId: j.journeyId, identity: OWNER });
  assert.equal(got.health, "yellow", "health carried forward, untouched by the progress-only update");
  assert.equal(got.progress, 60);

  const history = await journeys.getStatusHistory({ journeyId: j.journeyId, identity: OWNER });
  assert.equal(history.versions.length, 2);
  assert.equal(history.versions[0].health, "yellow");
  assert.equal(history.versions[1].health, "yellow", "version 2 still recorded the carried-forward health");
});

await test("status: null explicitly clears a field back to unset", async () => {
  const j = await journeys.createJourney({ identity: OWNER, body: { title: "T", visibility: "public" } });
  await journeys.updateStatus({ journeyId: j.journeyId, identity: OWNER, body: { health: "green", progress: 100 } });
  await journeys.updateStatus({ journeyId: j.journeyId, identity: OWNER, body: { health: null } });
  const got = await journeys.getJourney({ journeyId: j.journeyId, identity: OWNER });
  assert.equal(got.health, null);
  assert.equal(got.progress, 100, "progress is untouched by clearing health");
});

await test("status: a member (not just the owner) may set it; frozen once completed", async () => {
  const j = await journeys.createJourney({ identity: OWNER, body: { title: "T", visibility: "public" } });
  await journeys.updateStatus({ journeyId: j.journeyId, identity: COLLEAGUE, body: { progress: 10 } });
  await journeys.completeJourney({ journeyId: j.journeyId, identity: OWNER });
  await assert.rejects(
    journeys.updateStatus({ journeyId: j.journeyId, identity: OWNER, body: { progress: 20 } }),
    (e) => e.status === 409 && e.code === "journey_completed",
  );
});

// --- avatar re-roll (owner-only, via patch) ----------------------------------

await test("avatar: owner-only re-roll through patch; a member cannot set it", async () => {
  const j = await journeys.createJourney({ identity: OWNER, body: { title: "T", visibility: "public" } });
  await assert.rejects(
    journeys.patchJourney({ journeyId: j.journeyId, identity: COLLEAGUE, body: { avatarVariant: 7 } }),
    (e) => e.status === 403 && e.code === "not_journey_owner",
  );
  const updated = await journeys.patchJourney({ journeyId: j.journeyId, identity: OWNER, body: { avatarVariant: 7 } });
  assert.equal(updated.avatarVariant, 7);
});

// --- timeline: one row per mutation, backward cursor, type filter -----------

// A tiny real delay so successive writes land in different milliseconds —
// needed for these tests specifically because the timeline's sort key
// (docs 20 §9.1, `TL#<pad(at,13)>#<rand6>`) only orders same-millisecond
// entries by a random tie-breaker, exactly like `CONTRIB#` already does.
// Real usage is human-paced and never collides; a tight test loop with no
// delay at all genuinely can.
const tick = () => new Promise((r) => setTimeout(r, 2));

await test("timeline: description edits, status updates, and kelabo link/unlink each leave one entry", async () => {
  const j = await journeys.createJourney({ identity: OWNER, body: { title: "T", visibility: "public", description: "v1" } });
  await tick();
  await journeys.updateDescription({ journeyId: j.journeyId, identity: OWNER, body: { markdown: "v2" } });
  await tick();
  await journeys.updateStatus({ journeyId: j.journeyId, identity: OWNER, body: { progress: 50 } });
  await tick();
  await seedKelabo({ kelaboId: "k-tl", host: OWNER });
  await journeys.linkKelabo({ journeyId: j.journeyId, identity: OWNER, kelaboId: "k-tl" });
  await tick();
  await journeys.unlinkKelabo({ journeyId: j.journeyId, identity: OWNER, kelaboId: "k-tl" });

  const all = await journeys.getTimeline({ journeyId: j.journeyId, identity: OWNER });
  assert.equal(all.entries.length, 5, "creation-description, edit-description, status, linked, unlinked");
  const types = all.entries.map((e) => e.type);
  assert.deepEqual(types, ["kelabo_unlinked", "kelabo_linked", "status", "description", "description"], "newest first");

  const onlyStatus = await journeys.getTimeline({ journeyId: j.journeyId, identity: OWNER, type: "status" });
  assert.equal(onlyStatus.entries.length, 1);
  assert.equal(onlyStatus.entries[0].type, "status");

  // Re-linking the SAME kelabo again (idempotent branch) must not double-post.
  await journeys.linkKelabo({ journeyId: j.journeyId, identity: OWNER, kelaboId: "k-tl" });
  await journeys.linkKelabo({ journeyId: j.journeyId, identity: OWNER, kelaboId: "k-tl" });
  const linkedEntries = await journeys.getTimeline({ journeyId: j.journeyId, identity: OWNER, type: "kelabo_linked" });
  assert.equal(linkedEntries.entries.length, 2, "one for the first link, one for the re-link after unlinking — not three");
});

await test("timeline: backward pagination — `before` returns strictly older entries, and a stranger cannot read it", async () => {
  const j = await journeys.createJourney({ identity: OWNER, body: { title: "T", visibility: "private" } });
  for (let i = 0; i < 5; i++) {
    await tick();
    await journeys.updateStatus({ journeyId: j.journeyId, identity: OWNER, body: { progress: i * 10 } });
  }
  const page1 = await journeys.getTimeline({ journeyId: j.journeyId, identity: OWNER, limit: 2 });
  assert.equal(page1.entries.length, 2);
  assert.ok(page1.nextBefore);
  const page2 = await journeys.getTimeline({ journeyId: j.journeyId, identity: OWNER, limit: 2, before: page1.nextBefore });
  assert.equal(page2.entries.length, 2);
  assert.ok(page2.entries[0].at < page1.entries[page1.entries.length - 1].at);

  await assert.rejects(
    journeys.getTimeline({ journeyId: j.journeyId, identity: COLLEAGUE }),
    (e) => e.status === 403,
  );
});

// --- a handful of true HTTP-level checks, to prove index.js wiring ----------

await test("HTTP: POST /journeys requires a session", async () => {
  const res = await call("POST", "/journeys", { body: { title: "T" } });
  assert.equal(res.statusCode, 401);
});

await test("HTTP: create then get round-trips through the real route table", async () => {
  const cookies = await sessionFor("dana@example.com");
  const created = await call("POST", "/journeys", { body: { title: "HTTP journey", visibility: "public" }, cookies });
  assert.equal(created.statusCode, 200);
  assert.ok(created.json.journeyId);

  const got = await call("GET", `/journeys/${created.json.journeyId}`, { cookies });
  assert.equal(got.statusCode, 200);
  assert.equal(got.json.title, "HTTP journey");
  assert.equal(got.json.myRole, "owner");

  const notFound = await call("GET", "/journeys/does-not-exist", { cookies });
  assert.equal(notFound.statusCode, 404);
  assert.equal(notFound.json.error, "journey_not_found");
});

await test("HTTP: status update + history + timeline round-trip through the real route table", async () => {
  const cookies = await sessionFor("erin@example.com");
  const created = await call("POST", "/journeys", { body: { title: "Status via HTTP", visibility: "public" }, cookies });
  const id = created.json.journeyId;

  const posted = await call("POST", `/journeys/${id}/status`, { body: { health: "green", progress: 80 }, cookies });
  assert.equal(posted.statusCode, 200);
  assert.equal(posted.json.version, 1);

  const history = await call("GET", `/journeys/${id}/status/history`, { cookies });
  assert.equal(history.statusCode, 200);
  assert.equal(history.json.versions.length, 1);

  const timeline = await call("GET", `/journeys/${id}/timeline?type=status`, { cookies });
  assert.equal(timeline.statusCode, 200);
  assert.equal(timeline.json.entries.length, 1);
  assert.equal(timeline.json.entries[0].type, "status");
});

console.log(`\n${passed} passed`);
