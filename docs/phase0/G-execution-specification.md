# G. Execution Specification

**Phase 0 deliverable. No implementation.** The entire execution plane is
greenfield (audit §4: workflow engine, queue, worker, scheduler, sandbox,
webhook ingress, credential vault, connectors — all **ABSENT**).

---

## 1. The spec IR

A declarative document. **Not code, not a script, not an expression language.**

```jsonc
{
  "irVersion": 1,
  "name": "Notify sales on new high-value lead",
  "trigger": { "kind": "webhook" }, // or { kind: "schedule", cron, tz }
  "inputs": {/* named, typed, schema'd */},
  "steps": [
    {
      "id": "s1", // unique, stable, referenced by attempts
      "type": "connector.call",
      "connector": "crm",
      "capability": "lead.read",
      "connection": { "ref": "conn_..." }, // a REFERENCE. Never a value.
      "args": { "leadId": { "from": "trigger.body.id" } },
      "onError": "fail", // fail | continue | retry(policy)
    },
    {
      "id": "s2",
      "type": "branch",
      "when": { "gte": [{ "from": "s1.value" }, { "const": 10000 }] },
      "then": ["s3"],
      "else": [],
    },
  ],
  "limits": { "maxDurationMs": 300000, "maxSteps": 50, "maxCostMicros": 100000 },
}
```

### Properties the IR must have, and why each

| Property                                                                            | Why                                                                                                                                                              |
| ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Finite step type vocabulary**                                                     | A spec cannot introduce a capability at runtime. What the worker can do is compiled in.                                                                          |
| **No arbitrary expressions**                                                        | `when` and `from` are a small, total, side-effect-free reference/comparison grammar. There is no evaluator to escape from because there is no general evaluator. |
| **Data references are structural** (`{from: "s1.value"}`), not string interpolation | String interpolation is injection; a reference either resolves or the spec fails validation.                                                                     |
| **Credentials are references, always**                                              | THREAT-CRED-04. The schema type for an auth field admits only `{ref}`.                                                                                           |
| **Static, acyclic step graph**                                                      | Reachability, cost, and termination are decidable before running.                                                                                                |
| **Declared limits, defaulted low**                                                  | A missing limit is not "unlimited", it is the default.                                                                                                           |
| **Serializable, hashable, diffable**                                                | Approval, versioning, and rollback all depend on this.                                                                                                           |

**Deliberately absent from v1**: loops, sub-workflows, fan-out/fan-in,
user-defined functions, a generic HTTP step, and dynamic connector selection.
Each of those is a real product need and each converts a decidable property
above into an undecidable one. They are Phase-N decisions with their own ADRs,
not v1 conveniences.

## 2. Validation (before compilation, always)

| Layer           | Checks                                                                                                              | Failure                                                   |
| --------------- | ------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| **Structural**  | Zod `.strict()` against the IR schema; unknown keys rejected                                                        | reject                                                    |
| **Referential** | every `from` resolves to a prior step or an input; step ids unique; graph acyclic; every branch target exists       | reject                                                    |
| **Registry**    | connector exists, capability exists on it, connection exists in this workspace **and this environment**             | reject                                                    |
| **Policy**      | the workspace has been granted this capability; the _actor_ may author it                                           | reject                                                    |
| **Bounds**      | step count, graph depth, declared limits within platform maxima, estimated worst-case cost within budget            | reject                                                    |
| **Advisory**    | non-idempotent write with no idempotency key; unbounded-cardinality read; a step whose failure leaves partial state | **finding**, surfaced to the approver, not an auto-reject |

The advisory row matters: the platform's job is to make risk **visible to the
approver**, not to pretend it can decide every case. A finding a human sees and
accepts is a better outcome than a rule that blocks legitimate work and gets
disabled.

## 3. Compilation

`compile(ir, compilerVersion) -> plan`, a **pure function**. Same inputs, byte-identical
output; `plan_hash` is checkable by recompiling.

The compiler:

- resolves the step graph into an execution order,
- binds each step to a concrete step implementation and connector version,
- attaches the effective limits (declared ∩ platform maxima),
- computes the **egress allow-list** for the run: the union of the declared hosts
  of exactly the connectors the plan uses, and nothing else,
- attaches the credential _references_ each step is permitted to broker — the
  worker's credential requests are checked against this list.

The compiler **never** touches the network, the vault, or the database. That is
what makes it testable as a pure function and what makes ADR-0102's isolation
argument tractable: the plan is a complete, inspectable statement of what a run
may do, produced before the run exists.

## 4. Queue and leasing (ADR-0103)

Postgres-backed. One table, one leasing query:

```sql
UPDATE queue_messages
   SET leased_until = now() + $lease, lease_token = gen_random_uuid(), attempts = attempts + 1
 WHERE id IN (
   SELECT id FROM queue_messages
    WHERE available_at <= now() AND leased_until IS NULL AND dead_lettered_at IS NULL
      AND workspace_concurrency_ok(workspace_id)
    ORDER BY available_at
    FOR UPDATE SKIP LOCKED
    LIMIT $n)
RETURNING id, run_id, workspace_id, lease_token;
```

- **`FOR UPDATE SKIP LOCKED`** is why this works under concurrency. It is named
  in the spec so nobody "simplifies" it away.
- **At-least-once delivery.** Exactly-once is not offered because it cannot be,
  across a network to a third party. Safety comes from idempotency (§6).
- **Visibility timeout, not heartbeat-free leases.** A worker extends its lease
  while running; a dead worker's lease expires and the run is re-leased.
- **Per-workspace concurrency caps at lease time** (THREAT-EXEC-05) — enforced
  where the work is handed out, not where it is submitted, because a fair
  submission does not stay fair.
- **Dead letter after `max_attempts`**, with the terminal error kind recorded.
  A dead-lettered run is visible in the UI and alertable; it is never silently
  dropped and never retried forever.

## 5. Worker lifecycle

```
lease(runId, leaseToken)
  → GET /internal/runs/{runId}/plan          (token-scoped, read-only)
  → open sandbox: closed env map, egress allow-list from the plan, rlimits
  → for each step in plan order:
        cancel flag? → stop
        deadline exceeded? → fail(timeout)
        broker credential for THIS step only  → short-lived, single-purpose
        execute with per-step timeout + response caps
        report attempt (append-only)
  → report terminal outcome (idempotent by leaseToken)
  → ack
```

Non-negotiable properties:

1. **The worker's authority is the plan.** It cannot request a credential the
   plan does not reference; it cannot reach a host the plan's allow-list does
   not contain; it cannot read another run.
2. **The worker holds no tenant database credential** (B1). It talks to the
   control plane over the narrow `/internal` surface only.
3. **The worker's environment is an explicit closed map** (B3, THREAT-EXEC-04).
   No `process.env` passthrough, no inherited cloud role, and the instance
   metadata endpoint is unreachable.
4. **One isolate per run.** No state, cache, temp file, or connection pool
   survives from one run to the next. A previous tenant's data cannot be there
   because nothing is.
5. **The server owns the deadline too.** The control plane will terminate a run
   whose lease expires irrespective of what the sandbox does — the two-layer
   pattern from `callWithDeadline`, applied at the process level.

## 6. Idempotency and retries (ADR-0109)

Every write capability a connector declares must state one of:

| Declaration                               | Retry behaviour                                                                                                                                   |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `idempotent` (naturally, e.g. PUT-by-key) | retry freely within the run deadline                                                                                                              |
| `idempotency-key` (vendor supports a key) | platform generates a deterministic key from `(runId, stepId, attemptGroup)` and retries                                                           |
| `at-most-once` (no safe retry)            | **never retried automatically.** On ambiguous failure (timeout, connection reset after send) the run **fails** and is surfaced for human decision |

Retrying an unretryable write is worse than failing it. The platform's default
must be the one that cannot double-charge a customer, and the connector author
must state which case applies — the field is required, so "we didn't think about
it" is not a representable state.

Retry backoff is exponential with jitter, bounded by the run's deadline, and
capped by `max_attempts`. Rate-limit responses back off inside the deadline and
then fail as `rate_limited` — the same normalized-kind discipline the AI adapter
already uses.

## 7. Scheduling

- Cron + IANA timezone per trigger, stored as text; **next fire time computed
  and stored** so the due query is an index scan, not a scan-and-evaluate.
- The scheduler **enqueues; it never executes.** It is a control-plane component
  and holds no connector code.
- Missed fires (process down): a bounded catch-up window, configurable, default
  **do not backfill**. Silently running 400 skipped hourly jobs after an outage
  is a worse failure than skipping them.
- DST and leap: the timezone is stored, the arithmetic is done in it, and
  ambiguous/nonexistent local times have a documented rule (skip nonexistent,
  fire once on ambiguous). Overlap prevention: if the previous run for a trigger
  is still active, the default is **skip with a recorded reason**, not queue.
- Idempotency key is `(triggerId, plannedFireTime)`, so a scheduler that fires
  twice creates one run.

## 8. Cancellation

Cooperative and honest. A cancel sets a flag; the worker checks it between
steps. The API and UI must say **"cancellation requested"** until the worker
confirms, and must never claim that an in-flight external call was undone. The
platform does not have that power, and pretending it does is how a user makes a
bad decision.

## 9. Observability of a run

Every run produces: status timeline, per-step attempts with timings and
normalized error kinds, cost, egress hosts contacted, credentials brokered
(references, never values), and the plan hash it executed.

**The plan hash on the run is what makes the audit trail complete**: the run
record names exactly which compiled bytes ran, which name exactly which spec
version, which names exactly who approved it and what diff they saw.

## 10. Open execution risks

| ID           | Risk                                                                                                                                     |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| OPEN-EXEC-01 | Sandbox technology unchosen (ADR-0102). All isolation claims are **UNVERIFIED**.                                                         |
| OPEN-EXEC-02 | Postgres queue throughput ceiling is estimated, not measured.                                                                            |
| OPEN-EXEC-03 | Connector rate-limit models differ per vendor; a shared abstraction may not fit all, and no connector exists yet to test the assumption. |
| OPEN-EXEC-04 | Egress enforcement depends on the deployment substrate (§I). Without one, the allow-list is a plan field with no enforcer.               |
