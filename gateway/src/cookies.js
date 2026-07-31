import { createHmac, timingSafeEqual } from "node:crypto";
import { INTERNAL_JWT_AUD, AGENT_JWT_AUD, AGENT_JWT_ROLE } from "@kelabo/contracts";

const b64u = (buf) => Buffer.from(buf).toString("base64url");

export function signJwt(payload, key, header = { alg: "HS256", typ: "JWT" }) {
  const h = b64u(JSON.stringify(header));
  const p = b64u(JSON.stringify(payload));
  const sig = createHmac("sha256", key).update(`${h}.${p}`).digest();
  return `${h}.${p}.${b64u(sig)}`;
}

export function verifyJwt(token, key) {
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [h, p, s] = parts;
  let header;
  try {
    header = JSON.parse(Buffer.from(h, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (header.alg !== "HS256") return null;
  const expect = createHmac("sha256", key).update(`${h}.${p}`).digest();
  let got;
  try {
    got = Buffer.from(s, "base64url");
  } catch {
    return null;
  }
  if (got.length !== expect.length || !timingSafeEqual(got, expect)) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(p, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof payload.exp === "number" && payload.exp * 1000 <= Date.now()) return null;
  return payload;
}

export function verifyParticipantCookie(token, key) {
  const payload = verifyJwt(token, key);
  if (!payload || payload.kind !== "participant") return null;
  if (!payload.kelaboId || !payload.identity) return null;
  return payload;
}

// The browser session cookie (`kelabo_session`), used to authenticate the
// presence stream (docs 18 §5) — the first non-kelabo-scoped browser route on
// the Gateway. It is `{kind:"identity", identity, tenantId, exp}` and, like the
// participant cookie, carries no `sub` — so it can never be mistaken for an
// agent or internal JWT, which `verifyAppJwt` requires a `sub` for. `kind` and
// the two required fields are checked to keep the "aud/kind separates families"
// invariant honest.
export function verifySessionCookie(token, key) {
  const payload = verifyJwt(token, key);
  if (!payload || payload.kind !== "identity") return null;
  if (!payload.identity || !payload.tenantId) return null;
  return payload;
}

// Three token families are signed with the same key: participant cookies, the
// REST->Gateway internal JWT, and a developer's agent token. `aud` is the only
// thing that keeps them apart, so every verifier below demands its own — a
// verifier that checks `role` alone would accept a token minted for a different
// purpose that happens to carry the same role.
export function verifyAppJwt(token, key, { role, aud } = {}) {
  const payload = verifyJwt(token, key);
  if (!payload || !payload.sub) return null;
  if (role && payload.role !== role) return null;
  if (aud && payload.aud !== aud) return null;
  return payload;
}

/** A developer's agent bridge (docs 16). Revocation is checked separately, by
 *  the caller, because it costs a table read and is only worth doing once per
 *  connection rather than once per frame. */
export function verifyAgentJwt(token, key) {
  const payload = verifyAppJwt(token, key, { role: AGENT_JWT_ROLE, aud: AGENT_JWT_AUD });
  return payload?.jti ? payload : null;
}

export function verifyInternalJwt(token, key) {
  const payload = verifyJwt(token, key);
  if (!payload || payload.aud !== INTERNAL_JWT_AUD) return null;
  return payload;
}

export function parseCookies(req) {
  const header = req.headers.cookie;
  const out = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function bearerToken(req) {
  const h = req.headers.authorization || "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1] : null;
}
