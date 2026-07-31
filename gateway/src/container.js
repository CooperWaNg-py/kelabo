import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { S3Client } from "@aws-sdk/client-s3";
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { loadGatewayConfig } from "./config.js";
import { createState, rebuildState } from "./state.js";
import { createCloudflareRtc } from "./rtc/cloudflare.js";
import { log, logError } from "./log.js";

export async function createContainer(overrides = {}) {
  const config = overrides.config ?? (await loadGatewayConfig());
  const region = config.region;
  const db = overrides.db ?? DynamoDBDocumentClient.from(new DynamoDBClient({ region }));
  const s3 = overrides.s3 ?? new S3Client({ region });
  const secrets = overrides.secrets ?? new SecretsManagerClient({ region });

  // Cached with a TTL, not forever: MCP bearer tokens are rotated by the user
  // from Settings while the task keeps running, and an immortal cache meant the
  // gateway kept presenting a stale credential until the next deploy.
  const SECRET_TTL_MS = 5 * 60_000;
  const secretCache = new Map();
  async function getSecret(name) {
    if (!name) return null;
    const hit = secretCache.get(name);
    if (hit && hit.expiresAt > Date.now()) return hit.value;
    const out = await secrets.send(new GetSecretValueCommand({ SecretId: name }));
    const raw = out.SecretString ?? Buffer.from(out.SecretBinary ?? []).toString("utf8");
    let value = raw;
    try {
      value = JSON.parse(raw);
    } catch {
      value = raw;
    }
    secretCache.set(name, { value, expiresAt: Date.now() + SECRET_TTL_MS });
    return value;
  }

  async function getCookieKey() {
    const v = await getSecret(config.secrets.cookieSigningKey);
    return typeof v === "string" ? v : v.key ?? v.signingKey ?? JSON.stringify(v);
  }

  // { sfuAppId, sfuAppSecret, turnKeyId, turnKeyApiToken }. Absent until the
  // operator runs `make secrets` with the Cloudflare values, in which case the
  // RTC client reports rtc_unavailable and kelabos run board+transcript only.
  async function getCloudflareRtc() {
    const v = await getSecret(config.secrets.cloudflareRealtime);
    return v && typeof v === "object" ? v : null;
  }

  const c = {
    config,
    db,
    s3,
    secrets,
    getSecret,
    getCookieKey,
    getCloudflareRtc,
    state: createState(),
    log: (event, fields) => log(event, fields),
    // Overridable so tests exercise the routes without reaching Cloudflare.
    rtc:
      overrides.rtc ??
      createCloudflareRtc({
        apiBase: config.rtcApiBase,
        getCreds: getCloudflareRtc,
        fetchImpl: overrides.fetchImpl,
      }),
    logError,
    shutdownHooks: [],
    async shutdown() {
      for (const fn of c.shutdownHooks.splice(0)) {
        try {
          await fn();
        } catch {}
      }
    },
  };

  if (!overrides.skipRebuild) {
    try {
      await rebuildState(c);
    } catch (err) {
      logError("state_rebuild_failed", err);
    }
  }
  return c;
}
