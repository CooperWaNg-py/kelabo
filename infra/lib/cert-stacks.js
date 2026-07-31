import { Stack } from "aws-cdk-lib";
import * as acm from "aws-cdk-lib/aws-certificatemanager";

export class CertStack extends Stack {
  constructor(scope, id, props) {
    super(scope, id, props);
    const { cfg, zone } = props;

    this.gatewayCert = new acm.Certificate(this, "GatewayCert", {
      domainName: cfg.gatewayDomain,
      validation: acm.CertificateValidation.fromDns(zone),
    });
  }
}

export class CertStackUsEast1 extends Stack {
  constructor(scope, id, props) {
    super(scope, id, props);
    const { cfg, zone } = props;

    this.portalCert = new acm.Certificate(this, "PortalCert", {
      domainName: cfg.portalDomain,
      validation: acm.CertificateValidation.fromDns(zone),
    });
  }
}
