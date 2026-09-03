# Phase 0 — AI Automation Platform

Design and inspection only. **No implementation exists** (§4).

Read in this order:

1. **[`00-audit.md`](00-audit.md)** — what the repository and environment
   actually contain, measured rather than assumed. Start here; every other
   document rests on it.
2. **[`A-product-specification.md`](A-product-specification.md)** — what is being
   built, who uses it, and what is deliberately out of v1.
3. **[`B-architecture-specification.md`](B-architecture-specification.md)** — two
   planes and the boundary between them.
4. **[`C-security-specification.md`](C-security-specification.md)** — trust
   zones, the threat model, and each threat's **disconfirming test**.
5. **[`D-data-specification.md`](D-data-specification.md)** — entities,
   invariants, retention.
6. **[`E-api-specification.md`](E-api-specification.md)** — routes, including the
   webhook ingress and the internal worker surface.
7. **[`F-ai-specification.md`](F-ai-specification.md)** — the model's narrow job,
   and how its output is disbelieved.
8. **[`G-execution-specification.md`](G-execution-specification.md)** — the IR,
   validation, compilation, queue, worker, scheduling, idempotency.
9. **[`H-testing-specification.md`](H-testing-specification.md)** — what each
   layer must prove, and the mandatory defect-injection set.
10. **[`I-infrastructure-specification.md`](I-infrastructure-specification.md)** —
    deployables, isolation requirements, CI/CD, and the gaps.
11. **[`J-engineering-rules.md`](J-engineering-rules.md)** — binding rules, each
    with an incident behind it.
12. **[`57-architecture-review.md`](57-architecture-review.md)** — twenty
    questions, answered, with every risk classified.
13. **[`99-phase0-report.md`](99-phase0-report.md)** — the §58 status report.

## Decisions

ADRs are numbered from **0100** so this product's decision history never
collides with the education platform's (`docs/architecture/adr/`, 0001–0009).

| ADR                                                            | Decision                                                 |
| -------------------------------------------------------------- | -------------------------------------------------------- |
| [0100](adr/0100-reuse-foundation-new-product.md)               | Reuse the foundation, build a new product                |
| [0101](adr/0101-declarative-ir-not-code.md)                    | The automation spec is a declarative IR, not code        |
| [0102](adr/0102-execution-isolation.md)                        | Isolation requirements now, technology in Phase 1        |
| [0103](adr/0103-postgres-queue.md)                             | The queue is a Postgres table                            |
| [0104](adr/0104-credential-vault-broker.md)                    | Credentials are brokered, never shipped                  |
| [0105](adr/0105-dual-gate-tenancy.md)                          | Tenancy enforced twice: policy engine and RLS            |
| [0106](adr/0106-immutable-versions-append-only-deployments.md) | Immutable versions; rollback is promotion                |
| [0107](adr/0107-ai-proposes-humans-approve.md)                 | The AI proposes; it never executes or approves           |
| [0108](adr/0108-egress-default-deny.md)                        | Egress default-deny, enforced below the application      |
| [0109](adr/0109-at-least-once-with-idempotency.md)             | At-least-once delivery, safety from declared idempotency |
| [0110](adr/0110-separate-worker-deployable.md)                 | The worker is a separate deployable, not a thread        |

## The one-paragraph summary

This repository holds a production-grade **education** platform. The brief
describes an **automation** platform. ADR-0100 keeps the repository and reuses
the domain-neutral control plane — the dual authorization gate, RLS, the test
pyramid, the AI provider abstraction — and treats the entire execution plane as
greenfield and untrusted. The AI's role is narrowed to proposing a spec that a
human approves; everything with an external effect is a deterministic compiled
plan running in an isolate that inherits nothing. The largest open question is
the isolation substrate, and it is deferred with conditions rather than guessed
at.
