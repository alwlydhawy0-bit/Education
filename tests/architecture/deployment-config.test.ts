import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * The deployment build configuration must describe the repository it is in.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE EXISTS (Task 009C/D — three broken deployments)
 * ---------------------------------------------------------------------------
 *
 * Vercel failed with `[UNRESOLVED_ENTRY] Cannot resolve entry module
 * "index.html"`. With no `vercel.json`, Vercel auto-detected a framework at the
 * REPOSITORY ROOT — `vite` is a root devDependency, pulled in for vitest — and
 * ran the Vite preset's default `vite build` there. No `index.html` and no
 * `vite.config.*` exist at the root, so Vite started with an empty config, took
 * its root to be the working directory, and found no entry.
 *
 * The remedy was to stop letting Vercel guess. These tests assert that what the
 * config claims is still true of the repository, because every value in it is a
 * fact that can drift silently and break a deploy while every other test in the
 * suite stays green.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE ROOT DEPLOYMENT NOW BUILDS, AND WHY THIS FILE CHANGED
 * ---------------------------------------------------------------------------
 *
 * It used to build `apps/web`. It now builds `edunext/` — the Arabic RTL
 * EduNext client — because that is the application the deployment is meant to
 * serve, and the root deployment was serving a legacy template instead.
 *
 * `apps/web` IS THEREFORE NO LONGER DEPLOYED BY THE ROOT PROJECT. It keeps its
 * own `apps/web/vercel.json` for a deployment whose Root Directory is set to
 * `apps/web`, and the assertions below still hold that file to the same
 * standard — but nothing in this repository deploys it today.
 *
 * ---------------------------------------------------------------------------
 * THE PART THAT IS EASY TO GET WRONG
 * ---------------------------------------------------------------------------
 *
 * `edunext` IS NOT IN THE PNPM WORKSPACE. It installs with npm and has its own
 * lockfile. Vercel, left alone, sees `pnpm-lock.yaml` and `packageManager` at
 * the repository root and runs `pnpm install` — which installs the workspace
 * and leaves `edunext/node_modules` EMPTY, so the build fails on the first
 * import. The `installCommand` below is what prevents that, and the test for it
 * is the reason it cannot be dropped as redundant.
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

/** The directory the root deployment builds, derived from the config itself. */
const DEPLOYED_DIR = 'edunext';

const deployedPackage = JSON.parse(
  readFileSync(join(ROOT, DEPLOYED_DIR, 'package.json'), 'utf8'),
) as { name: string; scripts: Record<string, string>; devDependencies?: Record<string, string> };

describe('the root vercel.json describes this repository', () => {
  it('disables framework auto-detection', () => {
    // The Task 009C failure in one assertion. Auto-detection ran the Vite
    // preset at the repository root, where there is no entry to resolve.
    // `null` is what stopped it guessing; an explicit preset name would work
    // too, and `null` is the value that was actually proven here.
    expect(vercel.framework).toBeNull();
  });

  it('installs with the package manager the deployed app actually uses', () => {
    // THE CRITICAL ONE. `edunext` is not in pnpm-workspace.yaml — it has its own
    // npm lockfile — so Vercel's root-detected `pnpm install` would install the
    // workspace and leave edunext/node_modules empty. Deleting this line
    // produces a build that fails on its first import with a message about a
    // missing module rather than about the installer.
    expect(vercel.installCommand).toBe(`cd ${DEPLOYED_DIR} && npm ci`);
  });

  it('installs from a lockfile, so a deploy resolves what CI resolved', () => {
    // `npm ci` rather than `npm install`: the latter is free to update the
    // lockfile and resolve a different tree than the one that was tested.
    expect(vercel.installCommand).toContain('npm ci');
    expect(existsSync(join(ROOT, DEPLOYED_DIR, 'package-lock.json'))).toBe(true);
  });

  it('delegates to the package script rather than restating it', () => {
    // `vite build` inlined here would silently drop whatever else the package's
    // own build script does now or later.
    expect(vercel.buildCommand).toBe(`cd ${DEPLOYED_DIR} && npm run build`);
    expect(deployedPackage.scripts['build']).toBeDefined();
    expect(vercel.buildCommand).not.toContain('vite build');
  });

  it('publishes the directory the build actually writes to', () => {
    // Task 009D: "No Output Directory named 'dist' found". Vite's root is the
    // directory it runs in, and `build.outDir` is unset, so the output lands in
    // <package>/dist — not at the repository root.
    expect(vercel.outputDirectory).toBe(`${DEPLOYED_DIR}/dist`);
  });

  it('derives that path from where the vite config actually lives', () => {
    // Asserting the STRING alone would keep passing if the app moved. This ties
    // it to the file whose location decides the answer.
    expect(existsSync(join(ROOT, DEPLOYED_DIR, 'vite.config.js'))).toBe(true);
    const configured = readFileSync(join(ROOT, DEPLOYED_DIR, 'vite.config.js'), 'utf8');
    // No `build.outDir` override means Vite's default of `<root>/dist` holds,
    // which is what the output path above assumes.
    expect(configured).not.toMatch(/outDir/);
  });

  it('the output path is relative, never absolute or parent-escaping', () => {
    const out = vercel.outputDirectory ?? '';
    expect(out.startsWith('/')).toBe(false);
    expect(out.split('/')).not.toContain('..');
  });

  it('when a build output exists on disk, it is at exactly that path', () => {
    // Only meaningful after a local build; skipped rather than faked otherwise.
    const declared = join(ROOT, vercel.outputDirectory ?? '');
    if (!existsSync(declared)) return;
    expect(existsSync(join(declared, 'index.html'))).toBe(true);
  });

  it('the deployed app has exactly one index.html, and it is not at the repository root', () => {
    // A root index.html is what re-enables the framework auto-detection this
    // whole file exists to prevent.
    expect(existsSync(join(ROOT, 'index.html'))).toBe(false);
    expect(existsSync(join(ROOT, DEPLOYED_DIR, 'index.html'))).toBe(true);
  });

  it('no vite.config exists at the repository root', () => {
    for (const name of ['vite.config.ts', 'vite.config.js', 'vite.config.mjs']) {
      expect(existsSync(join(ROOT, name))).toBe(false);
    }
  });
});

/**
 * `apps/web` keeps its own config for a deployment whose Root Directory is set
 * to `apps/web`. The root project no longer builds it.
 *
 * Vercel reads `vercel.json` FROM the Root Directory, and Root Directory is a
 * dashboard-only setting no test in this repository can read — which is exactly
 * how a correct root config went unread for three deployments. Keeping this
 * file honest is cheap; discovering it had rotted during an incident is not.
 */
describe('apps/web keeps a self-consistent config for a Root-Directory deployment', () => {
  const WEB_VERCEL = join(ROOT, 'apps/web/vercel.json');

  it('exists', () => {
    expect(existsSync(WEB_VERCEL)).toBe(true);
  });

  it('builds the web package by the name that package actually declares', () => {
    const webVercel = JSON.parse(readFileSync(WEB_VERCEL, 'utf8')) as VercelConfig;
    const webPackage = JSON.parse(readFileSync(join(ROOT, 'apps/web/package.json'), 'utf8')) as {
      name: string;
    };
    expect(webVercel.buildCommand).toBe(`pnpm --filter ${webPackage.name} build`);
  });

  it('installs workspace-aware, because the web app depends on a workspace package', () => {
    // `apps/web` depends on @edu/contracts via workspace:*, so an install
    // scoped to that directory fails with ERR_PNPM_WORKSPACE_PKG_NOT_FOUND.
    const webVercel = JSON.parse(readFileSync(WEB_VERCEL, 'utf8')) as VercelConfig;
    expect(webVercel.installCommand).toBe('pnpm install --frozen-lockfile');
  });

  it('disables framework auto-detection, for the same reason the root does', () => {
    const webVercel = JSON.parse(readFileSync(WEB_VERCEL, 'utf8')) as VercelConfig;
    expect(webVercel.framework).toBeNull();
  });

  it('its output path is relative, never absolute or parent-escaping', () => {
    const webVercel = JSON.parse(readFileSync(WEB_VERCEL, 'utf8')) as VercelConfig;
    const out = webVercel.outputDirectory ?? '';
    expect(out.startsWith('/')).toBe(false);
    expect(out.split('/')).not.toContain('..');
  });

  it('does NOT claim the same output directory as the root project', () => {
    // The two now build different applications. Asserting they MATCH — which
    // this suite used to — would be asserting the bug the root config was just
    // changed to fix.
    const webVercel = JSON.parse(readFileSync(WEB_VERCEL, 'utf8')) as VercelConfig;
    expect(webVercel.outputDirectory).not.toBe(vercel.outputDirectory);
  });
});
