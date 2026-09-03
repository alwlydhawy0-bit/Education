# J. Engineering Rules

**Phase 0 deliverable.** These are binding rules for the automation platform's
implementation phases. Most are not new — they are the disciplines this
repository already practises, written down so the transition to a second product
does not lose them (audit §8).

---

## 1. Rules about truth

**J1. Never claim a property without evidence.** The vocabulary is fixed:
**VERIFIED / PARTIALLY VERIFIED / UNVERIFIED / BLOCKED / OPEN RISK**. The words
_secure_, _production ready_, _scalable_, _fully tested_, _AI correct_,
_provider validated_ are not available as adjectives; they are conclusions that
require a named test and a run of it.

**J2. VERIFIED means the test fails when the control is removed**, demonstrated,
not assumed. A green suite proves the tests pass. Deleting the control and
watching the suite go red proves the tests _mean_ something.

**J3. Uncertainty is never converted into success.** Where a result cannot be
determined, it is `unresolved` / `BLOCKED`, and the report says so. Task 015
reported BLOCKED rather than fake a live provider call; that was the correct
outcome and it stays correct.

**J4. Report what actually happened**, including one's own mistakes. Spurious
failures from overlapping test runs, a defect that escaped, a dataset case that
was wrong — these go in the report. A report that only contains successes is not
a report.

**J5. Never delete a difficult test case to improve a metric.**

## 2. Rules about security

**J6. Two gates, independently testable.** Where a control matters, it exists in
two layers, and each layer has a test that can fail while the other is correct.
Policy engine **and** RLS. Sandbox bound **and** server deadline. This is the
single most valuable pattern in the repository.

**J7. Authority is never taken from the request.** Not from a body field, not
from a query parameter, not from a queue message, not from a run token's
payload. It is derived server-side from a stored row.

**J8. Deny by default, everywhere.** Egress, capabilities, config keys,
environment variables, schema fields (`.strict()`), database grants. A thing not
explicitly allowed is refused, and the refusal is the cheap path.

**J9. Secrets have a vocabulary of three words** — PRESENT, ABSENT, UNAVAILABLE.
No prefix, suffix, length, hash, or environment dump, in any log, report, test
output, error, or message.

**J10. Never use a credential belonging to the tooling or CI environment as an
application credential**, and never weaken configuration validation to make a
boot succeed. A missing credential is a BLOCKED result, not a problem to route
around.

**J11. Vendor error text is never read, logged, or returned.** Errors are
normalized to a closed kind set. Vendor messages echo requests.

**J12. Ambient environment is not configuration.** Every variable the
application reads is in the allow-list and the schema, and a test asserts the
two agree. Every process the platform spawns gets an explicit closed env map.

**J13. A migration that creates a tenant table creates its RLS policies in the
same file.** A table unprotected for one deploy is unprotected.

## 3. Rules about design

**J14. A guarantee stated as "this code never does X" is a structural claim and
needs a structural test.** Comments are not controls; architecture fitness tests
asserting on source are.

**J15. When one fact is written down twice, a test must assert the two agree.**
(The JSON schema written for the SDK and the Zod schema; `CONFIG_KEYS` and the
config schema; the plan's egress list and the connector declarations.)

**J16. When you pick a default for one property, write down what else it
decides.** VULN-039: choosing the `simple` text-search configuration was a
language decision that silently also decided "no stop words", which decided
"unanswerable questions look grounded".

**J17. An optional field on a trust boundary is a decision delegated to whoever
fills it in.** Make it required, or make the absent case explicit and tested.

**J18. Stub the transport, not the dependency.** A test that replaces the
adapter tests the test's idea of the adapter. A test that replaces `fetch`
exercises the real serialization, the real headers, and the real bytes.

**J19. Assert on what crosses the boundary**, not on the object handed to the
thing that crosses it. (T015-F7.)

**J20. A measurement tool needs its own tests.** The benchmark asserts on the
platform; the evaluator is asserted on by unit tests. (T016-F1.)

**J21. Prefer failing to guessing.** Reject, do not repair. A proposal that names
a non-existent connector is rejected with a finding, never quietly fixed into
something that looks like understanding.

**J22. Immutability where history matters.** Spec versions, compilations,
approvals, deployments, runs and attempts are append-only, enforced by database
grants rather than by discipline.

## 4. Rules about process

**J23. Defect injection is routine, not ceremonial.** Every substantial change
set ends with a round: inject real defects, run the full suite, and treat any
defect the suite misses as **the finding**. Write the missing test before
reverting.

**J24. Every vulnerability gets a log entry with root cause and a regression
test** — including entries whose root cause is "no defect existed, the test was
too weak." The existing log has 39 entries and continues.

**J25. Every architectural decision that closes an option gets an ADR**,
numbered from 0100 for this product, recording the alternatives and what would
make the decision wrong.

**J26. Inspect before building.** Probe the database, the SDK, the environment
empirically first. Several of this repository's worst bugs (VULN-038) were found
by probing, not by reading.

**J27. Run the test suite serially and exclusively.** globalSetup resets the
schema; overlapping runs produce hundreds of meaningless failures and have
already cost real time twice.

**J28. No new capability without its threat, its control, and its
disconfirming test** — the three columns of §C.2. A capability with two of the
three is not ready.

## 5. Code rules

- TypeScript strict, including `noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`, `verbatimModuleSyntax`. No `any`, no non-null
  assertion — narrow explicitly and throw.
- Zod `.strict()` on every external boundary: HTTP bodies, queue messages,
  connector responses, AI output, config.
- Hand-written SQL migrations, reviewed as security artifacts.
- Comments explain **why**, especially why a control exists and what it is
  protecting against. The existing codebase's comments are an asset; match their
  density and their honesty (including the ones that say "this is a belt, not the
  braces").
- No secret, no credential, no model identifier, and no environment value in a
  commit message, code comment, or any pushed artifact.

## 6. The rule behind the rules

Every rule above exists because something went wrong once, in this repository,
and was written down instead of being forgotten. The list is expected to grow
the same way. **A rule with no incident behind it is a preference; a rule with an
incident behind it is a control.**
