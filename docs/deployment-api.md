# Deploying `apps/api`

The API is implemented, boots, and serves. It is **not deployed anywhere**, and
this document is what a deployment needs to get right.

Everything in §1–§4 was measured against commit `21f1034`, not inferred.

---

## 1. The deployment contract

| Property        | Value                                                  | How it was established                                                                                                                          |
| --------------- | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Build step      | **none**                                               | Every workspace package exports `./src/index.ts`; Node runs the TypeScript under `--experimental-strip-types`. No package has a `build` script. |
| Start command   | `node --experimental-strip-types apps/api/src/main.ts` | `apps/api/package.json#scripts.start`                                                                                                           |
| Node            | `>=22.12.0`                                            | root `package.json#engines`                                                                                                                     |
| Package manager | pnpm 10.33.0                                           | `package.json#packageManager`                                                                                                                   |
| Install scope   | **repository root**                                    | `apps/api` depends on four `workspace:*` packages; the lockfile is at the root                                                                  |
| Process model   | **long-lived, stateful**                               | holds a `pg.Pool`. Not serverless, not edge.                                                                                                    |
| `HOST`          | **must be `0.0.0.0`**                                  | the application default is `127.0.0.1` — correct on a laptop, unreachable inside a container                                                    |
| `PORT`          | from the provider                                      | `config.PORT`, default 3000                                                                                                                     |
| Shutdown        | SIGTERM/SIGINT → `app.close()` then `db.close()`       | `main.ts`; verified by sending SIGTERM to a running process — port released, exit 0                                                             |
| Health check    | `GET /api/v1/health` → `200 {"status":"ok"}`           | Touches no database and discloses no configuration, so it is safe unauthenticated                                                               |

**`HOST=0.0.0.0` is the one non-obvious requirement.** Miss it and the process
starts, logs "API listening on 127.0.0.1", fails every health check, and looks
like a networking fault rather than a configuration one.

## 2. Provider

**Recommended: Railway, running the Dockerfile.**

The decisive requirements, in order:

1. **A long-lived process with a connection pool.** This eliminates every
   serverless and edge runtime, including Vercel Functions. It is not a
   preference — a per-request runtime would open and discard Postgres
   connections on every call.
2. **Postgres must not have a public port** (§14 of the security review).
   Railway's private networking keeps the database off the internet.
3. **Explicit replica count.** The boot log warns:
   `rate limiting uses an in-process store; limits are per-instance and are NOT
shared across replicas` (RISK-RATE-01). Until a shared store exists, running
   more than one replica silently multiplies every rate limit. Railway defaults
   to one instance and makes the count explicit.
4. **A one-off command runner**, so migrations are a gated step and never part
   of application start (§3).

**Rejected, with reasons:**

- **Render** — genuinely close, and would work. Private networking, health
  checks and one-off jobs are all there. The discriminator is marginal, so this
  is a preference rather than a finding; its free tier spins down, which is
  disqualifying for production but irrelevant on a paid plan.
- **Fly.io** — the strongest primitives (6PN private networking, regional
  placement) but the largest operational surface: machines, volumes and regions
  to reason about, and its Postgres is an app you run rather than a managed
  service. More responsibility than this platform currently needs.
- **Vercel Functions** — eliminated by requirement 1.

**The choice is deliberately reversible.** `apps/api/Dockerfile` is a plain
OCI build with no provider-specific instructions, so the same image runs on
Railway, Render or Fly. If Railway proves wrong, the artifact moves unchanged.

## 3. Database and migrations

**Migrations are a separate, gated step. Never run them from application
start** — under a rolling deploy, N replicas would race the same DDL.

```
DATABASE_URL=<migrator role> node --experimental-strip-types db/migrate.ts
```

Verified on a throwaway database at `21f1034`:

| Property                                               | Result                                                       |
| ------------------------------------------------------ | ------------------------------------------------------------ |
| Applies in filename order, each in its own transaction | 23 migrations applied                                        |
| **Idempotent**                                         | second run: `Schema is up to date; nothing to apply.`        |
| Checksum-guarded                                       | editing an applied migration aborts with a checksum mismatch |
| `--reset` under `NODE_ENV=production`                  | **refused**: `Refusing to --reset with NODE_ENV=production.` |

`--reset` is the only destructive path and it is already blocked in production.
Nothing else in the runner drops or truncates.

**Roles.** Migrate as `edu_migrator`; run the application as `edu_app`
(NOBYPASSRLS). Running the server as the migrator would silently disable Row
Level Security, which is far worse than a failed deploy.

**SSL.** `db.ts` passes only `connectionString` and `max` to `pg.Pool`, so TLS
comes from the URL's `sslmode`. Measured against the installed
`pg-connection-string@2.14.0`:

```
sslmode=disable      -> ssl false
sslmode=require      -> ssl {}    (currently full verification)
sslmode=verify-full  -> ssl {}
```

The library warns that `require` will adopt weaker libpq semantics in pg 9.
**Use `sslmode=verify-full` explicitly** so the meaning does not change under a
dependency upgrade. If the provider's certificate does not chain to a public
root, supply its CA rather than dropping to `require`.

## 4. Environment matrix

Names and classifications only — no values.

| Variable                                                                                                                                                                                                                                             | Classification      | Note                                                     |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- | -------------------------------------------------------- |
| `DATABASE_URL`                                                                                                                                                                                                                                       | **REQUIRED SECRET** | application role, NOBYPASSRLS, `sslmode=verify-full`     |
| `NODE_ENV`                                                                                                                                                                                                                                           | REQUIRED NON-SECRET | `production` — activates every fail-closed rule below    |
| `HOST`                                                                                                                                                                                                                                               | REQUIRED NON-SECRET | `0.0.0.0`                                                |
| `PORT`                                                                                                                                                                                                                                               | REQUIRED NON-SECRET | provider-supplied                                        |
| `ALLOWED_ORIGINS`                                                                                                                                                                                                                                    | REQUIRED NON-SECRET | the Vercel origin. Must be `https://`, must be non-empty |
| `SESSION_COOKIE_SECURE`                                                                                                                                                                                                                              | REQUIRED NON-SECRET | must be `true`                                           |
| `RATE_LIMIT_ENABLED`                                                                                                                                                                                                                                 | REQUIRED NON-SECRET | must not be `false`                                      |
| `LOG_LEVEL`                                                                                                                                                                                                                                          | REQUIRED NON-SECRET | must not be `debug`                                      |
| `AI_PROVIDER`                                                                                                                                                                                                                                        | REQUIRED NON-SECRET | `none` is a real mode, not a disabled one                |
| `AI_API_KEY`                                                                                                                                                                                                                                         | OPTIONAL SECRET     | required the moment `AI_PROVIDER` is not `none`          |
| `AI_BASE_URL`, `AI_MODEL`, `AI_MAX_OUTPUT_TOKENS`, `AI_TIMEOUT_MS`                                                                                                                                                                                   | OPTIONAL NON-SECRET | pinned defaults; `AI_BASE_URL` must be `https://`        |
| `SESSION_COOKIE_NAME`, `REFRESH_COOKIE_NAME`, `SESSION_TTL_HOURS`, `REFRESH_TTL_DAYS`, `DATABASE_POOL_MAX`, `MAX_FAILED_LOGINS`, `LOCKOUT_MINUTES`, `EMAIL_VERIFICATION_TTL_HOURS`, `PASSWORD_RESET_TTL_MINUTES`, `REQUIRE_VERIFIED_EMAIL_FOR_LOGIN` | OPTIONAL NON-SECRET | sane defaults                                            |

**No `VITE_*` variable exists or may be created for any of these.** `VITE_` is
the only prefix Vite inlines into the browser bundle.

### Fail-closed, verified

Each of these was tested by booting with the violation and observing refusal:

| Violation under `NODE_ENV=production`  | Result     |
| -------------------------------------- | ---------- |
| correct configuration                  | **BOOTED** |
| `SESSION_COOKIE_SECURE=false`          | refused    |
| `RATE_LIMIT_ENABLED=false`             | refused    |
| `ALLOWED_ORIGINS` containing `http://` | refused    |
| `LOG_LEVEL=debug`                      | refused    |
| `AI_PROVIDER=anthropic` without a key  | refused    |
| `DATABASE_URL` absent                  | refused    |

## 5. CORS, cookies, and how the frontend connects

**There is no CORS. That is deliberate, and it decides the frontend wiring.**

- `@fastify/cors` is not a dependency and is not registered. A production
  response carries **no `Access-Control-Allow-Origin` header** (verified).
- `ALLOWED_ORIGINS` drives an **origin guard** — a CSRF control that _rejects_
  state-changing requests whose `Origin` is absent or not allow-listed. It is
  not CORS and emits no CORS headers.
- Session cookies are `HttpOnly`, `SameSite=Strict`, `Secure` in production.
- Responses carry `Cross-Origin-Resource-Policy: same-origin`.

Verified against a production-mode server:

| Request                                            | Result                                                       |
| -------------------------------------------------- | ------------------------------------------------------------ |
| `POST /auth/login`, no `Origin`                    | `403 FORBIDDEN` — cross-origin request rejected              |
| `POST /auth/login`, `Origin: https://evil.example` | `403 FORBIDDEN`                                              |
| `POST /auth/login`, allow-listed origin            | passes the guard (`400 VALIDATION_FAILED` on the empty body) |

### Option A — Vercel rewrite. **Chosen.**

```
browser ──► https://<vercel-app>/api/v1/*  ──rewrite──►  https://<api-host>/api/v1/*
```

The browser only ever talks to the Vercel origin. Cookies stay same-origin and
`SameSite=Strict`; no CORS is needed; **no frontend code changes at all**,
because `client.ts` already calls the relative path `/api/v1/...`.

### Option B — `VITE_API_BASE_URL`. **Rejected.**

It would require, all at once: adding `@fastify/cors`; relaxing
`SameSite=Strict` to `SameSite=None` so the cookie survives a cross-site
request; relaxing `Cross-Origin-Resource-Policy`; and changing the frontend
client. That is three security relaxations to avoid one rewrite rule, against
an explicit instruction not to weaken cookie or session security to solve CORS.

### The rewrite, once the API has a hostname

Add to the `vercel.json` that the project's Root Directory actually reads
(see `docs/deployment.md` §2 — currently `apps/api/vercel.json`):

```json
"rewrites": [
  { "source": "/api/:path*", "destination": "https://<api-host>/api/:path*" }
]
```

**Not added yet, on purpose:** the destination hostname does not exist until
the API is deployed, and inventing one would be worse than leaving the rule
out. Set `ALLOWED_ORIGINS` to the Vercel origin — with a rewrite the browser's
`Origin` header is the Vercel origin, not the API's.

## 6. What is not yet done

| Item                                | Blocked on                                                      |
| ----------------------------------- | --------------------------------------------------------------- |
| The API is not deployed             | no provider account, credentials, or CLI in this environment    |
| No production `DATABASE_URL` exists | must be created with the provider's Postgres                    |
| The Dockerfile has never been built | no Docker daemon available here (`/var/run/docker.sock` absent) |
| The Vercel rewrite is not added     | needs the API hostname from a real deployment                   |
| HTTPS verification                  | needs a deployed endpoint                                       |

## 7. Known risks that a deployment must respect

- **RISK-RATE-01** — the rate limiter is in-process. **Run one replica** until a
  shared store exists, or every limit multiplies by the replica count.
- **The frontend collapses failure kinds.** `HealthIndicator` catches every
  error and shows "Service is unreachable", so a 500, a CORS failure and an
  outage are indistinguishable in the UI. Recorded as a follow-up defect; not
  changed here.
- **There is no authentication UI.** Even with the API reachable, no session can
  be obtained through the browser.
