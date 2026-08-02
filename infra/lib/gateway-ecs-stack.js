import { Stack, CfnOutput } from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as iam from "aws-cdk-lib/aws-iam";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as targets from "aws-cdk-lib/aws-route53-targets";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import { ApplicationLoadBalancedFargateService } from "aws-cdk-lib/aws-ecs-patterns";
import { execSync } from "node:child_process";

function credentialsAccount() {
  try {
    return execSync("aws sts get-caller-identity --query Account --output text", {
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 8000,
    })
      .toString()
      .trim();
  } catch {
    return undefined;
  }
}

export class GatewayEcsStack extends Stack {
  constructor(scope, id, props) {
    super(scope, id, props);
    const { cfg, zone, certificate, tables, archiveBucket } = props;
    const names = cfg.tableNames;

    let vpc;
    let vpcMode;
    const forced = this.node.tryGetContext("vpcMode");
    const credAccount = credentialsAccount();
    if (forced === "new" || credAccount !== cfg.account) {
      vpcMode = `fallback-synth-only-vpc (credential account ${credAccount ?? "none"} != config account ${cfg.account})`;
      vpc = ec2.Vpc.fromVpcAttributes(this, "Vpc", {
        vpcId: "vpc-00000000000000000",
        availabilityZones: [`${cfg.region}a`, `${cfg.region}b`],
        publicSubnetIds: ["subnet-00000000000000000", "subnet-00000000000000001"],
      });
    } else {
      try {
        vpcMode = "default-vpc-lookup";
        vpc = ec2.Vpc.fromLookup(this, "Vpc", { isDefault: true });
      } catch (err) {
        vpcMode = "fallback-synth-only-vpc (lookup failed)";
        vpc = ec2.Vpc.fromVpcAttributes(this, "Vpc", {
          vpcId: "vpc-00000000000000000",
          availabilityZones: [`${cfg.region}a`, `${cfg.region}b`],
          publicSubnetIds: ["subnet-00000000000000000", "subnet-00000000000000001"],
        });
      }
    }
    console.log(`[GatewayEcsStack] VPC source: ${vpcMode}`);

    this.repo = ecr.Repository.fromRepositoryName(this, "GatewayRepo", cfg.ecrRepoName);

    const cluster = new ecs.Cluster(this, "Cluster", {
      vpc,
      clusterName: `${cfg.app}-${cfg.endpoint}`,
    });

    this.service = new ApplicationLoadBalancedFargateService(this, "GatewayService", {
      cluster,
      serviceName: `${cfg.app}-${cfg.endpoint}-gateway`,
      cpu: cfg.gateway.cpu,
      memoryLimitMiB: cfg.gateway.memoryMiB,
      // Graviton when the config says so — the image must be built for the
      // same architecture (scripts/build-push-gateway.sh reads the same knob).
      runtimePlatform: {
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
        cpuArchitecture:
          cfg.gateway.arch === "arm64" ? ecs.CpuArchitecture.ARM64 : ecs.CpuArchitecture.X86_64,
      },
      desiredCount: cfg.gateway.desiredCount,
      taskSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      assignPublicIp: true,
      publicLoadBalancer: true,
      certificate,
      redirectHTTP: true,
      // The pattern's default is to open the listener to 0.0.0.0/0. When
      // `allowIps` is set that rule has to be absent rather than merely joined
      // by narrower ones — a security group is a union, so an open rule beside
      // an allowlist is just an open rule. The replacements go in below.
      openListener: cfg.allowIps.length === 0,
      circuitBreaker: { rollback: true },
      taskImageOptions: {
        image: ecs.ContainerImage.fromEcrRepository(this.repo, cfg.gateway.imageTag),
        containerPort: 8080,
        environment: {
          KELABO_ENV: cfg.endpoint,
          KELABO_REGION: cfg.region,
          KELABO_PORTAL_URL: cfg.portalUrl,
          KELABO_GATEWAY_BASE_URL: cfg.gatewayBaseUrl,
          KELABO_COOKIE_DOMAIN: cfg.cookieDomain,
          KELABO_TENANT_ID: cfg.allowedEmailDomain,
          KELABO_TABLE_KELABOS: names.kelabos,
          KELABO_TABLE_HISTORY: names.history,
          KELABO_TABLE_MCP: names.mcp,
          // Agent bridge tokens are revocable rows in the refresh table
          // (docs 16); the Gateway reads one per tunnel connection.
          KELABO_TABLE_REFRESH: names.refresh,
          // Read-only: the Gateway reads a subscriber's accepted external peers
          // to scope presence fan-out (docs 18 §5). It must never mutate a link.
          KELABO_TABLE_CONTACTS: names.contacts,
          KELABO_CONTACTS_EXTERNAL: String(cfg.contacts.external),
          KELABO_ARCHIVE_BUCKET: cfg.archiveBucket,
          KELABO_ARCHIVE_KEY_PREFIX: cfg.archiveKeyPrefix,
          KELABO_SECRET_COOKIE_KEY: cfg.secrets.cookieSigningKey,
          KELABO_SECRET_LLM: cfg.secrets.llm,
          KELABO_SECRET_MCP_PREFIX: cfg.secrets.mcpPrefix,
          KELABO_SECRET_CLOUDFLARE_RTC: cfg.secrets.cloudflareRealtime,
          KELABO_RTC_API_BASE: cfg.rtcApiBase,
          KELABO_RTC_DEFAULT_MODE: cfg.rtc.defaultMode,
          KELABO_RTC_MESH_MAX: String(cfg.rtc.meshMaxParticipants),
          KELABO_RTC_ICE_TTL: String(cfg.rtc.iceTtlSeconds),
          KELABO_RTC_DISCONNECT_GRACE: String(cfg.rtc.disconnectGraceSeconds),
          KELABO_RTC_VIDEO: String(cfg.rtc.video),
          KELABO_LLM_PROVIDER: cfg.llm.provider,
          KELABO_LLM_MODEL: cfg.llm.model,
          KELABO_LLM_SMALL_MODEL: cfg.llm.smallModel,
          ...(cfg.llm.baseUrl ? { KELABO_OPENAI_BASE_URL: cfg.llm.baseUrl } : {}),
          // (No STT settings here. The gateway never speaks to a transcription
          // provider — it only ever sees text captions — and the two vars that
          // used to be set were read by nothing.)
          KELABO_RETENTION_DAYS: String(cfg.retentionDays),
          KELABO_AGENT_MAX_CONCURRENT_RUNS: String(cfg.gateway.agent.maxConcurrentRuns),
          KELABO_AGENT_MAX_DISPATCH_PER_TURN: String(cfg.gateway.agent.maxDispatchPerTurn ?? 3),
          KELABO_AGENT_SENSITIVITY: cfg.gateway.agent.sensitivity,
          KELABO_AGENT_MAX_CONTRIB_PER_MIN: String(cfg.gateway.agent.maxContributionsPerMinute),
          KELABO_AGENT_COOLDOWN_SECONDS: String(cfg.gateway.agent.cooldownSeconds),
          KELABO_AGENT_ROLLING_WINDOW: String(cfg.gateway.agent.rollingWindowSize),
        },
      },
    });

    this.service.targetGroup.configureHealthCheck({ path: "/health" });
    this.service.loadBalancer.setAttribute("idle_timeout.timeout_seconds", "240");

    // `allowIps` — the Gateway's half of it (the portal's is a WAF WebACL, see
    // waf-stack.js). A security group rather than WAF because the ALB is
    // regional and already has one: refusing the connection is stronger than
    // accepting it and answering 403, and it costs nothing.
    //
    // Port 80 is listed as well as 443 only because `redirectHTTP` above opens
    // it. Leaving it out would not be safer — it would make an allowlisted
    // browser typing `http://` hang instead of being redirected, which reads as
    // the service being down.
    if (cfg.allowIps.length) {
      const lb = this.service.loadBalancer;
      const open = (peer, label) => {
        lb.connections.allowFrom(peer, ec2.Port.tcp(443), `allowIps ${label}`);
        lb.connections.allowFrom(peer, ec2.Port.tcp(80), `allowIps ${label} (http redirect)`);
      };
      for (const cidr of cfg.allowIpsV4) open(ec2.Peer.ipv4(cidr), cidr);
      for (const cidr of cfg.allowIpsV6) open(ec2.Peer.ipv6(cidr), cidr);
    }

    // `make allow-ip` edits this group live, so it has to be findable without
    // guessing at a name CloudFormation generated.
    new CfnOutput(this, "GatewayAlbSecurityGroupId", {
      value: this.service.loadBalancer.connections.securityGroups[0].securityGroupId,
    });

    const taskRole = this.service.taskDefinition.taskRole;
    tables.kelabos.grantReadWriteData(taskRole);
    // Write, because ending a kelabo archives it here. Read as well, because
    // the assistant's optional memory of earlier kelabos (notes #3) queries
    // `participant-index` for the host's own past kelabos. `grantReadWriteData`
    // covers the index too — a plain table grant does not, and the failure mode
    // is an AccessDenied on the GSI only, which looks exactly like "this host
    // has no history".
    tables.history.grantReadWriteData(taskRole);
    tables.mcp.grantReadData(taskRole);
    // Presence fan-out reads a subscriber's accepted external peers (docs 18
    // §5). Read only — links are created and destroyed by the REST API alone.
    tables.contacts.grantReadData(taskRole);
    // The gateway is the only component that sees a 401 from an MCP server, so
    // it owns the OAuth refresh grant and must persist the rotated tokens.
    // Deliberately PutItem only — not grantReadWriteData — so a compromised
    // gateway still cannot delete a user's MCP configuration.
    taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({ actions: ["dynamodb:PutItem"], resources: [tables.mcp.tableArn] }),
    );
    // grantReadData already added kms:Decrypt for the table's CMK; writing needs
    // the encrypt half as well.
    tables.mcp.encryptionKey?.grantEncryptDecrypt(taskRole);
    // Agent bridge tokens live in the refresh table (docs 16 §6). Read only: the
    // Gateway checks whether one was revoked, and must never be able to mint,
    // revoke or delete a credential — nor to read the browser refresh tokens
    // that share the table, which is why this is GetItem on the table alone and
    // not a grant over its identity-index.
    taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({ actions: ["dynamodb:GetItem"], resources: [tables.refresh.tableArn] }),
    );
    archiveBucket.grantWrite(taskRole);

    secretsmanager.Secret.fromSecretNameV2(this, "SecretCookieKey", cfg.secrets.cookieSigningKey).grantRead(taskRole);
    secretsmanager.Secret.fromSecretNameV2(this, "SecretLlm", cfg.secrets.llm).grantRead(taskRole);
    // Cloudflare Realtime SFU app credentials + TURN key. The Gateway is the
    // only component that holds them: the browser never sees more than an SDP
    // answer and short-lived ICE credentials (docs 15).
    secretsmanager.Secret.fromSecretNameV2(this, "SecretCloudflareRtc", cfg.secrets.cloudflareRealtime).grantRead(taskRole);
    taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ["secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret"],
        resources: [`arn:aws:secretsmanager:${cfg.region}:${cfg.account}:secret:${cfg.secrets.mcpPrefix}*`],
      }),
    );

    new route53.ARecord(this, "GatewayARecord", {
      zone,
      recordName: cfg.gatewayDomain,
      target: route53.RecordTarget.fromAlias(new targets.LoadBalancerTarget(this.service.loadBalancer)),
    });
    new route53.AaaaRecord(this, "GatewayAaaaRecord", {
      zone,
      recordName: cfg.gatewayDomain,
      target: route53.RecordTarget.fromAlias(new targets.LoadBalancerTarget(this.service.loadBalancer)),
    });

    new CfnOutput(this, "GatewayAlbDns", { value: this.service.loadBalancer.loadBalancerDnsName });
    new CfnOutput(this, "GatewayUrl", { value: cfg.gatewayBaseUrl });
    new CfnOutput(this, "EcrRepoUri", { value: this.repo.repositoryUri });
  }
}
