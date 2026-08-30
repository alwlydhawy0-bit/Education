# CI/CD & Security Pipeline

## Workflows

### `ci.yml` — three jobs, deliberately separated

**`static`** — install with `--frozen-lockfile`, format check, lint, typecheck,
unit tests, architecture fitness tests. Under a minute; catches most mistakes.

**`supply-chain`** — secret scan and dependency audit. Its own job so its result
is legible at a glance rather than buried in a general "tests" tick.

**`database`** — spins up a real PostgreSQL 16 service, provisions roles and
schema via `tools/ci/setup-test-db.sh`, then runs the `integration` and
`security` suites as **separate steps**, so the checks list shows explicitly
whether the security boundaries passed.

### `codeql.yml` — SAST

`security-extended` queries on push, pull request, and a weekly schedule. The
schedule matters: on a mature codebase most findings come from newly published
queries running against unchanged code, not from new commits.

## Security gates, and what each is for

| Gate                     | Fails the build on                        | Tool                             |
| ------------------------ | ----------------------------------------- | -------------------------------- |
| Lockfile integrity       | any resolution drift                      | `pnpm install --frozen-lockfile` |
| Install-script execution | a missing `enable-pre-post-scripts=false` | `check-deps.ts`                  |
| Dependency advisories    | any high or critical                      | `pnpm audit`                     |
| Secrets                  | any match without a documented exemption  | `scan-secrets.ts`                |
| Architecture             | any dependency-rule violation             | `vitest --project architecture`  |
| Authorization            | any IDOR/BOLA/session/CSRF regression     | `vitest --project security`      |
| SAST                     | CodeQL security-extended findings         | CodeQL                           |

## Design notes

**Least privilege.** `permissions: contents: read` by default; only the CodeQL
job requests `security-events: write`.

**A gate that cannot run must fail, not pass.** `check-deps.ts` treats an
unreachable registry as **UNKNOWN and fails** rather than reporting clean. A
security gate that silently no-ops when the network is down is worse than no
gate, because it is trusted.

**Exemptions are explicit and must carry a reason.** The secret scanner honours a
`secret-scan-allow` marker on a line; every current use names why (test fixture,
local dev default, a string deliberately asserted to be _absent_ from the audit
log).

**The audit gate has already earned its place.** On first run it found a high
advisory in `vite` and a critical one in `vitest`. Both were fixed by upgrading —
not exempted. The Vitest 4 upgrade then silently changed pool options, making the
database suites flaky; that was caught and fixed too (`fileParallelism: false`
plus per-project `sequence.groupOrder`, since the suites share one database).

## Verification status

**Verified:** `tools/ci/setup-test-db.sh` was executed locally and the full
208-test suite passes against the database it provisions. The workflow YAML is
syntactically valid and formatted.

**Not verified:** no GitHub-hosted run has ever executed. CodeQL has never
analysed this code. The first push will be the first real test of these
workflows.

## Not built

No CD. No deployment pipeline, environments, migration-on-deploy strategy,
rollback procedure, smoke tests, blue/green or canary, secrets manager
integration, or container build. Deployment is a separate task.
