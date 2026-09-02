# Testing Strategy

**1,560 tests, all executed and passing** as of Task 010.

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

Task 012 added no new decision table either, and added one lesson about the
existing ones: its defect injection showed that the policy unit tests are what
catch a POLICY defect, because the HTTP suites pass while RLS covers for it —
and, symmetrically, that a defect in RLS is caught only by a test that observes
RLS alone. Two such tests were missing for the lesson's own status and have been
added (VULN-035). The rule that follows: when a control exists in two layers,
each layer needs a test that can fail while the other is correct.

Task 011 added no new decision table — the content table already covers the
lifecycle verbs — but added three suites over the existing ones:
`tests/integration/rls-content-lifecycle.test.ts` (the 0022 triggers, at the
database), `tests/security/content-lifecycle.test.ts` (the rules over HTTP),
`tests/security/content-concurrency.test.ts` (lost updates, capability hints and
direct HTTP that no interface would send) and
`tests/security/content-full-chain.test.ts`, which builds Course → Unit → Lesson
→ Objective → Activity → Assessment → Question entirely through the API,
publishes it, has a learner attempt it, and then disturbs the content to prove
no stored attempt, answer, evidence row, released result or mastery level moves.
That last one exists because every link has its own suite and none of them can
see the failure that matters: content edited _around_ a learner's history in a
way that changes what the history MEANS.

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

Task 010 added a fifth resource, `objective_progress`, with READ and LIST and
nothing else. Its unit table is short and its most interesting property is what
is absent: there is no write case to test, because the action vocabulary has no
word for asserting what a child understands. The mastery RULES are not there
either — they live in SQL, for the same reason the scorer does.

Task 009 added two more over the SAME resource: RELEASE and REVIEW. That makes
four tables for one object, which is the point rather than an accident — the
four give different answers for the same actor and the same attempt. A verified
guardian may read a result and may not release it; a learner may read their own
attempt and may not review it before release; a platform operator may release
but may not submit. Each of those disagreements is asserted explicitly, because
a single collapsed matrix would invite somebody to "simplify" them into
agreement and the looser answer is the one an attacker would find.

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

Task 009 NARROWED that last assertion rather than deleting it, which is the more
interesting half. `reviewedQuestionSchema` legitimately carries
`correctOptionIds`, so the rule now scans every response shape EXCEPT that one,
and adds two assertions to keep the exemption from becoming a hole: the review
schema must actually carry the field (an exemption for a shape that no longer
needs it is a gap), and `attemptQuestionSchema` — the paper handed out DURING an
attempt — is pinned separately, because a key there would be disclosed before
the learner has answered anything. A rule that had simply been dropped when it
started failing would have taken both of those with it.

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

`rls-assessment.test.ts` (Task 008, extended in Task 009) is the ONLY place the
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

Task 009 added the release and review boundaries to the same file, and three
defects surfaced there before any of the new code shipped:

- VULN-030 was caught by the UNCHANGED Task 008 scoring tests, which began
  failing the moment migration 0020 was applied. They exercise the real learner
  insert path rather than seeding attempts as superuser, and that is the only
  reason they saw it: an extracted RLS predicate that could not see its own row
  during `INSERT ... RETURNING`. A suite that seeded through the fixture would
  have stayed green against an application nobody could use.
- VULN-029 was caught by a new test written from the task's rule rather than
  from the code — "a review policy cannot be changed once papers have been sat"
  — which found the update accepted.
- VULN-031 was caught by the two layers disagreeing: an RLS test asserting a
  teacher may review before release returned zero rows while the unit decision
  table asserted `allow`. Neither suite alone would have noticed.

Seven separate defects were then injected into migration 0020 — learner
self-release, dropping either gate from the review function, letting a release
carry other column changes, trusting the caller's timestamp, ignoring the review
policy, and removing the configuration freeze — and every one was caught, by
between one and fourteen tests.

`rls-mastery.test.ts` (Task 010) owns the MASTERY RULES, for the same reason
`rls-assessment.test.ts` owns the scoring rule: they live in
`app_objective_mastery`, in SQL, so a TypeScript re-implementation would be a
second answer to "what does this child understand?" that could disagree about a
real learner. It enumerates all five states, the distinct-assessment rule, the
never-goes-down property, the absence of decay, and the withheld-result
interaction with Task 009 — plus the evidence table's central claim, that
`edu_app` cannot write it by any statement.

Eleven defects were injected into migration 0021 and every one was caught, but
TWO OF THEM ONLY AFTER THE SUITE WAS FIXED, which is the part worth recording:

- Removing the organization boundary from the read predicate passed all 64
  tests. There was no foreign-ADMIN in the world — only a foreign teacher — so
  an `admin` role held anywhere would have reached every child on the platform
  and nothing would have failed. Two tests were added.
- The "an objective cannot be moved to another lesson" test passed with the
  immutability trigger deleted, because the destination lesson already had an
  objective at position 1 and the UNIQUE constraint refused the move instead.
  The test proved nothing; it now moves into an empty lesson.

Neither was a defect in the migration. Both were defects in the tests, found
only because the injection was actually performed rather than assumed.

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

Task 009 added the release and review scenarios the brief names, each marked in
the test name: a learner releasing their own result, a learner releasing
another's, an unauthorized teacher, a teacher from another class (asserted in
BOTH directions, so a rule admitting everybody could not pass), a teacher from
another organization, a guardian, and a security administrator. Alongside them:
a parameter-tampering table sending a score, a percentage, a pass flag, a
learner id under two names, an organization, a class, a release timestamp and a
releaser — each expected to be REFUSED with a 400 rather than silently ignored,
which is the distinction `.strict()` exists to make. Three application-layer
defects were injected and all three were caught: letting the policy admit a
learner's own release, dropping the review release gate, and removing the
repository's SQL redaction of the withheld marks.

Task 010 added `mastery.test.ts` over the same HTTP stack: the learner flow end
to end, IDOR across learners, cross-class and cross-organization refusal in BOTH
directions, forged `learnerId`/`userId`/`organizationId`/`classId` query
parameters, forged objective ids, the three-ways-to-one-404 rule on the teacher
route, retention after enrolment ends, and the withheld-result interaction.

Six defects were injected at the application layer. Four were caught. The other
two are recorded rather than counted, and the reason is instructive: injecting a
handler that read `?learnerId=` instead of the session was STILL refused, because
RLS filtered the rows independently. The application bug was real and not
exploitable, which is the layered defence working — but it means this suite
cannot demonstrate that half alone. `layered-defense.test.ts` gained a mastery
block for exactly that, and the caveat is written into the file.

**The two gates are tested with the other removed.** This is the claim that
would be easiest to state and hardest to have earned, so it has a test on each
side: `tests/integration/rls-relationship-writes.test.ts` proves the database
refuses alone, and `tests/security/layered-defense.test.ts` runs the whole
application against a `BYPASSRLS` role and proves the policy engine refuses
alone. A boundary that appears only in one of them is a boundary with one gate —
that is how VULN-016 was found, and the fix is verified in the second file, not
the first.

### Web (component) — added in Task 011

`tests/web` renders the real `LessonEditor` in jsdom with `fetch` stubbed. It is
its own Vitest project so it can have a DOM environment without giving one to
the unit tests, and it runs in group 0 alongside `unit` and `architecture`
because it touches no database.

**What it is for.** The component's whole job is to render what the server said
and send back only what the contract allows. The interesting assertions are
therefore negative: it must not invent a permission the server did not grant,
must not assume a transition succeeded before the server confirmed it, must not
send a stale concurrency token or forget to send one, must not disclose the
difference between "no such lesson" and "not yours", and must distinguish the
five failure kinds an author can act on differently.

**What it is not for, stated so nobody mistakes it later.** It is not a security
control and proves nothing about what the server permits. `fetch` is stubbed —
the responses are whatever the test says they are. Every authorization claim in
Task 011 is proved in `tests/security` over real HTTP against a real database as
`edu_app`.

`fetch` is stubbed rather than the feature's own API module, deliberately: that
keeps the URL, method and JSON body inside the assertion surface, so a change to
the wire format fails here instead of passing because somebody updated the mock
to match it.

Task 012 added the learner views, and with them the sharpest assertion in the
project's component tests: **`LessonView` renders a DRAFT lesson if the server
sends one**, and a test asserts that it does. A component that hid it would hold
a second copy of the visibility rule and would mask a real server defect — the
server tests would fail while the interface looked correct. Hiding drafts is the
server's job, and `tests/security/learner-delivery.test.ts` proves it does it.

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
