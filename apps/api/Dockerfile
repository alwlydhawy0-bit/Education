# syntax=docker/dockerfile:1

# ─── Deployment image for @edu/api ────────────────────────────────────────────
#
# There is NO BUILD STEP. Every workspace package exports `./src/index.ts`
# directly and Node runs the TypeScript with --experimental-strip-types, so the
# image ships source and a resolved node_modules — nothing is compiled.
#
# bookworm-slim, not alpine: @node-rs/argon2 is a native module and its
# prebuilt binaries are glibc. Alpine (musl) would fall back to a source build
# or fail, and password hashing is not a place to discover that in production.
#
# Build context is the REPOSITORY ROOT, not apps/api — apps/api depends on four
# workspace packages and the lockfile lives at the root:
#     docker build -f apps/api/Dockerfile -t edu-api .
FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH

WORKDIR /app

# corepack pins pnpm to the version in package.json#packageManager, so the
# image cannot drift from the lockfile's resolver.
RUN corepack enable

# Manifests first: this layer only invalidates when a dependency changes, not
# when source does.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/api/package.json      apps/api/
COPY apps/web/package.json      apps/web/
COPY packages/kernel/package.json        packages/kernel/
COPY packages/authz/package.json         packages/authz/
COPY packages/contracts/package.json     packages/contracts/
COPY packages/observability/package.json packages/observability/

# --frozen-lockfile: refuse to resolve anything the lockfile did not already
# pin. A deployment that silently upgrades a dependency is not reproducible.
RUN pnpm install --frozen-lockfile --filter @edu/api...

COPY packages/ packages/
COPY apps/api/ apps/api/
COPY db/ db/

# Drop privileges. The image's own `node` user owns nothing it needs to write.
USER node

# The provider supplies PORT. HOST must be 0.0.0.0: the application's default
# is 127.0.0.1, which is correct for a laptop and unreachable inside a
# container — the process would start, pass no health check, and look like a
# network fault.
ENV HOST=0.0.0.0
EXPOSE 3000

# Reports process health only. It deliberately says nothing about the database
# or configuration, so it is safe to expose unauthenticated.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# `node` directly, NOT `pnpm start`: the container's PID 1 receives SIGTERM, and
# main.ts installs the SIGTERM handler that closes the server before draining
# the pool. Behind a package-manager wrapper the signal may never arrive and
# shutdown stops being graceful.
CMD ["node", "--experimental-strip-types", "apps/api/src/main.ts"]
