import { randomUUID } from "node:crypto";
import { JOURNEY_VISIBILITIES } from "@kelabo/contracts";
import { err } from "./errors.js";

/**
 * Journey (docs 20): a persistent container linking related kelabos so
 * description, decisions and Q&A history carry from one meeting to the
 * next, for the people in the room and the agent listening.
 *
 * Visibility decides access, and nothing is stored to grant the common
 * case: a `public` journey is fully open to every identity whose
 * `tenantId` matches the journey's — no roster, computed fresh per
 * request, the same derivation doc 18 already uses for "same org". A
 * `private` journey keeps an explicit `ACCESSOR#` roster; being on it
 * grants the same rights minus managing that roster, which — like delete,
 * visibility and complete/reopen — stays owner-only (docs 20 §3.3).
 */
export function createJourneys({ config, db }) {
  const tenantOf = (identity) => identity.split("@")[1].toLowerCase();

  // A conditional write that lost its guard surfaces either as a bare
  // ConditionalCheckFailedException or, inside a transaction, as a
  // TransactionCanceledException — the same shape scheduling.js already
  // checks for.
  const isConditionFailure = (e) =>
    e.name === "ConditionalCheckFailedException" ||
    (e.name === "TransactionCanceledException" &&
      (e.CancellationReasons || []).some((r) => r.Code === "ConditionalCheckFailed"));

  function toSummary(meta) {
    return {
      journeyId: meta.journeyId,
      title: meta.title,
      status: meta.status,
      visibility: meta.visibility,
      ownerIdentity: meta.ownerIdentity,
      avatarVariant: meta.avatarVariant || 0,
      // Optional (docs 20 §5): absent means genuinely unset, not 0%/red.
      health: meta.health ?? null,
      progress: meta.progress ?? null,
      kelaboCount: meta.kelaboCount || 0,
      documentCount: meta.documentCount || 0,
      reportCount: meta.reportCount || 0,
      accessorCount: meta.accessorCount || 0,
      createdAt: meta.createdAt,
      updatedAt: meta.updatedAt,
      completedAt: meta.completedAt || null,
    };
  }

  /**
   * Fresh, per-request access check (docs 20 §3.2) — no cached membership
   * flag, matching how host/participant checks already work on `kelabos`.
   * Order: owner, then public-tenant-match, then private-accessor lookup.
   */
  async function resolveAccess(meta, identity) {
    if (!identity) return { role: "none" };
    if (identity === meta.ownerIdentity) return { role: "owner" };
    if (meta.visibility === "public" && tenantOf(identity) === meta.tenantId) return { role: "member" };
    if (meta.visibility === "private") {
      const accessor = await db.getAccessor(meta.journeyId, identity);
      if (accessor) return { role: "member" };
    }
    return { role: "none" };
  }

  async function requireJourney(journeyId) {
    const meta = await db.getJourneyMeta(journeyId);
    if (!meta) throw err(404, "journey_not_found");
    return meta;
  }

  /** Owner or member; 403 otherwise. Returns the resolved role. */
  async function requireMember(meta, identity) {
    const access = await resolveAccess(meta, identity);
    if (access.role === "none") throw err(403, "forbidden");
    return access.role;
  }

  function requireOwner(meta, identity) {
    if (meta.ownerIdentity !== identity) throw err(403, "not_journey_owner");
  }

  /** Completion freezes every write, no exception (docs 20 §3.1). */
  function requireActive(meta) {
    if (meta.status === "completed") throw err(409, "journey_completed");
  }

  async function createJourney({ identity, body }) {
    const tenantId = tenantOf(identity);
    const now = Date.now();
    const journeyId = randomUUID();
    const visibility = JOURNEY_VISIBILITIES.includes(body.visibility) ? body.visibility : "private";
    const meta = {
      journeyId,
      title: body.title.trim(),
      status: "active",
      visibility,
      ownerIdentity: identity,
      tenantId,
      tenantStatus: `${tenantId}#active`,
      avatarVariant: 0,
      currentDescriptionVersion: 0,
      kelaboCount: 0,
      documentCount: 0,
      reportCount: 0,
      accessorCount: 0,
      createdAt: now,
      updatedAt: now,
    };
    await db.createJourney(meta);
    if (typeof body.description === "string" && body.description.trim()) {
      await writeDescriptionVersion({ meta, identity, markdown: body.description.trim() });
    }
    return { journeyId, title: meta.title, status: meta.status, visibility };
  }

  async function listJourneys({ identity }) {
    const tenantId = tenantOf(identity);
    const [tenantActive, accessorLinks] = await Promise.all([
      db.listJourneysByTenantStatus(tenantId, "active"),
      db.listAccessorJourneys(identity),
    ]);
    const mine = tenantActive.filter((m) => m.ownerIdentity === identity).map(toSummary);
    const mineIds = new Set(mine.map((m) => m.journeyId));

    const accessorMetas = await Promise.all(
      accessorLinks.map((l) => db.getJourneyMeta(String(l.PK).slice("JOURNEY#".length)))
    );
    const accessible = accessorMetas
      .filter((m) => m && !mineIds.has(m.journeyId))
      .map(toSummary);

    const publicJourneys = tenantActive
      .filter((m) => m.visibility === "public" && !mineIds.has(m.journeyId))
      .map(toSummary);

    return { mine, accessible, public: publicJourneys };
  }

  async function getJourney({ journeyId, identity }) {
    const meta = await requireJourney(journeyId);
    const role = await requireMember(meta, identity);
    return { ...toSummary(meta), myRole: role };
  }

  async function patchJourney({ journeyId, identity, body }) {
    const meta = await requireJourney(journeyId);
    requireOwner(meta, identity);
    const updates = {};
    if (typeof body.title === "string" && body.title.trim()) updates.title = body.title.trim();
    if (JOURNEY_VISIBILITIES.includes(body.visibility)) updates.visibility = body.visibility;
    if (typeof body.avatarVariant === "number") updates.avatarVariant = body.avatarVariant;
    if (Object.keys(updates).length === 0) throw err(400, "nothing_to_change");
    updates.updatedAt = Date.now();
    await db.updateJourneyMeta(journeyId, updates);
    return toSummary({ ...meta, ...updates });
  }

  async function completeJourney({ journeyId, identity }) {
    const meta = await requireJourney(journeyId);
    requireOwner(meta, identity);
    // Idempotent: a second click should land on "completed", not an error.
    if (meta.status === "completed") return { journeyId, status: "completed" };
    try {
      await db.completeJourney({
        journeyId,
        tenantId: meta.tenantId,
        completedAt: Date.now(),
        completedBy: identity,
      });
    } catch (e) {
      if (!isConditionFailure(e)) throw e;
      throw err(409, "journey_completed");
    }
    return { journeyId, status: "completed" };
  }

  async function reopenJourney({ journeyId, identity }) {
    const meta = await requireJourney(journeyId);
    requireOwner(meta, identity);
    if (meta.status === "active") return { journeyId, status: "active" };
    try {
      await db.reopenJourney({ journeyId, tenantId: meta.tenantId, reopenedAt: Date.now() });
    } catch (e) {
      if (!isConditionFailure(e)) throw e;
      throw err(409, "not_completed");
    }
    return { journeyId, status: "active" };
  }

  /**
   * Irreversibly delete a journey and everything it owns. Kelabos it was
   * linked to are never touched — only their mirror of this journey goes
   * (docs 20 §14.1). Owner-only, allowed even while completed (deleting a
   * completed journey is not a "write" the freeze in §3.1 is about).
   */
  async function deleteJourney({ journeyId, identity }) {
    const meta = await requireJourney(journeyId);
    requireOwner(meta, identity);
    const links = await db.listJourneyLinks(journeyId);
    await db.deleteJourneyChildren(journeyId);
    for (const link of links) {
      await db.deleteKelaboJourneyMirror(link.kelaboId, journeyId).catch(() => {});
    }
    // META last: a crash before this point leaves a resumable job (the
    // journey still exists and can be deleted again), never an orphan.
    await db.deleteJourneyMeta(journeyId);
    return { journeyId, deleted: true, kelabosUnlinked: links.length };
  }

  // --- accessors (private journeys only) -------------------------------------

  async function listAccessors({ journeyId, identity }) {
    const meta = await requireJourney(journeyId);
    await requireMember(meta, identity);
    const rows = await db.listAccessors(journeyId);
    return { accessors: rows.map((r) => ({ identity: r.identity, addedBy: r.addedBy, addedAt: r.addedAt })) };
  }

  async function addAccessor({ journeyId, identity, body }) {
    const meta = await requireJourney(journeyId);
    requireOwner(meta, identity);
    requireActive(meta);
    if (meta.visibility !== "private") throw err(409, "not_private");
    const target = body.identity.trim().toLowerCase();
    const existing = await db.getAccessor(journeyId, target);
    if (!existing) {
      const now = Date.now();
      await db.putAccessor(journeyId, { identity: target, addedBy: identity, addedAt: now });
      await db.updateJourneyMeta(journeyId, { accessorCount: (meta.accessorCount || 0) + 1, updatedAt: now });
    }
    return { journeyId, identity: target };
  }

  async function removeAccessor({ journeyId, identity, target }) {
    const meta = await requireJourney(journeyId);
    requireOwner(meta, identity);
    requireActive(meta);
    const existing = await db.getAccessor(journeyId, target);
    if (existing) {
      await db.removeAccessor(journeyId, target);
      await db.updateJourneyMeta(journeyId, {
        accessorCount: Math.max(0, (meta.accessorCount || 0) - 1),
        updatedAt: Date.now(),
      });
    }
    return { journeyId, identity: target };
  }

  // --- kelabo membership ------------------------------------------------------

  /**
   * Link an existing kelabo into a journey. The actor must be a member of
   * the journey (public-tenant or private-accessor) AND host/participant of
   * the kelabo being linked — the first authorizes touching this journey,
   * the second stops pulling in a kelabo you had nothing to do with.
   */
  async function linkKelabo({ journeyId, identity, kelaboId }) {
    const meta = await requireJourney(journeyId);
    await requireMember(meta, identity);
    requireActive(meta);
    const kelaboMeta = await db.getKelaboMeta(kelaboId);
    if (!kelaboMeta) throw err(404, "kelabo_not_found");
    const isTargetMember =
      kelaboMeta.hostIdentity === identity ||
      (kelaboMeta.participants || []).some((p) => p.identity === identity);
    if (!isTargetMember) throw err(403, "not_kelabo_member");

    const now = Date.now();
    try {
      await db.linkKelaboToJourney({
        journeyId,
        kelaboId,
        link: {
          kelaboId,
          titleSnapshot: kelaboMeta.title,
          hostIdentitySnapshot: kelaboMeta.hostIdentity,
          linkedBy: identity,
          linkedAt: now,
          statusSnapshot: kelaboMeta.status,
        },
        mirror: {
          journeyId,
          journeyTitleSnapshot: meta.title,
          journeyVisibilitySnapshot: meta.visibility,
          linkedAt: now,
          linkedBy: identity,
        },
      });
    } catch (e) {
      if (!isConditionFailure(e)) throw e;
      // Either already linked (idempotent — land on "linked", not an error)
      // or the journey completed mid-request.
      const existing = await db.getJourneyLink(journeyId, kelaboId);
      if (existing) return { journeyId, kelaboId, linked: true };
      throw err(409, "journey_completed");
    }
    // Only on a genuine new link — the idempotent branch above must not
    // double-post the same event to the timeline.
    await db.putJourneyTimelineEntry(journeyId, {
      type: "kelabo_linked",
      summary: `Linked kelabo: ${kelaboMeta.title}`,
      actor: identity,
      at: now,
      detail: { kelaboId },
    });
    return { journeyId, kelaboId, linked: true };
  }

  async function unlinkKelabo({ journeyId, identity, kelaboId }) {
    const meta = await requireJourney(journeyId);
    await requireMember(meta, identity);
    const link = await db.getJourneyLink(journeyId, kelaboId);
    if (!link) throw err(404, "kelabo_not_found");
    await db.unlinkKelaboFromJourney({ journeyId, kelaboId, now: Date.now() });
    await db.putJourneyTimelineEntry(journeyId, {
      type: "kelabo_unlinked",
      summary: `Unlinked kelabo: ${link.titleSnapshot}`,
      actor: identity,
      at: Date.now(),
      detail: { kelaboId },
    });
    return { journeyId, kelaboId, unlinked: true };
  }

  async function listLinkedKelabos({ journeyId, identity }) {
    const meta = await requireJourney(journeyId);
    await requireMember(meta, identity);
    const links = await db.listJourneyLinks(journeyId);
    return {
      kelabos: links.map((l) => ({
        kelaboId: l.kelaboId,
        title: l.titleSnapshot,
        hostIdentity: l.hostIdentitySnapshot,
        linkedBy: l.linkedBy,
        linkedAt: l.linkedAt,
        statusSnapshot: l.statusSnapshot,
      })),
    };
  }

  // --- description (versioned) ------------------------------------------------

  async function writeDescriptionVersion({ meta, identity, markdown, changeNote }) {
    const version = (meta.currentDescriptionVersion || 0) + 1;
    const now = Date.now();
    await db.putJourneyDescriptionVersion(meta.journeyId, {
      version,
      markdown,
      editedBy: identity,
      editedAt: now,
      ...(changeNote ? { changeNote } : {}),
    });
    await db.updateJourneyMeta(meta.journeyId, { currentDescriptionVersion: version, updatedAt: now });
    await db.putJourneyTimelineEntry(meta.journeyId, {
      type: "description",
      summary: changeNote ? `Description updated — ${changeNote}` : "Description updated",
      actor: identity,
      at: now,
      detail: { version },
    });
    return version;
  }

  // --- health/progress status (docs 20 §5) ------------------------------------

  /**
   * One combined snapshot per update — health and progress are reported
   * together, not as two independently-drifting fields. An omitted field
   * carries forward from META's own cached copy of the current value;
   * `null` explicitly clears it, which `updateJourneyMeta` turns into a
   * REMOVE (docs 20 §5's "genuinely absent, not defaulted").
   */
  async function writeStatusVersion({ meta, identity, health, progress, note, source, reportId }) {
    const version = (meta.currentStatusVersion || 0) + 1;
    const now = Date.now();
    const resolvedHealth = health !== undefined ? health : meta.health ?? null;
    const resolvedProgress = progress !== undefined ? progress : meta.progress ?? null;
    await db.putJourneyStatusVersion(meta.journeyId, {
      version,
      health: resolvedHealth,
      progress: resolvedProgress,
      ...(note ? { note } : {}),
      setBy: identity,
      setAt: now,
      source: source || "manual",
      ...(reportId ? { reportId } : {}),
    });
    await db.updateJourneyMeta(meta.journeyId, {
      currentStatusVersion: version,
      health: resolvedHealth,
      progress: resolvedProgress,
      updatedAt: now,
    });
    const parts = [];
    if (health !== undefined) parts.push(`health: ${resolvedHealth ?? "cleared"}`);
    if (progress !== undefined) parts.push(`progress: ${resolvedProgress ?? "cleared"}`);
    await db.putJourneyTimelineEntry(meta.journeyId, {
      type: "status",
      summary: parts.length ? `Status updated (${parts.join(", ")})` : "Status updated",
      actor: identity,
      at: now,
      detail: { version, health: resolvedHealth, progress: resolvedProgress },
    });
    return version;
  }

  async function updateStatus({ journeyId, identity, body }) {
    const meta = await requireJourney(journeyId);
    await requireMember(meta, identity);
    requireActive(meta);
    if (body.health === undefined && body.progress === undefined && body.note === undefined) {
      throw err(400, "nothing_to_change");
    }
    const version = await writeStatusVersion({
      meta,
      identity,
      health: body.health,
      progress: body.progress,
      note: body.note?.trim() || undefined,
    });
    return { journeyId, version };
  }

  async function getStatusHistory({ journeyId, identity }) {
    const meta = await requireJourney(journeyId);
    await requireMember(meta, identity);
    const versions = await db.listJourneyStatusVersions(journeyId);
    return { versions: versions.map(({ PK, SK, ...v }) => v) };
  }

  // --- timeline (docs 20 §9) ---------------------------------------------------

  async function getTimeline({ journeyId, identity, type, before, limit }) {
    const meta = await requireJourney(journeyId);
    await requireMember(meta, identity);
    const items = await db.listJourneyTimeline(journeyId, { type, before, limit: limit || 50 });
    const entries = items.map(({ PK, SK, ...e }) => e);
    const nextBefore = entries.length ? entries[entries.length - 1].at : undefined;
    return { entries, ...(nextBefore !== undefined ? { nextBefore } : {}) };
  }

  async function updateDescription({ journeyId, identity, body }) {
    const meta = await requireJourney(journeyId);
    await requireMember(meta, identity);
    requireActive(meta);
    const version = await writeDescriptionVersion({
      meta,
      identity,
      markdown: body.markdown.trim(),
      changeNote: body.changeNote?.trim() || undefined,
    });
    return { journeyId, version };
  }

  async function getDescriptionHistory({ journeyId, identity }) {
    const meta = await requireJourney(journeyId);
    await requireMember(meta, identity);
    const versions = await db.listJourneyDescriptionVersions(journeyId);
    return { versions: versions.map(({ PK, SK, ...v }) => v) };
  }

  return {
    createJourney,
    listJourneys,
    getJourney,
    patchJourney,
    completeJourney,
    reopenJourney,
    deleteJourney,
    listAccessors,
    addAccessor,
    removeAccessor,
    linkKelabo,
    unlinkKelabo,
    listLinkedKelabos,
    updateDescription,
    getDescriptionHistory,
    updateStatus,
    getStatusHistory,
    getTimeline,
  };
}
