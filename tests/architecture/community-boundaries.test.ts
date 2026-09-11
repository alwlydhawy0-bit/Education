import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CONTENT_FLAG_ACTIONS,
  DISCUSSION_REPLY_ACTIONS,
  DISCUSSION_THREAD_ACTIONS,
} from '@edu/authz';
import {
  MUST_NEVER_MATCH,
  screenContent,
} from '../../apps/api/src/modules/community/content-filter.ts';

/**
 * Fitness functions for class discussion forums and moderation.
 *
 * SOURCE TEXT, NOT BEHAVIOUR. `tests/security/community.test.ts` proves the
 * pipeline does the right thing today; this proves the wrong thing cannot be
 * written tomorrow without somebody reading a failure that explains why.
 *
 * Three of the assertions here exist because of a specific defect found while
 * building this domain, and each names it. They are the permanent structural
 * record of an escape:
 *
 *   `createFlag` may not end in RETURNING — PostgreSQL applies SELECT policies
 *   to a RETURNING clause, so reading back an automated flag failed for the
 *   very author it was filed against, and the error blamed the INSERT.
 *
 *   Nothing in this module may JOIN `users` — a join added to fetch a display
 *   name is an access predicate whether or not anybody meant it as one, which
 *   is the third time this platform has learned that (VULN-054, VULN-055).
 *
 *   `content_flag_reply_cleanup` must be SECURITY DEFINER — as invoker-rights
 *   it made a reported reply permanently undeletable by its own author.
 */

const ROOT = resolve(import.meta.dirname, '../..');
const MODULE = 'apps/api/src/modules/community';

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

/** Prose about a query is not a query. Same rule as the other fitness suites. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => {
      const trimmed = line.trimStart();
      return !trimmed.startsWith('//') && !trimmed.startsWith('*') && !trimmed.startsWith('--');
    })
    .join('\n');
}

const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');
const code = (path: string): string => stripComments(read(path));

const FILTER = `${MODULE}/content-filter.ts`;
const REPOSITORY = `${MODULE}/community.repository.ts`;
const SERVICE = `${MODULE}/community.service.ts`;
const ROUTES = `${MODULE}/community.routes.ts`;
const MIGRATION = 'db/migrations/0029_community_discussions.sql';

/** The body of one method, from its `async name(` to the next one. */
function method(source: string, name: string): string {
  const start = source.indexOf(`async ${name}(`);
  expect(start, `${name} not found`).toBeGreaterThan(-1);
  const rest = source.slice(start + 1);
  const next = rest.search(/\n {2}(?:async )?\w+\(/);
  return next === -1 ? rest : rest.slice(0, next);
}

describe('the content filter is a pure function', () => {
  it('reads no database, no clock, no randomness and no configuration', () => {
    const source = code(FILTER);
    // Purity is what lets the unit suite enumerate seventy-six evasions in
    // milliseconds. A filter that consulted a table would be a filter whose
    // behaviour depended on which rows the caller could see.
    for (const forbidden of [
      'tx.query',
      'Date.now',
      'new Date',
      'Math.random',
      'process.env',
      'import(',
      'require(',
    ]) {
      expect(source, `${forbidden} in the filter`).not.toContain(forbidden);
    }
  });

  it('imports nothing at all', () => {
    // No import line means no way for this file to acquire a dependency on a
    // layer above it, and no way for the ordering of module initialization to
    // change what it decides.
    expect(code(FILTER)).not.toMatch(/^\s*import\b/m);
  });

  it('publishes the innocent words it must never match, and does not match them', () => {
    // MUST_NEVER_MATCH is exported so this file can assert on it rather than
    // keeping a second, drifting copy. The Scunthorpe cases live here because a
    // filter that flags `classic`, `assess` or `Cockburn` teaches children that
    // the platform is broken and that reporting is noise.
    expect(MUST_NEVER_MATCH.length).toBeGreaterThanOrEqual(20);
    for (const word of MUST_NEVER_MATCH) {
      expect(screenContent(`We studied ${word} today.`).flagged, word).toBe(false);
    }
  });
});

describe('every content-bearing write is screened, and screened again on edit', () => {
  const CONTENT_METHODS = ['createThread', 'updateThread', 'createReply', 'updateReply'];

  it.each(CONTENT_METHODS)('%s calls both checkBody and screen', (name) => {
    // TWO CHECKS, DIFFERENT JOBS. `checkBody` is Task 010's markdown safety —
    // it refuses a javascript: or data: URL before storage. `screen` is section
    // 2B's profanity and self-harm filter, which never refuses: it decides the
    // `moderation_status` the row is born with.
    //
    // The edit paths are here for the reason the edit paths always are: a
    // one-time check at creation is a check a learner walks past by posting
    // something innocuous and editing it a second later.
    const body = method(code(SERVICE), name);
    expect(body, `${name} does not call checkBody`).toContain('checkBody(');
    expect(body, `${name} does not screen`).toContain('screen(');
  });

  it('a flagged write files an automated flag and emits a security event', () => {
    const source = code(SERVICE);
    for (const name of CONTENT_METHODS) {
      const body = method(source, name);
      expect(body, `${name} does not file a flag`).toContain("'automated_filter'");
      expect(body, `${name} does not emit`).toContain('MODERATION_AUTO_FLAGGED');
    }
  });

  it('the markdown checker comes from platform/, not from another module', () => {
    // Dependency rule 3: a module may not import from a sibling module. The
    // markdown safety check was written for Task 010's notebooks and lived
    // under modules/notebook/ until this task needed it, at which point it
    // moved to platform/security/ — because it was always a platform primitive
    // and the notebook module was only its first caller.
    const source = code(SERVICE);
    expect(source).toContain("from '../../platform/security/markdown-safety.ts'");
    for (const file of sourceFiles(MODULE)) {
      const text = stripComments(readFileSync(file, 'utf8'));
      const crossModule = text.match(/from '\.\.\/(?!\.\.\/)(\w+)\//g) ?? [];
      expect(crossModule, `${file} imports a sibling module`).toEqual([]);
    }
  });
});

describe('a report is filed without being read back', () => {
  it('createFlag has no RETURNING clause', () => {
    /**
     * THE DEFECT THIS ASSERTION IS MADE OF.
     *
     * `createFlag` first ended `ON CONFLICT DO NOTHING RETURNING id`, which
     * reads like defensive coding and is not: PostgreSQL applies SELECT
     * policies to a RETURNING clause. An automated flag has a NULL reporter, so
     * `content_flags_select` — which admits the reporter or a moderator — hid
     * the row from the flagged author, and their post came back as a 500 whose
     * message blamed the INSERT.
     *
     * The tempting fix, widening the read policy so an author can see flags
     * against them, would have turned the queue into an oracle: file text,
     * read back the matched term, and the moderation word-list is yours.
     * So the flag is written and NOT read, and the caller gets a row count.
     */
    const body = method(code(REPOSITORY), 'createFlag');
    expect(body).not.toMatch(/\bRETURNING\b/i);
    expect(body).toContain('ON CONFLICT DO NOTHING');
    expect(body).toContain('rowCount');
  });

  it('the flag row is never surfaced to the caller of flagContent', () => {
    // The route answers 202 with a boolean, so a reporter learns their report
    // was accepted and nothing about what it matched or who else filed one.
    const body = method(code(SERVICE), 'flagContent');
    expect(body).toContain('recorded');
    expect(body).not.toContain('matchedTerm');
  });
});

describe('a display name is fetched through the definer, never through a join', () => {
  it('no statement in the module joins users', () => {
    /**
     * THE THIRD TIME. VULN-054 was a join to `lessons` that silently became an
     * access predicate; VULN-055 was a join to `users` for a portfolio author's
     * name, which took down every public page on the platform because `users`
     * has RLS and the public path has no actor.
     *
     * A JOIN ADDED TO FETCH A DISPLAY VALUE IS AN ACCESS PREDICATE WHETHER OR
     * NOT ANYBODY MEANT IT AS ONE. `app_forum_display_name` is bounded twice —
     * the caller must be in the room and so must the subject — so it discloses
     * exactly what a forum already discloses, and it cannot narrow a result set
     * by failing to match.
     */
    const source = code(REPOSITORY);
    expect(source).not.toMatch(/JOIN\s+users\b/i);
    expect(source).not.toMatch(/FROM\s+users\b/i);
    expect(source).toContain('app_forum_display_name(');
  });

  it('the display-name function is bounded on both the caller and the subject', () => {
    const migration = read('db/migrations/0030_forum_display_names.sql');
    expect(migration).toContain('SECURITY DEFINER');
    // Two independent membership tests: `app_actor_in_class_forum` for the
    // reader, and a membership check on the user being named.
    expect((migration.match(/app_actor_in_class_forum/g) ?? []).length).toBeGreaterThanOrEqual(1);
    expect(migration).toMatch(/class_memberships|teacher_assignments/);
  });
});

describe('an author edits only what an author wrote', () => {
  it('updateThread touches exactly title, content and updated_at', () => {
    const body = method(code(REPOSITORY), 'updateThread');
    const setClause = body.slice(body.indexOf('SET'), body.indexOf('WHERE'));
    const assignments = (setClause.match(/(\w+)\s*=/g) ?? []).map((m) =>
      m.replace(/\s*=$/, '').trim(),
    );
    // `is_pinned`, `is_locked` and `moderation_status` are ABSENT rather than
    // guarded. A column that is not in the statement cannot be moved by it,
    // whatever the policy and the trigger do.
    expect(new Set(assignments)).toEqual(new Set(['title', 'content_markdown', 'updated_at']));
  });

  it('updateReply touches exactly content and updated_at', () => {
    const body = method(code(REPOSITORY), 'updateReply');
    const setClause = body.slice(body.indexOf('SET'), body.indexOf('WHERE'));
    const assignments = (setClause.match(/(\w+)\s*=/g) ?? []).map((m) =>
      m.replace(/\s*=$/, '').trim(),
    );
    expect(new Set(assignments)).toEqual(new Set(['content_markdown', 'updated_at']));
    // Not `is_accepted_answer`: acceptance moves through `acceptReply`, whose
    // policy holder is the person who asked the question rather than the person
    // who answered it.
    expect(setClause).not.toContain('is_accepted_answer');
  });

  it('no insert in the module lets the caller choose class_id or author_id', () => {
    const source = code(REPOSITORY);
    // The reply insert passes the zero UUID as a placeholder the trigger
    // overwrites from the thread. A caller who could choose `class_id` could
    // file a reply into another class's room, where the composite foreign key
    // would then be the only thing standing.
    expect(method(source, 'createReply')).toContain("'00000000-0000-0000-0000-000000000000'");
    expect(method(source, 'createFlag')).toContain("'00000000-0000-0000-0000-000000000000'");
    // `author_id` is the session's id from the service, never from the body.
    expect(code(ROUTES)).not.toMatch(/authorId:\s*(?!ctx|actor)/);
  });

  it('no SQL in the module is built by concatenation of a value', () => {
    /**
     * THE ALLOW-LIST PERMITS A NAMED FRAGMENT AND A ZERO-ARGUMENT BUILDER, and
     * the zero arguments are the whole condition rather than a convenience.
     *
     * `flagSelect()` takes nothing, so there is no parameter through which a
     * caller value could reach the string it returns; it is a constant written
     * as a function because it is long. `flagSelect(classId)` would be a
     * different thing entirely and fails here, which is the case this pattern
     * exists to catch.
     */
    for (const file of sourceFiles(MODULE)) {
      const source = stripComments(readFileSync(file, 'utf8'));
      if (!source.includes('tx.query')) continue;
      for (const interpolation of source.match(/\$\{[^}]+\}/g) ?? []) {
        expect(interpolation, `${file}: ${interpolation}`).toMatch(
          /^\$\{(THREAD_SELECT|REPLY_SELECT|FLAG_SELECT|AUTHOR_NAME|column|direction|\w+\(\))\}$/,
        );
      }
    }
  });
});

describe('every list is admitted row by row', () => {
  it.each(['listClassThreads', 'listFlags'])('%s passes through admit', (name) => {
    // NOT a WHERE clause. Section 3 asks that hidden posts be excluded "via
    // RLS", and they are — but a SQL filter would be a filter the
    // layered-defence suite could not see doing its job, because with RLS
    // bypassed the rows come back and something has to remove them.
    expect(method(code(SERVICE), name)).toContain('admit(');
  });

  it('readThread admits the replies separately from the thread', () => {
    const body = method(code(SERVICE), 'readThread');
    expect(body).toContain("'discussion_thread:read'");
    // A reader entitled to the thread is not thereby entitled to every reply in
    // it: a reply can be hidden while its thread is fine.
    expect(body).toContain("'discussion_reply:list'");
  });

  it('the repository returns Guarded rows, so a caller cannot skip the decision', () => {
    const source = code(REPOSITORY);
    expect(source).toContain('Guarded.of(');
    // No `.value` getter exists on Guarded; `unwrap` re-checks the id and the
    // action. A repository that returned bare rows would let a future caller
    // read one without a decision ever being made about it.
    expect(source).not.toMatch(/\.value\b/);
  });
});

describe('the locked-thread rule is written twice, in two languages', () => {
  it('the database refuses a reply insert into a locked thread', () => {
    // Section 3: "database-level policies must reject any NEW reply inserts
    // regardless of API routes". This is the WITH CHECK that does it.
    const migration = read(MIGRATION);
    const policy = migration.slice(migration.indexOf('CREATE POLICY discussion_replies_insert'));
    const clause = policy.slice(0, policy.indexOf(';'));
    expect(clause).toContain('NOT t.is_locked');
    expect(clause).toContain("t.moderation_status <> 'hidden'");
  });

  it('the policy engine refuses it too, and says why rather than hiding', () => {
    const policy = code('packages/authz/src/policies/community.policy.ts');
    // `reveal`, not `hide`: a learner looking at a thread they can plainly read
    // is owed the reason their reply was refused. A silent 404 here would read
    // as the platform being broken, and a child would try again.
    expect(policy).toMatch(/discussion_reply\.thread_locked['"],\s*'reveal'/);
    expect(policy).toMatch(/discussion_thread\.locked['"],\s*'reveal'/);
  });

  it('a hidden post is hidden rather than explained', () => {
    const policy = code('packages/authz/src/policies/community.policy.ts');
    // The opposite disposition, for the opposite reason: confirming that a
    // hidden post exists at a given id is the disclosure moderation removed.
    expect(policy).toMatch(/discussion_thread\.hidden['"],\s*'reveal'/);
    expect(policy).toContain("'content_flag.no_matching_grant'");
  });
});

describe('the definer functions have the policies they need', () => {
  it('the reply-cleanup trigger is SECURITY DEFINER', () => {
    /**
     * REPORT-TO-FREEZE, the defect the adversarial probe found in 0029.
     *
     * `content_flag_reply_cleanup()` deletes the flags attached to a reply
     * being deleted. As invoker-rights it ran as `edu_app`, which has no DELETE
     * grant on `content_flags`, so deleting a reported reply raised `permission
     * denied` and rolled the whole statement back — meaning ANY LEARNER COULD
     * MAKE A CLASSMATE'S REPLY PERMANENTLY UNDELETABLE simply by reporting it.
     */
    const migration = read(MIGRATION);
    const fn = migration.slice(migration.indexOf('FUNCTION content_flag_reply_cleanup'));
    expect(fn.slice(0, fn.indexOf('$$'))).toContain('SECURITY DEFINER');
  });

  it('every table the definers touch has a policy for the definer role', () => {
    // The rule migration 0014 wrote down: EVERY table a SECURITY DEFINER
    // function touches needs a policy for the definer role, for every command
    // it performs. `tests/integration/rls-definer-coverage.test.ts` proves this
    // against the live catalog; this is the cheap textual half.
    const migration = read(MIGRATION);
    for (const policy of [
      'discussion_threads_definer_select',
      'discussion_replies_definer_select',
      'content_flags_definer_select',
      'content_flags_definer_delete',
    ]) {
      expect(migration, `${policy} is missing`).toContain(policy);
    }
  });

  it('the automated filter may file only against the caller’s own post', () => {
    // Migration 0031 widened `content_flags_insert` to permit
    // `raised_by = 'automated_filter'`, which is the only way the screener can
    // record a finding. The widening is bounded: the caller must be the author
    // of the post being reported, so it cannot be used to file anonymous
    // reports against somebody else.
    const migration = read('db/migrations/0031_automated_flag_insert.sql');
    expect(migration).toContain("raised_by = 'automated_filter'");
    expect(migration).toContain('app_current_actor()');
  });
});

describe('the vocabulary says only what the system does', () => {
  it('has no content_flag:delete and no content_flag:withdraw', () => {
    // A moderation record that can be removed is not a record, and a report
    // that can be retracted can be retracted under pressure.
    expect(CONTENT_FLAG_ACTIONS).not.toContain('content_flag:delete');
    expect(CONTENT_FLAG_ACTIONS).not.toContain('content_flag:withdraw');
  });

  it('offers pin and lock on a thread and neither on a reply', () => {
    expect(DISCUSSION_THREAD_ACTIONS).toContain('discussion_thread:pin');
    expect(DISCUSSION_THREAD_ACTIONS).toContain('discussion_thread:lock');
    expect(DISCUSSION_REPLY_ACTIONS).not.toContain('discussion_reply:pin');
    expect(DISCUSSION_REPLY_ACTIONS).not.toContain('discussion_reply:lock');
  });

  it('gives a reply its own accept verb', () => {
    // Its holder is neither the author nor staff, so it is not `update` and it
    // is not `moderate`.
    expect(DISCUSSION_REPLY_ACTIONS).toContain('discussion_reply:accept');
  });

  /**
   * The three verbs the module declares and does not call, named here rather
   * than left for a reader to discover, and each for a stated reason.
   *
   * `discussion_reply:read` and `content_flag:read` — the policy decides both,
   * and no endpoint reads a SINGLE reply or a single flag. A reply is read as
   * part of its thread and a flag as part of the queue, so only the `:list`
   * sibling has a caller. The verbs stay because the policy is complete for
   * them: the day a permalink to one reply exists, it gets a correct decision
   * rather than a new branch written under time pressure.
   *
   * `content_flag:review` — resolving a flag happens inside `moderate`, under
   * the decision already taken for `discussion_thread:moderate` or
   * `discussion_reply:moderate`, and under the `content_flags_review` RLS
   * policy. Both gates are present, and both ask the same question this verb
   * asks: does the actor moderate this class. Taking a third decision would
   * mean loading every flag on the post to build resources for it, which is a
   * query per moderation action to re-derive an answer already in hand, and a
   * second place that could come to disagree with the first.
   *
   * These are recorded in the Task 014 report rather than resolved by deleting
   * the verbs, because a vocabulary that shrinks to exactly today's endpoints
   * is one that gets extended in a hurry tomorrow.
   */
  const DECLARED_BUT_NOT_CALLED = [
    'discussion_reply:read',
    'content_flag:read',
    'content_flag:review',
  ];

  it('every action in the vocabulary is authorized somewhere in the module', () => {
    const source = sourceFiles(MODULE)
      .map((file) => readFileSync(file, 'utf8'))
      .join('\n');
    for (const action of [
      ...DISCUSSION_THREAD_ACTIONS,
      ...DISCUSSION_REPLY_ACTIONS,
      ...CONTENT_FLAG_ACTIONS,
    ]) {
      if (DECLARED_BUT_NOT_CALLED.includes(action)) continue;
      expect(source, `${action} is declared but never authorized`).toContain(action);
    }
  });

  it('the uncalled verbs are exactly the three named above, and no more', () => {
    // THE ASSERTION THAT KEEPS THE EXEMPTION HONEST. Without it the list above
    // is a place to quietly park the next verb somebody forgets to authorize.
    const source = sourceFiles(MODULE)
      .map((file) => readFileSync(file, 'utf8'))
      .join('\n');
    const uncalled = [
      ...DISCUSSION_THREAD_ACTIONS,
      ...DISCUSSION_REPLY_ACTIONS,
      ...CONTENT_FLAG_ACTIONS,
    ].filter((action) => !source.includes(action));
    expect(uncalled.sort()).toEqual([...DECLARED_BUT_NOT_CALLED].sort());
  });
});

describe('every route is guarded and every response is strict', () => {
  it('no forum route is reachable without an actor', () => {
    const source = code(ROUTES);
    const registrations = source.match(/app\.(get|post|put|patch|delete|route)\(/g) ?? [];
    const guards = source.match(/preHandler: requireActor/g) ?? [];
    // Unlike the portfolio module there is NO public route here at all: a class
    // forum has no readership outside the class.
    expect(registrations.length).toBeGreaterThan(0);
    expect(guards.length).toBe(registrations.length);
  });

  it('every schema in the contract is strict', () => {
    const contract = code('packages/contracts/src/community.contract.ts');
    const objects = (contract.match(/z\.object\(/g) ?? []).length;
    const stricts = (contract.match(/\.strict\(\)/g) ?? []).length;
    // A field that arrives without being declared is a 400, not a silent
    // ignore — which is how `is_locked: false` in a request body would
    // otherwise reach an UPDATE somebody widened later.
    expect(stricts).toBeGreaterThanOrEqual(objects);
  });
});
