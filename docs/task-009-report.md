# Task 009 — Interactive labs and the practical experiments sandbox

**Status: COMPLETE for the server. The browser-side simulators do not exist and
were not built.** That boundary is stated first because it is the one thing a
reader could mistake: every rule below is enforced and tested, and there is no
UI through which a child can draw a circuit yet.

Vocabulary: **VERIFIED** — measured here. **PARTIALLY VERIFIED** — measured in
one layer only. **UNVERIFIED** — not measured. **OPEN RISK** — known and
accepted.

## What was built

| Layer         | File                                                     |
| ------------- | -------------------------------------------------------- |
| Schema        | `db/migrations/0024_experiments_and_lab_sessions.sql`     |
| Authorization | `packages/authz/src/policies/experiment-session.policy.ts` |
| Contract      | `packages/contracts/src/experiment.contract.ts`           |
| API           | `apps/api/src/modules/experiment/`                        |
| Docs          | `docs/api/experiments.md`                                 |

Four tables — `experiments`, `experiment_validation_rules`,
`experiment_sessions`, `experiment_artifacts` — one policy, one contract, ten
routes. The full design rationale is in `docs/api/experiments.md`; this document
is the evidence.

## The three decisions that shaped everything

1. **A lab hangs off a `learning_activity`.** It inherits the whole
   authorization graph and the draft/published lifecycle rather than copying
   either. There is no `experiment` resource kind and no publish route, for the
   reason 0019 gives for having no `assessment` one: a lab has no lifecycle of
   its own, and two rules for one object can disagree.
2. **The validation rules live in their own table.** RLS is row-level, and a
   learner and an author are both `edu_app`, so a column on `experiments` could
   not be hidden from one and shown to the other. This mirrors
   `assessment_answer_keys` exactly.
3. **The rule language has no evaluator.** A flat list of comparisons over
   bounded dot-paths. Nothing to parse, no recursion, no function call, and
   therefore nothing to escape from.

## Requirements

| Requirement                                       | Status   | Evidence                                                                                          |
| ------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------- |
| Server-side validation; never trust the client    | VERIFIED | Submit trigger overwrites `passed` and `status`; RLS + HTTP cases; F3 injection                    |
| Payload sanitization and size limits              | VERIFIED | Three ordered limits + depth and node bounds; five HTTP cases; F10 injection                       |
| Instant state isolation                           | VERIFIED | RLS `UPDATE` policy re-asks on every write; six cases across two suites; F4 injection              |
| The answer key never reaches a learner            | VERIFIED | Separate table, separate RLS policy, separate response shape; F5, F9 injections                    |
| Only the learner may work their own session       | VERIFIED | Policy denies teacher, guardian, admin and operator; unit + HTTP; F6 injection                     |
| One live session per learner per lab              | VERIFIED | Partial unique index; start resumes rather than failing                                            |
| Artifacts are append-only                         | VERIFIED | No `UPDATE`/`DELETE` grant; no route; F11, F12 injections                                          |
| A published lab is frozen                         | VERIFIED | Policy, RLS and trigger; four cases                                                                |
| Teacher and guardian reporting views              | VERIFIED | Class-scoped and child-scoped listings, both with their own denial cases                           |
| Retention after a learner leaves a class          | VERIFIED | `app_experiment_label` is a definer helper, not a join; F8 injection                               |
| Browser-side simulators                           | **NOT BUILT** | Out of scope for this task and stated as such                                                 |

## Defect injection — round 8

Twelve defects, each applied to the working tree, run against the suite that
should catch it, and reverted.

| #   | Defect                                                        | Caught by                            |
| --- | ------------------------------------------------------------- | ------------------------------------ |
| F1  | `app_actor_sees_experiment` made `SECURITY DEFINER`           | architecture (structural only)       |
| F2  | the marker's `REVOKE ... FROM PUBLIC` removed                 | integration + architecture           |
| F3  | submit trigger trusts a client-supplied `passed`              | integration                          |
| F4  | `may_study` dropped from the session `UPDATE` policy          | integration — **after a new test**   |
| F5  | a learner branch opened on the answer key                     | integration + security               |
| F6  | policy lets a teacher write into a learner's session          | unit (3 cases)                       |
| F7  | the save contract stops rejecting unknown fields              | security                             |
| F8  | the session query joins the content tree for its breadcrumb   | security (4 cases)                   |
| F9  | the lab read always uses the authoring response shape         | security                             |
| F10 | the payload depth bound raised past anything reachable        | security                             |
| F11 | appending an artifact authorized as `:read` rather than `:save` | security — **after two new tests** |
| F12 | `DELETE` granted on `experiment_artifacts`                    | architecture                         |

**Two escaped, and both were worth more than the ten that did not.**

- **F4** passed because for a LEARNER both conjuncts of the session update
  policy move together: leaving the class fails `app_actor_sees_experiment` and
  `app_actor_may_study_lesson` alike. They part for a TEACHER, who reaches the
  course by teaching it. A new case gives a teacher their own session and proves
  they still cannot work through it — a clause no test can remove is a clause
  nobody is checking.
- **F11** passed because no test appended to a FINISHED session, or appended as
  somebody who may read it but not write it. Two new cases cover both. Fixing it
  also surfaced a real weakness: an artifact insert refused by RLS raised a
  502-shaped internal error rather than the 404 the equivalent session write
  produces. The repository now maps SQLSTATE `42501` to the same non-fault
  error, so a policy loosened in future degrades to a refusal rather than to a
  crash.

**F1's only catch is structural, and that is the honest result.**
`experiments_select` no longer routes through the wrapper — it calls
`app_actor_sees_activity` directly — so restoring the definer flag breaks no
behaviour today. The architecture assertion is what still catches it, and that is
precisely the case for having structural tests at all.

**F3 is caught at the database and not over HTTP**, by design: `.strict()`
rejects a forged `passed` with a 400 before the trigger that would have
discarded it is ever reached. Both layers are real; each has its own test.

## Defects found and fixed during the task

Four, recorded in full as VULN-040 to VULN-043 in
`docs/security/vulnerability-log.md`.

| ID       | Defect                                                                | Severity                    | Found by                |
| -------- | --------------------------------------------------------------------- | --------------------------- | ----------------------- |
| —        | trigger guard resolved a field on a branch it did not take            | functional break            | the pre-code SQL probe  |
| VULN-040 | a definer wrapper turned a visibility check into an unconditional true | HIGH — cross-school reads   | the RLS probe           |
| VULN-041 | `EXECUTE` defaults to `PUBLIC`, so the marker was an answer-key oracle | HIGH — assessment integrity | the RLS probe           |
| VULN-042 | policies that could not see the row they were deciding about (×2)     | functional break            | the HTTP suite          |
| VULN-043 | a payload limit set equal to the transport limit, so it never fired   | LOW                         | the HTTP suite          |

**VULN-042 is VULN-030 again**, three tasks later, in a different table. Its own
entry recorded the lesson — tests that "exercise the real insert path rather
than seeding as superuser" are what catch this class — and the new RLS suite did
not have that property, because seeding as superuser is what makes fixtures
convenient. Four cases now author a lab as `edu_app`.

## Verification

Measured on this branch, serially, against a real PostgreSQL 16.

| Gate                    | Result                            |
| ----------------------- | --------------------------------- |
| `pnpm typecheck`        | clean                             |
| `pnpm lint`             | clean                             |
| unit                    | 50 new, in a read table and a write table |
| architecture            | 12 new fitness functions          |
| integration (RLS)       | 37 new                            |
| security (HTTP)         | 51 new, grouped A–J               |
| Live boot               | API boots against a real database; all ten routes registered and refusing anonymous callers with 401 |

Full totals are in the commit that closes the task.

## Open risks

- **RISK-LAB-01 — a lab has no attempt limit.** Deliberate: "keep adjusting it
  until the circuit works" is the pedagogy. The consequence is that
  `lab.session_start`'s rate limit is the only bound on session creation. It
  protects cost, not the rules — a submission answers "not yet", never "the
  voltage must be 5" — so a grinder learns one bit per attempt about a lab it
  was already entitled to attempt. **Accepted.**
- **RISK-LAB-02 — the rules are visible to teachers.** The `teacher` role holds
  `content:author` in the 0007 seed, so a teacher is an author here and the
  rules policy admits them. This is exactly how `assessment_answer_keys` already
  behaves, and a lab that hid its rules from teachers while the quiz beside it
  showed its answer key would be the inconsistency. **Accepted; noted because it
  looks like an oversight and is not.**
- **RISK-LAB-03 — `checkStatePayload` bounds shape, not meaning.** The server
  has no opinion about what a valid circuit is, deliberately. A learner can save
  20 000 nodes of nonsense within every limit. It costs storage and nothing else.
  **Accepted.**
- **RISK-LAB-04 — no browser-side simulator exists.** Every endpoint here works
  and nothing renders a circuit. **Stated, not accepted as done.**

## What a reviewer should check first

1. `experiment_session_submit_guard` in the migration — the whole
   "never trust the client" claim is those fifteen lines.
2. The `REVOKE ... FROM PUBLIC` block, and the architecture test asserting every
   function has one. That default is the trap that caught this task.
3. `tests/unit/experiment-policy.test.ts`'s write table — every branch that
   denies an adult writing a child's work.
