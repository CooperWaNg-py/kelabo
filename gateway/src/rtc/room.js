import { RTC_MODES } from "@kelabo/contracts";
import { getMeta } from "../db.js";

// Per-kelabo conference presence. Deliberately in-process and unpersisted, for
// the same reason as sseSubscribers: it is a view of who currently holds a live
// connection, and a task restart rebuilds it as clients reconnect. The durable
// half — which transport the kelabo uses — lives on the kelabo META as
// `rtcMode`, written once at creation by the REST API.

/**
 * @typedef {object} Peer
 * @property {string} participantId
 * @property {string} displayName
 * @property {boolean} isGuest
 * @property {string} [sfuSessionId]  Cloudflare session, sfu mode only
 * @property {Record<string,string>} tracks  media kind -> published track name
 * @property {number} joinedAt
 */

export function createRtcRoom(c) {
  const meshMax = c.config.rtc.meshMaxParticipants;

  function room(kelaboId) {
    return c.state.rtcRooms.get(kelaboId) ?? null;
  }

  /** Resolve (and cache) the kelabo's transport from its META. */
  async function modeFor(kelaboId) {
    const existing = room(kelaboId);
    if (existing) return existing.mode;
    const meta = await getMeta(c, kelaboId).catch(() => null);
    const mode = RTC_MODES.includes(meta?.rtcMode) ? meta.rtcMode : c.config.rtc.defaultMode;
    return mode;
  }

  function ensureRoom(kelaboId, mode) {
    let r = room(kelaboId);
    if (!r) {
      r = { mode, peers: new Map() };
      c.state.rtcRooms.set(kelaboId, r);
    }
    return r;
  }

  function roster(kelaboId) {
    const r = room(kelaboId);
    if (!r) return [];
    return [...r.peers.values()].map(toWire);
  }

  function toWire(p) {
    return {
      participantId: p.participantId,
      displayName: p.displayName,
      avatarVariant: p.avatarVariant || 0,
      isGuest: p.isGuest,
      sfuSessionId: p.sfuSessionId,
      tracks: { ...p.tracks },
      media: { ...p.media },
      joinedAt: p.joinedAt,
    };
  }

  function peer(kelaboId, participantId) {
    return room(kelaboId)?.peers.get(participantId) ?? null;
  }

  /**
   * Register a participant on the call.
   * @returns {{ ok:true, mode:string, self:Peer, peers:object[] }
   *          | { ok:false, code:string, status:number, detail?:object }}
   */
  async function join({ kelaboId, participantId, displayName, avatarVariant, isGuest }) {
    const mode = await modeFor(kelaboId);
    const r = ensureRoom(kelaboId, mode);

    const rejoining = r.peers.has(participantId);
    // Mesh is a hard cap, not a soft one: silently spilling over to the SFU
    // would revoke the peer-to-peer guarantee the host chose, so the join is
    // refused instead. Rejoining an existing seat never counts against it.
    if (r.mode === "mesh" && !rejoining && r.peers.size >= meshMax) {
      return { ok: false, code: "mesh_room_full", status: 409, detail: { meshMax } };
    }

    const self = r.peers.get(participantId) ?? {
      participantId,
      displayName: displayName || participantId,
      avatarVariant: Number(avatarVariant) || 0,
      isGuest: !!isGuest,
      sfuSessionId: undefined,
      tracks: {},
      // Switched on until told otherwise, for both: "on" is the value that
      // makes the tiles behave exactly as they did before this field existed,
      // reading the track and nothing else. Defaulting to "off" would put a
      // mic badge on everyone for the moment between joining and their first
      // report, and — worse during a rollout — would hide the camera of any
      // peer still on a bundle that does not know to report at all.
      media: { audio: true, video: true },
      joinedAt: Date.now(),
    };
    self.displayName = displayName || self.displayName;
    r.peers.set(participantId, self);

    // The joiner gets the roster in its /rtc/join response; everyone already in
    // the room learns about them here. Peers decide who dials whom (mesh) or
    // which tracks to pull (sfu) from this event.
    c.sseHub.rtc(kelaboId, { kind: "peer_joined", peer: toWire(self) });
    c.log("rtc_join", { kelaboId, participantId, mode: r.mode, peers: r.peers.size });

    return {
      ok: true,
      mode: r.mode,
      self: toWire(self),
      peers: [...r.peers.values()].filter((p) => p.participantId !== participantId).map(toWire),
    };
  }

  /**
   * Bind the Cloudflare session created for this participant (sfu mode).
   *
   * A *new* session id means the old one is gone, and with it every track that
   * was published on it. The roster has to forget them in the same breath:
   * `tracks` only ever accumulated before, so a participant who rebuilt their
   * session — after a reload, or after Cloudflare declared the old one
   * disconnected — kept advertising tracks that no longer existed anywhere.
   * Every other participant went on pulling them for the rest of the kelabo,
   * once per reconcile tick, and got `not_found_track_error` every time.
   */
  function bindSfuSession(kelaboId, participantId, sfuSessionId) {
    const p = peer(kelaboId, participantId);
    if (!p) return null;
    const replaced = p.sfuSessionId && p.sfuSessionId !== sfuSessionId;
    p.sfuSessionId = sfuSessionId;
    if (replaced && Object.keys(p.tracks).length) {
      p.tracks = {};
      c.sseHub.rtc(kelaboId, { kind: "tracks", peer: toWire(p) });
      c.log("rtc_tracks_retracted", { kelaboId, participantId });
    }
    return p;
  }

  /**
   * Record tracks this participant now publishes and tell the room, so peers
   * know what to pull. Keyed by media kind, so a video track lands beside
   * the audio one without touching the wire format.
   */
  function announceTracks(kelaboId, participantId, tracks) {
    const p = peer(kelaboId, participantId);
    if (!p) return null;
    let changed = false;
    for (const t of tracks) {
      if (t.location !== "local") continue;
      if (p.tracks[t.kind] === t.trackName) continue;
      p.tracks[t.kind] = t.trackName;
      changed = true;
    }
    if (changed) c.sseHub.rtc(kelaboId, { kind: "tracks", peer: toWire(p) });
    return p;
  }

  /**
   * Record whether this participant's microphone and camera are switched on,
   * and tell the room if it changed.
   *
   * Deliberately separate from `announceTracks`. A published track and a
   * switched-on device are different facts with different lifetimes: the track
   * stays negotiated for the whole kelabo precisely so that toggling a camera
   * costs nothing, so "is there a track" cannot answer "is it on".
   */
  function setMedia(kelaboId, participantId, media) {
    const p = peer(kelaboId, participantId);
    if (!p) return null;
    let changed = false;
    for (const kind of ["audio", "video"]) {
      const next = media[kind];
      if (typeof next !== "boolean" || p.media[kind] === next) continue;
      p.media[kind] = next;
      changed = true;
    }
    if (changed) c.sseHub.rtc(kelaboId, { kind: "media", peer: toWire(p) });
    return p;
  }

  /**
   * Is `sfuSessionId` owned by a peer of this kelabo? This is the check that
   * stops a client pulling from, or interfering with, a session belonging to
   * another kelabo — the Cloudflare docs call out unauthenticated session ids
   * as the main abuse vector for the SFU API.
   */
  function ownsSession(kelaboId, sfuSessionId) {
    const r = room(kelaboId);
    if (!r || !sfuSessionId) return false;
    for (const p of r.peers.values()) if (p.sfuSessionId === sfuSessionId) return true;
    return false;
  }

  /** Remove a participant and tell the room. Idempotent. */
  async function leave(kelaboId, participantId, reason = "left") {
    const r = room(kelaboId);
    const p = r?.peers.get(participantId);
    if (!p) return false;
    r.peers.delete(participantId);
    if (!r.peers.size) c.state.rtcRooms.delete(kelaboId);

    // Best-effort: the SFU also expires idle sessions on its own, so a failure
    // here costs nothing but a little lingering state on Cloudflare's side.
    if (r.mode === "sfu" && p.sfuSessionId && Object.keys(p.tracks).length) {
      try {
        const session = await c.rtc.getSession(p.sfuSessionId);
        const mids = (session.tracks ?? []).filter((t) => t.mid).map((t) => ({ mid: t.mid }));
        if (mids.length) await c.rtc.closeTracks(p.sfuSessionId, { tracks: mids, force: true });
      } catch (err) {
        c.logError("rtc_session_close_failed", err, { kelaboId, participantId });
      }
    }

    c.sseHub.rtc(kelaboId, { kind: "peer_left", participantId, reason });
    c.log("rtc_leave", { kelaboId, participantId, reason, peers: r.peers.size });
    return true;
  }

  // Called by sseHub when a participant's event stream closes. Losing the SSE
  // stream is the only liveness signal we get — /rtc/leave fires on a clean
  // exit, but a closed laptop or a killed tab never sends it.
  function handleDisconnect(kelaboId, participantId) {
    if (!peer(kelaboId, participantId)) return;
    leave(kelaboId, participantId, "disconnected").catch((err) =>
      c.logError("rtc_disconnect_cleanup_failed", err, { kelaboId, participantId }),
    );
  }

  /** Kelabo ended: drop the whole room. The `ended` SSE event is sent separately. */
  function closeKelabo(kelaboId) {
    const r = room(kelaboId);
    if (!r) return;
    c.state.rtcRooms.delete(kelaboId);
    c.log("rtc_room_closed", { kelaboId, peers: r.peers.size });
  }

  return {
    join,
    leave,
    handleDisconnect,
    closeKelabo,
    roster,
    peer,
    bindSfuSession,
    announceTracks,
    setMedia,
    ownsSession,
    modeFor,
  };
}
