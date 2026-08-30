# Testing Strategy

**208 tests, all executed and passing** as of Task 001.

| Project        | Tests | Needs      | Proves                                                               |
| -------------- | ----- | ---------- | -------------------------------------------------------------------- |
| `unit`         | 112   | nothing    | Policy decision table, `Guarded`, redaction, contracts, config, i18n |
| `architecture` | 16    | nothing    | The dependency rules hold                                            |
| `integration`  | 45    | PostgreSQL | Schema, constraints, RLS                                             |
| `security`     | 35    | PostgreSQL | IDOR/BOLA, layer isolation, session, CSRF, audit, rate limiting      |

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

**Architecture** — the seven dependency rules, by scanning imports in source.

**Integration** — RLS by attack (read/update/delete/forge by exact id, unfiltered
`SELECT *`, no actor set, pool-reuse leakage), privilege boundaries (`user_roles`
writes denied, `audit_log` reads denied), and 21 constraint tests asserting the
database refuses states that would break authorization invariants.

**Security** — end-to-end IDOR/BOLA, the existence-oracle test, mass assignment,
authentication requirements, immediate revocation, CSRF including a missing
Origin and a near-miss Origin, cookie flags, token-hash-only storage, login
enumeration resistance, security headers, audit trail contents, rate limiting,
and body size limits.

## Test data

Truncation between tests, not transactional rollback — the code under test
manages its own transactions, so wrapping it in an outer one would change its
behaviour. Deterministic UUID constants in unit tests make the decision table
readable.

## Gaps — see also [`limitations.md`](./security/limitations.md)

No E2E browser tests. No component render tests. No accessibility tests. No load
or performance tests. No mutation testing. No fuzzing. No coverage thresholds
(deliberate for now: coverage percentage is a poor proxy for whether the
_security-relevant_ paths are covered, and those are enumerated explicitly
above).
