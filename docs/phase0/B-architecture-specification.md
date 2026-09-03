# B. Architecture Specification

**Phase 0 deliverable. No implementation.** Everything here is **DESIGN
INTENT**; nothing is verified because nothing is built.

---

## 1. The one structural idea

**Two planes, one trust boundary between them.**

```
┌─────────────────────────── CONTROL PLANE ────────────────────────────┐
│  trusted · multi-tenant · reads and writes the tenant database       │
│                                                                      │
│  HTTP API · policy engine · spec store · validator · compiler ·      │
│  approval · deployment · scheduler · run ledger · credential BROKER  │
└───────────────────────────────┬──────────────────────────────────────┘
                                │  queue (durable, Postgres)
                                │  + short-lived, scoped run tokens
┌───────────────────────────────▼──────────────────────────────────────┐
│                       EXECUTION PLANE                                │
│  UNTRUSTED · one isolate per run · no tenant DB credentials ·        │
│  no ambient environment · egress allow-list only · hard bounds       │
└──────────────────────────────────────────────────────────────────────┘
```

The control plane is an evolution of what this repository already has and has
tested. The execution plane is **entirely new and is treated as hostile
territory**: it runs work that a language model wrote and that touches third
party systems. The rest of this document is mostly about keeping that boundary
honest.

### The boundary rules (each is separately testable)

| #   | Rule                                                                                                     | How a test can fail it                                                                           |
| --- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| B1  | A worker never holds the tenant database connection string.                                              | grep the worker's resolved config; assert `DATABASE_URL` absent                                  |
| B2  | A worker never receives a plaintext third-party credential it did not need for the step it is executing. | broker returns a scoped, single-use handle; assert the handle, not the secret, crosses the queue |
| B3  | A worker never receives ambient process env.                                                             | worker spawn passes an explicit, closed env map; fitness test asserts the map's keys             |
| B4  | A worker's outbound network is deny-by-default.                                                          | assert a run whose spec has no connector makes zero egress                                       |
| B5  | The control plane never executes connector code.                                                         | architecture test: connector runtime modules importable only from the worker package             |
| B6  | A run's authority is derived from the deployment, never from the run's own payload.                      | forge every field of a queue message; assert authority unchanged                                 |

B6 is the direct descendant of the education platform's hardest-won lesson: the
`assistant-provider-gate` test forges 13 request fields and asserts the provider
is called **zero** times. The queue message is the same class of boundary as an
HTTP body and gets the same treatment.

## 2. Module map

Names are directories, not packages-in-waiting; the packaging decision is §4.

### Reused as-is (proven in this repo)

| Module                                         | Change needed                                                           |
| ---------------------------------------------- | ----------------------------------------------------------------------- |
| `packages/kernel`                              | none                                                                    |
| `packages/observability`                       | add automation security-event types                                     |
| `packages/authz` — `decision.ts`, `guarded.ts` | **none** (zero education references, audit §3)                          |
| `packages/authz` — `engine.ts`                 | swap the resource-kind → policy registry table                          |
| `apps/api/src/platform/config`                 | add automation keys to schema **and** `CONFIG_KEYS` (VULN-037's lesson) |
| `apps/api/src/platform/db`                     | `withActor` → RLS carries over unchanged                                |
| `apps/api/src/platform/http`                   | auth, CSRF, error envelope, rate limiting carry over                    |
| `apps/api/src/platform/ai`                     | provider abstraction carries over; the _use_ changes (F)                |

### New — control plane

| Module              | Responsibility                                                                    | Must not                                                 |
| ------------------- | --------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `spec/ir`           | The automation IR type + Zod schema. Single source of truth.                      | know about any connector's wire format                   |
| `spec/validator`    | Structural, referential, policy, capability and cost validation of a spec version | mutate the spec                                          |
| `spec/compiler`     | IR → executable plan; deterministic; versioned                                    | resolve credentials, or reach the network                |
| `spec/diff`         | Human-readable diff between two spec versions (what an approver actually reads)   | be the only place a change is visible                    |
| `automations`       | Automation, spec version, approval, deployment lifecycle                          | let a version be edited                                  |
| `runs`              | Run ledger, step attempts, outcomes, cost                                         | be writable by a worker except through the reporting API |
| `triggers/schedule` | Owns _when_; enqueues, never executes                                             | run a step                                               |
| `triggers/webhook`  | Ingress: verify, bound, deduplicate, enqueue                                      | run a step, or trust the body                            |
| `vault`             | Envelope-encrypted credential storage + **broker**                                | ever return plaintext to the control plane's HTTP layer  |
| `queue`             | Durable enqueue/lease/ack/nack/dead-letter                                        | know what a step means                                   |

### New — execution plane

| Module                 | Responsibility                                                                        |
| ---------------------- | ------------------------------------------------------------------------------------- |
| `apps/worker`          | Lease → resolve → execute plan → report. No other authority.                          |
| `runtime/steps`        | The bounded step vocabulary implementations                                           |
| `runtime/connectors/*` | One directory per connector; declares capabilities, endpoints, rate limits, test mode |
| `runtime/sandbox`      | Process/container isolation, resource bounds, egress policy enforcement               |

## 3. Dependency direction

```
contracts ──► kernel
authz ──► kernel
observability ──► kernel
spec/ir ──► kernel, contracts
spec/validator ──► spec/ir, authz            (validation asks the policy engine)
spec/compiler ──► spec/ir                     (and NOTHING else — see below)
api modules ──► spec/*, platform/*, authz, observability
worker ──► spec/ir (plan type only), runtime/*, observability
worker ──✗──► api modules, platform/db, vault internals
```

**`spec/compiler` depends on `spec/ir` and nothing else.** That is a deliberate
narrowing so the compiler is a pure function: same IR + same compiler version →
byte-identical plan. Determinism is what makes "the bytes that ran in staging
run in production" true rather than hoped for, and it is what makes the compiler
testable without a database.

These arrows are enforced the way `docs/architecture/dependency-rules.md`
already enforces the education platform's: **architecture fitness tests that
assert on source, not on behaviour.** The audit found 5 such test files; this
adds to them rather than inventing a new mechanism.

## 4. Packaging: modular monolith + one worker binary

ADR-0001 chose a modular monolith and it was right for the control plane. The
automation platform keeps it, with one addition:

- **`apps/api`** — the control plane. One deployable.
- **`apps/worker`** — the execution plane. A _separate deployable_, because the
  boundary in §1 has to be a process boundary to mean anything. A worker that
  shares a process with the API shares its heap, its environment and its
  database pool, and B1–B3 become comments rather than controls.

That is the whole distributed-systems footprint of v1. No service mesh, no
per-connector microservice, no event bus beyond the queue.

## 5. Request and run lifecycles

### Authoring (synchronous, control plane only)

```
POST /automations/:id/versions {prompt}
  → authorize (policy engine)               ← denies before anything else happens
  → rate limit + cost budget check
  → AI proposal  (F: bounded, non-agentic, schema-constrained)
  → parse into IR; REJECT if it does not parse — never repair silently
  → validate (structure, refs, capabilities, policy, cost ceiling)
  → persist as spec version, status = draft
  → 201 with the spec + the validator's findings
```

The proposal is **never auto-approved and never auto-deployed**, regardless of
validator result. An empty finding list is not an approval.

### Execution (asynchronous, crosses the boundary)

```
trigger fires (schedule | webhook | manual)
  → resolve deployment for (automation, environment)   ← authority comes from HERE
  → create run row (status=queued) + idempotency key
  → enqueue {runId, planId, workspaceId, scoped token}  ← no secrets, no plan body
  → worker leases (visibility timeout, attempt counter)
  → worker fetches plan by planId with the scoped token (read-only, single run)
  → worker executes steps under sandbox bounds
      each step: broker-resolve credential → call → record attempt
  → worker reports outcome (append-only)
  → ack / nack→retry with backoff / dead-letter after N
```

Note what the queue message does **not** contain: the plan, the credentials, or
the workspace's authority. It contains identifiers and a token whose scope is
"this run, read-only, expires". A leaked queue message is then a bounded
incident rather than a tenant compromise.

## 6. Failure model

| Failure                                             | Design response                                                                                                                                                |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Worker dies mid-run                                 | Lease expires → run is re-leased. **Requires step-level idempotency** (ADR-0109).                                                                              |
| Step is not idempotent and the connector has no key | The step is marked `at-most-once`; on ambiguity the run **fails** rather than retries. Retrying a payment is worse than failing one.                           |
| Connector rate-limits                               | Backoff inside the run's deadline; if the deadline is hit, the run fails with `rate_limited` — the same normalized-kind discipline the AI adapter already uses |
| Provider/compiler version drift                     | Plans record their compiler version; a plan compiled by a version no longer present is **not executed**, it is recompiled and re-approved                      |
| Queue backlog                                       | Per-workspace concurrency caps mean one tenant cannot starve another; global backlog is an alert, not a silent degradation                                     |
| Database unavailable                                | Control plane returns 503; the queue is _in_ the database, so no runs are lost or double-started                                                               |

## 7. Scalability posture (stated honestly)

The Postgres-backed queue (ADR-0103) is chosen for correctness, operability and
one fewer trusted store — not for throughput. Its expected ceiling is on the
order of a few hundred leases/second on a single primary, and **that number is
an estimate, not a measurement**. The migration path (Redis or a dedicated
broker behind the same `queue` interface) is the reason `queue` is an interface
in §2 rather than inline SQL.

Horizontal scaling of workers is the only scaling axis in v1. The control plane
is stateless behind the database and scales the same way `apps/api` already
does.

## 8. What this architecture deliberately refuses

- **No dynamic step loading.** The step vocabulary is compiled into the worker.
  A spec cannot introduce a new capability at runtime.
- **No control-plane callbacks from connectors.** A connector talks to its
  vendor and to nothing else.
- **No shared mutable state between runs.** Each run gets a fresh isolate; there
  is no cache a previous tenant's data could survive in.
- **No "just this once" bypass of the approval gate**, including for platform
  admins, including for rollback. Rollback promotes an _already approved_
  version — that is why rollback is safe and why it needs no new approval.
