/**
 * Supply-chain checks.
 *
 * Three things, all cheap enough to run on every CI build:
 *
 *   1. A lockfile exists. Without one, two builds of the "same" commit can
 *      resolve different transitive dependencies — which defeats the point of
 *      auditing them at all.
 *   2. Lifecycle scripts stay disabled (.npmrc). An arbitrary `postinstall` in
 *      a transitive dependency is code execution on every developer machine and
 *      every CI runner; packages that genuinely need one must be allow-listed
 *      deliberately.
 *   3. `pnpm audit` reports no high or critical advisory.
 *
 * A registry that cannot be reached is reported as UNKNOWN and fails the check
 * rather than passing quietly. A security gate that silently no-ops when the
 * network is down is worse than no gate, because it is trusted.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '../..');
const failures: string[] = [];

// --- 1. Lockfile --------------------------------------------------------
if (!existsSync(join(ROOT, 'pnpm-lock.yaml'))) {
  failures.push('pnpm-lock.yaml is missing — dependency resolution is not reproducible.');
} else {
  console.log('OK  lockfile present');
}

// --- 2. Lifecycle scripts ----------------------------------------------
const npmrcPath = join(ROOT, '.npmrc');
const npmrc = existsSync(npmrcPath) ? readFileSync(npmrcPath, 'utf8') : '';
if (!/^enable-pre-post-scripts\s*=\s*false\s*$/m.test(npmrc)) {
  failures.push(
    '.npmrc must set "enable-pre-post-scripts=false" so transitive dependencies cannot run install scripts.',
  );
} else {
  console.log('OK  dependency lifecycle scripts disabled');
}

// --- 3. Advisories ------------------------------------------------------
interface AuditReport {
  advisories?: Record<string, { severity?: string; module_name?: string; title?: string }>;
  metadata?: { vulnerabilities?: Record<string, number> };
}

function runAudit(): AuditReport | null {
  try {
    const output = execFileSync('pnpm', ['audit', '--json'], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return JSON.parse(output) as AuditReport;
  } catch (error) {
    // `pnpm audit` exits non-zero when it FINDS advisories, and still prints the
    // report — so a non-zero exit is not by itself a failure to run.
    const stdout = (error as { stdout?: string }).stdout;
    if (typeof stdout === 'string' && stdout.trim().startsWith('{')) {
      try {
        return JSON.parse(stdout) as AuditReport;
      } catch {
        return null;
      }
    }
    return null;
  }
}

const report = runAudit();

if (report === null) {
  failures.push(
    'Could not obtain an audit report (registry unreachable, or unexpected output). ' +
      'Treating as UNKNOWN, not as clean.',
  );
} else {
  const counts = report.metadata?.vulnerabilities ?? {};
  const high = (counts['high'] ?? 0) + (counts['critical'] ?? 0);
  const summary = Object.entries(counts)
    .map(([severity, count]) => `${severity}=${count}`)
    .join(' ');
  console.log(`OK  audit completed (${summary || 'no counts reported'})`);

  if (high > 0) {
    failures.push(`${high} high/critical advisory(ies) reported by pnpm audit.`);
    for (const advisory of Object.values(report.advisories ?? {})) {
      const severity = advisory.severity ?? '?';
      if (severity === 'high' || severity === 'critical') {
        console.error(`  [${severity}] ${advisory.module_name ?? '?'}: ${advisory.title ?? '?'}`);
      }
    }
  }
}

if (failures.length > 0) {
  console.error('\nDependency check FAILED:\n');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log('\nDependency check passed.');
