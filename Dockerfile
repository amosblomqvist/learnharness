# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci

FROM node:22-bookworm-slim AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=dependencies /app/node_modules ./node_modules
COPY . .
RUN npm run plugins:setup
RUN npm run build && node scripts/build-server.mjs

FROM node:22-bookworm-slim AS runner
WORKDIR /app

RUN apt-get update \
	&& apt-get install -y --no-install-recommends chromium fonts-liberation \
	&& rm -rf /var/lib/apt/lists/* \
	&& mkdir -p /data /config \
	&& chown node:node /data /config

ARG SOURCE_REVISION
LABEL org.opencontainers.image.source="https://github.com/michal-pielka/learnharness" \
	org.opencontainers.image.revision="${SOURCE_REVISION}" \
	org.opencontainers.image.licenses="AGPL-3.0-only"

ENV NODE_ENV=production \
	NEXT_TELEMETRY_DISABLED=1 \
	HOSTNAME=0.0.0.0 \
	PORT=3000 \
	LH_DATA_DIR=/data \
	LH_AUTH_FILE=/config/auth.json \
	CHROME_PATH=/usr/bin/chromium

COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/LICENSE ./LICENSE

# The slim image has no curl; node itself probes the server port.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
	CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || '3000') + '/').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]

USER node
EXPOSE 3000
CMD ["node", "server.js"]
