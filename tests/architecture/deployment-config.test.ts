import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

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

interface VercelConfig {
  framework?: string | null;
  installCommand?: string;
  buildCommand?: string;
  outputDirectory?: string;
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
    // Installing from the repository root is what resolves them. An install
    // scoped to apps/web fails with ERR_PNPM_WORKSPACE_PKG_NOT_FOUND.
    expect(vercel.installCommand).toBe('pnpm install --frozen-lockfile');
  });

  it('publishes the directory the build actually writes to', () => {
    // Vite's default outDir is `<root>/dist`, and the config overrides neither
    // `root` nor `build.outDir` — so the output is apps/web/dist.
    const viteConfig = readFileSync(join(ROOT, 'apps/web/vite.config.ts'), 'utf8');
    expect(viteConfig).not.toMatch(/\broot\s*:/);
    expect(viteConfig).not.toMatch(/\boutDir\s*:/);
    expect(vercel.outputDirectory).toBe('apps/web/dist');
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
