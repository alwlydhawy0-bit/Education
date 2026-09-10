# Task 016 — Final Backend Hardening & Deployment Prep

---

## 1. WHAT WAS ASKED FOR, AND WHAT THIS PLATFORM ACTUALLY IS

The brief names Supabase RLS, Upstash, and Pino/Winston. This platform uses
plain PostgreSQL 16 with hand-written policies, its own rate-limit policy
catalogue, and a structured logger with **mandatory** redaction. Those are not
gaps to be filled by swapping in the named products; they are the same
capabilities, already built and already tested, and replacing working
infrastructure to match a vocabulary would be the opposite of hardening.

So the brief was read as its four requirements rather than its four product
names, and each was mapped onto what exists:

| Asked for                        | What it means here                                                         |
| -------------------------------- | -------------------------------------------------------------------------- |
| Upstash / Redis rate limiting    | A **shared store** behind the existing policy catalogue. Redis, required in production. |
| Helmet / CSP / CORS              | Already present. Verified end to end, including on a 404, and extended with the proxy setting that decides what an IP *is*. |
| Supabase RLS audit               | A **catalog-derived** audit of the platform's own RLS: six rules, every table, proven able to fail. |
| pgvector optimisation            | A query-plan investigation that found a correctness bug, not a slow query.  |
| Pino / Winston structured logging | Already structured, already redacting. Fixed the one file that went around it. |
| `.env.production` validation      | A validator that runs the **server's own schema** before an image is built.  |
| Dockerfile / Compose             | Written, reviewed, and verified as far as an environment with no container registry allows. |
| `/health`                        | Split into liveness and readiness, because conflating them causes outages.   |

**Nothing established was redesigned.** The policy catalogue, the origin guard,
the helmet configuration, the authorization engine and the RLS policies are
untouched except where a defect was demonstrated.

---

## 2. THE THREE DEFECTS

Each was found by running or measuring something, not by reading it.

### VULN-061 — the tutor's retrieval silently returned three rows when asked for eight

`knowledge.repository.ts` has said since Task 011 that the authorization filter
runs before the vector scan. That was true of the SQL **text** and not of the
**plan**: the authorized course list arrives as a parameterized array, the
planner cannot estimate `= ANY($1::uuid[])`, and at scale it chose the HNSW
index for the `ORDER BY` and filtered afterwards.

pgvector 0.6 has no iterative index scan. Post-filtering an approximate index
exhausts a fixed candidate list and returns **fewer rows than the limit**, with
no error:

```
Limit (actual rows=3)                       <- asked for 8
  ->  Index Scan using emb_vec_ix on emb
        Filter: (course_id = ANY ($1))
        Rows Removed by Filter: 362
```

Three rows, ten trials out of ten, on a 20,000-vector table with one authorized
course in two hundred.

**This is a correctness failure wearing a performance failure's clothes.** The
tutor cites what it quotes, so every citation stays valid while the SET becomes
an arbitrary subset of what the learner was entitled to — and a learner asking
about a topic in the lesson the scan did not reach is told, in effect, that the
course does not cover it.

Fixed with a `MATERIALIZED` CTE, which makes the top-K exact and the plan
independent of the estimate. Cost measured and recorded (RISK-VEC-01): 20ms for
four authorized courses, 183ms for forty, 959ms for two hundred — bounded by
enrolment rather than corpus size, which is the right shape.

### VULN-062 — the first file to run was the one logging around the redactor

`@edu/observability` has no raw sink: every context passes through `redact`.
Every module respected that except `main.ts`, which used `console.error` — and
in the shutdown path printed a **raw error object**. The likeliest failure there
is the database refusing a connection, and a `pg` connection error carries the
connection string, which carries the password.

Low severity, honestly: it needs a database failure and writes to the process's
own stderr. Worth fixing anyway, because that stderr is shipped somewhere by
every real deployment.

### VULN-063 — a proxy setting that reports trust and enforces none

Caught before shipping, by reading Fastify rather than trusting its type.
`trustProxy` accepts a number, and `getTrustProxyFn` in Fastify 5 compiles a
number to `function () { return false }` — **trust nothing**. A deployment
setting `TRUST_PROXY=2` would boot cleanly, log its hop count, pass every check,
and key every request to the load balancer: per-IP rate limiting collapsed into
one global bucket, every security event naming the proxy.

The parser now accepts only an address or CIDR list and refuses both silent
forms — the hop count, and the blanket `true` that believes a client-supplied
header.

---

## 3. WHAT WAS BUILT

### The shared rate-limit store — RISK-RATE-01, closed after eight tasks

Limits had been counted in process memory since Task 008. With N replicas the
enforced ceiling was N times the number written down; every deploy refilled each
attacker's budget. Every header said so, and it stayed open.

`platform/security/rate-limit-store.ts` counts in Redis with a Lua script.
`INCR` then `PEXPIRE` is two round trips with a gap: a process dying in the gap
leaves a key with no expiry, and that bucket never refills — a permanent denial
of service against one user, caused by the control meant to protect them. One
atomic call, no gap.

**The decision that matters is what happens when Redis is gone.** Fail open is
the plugin's default and hands an attacker a switch. Fail closed takes the login
page down whenever a cache restarts, including for the operator fixing it. The
store **degrades** to per-process counting and records
`ratelimit.store_degraded` on the transition — a weaker limit, in the audit
trail rather than in nobody's memory.

`REDIS_URL` is required in production and staging. A limit that is merely
configured is not a limit.

### The RLS audit — six rules, derived from the catalog

Twenty behavioural RLS suites prove specific boundaries for specific rows. They
are enumerative, and the failure they cannot catch is the table nobody wrote a
scenario for: a migration grants four commands, forgets `ENABLE ROW LEVEL
SECURITY`, every existing test still passes, and one tenant reads another's data.

`pnpm security:rls` asks the catalog what exists and applies R1–R6 to all of it.
**PASS, 0 findings** across 51 tables, 195 policies, 110 definer functions. Two
exemptions, both declared, both asserted to be the only ones — and the
unforced-table exemption checks its own premise (that the application role is
granted nothing there) rather than trusting it.

**It is proven able to fail.** Eight injections inside rolled-back transactions,
eight caught. An audit that always passes is indistinguishable from one that
works.

### Thirty-four indexes the schema's own constraints required

PostgreSQL indexes the referenced side of a foreign key and never the
referencing side. Thirty-five cascading or nulling keys had no covering index,
so deleting one parent row would sequentially scan and lock each child table in
turn — and those deletes are the erasure path a school is legally obliged to
have. Migration 0034 adds thirty-four (the thirty-fifth was redundant with a
composite that already leads on the same column); `pnpm db:audit-indexes`
derives the rule, and also refuses redundant indexes so that a rule which only
ever says "add an index" cannot become a schema nobody can write to.

### Liveness and readiness, which are different questions

`/api/v1/health` answers from the process alone. A liveness probe that checked
the database would fail on every replica during a database blip, the
orchestrator would restart the fleet, and it would come back cold into a
database already struggling — a dependency outage turned into a total one by the
health check.

`/api/v1/health/ready` probes the database and returns 503 with a one-word body.
It is memoised for a second, because an unauthenticated endpoint that checks out
a pooled connection is an amplifier: one cheap request becoming one connection,
and a flood becoming the denial of service the probe exists to detect.

### The pre-deploy environment check

`platform/config.ts` already refuses a bad configuration — at the wrong moment,
after the image is built, pushed and scheduled, as a crash loop at 03:00.
`pnpm deploy:check-env` runs **the same schema** (it imports `loadConfig`; a
copy would drift and a green tick from a rulebook the server does not use is
worse than nothing) and reports everything at once.

It also catches the two classes a schema cannot: placeholders left in a copied
template (`CHANGE_ME` is a valid string), and variables the application will
silently ignore — `REDIS_HOST` where the code reads `REDIS_URL`, the mirror
image of VULN-037. No branch of it can print a value.

### The container

Multi-stage, non-root, production dependencies only (88 packages, 5 of 7
workspace projects), pinned base and package manager, HEALTHCHECK on
**readiness**. No build stage, because the platform runs TypeScript directly —
so what runs in production is what is in the repository, byte for byte.

The compose stack runs Postgres-with-pgvector, Redis, a migrate job that must
succeed first, and the API. The migrate job runs from the **same image** and is
the only service holding the migrator credential; the API never gets it, because
a server connecting as the schema owner silently bypasses RLS everywhere.

---

## 4. VERIFIED

| Gate                                 | Result                          |
| ------------------------------------ | ------------------------------- |
| `pnpm typecheck`                     | clean, exit 0                   |
| `pnpm lint`                          | clean, exit 0                   |
| `pnpm test` (all six projects)       | PLACEHOLDER_GATE                |
| `pnpm security:rls`                  | PASS — 0 findings, 51 tables    |
| `pnpm db:audit-indexes`              | PASS — 0 findings, 216 indexes  |
| `pnpm security:secrets`              | PASS — 442 files                |
| `pnpm security:audit`                | 0 high, 0 critical              |
| `pnpm deploy:check-env` (template)   | correctly REFUSES until filled  |
| `docker compose config`              | valid                           |
| Defect injection round 15            | PLACEHOLDER_INJECTION           |
| Live checks                          | see §5                          |

---

## 5. WHAT WAS RUN, NOT INFERRED

**The store, against a real Redis.** Two application instances sharing one
counter (1, 2, then **3** from the second instance), per-route buckets kept
separate, every key carrying a TTL, and no degradation event during normal
operation.

That last one is a fix rather than a result. The first run degraded on the very
first request of every boot: `lazyConnect` plus `enableOfflineQueue: false`
rejects a command on an unconnected client, so the store fell back to local
counting and emitted a false security event on every deploy. Connecting at boot
fixes it; the failure is logged and degrades rather than refusing to start.

**The API, over HTTP.**

```
GET /api/v1/health          200 {"status":"ok"}      cache-control: no-store
GET /api/v1/health/ready    200 {"status":"ready"}   cache-control: no-store
```

with the full helmet set on both, and the boot log as structured JSON:

```
{"level":"info","message":"rate limiting uses a shared store; configured limits are fleet-wide"}
{"level":"info","message":"proxy trust configured","context":{"trustProxy":"direct (no forwarding header is believed)"}}
{"level":"info","message":"listening","context":{"host":"127.0.0.1","port":3223,"environment":"production"}}
```

`SIGTERM` → `"shutting down"` → `"shutdown complete"` → exit 0.

**The image, as far as this environment allows.** It was NOT built: the egress
policy denies CONNECT to `docker.io`, `ghcr.io`, `mcr.microsoft.com`, `quay.io`
and `public.ecr.aws` alike, so no base image can be pulled. Everything the
Dockerfile *does* was reproduced natively — the exact install command into a
clean tree (88 packages), the exact copied file set, a boot from that tree under
the full production posture, the exact HEALTHCHECK one-liner (exit 0 when ready,
exit 1 with nothing listening), and the SIGTERM drain above.

**That simulation found a real bug.** The runtime stage originally copied only
`/app/node_modules` and `/app/apps/api/node_modules`. A pnpm workspace install
also writes `node_modules` into every package with a dependency —
`packages/authz/node_modules/@edu/kernel`, `packages/contracts/node_modules/zod`
— and those symlinks are what the resolver follows. The image would have built
cleanly and failed to resolve `@edu/kernel` from inside `@edu/authz`. Reading
the Dockerfile would not have caught it. RISK-DEPLOY-01 records what is still
unverified: the base image and Docker's own mechanics.

---

## 6. FILES

```
NEW
  apps/api/src/platform/security/rate-limit-store.ts   the shared store and its outage path
  apps/api/src/platform/security/trusted-proxy.ts      what request.ip means
  apps/api/src/platform/http/health.ts                 liveness and readiness
  tools/security/audit-rls.ts                          six rules, derived from the catalog
  tools/db/audit-indexes.ts                            the indexes the constraints imply
  tools/deploy/check-env.ts                            the server's schema, before the deploy
  db/migrations/0034_cascading_foreign_key_indexes.sql 34 indexes
  db/docker/init-roles.sh                              role separation, once, on an empty cluster
  Dockerfile  docker-compose.yml  .env.production.example
  docs/production-readiness.md                         the checklist
  tests/unit/{trusted-proxy,rate-limit-store,check-env,health}.test.ts
  tests/architecture/production-readiness.test.ts
  tests/integration/{rls-audit,query-plans}.test.ts
  tests/security/deployment-surface.test.ts

CHANGED
  apps/api/src/app.ts                                  store, proxy trust, health wiring
  apps/api/src/main.ts                                 structured boot, shutdown and fatal logging
  apps/api/src/platform/config.ts                      REDIS_URL, TRUST_PROXY, the production refusal
  apps/api/src/platform/security/rate-limit.ts         the store, skipOnError: false
  apps/api/src/modules/knowledge/knowledge.repository.ts  the MATERIALIZED scope (VULN-061)
  packages/observability/src/logger.ts                 stderrJsonSink
  packages/observability/src/security-events.ts        ratelimit.store_degraded
  docs/security/{rate-limiting,limitations,vulnerability-log}.md
  docs/deployment-api.md
```

---

## 7. TEST RESULTS

PLACEHOLDER_RESULTS

---

## 8. WHAT IS NOT READY

Stated in full in `docs/production-readiness.md` §9. The four that matter:

- **No load testing.** The plan assertions are about plan SHAPE. The vector
  timings are single queries on synthetic data. Pool sizing, lock contention
  under concurrent writes, and the readiness probe's behaviour during a real
  incident are unmeasured (RISK-LOAD-01).
- **No CI/CD pipeline.** CI runs the gate; there is no image publishing,
  promotion or rollback.
- **The image has never been built** (RISK-DEPLOY-01). The first CI run that
  builds it should be treated as a test, not a formality.
- **No secret manager.** Secrets are environment variables, unrotated.

---

## 9. THE LESSON THIS TASK ADDS

**A security property expressed as SQL text is a property of the text, not of
the query.**

Every previous task's discipline was about making a boundary hold: the right
predicate, the right policy, the right gate, tested with the other gate removed.
VULN-061 is the first defect where the boundary was written correctly, tested
correctly, and enforced by neither — because the planner is free to reorder
anything it believes to be equivalent, and "equivalent" is defined by
result-set semantics that an approximate index quietly does not satisfy.

The remedy is not vigilance. It is `tests/integration/query-plans.test.ts`,
which extracts the query from the repository source and asserts on the PLAN.
That is a new kind of test for this codebase, and the class of defect it covers
— *correct code, legal optimisation, wrong answer* — has no other detector.

A second, smaller lesson, learned for the second time and now written where it
will be read: **a fitness function must assert on code, never on the
documentation of code.** Two of this task's own fitness tests failed on their
own explanatory comments, because the comments quote the strings the rules
forbid. Task 015 hit this in SQL; the general form is now in
`tests/architecture/production-readiness.test.ts`.

---

## 10. NEXT

**Task 017: CI/CD and the first real build.**

Everything above is verified as far as a machine with no container registry can
verify it. The single highest-value next step is a pipeline that builds this
image on a runner that can pull a base image, runs the gate and the three audits
against a real database, and publishes on green. That converts RISK-DEPLOY-01
from an open risk into either a passing build or a specific error — and it is
the prerequisite for load testing, which needs somewhere to deploy to.
