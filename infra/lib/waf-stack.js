import { Stack, CfnOutput } from "aws-cdk-lib";
import * as wafv2 from "aws-cdk-lib/aws-wafv2";

/**
 * The CloudFront half of `allowIps` — the portal and, through it, the REST API.
 *
 * It is its own stack, in us-east-1, because a CLOUDFRONT-scope WebACL only
 * exists there. The distribution it protects is global and the portal stack
 * that owns it is in the environment's home region, so this cannot simply be a
 * few more lines over there; the ARN crosses regions through the same
 * `crossRegionReferences` machinery that already carries the portal
 * certificate.
 *
 * The Gateway's half is deliberately *not* WAF but a security group
 * (`gateway-ecs-stack.js`): the ALB is a regional resource that already has a
 * network-layer control attached, an SG refuses the connection rather than
 * accepting it and answering 403, and it costs nothing. WAF is used here only
 * because CloudFront has no security group to put a rule in.
 *
 * Nothing in this stack is created when `allowIps` is empty — `infra/bin` skips
 * the stack entirely, so an open deployment carries no WebACL and no charge.
 */
export class WafStack extends Stack {
  constructor(scope, id, props) {
    super(scope, id, props);
    const { cfg } = props;

    // Two sets rather than one: an IPSet holds a single address family, and
    // both are needed because a dual-stack viewer picks the family, not us.
    // Either may be empty; an empty set simply never matches.
    this.ipSetV4 = new wafv2.CfnIPSet(this, "AllowIpSetV4", {
      name: `${cfg.app}-${cfg.endpoint}-allow-v4`,
      scope: "CLOUDFRONT",
      ipAddressVersion: "IPV4",
      addresses: cfg.allowIpsV4,
      description: `IPv4 sources allowed to reach ${cfg.portalDomain}`,
    });
    this.ipSetV6 = new wafv2.CfnIPSet(this, "AllowIpSetV6", {
      name: `${cfg.app}-${cfg.endpoint}-allow-v6`,
      scope: "CLOUDFRONT",
      ipAddressVersion: "IPV6",
      addresses: cfg.allowIpsV6,
      description: `IPv6 sources allowed to reach ${cfg.portalDomain}`,
    });

    this.webAcl = new wafv2.CfnWebACL(this, "AllowWebAcl", {
      name: `${cfg.app}-${cfg.endpoint}-allow`,
      scope: "CLOUDFRONT",
      // Deny by default and name the exceptions. The inverse — allow by default
      // and block a list — is not the same feature and cannot be made into it.
      defaultAction: { block: {} },
      visibilityConfig: {
        cloudWatchMetricsEnabled: true,
        metricName: `${cfg.app}-${cfg.endpoint}-allow`,
        sampledRequestsEnabled: true,
      },
      rules: [
        {
          name: "AllowListedSources",
          priority: 0,
          action: { allow: {} },
          statement: {
            orStatement: {
              statements: [
                { ipSetReferenceStatement: { arn: this.ipSetV4.attrArn } },
                { ipSetReferenceStatement: { arn: this.ipSetV6.attrArn } },
              ],
            },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: `${cfg.app}-${cfg.endpoint}-allow-listed`,
            sampledRequestsEnabled: true,
          },
        },
      ],
    });

    this.webAclArn = this.webAcl.attrArn;

    // `make allow-ip` / `allow-list` read these rather than guessing names, and
    // an id is what update-ip-set wants alongside the name and scope.
    new CfnOutput(this, "AllowIpSetV4Id", { value: this.ipSetV4.attrId });
    new CfnOutput(this, "AllowIpSetV4Name", { value: this.ipSetV4.name });
    new CfnOutput(this, "AllowIpSetV6Id", { value: this.ipSetV6.attrId });
    new CfnOutput(this, "AllowIpSetV6Name", { value: this.ipSetV6.name });
    new CfnOutput(this, "AllowWebAclArn", { value: this.webAcl.attrArn });
  }
}
