// How full a mesh room is. Pure, in the style of spa/src/rtc/reconcile.js:
// the decision lives here so gateway/test/rtc.mjs can pin it without a live
// kelabo, and so the join path and the screen-share path cannot drift apart.
//
// Mesh capacity is counted in *units*, not seats. A participant is one unit;
// an active screen share is one more, because in a mesh a share is a second
// video uplink to every other peer — the exact cost the cap exists to bound.
// The SFU relays media through Cloudflare's edge and is not capped at all.

/**
 * Units currently occupied: one per peer plus one per active screen share.
 * @param {Iterable<{media?: {screen?: boolean}}>} peers
 */
export function meshUnits(peers) {
  let units = 0;
  for (const p of peers) {
    units += 1;
    if (p?.media?.screen) units += 1;
  }
  return units;
}

/**
 * May one more unit (a joiner, or a screen share) be admitted?
 *
 * Only `mesh` rooms are capped, and a non-positive cap means uncapped — the
 * self-host escape hatch, not a way to close a room.
 */
export function meshHasRoom({ mode, meshMax, units, adding = 1 }) {
  if (mode !== "mesh") return true;
  if (!(meshMax > 0)) return true;
  return units + adding <= meshMax;
}
