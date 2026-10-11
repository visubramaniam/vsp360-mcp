# syntax=docker/dockerfile:1

# ---- build: compile TypeScript ----
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- runtime: production dependencies only ----
FROM node:22-alpine
LABEL org.opencontainers.image.title="vsp360-mcp" \
      org.opencontainers.image.description="MCP server for the Hitachi VSP 360 1.4 REST API" \
      org.opencontainers.image.source="https://github.com/visubramaniam/vsp360-mcp" \
      org.opencontainers.image.licenses="MIT"
WORKDIR /app
ENV NODE_ENV=production \
    VSP360_DOWNLOAD_DIR=/downloads
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY spec ./spec
RUN mkdir -p /downloads && chown node:node /downloads
USER node
# MCP over stdio: run with `docker run -i`
ENTRYPOINT ["node", "/app/dist/index.js"]
