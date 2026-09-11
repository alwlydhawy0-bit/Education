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

| Asked for                         | What it means here                                                                                                          |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Upstash / Redis rate limiting     | A **shared store** behind the existing policy catalogue. Redis, required in production.                                     |
| Helmet / CSP / CORS               | Already present. Verified end to end, including on a 404, and extended with the proxy setting that decides what an IP _is_. |
| Supabase RLS audit                | A **catalog-derived** audit of the platform's own RLS: six rules, every table, proven able to fail.                         |
| pgvector optimisation             | A query-plan investigation that found a correctness bug, not a slow query.                                                  |
| Pino / Winston structured logging | Already structured, already redacting. Fixed the one file that went around it.                                              |
| `.env.production` validation      | A validator that runs the **server's own schema** before an image is built.                                                 |
| Dockerfile / Compose              | Written, reviewed, and verified as far as an environment with no container registry allows.                                 |
| `/health`                         | Split into liveness and readiness, because conflating them causes outages.                                                  |

**Nothing established was redesigned.** The policy catalogue, the origin guard,
the helmet configuration, the authorization engine and the RLS policies are
untouched except where a defect was demonstrated.

---

## 2. THE FIVE DEFECTS

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

### VULN-064 — the rule guaranteeing no redundant indexes had never been able to fire

Found late, while writing falsification tests for the index audit as part of
closing defect injection round 15. Rule I2 compared a leading slice of one
index's column list against another's. `pg_index.indkey` is a catalog vector
with a **zero**-based lower bound, a PostgreSQL array slice is **one**-based,
and array equality compares bounds as well as elements — so the predicate was
FALSE for every pair of indexes on every table.

"PASS — no redundant indexes" had therefore been asserting nothing at all since
the audit was written. The fixed rule found a real redundancy on its first run,
live since migration 0020: `assessment_attempts_assessment_idx` is a leading
prefix of `assessment_attempts_released_idx`, costing write amplification on the
platform's hottest write path and buying nothing. Migration 0035 drops it.

The RLS audit shipped with eight falsification tests. The index audit shipped
with none, and that is exactly where a dead rule could hide. **An audit is not
evidence until something has watched it fail.**

### The CI gate had been failing at its first step, so none of the rest of it ran

Not a defect in the product; a defect in the thing that is supposed to catch
defects, which is worse than it sounds.

`.github/workflows/ci.yml` runs `pnpm run format` — `prettier --check .` — as the
first step of the `static` job. It was failing across **76 files**, and had been
since at least 2026-09-07, forty commits back. A failing step ends the job, so
**every step after it had not run in CI**: lint, typecheck, the unit project, the
architecture project, the web client build, and the assertion that no
server-only value reached the client bundle. That last one is a security check.

Nothing was actually broken — the failures were pure line-wrapping, and the full
gate passes before and after — which is precisely why it went unnoticed for so
long. A gate that fails for a harmless reason gets read as noise, and then it
stops being a gate. The whole repository is now formatted (`prettier --write .`,
77 files, no semantic change) and `pnpm run format` passes, so the steps behind
it run again.

**The lesson.** _A red check that everyone has learned to ignore is worse than no
check, because it also hides the checks behind it._ This one was found by
running CI's own commands locally rather than assuming the gate this task kept
citing was the gate CI was executing.

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

| Gate                               | Result                              |
| ---------------------------------- | ----------------------------------- |
| `pnpm run format`                  | clean, exit 0 — after the fix in §2 |
| `pnpm typecheck`                   | clean, exit 0                       |
| `pnpm lint`                        | clean, exit 0                       |
| `pnpm test` (all six projects)     | 105 files, 3,532 tests, exit 0      |
| `pnpm security:rls`                | PASS — 0 findings, 51 tables        |
| `pnpm db:audit-indexes`            | PASS — 0 findings, 215 indexes      |
| `pnpm security:secrets`            | PASS — 472 files                    |
| `pnpm security:audit`              | 0 high, 0 critical                  |
| `pnpm deploy:check-env` (template) | correctly REFUSES until filled      |
| `docker compose config`            | valid                               |
| Defect injection round 15          | 20 injected, 20 caught, 0 escaped   |
| Live checks                        | see §5                              |

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
Dockerfile _does_ was reproduced natively — the exact install command into a
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
  db/migrations/0035_drop_redundant_attempt_index.sql  drops the redundancy I2 found (VULN-064)
  tests/architecture/production-readiness.test.ts
  tests/integration/{rls-audit,query-plans}.test.ts
  tests/integration/rate-limit-store-redis.test.ts     the real Lua, a real server
  tests/security/deployment-surface.test.ts

CHANGED
  apps/api/src/app.ts                                  store, proxy trust, health wiring
  apps/api/src/main.ts                                 structured boot, shutdown and fatal logging
  apps/api/src/platform/config.ts                      REDIS_URL, TRUST_PROXY, the production refusal
  apps/api/src/platform/security/rate-limit.ts         the store, skipOnError: false
  apps/api/src/modules/knowledge/knowledge.repository.ts  the MATERIALIZED scope (VULN-061)
  packages/observability/src/logger.ts                 stderrJsonSink
  packages/observability/src/security-events.ts        ratelimit.store_degraded
  tools/db/audit-indexes.ts                            rule I2's prefix predicate (VULN-064)
  tests/unit/config.test.ts                            SECRET_BEARING_KEYS, the hardened env
  tests/architecture/deployment-config.test.ts         retargeted from apps/web to edunext
  docs/security/{rate-limiting,limitations,vulnerability-log}.md
  docs/deployment-api.md
```

---

## 7. TEST RESULTS

**The full gate, on the clean tree, with every fix below in place.**

```
pnpm typecheck   exit 0
pnpm lint        exit 0
pnpm test        105 files, 3,532 tests, all passing  (919s)
```

All six vitest projects — unit, architecture, web, integration, security,
evaluation. Nothing skipped, nothing quarantined.

**This task's suites**

| Suite                                              | Tests | What it removes                                  |
| -------------------------------------------------- | ----- | ------------------------------------------------ |
| `tests/unit/trusted-proxy.test.ts`                 | 12    | everything — the parser is pure                  |
| `tests/unit/rate-limit-store.test.ts`              | 13    | Redis (a fake, so the outage path can be driven) |
| `tests/unit/check-env.test.ts`                     | 18    | the process environment                          |
| `tests/unit/health.test.ts`                        | 8     | the database                                     |
| `tests/unit/config.test.ts`                        | 47    | the process environment                          |
| `tests/architecture/production-readiness.test.ts`  | 22    | behaviour — asserts on source text               |
| `tests/architecture/deployment-config.test.ts`     | 16    | Vercel — asserts the config describes this repo  |
| `tests/integration/rls-audit.test.ts`              | 12    | nothing — real catalog, real injections          |
| `tests/integration/query-plans.test.ts`            | 10    | nothing — real planner, real `EXPLAIN`           |
| `tests/integration/rate-limit-store-redis.test.ts` | 7     | nothing — the real Lua, a real server            |
| `tests/security/deployment-surface.test.ts`        | 18    | nothing — real HTTP                              |
| `tests/security/rate-limiting.test.ts`             | 7     | nothing — real HTTP                              |

**Defect injection round 15 — 20 injected, 20 caught, 0 escaped.**

Five of these escaped on the first clean run, and each escape is a gap that was
closed rather than argued away.

| #   | Defect                                                                        | Caught by       |
| --- | ----------------------------------------------------------------------------- | --------------- |
| F1  | The route is dropped from the bucket key, so every route shares one counter   | unit, **plans** |
| F2  | A store error FAILS OPEN — every request allowed while Redis is down          | unit            |
| F3  | The expiry is refreshed on every hit, so a burst slides the window forever    | plans†          |
| F4  | The recovery-probe cooldown is removed — a dead store is called every request | unit            |
| F5  | The whole error object is reported, and a Redis error carries a password      | unit            |
| F6  | The degradation event fires per request rather than on the transition         | unit†           |
| F7  | The plugin is allowed to skip the limiter when the store errors               | arch†           |
| F8  | Blanket proxy trust is accepted, so any caller picks their own bucket         | unit, sec       |
| F9  | A hop count is accepted — Fastify would silently trust no peer at all         | unit, sec       |
| F10 | The boot log prints the internal subnets — topology is reconnaissance         | unit            |
| F11 | Production no longer requires a shared store, so limits silently multiply     | unit, sec       |
| F12 | The Redis URL stops being treated as secret-bearing                           | unit†           |
| F13 | Liveness depends on the database, so a database blip restarts the whole fleet | unit            |
| F14 | The readiness memo is removed — an unauthenticated pool amplifier             | unit            |
| F15 | The readiness body names the dependency and the failure                       | unit            |
| F16 | The scope stops being materialized, so the planner may rank before filtering  | plans           |
| F17 | The RLS audit stops requiring FORCE, so the owner bypasses every policy       | plans           |
| F18 | The index audit stops looking at cascading foreign keys                       | plans†          |
| F19 | The validator stops catching placeholders left in a copied template           | unit            |
| F20 | The validator stops checking the proxy setting                                | unit            |

† escaped on the first run; the suite that catches it now did not exist, or did
not reach that behaviour, until the escape was closed.

**What the five escapes were actually about**

- **F3 — the fake had never run the script.** `tests/unit/rate-limit-store.test.ts`
  replaces Redis with a fake that INTERPRETS the Lua script's contract. That is
  the right tool for the outage path (a real server will not fail on cue) and it
  means the script itself was executed by nothing in the repository. Moving
  `PEXPIRE` out of the `count == 1` branch makes every request renew the window,
  so a sustained burst never reaches the limit and rate limiting stops existing
  — and nothing noticed. `tests/integration/rate-limit-store-redis.test.ts` now
  runs the real script against a real server. A missing Redis **fails** that
  suite rather than skipping it: a suite that skips when its dependency is
  absent reports success for a guarantee nobody checked, which is the same
  failure shape in a different costume.

- **F6 — a serial test cannot see a transition bug.** The existing case drove
  the store one request at a time, where "first failure" and "the transition"
  are the same moment. Ten concurrent requests into a dead store separate them.

- **F7 — a setting with no behaviour of its own.** `skipOnError: false` changes
  nothing observable today; it only matters after someone flips it. There is
  nothing to test behaviourally, so it is a fitness function over the source.

- **F12 — a connection string carries a password.** `REDIS_URL` had been added
  to the schema without being added to the set the validator refuses to print.

- **F18 — the escape that was a real bug.** See VULN-064. Rule I2 of the index
  audit ("no redundant indexes") compared a zero-based catalog vector against a
  one-based array slice, and PostgreSQL array equality compares bounds, so the
  predicate could never be true. The rule had been reporting PASS since the day
  it was written without ever being able to report anything else. Fixing it
  surfaced a genuine redundancy live since migration 0020, dropped by migration 0035. The audit's index count fell from 216 to 215 as a result.

**The green-baseline check.** Every suite above was confirmed passing on the
unmodified tree before and after the round. The runner restores through
`git checkout --` and verifies the tree is clean at every defect boundary,
aborting rather than producing a result that a previous defect's residue might
explain.

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
— _correct code, legal optimisation, wrong answer_ — has no other detector.

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
