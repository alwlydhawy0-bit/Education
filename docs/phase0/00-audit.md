# Phase 0 — Repository & Environment Audit

**Audited 2026-09-03 against commit `b1243b8`. Working tree clean.**

Evidence-based. Every claim below was produced by inspecting the repository, not
by assuming its shape.

---

## 1. The headline finding

**This repository contains a production-grade EDUCATIONAL platform. The Phase 0
brief describes an AI AUTOMATION platform. They are different products.**

That is not a problem to be smoothed over — it is the single most important
input to every decision that follows, and it was confirmed before any design
work began.

**Decision taken (ADR-0100): reuse the foundation, build a new product.** The
domain-neutral control-plane layers are extracted and reused; the execution
plane is genuinely new; the fate of the education domain modules is a separate
product decision that Phase 0 does **not** pre-empt.

---

## 2. Stack

|                 |                                                                                                           |
| --------------- | --------------------------------------------------------------------------------------------------------- |
| Runtime         | Node 22.22.2, ESM, `--experimental-strip-types`                                                           |
| Language        | TypeScript 5.7, strict (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`) |
| Package manager | pnpm 10.33 workspace                                                                                      |
| Backend         | Fastify 5                                                                                                 |
| Frontend        | React 18 + Vite 7, no framework beyond that                                                               |
| Database        | PostgreSQL 16, `pg` driver, hand-written SQL migrations (23)                                              |
| Validation      | Zod 3 (`.strict()` throughout)                                                                            |
| AI              | `@anthropic-ai/sdk` 0.123, confined to `apps/api/src/platform/ai/`                                        |
| Auth            | Opaque server-side sessions, Argon2id (`@node-rs/argon2`)                                                 |
| Tests           | Vitest 5, six projects, 2,047 tests                                                                       |
| CI              | GitHub Actions — `ci.yml`, `codeql.yml`                                                                   |
| Deploy          | `vercel.json` builds the web client only. **No API deployment exists.**                                   |

---

## 3. What exists, classified for reuse

Line counts are source only.

### REUSABLE — domain-neutral, proven, keep

| Component                                  | Lines                                                        | Why it transfers                                                                                                                                                                                                  |
| ------------------------------------------ | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/authz` engine, decision, guarded | ~2,700 total                                                 | `decision.ts` and `guarded.ts` contain **zero** education references. `engine.ts` is a **registry**: the only coupling is a table mapping resource kinds to policy functions. Swap the table, keep the machinery. |
| `packages/kernel`                          | 188                                                          | Result, errors, clock, events. Nothing domain-specific.                                                                                                                                                           |
| `packages/observability`                   | 523                                                          | Structured logging with secret redaction, typed security events.                                                                                                                                                  |
| `apps/api/src/platform`                    | 2,207                                                        | Config (fail-fast, secret-bearing key list, public/private split), DB (`withActor` → RLS), HTTP (auth, CSRF, error envelope), security (rate limiting, security events), AI (provider abstraction + adapter).     |
| RLS patterns                               | 136 policies, 11 migrations using `FORCE ROW LEVEL SECURITY` | The dual-gate model — policy engine **and** RLS, each testable with the other removed — is the single most valuable asset here.                                                                                   |
| Test pyramid                               | 63 files / 2,047 tests                                       | unit 20, architecture 5, web 3, integration 12, security 21, evaluation 2.                                                                                                                                        |
| AI evaluation framework                    | `tools/eval/` + 38 tests                                     | Contract, gold dataset with hash, metrics, fixtures, evaluator, reporting. Domain-neutral except the corpus.                                                                                                      |

### EDUCATION-SPECIFIC — not reusable, fate deferred

`apps/api/src/modules` — 11,915 lines across assessment, curriculum, mastery,
progress, class-courses, assistant, relationships, notebook. Plus their
migrations, contracts, policies and ~1,400 tests.

**Phase 0 makes no decision about these.** Retiring them is a product decision
with real cost (23 migrations to unwind), and it is not required to begin.

### PARTIALLY REUSABLE

`packages/contracts` (1,969 lines) — the _patterns_ (strict schemas, `Guarded<T>`,
`emptyQuerySchema`) transfer; the education schemas do not.

---

## 4. What the automation platform needs and does NOT exist

Verified by search across `apps`, `packages`, `db`, `tools`:

| Capability                                  | Status     |
| ------------------------------------------- | ---------- |
| Workflow engine                             | **ABSENT** |
| Queue                                       | **ABSENT** |
| Worker pool                                 | **ABSENT** |
| Scheduler                                   | **ABSENT** |
| Execution sandbox / isolation               | **ABSENT** |
| Webhook ingress                             | **ABSENT** |
| Credential vault                            | **ABSENT** |
| Integration/connector framework             | **ABSENT** |
| Billing                                     | **ABSENT** |
| Redis / BullMQ / Temporal / Docker          | **ABSENT** |
| Automation spec IR, compiler, policy engine | **ABSENT** |

Incidental matches for "job", "quota", "integration", "isolate" are prose in
comments or unrelated identifiers (rate-limit quotas, `edu_app_norls` isolation
tests). **The entire execution plane is greenfield.**

---

## 5. Environment and secrets

Reported as `PRESENT` / `ABSENT` only, per §37. No value, length, prefix or
environment dump was read or printed.

| Variable            | Status                                                                          |
| ------------------- | ------------------------------------------------------------------------------- |
| `DATABASE_URL`      | PRESENT                                                                         |
| `AI_API_KEY`        | **ABSENT**                                                                      |
| `ANTHROPIC_API_KEY` | **ABSENT**                                                                      |
| `REDIS_URL`         | ABSENT                                                                          |
| `STRIPE_SECRET_KEY` | ABSENT                                                                          |
| `AWS_ACCESS_KEY_ID` | PRESENT _(ambient container credential, not an application secret — see below)_ |

**No application AI credential exists.** This is unchanged from Task 015 and it
means live model behaviour remains unverified.

`AWS_ACCESS_KEY_ID` being present is an **ambient container variable**, not
something this application reads. It is called out because Task 015's VULN-038
established exactly this hazard: ambient environment state silently influencing
application behaviour. The automation platform will run untrusted workloads, so
**ambient credential inheritance in the execution plane is a named threat**
(THREAT-EXEC-04 in the security spec).

---

## 6. CI gaps found

`.github/workflows/ci.yml` runs `unit`, `architecture`, `integration`,
`security`. It does **not** run:

- **`web`** — the component tests never execute in CI.
- **`evaluation`** — the AI benchmark added in Task 016 never executes in CI.

§49 of the brief requires AI Evaluation in the pipeline. **This is an existing,
unfixed gap** (OPEN-CI-01) and is not addressed in Phase 0 because Phase 0
builds nothing — it is recorded for the first implementation phase.

`codeql.yml` exists. There is no deployment stage, no migration-validation
stage, and no smoke test in CI.

---

## 7. Documentation assets

31 markdown documents including 9 ADRs, a threat model, a vulnerability log with
39 entries, a testing strategy and a limitations register. **The ADR numbering
continues at 0100 for automation-platform decisions** so the two products'
decision histories never collide.

---

## 8. Engineering culture, as evidenced

Worth recording because it is an asset and because Phase 0 should preserve it:

- **Defect injection is routine.** Seven rounds, 67 defects injected. Five
  escaped and each produced a permanent structural test.
- **Vulnerabilities are logged with root cause and a regression test**, 39
  entries, including "no defect existed, the test was too weak".
- **Uncertainty is not converted into success.** Task 015 reported `BLOCKED`
  rather than fake a live provider call; Task 016's evaluator reports
  `unresolved` rather than infer correctness from keywords.

These are exactly the disciplines §3, §35 and §58 demand. They already exist and
must not be lost in the transition.
