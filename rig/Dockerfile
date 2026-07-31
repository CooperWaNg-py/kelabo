FROM node:22-alpine

RUN apk add --no-cache supervisor git openssh-client ca-certificates \
 && npm i -g opencode-ai

WORKDIR /opt/kelabo
COPY contracts/ ./contracts/
COPY connector/ ./connector/
RUN cd connector && npm install --omit=dev

COPY rig/bootstrap.js rig/model-auth.js rig/awsSecrets.js /opt/rig/
COPY rig/supervisord.conf /opt/rig/supervisord.conf
COPY rig/templates/ /opt/rig/templates/

ENTRYPOINT ["node", "/opt/rig/bootstrap.js"]
