#!/usr/bin/env bash
# Build the gateway image locally and push it to the env's ECR repo.
# Usage: scripts/build-push-gateway.sh <env>   (env = dev|staging|prod)
set -euo pipefail

ENV="${1:?usage: build-push-gateway.sh <env>}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

read -r ACCOUNT REGION REPO TAG <<<"$(cd "$ROOT/config" && KELABO_ENV="$ENV" node --input-type=module -e "
import('./loadConfig.mjs').then((m) => {
  const c = m.loadConfig(process.env.KELABO_ENV);
  console.log([c.account, c.region, c.ecrRepoName, c.gateway.imageTag].join(' '));
});
")"

REGISTRY="${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com"
IMAGE_URI="${REGISTRY}/${REPO}:${TAG}"

echo ">> env=$ENV region=$REGION repo=$REPO tag=$TAG"
echo ">> ensuring ECR repo $REPO exists"
aws ecr describe-repositories --repository-names "$REPO" --region "$REGION" >/dev/null 2>&1 \
  || aws ecr create-repository --repository-name "$REPO" --region "$REGION" >/dev/null
aws ecr put-lifecycle-policy --repository-name "$REPO" --region "$REGION" --lifecycle-policy-text \
  '{"rules":[{"rulePriority":1,"description":"keep recent images","selection":{"tagStatus":"any","countType":"imageCountMoreThan","countNumber":10},"action":{"type":"expire"}}]}' >/dev/null

echo ">> logging in to $REGISTRY"
aws ecr get-login-password --region "$REGION" \
  | docker login --username AWS --password-stdin "$REGISTRY"

echo ">> building $REPO:$TAG from gateway/"
docker build --platform linux/amd64 -f "$ROOT/gateway/Dockerfile" -t "$REPO:$TAG" "$ROOT"

echo ">> pushing $IMAGE_URI"
docker tag "$REPO:$TAG" "$IMAGE_URI"
docker push "$IMAGE_URI"

echo ">> done: $IMAGE_URI"
