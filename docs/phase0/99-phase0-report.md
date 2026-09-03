# Phase 0 — Report

**Date:** 2026-09-03 · **Base commit at audit:** `b1243b8`
**Scope:** inspection and design only. **§4 forbids implementation in this phase
and none was performed.**

Reporting vocabulary is §58's, and it is used strictly: **VERIFIED / PARTIALLY
VERIFIED / UNVERIFIED / BLOCKED / OPEN RISK**. The words _secure_, _production
ready_, _scalable_, _AI correct_, _fully tested_, _Arabic supported_ and
_provider validated_ do not appear as claims anywhere in these documents.

---

## 1. What was produced

| Deliverable                                   | File                                |
| --------------------------------------------- | ----------------------------------- |
| Repository & environment audit (§5)           | `00-audit.md`                       |
| A. Product Specification                      | `A-product-specification.md`        |
| B. Architecture Specification                 | `B-architecture-specification.md`   |
| C. Security Specification                     | `C-security-specification.md`       |
| D. Data Specification                         | `D-data-specification.md`           |
| E. API Specification                          | `E-api-specification.md`            |
| F. AI Specification                           | `F-ai-specification.md`             |
| G. Execution Specification                    | `G-execution-specification.md`      |
| H. Testing Specification                      | `H-testing-specification.md`        |
| I. Infrastructure Specification               | `I-infrastructure-specification.md` |
| J. Engineering Rules                          | `J-engineering-rules.md`            |
| Final architecture review, 20 questions (§57) | `57-architecture-review.md`         |
| ADRs 0100–0110                                | `adr/`                              |

Eleven ADRs, numbered from 0100 so the automation platform's decision history
never collides with the education platform's 0001–0009.

## 2. Status of every substantive claim

### VERIFIED (evidence exists, in this repository, today)

| Claim                                                                                                     | Evidence                                                                                                                                                    |
| --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The repository contains a working education platform with a dual authorization gate                       | 136 RLS policies across 11 migrations with `FORCE ROW LEVEL SECURITY`; `edu_app` / `edu_app_norls` roles; existing cross-tenant suites                      |
| `packages/authz` is domain-neutral except a registry table                                                | `decision.ts` and `guarded.ts` contain zero education references; `engine.ts`'s only coupling is the resource-kind → policy map                             |
| A six-project test pyramid exists and runs                                                                | 63 files, 2,047 tests                                                                                                                                       |
| The AI provider abstraction, model allow-list, base-URL pinning and boot-time credential requirement work | Tasks 013–015, tested offline against a stubbed transport                                                                                                   |
| The entire execution plane is absent                                                                      | searched `apps`, `packages`, `db`, `tools`: no queue, worker, scheduler, sandbox, webhook ingress, vault, connector framework, redis/bullmq/temporal/docker |
| CI does not run the `web` or `evaluation` projects                                                        | `.github/workflows/ci.yml`                                                                                                                                  |

### PARTIALLY VERIFIED

| Claim                                                      | Limit                                                                                   |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| The AI adapter's privacy and error-normalization behaviour | Verified against a **stubbed transport** only; no live provider call has ever been made |
| The evaluation framework measures what it claims           | Verified on the education corpus; no automation corpus exists                           |

### UNVERIFIED

Everything designed in A–J. The automation platform does not exist: no IR, no
validator, no compiler, no queue, no worker, no vault, no connector, no route.
**No control described in `C-security-specification.md` is implemented, and none
may be described as mitigating anything.**

### BLOCKED

| Item                                                                                               | Reason                                                                                                                                                                                                          |
| -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Live AI provider behaviour, and therefore the wire-level privacy assertion against a real provider | **No application AI credential exists in this environment** (`AI_API_KEY` ABSENT, `ANTHROPIC_API_KEY` ABSENT). Unchanged since Task 015. No harness or environment credential was used, sought, or substituted. |
| Envelope encryption's root of trust                                                                | No KMS exists in this environment                                                                                                                                                                               |
| Backup/restore rehearsal                                                                           | Nothing is deployed                                                                                                                                                                                             |

### OPEN RISK

Fifteen entries, all enumerated with classifications in
`57-architecture-review.md`'s risk register. The ones that gate work:

- **OPEN-EXEC-01 / OPEN-INFRA-01** — no execution sandbox chosen. Gated: no
  isolation claim without a test that fails when the control is removed; I6
  measured; **no write-capable connector ships before the choice**.
- **OPEN-SEC-02** — no KMS; the vault has no root of trust.
- **OPEN-CI-01** — `web` and `evaluation` absent from CI. **Designated the first
  item of the first implementation phase**, because it is a hole in a gate that
  already exists.

## 3. The decisions that close options

| ADR  | Decision                                                              | Notably rejected                                |
| ---- | --------------------------------------------------------------------- | ----------------------------------------------- |
| 0100 | Reuse the foundation, new product                                     | greenfield repo; deleting education modules now |
| 0101 | Spec is a declarative IR, not code                                    | user code, general expression language          |
| 0102 | Isolation requirements fixed, technology deferred **with conditions** | in-process V8 isolates                          |
| 0103 | The queue is a Postgres table                                         | Redis/BullMQ/Temporal for v1                    |
| 0104 | Credentials brokered, never shipped                                   | credentials in the queue message or plan        |
| 0105 | Dual gate: policy engine **and** RLS                                  | single-gate tenancy                             |
| 0106 | Immutable versions; rollback is promotion                             | editable automations                            |
| 0107 | AI proposes; humans approve; plans execute                            | agentic runtime                                 |
| 0108 | Egress default-deny, enforced below the app                           | application-level allow-listing                 |
| 0109 | At-least-once + declared idempotency                                  | claiming exactly-once                           |
| 0110 | Worker is a separate deployable                                       | worker as a thread in the API                   |

## 4. What Phase 0 got wrong or could not settle

Stated because a report containing only successes is not a report (J4):

1. **The substrate question was not answered.** ADR-0102 is a deferral. It is
   conditioned and gated, but it is still the largest open question in the
   design, and every isolation, egress and blast-radius statement in §B, §C, §G
   and §I inherits its uncertainty.
2. **Throughput numbers are estimates.** The Postgres queue's ceiling is a
   reasoned guess. It is labelled as one everywhere it appears and should not be
   repeated as a measurement.
3. **The education modules' fate is still undecided.** ADR-0100 deliberately did
   not decide it. That is defensible, but it means the repository carries 11,915
   lines whose future is unknown, and the cost of that ambiguity grows.
4. **No adversarial review of the IR grammar has been done**, because the
   grammar does not exist yet in code. §G.1's claim that "there is no evaluator
   to escape from" is true of the design and will need to be re-established
   against the implementation.
5. **The approver-comprehension risk (Q20) has no technical mitigation.** The
   diff renderer is named as a security surface, which is the beginning of an
   answer, not the answer.

## 5. What the first implementation phase should do, in order

Ordered by what unblocks the most, not by what is most interesting:

1. **Fix OPEN-CI-01** — add `web` and `evaluation` to CI. Smallest change, and it
   restores a gate that is currently open.
2. **Decide the substrate (ADR-0102)** by measurement, and build the
   `execution` test project's egress/env/metadata assertions **first**, so the
   choice is made against tests rather than opinions.
3. **The IR, validator and compiler**, as pure code with no database — the part
   with the highest test-value-per-line and no infrastructure dependency.
4. **Tenancy tables + RLS + policy engine extension**, with the dual-gate suite
   running from day one, before any route exists to use them.
5. **Queue and worker**, against a stubbed connector, proving lease/retry/
   idempotency/concurrency-cap behaviour before any real vendor is involved.
6. **The broker and the vault** — after a KMS decision, not before.
7. **The first connector**, chosen for having a sandbox, an idempotency story
   and a respectable rate limit.
8. **The AI proposal path last**, because it is the only part whose value
   depends on everything beneath it being trustworthy.

No step above may be reported as complete without a defect-injection round
(J23) and the §58 vocabulary.

## 6. Statement

Phase 0 produced a design, an evidence-backed audit, eleven decisions, and a
risk register. **It produced no code, no schema, no route and no control.**
Nothing in this phase makes the platform secure, correct, scalable or ready,
because nothing in this phase makes the platform exist.
