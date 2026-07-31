import {
  SecretsManagerClient,
  GetSecretValueCommand,
  CreateSecretCommand,
  PutSecretValueCommand,
  DeleteSecretCommand,
} from "@aws-sdk/client-secrets-manager";

export function createSecrets({ region } = {}) {
  const client = new SecretsManagerClient({ region: region || process.env.AWS_REGION });
  const cache = new Map();

  async function getSecretRaw(name) {
    if (cache.has(name)) return cache.get(name);
    const res = await client.send(new GetSecretValueCommand({ SecretId: name }));
    const value = res.SecretString ?? Buffer.from(res.SecretBinary).toString("utf8");
    cache.set(name, value);
    return value;
  }

  async function getSecretJson(name) {
    const raw = await getSecretRaw(name);
    try {
      return JSON.parse(raw);
    } catch {
      return { value: raw };
    }
  }

  // MCP server auth tokens live at <mcpPrefix><identity>/<serverName> as
  // {token}. DynamoDB only stores the secretRef (`<identity>/<serverName>`).
  async function putMcpSecret(config, identity, serverName, token) {
    const name = `${config.secrets.mcpPrefix}${identity}/${serverName}`;
    const SecretString = JSON.stringify({ token });
    try {
      await client.send(new CreateSecretCommand({ Name: name, SecretString }));
    } catch (e) {
      if (e.name !== "ResourceExistsException") throw e;
      await client.send(new PutSecretValueCommand({ SecretId: name, SecretString }));
    }
    cache.set(name, SecretString);
  }

  async function deleteMcpSecret(config, identity, serverName) {
    const name = `${config.secrets.mcpPrefix}${identity}/${serverName}`;
    cache.delete(name);
    await client
      .send(new DeleteSecretCommand({ SecretId: name, ForceDeleteWithoutRecovery: true }))
      .catch(() => {});
  }

  return {
    getSecretRaw,
    getSecretJson,
    putMcpSecret,
    deleteMcpSecret,
    getCookieKey: (config) => getSecretRaw(config.secrets.cookieSigningKey),
    getDeepgramKey: async (config) => {
      const s = await getSecretJson(config.secrets.deepgram);
      return s.apiKey || s.key || s.value;
    },
    getOidcSecret: (config, provider) =>
      getSecretJson(provider === "google" ? config.secrets.oidcGoogle : config.secrets.oidcApple),
  };
}
