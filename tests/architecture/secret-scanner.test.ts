import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * The secret scanner's own behaviour, exercised end to end.
 *
 * Task 009A tightened `walk`'s file selection: files that git IGNORES **and**
 * does not track are skipped, because the accident the gate exists to prevent
 * is a secret reaching the REPOSITORY, and such a file cannot. The documented
 * local setup produces exactly one — `cp .env.example .env`, then fill in real
 * credentials — and failing the security gate for following the README teaches
 * developers that the scanner cries wolf, which costs more than it buys.
 *
 * That change makes the scanner MORE precise, and these tests exist to prove it
 * did not make it weaker. The whole risk of the change is in the two negative
 * cases below: a tracked file, and a force-added one. Both must still fail.
 *
 * The scanner resolves its root as `../..` from its own location, so each case
 * builds a throwaway repository with that shape and runs the real script in it.
 * Nothing here inspects the live repository, so the tests cannot pass by
 * accident because of how this checkout happens to be arranged.
 */
const REPO = resolve(import.meta.dirname, '../..');
const SCANNER = join(REPO, 'tools/security/scan-secrets.ts');

/** A connection string with a NON-placeholder password — a real finding. */
const SECRET_LINE = 'DATABASE_URL=postgres://edu_app:s3cr3t-not-a-placeholder@10.0.0.5:5432/edu'; // secret-scan-allow: fabricated fixture whose whole purpose is to be detected by the scanner under test

let sandbox: string;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'secret-scan-'));
  mkdirSync(join(sandbox, 'tools/security'), { recursive: true });
  cpSync(SCANNER, join(sandbox, 'tools/security/scan-secrets.ts'));
  writeFileSync(join(sandbox, '.gitignore'), '.env\n');
  const git = (...args: string[]): void => {
    execFileSync('git', args, { cwd: sandbox, stdio: 'ignore' });
  };
  git('init', '-q');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'Test');
  // The .gitignore must be tracked for `--exclude-standard` to honour it.
  git('add', '.gitignore');
  git('commit', '-qm', 'init');
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

/** Runs the scanner in the sandbox. Returns its exit code and output. */
function runScanner(): { code: number; output: string } {
  try {
    const output = execFileSync(
      process.execPath,
      ['--experimental-strip-types', 'tools/security/scan-secrets.ts'],
      { cwd: sandbox, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    return { code: 0, output };
  } catch (error) {
    const e = error as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, output: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

const track = (file: string, force = false): void => {
  execFileSync('git', force ? ['add', '-f', file] : ['add', file], {
    cwd: sandbox,
    stdio: 'ignore',
  });
};

describe('the secret scanner', () => {
  it('passes on a clean tree', () => {
    expect(runScanner().code).toBe(0);
  });

  it('SKIPS a secret in a file git ignores and does not track', () => {
    // The documented local `.env`. It cannot be committed, so it is not the
    // accident this gate is for.
    writeFileSync(join(sandbox, '.env'), `${SECRET_LINE}\n`);
    const result = runScanner();
    expect(result.code).toBe(0);
    expect(result.output).not.toMatch(/\.env/);
  });

  it('CATCHES a secret in a tracked file', () => {
    // The case that must never regress: a secret on its way into history.
    writeFileSync(join(sandbox, 'config.ts'), `export const url = '${SECRET_LINE}';\n`);
    track('config.ts');
    const result = runScanner();
    expect(result.code).toBe(1);
    expect(result.output).toMatch(/config\.ts/);
  });

  it('CATCHES a secret in an untracked file that is NOT ignored', () => {
    // Not yet added, but nothing stops the next `git add .` from taking it.
    writeFileSync(join(sandbox, 'notes.md'), `${SECRET_LINE}\n`);
    const result = runScanner();
    expect(result.code).toBe(1);
    expect(result.output).toMatch(/notes\.md/);
  });

  it('CATCHES an ignored file once it is force-added', () => {
    // `git add -f .env` defeats .gitignore, so the file is back in scope. The
    // rule is "can this reach the repository?", never "is it called .env".
    writeFileSync(join(sandbox, '.env'), `${SECRET_LINE}\n`);
    expect(runScanner().code).toBe(0);
    track('.env', true);
    const result = runScanner();
    expect(result.code).toBe(1);
    expect(result.output).toMatch(/\.env/);
  });

  it('CATCHES the secret again if .env stops being ignored', () => {
    writeFileSync(join(sandbox, '.env'), `${SECRET_LINE}\n`);
    expect(runScanner().code).toBe(0);
    writeFileSync(join(sandbox, '.gitignore'), '# nothing ignored\n');
    expect(runScanner().code).toBe(1);
  });

  it('still ignores a placeholder password, tracked or not', () => {
    // The pre-existing carve-out for `.env.example`, unchanged by this work.
    writeFileSync(
      join(sandbox, '.env.example'),
      'DATABASE_URL=postgres://edu_app:CHANGE_ME@127.0.0.1:5432/edu_dev\n',
    );
    track('.env.example');
    expect(runScanner().code).toBe(0);
  });
});
