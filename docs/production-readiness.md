# Production Readiness Checklist

**Task 016.** Every row below is either backed by a command anybody can re-run,
or marked as not done. A checklist whose green ticks cannot be reproduced is a
worse artifact than no checklist, because it converts uncertainty into
confidence without adding evidence.

Where a row says PASS, the command that produced it is named. Where a row says
NOT VERIFIED, the reason is stated and the risk is tracked.

---

## 1. The one-line summary

The backend is ready to be deployed **behind a proxy the operator configures
explicitly**, with **Postgres and Redis**, by **an orchestrator that supplies
secrets at run time**. It is not ready to be deployed by copying
`.env.production.example` and pressing go — and the validator refuses to let
that happen, which is the point.

Two things are deliberately out of scope and are NOT claimed: load testing under
concurrency, and a CI/CD pipeline. Both are named in §9.

---

## 2. Rate limiting and protection

| Check                                                 | Status | Evidence                                                                       |
| ----------------------------------------------------- | ------ | ------------------------------------------------------------------------------ |
| Global limit on every route                           | PASS   | `RATE_LIMIT_POLICIES.global` — 300/min, `tests/security/rate-limiting.test.ts` |
| Route-specific limits on the abusable endpoints       | PASS   | 13 named policies; the catalogue is one screen in `rate-limit.ts`              |
| Limits shared across replicas                         | PASS   | Redis store, `tests/unit/rate-limit-store.test.ts` — **closes RISK-RATE-01**   |
| Required in production, not merely available          | PASS   | `loadConfig` refuses production without `REDIS_URL`                            |
| Store outage does not disable rate limiting           | PASS   | degrades to per-process counting; never fail-open, never fail-closed           |
| Store outage is recorded                              | PASS   | `ratelimit.store_degraded`, emitted on the transition only                     |
| `request.ip` is meaningful behind a proxy             | PASS   | `TRUST_PROXY` address list; blanket `true` and hop counts refused              |
| CORS / origin allow-list, default deny                | PASS   | `registerOriginGuard`, `tests/security/session-hardening.test.ts`              |
| All origins https in production                       | PASS   | `loadConfig` refuses otherwise                                                 |
| Security headers (CSP, frameguard, nosniff, referrer) | PASS   | `tests/security/deployment-surface.test.ts` — asserted on a 404 too            |
| HSTS in hardened environments only                    | PASS   | same suite                                                                     |
| Request body bounded before parsing                   | PASS   | `bodyLimit: 256 KiB` in the Fastify options                                    |

**The rate-limit degradation decision, stated once.** Fail-open hands an
attacker a switch that turns rate limiting off by disturbing a cache.
Fail-closed takes the login page down whenever Redis restarts, including for the
operator trying to fix it. Neither is acceptable, so the store degrades to
per-process counting and records the window during which the numbers were
per-instance rather than fleet-wide.

---

## 3. Row-Level Security and multi-tenant isolation

`pnpm security:rls` — **PASS, 0 findings** across 51 tables, 48 reachable by the
application role, 195 policies, 110 SECURITY DEFINER functions.

| Rule | What it derives from the catalog                                                         |
| ---- | ---------------------------------------------------------------------------------------- |
| R1   | Every table the application role can reach has RLS **enabled and FORCED**                |
| R2   | Every granted command has a policy covering it (a grant with no policy is a silent deny) |
| R3   | No application policy is unconditionally true                                            |
| R4   | Every table carrying `organization_id` is narrowed by the actor or their organization    |
| R5   | Every SECURITY DEFINER function touching a FORCE-RLS table has a policy for the definer  |
| R6   | `edu_app` is NOSUPERUSER and NOBYPASSRLS                                                 |

**Two exemptions, both declared and both asserted to be the only ones.**
`audit_log.audit_log_insert` is unconditional because the audit trail must be
able to record an event about an actor the platform has just refused;
`email_verifications` and `password_reset_tokens` are unforced because the
application role is granted **nothing** on them — the audit checks that premise
rather than trusting it.

**The audit is proven able to fail.** `tests/integration/rls-audit.test.ts`
breaks the schema one rule at a time inside a rolled-back transaction and
asserts the audit notices — eight injections, eight caught. An audit that always
passes is indistinguishable from an audit that works.

**Role isolation across School / Teacher / Student / Parent** is covered
behaviourally by twenty `tests/integration/rls-*.test.ts` files and the
`tests/security/idor.test.ts` family, with `tests/security/layered-defense.test.ts`
proving each gate holds with the other removed.

---

## 4. Database and vector indexing

`pnpm db:audit-indexes` — **PASS, 0 findings** across 215 indexes and 103
foreign keys.

| Check                                           | Status           | Evidence                                       |
| ----------------------------------------------- | ---------------- | ---------------------------------------------- |
| Every cascading foreign key is indexed          | PASS             | migration 0034 added 34; rule I1 keeps it true |
| No redundant indexes                            | PASS             | rule I2, after the fix below; migration 0035   |
| Vector retrieval filters before it ranks        | PASS             | `tests/integration/query-plans.test.ts`        |
| Vector retrieval returns a full, exact top-K    | PASS             | `MATERIALIZED` CTE — **VULN-061**              |
| Statement timeout bounds a runaway query        | PASS             | `statement_timeout: 10s` in `platform/db.ts`   |
| Idle-in-transaction timeout                     | PASS             | 15s, same file                                 |
| Concurrent read/write plan behaviour under load | **NOT VERIFIED** | no load testing was performed — §9             |

**The finding worth reading.** The retrieval query's scope filter was correct in
the SQL text and not guaranteed in the plan. With the authorized course list
arriving as a parameterized array the planner cannot estimate its selectivity,
so at scale it chose the HNSW index for the ORDER BY and filtered afterwards —
and pgvector 0.6 has no iterative index scan, so post-filtering returns fewer
rows than the limit, silently. Measured: `LIMIT 8` returned **3**, ten times out
of ten. See VULN-061.

**The second finding, which is about this audit rather than the database.** Rule
I2 — "no redundant indexes" — had never once been capable of firing. It compared
a leading slice of one index's column list against another's:

```sql
(y.indkey::int2[])[0:array_length(x.indkey::int2[], 1) - 1] = x.indkey::int2[]
```

`indkey` is a `pg_catalog` vector with a ZERO-based lower bound, an array slice
in PostgreSQL is ONE-based, and array equality compares bounds as well as
elements. `'[0:0]={1}' = '{1}'` is therefore FALSE no matter what the columns
are. The predicate was structurally incapable of returning true, so "PASS, no
redundant indexes" had been asserting nothing at all since the audit was
written. Comparing the slices with `array_to_string` fixes it.

The fixed rule found a real redundancy on its first run, live since migration
0020: `assessment_attempts_assessment_idx (assessment_id)` is a leading prefix
of `assessment_attempts_released_idx (assessment_id, released_at)`, so the
narrower index cost write amplification on every attempt row and bought
nothing. Migration 0035 drops it, which is why the index count fell from 216 to 215.

It was found by writing falsification tests for the audit — injecting a
redundancy and expecting the audit to complain — as part of closing defect
injection round 15 (F18). The RLS audit shipped with eight such tests and the
index audit shipped with none, and that difference is exactly where the dead
rule hid. **An audit is not evidence until something has watched it fail.**
Both audits now have falsification tests in
`tests/integration/query-plans.test.ts` and `tests/integration/rls-audit.test.ts`.

---

## 5. Environment and configuration

| Check                                                  | Status | Evidence                                                           |
| ------------------------------------------------------ | ------ | ------------------------------------------------------------------ |
| One place reads the environment                        | PASS   | `platform/config.ts`; fitness test forbids `process.env` elsewhere |
| Unknown variables are ignored, not silently adopted    | PASS   | `CONFIG_KEYS` allow-list                                           |
| Hardened refusals (cookie, origins, log level, limits) | PASS   | `tests/security/deployment-surface.test.ts`                        |
| A production env can be validated **before** deploying | PASS   | `pnpm deploy:check-env .env.production`                            |
| The validator uses the server's own schema, not a copy | PASS   | it imports `loadConfig`                                            |
| The validator never prints a value                     | PASS   | `tests/unit/check-env.test.ts`                                     |
| Template placeholders are refused                      | PASS   | the template fails its own check until filled                      |
| Variables the app ignores are reported                 | PASS   | catches `REDIS_HOST` where the code reads `REDIS_URL`              |
| No secret reaches the browser bundle                   | PASS   | `tests/architecture/deployment-config.test.ts`                     |
| No secret is committed                                 | PASS   | `pnpm security:secrets` — 442 files, 0 findings                    |
| No known-vulnerable dependency                         | PASS   | `pnpm security:audit` — 0 high, 0 critical                         |

---

## 6. Health checks and logging

| Check                                                | Status | Evidence                                               |
| ---------------------------------------------------- | ------ | ------------------------------------------------------ |
| Liveness endpoint depends on nothing but the process | PASS   | `tests/unit/health.test.ts`                            |
| Readiness endpoint reports dependency state          | PASS   | 503 when the database is unreachable                   |
| Neither leaks version, host or dependency detail     | PASS   | `tests/security/deployment-surface.test.ts`            |
| Readiness cannot be used to exhaust the pool         | PASS   | memoised 1s; 50 probes → 1 database check              |
| Structured JSON logs, one object per line            | PASS   | `@edu/observability`, `stdoutJsonSink`                 |
| Redaction cannot be bypassed                         | PASS   | no raw sink is exported; every context passes `redact` |
| Boot, shutdown and fatal go through the logger       | PASS   | `tests/architecture/production-readiness.test.ts`      |
| A startup failure never logs the error object        | PASS   | same suite — a pg error carries the password           |
| Graceful shutdown drains the server before the pool  | PASS   | verified live: SIGTERM → drain → exit 0                |
| A second SIGTERM does not start a second drain       | PASS   | `main.ts`                                              |

**On Pino/Winston.** The brief names them; this platform has its own structured
logger with **mandatory** redaction and no raw escape hatch. Swapping it for a
library whose redaction is opt-in would be a downgrade dressed as convention, so
it was not done. What was fixed is the one file that went around it.

---

## 7. Container and deployment

| Check                                         | Status        | Evidence                                           |
| --------------------------------------------- | ------------- | -------------------------------------------------- |
| Multi-stage image, no dev dependencies        | PASS          | `--prod --filter @edu/api...` — 88 packages        |
| Runs as an unprivileged user                  | PASS (static) | `USER node` before `CMD`                           |
| Base image and package manager pinned         | PASS (static) | fitness test                                       |
| No credential baked into a layer              | PASS (static) | fitness test over every `ENV`                      |
| HEALTHCHECK probes readiness, not liveness    | PASS (static) | fitness test                                       |
| The dependency tree copy is complete          | PASS          | reproduced natively; **a real bug was found here** |
| The install command works                     | PASS          | run for real: 88 packages, 5 of 7 projects         |
| The image's file set boots the API            | PASS          | booted from the staged tree, production posture    |
| The HEALTHCHECK command works                 | PASS          | exit 0 ready, exit 1 with nothing listening        |
| Compose file is valid                         | PASS          | `docker compose config`                            |
| Compose never gives the API the migrator role | PASS          | fitness test                                       |
| Migrations run from the same image as the API | PASS          | fitness test                                       |
| **The image was built and run**               | **NOT DONE**  | see below                                          |

**Why the image was not built.** This environment's egress policy denies CONNECT
to every container registry — `docker.io`, `ghcr.io`, `mcr.microsoft.com`,
`quay.io` and `public.ecr.aws` all return 403 — so no base image can be pulled
and no image can be built. Rather than claim a verification that did not happen,
everything the Dockerfile _does_ was reproduced natively: the exact install into
a clean tree, the exact copied file set, a boot from that tree under the full
production posture, the exact HEALTHCHECK one-liner, and a SIGTERM drain.

That simulation earned its keep immediately. The runtime stage originally copied
only `/app/node_modules` and `/app/apps/api/node_modules`; a pnpm workspace
install also writes `node_modules` into every package with a dependency, and
those symlinks are what the resolver follows. The image would have built cleanly
and failed to resolve `@edu/kernel` from inside `@edu/authz`. Reading the
Dockerfile would not have caught it.

**What remains unverified is the base image and Docker's own mechanics.** The
first CI run that builds this image is the real test, and it should be treated
as one.

---

## 8. The commands, in the order an operator would run them

```bash
pnpm run format                           # prettier --check, CI's first step
pnpm deploy:check-env .env.production     # before anything is built
pnpm security:secrets                     # nothing committed
pnpm security:audit                       # no high/critical advisories
pnpm typecheck && pnpm lint && pnpm test  # the full gate

DATABASE_URL="$MIGRATOR_URL" pnpm db:migrate
DATABASE_URL="$CATALOG_READER_URL" pnpm security:rls
DATABASE_URL="$CATALOG_READER_URL" pnpm db:audit-indexes
```

The URLs above are read from the shell, never written down. A connection string
carries a password, and a documented example with the password position filled
in — even elided to `...` — is a pattern that gets copied with a real value in
it. `pnpm security:secrets` refuses that shape anywhere in the repository, and
it refused these three lines when they were written the other way.

`$MIGRATOR_URL` is the schema owner, used for migrations and nothing else.
`$CATALOG_READER_URL` needs only to read `pg_policy` and `pg_proc`; both audits
read the catalog and write nothing.

**`pnpm run format` is first on that list for a reason.** It is the first step
of CI's `static` job, and it had been failing across 76 files since at least
forty commits back. A failing step ends a GitHub Actions job, so everything
behind it — lint, typecheck, the unit project, the architecture project, the web
client build, and the assertion that no server-only value reached the client
bundle — had not been running in CI at all. The failures were pure line
wrapping, which is exactly why nobody looked: a red check that fails for a
harmless reason gets read as noise, and then it stops being a check and starts
being a lid on the checks behind it. The repository is now formatted and the
step passes.

---

## 9. What is NOT ready, stated plainly

- **No load testing.** Nothing here says how the platform behaves at
  concurrency. §4's plan assertions are about plan SHAPE, not throughput. The
  vector retrieval's cost curve was measured on synthetic data (20ms for 4
  authorized courses, 183ms for 40, 959ms for 200 — RISK-VEC-01) and that is a
  measurement, not a load test.
- **No CI/CD pipeline.** `.github/workflows/ci.yml` runs the gate; there is no
  deployment pipeline, no image publishing, no promotion, no rollback.
- **No secret manager.** Secrets arrive as environment variables. There is no
  rotation, no sealed-secret integration, no audit of who read what.
- **No TLS termination in this repository.** The server refuses plaintext
  origins in production and expects something in front of it to terminate TLS.
- **No backup or restore procedure.** The erasure path now deletes efficiently
  (§4); nothing here says how to get data back.
- **Mail delivery is still a logging stub**, so
  `REQUIRE_VERIFIED_EMAIL_FOR_LOGIN` must stay false.
- **The image has never been built** (§7).

---

## 10. Risks opened or changed by this task

| ID             | Risk                                                                                                                             |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| RISK-RATE-01   | **CLOSED** — limits are now shared across replicas when `REDIS_URL` is set, and it is required in production                     |
| RISK-RATE-02   | While the shared store is unreachable, limits are per-instance. Bounded and recorded, not silent                                 |
| RISK-PROXY-01  | `TRUST_PROXY` is the operator's to get right. The parser refuses the two forms that fail silently; it cannot verify the topology |
| RISK-VEC-01    | Exact vector retrieval costs O(authorized set). Fine at enrolment scale; pgvector ≥ 0.8's iterative scans are the upgrade path   |
| RISK-DEPLOY-01 | The container image has never been built or run                                                                                  |
| RISK-LOAD-01   | No load testing has been performed                                                                                               |
