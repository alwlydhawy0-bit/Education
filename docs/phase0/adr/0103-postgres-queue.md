# ADR 0103 — The queue is a Postgres table

**Status:** Accepted · **Date:** 2026-09-03 · **Phase 0**

## Context

Runs must be durable, retryable, fairly scheduled across tenants, and
observable. The audit found no queue, no Redis, no BullMQ, no Temporal — the
choice is entirely open. PostgreSQL 16 is already the system of record and is
already operated, backed up and RLS-protected.

## Decision

**Implement the queue as a table in the existing PostgreSQL database**, leased
with `FOR UPDATE SKIP LOCKED`, behind a `queue` interface narrow enough to be
replaced.

## Rationale

1. **One fewer trusted stateful store.** Every additional store is another thing
   to secure, back up, restore, monitor, and reason about at 3am. Redis in
   particular is an unauthenticated-by-default, in-memory store that would hold
   run identifiers and tokens.
2. **Transactional enqueue.** Creating a run row and enqueuing its message is
   one transaction. With an external broker, "run created but never queued" and
   "queued but no run row" are both real states requiring reconciliation code
   that nobody writes until after the first incident.
3. **The idempotency index is in the same database as the queue**, so "exactly
   one run per `(triggerId, fireTime)`" is a unique constraint rather than a
   distributed agreement problem.
4. **RLS applies.** Queue rows carry `workspace_id` and are protected by the same
   mechanism as everything else.
5. **Observability for free.** Queue depth, oldest-available age, lease expiries
   and dead-letter rates are SQL queries, not a second metrics pipeline.
6. **`SKIP LOCKED` is a mature, documented primitive**, not a clever trick.

## What is explicitly given up

- **Throughput.** Expected ceiling on the order of hundreds of leases/second on a
  single primary. **This is an estimate, not a measurement** (OPEN-EXEC-02).
- **Fan-out patterns** a real broker gives cheaply.
- Load on the primary competing with control-plane queries.

## Consequences

- `queue` is an **interface** (enqueue / lease / extend / ack / nack /
  dead-letter), not inline SQL scattered through the scheduler and worker. That
  is the migration path: a broker-backed implementation swaps in behind it.
- Per-workspace concurrency caps are enforced **in the lease query**, because
  fairness must be applied where work is handed out, not where it is submitted.
- At-least-once delivery is the contract. Exactly-once is not offered because it
  cannot be delivered across a network to a third party (ADR-0109).
- `FOR UPDATE SKIP LOCKED` must survive every refactor; a plain `SELECT`
  silently reintroduces double-leasing under concurrency. It gets a comment in
  the SQL and a test that runs two leasers concurrently.

## Trigger to revisit

Measured sustained lease rate approaching the ceiling, or p99 lease latency
degrading control-plane query latency. Both are observable with the metrics this
design already produces, so the trigger is detectable rather than theoretical.
