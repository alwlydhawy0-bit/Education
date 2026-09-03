# ADR 0100 — Reuse the foundation, build a new product

**Status:** Accepted · **Date:** 2026-09-03 · **Phase 0**
**No implementation exists.**

## Context

The Phase 0 audit established the headline finding: this repository contains a
production-grade **educational** platform, and the brief describes an **AI
automation** platform. They are different products.

What exists and is domain-neutral (audit §3): `packages/authz` — whose
`decision.ts` and `guarded.ts` contain **zero** education references and whose
`engine.ts` couples to the domain only through a registry table —
`packages/kernel` (188 lines), `packages/observability` (523),
`apps/api/src/platform` (2,207), 136 RLS policies across 11 migrations using
`FORCE ROW LEVEL SECURITY`, a six-project test pyramid of 2,047 tests, and the
`tools/eval` framework.

What is education-specific: `apps/api/src/modules` (11,915 lines) and its
migrations, contracts, policies and ~1,400 tests.

What the automation platform needs and does not exist at all: the entire
execution plane — workflow engine, queue, worker, scheduler, sandbox, webhook
ingress, credential vault, connector framework (audit §4).

Three options were considered and the choice was put to the product owner.

## Decision

**Keep this repository. Extract the proven, domain-neutral control-plane layers
as the base for the automation platform. Build the execution plane as genuinely
new. The education domain modules stay for now; their retirement is a separate
product decision that Phase 0 does not pre-empt.**

## Alternatives considered

**A. Greenfield repository.** Cleanest conceptual separation. Rejected because
it discards the dual-gate authorization model, 136 RLS policies, the test
pyramid, and the defect-injection culture — the assets that took seven rounds of
adversarial work to earn, and the ones most likely to be re-derived badly under
delivery pressure.

**B. Fork and delete the education modules now.** Rejected as premature:
unwinding 23 migrations is real work with real risk, it is not required to start
the automation platform, and it forecloses a product decision (whether the
education product continues) that has not been made.

**C. Reuse the foundation, new product.** Chosen.

## Consequences

Accepted:

- Two products share `packages/authz`, `packages/kernel`,
  `packages/observability` and `apps/api/src/platform`. A change to a shared
  layer must be evaluated against both.
- `packages/authz`'s resource registry gains automation resource kinds. The
  registry table is the coupling point and it is designed to be extended.
- One database, one migration sequence, both products' tables. RLS keeps them
  apart at the row level exactly as it keeps tenants apart.
- The repository is larger and a newcomer must be told which half is which.
  `docs/phase0/` is that map, and ADR numbering is split (0001–0009 education,
  0100+ automation) so the decision histories never collide.

## What would make this decision wrong

Stated so it can be checked rather than defended:

1. **If the shared layers start growing conditionals** — `if (product ===
'automation')` inside `authz`, `platform/config`, or `platform/http` — the
   coupling has stopped being domain-neutral and the layers should be split into
   genuinely separate packages.
2. **If the two products' release cadences conflict** such that one is blocked
   waiting for the other's tests, the monorepo is costing more than it saves.
3. **If the education product is retired**, this ADR is superseded by a simple
   deletion, and the automation platform keeps everything it was already using.

Any of the three is grounds to revisit. None of them is a reason to hedge now.
