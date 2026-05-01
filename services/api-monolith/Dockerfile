# syntax=docker/dockerfile:1.7
# Multi-stage build for services/api-monolith.
#
# Stage 1 (deps):    install workspace deps with pnpm.
# Stage 2 (build):   run esbuild bundle (build.mjs) → dist/index.mjs.
# Stage 3 (runtime): node:24-alpine, non-root, only the bundle + node_modules
#                    that the bundle externalises (none today, but kept
#                    minimal so adding native deps Just Works).
#
# Build context expected: repo root (the workspace), not the service dir.
# Example:
#   docker build -f services/api-monolith/Dockerfile -t api-monolith:dev .

ARG NODE_VERSION=24

# ---------- deps ----------
FROM node:${NODE_VERSION}-alpine AS deps
RUN apk add --no-cache libc6-compat python3 make g++
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=1
RUN corepack enable && corepack prepare pnpm@10 --activate

WORKDIR /repo

# Copy only the files needed to resolve the workspace graph first so the
# layer cache survives source edits.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json .npmrc tsconfig.base.json tsconfig.json ./
COPY services/api-monolith/package.json services/api-monolith/
COPY packages/db/package.json packages/db/
COPY packages/api-zod/package.json packages/api-zod/
COPY packages/api-spec/package.json packages/api-spec/
COPY packages/payments/package.json packages/payments/
COPY packages/api-client-react/package.json packages/api-client-react/

RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter "@workspace/api-server..."

# ---------- build ----------
FROM deps AS build
COPY packages packages
COPY services/api-monolith services/api-monolith
WORKDIR /repo/services/api-monolith
RUN pnpm run build

# ---------- runtime ----------
FROM node:${NODE_VERSION}-alpine AS runtime
RUN apk add --no-cache tini ca-certificates && \
    addgroup -S app && adduser -S -G app -u 10001 app

ENV NODE_ENV=production \
    PORT=8080 \
    NODE_OPTIONS="--enable-source-maps"

WORKDIR /app

# The esbuild bundle is self-contained; we only need the dist directory.
COPY --from=build --chown=app:app /repo/services/api-monolith/dist ./dist

USER app
EXPOSE 8080

# Health probe — `/healthz` returns 200 when boot is complete.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://127.0.0.1:8080/healthz || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "--enable-source-maps", "dist/index.mjs"]
