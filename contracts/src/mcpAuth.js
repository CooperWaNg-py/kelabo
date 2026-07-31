// MCP Authorization (spec rev 2025-06-18) — the discovery + OAuth 2.1 wire
// format, as pure functions.
//
// This module is deliberately dependency-free and imports NOTHING from node:
// (no crypto, no fs). It is shared verbatim by the rest-api Lambda (which drives
// the interactive authorization-code leg) and the gateway (which only ever needs
// the refresh leg). Keeping it node-free also means it stays safe to bundle if
// the SPA ever needs to parse this metadata. It is NOT re-exported from
// contracts/src/index.js — import it via the "@kelabo/contracts/mcp-auth"
// subpath so the SPA never pulls it in by accident.
//
// Standards assembled here (all mandated by the MCP spec):
//   RFC 9728  OAuth 2.0 Protected Resource Metadata  — find the auth server
//   RFC 8414  OAuth 2.0 Authorization Server Metadata — find the endpoints
//   RFC 7591  Dynamic Client Registration            — get a client_id with no
//                                                      human pre-registration
//   RFC 8707  Resource Indicators                    — bind the token to this
//                                                      MCP server (`resource`)
//   OAuth 2.1 + PKCE S256

const JSON_ACCEPT = { Accept: "application/json" };

class McpAuthError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = "McpAuthError";
    this.code = code;
  }
}

export function mcpAuthError(code, message) {
  return new McpAuthError(code, message);
}

/**
 * RFC 8707 §2 canonical resource URI: lowercase scheme + host, no fragment, and
 * no trailing slash (the spec explicitly prefers the slash-less form). The path
 * IS significant — `https://mcp.example.com/server/mcp` identifies a different
 * resource from `https://mcp.example.com` — so it is preserved as-is.
 * @param {string} raw
 * @returns {string}
 */
export function canonicalResourceUri(raw) {
  let u;
  try {
    u = new URL(String(raw ?? ""));
  } catch {
    throw mcpAuthError("invalid_resource_uri", `not a URL: ${raw}`);
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") {
    throw mcpAuthError("invalid_resource_uri", `unsupported scheme ${u.protocol}`);
  }
  u.hash = "";
  u.search = "";
  let path = u.pathname;
  if (path.endsWith("/")) path = path.slice(0, -1);
  return `${u.protocol.toLowerCase()}//${u.host.toLowerCase()}${path}`;
}

/**
 * Parse a `WWW-Authenticate: Bearer ...` challenge into its auth-param map.
 * We only need `resource_metadata` (RFC 9728 §5.1) but the whole map is
 * returned so callers can log `error`/`error_description` on failures.
 * @param {string|null|undefined} header
 * @returns {Record<string,string>}
 */
export function parseWwwAuthenticate(header) {
  const out = {};
  if (!header) return out;
  // Strip the scheme token ("Bearer"), then pull key="value" / key=value pairs.
  const params = String(header).replace(/^\s*[\w-]+\s+/, "");
  const re = /([\w-]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^,\s]+))/g;
  let m;
  while ((m = re.exec(params)) !== null) {
    out[m[1].toLowerCase()] = (m[2] !== undefined ? m[2].replace(/\\(.)/g, "$1") : m[3]) ?? "";
  }
  return out;
}

/**
 * Build the RFC 9728 / RFC 8414 well-known candidates for a URL. Both RFCs
 * insert the well-known segment between the host and the path rather than
 * appending it, e.g. https://h/mcp -> https://h/.well-known/<kind>/mcp.
 * OpenID Connect discovery (which many auth servers implement instead of 8414)
 * appends instead, so that variant is included last for auth servers.
 * @param {string} url
 * @param {string} kind - "oauth-protected-resource" | "oauth-authorization-server"
 * @returns {string[]}
 */
export function wellKnownCandidates(url, kind) {
  const u = new URL(url);
  const path = u.pathname.replace(/\/$/, "");
  const origin = `${u.protocol}//${u.host}`;
  const candidates = [];
  if (path && path !== "/") candidates.push(`${origin}/.well-known/${kind}${path}`);
  candidates.push(`${origin}/.well-known/${kind}`);
  if (kind === "oauth-authorization-server") {
    // OIDC discovery style, appended rather than inserted.
    if (path && path !== "/") candidates.push(`${origin}${path}/.well-known/openid-configuration`);
    candidates.push(`${origin}/.well-known/openid-configuration`);
  }
  return candidates;
}

async function fetchJson(fetchImpl, url, init, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs ?? 10_000);
  try {
    const res = await fetchImpl(url, { ...init, signal: ctrl.signal });
    const text = await res.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    return { ok: res.ok, status: res.status, body, text, headers: res.headers };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Send an unauthenticated MCP `initialize` to decide whether the server is
 * protected. A protected server MUST answer 401 with a `WWW-Authenticate`
 * carrying `resource_metadata` (spec: "Authorization Server Location").
 *
 * @returns {Promise<{requiresAuth: boolean, status: number,
 *   resourceMetadataUrl: string|null, challenge: Record<string,string>}>}
 */
export async function probeMcpServer(url, { fetchImpl = fetch, timeoutMs = 10_000 } = {}) {
  const res = await fetchJson(
    fetchImpl,
    url,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "kelabo", version: "1.0" },
        },
      }),
    },
    timeoutMs
  );
  const challenge = parseWwwAuthenticate(res.headers?.get?.("www-authenticate"));
  return {
    requiresAuth: res.status === 401,
    status: res.status,
    resourceMetadataUrl: challenge.resource_metadata || null,
    challenge,
  };
}

/**
 * RFC 9728 Protected Resource Metadata. Prefers the exact URL advertised in the
 * 401 challenge; falls back to the well-known derivations.
 * @returns {Promise<{resource: string, authorizationServers: string[],
 *   scopesSupported: string[], raw: object, metadataUrl: string}>}
 */
export async function fetchProtectedResourceMetadata(
  mcpUrl,
  { fetchImpl = fetch, resourceMetadataUrl = null, timeoutMs = 10_000 } = {}
) {
  const candidates = resourceMetadataUrl
    ? [resourceMetadataUrl, ...wellKnownCandidates(mcpUrl, "oauth-protected-resource")]
    : wellKnownCandidates(mcpUrl, "oauth-protected-resource");
  let lastStatus = 0;
  for (const candidate of candidates) {
    const res = await fetchJson(fetchImpl, candidate, { headers: JSON_ACCEPT }, timeoutMs).catch(() => null);
    if (!res) continue;
    lastStatus = res.status;
    if (!res.ok || !res.body) continue;
    const servers = Array.isArray(res.body.authorization_servers) ? res.body.authorization_servers : [];
    if (!servers.length) continue;
    return {
      resource: res.body.resource ? canonicalResourceUri(res.body.resource) : canonicalResourceUri(mcpUrl),
      authorizationServers: servers,
      scopesSupported: Array.isArray(res.body.scopes_supported) ? res.body.scopes_supported : [],
      raw: res.body,
      metadataUrl: candidate,
    };
  }
  throw mcpAuthError(
    "prm_not_found",
    `no protected-resource metadata at ${candidates.join(", ")} (last status ${lastStatus})`
  );
}

/**
 * RFC 8414 Authorization Server Metadata (with OIDC discovery fallback).
 * @returns {Promise<{issuer: string, authorizationEndpoint: string,
 *   tokenEndpoint: string, registrationEndpoint: string|null,
 *   scopesSupported: string[], codeChallengeMethods: string[],
 *   raw: object, metadataUrl: string}>}
 */
export async function fetchAuthServerMetadata(issuerUrl, { fetchImpl = fetch, timeoutMs = 10_000 } = {}) {
  const candidates = wellKnownCandidates(issuerUrl, "oauth-authorization-server");
  let lastStatus = 0;
  for (const candidate of candidates) {
    const res = await fetchJson(fetchImpl, candidate, { headers: JSON_ACCEPT }, timeoutMs).catch(() => null);
    if (!res) continue;
    lastStatus = res.status;
    if (!res.ok || !res.body?.authorization_endpoint || !res.body?.token_endpoint) continue;
    return {
      issuer: res.body.issuer || issuerUrl,
      authorizationEndpoint: res.body.authorization_endpoint,
      tokenEndpoint: res.body.token_endpoint,
      registrationEndpoint: res.body.registration_endpoint || null,
      scopesSupported: Array.isArray(res.body.scopes_supported) ? res.body.scopes_supported : [],
      codeChallengeMethods: Array.isArray(res.body.code_challenge_methods_supported)
        ? res.body.code_challenge_methods_supported
        : [],
      raw: res.body,
      metadataUrl: candidate,
    };
  }
  throw mcpAuthError(
    "as_metadata_not_found",
    `no authorization-server metadata at ${candidates.join(", ")} (last status ${lastStatus})`
  );
}

/**
 * RFC 7591 Dynamic Client Registration. This is the step that removes "paste a
 * token" from the UX: we obtain a client_id at runtime with no human involved.
 * Servers that do not offer a registration_endpoint require a pre-provisioned
 * client_id instead (spec: "Authorization servers that do not support DCR").
 * @returns {Promise<{clientId: string, clientSecret: string|null,
 *   registrationAccessToken: string|null, registrationClientUri: string|null,
 *   raw: object}>}
 */
export async function registerClient(
  registrationEndpoint,
  { redirectUri, clientName, clientUri, scope, fetchImpl = fetch, timeoutMs = 10_000 }
) {
  const body = {
    client_name: clientName,
    redirect_uris: [redirectUri],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    // Public client + PKCE. If the AS insists on credentials it returns a
    // client_secret anyway, which we persist and send on token requests.
    token_endpoint_auth_method: "none",
    application_type: "web",
    ...(clientUri ? { client_uri: clientUri } : {}),
    ...(scope ? { scope } : {}),
  };
  const res = await fetchJson(
    fetchImpl,
    registrationEndpoint,
    { method: "POST", headers: { "content-type": "application/json", ...JSON_ACCEPT }, body: JSON.stringify(body) },
    timeoutMs
  );
  if (!res.ok || !res.body?.client_id) {
    throw mcpAuthError("registration_failed", `client registration failed (${res.status}): ${res.text?.slice(0, 300)}`);
  }
  return {
    clientId: res.body.client_id,
    clientSecret: res.body.client_secret || null,
    registrationAccessToken: res.body.registration_access_token || null,
    registrationClientUri: res.body.registration_client_uri || null,
    raw: res.body,
  };
}

/**
 * Full discovery for one MCP server URL, tolerant of both spec revisions.
 *
 * The 2025-06-18 revision requires RFC 9728 protected-resource metadata, but a
 * lot of deployed servers still implement the 2025-03-26 flow, where the client
 * goes straight to RFC 8414 metadata at the MCP server's own ORIGIN and there is
 * no protected-resource document at all. Atlassian's production server is one of
 * these: it answers 401 with a `WWW-Authenticate` that carries no
 * `resource_metadata`, serves nothing at
 * /.well-known/oauth-protected-resource, and publishes its endpoints at
 * https://mcp.atlassian.com/.well-known/oauth-authorization-server.
 *
 * So: try the modern path, and fall back to the legacy one rather than refusing
 * to connect. `via` records which path was taken.
 *
 * @returns {Promise<{issuer,authorizationEndpoint,tokenEndpoint,
 *   registrationEndpoint,resource,scope,via:"prm"|"origin"}>}
 */
export async function discoverAuthorization(mcpUrl, { fetchImpl = fetch, timeoutMs = 10_000 } = {}) {
  const probe = await probeMcpServer(mcpUrl, { fetchImpl, timeoutMs });

  let prm = null;
  try {
    prm = await fetchProtectedResourceMetadata(mcpUrl, {
      fetchImpl,
      resourceMetadataUrl: probe.resourceMetadataUrl,
      timeoutMs,
    });
  } catch {
    prm = null;
  }

  // RFC 9728 §7.6 leaves the choice among several authorization servers to the
  // client; we have no basis to prefer one, so take the first.
  const issuerCandidate = prm ? prm.authorizationServers[0] : new URL(mcpUrl).origin;
  const as = await fetchAuthServerMetadata(issuerCandidate, { fetchImpl, timeoutMs });

  // Prefer the scopes the RESOURCE asks for over the (usually much broader) set
  // the authorization server advertises. Either may legitimately be empty, in
  // which case we send no `scope` and take the server's default grant.
  const scopes = prm?.scopesSupported?.length ? prm.scopesSupported : as.scopesSupported;

  return {
    issuer: as.issuer,
    authorizationEndpoint: as.authorizationEndpoint,
    tokenEndpoint: as.tokenEndpoint,
    registrationEndpoint: as.registrationEndpoint,
    resource: prm?.resource ?? canonicalResourceUri(mcpUrl),
    scope: scopes?.length ? scopes.join(" ") : null,
    via: prm ? "prm" : "origin",
  };
}

/**
 * Build the authorization-request URL. `resource` (RFC 8707) MUST be sent
 * regardless of whether the AS is known to support it.
 */
export function buildAuthorizeUrl({
  authorizationEndpoint,
  clientId,
  redirectUri,
  state,
  codeChallenge,
  resource,
  scope,
}) {
  const url = new URL(authorizationEndpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("resource", resource);
  if (scope) url.searchParams.set("scope", scope);
  return url.toString();
}

function tokenAuthHeaders(clientId, clientSecret) {
  if (!clientSecret) return {};
  const basic = Buffer.from(`${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`).toString("base64");
  return { authorization: `Basic ${basic}` };
}

function normalizeTokenResponse(body, now) {
  // expires_in is seconds; we persist an absolute ms deadline so the gateway can
  // decide staleness without trusting its own clock drift against the AS.
  const expiresIn = Number(body.expires_in);
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token || null,
    tokenType: body.token_type || "Bearer",
    scope: body.scope || null,
    expiresAt: Number.isFinite(expiresIn) && expiresIn > 0 ? now + expiresIn * 1000 : null,
    obtainedAt: now,
  };
}

/** OAuth 2.1 authorization-code exchange with PKCE + RFC 8707 `resource`. */
export async function exchangeAuthorizationCode({
  tokenEndpoint,
  code,
  redirectUri,
  clientId,
  clientSecret = null,
  codeVerifier,
  resource,
  fetchImpl = fetch,
  timeoutMs = 10_000,
  now = Date.now(),
}) {
  const params = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    code_verifier: codeVerifier,
    resource,
  });
  if (clientSecret) params.set("client_secret", clientSecret);
  const res = await fetchJson(
    fetchImpl,
    tokenEndpoint,
    {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        ...JSON_ACCEPT,
        ...tokenAuthHeaders(clientId, clientSecret),
      },
      body: params.toString(),
    },
    timeoutMs
  );
  if (!res.ok || !res.body?.access_token) {
    throw mcpAuthError("token_exchange_failed", `token exchange failed (${res.status}): ${res.text?.slice(0, 300)}`);
  }
  return normalizeTokenResponse(res.body, now);
}

/**
 * Refresh grant. Note OAuth 2.1 REQUIRES refresh-token rotation for public
 * clients, so the response may carry a NEW refresh token — callers must persist
 * whatever comes back, not just the access token. When the AS omits one we keep
 * the previous refresh token (some servers only rotate on demand).
 */
export async function refreshAccessToken({
  tokenEndpoint,
  refreshToken,
  clientId,
  clientSecret = null,
  resource,
  scope,
  fetchImpl = fetch,
  timeoutMs = 10_000,
  now = Date.now(),
}) {
  const params = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: clientId,
    resource,
  });
  if (clientSecret) params.set("client_secret", clientSecret);
  if (scope) params.set("scope", scope);
  const res = await fetchJson(
    fetchImpl,
    tokenEndpoint,
    {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        ...JSON_ACCEPT,
        ...tokenAuthHeaders(clientId, clientSecret),
      },
      body: params.toString(),
    },
    timeoutMs
  );
  if (!res.ok || !res.body?.access_token) {
    // A 400 invalid_grant here means the refresh token is dead — the user must
    // reconnect. Callers surface this as needsReauth rather than retrying.
    const code = res.body?.error === "invalid_grant" ? "refresh_rejected" : "refresh_failed";
    throw mcpAuthError(code, `refresh failed (${res.status}): ${res.text?.slice(0, 300)}`);
  }
  const next = normalizeTokenResponse(res.body, now);
  if (!next.refreshToken) next.refreshToken = refreshToken;
  return next;
}

/** True when the access token is missing, undated, or within `skewMs` of expiry. */
export function isTokenExpired(token, { now = Date.now(), skewMs = 120_000 } = {}) {
  if (!token?.accessToken) return true;
  if (!token.expiresAt) return false; // no expiry advertised → assume long-lived
  return token.expiresAt - skewMs <= now;
}
