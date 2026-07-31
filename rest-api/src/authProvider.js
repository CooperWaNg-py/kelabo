export function createAuthProvider({ otp, oidc, sessions }) {
  return {
    otp: {
      request: (args) => otp.request(args),
      verify: async (args) => {
        const user = await otp.verify(args);
        const session = await sessions.establishSession(user.email, user.displayName);
        return { ...session, identity: { email: user.email, displayName: user.displayName } };
      },
    },
    oidcSocial: {
      start: (provider) => oidc.start(provider),
      callback: async (provider, args) => {
        const { email, clearCookie } = await oidc.callback(provider, args);
        const session = await sessions.establishSession(email);
        return { ...session, cookies: [...session.cookies, clearCookie] };
      },
    },
  };
}
