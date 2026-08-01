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
      // The apex (or any other alias) the portal also answers on — a browser
      // never falls back from kelabo.me to www.kelabo.me by itself.
      ...(cfg.portalAliases?.length ? { subjectAlternativeNames: cfg.portalAliases } : {}),
      validation: acm.CertificateValidation.fromDns(zone),
    });
  }
}
