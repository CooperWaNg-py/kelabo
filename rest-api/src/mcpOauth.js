import { createHash, randomBytes } from "node:crypto";
import { COOKIE_MCP_OAUTH } from "@kelabo/contracts";
import {
  probeMcpServer,
  discoverAuthorization,
  registerClient,
  buildAuthorizeUrl,
  exchangeAuthorizationCode,
  canonicalResourceUri,
} from "@kelabo/contracts/mcp-auth";
import { signJwt, verifyJwt } from "./jwt.js";
import { serializeCookie, clearCookie } from "./cookies.js";
import { err } from "./errors.js";

// Same 10-minute budget as the social-login stash (oidc.js). Long enough for a
// real consent screen, short enough that a leaked cookie is near-useless.
const STASH_TTL = 600;

const b64u = (buf) => Buffer.from(buf).toString("base64url");

/**
 * Interactive half of the MCP authorization spec: discovery, dynamic client
 * registration, and the authorization-code leg. The gateway owns the refresh
 * leg (it is the component that sees the 401), so nothing here runs per-request
 * during a kelabo.
 */
export function createMcpOauth({ config, db, secrets, fetchImpl = fetch }) {
  // MUST be a single constant HTTPS URL: it is what gets registered with the
  // authorization server (RFC 7591 redirect_uris) and authorization servers
  // MUST match it exactly. The server name and the user identity therefore
  // cannot live in the path — they travel in the signed state cookie instead.
  const redirectUri = `${config.portalUrl}/api/me/mcp/oauth/callback`;
  const scopeOf = (identity) => `host#${identity}`;

  function settingsRedirect(params) {
    const q = new URLSearchParams(params).toString();
    return { status: 302, headers: { Location: `${config.portalUrl}/settings?${q}` } };
  }

  async function loadServer(identity, name) {
    const server = (await db.getMcpServers(scopeOf(identity))).find((s) => s.name === name);
    if (!server) throw err(404, "mcp_not_found", `no MCP server named ${name}`);
    return server;
  }

  const discover = (url) => discoverAuthorization(url, { fetchImpl });

  /**
   * Unauthenticated look at a URL so the SPA can decide whether to offer
   * "Connect with OAuth" or an auth-token field, before anything is saved.
   */
  async function probe(url) {
    const result = await probeMcpServer(url, { fetchImpl }).catch((e) => ({
      requiresAuth: false,
      status: 0,
      error: e.message,
    }));
    if (!result.requiresAuth) {
      return { authType: "none", reachable: result.status > 0, status: result.status };
    }
    try {
      const meta = await discover(url);
      return {
        authType: "oauth",
        reachable: true,
        status: 401,
        issuer: meta.issuer,
        resource: meta.resource,
        scope: meta.scope,
        // "prm" = RFC 9728 (MCP spec 2025-06-18); "origin" = the older
        // 2025-03-26 discovery, which most deployed servers still use.
        via: meta.via,
        // false => the AS has no /register; the user must supply a client_id or
        // fall back to a static bearer token.
        dynamicRegistration: !!meta.registrationEndpoint,
      };
    } catch (e) {
      // Protected, but not in a way we can automate: no RFC 9728 metadata. A
      // pasted bearer token is the only remaining option.
      return { authType: "bearer", reachable: true, status: 401, reason: e.code || "discovery_failed" };
    }
  }

  /**
   * Fetch (or create, once) the dynamic client registration for an
   * authorization server. Shared across all users of this deployment.
   */
  async function ensureClient(meta) {
    const existing = await db.getMcpClient(meta.issuer);
    // A registration is only reusable if it was made for our current redirect
    // URI — if the portal domain changed, re-register.
    if (existing?.clientId && existing.redirectUri === redirectUri) return existing;

    if (!meta.registrationEndpoint) {
      throw err(
        400,
        "mcp_oauth_unsupported",
        `${meta.issuer} offers no dynamic client registration; supply a bearer token instead`
      );
    }
    // The client name and URI are what the user sees on the provider's consent
    // screen, so identify the deployment by its portal host rather than an
    // internal env label.
    const reg = await registerClient(meta.registrationEndpoint, {
      redirectUri,
      clientName: `Kelabo (${new URL(config.portalUrl).host})`,
      clientUri: config.portalUrl,
      scope: meta.scope || undefined,
      fetchImpl,
    });
    const record = {
      issuer: meta.issuer,
      clientId: reg.clientId,
      clientSecret: reg.clientSecret,
      redirectUri,
      registrationAccessToken: reg.registrationAccessToken,
      registrationClientUri: reg.registrationClientUri,
      createdAt: Date.now(),
    };
    await db.putMcpClient(meta.issuer, record);
    return record;
  }

  /**
   * Begin the authorization-code flow. Responds 302 so the SPA can simply
   * navigate the top-level window here (SameSite=Lax lets the session cookie
   * ride along on a top-level GET).
   */
  async function start(identity, name) {
    const server = await loadServer(identity, name);
    if (!server.url) throw err(400, "bad_request", "server has no url");

    // Re-discover rather than trusting the cached copy: endpoints rotate, and
    // this path runs once per connect, not per request.
    const meta = await discover(server.url);
    const client = await ensureClient(meta);

    const state = randomBytes(16).toString("base64url");
    const codeVerifier = randomBytes(32).toString("base64url");
    const codeChallenge = b64u(createHash("sha256").update(codeVerifier).digest());

    const key = await secrets.getCookieKey(config);
    const stash = serializeCookie(
      COOKIE_MCP_OAUTH,
      signJwt(
        {
          identity,
          name,
          state,
          codeVerifier,
          issuer: meta.issuer,
          authorizationEndpoint: meta.authorizationEndpoint,
          tokenEndpoint: meta.tokenEndpoint,
          registrationEndpoint: meta.registrationEndpoint,
          resource: meta.resource,
          scope: meta.scope,
          clientId: client.clientId,
          exp: Math.floor(Date.now() / 1000) + STASH_TTL,
        },
        key
      ),
      { maxAgeSeconds: STASH_TTL, domain: config.cookieDomain }
    );

    const url = buildAuthorizeUrl({
      authorizationEndpoint: meta.authorizationEndpoint,
      clientId: client.clientId,
      redirectUri,
      state,
      codeChallenge,
      resource: meta.resource,
      scope: meta.scope,
    });
    return { status: 302, headers: { Location: url }, cookies: [stash] };
  }

  /**
   * Authorization-server redirect lands here. Verifies state + PKCE, exchanges
   * the code, persists the tokens, and marks the server as OAuth-backed.
   */
  async function callback(identity, { query, cookies }) {
    const key = await secrets.getCookieKey(config);
    const clear = clearCookie(COOKIE_MCP_OAUTH, { domain: config.cookieDomain });
    const raw = cookies[COOKIE_MCP_OAUTH];
    let stash = null;
    try {
      stash = raw ? verifyJwt(raw, key) : null;
    } catch {
      stash = null;
    }

    const fail = (code) => ({ ...settingsRedirect({ mcp_error: code }), cookies: [clear] });

    // The user declined, or the AS rejected the request.
    if (query.error) return fail(String(query.error).slice(0, 64));
    if (!stash) return fail("state_expired");
    // Bind the flow to the browser session that started it: a valid stash from
    // another user must not be redeemable here.
    if (stash.identity !== identity) return fail("identity_mismatch");
    if (!query.code || !query.state || stash.state !== query.state) return fail("state_mismatch");

    const client = await db.getMcpClient(stash.issuer);
    if (!client?.clientId) return fail("client_missing");

    let token;
    try {
      token = await exchangeAuthorizationCode({
        tokenEndpoint: stash.tokenEndpoint,
        code: String(query.code),
        redirectUri,
        clientId: client.clientId,
        clientSecret: client.clientSecret,
        codeVerifier: stash.codeVerifier,
        resource: stash.resource,
        fetchImpl,
      });
    } catch (e) {
      return fail(e.code || "token_exchange_failed");
    }

    const scope = scopeOf(identity);
    await db.putMcpToken(scope, stash.name, token);

    // Flip the server to OAuth and cache the endpoints the gateway needs for
    // refresh, so refresh never has to re-run discovery.
    const server = (await db.getMcpServers(scope)).find((s) => s.name === stash.name);
    if (server) {
      await db.putMcpServer(scope, {
        ...server,
        authType: "oauth",
        oauth: {
          issuer: stash.issuer,
          authorizationEndpoint: stash.authorizationEndpoint ?? null,
          tokenEndpoint: stash.tokenEndpoint,
          registrationEndpoint: stash.registrationEndpoint ?? null,
          resource: stash.resource,
          scope: stash.scope ?? null,
        },
      });
    }
    return { ...settingsRedirect({ mcp_connected: stash.name }), cookies: [clear] };
  }

  /** Forget the tokens; the server config and any static secret are untouched. */
  async function disconnect(identity, name) {
    const server = await loadServer(identity, name);
    await db.deleteMcpToken(scopeOf(identity), name);
    if (server.authType === "oauth") {
      const { oauth, ...rest } = server;
      await db.putMcpServer(scopeOf(identity), { ...rest, authType: "none" });
    }
    return { ok: true };
  }

  /** Connection state for the settings UI. Never exposes token material. */
  async function status(identity, name) {
    const token = await db.getMcpToken(scopeOf(identity), name);
    if (!token) return { connected: false };
    return {
      connected: true,
      scope: token.scope ?? null,
      expiresAt: token.expiresAt ?? null,
      obtainedAt: token.obtainedAt ?? null,
    };
  }

  return { probe, start, callback, disconnect, status, discover, redirectUri, canonicalResourceUri };
}
