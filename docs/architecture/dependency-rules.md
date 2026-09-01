# Dependency Rules

Brief §31. These rules are **enforced by tests**, not by convention:
`tests/architecture/dependency-rules.test.ts` (18 assertions).

## The direction

```
apps/web  ──HTTP only──►  apps/api
                            │
                    modules/  (domain logic)
                            │
                    platform/ (infrastructure: config, db, http, audit, crypto)
                            │
                    packages/ (pure: kernel, authz, contracts, observability)
                            │
                          (nothing)
```

Dependencies point **downward only**. `apps/web` never reaches the database.

## The rules

### 1. Pure packages import no infrastructure

`kernel`, `authz` and `contracts` must not import `pg`, `postgres`, `fastify`,
`@fastify/*`, `node:fs`, `node:http`, `node:child_process`, `@node-rs/argon2`, or
call `fetch`.

_Why:_ the policy engine must stay a pure function of its inputs so the
authorization decision table is exhaustively testable without a database. It is
additionally asserted that `packages/authz` imports **nothing but** `@edu/kernel`.

### 2. `platform` never imports from `modules`

`platform` sits below the domain modules. When it needs domain behaviour it
declares a local interface (`SessionAuthenticator`, `RelationshipLoader`) and the
composition root supplies an implementation.

_Why:_ the other direction is a cycle waiting to happen and would block
extracting a module into its own service. (This rule was violated by the first
draft of `authentication.ts` and fixed before the test was written.)

### 3. No module imports another module

`modules/notebook` must not import from `modules/identity`, and so on.
Cross-domain access goes through a contract supplied by the composition root.

_Why:_ this is the property that keeps a domain extractable. If `notebook`
imported `identity` directly, moving `identity` to its own service would mean
rewriting `notebook`.

### 4. Only the composition root wires modules together

`apps/api/src/app.ts` is the single file allowed to import from more than one
module.

_Why:_ one place to read to understand how the system is assembled, and one place
to change when a module is replaced.

### 5. HTTP files never touch the database, and never build an `Actor`

No `.routes.ts` file may import `pg` or `platform/db.js`, or construct an object
with a `roles: [...]` literal.

_Why:_ a route reaching the database directly skips the service layer's
authorization funnel. A route constructing an `Actor` would be an authentication
bypass — an actor may only come from a validated session.

### 6. Protected repositories return `Guarded<T>`

A by-id loader for a protected resource must declare
`Promise<Guarded<T> | null>`, and the service must unwrap only with a decision.

The loaders are **enumerated** in the test rather than discovered, so adding a
protected resource means adding a line — which is the moment somebody asks
whether the new loader is guarded. Covered today: `notebook`, `users` (user and
profile), `organizations`, `relationships` (classes and teacher assignments),
guardian links, the four levels of the content tree, class–course assignments,
lesson progress, learning activities and assessment attempts.

### 7. Only `platform/db.ts` constructs a connection pool

No other file may call `new pg.Pool` or `new pg.Client`.

_Why:_ this is what guarantees every query runs inside `withActor`/`withoutActor`
and therefore that `app.actor_id` is always set correctly for RLS. A stray
client would silently sidestep the entire database gate.

### 8. The frontend cannot reach server-only code or secrets

`apps/web` must not import from `apps/api`, must import no workspace package
except `@edu/contracts`, must not reference `process.env`, must read
`import.meta.env` in exactly one module, and must not even mention a server-only
variable name.

_Why:_ the browser bundle is public. The last rule is a tripwire for the
copy-paste that puts a server value in client code — it fired during Task 002 on
a docstring, which is the point.

### 9. The application must actually be runnable

No relative import may end in `.js`, and **every relative import must resolve to
a file that exists**.

_Why:_ Node's type stripping does not rewrite `./x.js` to `./x.ts`, so Task 001's
`.js` specifiers meant the API could not boot at all — while 208 tests passed,
because Vitest resolved them through a plugin (VULN-004). The second half of the
rule was added minutes later, when a bulk rename pointed `.tsx` components at
`.ts` paths: `tsc` accepted it, Rollup did not. Both halves check the filesystem,
which is what Node and Rollup actually do.

### 10. The answer key never leaves the database

`assessment_answer_keys` may appear in application code ONLY in an `INSERT` —
never after `FROM` or `JOIN` — and `app_score_attempt` may not appear at all.
No response schema may carry a field named for correctness.

The only rule here that guards a single table, and it earns that: the property
cannot be re-established by review once lost. A `SELECT` that pulls correctness
into a repository is one careless spread away from a response body, and nobody
reading the response schema would see it. The test strips comments first — these
files explain the rule at length, and prose about what must not happen is not
the thing happening.

## Allowed dependencies, in one table

| From                     | May import                                                |
| ------------------------ | --------------------------------------------------------- |
| `packages/kernel`        | nothing                                                   |
| `packages/authz`         | `@edu/kernel`                                             |
| `packages/contracts`     | `@edu/kernel`, `zod`                                      |
| `packages/observability` | `@edu/kernel`                                             |
| `apps/api/src/platform`  | `packages/*`, other `platform/*`, infrastructure libs     |
| `apps/api/src/modules/X` | `packages/*`, `platform/*`, its own files                 |
| `apps/api/src/app.ts`    | everything (composition root)                             |
| `apps/web`               | `packages/contracts`, its own files. **Never** `apps/api` |

## If a rule blocks you

That is the rule working. The usual resolutions:

- Need another domain's data? Define an interface where you need it and let the
  composition root supply it (rule 2's pattern).
- Need shared logic? It belongs in `packages/` — and if it cannot go there
  because it needs I/O, it belongs in `platform/`.
- Genuinely need to break a rule? Change the rule _and its test_, in the same
  commit, with the reasoning in the message. A rule with an undocumented
  exception is worse than no rule.
