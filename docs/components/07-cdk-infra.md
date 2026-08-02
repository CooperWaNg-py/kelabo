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
| **PortalCloudFrontStack** | S3 (OAC) + CloudFront; a single **`/api*` behavior** to the HTTP API with a CloudFront function stripping the `/api` prefix; SPA-fallback function rewrites non-dotted URIs to `/index.html`; deploy `spa/dist`; A-record portal subdomain | `webAclId` when `allowIps` is set |
| **WafStack (us-east-1)** | CLOUDFRONT-scope WebACL, default **block**, one allow rule over an IPv4 and an IPv6 `IPSet` | only when `allowIps` is non-empty |

### `allowIps` — closing a deployment to a list of sources

Empty (the default) is open, and nothing below is synthesized. Non-empty closes
the **whole** deployment, which takes two different mechanisms because the
browser reaches CloudFront and the Gateway ALB by separate names:

- **CloudFront** — a WAF WebACL, because a distribution has no security group.
  CLOUDFRONT scope exists only in us-east-1, so it is its own stack and the ARN
  crosses regions on the same `crossRegionReferences` path as the portal cert.
- **Gateway ALB** — a security group. `openListener: false` suppresses the
  pattern's own `0.0.0.0/0` rules, which matters: a security group is a union,
  so an open rule beside an allowlist is just an open rule. Port 80 is listed
  as well as 443 only because `redirectHTTP` opens it.

Both families are carried. CloudFront answers on IPv6 by default, so a list
holding only someone's IPv4 address blocks them the moment their browser
prefers IPv6 — and that reads as an outage, not as a rule.

`make allow-ip` / `allow-list` / `allow-rm` (`scripts/allowlist.sh`) write
`config/kelabo.json` *and* edit the IPSets and the security group live, so a new
address works in seconds and the next deploy re-asserts the same thing. The two
exceptions are the first lock and the last unlock: those add or remove a stack
and the ALB's open rule, which only a deploy can do, and the script says so
instead of appearing to succeed.

**The execute-api bypass, and `api.originSecret`.** API Gateway always answers
on its own `https://<id>.execute-api.<region>.amazonaws.com` URL, which reaches
the same Lambda while passing neither CloudFront nor the WebACL. Left alone,
`allowIps` closes the portal and the Gateway and does *nothing* for the control
plane — the whole of `/auth`, `/kelabos`, `/records` stays open to the internet.
It gives an allowlisted deployment a false sense of being closed, which is worse
than being visibly open.

It cannot be closed by address, and the reasons are worth recording because each
looks like the answer:

- **WAF** supports API Gateway *REST* APIs. This is an **HTTP** API, so no.
- **A resource policy** — HTTP APIs do not support them at all. And an IP rule
  could not work anyway: requests arrive from **CloudFront's edge**, not the
  visitor's, so allowing the visitor blocks CloudFront, and allowing
  CloudFront's ranges admits everyone else's distribution.
- **`disableExecuteApiEndpoint`** needs a custom domain, and a CloudFront origin
  must resolve publicly — so the custom domain becomes the new bypass. This is
  the trap: it reads as the clean fix and merely moves the hole.

What works is a secret only CloudFront knows. It injects `x-kelabo-origin` as a
**custom origin header** (set after the viewer request, so a caller cannot forge
it by sending one), and the Lambda requires it. The raw endpoint stays up and
becomes useless. The gate runs before the body is parsed and **fails closed** if
the secret cannot be read — a gate that opens when it loses its secret is not a
gate, and that failure takes the API down, which is the correct direction.

`api.originSecret` has three states, not two, because the safe rollout has a
middle one:

| | CloudFront sends | Lambda requires |
|---|---|---|
| `off` (default) | no | no |
| `send` | yes | no |
| `require` | yes | yes |

**The order is not optional.** The Lambda stack deploys *before* the portal
stack (`infra/bin/kelabo.js`), so going straight to `require` means the API
rejects CloudFront's own traffic until the distribution catches up — a
control-plane outage for the length of the deploy. And the header value is a
CloudFormation *dynamic reference*, resolved during deploy, so the secret must
exist before the portal stack is deployed at all:

```
make origin-secret env=<env>    # generates it; idempotent, never overwrites
# set api.originSecret = "send", then:
make deploy env=<env>
# confirm the header arrives, set "require", then:
make deploy env=<env>
```

An unrecognised value throws instead of defaulting to `off`: a typo that quietly
meant "open" is the one failure this knob exists to prevent. Rotating the secret
later needs the portal and the Lambda redeployed together, so `make
origin-secret` refuses to overwrite an existing value.

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
  can use verified addresses. Sandbox status, quota, reputation and the
  bounce/complaint suppression list are all **account+region** scoped and nothing
  inside an identity separates two domains sharing one, so `ses.region` puts an
  environment's mail in another region when it must not affect another
  environment's — e.g. granting production access to a test env while production
  stays sandboxed. `SesStack` then deploys to that region (`sesEnv` in
  `infra/bin/kelabo.js`) and the Lambda gets `KELABO_SES_REGION`; unset, it is
  the environment's own region and nothing changes.
- **`ses.spf` / `ses.dmarc` publish one record each, and both are opt-in for the
  same reason: a domain may hold only one of either.** A deployment whose domain
  already carries a policy from its mail provider would get a second record and a
  failed deploy. `dmarc: true` writes `v=DMARC1; p=none;` — monitor-only, the
  sole safe opening policy, since anything stricter quarantines mail from senders
  nobody has inventoried yet. `spf: true` writes
  `v=spf1 include:amazonses.com -all`. Be clear on what SPF buys: it is evaluated
  against the *envelope* sender, and SES's default envelope is
  `<id>@<region>.amazonses.com`, so this record does **not** authenticate our own
  mail and is not what makes DMARC pass — Easy DKIM is. It denies the domain to
  anyone else's envelope. SPF *alignment* would need a custom MAIL FROM
  subdomain, which neither knob provides.
- **Two environments may share a hosted zone, but only one may own its mail
  records.** DKIM CNAMEs, the apex SPF and `_dmarc` are singletons per *domain*,
  while portal/gateway records are per *subdomain* and never collide. So
  `corp.kelabo.dev` (dev) and `saas.kelabo.dev` (saasdev) coexist in one zone
  happily, and the mail records there belong to exactly one stack. What keeps
  them apart is `ses.hostedZone`: dev points it at the *other* domain, so its
  `SesStack` writes SPF/DMARC/DKIM into that zone instead. Point two
  environments' `ses.hostedZone` at the same zone with `spf`/`dmarc` on and both
  stacks try to create the same record, which fails the deploy with "already
  exists". **No code can catch this** — the two configs are separate files (and
  on a fork, separate branches), so no single `loadConfig` call ever sees both.
  It is a convention or it is nothing.

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
