const DEFAULTS = {
  sessionTtlSeconds: 3600,
  refreshTtlDays: 60,
  participantTtlSeconds: 43200,
  // A developer's agent bridge token (docs 16). Longer than a browser refresh
  // token because re-pairing means re-running `kelabo login` at a terminal, and
  // it is revocable from Settings the moment it is not wanted.
  agentTokenTtlDays: 90,
  otp: {
    ttlSeconds: 600,
    maxAttempts: 5,
    resendSeconds: 30,
    perEmailWindowSeconds: 3600,
    perEmailMaxRequests: 5,
    perIpWindowSeconds: 3600,
    perIpMaxRequests: 30,
  },
  // Join codes (rest-api/src/joinCode.js). `redeemPerIp*` is the control that
  // actually bounds guessing, so it is the one to tighten if a deployment ever
  // sees fishing; `mintPerKelaboPerHour` bounds how many codes one room can
  // have live at once, which is the multiplier on that same guess surface.
  joinCode: {
    ttlSeconds: 120,
    mintPerKelaboPerHour: 20,
    redeemPerIpWindowSeconds: 3600,
    redeemPerIpMaxRequests: 20,
  },
  rtc: {
    defaultMode: "sfu",
    meshMaxParticipants: 6,
    video: false,
  },
  retentionDays: 30,
};

let cached;

export function getConfig() {
  if (cached) return cached;
  cached = fromEnv() || null;
  return cached;
}

export async function ensureConfig() {
  if (cached) return cached;
  cached = fromEnv();
  if (cached) return cached;
  const env = process.env.KELABO_ENV || "dev";
  const { loadConfig } = await import("../../config/loadConfig.mjs");
  cached = fromLoadConfig(loadConfig(env));
  return cached;
}

export function setConfig(cfg) {
  cached = cfg;
}

function num(v, d) {
  const n = Number(v);
  return Number.isFinite(n) && v !== undefined && v !== "" ? n : d;
}

function fromEnv() {
  if (!process.env.KELABO_TABLE_KELABOS && !process.env.KELABO_ALLOWED_EMAIL_DOMAIN) return null;
  const env = process.env;
  return {
    env: env.KELABO_ENV || "dev",
    region: env.AWS_REGION || "us-east-1",
    allowedEmailDomain: env.KELABO_ALLOWED_EMAIL_DOMAIN,
    cookieDomain: env.KELABO_COOKIE_DOMAIN,
    portalUrl: env.KELABO_PORTAL_URL,
    gatewayBaseUrl: env.KELABO_GATEWAY_BASE_URL,
    joinUrl: (kelaboId) => `${env.KELABO_PORTAL_URL}/join/${kelaboId}`,
    inviteUrl: (kelaboId) => `${env.KELABO_PORTAL_URL}/invite/${kelaboId}`,
    tableNames: {
      kelabos: env.KELABO_TABLE_KELABOS,
      users: env.KELABO_TABLE_USERS,
      otp: env.KELABO_TABLE_OTP,
      refresh: env.KELABO_TABLE_REFRESH,
      history: env.KELABO_TABLE_HISTORY,
      mcp: env.KELABO_TABLE_MCP,
      contacts: env.KELABO_TABLE_CONTACTS,
    },
    contacts: { external: env.KELABO_CONTACTS_EXTERNAL === "true" },
    archiveBucket: env.KELABO_ARCHIVE_BUCKET,
    archiveKeyPrefix: env.KELABO_ARCHIVE_KEY_PREFIX || "archives",
    secrets: {
      deepgram: env.KELABO_SECRET_DEEPGRAM,
      cookieSigningKey: env.KELABO_SECRET_COOKIE_KEY,
      oidcGoogle: env.KELABO_SECRET_OIDC_GOOGLE,
      oidcApple: env.KELABO_SECRET_OIDC_APPLE,
      mcpPrefix: env.KELABO_SECRET_MCP_PREFIX || "",
      // Existence-probed only, for the capability map (docs 19 §3). The API
      // holds no read grant on these values — they stay gateway-owned.
      llm: env.KELABO_SECRET_LLM,
      cloudflareRealtime: env.KELABO_SECRET_CLOUDFLARE_RTC,
    },
    auth: {
      sessionTtlSeconds: num(env.KELABO_SESSION_TTL_SECONDS, DEFAULTS.sessionTtlSeconds),
      refreshTtlDays: num(env.KELABO_REFRESH_TTL_DAYS, DEFAULTS.refreshTtlDays),
      participantTtlSeconds: num(env.KELABO_PARTICIPANT_TTL_SECONDS, DEFAULTS.participantTtlSeconds),
      agentTokenTtlDays: num(env.KELABO_AGENT_TOKEN_TTL_DAYS, DEFAULTS.agentTokenTtlDays),
      socialProviders: (env.KELABO_SOCIAL_PROVIDERS || "").split(",").map((s) => s.trim()).filter(Boolean),
    },
    deepgram: {
      model: env.KELABO_DEEPGRAM_MODEL || "nova-3",
      language: env.KELABO_DEEPGRAM_LANGUAGE || "en",
      diarizeModel: env.KELABO_DEEPGRAM_DIARIZE_MODEL || "latest",
      tokenTtlSeconds: num(env.KELABO_DEEPGRAM_TOKEN_TTL_SECONDS, 60),
    },
    // `region` falls back to the Lambda's own region: an environment that never
    // moved its mail has no KELABO_SES_REGION, and the identity is where the
    // rest of it lives.
    ses: {
      fromAddress: env.KELABO_SES_FROM_ADDRESS,
      region: env.KELABO_SES_REGION || env.AWS_REGION || "us-east-1",
    },
    // The control plane only stamps the kelabo's transport and reports it back;
    // all Cloudflare credentials and signalling live in the Gateway (docs 15).
    rtc: {
      defaultMode: env.KELABO_RTC_DEFAULT_MODE || DEFAULTS.rtc.defaultMode,
      meshMaxParticipants: num(env.KELABO_RTC_MESH_MAX, DEFAULTS.rtc.meshMaxParticipants),
      video: env.KELABO_RTC_VIDEO === "true",
    },
    otp: {
      ttlSeconds: num(env.KELABO_OTP_TTL_SECONDS, DEFAULTS.otp.ttlSeconds),
      maxAttempts: num(env.KELABO_OTP_MAX_ATTEMPTS, DEFAULTS.otp.maxAttempts),
      resendSeconds: num(env.KELABO_OTP_RESEND_SECONDS, DEFAULTS.otp.resendSeconds),
      perEmailWindowSeconds: num(env.KELABO_OTP_PER_EMAIL_WINDOW_SECONDS, DEFAULTS.otp.perEmailWindowSeconds),
      perEmailMaxRequests: num(env.KELABO_OTP_PER_EMAIL_MAX_REQUESTS, DEFAULTS.otp.perEmailMaxRequests),
      perIpWindowSeconds: num(env.KELABO_OTP_PER_IP_WINDOW_SECONDS, DEFAULTS.otp.perIpWindowSeconds),
      perIpMaxRequests: num(env.KELABO_OTP_PER_IP_MAX_REQUESTS, DEFAULTS.otp.perIpMaxRequests),
    },
    joinCode: {
      ttlSeconds: num(env.KELABO_JOIN_CODE_TTL_SECONDS, DEFAULTS.joinCode.ttlSeconds),
      mintPerKelaboPerHour: num(env.KELABO_JOIN_CODE_MINT_PER_KELABO_PER_HOUR, DEFAULTS.joinCode.mintPerKelaboPerHour),
      redeemPerIpWindowSeconds: num(env.KELABO_JOIN_CODE_REDEEM_PER_IP_WINDOW_SECONDS, DEFAULTS.joinCode.redeemPerIpWindowSeconds),
      redeemPerIpMaxRequests: num(env.KELABO_JOIN_CODE_REDEEM_PER_IP_MAX_REQUESTS, DEFAULTS.joinCode.redeemPerIpMaxRequests),
    },
    retentionDays: num(env.KELABO_RETENTION_DAYS, DEFAULTS.retentionDays),
  };
}

function fromLoadConfig(c) {
  return {
    env: c.env,
    region: c.region,
    allowedEmailDomain: c.allowedEmailDomain,
    cookieDomain: c.cookieDomain,
    portalUrl: c.portalUrl,
    gatewayBaseUrl: c.gatewayBaseUrl,
    joinUrl: c.joinUrl,
    inviteUrl: c.inviteUrl,
    tableNames: c.tableNames,
    contacts: { external: !!c.contacts?.external },
    archiveBucket: c.archiveBucket,
    archiveKeyPrefix: c.archiveKeyPrefix,
    secrets: {
      deepgram: c.secrets.deepgram,
      cookieSigningKey: c.secrets.cookieSigningKey,
      oidcGoogle: c.secrets.oidcGoogle,
      oidcApple: c.secrets.oidcApple,
      mcpPrefix: c.secrets.mcpPrefix || "",
      llm: c.secrets.llm,
      cloudflareRealtime: c.secrets.cloudflareRealtime,
    },
    auth: {
      sessionTtlSeconds: c.auth?.sessionTtlSeconds ?? DEFAULTS.sessionTtlSeconds,
      refreshTtlDays: c.auth?.refreshTtlDays ?? DEFAULTS.refreshTtlDays,
      participantTtlSeconds: c.auth?.participantTtlSeconds ?? DEFAULTS.participantTtlSeconds,
      agentTokenTtlDays: c.auth?.agentTokenTtlDays ?? DEFAULTS.agentTokenTtlDays,
      socialProviders: c.auth?.socialProviders ?? [],
    },
    deepgram: {
      model: c.deepgram?.model ?? "nova-3",
      language: c.deepgram?.language ?? "multi",
      diarizeModel: c.deepgram?.diarizeModel ?? "latest",
      tokenTtlSeconds: c.deepgram?.tokenTtlSeconds ?? 60,
    },
    ses: { fromAddress: c.ses?.fromAddress, region: c.ses?.region || c.region },
    rtc: { ...DEFAULTS.rtc, ...(c.rtc || {}) },
    otp: { ...DEFAULTS.otp, ...(c.otp || {}) },
    joinCode: { ...DEFAULTS.joinCode, ...(c.joinCode || {}) },
    retentionDays: c.retentionDays ?? DEFAULTS.retentionDays,
  };
}
