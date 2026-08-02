import { randomInt, randomUUID } from "node:crypto";
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import { hmacSha256 } from "./jwt.js";
import { err } from "./errors.js";

export function createOtp({ config, db, ses }) {
  // Tenant = the verified email's own domain (ARCHITECTURE §1). With an
  // allow-list configured (self-host) that is the one allowed domain; with the
  // allow-list empty, registration is open and every org lands in its own
  // tenant — the multi-domain mode the schema always reserved space for.
  const tenantOf = (email) => email.split("@")[1]?.toLowerCase();

  function assertDomainAllowed(email) {
    const domain = tenantOf(email);
    if (!domain) throw err(403, "domain_not_allowed");
    if (config.allowedEmailDomain && domain !== config.allowedEmailDomain.toLowerCase()) {
      throw err(403, "domain_not_allowed");
    }
  }

  async function request({ email, ip }) {
    assertDomainAllowed(email);
    const now = Date.now();
    const o = config.otp;

    if (ip) {
      const counter = await db.bumpIpCounter(ip, o.perIpWindowSeconds);
      if ((counter?.count || 0) > o.perIpMaxRequests) throw err(429, "rate_limited");
    }

    const existing = await db.getOtp(email);
    if (existing) {
      const windowStart = existing.windowStart || now;
      const inWindow = now - windowStart < o.perEmailWindowSeconds * 1000;
      const count = inWindow ? existing.requestCount || 0 : 0;
      if (inWindow && count >= o.perEmailMaxRequests) throw err(429, "rate_limited");
      if (existing.lastSentAt && now - existing.lastSentAt < o.resendSeconds * 1000) {
        throw err(429, "rate_limited", `retry in ${o.resendSeconds}s`);
      }
    }

    const code = String(randomInt(0, 1000000)).padStart(6, "0");
    const nowSec = Math.floor(now / 1000);
    const inWindow = existing?.windowStart && now - existing.windowStart < o.perEmailWindowSeconds * 1000;
    await db.putOtp({
      email,
      codeHash: hmacSha256(code, email),
      expiresAt: now + o.ttlSeconds * 1000,
      ttl: nowSec + o.ttlSeconds,
      attempts: 0,
      requestCount: (inWindow ? existing.requestCount || 0 : 0) + 1,
      windowStart: inWindow ? existing.windowStart : now,
      lastSentAt: now,
      tenantId: tenantOf(email),
    });

    await ses.sendOtp({
      to: email,
      code,
      from: config.ses.fromAddress,
      // The brand tile, served by the portal. Mail clients that block remote
      // images just show the wordmark text — nothing important is in the image.
      logoUrl: config.portalUrl ? `${config.portalUrl}/favicon-192.png` : null,
    });
    return { ok: true, resendInSeconds: o.resendSeconds };
  }

  async function verify({ email, code }) {
    assertDomainAllowed(email);
    const item = await db.getOtp(email);
    if (!item) throw err(401, "invalid_code");
    if (item.expiresAt <= Date.now()) {
      await db.deleteOtp(email);
      throw err(401, "code_expired");
    }
    if ((item.attempts || 0) >= config.otp.maxAttempts) throw err(429, "too_many_attempts");
    if (hmacSha256(code, email) !== item.codeHash) {
      await db.incrementOtpAttempts(email);
      throw err(401, "invalid_code");
    }
    await db.deleteOtp(email);
    const displayName = email.split("@")[0];
    const tenantId = tenantOf(email);
    const user = await db.upsertUser({ email, displayName, tenantId });
    return { email, displayName: user?.displayName || displayName, tenantId };
  }

  return { request, verify, assertDomainAllowed };
}

/**
 * Formats a scheduled time for someone who may be anywhere. The offset is
 * spelled out rather than assumed: an invitation that says "2:00 PM" without
 * saying whose 2:00 PM is how people miss kelabos.
 */
function formatWhen(scheduledAt, durationMinutes) {
  const d = new Date(scheduledAt);
  const date = d.toUTCString().replace(" GMT", " UTC");
  return durationMinutes ? `${date} (${durationMinutes} min)` : date;
}

const esc = (v) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export function createSesSender({ region, sendEmail, configurationSet, client: injectedClient } = {}) {
  // The stub seam used by the tests: one function stands in for every kind of
  // mail, so a test can assert on what would have been sent without a client.
  if (sendEmail) return { sendOtp: sendEmail, sendInvite: sendEmail, sendCancellation: sendEmail, sendReschedule: sendEmail };
  const client = injectedClient || new SESv2Client({ region: region || process.env.AWS_REGION });
  // Spread into every command so bounces and complaints reach the
  // configuration set's destination. ABSENT, not empty, when unconfigured:
  // SES rejects a send that names a set which does not exist, so an empty
  // string here would take all mail down rather than merely lose the events.
  const configSet = configurationSet ? { ConfigurationSetName: configurationSet } : {};
  return {
    async sendInvite({ to, from, hostName, title, scheduledAt, durationMinutes, note, inviteUrl }) {
      const when = formatWhen(scheduledAt, durationMinutes);
      const text = [
        `${hostName} invited you to "${title}".`,
        "",
        when,
        note ? `\n${note}\n` : "",
        "Let them know if you can make it:",
        inviteUrl,
        "",
        "You do not need an account — you can reply as a guest.",
      ]
        .filter((l) => l !== "")
        .join("\n");
      const html = [
        `<p><strong>${esc(hostName)}</strong> invited you to &ldquo;${esc(title)}&rdquo;.</p>`,
        `<p>${esc(when)}</p>`,
        note ? `<p>${esc(note)}</p>` : "",
        `<p><a href="${esc(inviteUrl)}">Let them know if you can make it</a></p>`,
        `<p style="color:#666;font-size:13px">You do not need an account — you can reply as a guest.</p>`,
      ].join("");
      try {
        await client.send(
          new SendEmailCommand({
            ...configSet,
            FromEmailAddress: from,
            Destination: { ToAddresses: [to] },
            Content: {
              Simple: {
                Subject: { Data: `Invitation: ${title}` },
                Body: { Text: { Data: text }, Html: { Data: html } },
              },
            },
          })
        );
      } catch (e) {
        if (e.name === "MessageRejected" && /not verified/i.test(e.message)) {
          throw err(502, "email_not_verified", "Recipient not verified — SES sandbox requires verifying this address or requesting production access.");
        }
        throw e;
      }
    },
    // A scheduled kelabo was called off (docs 18 §2.5).
    async sendCancellation({ to, from, hostName, title, scheduledAt, reason }) {
      const when = formatWhen(scheduledAt);
      const text = [
        `${hostName} cancelled "${title}".`,
        "",
        `It was scheduled for ${when}.`,
        reason ? `\nReason: ${reason}\n` : "",
        "No action is needed.",
      ]
        .filter((l) => l !== "")
        .join("\n");
      const html = [
        `<p><strong>${esc(hostName)}</strong> cancelled &ldquo;${esc(title)}&rdquo;.</p>`,
        `<p>It was scheduled for ${esc(when)}.</p>`,
        reason ? `<p>Reason: ${esc(reason)}</p>` : "",
        `<p style="color:#666;font-size:13px">No action is needed.</p>`,
      ].join("");
      try {
        await client.send(
          new SendEmailCommand({
            ...configSet,
            FromEmailAddress: from,
            Destination: { ToAddresses: [to] },
            Content: { Simple: { Subject: { Data: `Cancelled: ${title}` }, Body: { Text: { Data: text }, Html: { Data: html } } } },
          })
        );
      } catch (e) {
        if (e.name === "MessageRejected" && /not verified/i.test(e.message)) {
          throw err(502, "email_not_verified", "Recipient not verified — SES sandbox requires verifying this address or requesting production access.");
        }
        throw e;
      }
    },
    // A scheduled kelabo moved to a new time (docs 18 §3.3).
    async sendReschedule({ to, from, hostName, title, scheduledAt, previousScheduledAt, durationMinutes, inviteUrl }) {
      const nowWhen = formatWhen(scheduledAt, durationMinutes);
      const wasWhen = formatWhen(previousScheduledAt);
      const text = [
        `${hostName} moved "${title}" to a new time.`,
        "",
        `Was: ${wasWhen}`,
        `Now: ${nowWhen}`,
        "",
        "Please let them know again if you can make it:",
        inviteUrl,
      ]
        .filter((l) => l !== "")
        .join("\n");
      const html = [
        `<p><strong>${esc(hostName)}</strong> moved &ldquo;${esc(title)}&rdquo; to a new time.</p>`,
        `<p style="color:#666">Was: ${esc(wasWhen)}</p>`,
        `<p>Now: <strong>${esc(nowWhen)}</strong></p>`,
        `<p><a href="${esc(inviteUrl)}">Let them know again if you can make it</a></p>`,
      ].join("");
      try {
        await client.send(
          new SendEmailCommand({
            ...configSet,
            FromEmailAddress: from,
            Destination: { ToAddresses: [to] },
            Content: { Simple: { Subject: { Data: `Rescheduled: ${title}` }, Body: { Text: { Data: text }, Html: { Data: html } } } },
          })
        );
      } catch (e) {
        if (e.name === "MessageRejected" && /not verified/i.test(e.message)) {
          throw err(502, "email_not_verified", "Recipient not verified — SES sandbox requires verifying this address or requesting production access.");
        }
        throw e;
      }
    },
    async sendOtp({ to, code, from, logoUrl }) {
      // Email clients run no JavaScript, so a copy BUTTON is impossible in
      // mail. What replaces it: the code leads the subject line (copyable
      // straight from the notification), and the body sets it huge, spaced
      // and monospaced — the shape Gmail and Apple Mail recognise and offer
      // as a one-tap copy chip.
      const html = [
        `<div style="background:#faf9f7;padding:40px 16px;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">`,
        `<table role="presentation" cellpadding="0" cellspacing="0" align="center" style="width:100%;max-width:420px;margin:0 auto">`,
        `<tr><td style="text-align:center;padding-bottom:20px">`,
        logoUrl
          ? `<img src="${esc(logoUrl)}" width="112" height="112" alt="Kelabo" style="border-radius:28px;display:inline-block">`
          : "",
        `<div style="font-size:20px;font-weight:600;color:#1a1917;padding-top:10px">kelabo</div>`,
        `</td></tr>`,
        `<tr><td style="background:#ffffff;border:1px solid #e6e3dc;border-radius:12px;padding:28px 24px;text-align:center">`,
        `<div style="font-size:15px;color:#56524b;padding-bottom:16px">Your sign-in code — it expires in 10 minutes.</div>`,
        `<div style="font-family:'SF Mono',Consolas,monospace;font-size:40px;font-weight:700;letter-spacing:12px;color:#1a1917;padding:14px 0 14px 12px;background:#f3f1ed;border-radius:10px">${esc(code)}</div>`,
        `</td></tr>`,
        `<tr><td style="text-align:center;color:#8a857c;font-size:13px;padding-top:16px">`,
        `Didn't try to sign in? You can ignore this email — nobody gets in without it.`,
        `</td></tr>`,
        `</table></div>`,
      ].join("");
      try {
        await client.send(
          new SendEmailCommand({
            ...configSet,
            FromEmailAddress: from,
            Destination: { ToAddresses: [to] },
            Content: {
              Simple: {
                // The code up front: visible and copyable from the inbox row
                // and the OS notification without opening the mail at all.
                Subject: { Data: `${code} is your Kelabo sign-in code` },
                Body: {
                  Text: { Data: `Your Kelabo sign-in code is ${code}. It expires in 10 minutes.` },
                  Html: { Data: html },
                },
              },
            },
          })
        );
      } catch (e) {
        if (e.name === "MessageRejected" && /not verified/i.test(e.message)) {
          throw err(502, "email_not_verified", "Recipient not verified — SES sandbox requires verifying this address (check inbox for the AWS verification email) or requesting production access.");
        }
        throw e;
      }
    },
  };
}

export function generateGuestIdentity() {
  return `guest:${randomUUID()}`;
}
