# Dependency Rules

Brief §31. These rules are **enforced by tests**, not by convention:
`tests/architecture/dependency-rules.test.ts` (16 assertions).

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
`Promise<Guarded<T> | null>`.

### 7. Only `platform/db.ts` constructs a connection pool

No other file may call `new pg.Pool` or `new pg.Client`.

_Why:_ this is what guarantees every query runs inside `withActor`/`withoutActor`
and therefore that `app.actor_id` is always set correctly for RLS. A stray
client would silently sidestep the entire database gate.

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
