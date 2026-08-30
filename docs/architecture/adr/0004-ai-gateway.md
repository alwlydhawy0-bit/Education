# ADR 0004 — All AI traffic through a single gateway

**Status:** Accepted (design) · **Date:** 2026-08-30
**No implementation exists.**

## Context

Two AI products are planned (Tutor, Assistant) with different context policies,
knowledge priorities and tool sets. Both handle minors' data. Providers change.

## Decision

Both products route through one **AI Gateway**, the only component that talks to
a provider. It owns authentication, authorization, rate limiting and quota,
context selection, tool authorization, safety filtering, logging, and provider
abstraction.

The frontend sends an _intent_, never a tool name, model, system prompt, or
context document.

## Rationale

Without a single choke point, every new AI feature re-implements authorization
and rate limiting, and each is a fresh chance to leak. A gateway also makes the
provider replaceable: adapters live behind one interface, so a provider change
does not touch business logic (§26).

Most importantly it gives retrieval authorization exactly one home — and
retrieval authorization is the highest-consequence control in the AI design.

## Consequences

- A single point of failure and a potential bottleneck; must be built for it.
- Some latency overhead versus calling a provider directly. Accepted.
- Product teams cannot ship an AI feature without going through the gateway.
  That is the point.
