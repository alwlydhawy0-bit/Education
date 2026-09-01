/**
 * Secret scanner.
 *
 * A deliberately small, dependency-free gate that runs in CI and pre-commit. It
 * is NOT a replacement for a real scanner (gitleaks, trufflehog) — see
 * docs/security/limitations.md. It exists so that the most common accidents
 * (a pasted key, a real password in a config file, a committed .env) fail the
 * build today rather than after a vendor is onboarded.
 *
 * Exit code 1 on any finding.
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '../..');

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.vitest']);

/**
 * Files git IGNORES and does NOT track.
 *
 * These are skipped, and the reasoning is the scanner's own stated purpose: it
 * exists so that a secret cannot reach the REPOSITORY ("a committed .env", in
 * the header above). A file that is ignored and untracked cannot be committed,
 * so a finding in one is not the accident this gate is for.
 *
 * It matters because the documented local setup creates exactly such a file:
 * `cp .env.example .env`, then fill in real local credentials. Failing the
 * security gate for following the README teaches developers that the secret
 * scanner cries wolf, which costs more than it buys.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO: skip by filename. Tracked files are
 * always scanned, whatever `.gitignore` says — so `git add -f .env`, or
 * removing `.env` from `.gitignore`, puts the file straight back in scope. The
 * check is "can this reach the repository?", not "is this called .env".
 *
 * Fails OPEN: if git is unavailable (a tarball, a container without git), the
 * set is empty and everything is scanned, which is the safe direction.
 */
function ignoredAndUntracked(): { files: ReadonlySet<string>; dirs: readonly string[] } {
  try {
    // `--directory` collapses a wholly-ignored directory into ONE entry.
    // Without it git enumerates every file under node_modules — over a
    // megabyte here, which overruns execFileSync's default maxBuffer and
    // throws ENOBUFS. The catch below would then swallow it and skip nothing,
    // so the flag is what makes this work at all rather than a tidiness.
    const output = execFileSync(
      'git',
      ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z'],
      {
        cwd: ROOT,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        maxBuffer: 16 * 1024 * 1024,
      },
    );
    const entries = output.split('\0').filter((entry) => entry.length > 0);
    return {
      files: new Set(entries.filter((e) => !e.endsWith('/')).map((e) => resolve(ROOT, e))),
      dirs: entries.filter((e) => e.endsWith('/')).map((e) => resolve(ROOT, e) + '/'),
    };
  } catch {
    return { files: new Set<string>(), dirs: [] };
  }
}

const SKIPPED = ignoredAndUntracked();

function cannotReachRepository(file: string): boolean {
  return SKIPPED.files.has(file) || SKIPPED.dirs.some((dir) => file.startsWith(dir));
}

const SCANNED_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.json',
  '.yml',
  '.yaml',
  '.sql',
  '.md',
  '.env',
  '.sh',
  '.html',
]);

interface Rule {
  readonly name: string;
  readonly pattern: RegExp;
}

const RULES: readonly Rule[] = [
  { name: 'AWS access key id', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'GitHub token', pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { name: 'Slack token', pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: 'Google API key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: 'Stripe secret key', pattern: /\bsk_live_[0-9a-zA-Z]{16,}\b/ },
  { name: 'OpenAI/Anthropic style key', pattern: /\bsk-(?:ant-)?[A-Za-z0-9_-]{32,}\b/ },
  { name: 'Private key block', pattern: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/ },
  {
    name: 'JSON Web Token',
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
  },
  {
    name: 'Hardcoded password assignment',
    pattern: /\b(?:password|passwd|secret|api_?key)\s*[:=]\s*['"][^'"\s]{8,}['"]/i,
  },
  {
    name: 'Database URL with an embedded password',
    pattern: /\b(?:postgres|postgresql|mysql|mongodb)(?:\+\w+)?:\/\/[^\s:'"]+:[^\s@'"]+@/i,
  },
];

/**
 * Lines carrying this marker are exempt.
 *
 * Every exemption in the repository must name a reason, and the reviewer of the
 * commit that adds one is expected to check it. The test fixtures and the local
 * development defaults are the only current users.
 */
const ALLOW_MARKER = 'secret-scan-allow';

interface Finding {
  readonly file: string;
  readonly line: number;
  readonly rule: string;
}

/**
 * A connection string whose password segment is a shell/template variable or an
 * obvious placeholder is documentation, not a leaked credential.
 *
 * This is a precision fix, not a loophole: it matches only on the SHAPE of the
 * password component, so a real secret still trips the rule no matter which
 * file it sits in. Broad per-file exemptions were the alternative, and those rot
 * — a genuine credential added to an exempted file would never be seen.
 */
const PLACEHOLDER_PASSWORD =
  /^(?:\$\{?[A-Za-z_][A-Za-z0-9_]*\}?|CHANGE_ME|REPLACE_ME|<[^>]+>|\*+|x+|password|changeme)$/i;

const URL_WITH_PASSWORD =
  /\b(?:postgres|postgresql|mysql|mongodb)(?:\+\w+)?:\/\/[^\s:'"]+:([^\s@'"]+)@/i;

function isPlaceholderConnectionString(line: string): boolean {
  const match = URL_WITH_PASSWORD.exec(line);
  const password = match?.[1];
  return password !== undefined && PLACEHOLDER_PASSWORD.test(password);
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (SCANNED_EXTENSIONS.has(extname(entry)) || entry.startsWith('.env')) out.push(full);
  }
  return out;
}

function scan(): Finding[] {
  const findings: Finding[] = [];
  for (const file of walk(ROOT)) {
    // Never scan this file: it necessarily contains the patterns themselves.
    if (file === resolve(import.meta.dirname, 'scan-secrets.ts')) continue;
    // Cannot reach the repository — see `ignoredAndUntracked`.
    if (cannotReachRepository(file)) continue;

    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, index) => {
      if (line.includes(ALLOW_MARKER)) return;
      for (const rule of RULES) {
        if (
          rule.name === 'Database URL with an embedded password' &&
          isPlaceholderConnectionString(line)
        ) {
          continue;
        }
        if (rule.pattern.test(line)) {
          findings.push({ file: relative(ROOT, file), line: index + 1, rule: rule.name });
        }
      }
    });
  }
  return findings;
}

const findings = scan();

if (findings.length > 0) {
  console.error(`\nSecret scan FAILED — ${findings.length} finding(s):\n`);
  for (const finding of findings) {
    console.error(`  ${finding.file}:${finding.line}  ${finding.rule}`);
  }
  console.error(
    '\nIf a finding is a false positive, append a comment containing ' +
      `"${ALLOW_MARKER}" to that line, together with the reason.\n`,
  );
  process.exit(1);
}

console.log(`Secret scan passed — no findings across ${walk(ROOT).length} scanned files.`);
