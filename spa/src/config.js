export const config = {
  apiBase: import.meta.env.VITE_API_BASE_URL || 'http://localhost:3000',
  gatewayBase: import.meta.env.VITE_GATEWAY_BASE_URL || 'http://localhost:3001',
  portalUrl: import.meta.env.VITE_PORTAL_URL || 'http://localhost:5173',
  env: import.meta.env.VITE_ENV || 'dev',
  // Which social sign-in buttons the deployment offers. Empty — the
  // self-hosting default — renders none: work email is the identity there.
  socialProviders: (import.meta.env.VITE_SOCIAL_PROVIDERS || '').split(',').filter(Boolean),
  // The one email domain this deployment admits, baked in at build time from
  // config.allowedEmailDomain. The server is the authority (rest-api/src/otp.js);
  // the browser knows it only so the sign-in page can name it and stop asking
  // people to type what is already fixed. Empty = open registration.
  allowedEmailDomain: import.meta.env.VITE_ALLOWED_EMAIL_DOMAIN || '',
}
