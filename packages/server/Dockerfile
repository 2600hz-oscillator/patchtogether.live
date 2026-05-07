# packages/server/Dockerfile
#
# Multi-stage build for the Hocuspocus server. Builder stage compiles
# TypeScript with full deps; runtime stage strips devDeps for a smaller
# image.
#
# Build context is the workspace root (see fly.toml's `dockerfile` path).
# We need the workspace skeleton (root package.json + every workspace's
# package.json) so `npm ci` can resolve the dependency graph correctly,
# but only the server's source gets copied for the actual build.

# syntax=docker/dockerfile:1.7

FROM node:22-slim AS builder
WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
COPY packages/dsp/package.json packages/dsp/
COPY e2e/package.json e2e/
COPY art/package.json art/

# Workspace-aware install: only the server's deps + its workspace root
# context, no need to pull web/dsp/art/e2e deps.
RUN npm ci --workspace=@patchtogether.live/server --include-workspace-root

COPY packages/server/tsconfig.json packages/server/
COPY packages/server/src packages/server/src
RUN cd packages/server && npm run build


FROM node:22-slim AS runtime
WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
COPY packages/dsp/package.json packages/dsp/
COPY e2e/package.json e2e/
COPY art/package.json art/

# Production deps only — drops typescript, vitest, tsx, etc.
RUN npm ci --workspace=@patchtogether.live/server --include-workspace-root --omit=dev

COPY --from=builder /app/packages/server/dist packages/server/dist

WORKDIR /app/packages/server
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=8080
EXPOSE 8080
CMD ["node", "dist/index.js"]
