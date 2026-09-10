/**
 * Production environment validation, WITHOUT starting the server.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS NOT ALREADY COVERED BY `loadConfig`
 * ---------------------------------------------------------------------------
 *
 * `platform/config.ts` refuses to start on a bad configuration, which is the
 * right behaviour and the wrong MOMENT. By the time it runs, the image has been
 * built, pushed, scheduled and started; the failure appears as a crash loop in
 * an orchestrator at 03:00, and the operator's first question — "which
 * variable?" — is answered by a message buried in a restarting container's logs.
 *
 * This runs the SAME schema against a candidate environment before any of that,
 * from a laptop or a pipeline step, and prints every problem at once instead of
 * whichever one Zod happened to report first.
 *
 * It uses the real `loadConfig`. A validator with its own copy of the rules
 * would drift from the thing it validates, and would then be worse than nothing
 * — a green tick from a rulebook the server does not use.
 *
 * ---------------------------------------------------------------------------
 * IT NEVER PRINTS A VALUE
 * ---------------------------------------------------------------------------
 *
 * The file it reads is the most secret-dense file a deployment has: a database
 * password, a Redis password, a provider API key. So the output names KEYS and
 * describes problems, and no branch of this program can print the right-hand
 * side of an assignment. That is why failures are reported as
 * "DATABASE_URL: required" rather than by echoing what was found.
 *
 * ---------------------------------------------------------------------------
 * THE THIRD CHECK: VARIABLES THAT DO NOTHING
 * ---------------------------------------------------------------------------
 *
 * VULN-037 was a set of environment variables that were declared in the schema,
 * documented as configurable, and never listed in `CONFIG_KEYS` — so setting
 * them silently did nothing, and it survived a whole task. The mirror image is
 * a deployment that sets `REDIS_HOST` when the application reads `REDIS_URL`:
 * the operator believes the cache is configured, the application never sees it,
 * and there is no error anywhere. Every key in the file that the application
 * does not read is reported.
 *
 * Usage:
 *   node --experimental-strip-types tools/deploy/check-env.ts .env.production
 *   ... --env production|staging     (default: whatever NODE_ENV the file sets)
 *
 * Exit code 1 on any error. Unknown keys are warnings, not errors.
 */
import { readFileSync } from 'node:fs';
import { CONFIG_KEYS, loadConfig } from '../../apps/api/src/platform/config.ts';
import { parseTrustProxy } from '../../apps/api/src/platform/security/trusted-proxy.ts';

export interface EnvProblem {
  readonly severity: 'error' | 'warning';
  readonly key: string;
  readonly message: string;
}

/**
 * A deliberately small `.env` parser.
 *
 * It handles `KEY=value`, `export KEY=value`, quoted values and `#` comments,
 * and it does NOT handle interpolation, multi-line values or shell expansion.
 * Supporting those would mean this parser and whatever loads the file in
 * production could disagree about what the file says, and a validator that
 * reads a different file from the server is worse than no validator.
 */
export function parseEnvFile(contents: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const rawLine of contents.split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const withoutExport = line.startsWith('export ') ? line.slice('export '.length) : line;
    const eq = withoutExport.indexOf('=');
    if (eq <= 0) continue;
    const key = withoutExport.slice(0, eq).trim();
    let value = withoutExport.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

/**
 * Placeholders that mean "somebody meant to fill this in".
 *
 * A schema cannot catch these: `CHANGE_ME` is a perfectly valid non-empty
 * string, and `postgres://user:CHANGE_ME@host/db` is a perfectly valid URL. The
 * failure they produce is a deployment that boots and then cannot authenticate,
 * which looks like an infrastructure problem rather than a copied template.
 */
const PLACEHOLDERS = ['CHANGE_ME', 'REPLACE_ME', 'your-', 'xxxxx', '<', 'TODO'];

export function checkEnv(env: Record<string, string>, overrideEnvironment?: string): EnvProblem[] {
  const problems: EnvProblem[] = [];
  const candidate = { ...env };
  if (overrideEnvironment) candidate['NODE_ENV'] = overrideEnvironment;

  // --- 1. The real schema, with the real refinements -----------------------
  try {
    loadConfig(candidate as NodeJS.ProcessEnv);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // `loadConfig` formats issues as "  - KEY: message" lines. Split them back
    // out so every problem is reported, rather than one blob.
    for (const line of message.split('\n')) {
      const match = /^\s*-\s*([A-Za-z0-9_.()]+):\s*(.+)$/.exec(line);
      if (match?.[1] && match[2]) {
        problems.push({ severity: 'error', key: match[1], message: match[2] });
      }
    }
    if (problems.length === 0) {
      problems.push({ severity: 'error', key: '(configuration)', message: message.trim() });
    }
  }

  // --- 2. The proxy setting, which the schema deliberately does not decode --
  try {
    parseTrustProxy(candidate['TRUST_PROXY']);
  } catch (error) {
    problems.push({
      severity: 'error',
      key: 'TRUST_PROXY',
      message: error instanceof Error ? error.message : 'invalid',
    });
  }

  // --- 3. Placeholders left in a copied template ---------------------------
  for (const [key, value] of Object.entries(candidate)) {
    if (PLACEHOLDERS.some((token) => value.includes(token))) {
      problems.push({
        severity: 'error',
        key,
        // Names the key and the fact, never the value.
        message: 'still contains a template placeholder',
      });
    }
  }

  // --- 4. Keys the application will silently ignore ------------------------
  const known = new Set<string>(CONFIG_KEYS as readonly string[]);
  for (const key of Object.keys(env)) {
    // Not an error: a deployment legitimately carries variables for other
    // things (a log shipper, a sidecar). It is a warning because the failure it
    // most often signals — REDIS_HOST where the application reads REDIS_URL —
    // is completely silent otherwise.
    if (!known.has(key)) {
      problems.push({
        severity: 'warning',
        key,
        message: 'is not read by the application; setting it has no effect',
      });
    }
  }

  return problems;
}

function main(): void {
  const args = process.argv.slice(2);
  const path = args.find((a) => !a.startsWith('--')) ?? '.env.production';
  const envIndex = args.indexOf('--env');
  const override = envIndex >= 0 ? args[envIndex + 1] : undefined;

  let contents: string;
  try {
    contents = readFileSync(path, 'utf8');
  } catch {
    console.error(`Cannot read ${path}.`);
    process.exit(2);
  }

  const problems = checkEnv(parseEnvFile(contents), override);
  const errors = problems.filter((p) => p.severity === 'error');
  const warnings = problems.filter((p) => p.severity === 'warning');

  for (const w of warnings) console.warn(`  warning  ${w.key}  ${w.message}`);
  for (const e of errors) console.error(`  ERROR    ${e.key}  ${e.message}`);

  if (errors.length > 0) {
    console.error(`\n${path} is NOT deployable — ${errors.length} error(s).`);
    process.exit(1);
  }
  console.log(
    `${path} passes the same schema the server enforces at startup` +
      (warnings.length > 0 ? ` (${warnings.length} warning(s)).` : '.'),
  );
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main();
}
