# Rate Limiting

## What exists — stated plainly

`@fastify/rate-limit` with named policies in
`apps/api/src/platform/security/rate-limit.ts`, keyed by `request.ip`, counting
in **a shared Redis store when `REDIS_URL` is set** and **in this process when
it is not**.

Which of those is in force decides whether the numbers in the table below are
the limits the platform ENFORCES or merely the limits it INTENDS.

### Shared (production and staging — required)

`loadConfig` refuses to start a hardened environment without `REDIS_URL`. With
it, the configured number is the enforced number across every replica, and it
survives a deploy.

The counter is a Lua script rather than `INCR` followed by `PEXPIRE`. Those two
commands are two round trips with a gap: a process dying in the gap — or the two
landing on either side of a failover — leaves a key with NO EXPIRY, and that
bucket never refills. Every later request from that address is rate limited
forever: a permanent denial of service against one user, caused by the control
meant to protect them.

### Per-process (development, tests, a single instance)

With N instances the effective limit is N times the configured value, and every
deploy refills each attacker's budget. This was the ONLY mode until Task 016 and
was tracked as RISK-RATE-01 for eight tasks. The server logs a warning naming
the limitation on every boot without a shared store.

### When Redis is unreachable: DEGRADE

Three options, one defensible.

- **Fail open** — the plugin's own default (`skipOnError: true`). Rejected: it
  hands an attacker who can disturb a cache a switch that turns rate limiting
  off, and turns a cache outage into a credential-stuffing window. The
  application sets `skipOnError: false` so a future store cannot quietly
  reintroduce it.
- **Fail closed** — 429 everything while the store is down. Rejected: a Redis
  restart takes the platform offline, including the login page the operator
  needs to fix it. A control whose failure mode is a full outage gets disabled
  by the first person on call, and then protects nothing.
- **Degrade** — count in this process and say so. **Implemented.** Requests stay
  bounded, the site stays up, and `ratelimit.store_degraded` records the window
  during which the numbers were per-instance. The event fires on the TRANSITION
  only: an outage produces two events, not ten thousand. Tracked as
  RISK-RATE-02.

Degradation is not failing open. The fallback still enforces a limit — a weaker
one — and the weakening is in the audit trail rather than in nobody's memory.

## What `request.ip` means: `TRUST_PROXY`

This value is the key of every limit here AND the `ip` field of every security
event. There are two ways to get it wrong and they fail in opposite directions.

- **Too little trust.** Behind a proxy with `trustProxy` off, every request
  appears to come from the proxy. Per-IP limiting collapses into ONE GLOBAL
  BUCKET: the first thirty learners exhaust the login limit for everybody, and
  an attacker is indistinguishable from a classroom.
- **Too much trust.** `trustProxy: true` believes a client-supplied
  `X-Forwarded-For`. An attacker sends a new address per request, no two
  requests share a key, and rate limiting stops existing while continuing to
  report success.

`platform/security/trusted-proxy.ts` accepts an **address or CIDR list** and
refuses everything else, at boot, with a message.

**It also refuses a hop count**, which is the non-obvious one. Fastify 5's type
accepts a number and `getTrustProxyFn` in `lib/request.js` compiles it to
`function () { return false }` — a numeric setting trusts NOTHING. A deployment
setting `TRUST_PROXY=2` would boot cleanly, log its hop count, and key every
request to the load balancer: the first failure mode above, arrived at by
configuring the thing meant to prevent it.

## Enforced policies

| Policy                | Limit        | Keyed by  | Why                                                                                                                   |
| --------------------- | ------------ | --------- | --------------------------------------------------------------------------------------------------------------------- |
| `global`              | 300 / min    | IP        | Blunt ceiling. High enough not to affect a classroom sharing an IP.                                                   |
| `auth.login`          | 10 / 15 min  | IP        | Credential stuffing and password brute force.                                                                         |
| `auth.register`       | 5 / 15 min   | IP        | Bulk account creation, Argon2 CPU exhaustion, and the compensating control for the enumeration weakness RISK-ENUM-01. |
| `auth.refresh`        | 60 / 15 min  | IP        | Refresh-token grinding and rotation abuse.                                                                            |
| `auth.password_reset` | 5 / hour     | IP        | Reset-token flooding, inbox harassment, and account enumeration.                                                      |
| `auth.verify_email`   | 20 / hour    | IP        | Brute-forcing a verification token.                                                                                   |
| `assessment.attempt`  | 200 / 15 min | IP        | Answer-key probing through repeated attempts. **Secondary** to the per-learner `max_attempts` limit.                  |
| `assessment.submit`   | 200 / 15 min | IP        | Repeated scoring is the expensive half of answer-key probing.                                                         |
| `lab.session_start`   | 200 / 15 min | IP        | **The only bound on session creation** — a lab has no attempt limit, by design. See below.                            |
| `lab.submit`          | 200 / 15 min | IP        | Marking runs one rule check per rule inside a trigger, so a submission is the expensive request in that domain.       |
| `ai.request`          | 60 / hour    | **actor** | Provider cost is real money. The only per-actor policy: a class sharing a NAT must not share a quota.                 |
| `workspace.artifact`  | 120 / 15 min | IP        | **Row-count abuse, which the byte quota does not bound** — a million one-byte registrations fit inside 256 MiB.       |

Limits live in one catalogue rather than as numbers scattered across route
definitions, so the whole throttling posture is reviewable on one screen.

### `lab.session_start` carries more weight than its assessment counterpart

An assessment has `max_attempts`, enforced per learner by a database trigger, so
its limiter is genuinely secondary. **A lab has no attempt limit and should not
have one**: "keep adjusting it until the circuit works" is the pedagogy, and a
lab that locked a child out after three tries would be a worse lab. This policy
is therefore the only thing bounding how many sessions one source can open.

What it protects is platform cost, not the validation rules. Those stay hidden
however many times a learner submits — a submission answers "not yet", never
"the voltage must be 5" — so a scripted grinder learns one bit per attempt about
a lab it was already entitled to attempt.

## Reserved policies — declared, NOT enforced

`file.upload`, `operation.expensive`. Both are in
`RESERVED_RATE_LIMIT_POLICIES`, and `tests/unit/rate-limit.test.ts` asserts they
are not mistaken for active ones.

**This list was stale until Task 009.** It named `auth.password_reset` and
`ai.request` as reserved long after both were enforced — the table above is now
generated by reading `routeLimit` call sites rather than by memory.

These have no routes yet. They are recorded so the limit is decided alongside the
feature rather than bolted on afterwards, and they are kept in a **separate
object** so nothing mistakes them for active protection. A unit test asserts the
two sets never overlap.

## Ordering: why the limiter runs before the origin guard

Fastify runs every `onRequest` hook before any `preHandler`. The limiter is an
`onRequest` hook; the CSRF origin guard is a `preHandler`. So a request is
**counted before** the origin check can reject it.

This was a real defect, found while writing the tests. With the origin guard at
`onRequest` it ran first, so an attacker could send unlimited requests simply by
setting a wrong `Origin` header: each was a cheap 403, none was ever counted, and
the flood was invisible in the rate-limit signal.

Registration order alone would not have fixed it — hooks added inside a Fastify
plugin are appended when the plugin _loads_, not when it is registered, so a
synchronously-added `onRequest` hook wins regardless. The lifecycle guarantee is
what makes the current ordering robust.

The cost is that the request body is parsed before a cross-origin rejection.
That is bounded by the 256 KiB body limit, and no handler runs either way.

## Events

Exceeding a limit records a `ratelimit.exceeded` security event with the method
and the **route pattern** — never the concrete URL, which can contain identifiers
and query values.

`actorId` on these events is always `null`, and correctly so: the hook runs at
`onRequest`, before the session is resolved. Reading `request.actor` there would
look like per-actor attribution while silently always producing null. Actor-scoped
quotas — which the reserved `ai.request` policy will need, since provider cost is
real money — require a limiter that runs after authentication. Not built.

## Related: repeated-denial detection

Separate from rate limiting, `createSecurityEventRecorder` escalates a run of
authorization denials by one actor to `authz.repeated_denial`. It shares the same
limitation: **per-process and in-memory**, so it is a detection foundation, not a
SIEM, and not a substitute for one.
