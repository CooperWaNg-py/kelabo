// What an assistant remembers of earlier kelabos (notes #3): the host's past
// kelabos, each reduced to its minutes. Off unless the host opted in when they
// created the kelabo (`historyEnabled` on the META), and read from the host's
// own participant index — the same set of kelabos they can already open — so
// this never widens what anybody can reach, only what the assistant has
// already been told about.
//
// Minutes, not transcripts. A summary of eight kelabos is a few thousand
// tokens and is what "what did we decide last time" actually wants; eight full
// transcripts would be most of a context window spent on kelabos nobody asked
// about, on every single turn.
//
// Shared by both agent modes on purpose: the in-ECS agent pins this into its
// system prompt (runner.js), and the dev-mode bridge reads it over the tunnel
// (`kelabo_history`, tunnel.js). One loader means the host's opt-in grants
// exactly one record, whichever brain is attached.
import { getMinutes, queryPastKelabos } from "../db.js";

// How many past kelabos the assistant is given. Small on purpose: for the
// in-ECS agent these are pinned into the system prompt for every turn of the
// kelabo, so the cost is paid continuously, and the eighth-most-recent kelabo
// is already well past the point where "last time" means anything.
export const HISTORY_LIMIT = 8;

/** The host's recent kelabos, each reduced to what a summary is for. */
export async function loadKelaboHistory(c, kelaboId, meta) {
  const rows = await queryPastKelabos(c, meta.hostIdentity, {
    limit: HISTORY_LIMIT,
    exclude: kelaboId,
  });
  const withMinutes = await Promise.all(
    rows.map(async (row) => {
      const minutes = await getMinutes(c, row.kelaboId).catch(() => null);
      return {
        kelaboId: row.kelaboId,
        title: minutes?.title || row.title || "Untitled kelabo",
        endedAt: row.endedAt ?? null,
        summary: minutes?.summary || "",
        // Decisions and action items are the two things people come back for
        // by name ("did we agree to…", "who was picking that up"). Topics are
        // left out: the summary already narrates them, and repeating them as
        // a list is the index-not-a-write-up failure the minutes schema was
        // rewritten to avoid.
        decisions: (minutes?.decisions ?? []).map((d) => (typeof d === "string" ? d : d.text)).filter(Boolean),
        actionItems: (minutes?.actionItems ?? [])
          .map((a) => (typeof a === "string" ? a : [a.text, a.owner && `(${a.owner})`].filter(Boolean).join(" ")))
          .filter(Boolean),
      };
    })
  );
  // A kelabo with no minutes at all contributes a title and a date, which is
  // worse than nothing: it invites the model to guess what was in it.
  return withMinutes.filter((m) => m.summary || m.decisions.length || m.actionItems.length);
}
