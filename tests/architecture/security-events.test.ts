import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { RESERVED_SECURITY_EVENT_TYPES, SecurityEventType } from '@edu/observability';

/**
 * Honesty check for the security-event taxonomy.
 *
 * Task 001 declared `ratelimit.exceeded` and never emitted it, so the taxonomy
 * advertised a detection capability the system did not have — the exact class of
 * false claim the brief forbids. Documentation cannot prevent that recurring;
 * this test can.
 *
 * The rule: every member of `SecurityEventType` must have a real emitter in the
 * API source. Future intent belongs in `RESERVED_SECURITY_EVENT_TYPES`, which is
 * inert by construction.
 */
const ROOT = resolve(import.meta.dirname, '../..');

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current)) {
      if (entry === 'node_modules' || entry === 'dist') continue;
      const full = join(current, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith('.ts')) out.push(full);
    }
  };
  walk(join(ROOT, dir));
  return out;
}

const apiSource = sourceFiles('apps/api/src')
  .map((file) => readFileSync(file, 'utf8'))
  .join('\n');

describe('every declared security event has an emitter', () => {
  const declared = Object.entries(SecurityEventType);

  it.each(declared)('%s is actually emitted somewhere in the API', (key) => {
    // A member referenced only by its own definition is a capability the system
    // claims but does not have.
    expect(apiSource).toContain(`SecurityEventType.${key}`);
  });

  it('declares at least the authentication and authorization outcomes', () => {
    const values = Object.values(SecurityEventType);
    expect(values).toContain('auth.login.failed');
    expect(values).toContain('authz.denied');
    expect(values).toContain('authz.repeated_denial');
    expect(values).toContain('ratelimit.exceeded');
  });
});

describe('reserved event types are inert', () => {
  it.each(RESERVED_SECURITY_EVENT_TYPES)('%s is not in the live taxonomy', (reserved) => {
    expect(Object.values(SecurityEventType)).not.toContain(reserved);
  });

  it('is not emitted anywhere, since the features do not exist', () => {
    for (const reserved of RESERVED_SECURITY_EVENT_TYPES) {
      expect(apiSource).not.toContain(`'${reserved}'`);
    }
  });
});

describe('security events are recorded through the recorder, not the audit writer', () => {
  it('only the recorder calls audit.write', () => {
    // The recorder performs repeated-denial detection. A module writing straight
    // to the audit writer would bypass it, leaving a blind spot exactly where
    // enumeration would show up.
    const offenders = sourceFiles('apps/api/src')
      .filter((file) => !file.endsWith('security/security-events.ts'))
      .filter((file) => /\baudit\.write\(/.test(readFileSync(file, 'utf8')))
      .map((file) => file.replace(`${ROOT}/`, ''));
    expect(offenders).toEqual([]);
  });
});
