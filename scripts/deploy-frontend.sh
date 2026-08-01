#!/usr/bin/env bash
# Build the SPA with the env's VITE_* values (from config), sync to the portal
# bucket and invalidate CloudFront.
# Usage: scripts/deploy-frontend.sh <env>
set -euo pipefail

ENV="${1:?usage: deploy-frontend.sh <env>}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP="kelabo"

eval "$(cd "$ROOT/config" && KELABO_ENV="$ENV" node --input-type=module -e "
import('./loadConfig.mjs').then((m) => {
  const c = m.loadConfig(process.env.KELABO_ENV);
  const out = {
    VITE_API_BASE_URL: c.apiBaseUrl,
    VITE_GATEWAY_BASE_URL: c.gatewayBaseUrl,
    VITE_PORTAL_URL: c.portalUrl,
    VITE_SOCIAL_PROVIDERS: (c.auth?.socialProviders ?? []).join(','),
    // Empty when the env allows any domain — the sign-in page reads that as
    // open registration, exactly as the server does.
    VITE_ALLOWED_EMAIL_DOMAIN: c.allowedEmailDomain ?? '',
    VITE_ENV: c.endpoint,
    KELABO_REGION: c.region,
  };
  for (const [k, v] of Object.entries(out)) console.log(\`export \${k}='\${v}'\`);
});
")"

PORTAL_STACK="${APP}-${ENV}-portal"
get_output() {
  aws cloudformation describe-stacks \
    --stack-name "$PORTAL_STACK" --region "$KELABO_REGION" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text
}

BUCKET="$(get_output PortalBucketName)"
DIST_ID="$(get_output DistributionId)"
echo ">> portal bucket: $BUCKET"
echo ">> distribution:  $DIST_ID"

echo ">> building SPA with VITE_API_BASE_URL=$VITE_API_BASE_URL VITE_GATEWAY_BASE_URL=$VITE_GATEWAY_BASE_URL VITE_PORTAL_URL=$VITE_PORTAL_URL VITE_ENV=$VITE_ENV"
(cd "$ROOT/spa" && npm install && npm run build)

echo ">> syncing spa/dist -> s3://$BUCKET"
# --only-show-errors: the per-file progress lines are noise to whoever ran
# `make frontend` — a quiet sync that speaks only when something fails is the
# useful shape. The bucket/dist echoes above are the receipt.
aws s3 sync "$ROOT/spa/dist" "s3://$BUCKET" --delete --region "$KELABO_REGION" --only-show-errors

echo ">> creating CloudFront invalidation /*"
aws cloudfront create-invalidation --distribution-id "$DIST_ID" --paths "/*" >/dev/null

echo "== frontend deployed (env=$ENV) =="
