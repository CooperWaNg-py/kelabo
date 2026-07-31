import { Stack, CfnOutput } from "aws-cdk-lib";
import * as route53 from "aws-cdk-lib/aws-route53";

export class DnsStack extends Stack {
  constructor(scope, id, props) {
    super(scope, id, props);
    const { cfg } = props;

    this.zone = route53.HostedZone.fromHostedZoneAttributes(this, "Zone", {
      hostedZoneId: cfg.hostedZone.id,
      zoneName: cfg.hostedZone.name,
    });

    new CfnOutput(this, "HostedZoneName", { value: cfg.hostedZone.name });
  }
}
