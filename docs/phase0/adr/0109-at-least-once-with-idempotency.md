# ADR 0109 — At-least-once delivery, safety from declared idempotency

**Status:** Accepted · **Date:** 2026-09-03 · **Phase 0**

## Context

Workers die. Leases expire. Networks drop responses after the request landed.
Any durable execution system must decide what happens when it cannot tell
whether a step's effect occurred.

Exactly-once execution against a third-party API is not achievable. Claiming it
would be the kind of unearned assurance §58 forbids.

## Decision

**Delivery is at-least-once. Safety comes from idempotency declared per
connector capability, and the declaration is required.**

Every write capability declares exactly one of:

| Declaration       | Retry behaviour                                                                                                                 |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `idempotent`      | naturally safe (e.g. PUT-by-key) — retry freely within the run deadline                                                         |
| `idempotency-key` | vendor supports a key; the platform generates a deterministic key from `(runId, stepId, attemptGroup)` and retries              |
| `at-most-once`    | no safe retry exists — **never retried automatically.** On ambiguous failure the run fails and is surfaced for a human decision |

The field is **required**, so "we didn't think about it" is not a representable
state.

## Rationale

The failure mode this prevents is charging a customer twice, sending an email
twice, or creating two records — not because the platform is careless, but
because a retry is the _obvious_ response to a timeout, and a timeout is exactly
the case where the effect may already have happened.

Making the declaration mandatory pushes the decision to the person who knows the
vendor's semantics, at the time they write the connector, rather than to the
retry loop at 3am. Defaulting to `at-most-once` when in doubt means the platform
fails loudly rather than acting twice quietly.

Run-level idempotency keys sit above this: manual runs generate one, schedules
derive one from `(triggerId, plannedFireTime)`, webhooks from the delivery id,
and a unique index makes a duplicate trigger a no-op rather than a second run.

## Consequences

- Some legitimate transient failures will surface as run failures rather than
  being retried away. That is the intended trade; the alternative is silent
  double effects.
- A step that has already succeeded is not re-executed after a lease expiry: the
  attempt ledger is consulted, and completed steps are skipped on re-lease.
  This makes the append-only `step_attempts` table load-bearing, not just
  observational.
- Connector admission requires an idempotency story (§A.7). A connector whose
  writes have neither natural idempotency nor a key is admitted only as
  `at-most-once`, and users must be told what that means for retries.
- The acceptance test: kill a worker mid-run, let the lease expire, and assert
  the `at-most-once` step is **not** executed a second time.
