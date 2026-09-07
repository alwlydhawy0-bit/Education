import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AI_CONVERSATION_ACTIONS } from '@edu/authz';
import { TUTOR_MAX_QUESTION_CHARACTERS } from '@edu/contracts';
import { MAX_QUESTION_CHARACTERS } from '../../apps/api/src/modules/tutor/guardrails.ts';

/**
 * Fitness functions for the AI tutor.
 *
 * SOURCE TEXT, NOT BEHAVIOUR. `tests/security/ai-tutor.test.ts` proves the
 * pipeline does the right thing today; this proves the wrong thing cannot be
 * written tomorrow without somebody reading a failure that explains why.
 *
 * The properties here are the ones a passing behavioural suite would not notice
 * being broken — mostly because breaking them produces the same responses, and
 * only the shape of the code differs.
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

const TUTOR_DIR = 'apps/api/src/modules/tutor';
const SERVICE = stripComments(read(`${TUTOR_DIR}/tutor.service.ts`));
const REPOSITORY = stripComments(read(`${TUTOR_DIR}/tutor.repository.ts`));
const ROUTES = stripComments(read(`${TUTOR_DIR}/tutor.routes.ts`));
const CONTRACT = stripComments(read('packages/contracts/src/tutor.contract.ts'));
const MIGRATION = read('db/migrations/0027_ai_tutor_conversations.sql');

/**
 * The migration with its `--` comments removed.
 *
 * Structural assertions run against this rather than the raw file, and the
 * first version of this suite failed for want of it: a regex ending at the
 * first `;` stopped inside a prose comment, and a `GRANT ... ON ai_messages`
 * matcher spanned two statements because the text between them was prose. Prose
 * about a policy is not a policy — the same rule the other fitness suites apply
 * to TypeScript.
 */
const MIGRATION_SQL = MIGRATION.split('\n')
  .map((line) => line.replace(/--.*$/, ''))
  .join('\n');

const apiCode = sourceFiles('apps/api/src').map(
  (file) => [relative(ROOT, file), stripComments(readFileSync(file, 'utf8'))] as const,
);

describe('a tutor turn cannot be forged', () => {
  it('has EXACTLY ONE call site for the platform-turn marker', () => {
    // The marker is what lets a non-student `sender_type` past the RLS policy.
    // Migration 0027 is explicit that this is a PATH marker, not an identity
    // check — so its value depends entirely on the path being singular and
    // greppable. A second call site would not fail any behavioural test.
    const callers = apiCode.filter(([, source]) => source.includes('ai_begin_platform_turn'));
    expect(callers.map(([file]) => file)).toEqual([`${TUTOR_DIR}/tutor.repository.ts`]);
    const occurrences = REPOSITORY.split('ai_begin_platform_turn').length - 1;
    expect(occurrences).toBe(1);
  });

  it('has exactly two INSERT statements against ai_messages, both in the repository', () => {
    const inserters = apiCode.filter(([, source]) => /INSERT INTO ai_messages/i.test(source));
    expect(inserters.map(([file]) => file)).toEqual([`${TUTOR_DIR}/tutor.repository.ts`]);
    expect(REPOSITORY.match(/INSERT INTO ai_messages/gi)).toHaveLength(2);
  });

  it('writes the student sender type as a LITERAL, never as a parameter', () => {
    // A `sender_type` bound from a variable in the student path is one refactor
    // away from being bound from a request field.
    expect(REPOSITORY).toMatch(/VALUES \(\$1, \$2, 'student'/);
  });

  it('gives the REQUEST schemas no senderType, ownerId, studentId or seq field', () => {
    // Scoped to the request schemas on purpose. `senderType` is present on the
    // RESPONSE — a reader has to know who said what — and asserting its total
    // absence would be asserting the wrong property. What must not exist is a
    // way for a CALLER to state it.
    const requests = [
      /export const createConversationRequestSchema[\s\S]*?\.strict\(\);/.exec(CONTRACT)?.[0],
      /export const sendMessageRequestSchema[\s\S]*?\.strict\(\);/.exec(CONTRACT)?.[0],
    ];
    for (const schema of requests) {
      expect(schema).toBeDefined();
      for (const forbidden of ['senderType', 'ownerId', 'studentId', 'seq', 'courseId']) {
        expect(schema, `a request schema accepts ${forbidden}`).not.toContain(forbidden);
      }
      // `.strict()` is what makes the absence a 400 rather than a silent drop.
      expect(schema).toContain('.strict()');
    }
  });

  it('gives the wire contract no way to supply context, history or instructions', () => {
    // A caller supplying these would be choosing what the tutor is grounded in,
    // which is the whole security property of a RAG pipeline handed back.
    for (const forbidden of ['systemPrompt', 'instructions', 'history:', 'sources:', 'context:']) {
      expect(CONTRACT, `the contract accepts ${forbidden}`).not.toContain(forbidden);
    }
  });
});

describe('the transcript is append-only', () => {
  it('grants no UPDATE and no DELETE on ai_messages', () => {
    const grants = [...MIGRATION_SQL.matchAll(/GRANT[^;]*?ON ai_messages[^;]*;/g)].map((m) => m[0]);
    expect(grants.length).toBeGreaterThan(0);
    for (const grant of grants) {
      expect(grant).not.toMatch(/\bUPDATE\b/);
      expect(grant).not.toMatch(/\bDELETE\b/);
    }
  });

  it('defines no UPDATE or DELETE policy on ai_messages either', () => {
    expect(MIGRATION_SQL).not.toMatch(/CREATE POLICY[^;]*ON ai_messages\s+FOR UPDATE/);
    expect(MIGRATION_SQL).not.toMatch(/CREATE POLICY[^;]*ON ai_messages\s+FOR DELETE/);
  });

  it('has no UPDATE or DELETE against ai_messages anywhere in application code', () => {
    for (const [file, source] of apiCode) {
      expect(source, `${file} updates ai_messages`).not.toMatch(/UPDATE ai_messages/i);
      expect(source, `${file} deletes ai_messages`).not.toMatch(/DELETE FROM ai_messages/i);
    }
  });

  it('exposes no DELETE route for a conversation', () => {
    // Archiving withdraws a conversation and leaves it readable. `DELETE` would
    // promise something this platform deliberately does not do.
    expect(ROUTES).not.toMatch(/app\.delete/);
  });
});

describe('ownership is structural, not a lookup', () => {
  it('ties a message to its conversation AND owner with one composite foreign key', () => {
    // The first draft asked a SECURITY DEFINER helper and got NULL for every
    // row, because FORCE ROW LEVEL SECURITY binds the table owner too and every
    // policy is TO edu_app. Referential integrity runs beneath all of that.
    expect(MIGRATION_SQL).toMatch(
      /FOREIGN KEY \(conversation_id, owner_id\)\s*\n?\s*REFERENCES ai_conversations \(id, student_id\)/,
    );
    expect(MIGRATION_SQL).toContain('UNIQUE (id, student_id)');
  });

  it('checks ownership in the message policy with a plain comparison', () => {
    const policy = /CREATE POLICY ai_messages_insert[\s\S]*?;/.exec(MIGRATION_SQL)?.[0];
    expect(policy).toBeDefined();
    expect(policy).toContain('owner_id = app_current_actor()');
    // No function call and no subquery: both are places a privilege subtlety
    // could answer NULL, which is exactly how the first draft failed.
    expect(policy).not.toMatch(/SELECT/i);
  });
});

describe('the conversation scope is derived, never asserted', () => {
  it('derives course and organization from the lesson in a trigger', () => {
    const guard = /CREATE FUNCTION ai_conversation_scope_guard[\s\S]*?\$\$;/.exec(MIGRATION_SQL)?.[0];
    expect(guard).toBeDefined();
    expect(guard).toContain('NEW.course_id       := v_course');
    expect(guard).toContain('app_course_organization(v_course)');
  });

  it('RE-ASKS the assignment question on every turn, not only at creation', () => {
    // Task 009's rule: a revoked learner immediately loses the ability to
    // update an active session. Enrolment is a fact about now.
    const guard = /CREATE FUNCTION ai_message_sequence_guard[\s\S]*?\$\$;/.exec(MIGRATION_SQL)?.[0];
    expect(guard).toBeDefined();
    expect(guard).toContain('app_actor_may_study_lesson');
  });

  it('resolves the policy’s relationship facts in the same statement as the row', () => {
    // A second query could observe an enrolment that changed in between and
    // authorize against a world that no longer exists.
    expect(REPOSITORY).toContain('app_actor_observes_learner_lesson(c.student_id, c.lesson_id)');
    expect(REPOSITORY).toContain('app_actor_moderates_conversation(');
    expect(REPOSITORY).toContain('app_actor_may_study_lesson(c.lesson_id)');
  });

  it('uses the SAME helpers the RLS policies use, rather than re-deriving the joins', () => {
    // One definition of "teaches this learner", so the two gates cannot drift.
    for (const helper of ['app_actor_observes_learner_lesson', 'app_actor_moderates_conversation']) {
      expect(MIGRATION, `${helper} is not used by the migration`).toContain(helper);
      expect(REPOSITORY, `${helper} is not used by the repository`).toContain(helper);
    }
  });

  it('does not let a display join decide visibility', () => {
    // An inner join to `lessons` silently overrode the moderation policy and
    // hid a departed learner's own history; `lessons` is RLS-narrowed to the
    // classes an actor is in. A join added to fetch a title does not get a vote.
    expect(REPOSITORY).not.toMatch(/\n\s+JOIN lessons/);
    expect(REPOSITORY).toMatch(/LEFT JOIN lessons/);
  });
});

describe('the tutor never becomes the platform’s only gate', () => {
  it('re-retrieves sources every turn rather than carrying them forward', () => {
    // Carrying a conversation's sources forward would freeze the authorization
    // decision at the moment the conversation was opened.
    expect(SERVICE).toContain('coursesInScope');
    expect(SERVICE).toMatch(/knowledge\.similar\(/);
    expect(SERVICE).not.toMatch(/retrieved_context_chunks_json[\s\S]{0,200}history/);
  });

  it('intersects the conversation’s course with what the actor may study', () => {
    expect(SERVICE).toMatch(/reachable\.filter\(/);
  });

  it('authorizes BEFORE it retrieves, and retrieves before it generates', () => {
    const authorizeAt = SERVICE.indexOf("'ai_conversation:speak'");
    const retrieveAt = SERVICE.indexOf('coursesInScope');
    const generateAt = SERVICE.indexOf('provider.generateAnswer');
    expect(authorizeAt).toBeGreaterThan(-1);
    expect(retrieveAt).toBeGreaterThan(authorizeAt);
    expect(generateAt).toBeGreaterThan(retrieveAt);
  });

  it('SANITIZES BEFORE IT RETRIEVES, so a blocked turn spends no query', () => {
    expect(SERVICE.indexOf('sanitizeStudentTurn')).toBeLessThan(SERVICE.indexOf('coursesInScope'));
  });

  it('validates citations against the retrieved set', () => {
    expect(SERVICE).toMatch(/citedSourceIds/);
    expect(SERVICE).toMatch(/byId\.get\(/);
  });
});

describe('what the tutor may never read', () => {
  const PRIVATE_TABLES = [
    'student_notebooks',
    'student_artifacts',
    'notes',
    'assessment_answer_keys',
    'assessment_attempts',
  ];

  it('names no private or answer-key table anywhere in the module', () => {
    for (const [file, source] of apiCode) {
      if (!file.startsWith(TUTOR_DIR)) continue;
      for (const table of PRIVATE_TABLES) {
        expect(source, `${file} refers to ${table}`).not.toMatch(new RegExp(`\\b${table}\\b`));
      }
    }
  });

  it('reads only conversation and curriculum tables', () => {
    // An allow-list rather than a deny-list: a private table added by a future
    // task is covered the day it is created.
    const froms = [...REPOSITORY.matchAll(/\b(?:FROM|JOIN)\s+([a-z_]+)/g)].map((m) => m[1]);
    const ALLOWED = new Set(['ai_conversations', 'ai_messages', 'lessons', 'course_units']);
    for (const table of froms) {
      expect(ALLOWED.has(table!), `tutor.repository.ts reads ${table}`).toBe(true);
    }
  });

  it('gives ai_messages no column that could point at private work', () => {
    const createTable = /CREATE TABLE ai_messages[\s\S]*?\n\);/.exec(MIGRATION_SQL)?.[0];
    expect(createTable).toBeDefined();
    for (const forbidden of ['note_id', 'artifact_id', 'attempt_id', 'answer_key']) {
      expect(createTable, `ai_messages has a ${forbidden} column`).not.toContain(forbidden);
    }
  });

  it('stores chunk IDS on a message, never chunk bodies', () => {
    // A transcript is kept for years, so a copy of a lesson body inside one
    // outlives every correction ever made to the original.
    expect(SERVICE).toMatch(/sources: validated/);
    expect(SERVICE).not.toMatch(/sources: budget\.kept/);
  });
});

describe('instructions are server-authored constants', () => {
  it('builds the system prompt from constants with no interpolation', () => {
    const instructions = /const TUTOR_INSTRUCTIONS = \[[\s\S]*?\]\.join\(' '\);/.exec(SERVICE)?.[0];
    expect(instructions).toBeDefined();
    // A template literal here would be a place a caller could eventually reach.
    expect(instructions).not.toMatch(/\$\{/);
  });

  it('varies the stance by APPENDING a second constant, never by rewriting', () => {
    expect(SERVICE).toMatch(/\$\{TUTOR_INSTRUCTIONS\}\$\{TEACHING_STANCE\}/);
  });

  it('stores no system prompt in the database', () => {
    expect(MIGRATION_SQL).not.toMatch(/system_prompt|instructions\s+text/);
  });
});

describe('limits are layered rather than duplicated', () => {
  it('keeps the guardrail cap strictly BELOW the contract cap', () => {
    // Two limits at the same value means the inner one never fires and is dead
    // code that reads as a control — VULN-043.
    expect(MAX_QUESTION_CHARACTERS).toBeLessThan(TUTOR_MAX_QUESTION_CHARACTERS);
  });

  it('rate-limits both the turn and the conversation that multiplies it', () => {
    expect(ROUTES).toContain('RATE_LIMIT_POLICIES.tutorMessage');
    expect(ROUTES).toContain('RATE_LIMIT_POLICIES.tutorConversation');
  });
});

describe('the action vocabulary says what it means', () => {
  it('has no ai_conversation:update and no ai_conversation:moderate', () => {
    // `update` would be one verb meaning "change something"; moderation is not
    // an action but a reason for granting `read`, and making it its own action
    // would let it drift from the answer `read` gives.
    expect(AI_CONVERSATION_ACTIONS).not.toContain('ai_conversation:update');
    expect(AI_CONVERSATION_ACTIONS).not.toContain('ai_conversation:moderate');
  });

  it('names every verb the routes actually authorize', () => {
    for (const action of ['create', 'read', 'list', 'speak', 'rename', 'archive'] as const) {
      expect(AI_CONVERSATION_ACTIONS).toContain(`ai_conversation:${action}`);
    }
  });
});
