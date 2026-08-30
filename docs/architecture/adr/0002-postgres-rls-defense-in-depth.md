# ADR 0002 — PostgreSQL RLS as defence in depth

**Status:** Accepted · **Date:** 2026-08-30

## Context

Object-level authorization is non-negotiable (§14). Application-layer checks are
expressive but forgettable: one handler missing a `WHERE owner_id = …` is a
cross-user data breach, and it looks like ordinary code in review.

## Decision

Enforce authorization in **two independent layers**: the application policy
engine _and_ PostgreSQL Row-Level Security. Both must permit the access.

The application connects as `edu_app` — non-superuser, `NOBYPASSRLS`, minimal
grants — and never as the schema owner. Every table has `FORCE ROW LEVEL
SECURITY` so policies bind the owner too. The actor is set per transaction with
`set_config('app.actor_id', $1, true)`.

## Rationale

The two layers fail in different ways, which is the entire point. RLS cannot be
forgotten by a new query; the policy engine can express relationships, state and
disclosure rules that SQL cannot, and produces an auditable reason.

The `true` (transaction-local) argument to `set_config` is load-bearing: a
session-level `SET` would let a pooled connection carry one request's identity
into the next — a cross-user disclosure bug that only appears under concurrency.
There is a test for exactly that, using a pool of size 1 to force reuse.

## Consequences

- Policies must be maintained in two places and kept consistent; tests assert
  they agree on the cases that matter.
- RLS policies are invisible in application code review — hence the integration
  suite that attacks the database directly.
- **Superusers bypass RLS regardless.** Unavoidable in PostgreSQL. Mitigated by
  never connecting as one, and by a test harness that refuses to run if it
  detects one (which would make the RLS suite pass vacuously).
- RLS was measured only for correctness, never for performance. Unknown.
