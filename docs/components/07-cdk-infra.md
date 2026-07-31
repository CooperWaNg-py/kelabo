# Component: CDK / Infra

All AWS infrastructure as one CDK app. **One config file** drives everything; no
hard-coded values in source. Three standalone environments (**dev / staging /
prod**); every resource **tagged** `app=kelabo` + `endpoint=<env>`. Reuses the prior art's
stack decomposition (ARCHITECTURE §15.9), minus Cognito/orchestrator; add Deepgram
token + SES + OTP.

---

## 1. Config file — single source of truth

`config/kelabo.json` (or `.mjs` exporting an object). CDK reads the block for
the selected env; nothing env-specific is hard-coded.

```jsonc
{
  "app": "kelabo",
  "environments": {
    "dev": {
      "endpoint": "dev",
      "account": "0123456789",
      "region": "ap-southeast-2",
      "domain": "kelabo-dev.example.com",
      "hostedZone": { "name": "example.com", "id": "ZXXXXXXXXX" },
      "subdomains": { "portal": "dev", "gateway": "dev-gw" },
      "allowedEmailDomain": "example.com",
      "secrets": {
        "deepgram": "kelabo/dev/deepgram",
        "llm":      "kelabo/dev/llm",
        "cookieSigningKey": "kelabo/dev/cookie-key",
        "oidcGoogle": "kelabo/dev/oidc-google",
        "oidcApple":  "kelabo/dev/oidc-apple",
        "cloudflareRealtime": "kelabo/dev/cloudflare-realtime",
        "mcpPrefix": "kelabo/dev/mcp/"
      },
      "auth": {
        "sessionTtlSeconds": 3600,
        "refreshTtlDays": 60,
        "socialProviders": ["google", "apple"]
      },
      "llm": { "provider": "deepseek", "model": "deepseek-v4-flash",
               "smallModel": "deepseek-v4-flash",
               "baseUrl": "https://api.deepseek.com/v1" },
      "rtc": { "provider": "cloudflare", "defaultMode": "sfu",
               "meshMaxParticipants": 6, "iceTtlSeconds": 3600, "video": true },
      "ses": { "fromAddress": "otp@kelabo-dev.example.com" },
      "retentionDays": 30
      /* tenantId is derived at runtime from the verified email domain */
    },
    "staging": { "endpoint": "staging", "...": "..." },
    "prod":    { "endpoint": "prod", "domain": "kelabo.example.com", "...": "..." }
  }
}
```

**Rules baked into the CDK app:**
- `cdk deploy -c env=dev|staging|prod` selects exactly one block.
- Each env is a **standalone stack set** — fully isolated resources, own account/
  region as configured.
- `Tags.of(app).add('app','kelabo')` and `.add('endpoint', <env>)` at the app root
  so **every** resource is tagged.
- Secrets referenced by **name/ARN only**, never inlined.
- SPA build injects `VITE_*` from the same config (API/Gateway URLs, feature flags).
- `tenantId` can be promoted from constant to per-user without schema change.

---

## 2. Stacks

Selected via `infra/bin/kelabo.js` with `-c env=`. Two CDK environments per deploy: the
home region + `us-east-1` (CloudFront ACM), via `crossRegionReferences: true`.

| Stack | Resources | Notes |
|-------|-----------|-------|
| **DnsStack** | import existing Route53 hosted zone | creates nothing |
| **CertStack (home region)** | ACM certs for Gateway ALB domain | DNS-validated |
| **CertStack (us-east-1)** | ACM certs for Portal CloudFront | required in us-east-1 |
| **DynamoDbStack** | 7 tables (kelabos, users, otp, **refresh**, history, mcp, contacts) + S3 archive bucket | see [08-database.md](../08-database.md) |
| **SesStack / config** | SES identity + from-address; (sandbox in dev) | OTP email |
| **LambdaStack** | REST API Lambda (Node20); IAM (DynamoDB RW incl. refresh, SES send, Secrets read incl. social OIDC); **no `transcribe:*`** | control plane only |
| **ApiGatewayStack** | HTTP API `/{proxy+}` → Lambda | no JWT authorizer |
| **GatewayEcsStack** | ALB + Fargate service (`desiredCount:1`, sized from `config.gateway` — **0.5 vCPU / 1 GB** by default, configurable), `/health`, ALB idle 240s, DockerImageAsset from `gateway/`; **the server-agent worker runs in this task** | the one ECS |
| **PortalCloudFrontStack** | S3 (OAC) + CloudFront; a single **`/api*` behavior** to the HTTP API with a CloudFront function stripping the `/api` prefix; SPA-fallback function rewrites non-dotted URIs to `/index.html`; deploy `spa/dist`; A-record portal subdomain | |

The Gateway ECS uses the **default VPC, public subnets, no NAT** (cost),
`CircuitBreaker({rollback:true})`.

**Dropped from the prior art / earlier drafts:**
- Cognito stack → OTP + social OIDC instead.
- hosted-workspace/orchestrator + PTY → not adopted.
- **OpencodeSurfaceStack** (CloudFront reverse-proxy to opencode) → surface not built.
- **AgentStack** (agent Lambda) → the agent runs **inside the Gateway task**, not
  Lambda (no 15-min cap). No separate agent stack.
- AWS Transcribe IAM → Deepgram.

---

## 3. Networking / domains

| Subdomain | Points to | Purpose |
|-----------|-----------|---------|
| `<portal>` (e.g. `kelabo-dev.example.com`) | Portal CloudFront | SPA + REST behaviors |
| `<gateway>` (e.g. `gw.kelabo-dev.example.com`) | Gateway ALB directly | agent-bridge WSS `/rig` + browser `/caption*` (WS/SSE bypass CloudFront) |

WebSocket upgrades (`/rig`) and SSE (`/caption/replies`) go **direct to the ALB**,
not through CloudFront. *(No opencode subdomain — surface not built.)*

---

## 4. Secrets (Secrets Manager, by name)

| Secret | Used by |
|--------|---------|
| `kelabo/<env>/deepgram` | REST API (mint STT token) |
| `kelabo/<env>/llm` | Agent worker in Gateway (server mode) |
| `kelabo/<env>/cookie-key` | REST API + Gateway (sign/verify cookies + tunnel JWT) |
| `kelabo/<env>/oidc-google`, `.../oidc-apple` | REST API (social login client id/secret) |
| `kelabo/<env>/cloudflare-realtime` | Gateway (Cloudflare Realtime SFU/TURN creds; populated by `make rtc-secrets` — without it RTC degrades to `rtc_unavailable`) |
| `kelabo/<env>/mcp/*` (config `mcpPrefix`) | Agent worker reads (server MCP creds); REST API writes host-pasted tokens |

Dev may use inline values in local profiles; prod always references secrets.

---

## 5. IAM highlights

- **REST Lambda:** DynamoDB RW (kelabos/users/otp/refresh/mcp/contacts), read
  history + read S3 archive (plus narrow `dynamodb:DeleteItem` on history and
  `s3:DeleteObject` on archive objects for `/records/purge`), `ses:SendEmail`,
  Secrets read (deepgram, cookie-key, oidc-*) and Create/Put/Get/Delete/Describe
  under the `kelabo/<env>/mcp/` prefix (host MCP tokens). No `transcribe:*`.
- **Gateway task role:** DynamoDB — kelabos RW, history RW (incl.
  `participant-index`), mcp read + narrow `dynamodb:PutItem` (persists rotated
  OAuth tokens; cannot delete user config) + encrypt/decrypt on the mcp table's
  KMS key, contacts read, refresh `GetItem` (agent-token revocation check); S3
  archive write; Secrets read (cookie-key, **llm**, cloudflare-realtime, and
  Get/Describe under the mcp prefix — because the agent runs here). No separate
  agent role.

---

## 6. Deploy workflow

```
cdk deploy -c env=dev   --all      # isolated dev
cdk deploy -c env=staging --all
cdk deploy -c env=prod  --all
```

- Frontend built with env `VITE_*` then synced to that env's S3 + CloudFront
  invalidation.
- Gateway and Rig are Docker images (DockerImageAsset / ECR); the agent bridge is
  an npm package (`@kelabome/agents`), not an image.
- SES must leave sandbox for prod (verified domain + production access); dev/staging
  can use verified addresses.

---

## 7. Tagging & cost

- Root tags `app=kelabo`, `endpoint=<env>` on all resources → per-env cost
  allocation and easy teardown.
- Cost levers: no NAT, `desiredCount:1` ECS (agent runs in-task — no extra compute
  service), audio direct to Deepgram (no server audio egress), DG mute closes
  sockets, cheap trigger gate keeps the agent idle on ordinary chatter.

---

## 8. Environments as standalone

Each of dev/staging/prod is a complete, isolated deployment (own tables, bucket,
ECS, domains, secrets). No shared resources across envs. Adding an env = add a block
to `kelabo.json` + `cdk deploy -c env=<new>`.

---

## 9. Scaling (infra view)

- **Today:** the whole CDK app deploys into the adopter's own AWS account;
  `allowedEmailDomain` restricts who can register; single tenant (`tenantId` = that
  domain).
- **Scale-out (future, unbuilt):** same stacks; `tenantId = email domain` scopes
  listing/isolation. Raise `desiredCount` and route with
  **kelabo affinity** — each kelabo is assigned to one Gateway task at creation
  (consistent hash on `kelaboId`); the task registers its endpoint in DynamoDB and
  REST hands clients that task's base URL, so all of a kelabo's connections
  (browser SSE/caption, dev tunnel, agent worker) land on one task. **ALB stays**
  with per-task routing (host rules / target groups). Failover = reassign + client
  reconnect (same semantics as a single-task restart). Optionally split the agent
  into its own ECS service sharded the same way. No rewrite of the existing stacks.
