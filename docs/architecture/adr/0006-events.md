# ADR 0006 — A minimal in-process event bus

**Status:** Accepted · **Date:** 2026-08-30

## Context

§20 asks for events where they reduce coupling, and explicitly warns against
building unnecessary infrastructure.

## Decision

A small typed in-process event bus in `packages/kernel`. No broker, no queue, no
persistence, no retry, no cross-process delivery. Handlers are isolated from each
other; a failing handler is reported and does not affect the publisher.

**No domain publishes an event yet.** The bus exists so the first cross-domain
reaction has an obvious home.

## Rationale

A message broker at zero users is infrastructure to operate, not architecture. An
in-process bus captures most of the decoupling benefit — `assessments` need not
know `analytics` exists — at almost no cost, and the interface is broker-shaped
enough to swap later.

## Consequences

- **Delivery is weak, deliberately.** Handlers run after the publishing
  transaction commits; no retry; no durability.
- Therefore: **never place a security control or a data-integrity invariant in an
  event handler.** Those belong in the publishing transaction. This is stated in
  the source file too, because it is the mistake this pattern invites.
- Cross-process delivery needs a real broker and a transactional outbox. Not
  built.
