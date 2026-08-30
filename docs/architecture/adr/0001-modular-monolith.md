# ADR 0001 — Modular monolith, not microservices

**Status:** Accepted · **Date:** 2026-08-30

## Context

The platform must scale to a large user base and eventually support ~30 domains.
Three exist today. The brief (§6) explicitly warns against introducing
distribution merely because scale is _intended_.

## Decision

Build a modular monolith: one API process, strict internal module boundaries,
enforced by architecture fitness tests.

## Rationale

Microservices today would buy network partitions, distributed transactions,
eventual consistency and a deployment pipeline per service — in exchange for
scaling properties nobody needs at zero users. Those costs are paid immediately;
the benefits arrive much later, if at all.

The real risk of a monolith is not performance, it is **entanglement** — that by
the time extraction is justified, it is impossible. So the boundaries are treated
as the deliverable, and they are machine-checked: no module imports another
module, only the composition root wires them, each domain owns its tables.

## Consequences

- Fast to develop; one deployment; transactions are simple and local.
- A single process is a single blast radius; scaling is all-or-nothing.
- Extraction remains possible because the seams are enforced continuously, not
  audited occasionally.

## Revisit when

One domain's load, reliability requirements, or owning team diverges enough to
justify a separate deployment — extract along the existing module seam.
