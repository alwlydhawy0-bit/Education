# A. Product Specification

**Phase 0 deliverable. No implementation.**
Status of every claim below: **DESIGN INTENT**, not verified behaviour.

---

## 1. What the product is

An **AI Automation Platform**: a system where a person describes a business
process in natural language, and the platform turns that description into a
reviewed, versioned, testable, deployable automation that runs on a schedule or
in response to an event, against real third-party systems, with an audit trail.

The pipeline, and the whole product, is this sequence:

```
natural language
  → automation SPEC (declarative IR)
    → VALIDATION (schema, policy, capability, cost)
      → COMPILATION (IR → executable plan)
        → TESTING (dry run against fixtures / sandbox)
          → APPROVAL (human, explicit, recorded)
            → DEPLOYMENT (version promoted to an environment)
              → EXECUTION (queued, isolated, bounded)
                → MONITORING (runs, costs, failures, drift)
                  → VERSIONING / ROLLBACK
```

Every arrow is a gate. **None of them is optional and none of them is
AI-decided.** The AI participates at exactly one arrow — the first — and its
output is a proposal that the rest of the pipeline is free to reject.

## 2. What the product is NOT

Stating this precisely is load-bearing, because most of the security design
follows from it.

- **Not an agent runtime.** The platform does not let a model decide at runtime
  which action to take. A model proposes a spec; a human approves it; the
  compiled plan is what executes. A deployed automation's behaviour is fixed
  before it runs.
- **Not a code-execution service.** Users do not ship arbitrary programs. They
  ship specs drawn from a bounded vocabulary of steps. (Whether a constrained
  expression language is later admitted is ADR-0101's open question, and it is
  deliberately left closed in v1.)
- **Not a general integration bus.** Connectors are first-party, declared, and
  capability-scoped. There is no "call any URL" step in v1.
- **Not a chat product.** The natural-language surface is an authoring aid, not
  a runtime interface.

## 3. Users and what each may do

| Role               | Authors specs | Approves | Deploys          | Runs manually      | Reads runs         | Manages credentials         | Manages members       |
| ------------------ | ------------- | -------- | ---------------- | ------------------ | ------------------ | --------------------------- | --------------------- |
| **Viewer**         | no            | no       | no               | no                 | own workspace      | no                          | no                    |
| **Author**         | yes (draft)   | no       | no               | in _test_ env only | own workspace      | attach existing, never read | no                    |
| **Approver**       | yes           | **yes**  | yes → staging    | yes (staging)      | own workspace      | attach existing             | no                    |
| **Operator**       | no            | no       | yes → production | yes (production)   | own workspace      | rotate                      | no                    |
| **Owner**          | yes           | yes      | yes              | yes                | own workspace      | create/rotate/delete        | yes                   |
| **Platform admin** | no            | no       | no               | no                 | **no tenant data** | no                          | tenant lifecycle only |

Two rules that the table encodes and that the policy engine must enforce
independently of the UI:

1. **An author may not approve their own spec version.** Separation of duty is a
   product requirement, not a nicety — the AI-authored path makes self-approval
   the single easiest way to get an unreviewed action into production.
2. **A platform admin has no read path to tenant automation content, run
   payloads, or credentials.** Support access, if it is ever needed, is a
   separate, time-boxed, logged, tenant-consented mechanism — not a role.

## 4. Core objects

| Object                      | Mutable?              | Notes                                                                                                        |
| --------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------ |
| **Workspace** (tenant)      | yes                   | The isolation boundary. Everything below belongs to exactly one.                                             |
| **Automation**              | yes (name, ownership) | A named, long-lived thing. Holds no behaviour itself.                                                        |
| **Spec version**            | **immutable**         | The behaviour. Content-addressed. Created by AI proposal, human edit, or import.                             |
| **Compilation**             | **immutable**         | The plan produced from one spec version by one compiler version.                                             |
| **Approval**                | **immutable**         | Who approved which spec version, when, with what diff in front of them.                                      |
| **Deployment**              | append-only           | Binds (automation, environment) → spec version. Rollback is a _new_ deployment pointing at an older version. |
| **Trigger**                 | yes                   | Schedule, webhook, or manual. Belongs to a deployment target, not to a version.                              |
| **Run**                     | append-only           | One execution. Has steps, timings, cost, outcome.                                                            |
| **Step attempt**            | append-only           | One try of one step. Retries create new attempts, never overwrite.                                           |
| **Connection** (credential) | yes (rotate)          | A secret held by the vault. Referenced, never inlined into a spec.                                           |

**Nothing that has ever executed is editable.** Editing an automation means
creating a new spec version and moving through the gates again.

## 5. The environment model

Three environments per workspace: **test**, **staging**, **production**.

- A spec version is promoted, never rebuilt. The bytes that ran in staging are
  the bytes that run in production.
- Credentials are **per-environment**. A test deployment cannot resolve a
  production connection. This is the mechanism that makes "dry run" honest.
- Only **production** may act on external systems with write capabilities that
  the workspace has explicitly granted. Test defaults to connectors' sandbox
  endpoints or recorded fixtures.

## 6. Explicit v1 scope

**In:**

- NL → spec proposal (single provider, ADR-0107)
- Spec IR, validator, compiler
- Human approval with a rendered diff
- Schedule and webhook triggers; manual run
- A small first-party connector set (deliberately small — see §7)
- Postgres-backed durable queue and worker pool (ADR-0103)
- Per-workspace isolated execution with hard resource, time, and egress bounds
- Run ledger, cost accounting, alerting on failure
- Versioning, promotion, rollback
- Credential vault with envelope encryption and a broker (ADR-0104)

**Out of v1, named so they are not smuggled in:**

- User-supplied code or expressions beyond the declared step vocabulary
- Arbitrary outbound HTTP ("HTTP request" step)
- Runtime agentic decision-making
- Marketplace / third-party connectors
- Billing and metered pricing (the _metering_ data is collected; charging is not built)
- Sub-workflows, fan-out/fan-in, and long-running human-in-the-loop steps
- Multi-region

## 7. Why the connector set starts small

Each connector is a **capability grant with a blast radius**. A connector that
can send email can send phishing; a connector that can write to a CRM can
destroy a customer record at machine speed. The v1 set should be chosen so that
every connector has (a) a sandbox or test mode, (b) idempotent write operations
or a natural idempotency key, and (c) a rate limit the platform can respect.

A connector without all three is not a v1 connector. **This is a product rule,
not an engineering preference**, because it decides what a bug can do.

## 8. Success criteria for the product (measurable, not aspirational)

These are the things Phase 1+ must be able to _measure_. They are stated as
metrics rather than adjectives on purpose (§58).

| Criterion              | Metric                                                           | Threshold to be set in Phase 1            |
| ---------------------- | ---------------------------------------------------------------- | ----------------------------------------- |
| Proposal usefulness    | % of AI proposals approved with ≤ N edits                        | baseline first, no target invented here   |
| Proposal safety        | % of AI proposals rejected by the validator                      | measured, expected non-zero and _healthy_ |
| Execution correctness  | % runs whose observed effects match the compiled plan            | measured against fixtures                 |
| Isolation              | 0 cross-workspace reads under adversarial test                   | **hard: must be zero**                    |
| Credential confinement | 0 plaintext secrets in logs, run records, or worker memory dumps | **hard: must be zero**                    |
| Recoverability         | time to roll back a bad deployment                               | measured                                  |
| Cost predictability    | per-run cost recorded for 100% of runs                           | **hard: 100%**                            |

Nothing in this table is claimed to hold today. All are **UNVERIFIED** — the
platform does not exist.

## 9. Relationship to the existing education product

Per ADR-0100, this is a **new product in the same repository**, reusing the
domain-neutral control plane. The education modules are untouched by Phase 0 and
their retirement is a separate decision. Two products sharing `packages/authz`,
`packages/kernel`, `packages/observability` and the platform layer is a
deliberate, bounded coupling; ADR-0100 records what would make it wrong.
