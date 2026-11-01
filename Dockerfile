# LearnHarness server: one instance, every device connects to it.
# Build:  docker build -t learnharness .
# Run:    see docker-compose.yml and docs/self-hosting.md

FROM node:26-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY . .
# No electron payload in a server image; build-server.mjs curates the standalone output.
RUN npx next build && node scripts/build-server.mjs

FROM node:26-bookworm-slim AS run
# Chromium powers the demo/visual agents' headless rendering (CHROME_PATH below).
RUN apt-get update \
	&& apt-get install -y --no-install-recommends chromium fonts-dejavu-core ca-certificates tini \
	&& rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production \
	HOSTNAME=0.0.0.0 \
	PORT=3000 \
	LH_DATA_DIR=/data \
	LH_AUTH_FILE=/data/auth.json \
	CHROME_PATH=/usr/bin/chromium \
	NEXT_TELEMETRY_DISABLED=1
COPY --from=build --chown=node:node /app/.next/standalone ./
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 3000
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server.js"]
