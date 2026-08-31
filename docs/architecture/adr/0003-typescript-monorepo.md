# ADR 0003 — TypeScript monorepo with pnpm workspaces

**Status:** Accepted · **Date:** 2026-08-30

## Context

An Arabic-first web platform needs a shared frontend/backend type system,
strict validation on both sides of the wire, and a structure supporting pure,
dependency-free packages.

## Decision

A pnpm workspace monorepo. TypeScript in strict mode plus
`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitReturns`
and `verbatimModuleSyntax`. Contracts (Zod) shared between client and server.
Source runs directly under `node --experimental-strip-types` — no build step for
the API.

## Rationale

One language across the stack keeps contracts genuinely shared: a field cannot
drift between client and server without a type error. `noUncheckedIndexedAccess`
in particular catches the `rows[0]` mistakes that turn into runtime 500s in
database code, which is most of what this codebase does.

pnpm is chosen partly for supply-chain reasons: `enable-pre-post-scripts=false`
means a transitive dependency cannot execute an install script on a developer
machine or a CI runner.

## Consequences

- **Relative imports carry the real `.ts` extension**, not `.js`.

  This is a correction made in Task 002. The original decision paired NodeNext's
  `.js` convention with running the source directly under type stripping, and
  those are incompatible: Node does not rewrite `./x.js` to `./x.ts`, so the API
  could not start at all (VULN-004). The suite passed anyway, because Vitest had
  a resolver plugin papering over it.

  `.ts` specifiers are resolved natively by Node's type stripping, by Vite, and
  by TypeScript (`allowImportingTsExtensions`). The Vitest plugin was deleted, so
  the harness and the runtime now resolve modules identically — which is the
  property that makes the tests evidence about the real system.

- Strict flags cost some ceremony; the payoff is in the database layer.

- No build step for the API keeps the dev loop fast.

  **Known risk:** this means production would run on `--experimental-strip-types`.
  Node's type stripping is erasure-only, and the codebase contains no
  non-erasable syntax — no enums, no parameter properties, no decorators, all
  checked before relying on this. But an experimental flag in production is a real
  dependency on unstable behaviour, and a compile step should be added before the
  first production deployment. Recorded in docs/security/limitations.md.
