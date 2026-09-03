# H. Testing Specification

**Phase 0 deliverable. No implementation.**
The strategy is not invented here — it is the one this repository already runs
(63 files, 2,047 tests, six Vitest projects) extended to a second plane.

---

## 1. Projects

Existing, reused:

| Project        | Order | What it may touch                        |
| -------------- | ----- | ---------------------------------------- |
| `unit`         | 1     | pure functions only, no DB, no network   |
| `architecture` | 1     | **source text**, not behaviour           |
| `web`          | 1     | jsdom components                         |
| `integration`  | 2     | real Postgres, real HTTP through the app |
| `security`     | 2     | real Postgres, adversarial               |
| `evaluation`   | 3     | AI benchmark                             |

New:

| Project     | Order | What it may touch                                                                      |
| ----------- | ----- | -------------------------------------------------------------------------------------- |
| `execution` | 2     | real Postgres + a worker process, real queue leasing, **stubbed connector transports** |

`execution` is a separate project rather than part of `integration` because it
is the only one that starts a second process, and because a worker test that
quietly runs in-process would test the opposite of what it claims (B1–B3 are
process-boundary claims).

**Operational constraint, already known:** globalSetup runs `db:migrate --reset`,
so overlapping runs corrupt each other. Runs are serial and exclusive. This has
already produced ~514 spurious failures twice during earlier tasks and it is
documented rather than rediscovered.

## 2. What each layer must prove

### Unit

The compiler is a **pure function** — same IR + compiler version → identical
`plan_hash`. The IR validator's every rejection rule. The reference grammar's
totality. The cron/timezone arithmetic including DST edges. The evaluator (a
measurement tool needs its own tests — T016-F1).

### Architecture (fitness functions, asserting on source)

The existing 5 files gain:

1. `apps/worker` does not import `platform/db`, any API module, or the vault's
   internals.
2. Connector runtime modules are importable only from the worker package.
3. `spec/compiler` imports `spec/ir` and nothing else.
4. Only the composition root constructs a provider or a connector client.
5. `CONFIG_KEYS` and the config schema describe the same key set (VULN-037's
   permanent test, extended to automation keys).
6. Every tenant table added by a migration has `FORCE ROW LEVEL SECURITY` and at
   least one policy.
7. No `process.env` read outside `platform/config`.

Each of these is a claim of the form "this code never does X". **A guarantee
stated as 'this code never does X' is a structural claim and needs a structural
test** — that sentence is the reason this project exists and it is why the rules
above are enumerated rather than trusted.

### Integration

Every route's happy path and every gate: propose → validate → approve → deploy →
run → roll back, over real HTTP against a real database. Idempotency keys.
Optimistic concurrency on spec edits. The 409 on a stale `diffHash`.

### Security (adversarial)

The suite that must exist before the platform is called anything:

| Family                | Assertion                                                                                                                                                                             |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cross-tenant          | Every route, every id, from a foreign workspace → 404/deny, **proved twice**: once with the policy engine disabled (RLS alone), once against the BYPASSRLS role (policy engine alone) |
| Separation of duty    | Author approving own version → deny, at both gates                                                                                                                                    |
| Queue message forgery | Forge every field of a leased message; resolved workspace and authority unchanged; run refused                                                                                        |
| Broker                | Credential request for a connection the plan does not reference → deny + security event                                                                                               |
| Run-token scope       | Token for run A against run B's plan/credentials/attempts → deny                                                                                                                      |
| Webhook               | Wrong signature, replayed delivery, stale timestamp, oversized body, disabled trigger → **zero runs**, indistinguishable responses                                                    |
| Secret leakage        | A planted secret must appear in **no** log line, run row, attempt record, error body, or API response. Asserted by scanning captured output, not by reading the code                  |
| AI wire privacy       | Assert on **bytes sent**, not on the request object (T015-F7)                                                                                                                         |
| Provider gate         | Every denied shape → **zero** provider calls (the existing `assistant-provider-gate` pattern, 12 tests, generalized)                                                                  |

### Execution

| Assertion                                                                                  | Removing which control breaks it |
| ------------------------------------------------------------------------------------------ | -------------------------------- |
| Worker's resolved env key set == the allow-list                                            | THREAT-EXEC-04                   |
| `DATABASE_URL` absent from the worker                                                      | B1                               |
| A run with no connector makes **zero** egress                                              | THREAT-EXEC-03                   |
| A run with connector X cannot reach host Y                                                 | THREAT-EXEC-03                   |
| Instance-metadata endpoint unreachable                                                     | THREAT-EXEC-04                   |
| Sandbox bound removed ⇒ **outer** deadline still terminates the run                        | THREAT-EXEC-02                   |
| Killed worker ⇒ lease expires ⇒ run re-leased ⇒ `at-most-once` step **not** re-executed    | ADR-0109                         |
| One workspace saturating the queue ⇒ another still progresses                              | THREAT-EXEC-05                   |
| Oversized / redirecting / compressed-bomb connector response ⇒ step fails, worker survives | THREAT-EXEC-06                   |

### Evaluation

Per §F.7. Reports metrics individually; no aggregate score; `unresolved` where
undecidable; the benchmark asserts on the platform and merely reports the
evaluator.

## 3. Defect injection — the practice, not the ritual

Seven rounds so far, 67 injected defects, 5 escapes, each escape producing a
permanent structural test. It continues, with the same rules:

1. Inject a **real** defect (delete a check, weaken a bound, widen a scope), run
   the full suite, record which tests fail.
2. **A defect that no test catches is the finding.** Write the missing test
   before reverting.
3. The new test must be **structural where the claim is structural** — a test
   that would pass again the moment someone reintroduces the defect in a
   slightly different place has not closed the class.
4. Escapes are logged with root cause, including "no defect existed, the test
   was too weak."

Mandatory injection set for the first execution-plane round (each maps to a
threat, so a miss is a named gap, not a vibe):

| #   | Injected defect                                                                   | Must be caught by       |
| --- | --------------------------------------------------------------------------------- | ----------------------- |
| 1   | Broker stops checking the step→connection reference                               | security                |
| 2   | Queue lease drops the per-workspace concurrency predicate                         | execution               |
| 3   | Compiler's egress allow-list widened to all connectors, not the plan's            | execution               |
| 4   | Worker spawn passes `process.env` through                                         | execution               |
| 5   | `at-most-once` step becomes retryable                                             | execution               |
| 6   | Approval no longer checks `diffHash`                                              | integration             |
| 7   | Approval no longer denies self-approval                                           | security                |
| 8   | RLS policy dropped from one new tenant table                                      | architecture + security |
| 9   | Webhook signature comparison becomes non-constant-time / becomes `==` on a prefix | security                |
| 10  | Connector error message passed through into the run record                        | security (leak scan)    |
| 11  | Run token's workspace derived from the request instead of `runId`                 | security                |
| 12  | Validator "repairs" an unknown connector instead of rejecting                     | unit + evaluation       |

## 4. Test data and determinism

- No live third-party calls in any project. Connectors are exercised against
  **stubbed transports** — stub the transport, not the dependency, so the code
  under test is the real code path including serialization.
- Clock is injected (`packages/kernel` already provides one). Schedule tests do
  not sleep.
- Fixtures are versioned and hashed, as the eval dataset already is.

## 5. CI

**Existing gap carried forward: OPEN-CI-01 — `.github/workflows/ci.yml` runs
`unit`, `architecture`, `integration`, `security`, but not `web` and not
`evaluation`.** §49 requires AI evaluation in the pipeline. Phase 0 builds
nothing, so this is recorded, not fixed; **it is the first item of the first
implementation phase.**

Target pipeline:

```
lint → typecheck → unit + architecture + web (parallel)
     → migrate --reset → integration → security → execution → evaluation   (serial)
     → secret scan → CodeQL
     → build artifacts
```

Serial after the migration step is a consequence of §1's reset behaviour, not a
preference. Making the suites parallel requires per-run schema isolation, which
is a real change with a real cost and is not assumed here.

## 6. What "tested" is allowed to mean

Per §58, and binding on every future report:

- **VERIFIED** — a test exists, it ran, it passes, and it **fails when the
  control is removed** (demonstrated, not assumed).
- **PARTIALLY VERIFIED** — tested under stubs or in one layer only; state which.
- **UNVERIFIED** — no test, or the test cannot fail.
- **BLOCKED** — cannot be tested in this environment; say why.
- **OPEN RISK** — known, unaddressed, logged.

A green suite is not evidence that a control works. **A red suite when the
control is deleted is.**
