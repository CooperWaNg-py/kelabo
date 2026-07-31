# Self-hosting Kelabo

Kelabo is a meeting and calling workspace for one organisation: live rooms with
transcription, an AI assistant that answers into the meeting, minutes written
for you, and a searchable archive of everything your team decided. Each live
room is a *kelabo* — the word the app and the rest of this guide use. This
guide takes you from an empty AWS account to your team signing in at
`kelabo.mycompany.com`.

It is written for the person who runs infrastructure at a small-to-medium
organisation. You do not need to know the codebase; you do need to be
comfortable with a terminal, DNS, and an AWS bill.

---

## A. What self-hosting takes

Self-hosting puts the data boundary inside your organisation's own AWS
account — transcripts, minutes and the archive never leave infrastructure you
control (audio goes to your own Deepgram account for transcription; assistant
prompts go to your own LLM account).

| | |
|---|---|
| **Requirements** | An AWS account with admin access, a domain (or subdomain) whose DNS is a Route 53 hosted zone, a Deepgram API key, an LLM API key (DeepSeek), and optionally Cloudflare Realtime credentials for conference audio/video. Locally: Node 20+, Docker, the AWS CLI. |
| **Effort** | An afternoon for the first deployment, most of it waiting on account signups and certificate validation. Ongoing effort is close to zero: the stack is serverless except one small container, and `make deploy` is the whole upgrade procedure. |
| **Risk** | You are the operator. If SES stays in sandbox mode, sign-in emails only reach verified addresses until you request production access (see §C1). If a supplier key expires, that feature degrades (calls without Cloudflare credentials fall back to transcript + board). Nothing in the stack holds unrecoverable state outside your account. |
| **Benefit** | Totally self-contained, and you pay for what you actually use: every datastore and function is pay-per-request. The only always-on cost is one Fargate task (0.5 vCPU / 1 GB — roughly US$15–20/month) plus its load balancer; an idle deployment costs little more than that, and a busy one scales with actual kelabos, not seats. |

---

## B. The suppliers, and why each one

Kelabo deliberately buys rather than builds four things:

- **AWS** — everything that is Kelabo itself runs here: the web app (S3 +
  CloudFront), the REST API (Lambda), the realtime gateway (one Fargate
  container behind a load balancer), storage (DynamoDB + S3), sign-in email
  (SES), DNS and certificates (Route 53 + ACM), and secrets (Secrets Manager).
  One account, one region, one `make deploy`.
- **Deepgram** — live speech-to-text. Transcription quality is the floor under
  everything Kelabo does (the board, the assistant, the minutes all read the
  transcript), and Deepgram's streaming API is accurate, fast and priced per
  audio minute. Free tier credit is enough to evaluate seriously.
- **DeepSeek** — the LLM behind the in-kelabo assistant and the generated
  minutes. Chosen as the default for cost: minutes generation reads whole
  transcripts, and DeepSeek makes that a rounding error. The key goes in your
  account; the provider is configurable.
- **Cloudflare Realtime** *(optional)* — the SFU and TURN service that carries
  conference audio and video between participants. Running your own media
  servers is the single hardest part of a product like this; Cloudflare sells
  it as an API, priced per usage. **Without it, Kelabo still works** — rooms
  run in transcript + board mode, and peer-to-peer ("secure") calls for small
  groups still connect directly.

---

## C. Set up each supplier

### C1. AWS

1. Use (or create) an AWS account you administer. Create an IAM identity with
   admin access and configure it locally: `aws configure --profile myorg`
   (any profile name; pass it to every make command as `AWS_PROFILE=myorg`,
   or export it).
2. Put your domain's DNS in a **Route 53 hosted zone**. Either transfer the
   whole domain, or delegate just a subdomain (create a zone for
   `kelabo.mycompany.com` and add its NS records at your main DNS host).
   Note the **hosted zone ID** (`Z…`) — the config needs it.
3. **SES sandbox**: new AWS accounts can only send email to addresses you have
   individually verified. That is fine for testing (verify your own address in
   the SES console), but before the whole team signs in, request **production
   access** in SES (a one-page form, usually approved within a day). Sign-in
   codes are the only mail Kelabo sends.
4. One-time per account/region: bootstrap the CDK (step D3 below).

### C2. Deepgram

Create an account at deepgram.com and create an API key **with the Member
role — not the default owner/admin scope**. Kelabo never sends your key to
the browser; it uses it server-side to mint short-lived tokens via Deepgram's
`/v1/auth/grant` endpoint, and that endpoint rejects owner/admin-scoped keys.
The symptom of the wrong scope is not an obvious error at deploy time — it is
transcription failing later with `stt_unavailable` (a `deepgram grant 4xx`
line in the REST API log, §G).

That is all — the key goes into Secrets Manager in step D4 and is never
stored anywhere else.

### C3. DeepSeek

Create an API key at platform.deepseek.com. Same handling: Secrets Manager
only.

### C4. Cloudflare Realtime (optional, for conference audio/video)

In the Cloudflare dashboard create a **Realtime (Calls) app** — note the app
ID and secret — and a **TURN key** (ID + token). You can skip this entirely
at first and add it later with `make rtc-secrets` + `make restart`; rooms
degrade gracefully until then.

---

## D. Configure the deployment

All configuration is one file. Nothing anywhere else needs editing.

1. **Create your config from the template:**

   ```bash
   cp config/template.json config/kelabo.json
   ```

   `config/kelabo.json` is gitignored — it is *your* deployment's identity and
   never belongs in a public repository.

2. **Edit `config/kelabo.json`.** The fields that must change:

   | Field | Meaning |
   |---|---|
   | `baseDomain` | e.g. `mycompany.com` — every endpoint hangs off this |
   | `environments.<env>.account` / `region` | your AWS account ID and region |
   | `environments.<env>.hostedZone.name` / `id` | the Route 53 zone from C1 |
   | `environments.<env>.subdomains.portal` / `gateway` | e.g. `kelabo` and `gw.kelabo` → `kelabo.mycompany.com`, `gw.kelabo.mycompany.com` |
   | `environments.<env>.allowedEmailDomain` | e.g. `mycompany.com` — **this is your tenant boundary**: only addresses at this domain can sign in, and everyone at it is one organisation |
   | `environments.<env>.ses.fromAddress` | e.g. `kelabo@mycompany.com` — where sign-in codes come from |
   | `environments.<env>.ses.createIdentity` | leave unset. Set `false` only when another env in the same account already verified the sending domain (SES identities are account-scoped; two stacks can't create the same one) |

   Leave `auth.socialProviders` as `[]` — work-email sign-in is the
   self-hosting identity path. (Google/Apple sign-in requires registering
   OAuth apps and adding their client secrets first.)

   The `environments` block has `dev`, `staging` and `prod` entries — they are
   independent deployments; configure the ones you will use (§E uses two).

3. **Install and bootstrap:**

   ```bash
   make bootstrap                                  # npm install everywhere
   cd infra && npx cdk bootstrap aws://<account-id>/<region> -c env=dev && cd ..
   ```

   `cdk bootstrap` is once per account+region, ever.

4. **Create the secrets** (names are conventional; the stacks look them up):

   ```bash
   AWS_PROFILE=myorg make secrets env=dev DEEPGRAM_API_KEY=… LLM_API_KEY=…
   AWS_PROFILE=myorg make rtc-secrets env=dev CF_SFU_APP_ID=… CF_SFU_APP_SECRET=… \
       CF_TURN_KEY_ID=… CF_TURN_KEY_TOKEN=…      # optional — see C4
   ```

---

## E. Test deployment first

Don't aim the first deploy at the address your team will bookmark. The config
already gives you the mechanism: use one environment block as the rehearsal.
For example, in `environments.dev` set `subdomains.portal` to `test-kelabo`
(→ `test-kelabo.mycompany.com`) and keep `environments.prod` pointed at
`kelabo` for later.

```bash
AWS_PROFILE=myorg make deploy env=dev
```

The first run builds the gateway image, deploys nine CloudFormation stacks
(DNS records, two certificates, tables, mail identity, the REST Lambda, API,
gateway, portal)
and syncs the web app. Certificate validation can add ~10 quiet minutes the
first time.

**Then rehearse the product, not just the deploy:**

1. Open `https://test-kelabo.mycompany.com`, sign in with a company address
   (in SES sandbox: one you verified). The code email should arrive within
   seconds.
2. Start a kelabo, speak — the transcript should follow you. Address the
   assistant and watch the board.
3. Second browser/colleague: join by invite link, and try a call from
   Contacts. If you configured Cloudflare, you should hear each other; if
   not, you should still see transcript + board.
4. End it, and check the record appears under Kelabos with minutes arriving a
   moment later; try the search.

`make test` (no AWS needed) runs every package's test suite locally if you
want the belt-and-braces check first.

---

## F. Final deployment

When the rehearsal holds up, do the same thing at the real address:

1. Fill in `environments.prod` (same account or a separate one; `subdomains.portal: "kelabo"`).
2. `cdk bootstrap` if prod lives in a different account/region.
3. `make secrets env=prod …` (and `rtc-secrets`) — secrets are per environment.
4. `AWS_PROFILE=myorg make deploy env=prod`
5. Confirm SES production access is granted (C1.3) *before* announcing it —
   sandbox mode is the classic "works for me, broken for everyone else".

Upgrades from then on: pull the new code, `make deploy env=prod`. The test
environment is also your upgrade rehearsal: deploy there first, click through
§E, then promote. To tear an environment down, delete its CloudFormation
stacks (`kelabo-<env>-*`); tables and the archive bucket are retained on
delete so data outlives mistakes.

---

## G. Something broke — collecting logs for a GitHub issue

Every server-side log is in CloudWatch, in your account. The two that matter:

```bash
# REST API (sign-in, kelabos, records, contacts):
aws logs tail /aws/lambda/kelabo-<env>-rest-api --since 1h --profile myorg

# Realtime gateway (transcription, presence, calls, assistant):
aws logs tail "$(aws logs describe-log-groups \
    --query "logGroups[?contains(logGroupName, 'kelabo-<env>-gateway')].logGroupName" \
    --output text --profile myorg)" --since 1h --profile myorg
```

Both services log single-line JSON with an `msg` field and no message
contents — grep for `"level":"warn"` and `"level":"error"` first. For browser
issues, the devtools console plus the failing request from the Network tab
(status + response body) is what the issue needs.

When you open an issue at github.com/kelabome/kelabo, include: what you did,
what happened instead, the relevant log lines from the commands above
(**check them for anything your org considers sensitive first** — log lines
carry ids and email addresses, not content, but it is your call), your
`config/kelabo.json` **with account/zone ids removed**, and the commit you
deployed (`git rev-parse --short HEAD`).
