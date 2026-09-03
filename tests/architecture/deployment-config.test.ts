import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

/**
 * The deployment build configuration must describe the repository it is in.
 *
 * Task 009C: Vercel failed with `[UNRESOLVED_ENTRY] Cannot resolve entry module
 * "index.html"`. With no `vercel.json`, Vercel auto-detected a framework at the
 * REPOSITORY ROOT — `vite` is a root devDependency, pulled in for vitest — and
 * ran the Vite preset's default `vite build` there. The only index.html lives in
 * `apps/web`, and no `vite.config.*` exists at the root, so Vite started with an
 * empty config, took its root to be the working directory, and found no entry.
 *
 * `vercel.json` now pins the three values that were being guessed. These tests
 * assert each one still matches the repository, because every one of them is a
 * fact that can drift silently: renaming the web package, changing its build
 * script's output, or adding a root index.html would each break a deploy while
 * every other test stayed green.
 *
 * Nothing here contacts Vercel. It checks internal consistency only.
 */
const ROOT = resolve(import.meta.dirname, '../..');
const WEB_VITE_CONFIG = join(ROOT, 'apps/web/vite.config.ts');

interface VercelConfig {
  framework?: string | null;
  installCommand?: string;
  buildCommand?: string;
  outputDirectory?: string;
}

/** Every workspace package directory, from the globs pnpm-workspace.yaml declares. */
function workspacePackageDirs(): string[] {
  const yaml = readFileSync(join(ROOT, 'pnpm-workspace.yaml'), 'utf8');
  const roots = [...yaml.matchAll(/^\s*-\s*'?([^'\n]+?)\/\*'?\s*$/gm)].map((m) => m[1]);
  return roots.flatMap((r) => {
    const base = join(ROOT, r ?? '');
    if (!existsSync(base)) return [];
    return readdirSync(base)
      .map((name) => join(base, name))
      .filter((dir) => existsSync(join(dir, 'package.json')));
  });
}

const vercel = JSON.parse(readFileSync(join(ROOT, 'vercel.json'), 'utf8')) as VercelConfig;

const webPackage = JSON.parse(readFileSync(join(ROOT, 'apps/web/package.json'), 'utf8')) as {
  name: string;
  scripts: Record<string, string>;
  dependencies?: Record<string, string>;
};

describe('vercel.json describes this repository', () => {
  it('disables framework auto-detection', () => {
    // The root cause. Vite is a root devDependency for vitest, so leaving
    // detection on makes Vercel run the Vite preset's `vite build` at the repo
    // root — which is exactly the failure this file exists to prevent.
    expect(vercel.framework).toBeNull();
  });

  it('builds the web package by the name that package actually declares', () => {
    expect(vercel.buildCommand).toBe(`pnpm --filter ${webPackage.name} build`);
  });

  it('delegates to the package script rather than restating it', () => {
    // The script typechecks before building. A buildCommand that inlined
    // `vite build` would silently drop `tsc --noEmit`.
    expect(webPackage.scripts.build).toContain('tsc --noEmit');
    expect(webPackage.scripts.build).toContain('vite build');
    expect(vercel.buildCommand).not.toContain('vite build');
  });

  it('installs workspace-aware, because the web app depends on a workspace package', () => {
    const workspaceDeps = Object.entries(webPackage.dependencies ?? {}).filter(([, range]) =>
      range.startsWith('workspace:'),
    );
    expect(workspaceDeps.length).toBeGreaterThan(0);
    // Installing from the repository root is what resolves them, and the
    // lockfile and pnpm-workspace.yaml both live there.
    expect(vercel.installCommand).toBe('pnpm install --frozen-lockfile');
  });

  it('at least one workspace dependency resolves OUTSIDE apps/web', () => {
    // Task 019-A.1. This is the fact that decides Vercel's Root Directory, so
    // it is derived rather than asserted in prose.
    //
    // Vercel resolves `outputDirectory` relative to the Root Directory, and
    // reads `vercel.json` FROM that directory. Setting it to `apps/web` is
    // therefore tempting — `dist` would then be the output. But by default
    // Vercel copies only files inside the Root Directory into the build, and
    // this package's own dependencies reach outside it. Root Directory must
    // stay at the repository root, which is why `outputDirectory` carries the
    // `apps/web/` prefix.
    //
    // An earlier version of this comment claimed a scoped install fails with
    // ERR_PNPM_WORKSPACE_PKG_NOT_FOUND. Measured under pnpm 10.33 it does not:
    // pnpm walks up, finds the workspace root and links the package. The real
    // constraint is the one below — the files simply are not there.
    const webDir = dirname(WEB_VITE_CONFIG);
    const names = new Set(
      Object.entries(webPackage.dependencies ?? {})
        .filter(([, range]) => range.startsWith('workspace:'))
        .map(([name]) => name),
    );

    const outside: string[] = [];
    for (const dir of workspacePackageDirs()) {
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name: string };
      if (!names.has(pkg.name)) continue;
      // `..` as the first segment means the dependency lives outside apps/web.
      if (relative(webDir, dir).split(sep)[0] === '..') outside.push(pkg.name);
    }

    expect(outside.length).toBeGreaterThan(0);
  });

  it('publishes the directory the build actually writes to', () => {
    // Vite's default outDir is `<root>/dist`, and the config overrides neither
    // `root` nor `build.outDir` — so the output is apps/web/dist.
    const viteConfig = readFileSync(join(ROOT, 'apps/web/vite.config.ts'), 'utf8');
    expect(viteConfig).not.toMatch(/\broot\s*:/);
    expect(viteConfig).not.toMatch(/\boutDir\s*:/);
    expect(vercel.outputDirectory).toBe('apps/web/dist');
  });

  it('derives that path from where the vite config actually lives', () => {
    // Task 009D: Vercel reported `No Output Directory named "dist" found`. The
    // string assertion above would still have passed if the web app moved, so
    // this DERIVES the expected path from the filesystem instead of restating
    // it. Vite's root is the directory it runs in — which `pnpm --filter` makes
    // the package directory — and with outDir unset the output is `<root>/dist`.
    const webDir = relative(ROOT, dirname(WEB_VITE_CONFIG));
    expect(vercel.outputDirectory).toBe(`${webDir}/dist`);
  });

  it('the output path is relative, never absolute or parent-escaping', () => {
    // Vercel resolves outputDirectory relative to the Root Directory. A leading
    // slash or `../` would resolve outside the deployment and fail in a way the
    // build log describes only as "not found".
    const out = vercel.outputDirectory ?? '';
    expect(out.startsWith('/')).toBe(false);
    expect(out.split('/')).not.toContain('..');
  });

  it('when a build output exists on disk, it is at exactly that path', () => {
    // Runs no build of its own — that belongs to the build step, not the test
    // suite. But after any local or CI build, this validates the real artifact
    // rather than the claim about it.
    const declared = join(ROOT, vercel.outputDirectory ?? '');
    if (!existsSync(declared)) return;
    expect(existsSync(join(declared, 'index.html'))).toBe(true);
    // And nothing was emitted at the repository root, which is the location
    // Vercel was looking in when it failed.
    expect(existsSync(join(ROOT, 'dist'))).toBe(false);
  });

  it('there is exactly one index.html, and it is not at the repository root', () => {
    // If a root index.html ever appears, framework auto-detection would start
    // "working" by accident and build the wrong thing.
    expect(existsSync(join(ROOT, 'index.html'))).toBe(false);
    expect(existsSync(join(ROOT, 'apps/web/index.html'))).toBe(true);
  });

  it('no vite.config exists at the repository root', () => {
    // Its absence is why root-level `vite build` has no root and no entry.
    for (const ext of ['ts', 'js', 'mts', 'mjs']) {
      expect(existsSync(join(ROOT, `vite.config.${ext}`))).toBe(false);
    }
  });
});
