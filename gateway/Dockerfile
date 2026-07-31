FROM node:22-alpine
WORKDIR /app
COPY contracts ./contracts
COPY config ./config
COPY gateway/package.json gateway/package-lock.json* ./gateway/
RUN cd /app/contracts && npm install --omit=dev \
 && cd /app/gateway && npm install --omit=dev
COPY gateway/src ./gateway/src
WORKDIR /app/gateway
EXPOSE 8080
CMD ["node", "src/server.js"]
