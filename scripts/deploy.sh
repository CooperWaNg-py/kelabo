#!/usr/bin/env bash
# Full env deploy: gateway image -> CDK stacks -> SPA build/sync/invalidate.
# Usage: scripts/deploy.sh <env>   (env = dev|staging|prod)
set -euo pipefail

ENV="${1:?usage: deploy.sh <env>}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "== [1/3] build + push gateway image (env=$ENV) =="
"$ROOT/scripts/build-push-gateway.sh" "$ENV"

echo "== [2/3] cdk deploy --all (env=$ENV) =="
(cd "$ROOT/infra" && npx cdk deploy -c "env=$ENV" --all --require-approval never)

# The task definition references the :latest tag, so CDK alone doesn't roll the
# service when only the image changed — force a redeploy to re-pull it.
echo "== force gateway service redeploy (re-pull :latest) =="
read -r REGION CLUSTER SERVICE <<<"$(cd "$ROOT/config" && KELABO_ENV="$ENV" node --input-type=module -e "
import('./loadConfig.mjs').then((m) => {
  const c = m.loadConfig(process.env.KELABO_ENV);
  console.log([c.region, \`\${c.app}-\${c.endpoint}\`, \`\${c.app}-\${c.endpoint}-gateway\`].join(' '));
});
")"
aws ecs update-service --cluster "$CLUSTER" --service "$SERVICE" --force-new-deployment --region "$REGION" >/dev/null

echo "== [3/3] SPA build + sync + invalidation =="
"$ROOT/scripts/deploy-frontend.sh" "$ENV"

echo "== deploy complete (env=$ENV) =="
