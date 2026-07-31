import crypto from "node:crypto";

function hmac(key, data) {
  return crypto.createHmac("sha256", key).update(data, "utf8").digest();
}
function sha256Hex(data) {
  return crypto.createHash("sha256").update(data, "utf8").digest("hex");
}

function signV4({ method, host, region, service, path = "/", query = "", headers, body, credentials }) {
  const amzDate = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256Hex(body);
  const allHeaders = { host, "x-amz-date": amzDate, ...headers };
  if (credentials.sessionToken) allHeaders["x-amz-security-token"] = credentials.sessionToken;
  const sortedNames = Object.keys(allHeaders).map((k) => k.toLowerCase()).sort();
  const canonicalHeaders = sortedNames.map((k) => `${k}:${String(allHeaders[k]).trim()}\n`).join("");
  const signedHeaders = sortedNames.join(";");
  const canonicalRequest = [method, path, query, canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256Hex(canonicalRequest)].join("\n");
  const kDate = hmac(`AWS4${credentials.secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  const kSigning = hmac(kService, "aws4_request");
  const signature = crypto.createHmac("sha256", kSigning).update(stringToSign, "utf8").digest("hex");
  return {
    ...allHeaders,
    Authorization: `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

export function awsCredentialsFromEnv(env = process.env) {
  if (!env.AWS_ACCESS_KEY_ID || !env.AWS_SECRET_ACCESS_KEY) return null;
  return {
    accessKeyId: env.AWS_ACCESS_KEY_ID,
    secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
    sessionToken: env.AWS_SESSION_TOKEN,
  };
}

export async function getSecretValue({ secretName, region, credentials }) {
  const host = `secretsmanager.${region}.amazonaws.com`;
  const body = JSON.stringify({ SecretId: secretName });
  const headers = signV4({
    method: "POST",
    host,
    region,
    service: "secretsmanager",
    headers: {
      "content-type": "application/x-amz-json-1.1",
      "x-amz-target": "secretsmanager.GetSecretValue",
    },
    body,
    credentials,
  });
  const res = await fetch(`https://${host}/`, { method: "POST", headers, body });
  if (!res.ok) throw new Error(`secretsmanager_get_failed:${res.status}:${await res.text()}`);
  const data = await res.json();
  if (data.SecretString) {
    try { return JSON.parse(data.SecretString); } catch { return data.SecretString; }
  }
  return data.SecretBinary ? Buffer.from(data.SecretBinary, "base64").toString("utf8") : null;
}
