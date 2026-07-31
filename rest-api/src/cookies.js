import { signJwt, verifyJwt } from "./jwt.js";

export function parseCookies(event) {
  const out = {};
  const list = [];
  if (Array.isArray(event.cookies)) list.push(...event.cookies);
  const header = event.headers?.cookie || event.headers?.Cookie;
  if (header) list.push(...header.split(";").map((s) => s.trim()));
  for (const pair of list) {
    const idx = pair.indexOf("=");
    if (idx < 0) continue;
    out[pair.slice(0, idx).trim()] = decodeURIComponent(pair.slice(idx + 1).trim());
  }
  return out;
}

export function serializeCookie(name, value, { maxAgeSeconds, domain, path = "/", expires } = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${path}`, "HttpOnly", "Secure", "SameSite=Lax"];
  if (domain) parts.push(`Domain=${domain}`);
  if (maxAgeSeconds !== undefined) parts.push(`Max-Age=${maxAgeSeconds}`);
  if (expires) parts.push(`Expires=${expires.toUTCString()}`);
  return parts.join("; ");
}

export function clearCookie(name, { domain, path = "/" } = {}) {
  return serializeCookie(name, "", { domain, path, maxAgeSeconds: 0, expires: new Date(0) });
}

export function mintCookie(payload, secret) {
  return signJwt(payload, secret);
}

export function readCookie(value, secret, schema) {
  const payload = verifyJwt(value, secret);
  if (!payload) return null;
  if (!schema) return payload;
  const parsed = schema.safeParse(payload);
  return parsed.success ? parsed.data : null;
}
