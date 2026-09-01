# Testing Strategy

**1,288 tests, all executed and passing** as of Task 008.

| Project        | Tests | Needs      | Proves                                                                                                                                |
| -------------- | ----- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `unit`         | 550   | nothing    | Policy decision tables, `Guarded`, redaction, contracts, config, query validation, security-event recorder, rate-limit policies, i18n |
| `architecture` | 86    | nothing    | Dependency rules; every security event has an emitter; the app is runnable                                                            |
| `integration`  | 243   | PostgreSQL | Schema, constraints, RLS, query safety, and that the process actually boots                                                           |
| `security`     | 409   | PostgreSQL | IDOR/BOLA scenarios A–E, cross-organization isolation, layer isolation, session, CSRF, rate limiting, audit                           |

```bash
pnpm test                 # everything
pnpm test:unit            # fast; no database
pnpm test:security        # the security boundaries specifically
```

## Why the layers are separate projects

`security` is a **named project** so CI can gate on it specifically, and so that
nobody can quietly drop those tests by editing an unrelated `include` glob. A
green "tests passed" tick that conceals a skipped security suite is precisely the
failure this guards against.

## Principles

**Nothing is mocked in the security tests.** They drive real HTTP through the
real composition root, with real session cookies, against a real PostgreSQL
using the same non-superuser role production uses. A test that mocked the
authorization layer would prove nothing about it.

**Each gate is tested with the other removed.** This is the strategy's most
important idea. Both gates active means a passing suite cannot tell you _which_
one did the work:

- `integration/rls.test.ts` queries the database directly — no application code
  in the path.
- `security/layered-defense.test.ts` runs the whole application against a role
  holding `BYPASSRLS`, proving the application layer denies on its own. Its
  first test asserts the bypass role _really does_ bypass RLS — otherwise the
  entire file would pass vacuously.

**The harness refuses to run if it would prove nothing.** `tests/setup/global-db.ts`
aborts if the application role turns out to be a superuser or to hold
`BYPASSRLS`, since either makes the RLS suite meaningless while still green.

**Fixtures seed as superuser; assertions run as the application role.** Seeding
is not the thing under test, and it lets a fixture construct states the
application could never create (a verified guardian link, an admin role) — which
is exactly what the negative tests need. It also means production RLS policies
never get loosened for test convenience.

**Positive tests alongside negative ones.** A suite that only asserts denial
passes just as well when everything is broken. `idor.test.ts` includes a test
that the owner _can_ read, update and delete their own note.

## What each layer covers

**Unit** — the `notePolicy` decision table is enumerated exhaustively: owner,
stranger, assigned teacher, unassigned teacher, cross-org teacher, ended
assignment, verified guardian, pending guardian, every privileged role, an actor
holding _every_ role at once, suspended and unverified actors, and archived and
deleted states.

Task 004 added the roster decision table: the roster as a whole
(`class_membership:list`) versus one member's row (`:read`), including the two
degenerate forms — a list aimed at a single member, and a row-scoped action with
no member named — because that distinction is what VULN-013 turned on.

Task 005 added the content decision table, which is a product of four axes —
catalog, lifecycle, permission and verb — so the cases are enumerated as a
matrix across all four content kinds rather than written out per level. The
policy is one function registered four times; testing it four times is what
catches a level being wired to the wrong rule.

Task 006 added the assignment decision table, and reworked the content table
around the narrowing: most "a learner can read this" cases now need an
enrolled context rather than an empty one, which is itself the assertion.

Task 007 added the progress table, which is the first one where the read row and
the write row for the same actor and the same resource give different answers.
It is enumerated as two tables rather than one — `record` against every actor
including the platform operator, and `read`/`list` against every relationship —
because collapsing them into a single matrix is exactly the mistake the
asymmetry invites.

Task 008 added three: the activity table (content, with the duty split), the
attempt WRITE table, and the attempt READ table. Three rather than one for the
same reason, and because the activity rule and the attempt rule are different in
kind — one is about material, the other about a person.

What is NOT in the unit project, and deliberately: the scoring rule. It lives in
`app_score_attempt`, in SQL, granted to no role, precisely so the answer key
never enters application memory. A TypeScript scorer would be unit-testable and
would be a second implementation that could disagree with the one that actually
marks children's work, so the rule is enumerated against a real database instead
(below). The pure domain here holds only the payload validation and
`selectionLimitFor`, which is disclosure-relevant in its own right: it must
derive the number of selections from the question TYPE and never from the key.

**Architecture** — the ten dependency rules, by scanning imports in source, plus
the rule that every declared security-event type has an emitter.

Rule 10 (Task 008) is the odd one: it guards a single table rather than a
layer. `assessment_answer_keys` may appear in application code only in an
`INSERT`, `app_score_attempt` may not appear at all, and no response schema may
carry a field named for correctness. It earns its place because the property
cannot be re-established by review once lost — a `SELECT` that pulls correctness
into a repository is one careless spread from a response body. All four
assertions were verified to fail when the corresponding query or field was
actually reintroduced.

**Integration** — RLS by attack (read/update/delete/forge by exact id, unfiltered
`SELECT *`, no actor set, pool-reuse leakage), privilege boundaries (`user_roles`
writes denied, `audit_log` reads denied), and constraint tests asserting the
database refuses states that would break authorization invariants.

`rls-class-courses.test.ts` (Task 006) covers the narrowing and the assignment
edge: 27 checks over who may assign, cross-tenant refusal, the lifecycle, and
instant revocation on all three triggers. Three of them FORCE rows the database
normally refuses — by disabling the scope trigger for the insert — because a
read-path defence that is only ever reached through a write-path trigger has
not actually been tested.

`rls-assessment.test.ts` (Task 008) is 58 checks and is the ONLY place the
scoring rule is tested, for the reason given above: an entirely correct paper, a
blank one, a partly-correct multiple-choice answer (no partial credit), a
correct set plus one wrong option, order-independence, and a pass exactly AT the
threshold rather than above it. It also asserts the answer key is invisible to a
learner with arbitrary SQL — including through a join and a per-question count,
so even the SIZE of a key is not disclosed — that the scorer is
permission-denied to the application role, that a forged score is overwritten on
both INSERT and UPDATE, and that each of the five score CHECK constraints fires
with the sanitising trigger disabled.

Two of its assertions use a `changedRows` helper rather than a thrown error, and
the distinction is worth stating: an RLS `USING` clause does not raise, it makes
the row invisible, so the statement matches ZERO rows and SUCCEEDS. A suite that
treated "no error" as "allowed" would report a blocked write as an allowed one.
That was found by these tests failing against a database behaving correctly.

`rls-progress.test.ts` (Task 007) is 29 checks over the read/write asymmetry as
`edu_app`: the owner writing and every third party failing to, the four reader
relationships, the forward-only trigger, the immutability of `completed_at` and
of both parties, the absence of any DELETE grant, and — the one that matters for
retention — a learner reading their own labelled history after their class
membership has ended.

`rls-content.test.ts` (Task 005) does the same for the content tree: 32 checks
covering draft and archived visibility, the whole-chain published rule, the
global-versus-organization split, the author/publisher duty split, and the
lifecycle and ordering invariants — all as `edu_app`, with no application code
in the path.

`rls-relationship-writes.test.ts` (Task 004) is the write-side counterpart: 18
statements run as `edu_app` with no application code in the path, asserting the
database refuses a teacher self-assigning, a student self-enrolling, a school
administrator creating an organization or reaching into another one, a class
moving tenant, a relationship's parties being re-pointed, and an ended
membership being reinstated.

**Security** — end-to-end IDOR/BOLA, the existence-oracle test, mass assignment,
authentication requirements, immediate revocation, CSRF including a missing
Origin and a near-miss Origin, cookie flags, token-hash-only storage, login
enumeration resistance, security headers, audit trail contents, rate limiting,
and body size limits. Task 004 added 47 cases over the relationship and class
management surface, written from the scenarios the brief names by hand rather
than from the implementation.

Task 005 added 70 more: `curriculum.test.ts` for the scenarios the brief names,
and `curriculum-adversarial.test.ts` for the ones it does not — re-filing a
course to escape its scope, crossing a parent-child relationship, reaching the
lifecycle through a PATCH body, and bounds that turn out to be unreachable.
Both defects that suite found are recorded in the vulnerability log.

Task 006 added 61 more across `class-courses.test.ts` and the layered-defence
suite, including the four revocation paths asserted on the SAME live session —
a revocation that takes effect at next login is not a revocation.

Task 007 added 47 more: `progress.test.ts` for the write asymmetry and the four
read relationships driven over HTTP, plus a `learner progress, with RLS
disabled` block in the layered-defence suite. Each test in that suite was
verified to fail with the corresponding check removed, and one of them was NOT:
coarsening the teacher rule from "shares this class" to "teaches any class"
leaves layered-defence green, because the repository's SQL scoping fires before
the policy. That is recorded in a comment in the file rather than presented as
coverage the suite does not have.

Task 008 added 66 more: `assessment.test.ts`, in which each of the fifteen
scenarios the task names is marked A to O in the test NAME so the report's
matrix traces back to a test that ran rather than to a claim; plus an
`assessments, with RLS disabled` block. Two further branches were verified by
injection to be invisible to the layered-defence suite and are recorded in a
comment there rather than counted: deleting the attempt policy's ownership check
leaves it green (the SQL-computed `learnerMayAttempt` already encodes ownership,
and the branch fails eight UNIT cases instead), and coarsening the teacher rule
does the same. A redundant gate makes its neighbour hard to observe, which is
worth knowing when reading a green suite.

**The two gates are tested with the other removed.** This is the claim that
would be easiest to state and hardest to have earned, so it has a test on each
side: `tests/integration/rls-relationship-writes.test.ts` proves the database
refuses alone, and `tests/security/layered-defense.test.ts` runs the whole
application against a `BYPASSRLS` role and proves the policy engine refuses
alone. A boundary that appears only in one of them is a boundary with one gate —
that is how VULN-016 was found, and the fix is verified in the second file, not
the first.

## Test data

Truncation between tests, not transactional rollback — the code under test
manages its own transactions, so wrapping it in an outer one would change its
behaviour. Deterministic UUID constants in unit tests make the decision table
readable.

## The boot smoke test

Every other test builds the app in-process via `buildApp`. That is fast and
precise, but it never exercises `main.ts`, never resolves modules the way Node
does at runtime, and never binds a socket.

Task 001 shipped an API that could not start (VULN-004) and all 208 tests of the
day passed
anyway, because Vitest resolved its imports through a plugin the real runtime
does not have. `tests/integration/boot.test.ts` spawns the server as a real
process and asserts it binds, serves `/health`, enforces authentication, and
refuses to start without `DATABASE_URL`.

**A green suite is evidence about the harness as much as about the system.** That
test, and architecture rule 9, exist to keep the two honest about each other. Both
were verified to fail when the original defect was reintroduced.

## Gaps — see also [`limitations.md`](./security/limitations.md)

No E2E browser tests. No component render tests. No accessibility tests. No load
or performance tests. No mutation testing. No fuzzing. No coverage thresholds
(deliberate for now: coverage percentage is a poor proxy for whether the
_security-relevant_ paths are covered, and those are enumerated explicitly
above).
