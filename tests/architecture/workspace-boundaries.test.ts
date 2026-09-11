import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ALLOWED_CONTENT_TYPES, registerArtifactRequestSchema } from '@edu/contracts';

/**
 * Fitness functions for the student workspace.
 *
 * These assert on SOURCE TEXT rather than on behaviour, which is the point: a
 * behavioural test proves the code does the right thing today, a structural one
 * proves the wrong thing cannot be written tomorrow without somebody reading a
 * failure that explains why.
 *
 * Four properties are pinned here, and the first is the one the whole markdown
 * decision rests on.
 */

const ROOT = resolve(import.meta.dirname, '../..');

function sourceFiles(dir: string): string[] {
  const absolute = join(ROOT, dir);
  const out: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current)) {
      if (entry === 'node_modules' || entry === 'dist') continue;
      const full = join(current, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry)) out.push(full);
    }
  };
  walk(absolute);
  return out;
}

/** Same rule as `dependency-rules.test.ts`: prose about a sink is not a sink. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => {
      const trimmed = line.trimStart();
      return !trimmed.startsWith('//') && !trimmed.startsWith('*');
    })
    .join('\n');
}

const webCode = sourceFiles('apps/web/src').map(
  (file) => [relative(ROOT, file), stripComments(readFileSync(file, 'utf8'))] as const,
);

const apiCode = sourceFiles('apps/api/src').map(
  (file) => [relative(ROOT, file), stripComments(readFileSync(file, 'utf8'))] as const,
);

const MIGRATION = readFileSync(join(ROOT, 'db/migrations/0025_student_workspace.sql'), 'utf8');

describe('no HTML sink exists, which is why markdown is stored verbatim', () => {
  /**
   * THE ASSERTION THE MARKDOWN DECISION DEPENDS ON.
   *
   * `checkMarkdown` refuses executable schemes in link destinations and leaves
   * everything else alone — including raw HTML in a note's body. That is safe
   * for exactly one reason: nothing renders a note as HTML. If somebody adds a
   * renderer without a sanitizer, this test is what tells them the assumption
   * they are breaking.
   */
  const SINKS =
    /dangerouslySetInnerHTML|\.innerHTML|\.outerHTML|insertAdjacentHTML|document\.write/;

  it('the web app contains no HTML injection sink', () => {
    const violations = webCode.filter(([, code]) => SINKS.test(code)).map(([name]) => name);
    expect(violations).toEqual([]);
  });

  it('the API contains no HTML injection sink either', () => {
    // The API returns JSON, so a sink here would be stranger still — a
    // server-rendered fragment nobody planned for.
    const violations = apiCode.filter(([, code]) => SINKS.test(code)).map(([name]) => name);
    expect(violations).toEqual([]);
  });

  it('no markdown-to-HTML renderer is installed', () => {
    // A renderer in `package.json` and no sanitizer beside it is the shape of
    // the next stored-XSS bug. If one arrives, this fails and the reviewer has
    // to decide about sanitization deliberately.
    const manifests = ['package.json', 'apps/web/package.json', 'apps/api/package.json'];
    const renderers = /"(marked|markdown-it|remark-html|showdown|snarkdown|micromark)"/;
    for (const manifest of manifests) {
      const text = readFileSync(join(ROOT, manifest), 'utf8');
      expect(renderers.test(text), manifest).toBe(false);
    }
  });
});

describe('no client ever names a storage location', () => {
  it('the register-artifact contract rejects every path-shaped field', () => {
    const valid = {
      artifactType: 'image' as const,
      declaredContentType: 'image/png',
      byteSize: 1024,
    };
    for (const key of ['storageKey', 'filePath', 'fileUrl', 'url', 'path', 'location', 'bucket']) {
      expect(registerArtifactRequestSchema.safeParse({ ...valid, [key]: '/x' }).success, key).toBe(
        false,
      );
    }
  });

  it('the storage key is built in SQL and nowhere else', () => {
    // Grep for the assignment rather than for the concept: if a future service
    // starts composing keys in TypeScript, two writers will disagree about the
    // layout and one of them will win silently.
    expect(MIGRATION).toMatch(/NEW\.storage_key\s*:=/);
    const violations = apiCode
      .filter(([, code]) => /storage_key\s*=|storageKey\s*[:=]\s*['"`]org\//.test(code))
      .map(([name]) => name);
    expect(violations).toEqual([]);
  });

  it('the key carries the organization, so tenants cannot collide', () => {
    expect(MIGRATION).toMatch(/'org\/'\s*\|\|/);
    expect(MIGRATION).toMatch(/'\/user\/'\s*\|\|/);
  });
});

describe('the workspace is owner-only, structurally', () => {
  it('every RLS policy on the workspace tables tests the current actor', () => {
    const block = MIGRATION.slice(MIGRATION.indexOf('ROW LEVEL SECURITY'));
    const policies = [...block.matchAll(/CREATE POLICY (student_\w+) ON (\w+)([\s\S]*?);/g)];
    expect(policies.length).toBeGreaterThan(6);

    const forAppRole = policies.filter((m) => /TO edu_app/.test(m[3] ?? ''));
    expect(forAppRole.length).toBeGreaterThan(5);
    for (const match of forAppRole) {
      expect(match[3], match[1]).toMatch(/owner_id = app_current_actor\(\)/);
    }
  });

  it('grants no UPDATE on artifacts, so the quota cannot be edited around', () => {
    const grants = MIGRATION.split('\n')
      .map((line) => line.replace(/--.*$/, '').trim())
      .filter((line) => /^GRANT\b/i.test(line) && /student_artifacts/.test(line));
    expect(grants).toHaveLength(1);
    expect(grants[0]).not.toMatch(/UPDATE/i);
  });

  it('has no UPDATE policy on artifacts either', () => {
    expect(MIGRATION).not.toMatch(/CREATE POLICY student_artifacts_update/);
  });

  it('enforces the quota in a trigger rather than in the service', () => {
    // An application that reads a total and then inserts loses a race with a
    // very cheap exploit. The check has to sit under the insert's own lock.
    expect(MIGRATION).toMatch(/BEFORE INSERT ON student_artifacts/);
    expect(MIGRATION).toMatch(/quota exceeded/i);

    const violations = apiCode
      .filter(([, code]) => /sum\(byte_size\)/i.test(code))
      .map(([name]) => name);
    expect(violations, 'the service must not compute the quota itself').toEqual([]);
  });

  it('ties every parent to its owner with a COMPOSITE foreign key', () => {
    // Not a trigger and not a policy clause: referential integrity, which holds
    // against every writer including the migration role, and needs no privilege
    // widening on the platform's most private table.
    for (const constraint of [
      'notes_notebook_same_owner_fk',
      'student_artifacts_note_same_owner_fk',
      'student_artifacts_session_same_owner_fk',
    ]) {
      expect(MIGRATION, constraint).toMatch(new RegExp(`CONSTRAINT ${constraint}`));
    }
    // Each names owner_id in the referencing column list.
    expect(MIGRATION).toMatch(/FOREIGN KEY \(notebook_id, owner_id\)/);
    expect(MIGRATION).toMatch(/FOREIGN KEY \(note_id, owner_id\)/);
    expect(MIGRATION).toMatch(/FOREIGN KEY \(session_id, owner_id\)/);
  });

  it('deletes a parent WITHOUT deleting the child’s work', () => {
    // Column-specific SET NULL. Without naming the column the clause would try
    // to null `owner_id`, which is NOT NULL — and a plain CASCADE would destroy
    // a term of revision notes because somebody tidied a folder.
    const clauses = [...MIGRATION.matchAll(/ON DELETE SET NULL \((\w+)\)/g)].map((m) => m[1]);
    expect(clauses).toEqual(expect.arrayContaining(['notebook_id', 'note_id', 'session_id']));
  });
});

describe('the file-type rule is an allow-list', () => {
  it('permits no executable or markup type for an image', () => {
    // SVG above all: a document that can carry script, dressed as a picture.
    const dangerous = ['image/svg+xml', 'text/html', 'application/xhtml+xml', 'text/xml'];
    for (const [kind, allowed] of Object.entries(ALLOWED_CONTENT_TYPES)) {
      for (const type of dangerous) {
        expect(allowed, `${kind} must not accept ${type}`).not.toContain(type);
      }
    }
  });

  it('is exhaustive over the artifact types the database accepts', () => {
    // A type the CHECK constraint permits but the allow-list forgets would be
    // an artifact kind nobody can ever register.
    const inSql = [...MIGRATION.matchAll(/artifact_type IN \(([^)]*)\)/g)][0]?.[1] ?? '';
    const types = [...inSql.matchAll(/'(\w+)'/g)].map((m) => m[1] as string);
    expect(types.sort()).toEqual(Object.keys(ALLOWED_CONTENT_TYPES).sort());
  });
});
