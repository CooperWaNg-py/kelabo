// What the assistant is told about the journey(s) a live kelabo belongs to
// (docs 20 §12.1) — the PUSH half, pinned into the system prompt the same
// way agent/history.js already pins a host's own past-kelabo minutes.
// Independent and additive to that: a kelabo can have historyEnabled on,
// be linked to a journey, both, or neither (docs 20 §1). The PULL half
// (dev-mode MCP tools for deeper, on-demand reads) is not built.
//
// Reuses gateway/src/journeys.js's own reducers — the same rows a journey
// report reads — rather than a second copy of the same reduction.
import { queryKelaboItems } from "../db.js";
import { getJourneyMeta, latestDescription, activeBoardMessages, linkedKelaboSummaries } from "../journeys.js";

// Small on purpose, the same reasoning as HISTORY_LIMIT (history.js): this
// is pinned into the system prompt for EVERY turn of the kelabo, so its
// cost is paid continuously, not once on request like a report's context.
export const JOURNEY_LIMIT = 3;
const BOARD_LIMIT = 5;
const OTHER_KELABOS_LIMIT = 5;
const clip = (s, n) => (typeof s === "string" && s.length > n ? s.slice(0, n) + "…" : s || "");

/**
 * Every journey `kelaboId` is linked to (docs 20 §4.3's mirror on the
 * kelabo's own partition — no new table, no new query shape:
 * `queryKelaboItems` already answers `begins_with(SK, "JOURNEY#")`), each
 * reduced to a small, per-turn-affordable digest.
 */
export async function loadJourneyContext(c, kelaboId) {
  const links = await queryKelaboItems(c, kelaboId, "JOURNEY#").catch(() => []);
  const chosen = links.slice(0, JOURNEY_LIMIT);
  const journeys = await Promise.all(
    chosen.map(async (link) => {
      const journeyId = link.journeyId;
      const [meta, description, board, kelabos] = await Promise.all([
        getJourneyMeta(c, journeyId).catch(() => null),
        latestDescription(c, journeyId).catch(() => ""),
        activeBoardMessages(c, journeyId, BOARD_LIMIT).catch(() => []),
        linkedKelaboSummaries(c, journeyId).catch(() => []),
      ]);
      if (!meta) return null;
      // A kelabo with nothing to say (no minutes yet, or the live kelabo
      // itself) contributes noise, not context — the same reasoning
      // history.js already applies to a host's own past kelabos.
      const others = kelabos
        .filter((k) => k.kelaboId !== kelaboId && (k.summary || k.decisions.length || k.actionItems.length))
        .slice(0, OTHER_KELABOS_LIMIT);
      return {
        title: meta.title,
        description: clip(description, 1500),
        health: meta.health || null,
        progress: typeof meta.progress === "number" ? meta.progress : null,
        board: board.map((m) => clip(m.content, 300)),
        kelabos: others,
      };
    })
  );
  return journeys.filter(Boolean);
}
