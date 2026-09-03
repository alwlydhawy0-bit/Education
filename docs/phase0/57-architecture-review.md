# Phase 0 — Final Architecture Review (§57)

Twenty questions, answered before Phase 0 may be declared complete. Every risk
is classified **Resolved / Accepted / Deferred / Rejected**. Per §57, _any
unanswered question is an OPEN ARCHITECTURAL RISK_ — so none is left with a
gesture, and where the honest answer is "we do not know", it is classified
**Deferred** with the condition that closes it.

---

### 1. What exactly is being built, and what is explicitly not?

An AI **automation** platform: NL → spec → validate → compile → test → approve →
deploy → execute → monitor → version → rollback (§A.1). Explicitly not an agent
runtime, not a code-execution service, not a general integration bus, not a chat
product (§A.2). The v1 out-list is written down so it cannot be smuggled in
(§A.6).

**Resolved.**

### 2. Is this repository the right base, and what does reusing it cost?

Yes, per ADR-0100: the domain-neutral control plane (`authz`, `kernel`,
`observability`, `platform`, 136 RLS policies, a 2,047-test pyramid) is the
asset; the execution plane is greenfield anyway. Cost: two products share four
layers and one migration sequence.

**Resolved**, with three named tripwires in ADR-0100 ("what would make this
decision wrong") — the first being any `if (product === …)` appearing in a
shared layer.

### 3. Where is the trust boundary, and is it a real one?

Between the control plane and the execution plane, and it is a **process,
deployable and network boundary**, not a module boundary (ADR-0110). A boundary
you can cross with an import is not a boundary; every "the worker cannot…"
control is untestable in a shared process.

**Resolved** as a design. Its enforcement is **Deferred** to the substrate
choice (Q7).

### 4. What is the blast radius of a compromised worker?

By design: one run's plan, the credentials brokered for that run's steps, and
egress to that plan's allow-listed hosts. Not the database (B1), not other runs
(one isolate per run), not other tenants' credentials (broker checks the plan),
not the wider internet (ADR-0108).

**Accepted** as a design. **UNVERIFIED** in fact — every clause depends on
controls that do not exist yet.

### 5. How does a tenant read another tenant's data?

It should not, and the answer must be provable twice: policy engine alone
(tested against the BYPASSRLS role) and RLS alone (tested with the policy
engine's decision short-circuited) — ADR-0105, §H.2. Plus THREAT-TEN-02: run
authority derives from the deployment row, never from the queue message.

**Resolved** as a design, and it is the design element with the most existing
evidence behind it (136 policies, two database roles, an existing dual-gate
suite).

### 6. Can an AI-authored automation do something nobody approved?

No, by construction: the model emits a document, the validator can reject it, a
human approves a **rendered diff whose hash is recorded**, and rollback promotes
an already-approved version (ADR-0107, ADR-0106). Self-approval is denied at
both gates.

**Resolved** as a design. The residual risk — a human approving a diff they did
not read — is a product/UX problem, **Accepted** and named: the diff renderer is
a security surface, not a nicety.

### 7. What isolates a run?

Undecided. §I fixes seven requirements (I1–I7); ADR-0102 sketches four
candidates and rejects in-process V8 isolates outright.

**Deferred**, with conditions that make it a gate rather than a punt: no
isolation claim until I3/I4 are demonstrated by a test that fails when the
control is removed; I6 must be measured; **no write-capable connector ships
before the choice is made.**
(OPEN-EXEC-01, OPEN-INFRA-01)

### 8. What stops exfiltration?

Default-deny egress with a **per-plan** allow-list enforced below the
application, no off-list redirects, unreachable metadata endpoint, denial as a
security event (ADR-0108).

**Deferred** — the mechanism is decided, the enforcer depends on Q7.
(OPEN-EXEC-04)

### 9. How are third-party credentials protected?

Envelope encryption at rest (per-workspace DEK wrapped by a KMS master key) and
a **broker** at runtime: the worker presents `(runId, stepId, connectionRef)`
and receives a short-lived credential only if the compiled plan's step
references it; every release is a row (ADR-0104).

**Deferred on the root of trust** — there is no KMS in this environment
(OPEN-SEC-02). The broker design itself is **Resolved**.

### 10. What happens when a worker dies mid-run?

The lease expires, the run is re-leased, completed steps are skipped from the
append-only attempt ledger, and `at-most-once` steps are never re-executed
(ADR-0109). Delivery is at-least-once; exactly-once is not claimed because it
cannot be delivered across a network to a third party.

**Resolved**, and the acceptance test is written (§H: kill the worker, expire
the lease, assert the `at-most-once` step does not run twice).

### 11. Can one tenant starve another?

Per-workspace concurrency caps enforced **in the lease query**, because fairness
must apply where work is handed out, not where it is submitted (ADR-0103,
THREAT-EXEC-05).

**Resolved** as a design; **UNVERIFIED** — no queue exists.

### 12. Will the queue scale?

Postgres + `FOR UPDATE SKIP LOCKED`, expected ceiling on the order of hundreds
of leases/second on a single primary. **That is an estimate, not a
measurement.** Chosen for correctness, transactional enqueue, and one fewer
trusted store — not for throughput. `queue` is an interface so a broker can
replace it.

**Accepted**, with a detectable revisit trigger (measured lease rate, p99 lease
latency). (OPEN-EXEC-02)

### 13. Can the platform say what a given run actually did?

Yes: run → plan hash → compilation → spec version → approval → approver + diff
hash, plus per-step attempts, egress hosts contacted, credentials brokered (by
reference), and cost. Ledger tables are append-only **by database grant**, not
by convention (§D, ADR-0106).

**Resolved** as a design.

### 14. What data does the platform hold that it would regret holding?

Run payloads and connector responses (§D.5). Mitigations: digests by default
rather than bodies; payloads in a separate table with short, configurable, safe-
by-default retention; capture off unless the workspace enables it; never for
fields a connector declares secret.

**Resolved** by design choice; the retention default being the safe one is the
part that is cheap now and impossible later.

### 15. What does the AI see, and how is that verified?

Server-authored constant instructions, the user's own text in a separate typed
field, the public step vocabulary, and (when editing) a spec the actor may
already read. Never credentials, run data, or another tenant's anything (§F.4).
Verified by asserting on **the bytes sent on the wire**, not on the request
object — the T015-F7 lesson.

**Resolved** as a design; the live-provider half is **BLOCKED** — no application
credential exists (OPEN-SEC-03), unchanged since Task 015.

### 16. What is the prompt-injection story?

Layered, in order of real weight: the model cannot cause an effect; the approver
sees a diff; capability validation binds an approved spec to granted connectors
and declared hosts; typed field separation; and last, an instruction telling the
model to treat embedded text as data — documented as a belt, not the braces
(§F.6).

**Resolved** structurally. The adversarial corpus's assertion is "no injected
proposal reached deployment without human approval" — checkable — not "the model
resisted", which is not.

### 17. How is AI quality measured without fooling ourselves?

Individually reported metrics: proposal validity, capability faithfulness,
intent coverage, **over-reach**, refusal correctness, injection resilience. No
LLM-as-judge. No invented aggregate score. Undecidable cases are `unresolved`,
never `pass`. Difficult cases are never deleted. Thresholds move only on
recorded baseline evidence. The evaluator has its own unit tests (§F.7, the
T016-F1 lesson).

**Resolved** as a discipline; **UNVERIFIED** as an artifact — the automation
corpus does not exist.

### 18. What does the test suite have to prove before anything is called safe?

§H lists it per layer, and the standard is fixed by J2: **VERIFIED means the
test fails when the control is removed**, demonstrated. Twelve mandatory
execution-plane injection defects are enumerated in §H.3 so a miss is a named
gap rather than a feeling.

**Resolved** as a plan.

### 19. What is broken in the pipeline today?

`.github/workflows/ci.yml` runs `unit`, `architecture`, `integration`,
`security` — **not `web`, not `evaluation`**, despite §49 requiring AI
evaluation in the pipeline (OPEN-CI-01). There is also no API deploy stage
(OPEN-CI-02), no migration-validation stage (OPEN-CI-03), and no smoke test and
therefore no auto-rollback trigger (OPEN-CI-04).

**Deferred to Phase 1 by necessity** — Phase 0 builds nothing — and OPEN-CI-01
is designated **the first item of the first implementation phase**, because it
is a gap in a gate that already exists rather than a feature that does not.

### 20. What is the single most likely way this platform hurts someone?

A well-formed, approved automation that does exactly what its spec says, at
machine speed, to the wrong records — because the approver did not fully
understand a model-authored diff.

Nothing in this design prevents that. What it does is make it **visible and
reversible**: the diff is rendered and hashed, the approval names it, the run
records what it touched, rollback is one already-approved deployment away, and
the advisory validator findings (§G.2) exist precisely to put "this write is not
idempotent" and "this read is unbounded" in front of the person clicking
approve.

**Accepted, and named as the residual risk of the product.** The mitigation that
matters most is not technical: it is the small v1 connector set (§A.7), where
every connector must have a test mode, an idempotency story, and a respectable
rate limit before it ships.

---

## Risk register produced by this review

| ID                                                               | Classification                                  |
| ---------------------------------------------------------------- | ----------------------------------------------- |
| OPEN-SEC-01 / OPEN-EXEC-01 / OPEN-INFRA-01 — no sandbox chosen   | **Deferred**, gated (Q7)                        |
| OPEN-SEC-02 / OPEN-INFRA-02 — no KMS                             | **Deferred**, gated (Q9)                        |
| OPEN-SEC-03 — no AI credential; live behaviour unverifiable      | **Blocked** (Q15)                               |
| OPEN-SEC-04 / OPEN-EXEC-04 — egress enforcement has no enforcer  | **Deferred**, follows Q7                        |
| OPEN-EXEC-02 — queue ceiling estimated, not measured             | **Accepted**, revisit trigger defined (Q12)     |
| OPEN-EXEC-03 — connector rate-limit abstraction unproven         | **Deferred** until the first connectors exist   |
| OPEN-CI-01 — `web` and `evaluation` not in CI                    | **Deferred** to Phase 1, **first item** (Q19)   |
| OPEN-CI-02/03/04 — no deploy, migration or smoke stage           | **Deferred** to Phase 1 (Q19)                   |
| OPEN-DATA-01/02 — plan storage and run partitioning              | **Deferred**; deciding now would be speculation |
| OPEN-INFRA-03 — backup/restore untested                          | **Deferred**; nothing is deployed               |
| Residual: approved automation acting correctly on the wrong data | **Accepted**, named (Q20)                       |
| In-process V8 isolates as the sandbox                            | **Rejected** (ADR-0102)                         |
| Agentic runtime execution                                        | **Rejected** (ADR-0107)                         |
| Greenfield repository / delete education modules now             | **Rejected** (ADR-0100)                         |
| User code or general expressions in the IR                       | **Rejected** for v1 (ADR-0101)                  |
| Exactly-once execution semantics                                 | **Rejected** as unachievable (ADR-0109)         |
