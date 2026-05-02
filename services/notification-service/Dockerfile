# syntax=docker/dockerfile:1.7
# Multi-stage build for services/notification-service.

ARG NODE_VERSION=24

FROM node:${NODE_VERSION}-alpine AS deps
RUN apk add --no-cache libc6-compat python3 make g++
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=1
RUN corepack enable && corepack prepare pnpm@10 --activate

WORKDIR /repo

COPY pnpm-workspace.yaml pnpm-lock.yaml package.json .npmrc tsconfig.base.json tsconfig.json ./
COPY services/notification-service/package.json services/notification-service/
COPY packages/db/package.json packages/db/

RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter "@workspace/notification-service..."

FROM deps AS build
COPY services/notification-service services/notification-service
COPY packages/db packages/db
WORKDIR /repo/services/notification-service
RUN pnpm exec tsc -p tsconfig.build.json
RUN echo '{"type":"module"}' > dist/package.json

FROM node:${NODE_VERSION}-alpine AS runtime
RUN apk add --no-cache tini ca-certificates && \
    addgroup -S app && adduser -S -G app -u 10001 app

ENV NODE_ENV=production \
    PORT=3200 \
    NODE_OPTIONS="--enable-source-maps"

WORKDIR /app

COPY --from=build --chown=app:app /repo/services/notification-service/dist ./dist
COPY --from=build --chown=app:app /repo/services/notification-service/package.json ./package.json
COPY --from=build --chown=app:app /repo/node_modules ./node_modules

USER app
EXPOSE 3200

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://127.0.0.1:3200/healthz || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "--enable-source-maps", "dist/index.js"]
