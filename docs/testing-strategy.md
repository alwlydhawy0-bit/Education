# Testing Strategy

**477 tests, all executed and passing** as of Task 003.

| Project        | Tests | Needs      | Proves                                                                                                                               |
| -------------- | ----- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `unit`         | 227   | nothing    | Policy decision table, `Guarded`, redaction, contracts, config, query validation, security-event recorder, rate-limit policies, i18n |
| `architecture` | 51    | nothing    | Dependency rules; every security event has an emitter; the app is runnable                                                           |
| `integration`  | 79    | PostgreSQL | Schema, constraints, RLS, query safety, and that the process actually boots                                                          |
| `security`     | 120   | PostgreSQL | IDOR/BOLA scenarios A–E, cross-organization isolation, layer isolation, session, CSRF, rate limiting, audit                          |

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

**Architecture** — the nine dependency rules, by scanning imports in source,
plus the rule that every declared security-event type has an emitter.

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
