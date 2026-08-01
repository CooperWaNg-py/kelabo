import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Load the single source-of-truth config and derive every env-specific value
 * (domains, URLs, table names, bucket, ECR image). No value may be hard-coded
 * elsewhere; secrets are referenced by name only.
 *
 * @param {string} env - dev | staging | prod
 * @param {string} [configPath]
 */
export function loadConfig(env,   configPath = join(here, "kelabo.json")) {
  const raw = JSON.parse(readFileSync(configPath, "utf8"));
  const block = raw.environments?.[env];
  if (!block) throw new Error(`kelabo config: unknown env "${env}" (have: ${Object.keys(raw.environments || {}).join(", ")})`);

  const baseDomain = raw.baseDomain;
  const portalDomain = block.subdomains.portal
    ? `${block.subdomains.portal}.${baseDomain}`
    : baseDomain;
  const gatewayDomain = `${block.subdomains.gateway}.${baseDomain}`;

  const portalUrl = `https://${portalDomain}`;
  const gatewayBaseUrl = `https://${gatewayDomain}`;
  // The REST API is served on the portal host under the /api prefix (CloudFront
  // strips /api before forwarding to the API origin), keeping it separate from
  // SPA client routes like /records and /kelabos.
  const apiBaseUrl = `${portalUrl}/api`;

  const names = {
    kelabos: `kelabo-${block.endpoint}-kelabos`,
    users: `kelabo-${block.endpoint}-users`,
    otp: `kelabo-${block.endpoint}-otp`,
    refresh: `kelabo-${block.endpoint}-refresh`,
    history: `kelabo-${block.endpoint}-history`,
    mcp: `kelabo-${block.endpoint}-mcp`,
    contacts: `kelabo-${block.endpoint}-contacts`,
  };

  // Cloudflare Realtime's API host. Derived here (not written in a consumer) so
  // the "no hard-coded env values" rule holds; the app id and both secrets stay
  // in Secrets Manager and never appear in config.
  const rtcApiBase = raw.rtcApiBase ?? "https://rtc.live.cloudflare.com/v1";
  // Defaulted rather than required: an existing kelabo.json predating conference
  // audio still loads, and the kelabo simply runs board+transcript only until
  // the Cloudflare secret is set.
  const rtc = {
    provider: "cloudflare",
    defaultMode: "sfu",
    // Mesh only. Counted in *units*: each participant is one, each active
    // screen share is one more — a share is an extra uplink to every peer,
    // which is what the cap exists to bound. SFU rooms are not capped.
    meshMaxParticipants: 5,
    iceTtlSeconds: 3600,
    // How long a participant whose last SSE stream closed keeps their seat
    // before being evicted. Bridges the reload / brief-network-blip gap so the
    // room does not churn; the client holds its transport for slightly less
    // (see spa/src/rtc/useRtc.js) so the two windows must move together.
    disconnectGraceSeconds: 20,
    // Camera video is built (docs 15 §8). A deployment can still turn it off —
    // the flag reaches the SPA on the /rtc/join response and hides the control
    // rather than letting someone publish a track nobody wants paid for.
    video: true,
    ...(block.rtc ?? {}),
  };

  // Contacts (docs 18 §4). Favourites — private, one-way, same-org markers —
  // are always available. External contacts (mutual cross-org links) require a
  // multi-domain / open-signup deployment that self-host mode cannot support, so
  // they are OFF by default and the routes that create them 501 until a
  // multi-domain deployment sets `contacts.external: true`.
  const contacts = {
    external: false,
    ...(block.contacts ?? {}),
  };

  // Social sign-in is OFF unless a deployment turns it on: it needs OAuth apps
  // registered with Google/Apple and their client secrets in Secrets Manager,
  // none of which a self-hosted org has on day one — and work-email OTP is the
  // identity path such a deployment actually wants. A deployment that has
  // registered OAuth apps flips this on in its own config.
  const auth = {
    sessionTtlSeconds: 3600,
    refreshTtlDays: 60,
    participantTtlSeconds: 43200,
    socialProviders: [],
    ...(block.auth ?? {}),
  };

  // Join codes (rest-api/src/joinCode.js): the two-minute spoken stand-in for a
  // kelabo URL. Always available — it needs no third-party service and no
  // secret, so there is nothing for a deployment to turn on. What a deployment
  // may want to move are the abuse dials: `redeemPerIp*` bounds guessing and is
  // the one to tighten, `mintPerKelaboPerHour` bounds how many codes a single
  // room can have live at once.
  const joinCode = {
    ttlSeconds: 120,
    mintPerKelaboPerHour: 20,
    redeemPerIpWindowSeconds: 3600,
    redeemPerIpMaxRequests: 20,
    ...(block.joinCode ?? {}),
  };

  return {
    ...block,
    env,
    app: raw.app,
    rtcApiBase,
    rtc,
    contacts,
    auth,
    joinCode,
    secrets: {
      ...block.secrets,
      // Same defaulting reason as `rtc` above: keep a pre-conference-audio
      // kelabo.json loadable, using the conventional name.
      cloudflareRealtime:
        block.secrets?.cloudflareRealtime ?? `kelabo/${block.endpoint}/cloudflare-realtime`,
    },
    baseDomain,
    portalDomain,
    gatewayDomain,
    portalUrl,
    gatewayBaseUrl,
    apiBaseUrl,
    joinUrl: (kelaboId) => `${portalUrl}/join/${kelaboId}`,
    inviteUrl: (kelaboId) => `${portalUrl}/invite/${kelaboId}`,
    cookieDomain: `.${portalDomain}`,
    tableNames: names,
    archiveBucket: `kelabo-${block.endpoint}-archives-${block.account}`,
    archiveKeyPrefix: "archives",
    ecrRepoName: `kelabo-${block.endpoint}-gateway`,
    gatewayImageUri: `${block.account}.dkr.ecr.${block.region}.amazonaws.com/kelabo-${block.endpoint}-gateway:${block.gateway.imageTag}`,
    tags: { app: raw.app, endpoint: block.endpoint },
  };
}
