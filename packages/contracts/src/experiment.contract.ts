import { z } from 'zod';
import { idSchema } from './common.ts';
import { createListQuerySchema } from './query.ts';

/**
 * Contracts for interactive labs and the sessions learners run in them.
 *
 * Read the REQUEST schemas for what is absent rather than what is present.
 * Every one is `.strict()`, so a field not listed is a 400 rather than a
 * silently-ignored value that some future code path starts trusting.
 *
 * NOT ACCEPTED FROM A CLIENT, ANYWHERE IN THIS FILE:
 *
 *   learnerId / userId  — the learner is the session, on every route.
 *   status              — 'completed' is the server's word. A client may ask to
 *                         submit; it may not announce that it finished.
 *   passed              — decided by the submit trigger from rules the learner
 *                         cannot read.
 *   submittedAt /       — the server clock. A client-supplied time is a client
 *   completedAt           writing history.
 *
 * THERE IS NO ROUTE THAT CREATES A LAB ACTIVITY, and that is deliberate. A lab
 * hangs off a `learning_activity` of type `simulation` or `experiment`, which
 * the existing activity endpoints already create, publish and archive. Adding a
 * second publish path would mean two places that decide when children can see a
 * lab, and the database's publication gate would only be enforcing one of them.
 * What this file adds is the lab's BODY, attached to an activity that already
 * exists.
 */

export const simulationTypeSchema = z.enum(['circuit', 'physics', 'logic_gate', 'code_sandbox']);
export type SimulationType = z.infer<typeof simulationTypeSchema>;

/**
 * `code_sandbox` IS A LABEL, NOT AN EXECUTION REQUEST.
 *
 * It names a sandbox that runs in the BROWSER. Nothing on the server executes
 * learner code, nothing here is a step toward that, and a future task that
 * wanted server-side execution would be a different piece of work with a
 * different threat model — not a new value in this enum.
 */

export const labSessionStatusSchema = z.enum(['in_progress', 'submitted', 'completed']);
export type LabSessionStatus = z.infer<typeof labSessionStatusSchema>;

export const artifactTypeSchema = z.enum(['snapshot', 'telemetry_log', 'output_result']);
export type ArtifactType = z.infer<typeof artifactTypeSchema>;

// --- The rule language ---------------------------------------------------

/**
 * THE OPERATOR SET IS CLOSED, AND THIS LIST MUST MATCH THE ONE IN SQL.
 *
 * `app_experiment_rule_holds` returns false for any operator it does not
 * recognise, and `app_experiment_rules_are_well_formed` refuses to publish a
 * lab containing one. So a mismatch between this list and that one does not
 * create a hole — it creates a lab an author can save and can never publish,
 * which is a worse day than a 400. `tests/architecture/experiment-rules.test.ts`
 * compares the two texts so the pair cannot drift silently.
 */
export const RULE_OPERATORS = [
  'exists',
  'absent',
  'eq',
  'neq',
  'isTrue',
  'isFalse',
  'lengthEq',
  'lengthGte',
  'lengthLte',
  'gt',
  'gte',
  'lt',
  'lte',
  'approx',
] as const;

export const ruleOperatorSchema = z.enum(RULE_OPERATORS);
export type RuleOperator = z.infer<typeof ruleOperatorSchema>;

/**
 * A dot-path into the state object.
 *
 * The pattern is the SQL one, character for character:
 * `^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+){0,7}$`. Segments are alphanumeric, at most
 * eight deep. No wildcards, no array slicing, no `..`, and nothing that could
 * be read as an expression — there is no evaluator to escape from, and the path
 * reaches SQL as an ARRAY argument to `#>`, never as interpolated text.
 */
export const RULE_PATH_PATTERN = /^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+){0,7}$/;

export const rulePathSchema = z.string().max(200).regex(RULE_PATH_PATTERN, {
  message: 'a rule path is up to eight dot-separated [A-Za-z0-9_] segments',
});

/**
 * One rule: a comparison, never a computation.
 *
 * `value` is `z.unknown()` because it is compared as JSON and its useful type
 * depends on the operator — a number for `gt`, an array length for `lengthEq`,
 * anything at all for `eq`. The comparison is total: a value of the wrong shape
 * makes the rule fail, it does not make the submission fail.
 */
export const validationRuleSchema = z
  .object({
    path: rulePathSchema,
    op: ruleOperatorSchema,
    value: z.unknown().optional(),
    /** Physics does not land on exact decimals. `approx` only. */
    tolerance: z.number().min(0).max(1_000_000).optional(),
  })
  .strict()
  .refine((r) => r.op !== 'approx' || typeof r.value === 'number', {
    message: 'an approx rule compares against a number',
    path: ['value'],
  })
  .refine((r) => r.tolerance === undefined || r.op === 'approx', {
    message: 'tolerance applies only to an approx rule',
    path: ['tolerance'],
  })
  .refine(
    (r) =>
      !(['lengthEq', 'lengthGte', 'lengthLte'] as readonly string[]).includes(r.op) ||
      (typeof r.value === 'number' && Number.isInteger(r.value) && r.value >= 0),
    { message: 'a length rule compares against a non-negative integer', path: ['value'] },
  )
  .refine(
    (r) =>
      (['exists', 'absent', 'isTrue', 'isFalse'] as readonly string[]).includes(r.op) ||
      r.value !== undefined,
    { message: 'this operator needs a value to compare against', path: ['value'] },
  );
export type ValidationRule = z.infer<typeof validationRuleSchema>;

/**
 * A payload the browser holds: the starting scene, or the state a learner
 * reached.
 *
 * An OBJECT specifically, matching the `jsonb_typeof(...) = 'object'` CHECK.
 * An array or a bare scalar is refused here and again by the database, because
 * every rule path starts with a named segment and a top-level array has none —
 * so a non-object state could never satisfy any rule, and accepting one would
 * only produce a lab nobody can pass.
 */
export const statePayloadSchema = z.record(z.string(), z.unknown());
export type StatePayload = z.infer<typeof statePayloadSchema>;

/**
 * Byte ceilings, stated here so an oversized payload is a 400 naming the field
 * rather than a database error surfacing as a 500.
 *
 * THREE LIMITS IN A DELIBERATE ORDER, smallest first:
 *
 *   1. these values          — a 400 that says which field was too big
 *   2. Fastify's `bodyLimit` — 256 KiB, a 413 at the transport, no field named
 *   3. the SQL CHECK         — 256 KiB on the stored `jsonb`, the real limit
 *
 * `SESSION_STATE_MAX_BYTES` is 192 KiB rather than the CHECK's 256 KiB
 * SPECIFICALLY so that order holds. Set equal to the CHECK, it also equalled
 * the body limit, and since the JSON envelope adds bytes around the state, the
 * transport refused first every time — this schema's rule was unreachable over
 * HTTP, and the caller got a 413 with no indication of which field to shrink.
 * Found by a security test that expected a 400 and got a 413.
 *
 * A limit that can never fire is not defence in depth; it is a comment that
 * looks like a control. The database CHECK stays where it is, as the backstop
 * for any writer that is not this API.
 */
export const INITIAL_CONFIG_MAX_BYTES = 65_536;
export const SESSION_STATE_MAX_BYTES = 196_608;
export const ARTIFACT_PAYLOAD_MAX_BYTES = 131_072;

const withinBytes = (limit: number) => (value: unknown) =>
  Buffer.byteLength(JSON.stringify(value ?? null), 'utf8') <= limit;

// --- Authoring -----------------------------------------------------------

/**
 * Attaching a lab body to an activity that already exists.
 *
 * The scene and the rules travel TOGETHER, deliberately. Two endpoints would
 * leave a window in which a lab existed with a scene and no rules — and the
 * database refuses to publish a lab whose rules row is missing, so that window
 * is an activity an author cannot publish and cannot diagnose.
 *
 * `rules` may be EMPTY, and that is a real configuration rather than an
 * oversight: a lab with nothing to check is a sandbox, and finishing it is
 * simply finishing it. The database agrees — `bool_and` over no rules is true.
 *
 * An UPSERT, and a PUT for that reason: attaching a body twice while the
 * activity is still a draft replaces it. Once the activity is published, both
 * the policy and a database trigger refuse.
 */
export const putExperimentRequestSchema = z
  .object({
    simulationType: simulationTypeSchema,
    initialConfig: statePayloadSchema.default({}),
    rules: z.array(validationRuleSchema).max(100).default([]),
  })
  .strict()
  .refine((v) => withinBytes(INITIAL_CONFIG_MAX_BYTES)(v.initialConfig), {
    message: `initialConfig must serialize to at most ${INITIAL_CONFIG_MAX_BYTES} bytes`,
    path: ['initialConfig'],
  });
export type PutExperimentRequest = z.infer<typeof putExperimentRequestSchema>;

// --- Responses -----------------------------------------------------------

/**
 * A lab as a LEARNER receives it.
 *
 * There is no `rules` property, and no property that could hold one. The rules
 * live in a different table under a policy no learner satisfies, and they have
 * no path into this shape — which is the point at which a serializer bug
 * becomes impossible rather than merely unlikely.
 */
export const experimentResponseSchema = z
  .object({
    id: idSchema,
    activityId: idSchema,
    lessonId: idSchema,
    title: z.string(),
    instructions: z.string(),
    simulationType: simulationTypeSchema,
    status: z.enum(['draft', 'published', 'archived']),
    initialConfig: statePayloadSchema,
  })
  .strict();
export type ExperimentResponse = z.infer<typeof experimentResponseSchema>;

/**
 * A lab as its AUTHOR receives it: the same thing, plus the answer key.
 *
 * A SEPARATE SHAPE rather than an optional field on the one above. An optional
 * `rules` is a shape whose safety depends on somebody remembering to omit it;
 * two shapes make the disclosure a decision the route has to take, in a line a
 * reviewer can see. The route can only take it when the database returned a
 * rules row at all, which it does not do for a learner.
 */
export const authoredExperimentResponseSchema = experimentResponseSchema
  .extend({ rules: z.array(validationRuleSchema) })
  .strict();
export type AuthoredExperimentResponse = z.infer<typeof authoredExperimentResponseSchema>;

/**
 * One learner's run at one lab.
 *
 * `passed` is null while in progress and a boolean afterwards, mirroring the
 * database CHECK that makes half a result unrepresentable — so no client has to
 * handle one either.
 */
export const labSessionResponseSchema = z
  .object({
    id: idSchema,
    experimentId: idSchema,
    experimentTitle: z.string(),
    simulationType: simulationTypeSchema,
    lessonId: idSchema,
    lessonTitle: z.string(),
    courseId: idSchema,
    courseTitle: z.string(),
    status: labSessionStatusSchema,
    currentState: statePayloadSchema,
    passed: z.boolean().nullable(),
    startedAt: z.string().datetime(),
    submittedAt: z.string().datetime().nullable(),
    completedAt: z.string().datetime().nullable(),
    updatedAt: z.string().datetime(),
  })
  .strict();
export type LabSessionResponse = z.infer<typeof labSessionResponseSchema>;

/** A started session, with the scene to load attached. */
export const labSessionWithExperimentSchema = z
  .object({ session: labSessionResponseSchema, experiment: experimentResponseSchema })
  .strict();
export type LabSessionWithExperiment = z.infer<typeof labSessionWithExperimentSchema>;

// --- Working -------------------------------------------------------------

/**
 * Saving the scene the learner has built so far.
 *
 * Carries the state and NOTHING else. No status — a save cannot finish a lab —
 * and no `passed`. `.strict()` turns either into a 400 rather than a silently
 * ignored field that a later change might start reading.
 */
export const saveLabStateRequestSchema = z
  .object({ currentState: statePayloadSchema })
  .strict()
  .refine((v) => withinBytes(SESSION_STATE_MAX_BYTES)(v.currentState), {
    message: `currentState must serialize to at most ${SESSION_STATE_MAX_BYTES} bytes`,
    path: ['currentState'],
  });
export type SaveLabStateRequest = z.infer<typeof saveLabStateRequestSchema>;

/**
 * Submitting.
 *
 * Carries the final state, and still no verdict. The state is marked by
 * `app_experiment_state_satisfies` inside the submit trigger, against rules the
 * learner cannot read, using a function the application role may not call.
 * There is nowhere in this request to claim an outcome.
 */
export const submitLabRequestSchema = z
  .object({ currentState: statePayloadSchema })
  .strict()
  .refine((v) => withinBytes(SESSION_STATE_MAX_BYTES)(v.currentState), {
    message: `currentState must serialize to at most ${SESSION_STATE_MAX_BYTES} bytes`,
    path: ['currentState'],
  });
export type SubmitLabRequest = z.infer<typeof submitLabRequestSchema>;

/**
 * Appending an artifact: a snapshot, a telemetry log, a recorded output.
 *
 * Append-only by privilege — `edu_app` holds SELECT and INSERT on the table and
 * neither UPDATE nor DELETE — so there is no request shape here for editing one,
 * because there is no grant that could carry it out. A telemetry log that can be
 * rewritten is not telemetry.
 */
export const appendArtifactRequestSchema = z
  .object({
    artifactType: artifactTypeSchema,
    payload: statePayloadSchema.default({}),
  })
  .strict()
  .refine((v) => withinBytes(ARTIFACT_PAYLOAD_MAX_BYTES)(v.payload), {
    message: `payload must serialize to at most ${ARTIFACT_PAYLOAD_MAX_BYTES} bytes`,
    path: ['payload'],
  });
export type AppendArtifactRequest = z.infer<typeof appendArtifactRequestSchema>;

export const artifactResponseSchema = z
  .object({
    id: idSchema,
    sessionId: idSchema,
    artifactType: artifactTypeSchema,
    payload: statePayloadSchema,
    createdAt: z.string().datetime(),
  })
  .strict();
export type ArtifactResponse = z.infer<typeof artifactResponseSchema>;

// --- Listing -------------------------------------------------------------

/**
 * There is no `userId` filter here, on purpose. WHOSE sessions are being read
 * is decided by the ROUTE and the session, never by a query parameter — the
 * same rule as `listAttemptsQuerySchema` and `listProgressQuerySchema`.
 */
export const listLabSessionsQuerySchema = createListQuerySchema({
  sortableFields: ['startedAt', 'submittedAt', 'updatedAt'],
  defaultSort: 'startedAt',
  defaultOrder: 'desc',
  filters: {
    experimentId: idSchema.optional(),
    status: labSessionStatusSchema.optional(),
  },
});
export type ListLabSessionsQuery = z.infer<typeof listLabSessionsQuerySchema>;
