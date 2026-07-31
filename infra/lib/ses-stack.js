import { Stack, CfnOutput } from "aws-cdk-lib";
import * as ses from "aws-cdk-lib/aws-ses";
import * as route53 from "aws-cdk-lib/aws-route53";

export class SesStack extends Stack {
  constructor(scope, id, props) {
    super(scope, id, props);
    const { cfg, zone } = props;

    // NOTE: SES starts in sandbox mode. Prod requires a sandbox-exit
    // (production access) request in the AWS console before OTP email flows.
    // The verified identity is the from-address domain; when it differs from
    // the env zone (e.g. dev sends from the apex domain), cfg.ses.hostedZone
    // points at the zone that owns it.
    const sesZone = cfg.ses.hostedZone
      ? route53.HostedZone.fromHostedZoneAttributes(this, "SesZone", {
          hostedZoneId: cfg.ses.hostedZone.id,
          zoneName: cfg.ses.hostedZone.name,
        })
      : zone;

    this.identity = new ses.EmailIdentity(this, "DomainIdentity", {
      identity: ses.Identity.publicHostedZone(sesZone),
    });

    new CfnOutput(this, "SesIdentityDomain", { value: sesZone.zoneName });
    new CfnOutput(this, "SesFromAddress", { value: cfg.ses.fromAddress });
  }
}
