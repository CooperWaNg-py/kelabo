export const config = {
  apiBase: import.meta.env.VITE_API_BASE_URL || 'http://localhost:3000',
  gatewayBase: import.meta.env.VITE_GATEWAY_BASE_URL || 'http://localhost:3001',
  portalUrl: import.meta.env.VITE_PORTAL_URL || 'http://localhost:5173',
  env: import.meta.env.VITE_ENV || 'dev',
  // Which social sign-in buttons the deployment offers. Empty — the
  // self-hosting default — renders none: work email is the identity there.
  socialProviders: (import.meta.env.VITE_SOCIAL_PROVIDERS || '').split(',').filter(Boolean),
}
