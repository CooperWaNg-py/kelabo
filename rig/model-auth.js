import { readFile } from "node:fs/promises";

const config = JSON.parse(await readFile("/run/model-auth.json", "utf8"));
const baseUrl = config.opencodeBaseUrl || "http://127.0.0.1:4096";

const deadline = Date.now() + 120000;
let healthy = false;
while (Date.now() < deadline) {
  try {
    const res = await fetch(`${baseUrl}/global/health`);
    if (res.ok) { healthy = true; break; }
  } catch {}
  await new Promise((r) => setTimeout(r, 1000));
}
if (!healthy) {
  console.error("[model-auth] opencode never became healthy");
  process.exit(1);
}
if (config.provider && config.key) {
  const res = await fetch(`${baseUrl}/auth/${encodeURIComponent(config.provider)}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "api", key: config.key }),
  });
  if (!res.ok) {
    console.error(`[model-auth] PUT /auth/${config.provider} failed: ${res.status}`);
    process.exit(1);
  }
  console.log(`[model-auth] credentials installed for provider ${config.provider}`);
}
