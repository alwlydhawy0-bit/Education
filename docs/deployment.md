# Deployment — Vercel (web client)

What is deployed, what is verified, and what has repeatedly gone wrong.

**Scope: only `apps/web` is deployed to Vercel. The API is not deployed
anywhere.** That is a fact about the current state of the project, not an
oversight of this document, and it has runtime consequences (§6).

---

## 1. The configuration, and why each value is pinned

`vercel.json` at the repository root:

| Key               | Value                            | Why it is pinned                                                                                                                                                                                                                                                                                                                                        |
| ----------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `framework`       | `null`                           | **Task 009C.** Vite is a _root_ devDependency (vitest needs it), so framework auto-detection ran the Vite preset's `vite build` at the repository root. The only `index.html` is in `apps/web`, and no root `vite.config.*` exists, so Vite started with an empty config and failed with `[UNRESOLVED_ENTRY] Cannot resolve entry module "index.html"`. |
| `installCommand`  | `pnpm install --frozen-lockfile` | Must run at the **workspace root**. `apps/web` depends on `@edu/contracts` via `workspace:*`; an install scoped to `apps/web` fails with `ERR_PNPM_WORKSPACE_PKG_NOT_FOUND`.                                                                                                                                                                            |
| `buildCommand`    | `pnpm --filter @edu/web build`   | Delegates to the package script, which is `tsc --noEmit && vite build`. Inlining `vite build` here would silently drop the typecheck.                                                                                                                                                                                                                   |
| `outputDirectory` | `apps/web/dist`                  | **Task 009D.** Vercel reported `No Output Directory named "dist" found`. Vite's root is the directory it runs in (which `pnpm --filter` makes the package directory) and `build.outDir` is unset, so the output is `apps/web/dist`.                                                                                                                     |

Ten fitness tests in `tests/architecture/deployment-config.test.ts` assert every
one of these against the repository, including **deriving** the output path from
where `vite.config.ts` actually lives rather than restating the string. Each is
a fact that can drift silently: renaming the web package, adding a root
`index.html`, or setting `build.outDir` would each break a deploy while every
other test stayed green.

## 2. Vercel settings that `vercel.json` cannot express

**`vercel.json` is read from the project's Root Directory, and Root Directory is
a dashboard-only setting.** This is the one deployment input that no test in this
repository can verify, and it is the first thing to check when a deploy fails
while the build is known good:

- **Root Directory must be the repository root** (empty). If it is set to
  `apps/web`, Vercel looks for `apps/web/vercel.json`, does not find it, and
  falls back to dashboard settings — and `outputDirectory: apps/web/dist` would
  then resolve to `apps/web/apps/web/dist`, which does not exist.
- The **Node version** comes from `engines.node` in the root `package.json`,
  currently `>=22.12.0`. That range has no upper bound and there is no `.nvmrc`,
  so the build silently follows whatever major Vercel offers as
  highest-satisfying. See §7.

## 3. Verified build facts

Measured 2026-09-03 against commit `58cd718`, in **three independent
environments**, all running the identical command sequence from `vercel.json`:

| Environment                                                                                        | Result                                                   |
| -------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| This repository's working tree                                                                     | `pnpm --filter @edu/web build` → exit 0                  |
| A pristine `git clone` with **no** `node_modules`, `pnpm install --frozen-lockfile` then the build | exit 0                                                   |
| The same, with `CI=1 NODE_ENV=production VERCEL=1 VERCEL_ENV=production`                           | exit 0                                                   |
| GitHub Actions `static` job (run #21, Node 22, ubuntu-latest)                                      | **success** — CI runs the exact Vercel install and build |

Output in every case:

```
dist/index.html                  0.73 kB
dist/assets/index-<hash>.js    240.11 kB │ map: 780.12 kB
```

The lockfile is in sync with every `package.json`: `--frozen-lockfile` installs
without modification.

## 4. The esbuild warning is not a failure

```
Ignored build scripts: esbuild@0.28.2.
Run "pnpm approve-builds" to pick which dependencies should be allowed to run scripts.
```

This appears on every install, locally and on Vercel, **and the build succeeds
anyway.** Evidence:

- `apps/web`'s Vite 7.3.6 declares `esbuild: ^0.27.0 || ^0.28.0` and resolves to
  esbuild 0.28.2, so esbuild **is** required by the production build.
- esbuild's only script is `postinstall: node install.js`. With it skipped,
  `node_modules/.pnpm/esbuild@0.28.2/node_modules/esbuild/bin/esbuild` remains
  the JavaScript shim rather than being replaced by the native binary — that
  replacement is the postinstall's sole effect, and it is a startup
  micro-optimisation.
- The native binary arrives **declaratively**, as the `@esbuild/linux-x64`
  optional dependency, which needs no script:
  `@esbuild/linux-x64@0.28.2/.../bin/esbuild: ELF 64-bit LSB executable, x86-64`.
- `esbuild.transformSync(..., {loader:'tsx'})` executes correctly with the
  postinstall skipped, spawning that binary.
- Rollup's native binding is present the same way
  (`@rollup/rollup-linux-x64-gnu@4.63.1`).

**Do not run `pnpm approve-builds` for this.** `.npmrc` deliberately sets
`enable-pre-post-scripts=false` — "do not run arbitrary lifecycle scripts from
transitive dependencies" — and `security:deps` enforces it. Approving a script
to silence an informational warning would trade a real supply-chain control for
nothing.

## 5. Frontend environment variables

**There are none.** The web application defines and reads **zero** `VITE_*`
variables.

| Variable                                                                                                             | Classification                                                                                                                                 |
| -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| _(any `VITE_*`)_                                                                                                     | **UNUSED** — none exists, none is referenced                                                                                                   |
| `DATABASE_URL`, `AI_API_KEY`, `AI_BASE_URL`, `AI_MODEL`, `SESSION_COOKIE_*`, `ALLOWED_ORIGINS`, `RATE_LIMIT_ENABLED` | **SERVER-ONLY** (several secret-bearing). Read by `apps/api` through `platform/config`. No `VITE_` counterpart exists and none may be created. |
| `import.meta.env.MODE`                                                                                               | **PUBLIC** — supplied by Vite itself, constant-folded at build time.                                                                           |

`apps/web/src/shared/config/index.ts` is the only module that reads
`import.meta.env`, and `tests/architecture/dependency-rules.test.ts` asserts
that. The API base URL is a same-origin relative path, so there is no host to
configure; the session cookie is `HttpOnly`, so its name is never needed by
JavaScript.

**No Vercel environment variables are required to build or serve this
frontend.** Adding a secret behind a `VITE_` prefix would ship it to every
browser; `tests/architecture/ai-boundaries.test.ts` fails the build on
`VITE_*(AI|ANTHROPIC|OPENAI|LLM|MODEL)*`.

## 6. What the deployed site actually does

Verified by serving the real `apps/web/dist` over HTTP and loading it in
headless Chromium:

- React mounts, the bundle executes, `<h1>` renders, the locale switcher works.
- **Zero page errors** — no fatal runtime crash.
- `index.html`, the JS bundle and the source map all serve 200.
- Navigation is by **query parameter** (`/?course=`, `/?lesson=`, `/?attempt=`),
  not by path. There is no client-side path router, so **no SPA rewrite rule is
  needed** and none should be added.
- The app ships **no CSS at all** — `document.styleSheets.length === 0`. It is
  unstyled by design at this stage; there is no stylesheet to fail to load.

And the consequence of §0:

- `GET /api/v1/health` and `GET /api/v1/me/courses` return **404**, because the
  Vercel deployment contains only static files. The UI degrades honestly
  ("Service is unreachable", "Your courses cannot be shown") rather than
  crashing — but **the deployed site is a shell with no working backend.**

## 7. Open deployment risks

| ID             | Risk                                                                                                                                                                                               |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OPEN-DEPLOY-01 | **Root Directory is unverifiable from the repository** (§2) and is the one setting that can break a deploy while every test stays green.                                                           |
| OPEN-DEPLOY-02 | `engines.node` is the open-ended range `>=22.12.0` with no `.nvmrc`. A new Node major on Vercel changes the build's runtime with no repository change.                                             |
| OPEN-DEPLOY-03 | **No API deployment exists**, so any successful Vercel deployment is a frontend with a dead backend (§6).                                                                                          |
| OPEN-DEPLOY-04 | `build.sourcemap: true` publishes a 780 kB source map exposing the full frontend source and `packages/contracts`. No secret is in it (verified), but it is readable by anyone.                     |
| OPEN-DEPLOY-05 | Vercel's build cache is not reproducible from here. A stale cache reconciling against a changed lockfile is a known class of "works everywhere but Vercel"; clearing it is the first cheap remedy. |
| OPEN-CI-01     | CI does not run the `web` or `evaluation` vitest projects. (It does run the web **build** and a bundle secret scan.)                                                                               |
