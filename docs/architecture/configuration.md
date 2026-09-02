# Configuration & Environments

## The rule

Application code never reads `process.env`. Everything goes through
`loadConfig()`, which parses once at startup and **refuses to start** on anything
missing or malformed. The architecture fitness tests enforce the rule for the
frontend; on the server, `loadConfig` is the only reader of the environment.

```
environment variables → validated configuration → application
```

Failing fast matters more than it looks. The alternative is a server that boots
happily with `SESSION_COOKIE_SECURE=undefined` and serves session cookies over
plaintext for a week before anyone notices.

## Environments

| Environment   | Purpose          | Safety rules                                          |
| ------------- | ---------------- | ----------------------------------------------------- |
| `development` | Local work       | Relaxed. Plaintext cookies and origins permitted.     |
| `test`        | Automated suites | Relaxed. Rate limiting may be disabled for isolation. |
| `staging`     | Pre-production   | **Hardened — identical to production.**               |
| `production`  | Live             | **Hardened.**                                         |

`staging` is hardened deliberately. It holds real-shaped data, is reachable over
the network, and is exactly where "we'll tighten it before launch" goes to die.
Every refine in `config.ts` tests `isHardened(...)`, not `=== 'production'`, so
adding an environment cannot silently open a hole.

In a hardened environment the process **refuses to start** if:

- `SESSION_COOKIE_SECURE` is false — cookies would travel in plaintext;
- `RATE_LIMIT_ENABLED` is false — no operational escape hatch for this;
- any `ALLOWED_ORIGINS` entry is not `https://`, or the list is empty;
- `LOG_LEVEL` is `debug` — debug volume retains request-shaped detail far longer
  than intended.

## PUBLIC vs PRIVATE

**Everything is PRIVATE by default.** A value becomes public only by being added
to `toPublicConfig()`, which is a hand-written allow-list.

### Server (`apps/api/src/platform/config.ts`)

| Value                                                                      | Class                           | Notes                                                                                                                    |
| -------------------------------------------------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `DATABASE_URL`                                                             | **PRIVATE**                     | Contains credentials. Never logged, never exposed.                                                                       |
| `ALLOWED_ORIGINS`                                                          | PRIVATE                         | Not secret, but not the client's business.                                                                               |
| `SESSION_COOKIE_NAME`                                                      | PRIVATE                         | The cookie is `HttpOnly`; the browser attaches it without JavaScript naming it.                                          |
| `SESSION_COOKIE_SECURE`, `RATE_LIMIT_ENABLED`, `LOG_LEVEL`, `PORT`, `HOST` | PRIVATE                         | Operational posture.                                                                                                     |
| `AI_API_KEY`                                                               | **PRIVATE, secret-bearing**     | Task 013. In `SECRET_BEARING_KEYS` beside `DATABASE_URL`, so the redacting logger and the configuration summary mask it. |
| `AI_PROVIDER`, `AI_TIMEOUT_MS`                                             | PRIVATE                         | Which adapter and what deadline. Not secret; not the client's business.                                                  |
| `NODE_ENV`                                                                 | public _(via `toPublicConfig`)_ | Environment name only.                                                                                                   |
| API version                                                                | public                          | A constant, not a secret.                                                                                                |

`assertNoPrivateLeakage()` runs on **every boot in every environment** and throws
if a secret-bearing value appears anywhere inside the public object. The
allow-list is the real control; this is the backstop for the future careless edit
that adds `databaseUrl` "just for a debug banner".

### Client (`apps/web/src/shared/config/index.ts`)

Everything here ships inside a downloadable bundle. There is no such thing as a
secret in it. Two layers keep server values out:

1. **Vite only exposes `VITE_`-prefixed variables.** Server-only values are
   simply absent from `import.meta.env` — the build tool enforces this, not our
   discipline.
2. **One module reads `import.meta.env`**, asserted by a fitness test, so no
   feature can introduce an unvalidated value.

The fitness tests additionally assert that `apps/web` never imports from
`apps/api`, imports no workspace package except `@edu/contracts`, never
references `process.env`, and contains no server-only variable _names_ (a
tripwire for copy-paste).

**Task 013 adds a rule specifically about AI credentials**
(`tests/architecture/ai-boundaries.test.ts`): no file under `apps/web/src` may
match `VITE_*(AI|ANTHROPIC|OPENAI|LLM|MODEL)*` or name `AI_API_KEY`, and no
vendor SDK may be imported by either app or appear in any dependency manifest.
An AI key behind a `VITE_` prefix would be inlined into the bundle and shipped to
every browser that loads the page, which is the single worst outcome available in
that task — so it gets its own rule rather than relying on the general one.

**Verified:** the production bundle was built and searched for `DATABASE_URL`,
`postgres://`, role names, development passwords, cookie settings and origin
settings. None were present.

## Secrets

Never committed. `.gitignore` excludes `.env*` (except `.env.example`) and key
material; `pnpm security:secrets` fails the build on a match, and exemptions must
carry a written reason on the line.

`.env.example` is the template. It contains placeholders only — the secret
scanner recognizes `CHANGE_ME` and `${VAR}` shapes as placeholders, so a **real**
credential pasted there would still fail the scan.

Production secret management (a vault, rotation, per-environment injection) is
**not implemented**. Today the expectation is that the deployment platform injects
environment variables. See `docs/security/limitations.md`.
