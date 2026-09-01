# Education Platform — Engineering Foundation

An Arabic-first educational platform for students from primary school through
university, built around practical, evidence-based learning.

> **Task 001 status: foundation only.** No product features are implemented, by
> design. What exists is the architecture, the security boundaries, and
> executable evidence that they hold. See
> [`docs/architecture/architecture-report.md`](docs/architecture/architecture-report.md).
>
> **This system is not proven secure.** 477 tests pass, which establishes that
> specific enumerated properties held at a point in time. Read
> [`docs/security/limitations.md`](docs/security/limitations.md) for what was
> **not** tested.

## Quick start

Requires Node 22.12+ (vite 7 needs it), pnpm 10+, PostgreSQL 16+.

```bash
pnpm install

# One-time: create roles (as a superuser) and the database.
read -rsp 'app password: '      APP_PW      && export APP_PW
read -rsp 'migrator password: ' MIGRATOR_PW && export MIGRATOR_PW

psql -v app_password="'$APP_PW'" -v migrator_password="'$MIGRATOR_PW'" -f db/bootstrap.sql

# `-O edu_migrator` is not cosmetic. The migration role must OWN the database,
# or `GRANT USAGE ON SCHEMA public TO edu_app` in migration 0001 cannot take
# effect — PostgreSQL emits a WARNING, not an error, so the migration reports
# success and the API then fails on every query with "relation does not exist".
createdb -O edu_migrator edu_dev

# The migration runner reads DATABASE_URL. Supply the MIGRATOR url inline here;
# the .env file keeps DATABASE_URL pointed at the application role.
DATABASE_URL="postgres://edu_migrator:$MIGRATOR_PW@127.0.0.1:5432/edu_dev" pnpm db:migrate

cp .env.example .env      # then set DATABASE_URL to the edu_app credentials
pnpm --filter @edu/api dev   # http://127.0.0.1:3000 — loads ../../.env
pnpm --filter @edu/web dev   # http://localhost:5173 — proxies /api to the API
```

Open <http://localhost:5173>. The dev server proxies `/api` to the API, so both
sides share one origin and the session cookie works without CORS.

The application connects as `edu_app` (non-superuser, `NOBYPASSRLS`). Connecting
as a superuser or as the migrator **disables Row-Level Security** and removes a
whole security layer.

Only `pnpm --filter @edu/api dev` loads `.env` (via Node's
`--env-file-if-exists`). The `start` script deliberately does not: in a deployed
environment configuration comes from the environment, and a missing value should
fail loudly rather than be filled in from a stray file.

## Verification

```bash
pnpm verify              # format + lint + typecheck + all tests
pnpm test:security       # the security boundaries specifically
pnpm security:secrets    # secret scan
pnpm security:deps       # lockfile, install-script and advisory checks
```

Integration and security tests need a test database:

```bash
PGPASSWORD=<superuser-pw> tools/ci/setup-test-db.sh
```

## Layout

```
apps/
  api/        Fastify modular monolith
    platform/ infrastructure: config, db, http, audit, crypto
    modules/  identity · relationships · notebook
  web/        React + Vite. Arabic-first, RTL by default
packages/
  kernel        Result, errors, clock, event bus      (pure)
  authz         policy engine, Guarded<T>             (pure, no I/O)
  contracts     Zod schemas shared client/server      (pure)
  observability redacting logger, security events     (pure)
db/
  bootstrap.sql roles (run once, as superuser)
  migrations/   immutable, checksum-verified SQL
tests/
  unit · architecture · integration · security
tools/
  security/     secret scan, dependency checks
  ci/           test-database provisioning
```

## The security model in one page

**Two independent authorization gates, both required.** The policy engine in
`packages/authz` (pure, exhaustively unit-tested) and PostgreSQL Row-Level
Security. Each is tested _with the other removed_, so neither can be silently
carrying the other.

**IDOR is structural, not conventional.** Repositories return `Guarded<T>`;
reading the payload requires an allow-decision, and `unwrap` re-verifies that the
decision was made for that exact resource id and action. Authorizing one object
and returning another — the actual shape of an IDOR bug — throws.

**Denials hide existence.** 404, not 403, wherever the actor may not learn the
object exists. A test asserts a forbidden note and a nonexistent one are
indistinguishable.

**Privilege escalation is blocked at the database.** The application role has no
write privilege on `user_roles` whatsoever.

**Roles carry a scope, and teacher–student is derived.** "Teacher" means
teacher _of this class_; the relationship holds only while the assignment, the
class and the membership are all active, so ending any one revokes access
immediately. Privilege containment means nobody can change their own roles and
only a security administrator can grant privileged ones.

**The architecture is enforced by tests**, not by convention — 51 fitness
assertions covering the dependency rules, the runnability of the application, and
the honesty of the security-event taxonomy (every declared event must have a real
emitter).

**Configuration is fail-fast and split PUBLIC/PRIVATE.** The server refuses to
start in production _or staging_ with insecure cookies, plaintext origins, rate
limiting off, or debug logging. Nothing server-only can reach the client bundle —
checked against the built artifact, not just asserted.

## Documentation

| Document                                                        | What it covers                                                      |
| --------------------------------------------------------------- | ------------------------------------------------------------------- |
| [Architecture report](docs/architecture/architecture-report.md) | The full §29 report — current state, decisions, risks, sequence     |
| [Domain boundaries](docs/architecture/domain-boundaries.md)     | Who owns what data                                                  |
| [Dependency rules](docs/architecture/dependency-rules.md)       | What may import what, and why                                       |
| [ADRs](docs/architecture/adr/)                                  | Seven decisions with their trade-offs                               |
| [Threat model](docs/security/threat-model.md)                   | Assets, actors, threats, risk register                              |
| [Authorization](docs/security/authorization.md)                 | The IDOR/BOLA strategy and decision table                           |
| [File security](docs/security/file-security.md)                 | **Designed, not implemented**                                       |
| [AI security](docs/security/ai-security.md)                     | **Designed, not implemented**                                       |
| [Observability](docs/security/observability.md)                 | Logging, redaction, audit                                           |
| [Vulnerability log](docs/security/vulnerability-log.md)         | Eleven defects found and fixed, with root cause and regression test |
| [Limitations](docs/security/limitations.md)                     | **What was not tested and remains unknown**                         |
| [Testing strategy](docs/testing-strategy.md)                    | The four layers and what each proves                                |
| [CI/CD](docs/cicd.md)                                           | Pipeline and security gates                                         |

## Contributing

Before adding a feature, answer the nine questions in §24 of the brief — most
importantly: which domain owns it, can it be tested and disabled independently,
and what regression tests protect existing behaviour.

When you fix a security defect: fix it, add a regression test that fails without
the fix, and record the root cause and boundary in the
[vulnerability log](docs/security/vulnerability-log.md). Mandatory for anything
touching authorization.
