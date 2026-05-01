# syntax=docker/dockerfile:1.7
# Multi-stage build for services/agent-service.
#
# AI Sprint 0/1: ships TypeScript source compiled with `tsc` (no bundler).
# When the runtime grows (Sprint 2+ will pull in LiteLLM SDK, Langfuse, ioredis,
# pgvector client, etc.), keeping unbundled output makes node_modules
# layer-cacheable per dependency.

ARG NODE_VERSION=24

# ---------- deps ----------
FROM node:${NODE_VERSION}-alpine AS deps
RUN apk add --no-cache libc6-compat python3 make g++
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=1
RUN corepack enable && corepack prepare pnpm@10 --activate

WORKDIR /repo

COPY pnpm-workspace.yaml pnpm-lock.yaml package.json .npmrc tsconfig.base.json tsconfig.json ./
COPY services/agent-service/package.json services/agent-service/

RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter "@workspace/agent-service..."

# ---------- build ----------
FROM deps AS build
COPY services/agent-service services/agent-service
WORKDIR /repo/services/agent-service
RUN pnpm exec tsc -p tsconfig.build.json
# Node refuses .ts extensions in import specifiers from .js output, so we
# also emit a tiny package.json marker for ESM resolution inside dist/.
RUN echo '{"type":"module"}' > dist/package.json

# ---------- runtime ----------
FROM node:${NODE_VERSION}-alpine AS runtime
RUN apk add --no-cache tini ca-certificates && \
    addgroup -S app && adduser -S -G app -u 10001 app

ENV NODE_ENV=production \
    PORT=3100 \
    NODE_OPTIONS="--enable-source-maps"

WORKDIR /app

# Production-only deps + compiled source.
COPY --from=build --chown=app:app /repo/services/agent-service/dist ./dist
COPY --from=build --chown=app:app /repo/services/agent-service/package.json ./package.json
COPY --from=build --chown=app:app /repo/node_modules ./node_modules

USER app
EXPOSE 3100

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://127.0.0.1:3100/healthz || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "--enable-source-maps", "dist/index.js"]
