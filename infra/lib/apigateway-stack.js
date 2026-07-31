import { Stack, CfnOutput } from "aws-cdk-lib";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";

export class ApiGatewayStack extends Stack {
  constructor(scope, id, props) {
    super(scope, id, props);
    const { cfg, fn } = props;

    const integration = new HttpLambdaIntegration("LambdaIntegration", fn);

    this.httpApi = new apigwv2.HttpApi(this, "HttpApi", {
      apiName: `${cfg.app}-${cfg.endpoint}-api`,
    });
    this.httpApi.addRoutes({
      path: "/{proxy+}",
      methods: [apigwv2.HttpMethod.ANY],
      integration,
    });
    this.httpApi.addRoutes({
      path: "/",
      methods: [apigwv2.HttpMethod.ANY],
      integration,
    });

    new CfnOutput(this, "ApiUrl", { value: this.httpApi.apiEndpoint });
  }
}
