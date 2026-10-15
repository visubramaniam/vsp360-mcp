# syntax=docker/dockerfile:1

# The build and dependency stages run on the build machine's own platform (--platform=$BUILDPLATFORM): their
# output is plain JavaScript (no native modules), the same for every target. Only the final stage is per
# platform, so multi-arch builds don't run npm under QEMU emulation, where it can crash (SIGILL) and hang.

# ---- build: compile TypeScript and pre-parse the spec ----
FROM --platform=$BUILDPLATFORM node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
COPY spec ./spec
COPY scripts/cache-spec.mjs ./scripts/
RUN npm run build

# ---- production dependencies ----
FROM --platform=$BUILDPLATFORM node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402 AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund

# ---- runtime ----
FROM node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402
LABEL org.opencontainers.image.title="vsp360-mcp" \
      org.opencontainers.image.description="Community MCP server for Hitachi VSP 360 (not an official Hitachi Vantara product)" \
      org.opencontainers.image.source="https://github.com/visubramaniam/vsp360-mcp" \
      org.opencontainers.image.licenses="MIT"
WORKDIR /app
ENV NODE_ENV=production \
    VSP360_DOWNLOAD_DIR=/downloads
COPY package.json package-lock.json ./
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY spec ./spec
RUN mkdir -p /downloads && chown node:node /downloads
USER node
# MCP over stdio: run with `docker run -i`
ENTRYPOINT ["node", "/app/dist/index.js"]
