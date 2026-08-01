import { Stack, Fn, RemovalPolicy, CfnOutput } from "aws-cdk-lib";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as targets from "aws-cdk-lib/aws-route53-targets";

export class PortalCloudFrontStack extends Stack {
  constructor(scope, id, props) {
    super(scope, id, props);
    const { cfg, zone, portalCert, httpApi } = props;

    this.bucket = new s3.Bucket(this, "PortalBucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    const s3Origin = origins.S3BucketOrigin.withOriginAccessControl(this.bucket);

    const spaFallbackFn = new cloudfront.Function(this, "SpaFallbackFn", {
      code: cloudfront.FunctionCode.fromInline(
        "function handler(event){var r=event.request;if(!r.uri.includes('.')){r.uri='/index.html';}return r;}",
      ),
    });

    const apiDomain = Fn.select(2, Fn.split("/", httpApi.apiEndpoint));
    // Strip the leading /api prefix before forwarding to the API origin, so the
    // Lambda router keeps matching un-prefixed routes (/records, /kelabos, ...).
    const stripApiFn = new cloudfront.Function(this, "StripApiPrefixFn", {
      code: cloudfront.FunctionCode.fromInline(
        "function handler(event){var r=event.request;if(r.uri==='/api'){r.uri='/';}else if(r.uri.indexOf('/api/')===0){r.uri=r.uri.slice(4);}return r;}",
      ),
    });
    const apiBehavior = {
      origin: new origins.HttpOrigin(apiDomain),
      allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
      cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
      originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      functionAssociations: [
        { function: stripApiFn, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST },
      ],
    };

    this.distribution = new cloudfront.Distribution(this, "Distribution", {
      certificate: portalCert,
      domainNames: [cfg.portalDomain, ...(cfg.portalAliases ?? [])],
      defaultRootObject: "index.html",
      defaultBehavior: {
        origin: s3Origin,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        functionAssociations: [
          { function: spaFallbackFn, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST },
        ],
      },
      additionalBehaviors: {
        "/api*": apiBehavior,
      },
    });

    // The portal's own name plus every alias (e.g. the bare apex beside www) —
    // each needs its own A/AAAA pair; nothing redirects a browser from
    // kelabo.me to www.kelabo.me except us serving both.
    [cfg.portalDomain, ...(cfg.portalAliases ?? [])].forEach((domain, i) => {
      const suffix = i === 0 ? "" : `Alias${i}`;
      new route53.ARecord(this, `PortalARecord${suffix}`, {
        zone,
        recordName: domain,
        target: route53.RecordTarget.fromAlias(new targets.CloudFrontTarget(this.distribution)),
      });
      new route53.AaaaRecord(this, `PortalAaaaRecord${suffix}`, {
        zone,
        recordName: domain,
        target: route53.RecordTarget.fromAlias(new targets.CloudFrontTarget(this.distribution)),
      });
    });

    new CfnOutput(this, "PortalUrl", { value: cfg.portalUrl });
    new CfnOutput(this, "PortalBucketName", { value: this.bucket.bucketName });
    new CfnOutput(this, "DistributionId", { value: this.distribution.distributionId });
    new CfnOutput(this, "DistributionDomain", { value: this.distribution.distributionDomainName });
  }
}
