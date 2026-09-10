# =============================================================================
# API image
# =============================================================================
#
# THERE IS NO BUILD STAGE, AND THAT IS DELIBERATE.
#
# This platform runs TypeScript directly under `node --experimental-strip-types`
# (see docs/architecture/adr). Types are erased at load; nothing is transpiled,
# bundled or emitted. So the image ships SOURCE, and the "build" is an install.
#
# The consequence worth stating: the thing that runs in production is the thing
# in the repository, byte for byte. There is no artifact in between that could
# have been produced from a different commit, and no sourcemap indirection when
# reading a stack trace.
#
# The cost is equally real: syntax that needs a TRANSFORM rather than an erasure
# — parameter properties, enums, namespaces — typechecks and then fails to
# start. That is caught by the architecture fitness tests, not by this file.
#
# -----------------------------------------------------------------------------
# Layer order is chosen so that a code change does not reinstall dependencies.
# Manifests and the lockfile are copied first; source arrives after the install.
# -----------------------------------------------------------------------------

# ---- dependencies -----------------------------------------------------------
# bookworm-slim rather than alpine: @node-rs/argon2 is a native module, and glibc
# prebuilds are the well-trodden path. Password hashing is not where to
# discover a musl packaging problem.
FROM node:22.22-bookworm-slim AS deps

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
# The version is pinned to the one in package.json's packageManager field. A
# floating pnpm would resolve a different dependency tree from the lockfile that
# CI verified.
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate

WORKDIR /app

# Manifests only. Everything below this line is cached until a dependency
# changes, which is the difference between a ten-second and a two-minute deploy.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json .npmrc* ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/authz/package.json packages/authz/
COPY packages/contracts/package.json packages/contracts/
COPY packages/kernel/package.json packages/kernel/
COPY packages/observability/package.json packages/observability/

# --filter @edu/api... selects the API and the workspace packages it depends on,
# and nothing else: no vitest, no react, no eslint. --prod drops devDependencies
# on top of that. The two together are what keeps a test harness out of a
# production image.
RUN pnpm install --frozen-lockfile --prod --filter @edu/api...

# ---- runtime ----------------------------------------------------------------
FROM node:22.22-bookworm-slim AS runtime

# Production posture is set in the image, not left to the deployment. A
# NODE_ENV that arrives only from the orchestrator is a NODE_ENV that can be
# forgotten, and this one gates every hardened-environment refusal in
# platform/config.ts.
ENV NODE_ENV=production
# 0.0.0.0 because the port is published by the orchestrator. Binding to loopback
# inside a container produces a service that is unreachable from outside and
# perfectly healthy inside — the worst kind of failure to diagnose.
ENV HOST=0.0.0.0
ENV PORT=3000

WORKDIR /app

# node:* images ship an unprivileged `node` user (uid 1000). Root inside a
# container is not a sandbox; a container escape starts from whatever the
# process already had.
#
# THE WHOLE /app TREE COMES ACROSS, NOT JUST THE ROOT node_modules, AND THAT IS
# THE PART THAT IS EASY TO GET WRONG. A pnpm workspace install writes a
# node_modules directory into EVERY workspace package that has a dependency —
# packages/authz/node_modules/@edu/kernel, packages/contracts/node_modules/zod —
# and those are symlinks the resolver needs. Copying only /app/node_modules and
# /app/apps/api/node_modules produces an image that builds cleanly and then
# cannot resolve @edu/kernel from inside @edu/authz. This was caught by
# reproducing the install and booting from the result, not by reading.
#
# The deps stage holds manifests and node_modules and nothing else, so this
# brings the dependency tree and its per-package symlinks and no source.
COPY --chown=node:node --from=deps /app ./

# Source goes on top. Docker COPY MERGES into an existing directory rather than
# replacing it, so the node_modules already inside apps/api and packages/*
# survive this.
COPY --chown=node:node package.json pnpm-workspace.yaml ./
COPY --chown=node:node apps/api ./apps/api
COPY --chown=node:node packages ./packages
# Migrations travel with the image so a pre-deploy job can run
# `node --experimental-strip-types db/migrate.ts` from the exact revision that
# is about to serve traffic, rather than from whatever a runner checked out.
COPY --chown=node:node db ./db

USER node

EXPOSE 3000

# READINESS, not liveness — see apps/api/src/platform/http/health.ts. Docker's
# HEALTHCHECK decides whether a container receives traffic from a load balancer,
# which is the readiness question; the liveness endpoint would report healthy
# while the database was unreachable.
#
# start-period covers the connection to Postgres and Redis at boot; without it
# a container is marked unhealthy for a startup that is proceeding normally.
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/v1/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# `--init` (or compose's `init: true`) is recommended alongside this so PID 1
# reaps zombies; the SIGTERM handling itself is in main.ts, which drains the
# server before the pool so in-flight requests are not cut off mid-response.
CMD ["node", "--experimental-strip-types", "apps/api/src/main.ts"]
