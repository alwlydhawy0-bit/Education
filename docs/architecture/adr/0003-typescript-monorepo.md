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

- NodeNext resolution requires `.js` extensions on relative imports even though
  the files are `.ts`. Vitest needs a small resolver plugin for this
  (`vitest.shared.ts`).
- Strict flags cost some ceremony; the payoff is in the database layer.
- No build step for the API keeps the dev loop fast; a production deployment may
  want a compile step later for startup time.
