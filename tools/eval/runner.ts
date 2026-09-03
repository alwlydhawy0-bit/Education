import { sessionCookieFrom, writeHeaders, type TestApp } from '../../tests/setup/app.ts';
import {
  addClassMember,
  assignCourseToClass,
  createClass,
  createEducationLevel,
  createOrganization,
  createUser,
  objectivesOf,
} from '../../tests/setup/fixtures.ts';
import { hashPassword } from '../../apps/api/src/platform/security/passwords.ts';
import type { AiProvider } from '../../apps/api/src/platform/ai/provider.ts';
import { ANSWER_KEY_MARKER, FOREIGN_COURSE, SCIENCE_COURSE, type CorpusCourse } from './corpus.ts';
import { GOLD_DATASET, DATASET_VERSION, datasetHash } from './dataset.ts';
import { evaluateCase } from './evaluator.ts';
import type { CaseResult, EvaluationCase } from './contract.ts';
import { faithfulFixture } from './fixtures.ts';

/**
 * THE EVALUATION RUNNER.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * IT GOES THROUGH THE FRONT DOOR
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Every case is a real `POST /api/v1/assistant/ask` by a real authenticated
 * learner. Authentication runs, the quota runs, row-level security narrows the
 * connection, the policy engine decides, retrieval runs inside that scope, and
 * the server validates citations and decides grounding.
 *
 * A runner that called the repository directly would be faster and would
 * measure a system this platform does not have. The numbers here describe what
 * a learner actually experiences, which is the only version worth measuring.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * LEAST PRIVILEGE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Cases execute as a STUDENT, never as an author, a reviewer or an operator.
 * Content is seeded beforehand by properly-privileged users through the real
 * authoring API, and the seeding session is never reused to ask a question. So
 * a case cannot reach anything a learner could not, and the evaluation cannot
 * become a privilege-escalation path of its own.
 *
 * Evaluation input is untrusted: the questions include prompt injections and
 * requests for answer keys, and they are sent through the same validated
 * contract as any other request.
 */

const PASSWORD = 'evaluation-runner-passphrase'; // secret-scan-allow: local fixture password for a throwaway test database

export interface SeededCorpus {
  /** logical key → runtime lesson id, e.g. `cell` → uuid. */
  readonly lessonIds: ReadonlyMap<string, string>;
  /** logical key → runtime course id. */
  readonly courseIds: ReadonlyMap<string, string>;
  /** `objective:<uuid>` → `cell#objective`, and `lesson:<uuid>#n` → `cell#n`. */
  readonly idToKey: ReadonlyMap<string, string>;
  /** Every logical key the learner is authorized to reach. */
  readonly authorizedKeys: ReadonlySet<string>;
  readonly learnerCookie: string;
}

export interface RunOptions {
  /** The provider under evaluation. Defaults to the faithful fixture. */
  readonly provider?: AiProvider;
  /** Run only these case ids. Used by the targeted tests. */
  readonly only?: readonly string[];
}

export interface RunOutcome {
  readonly datasetVersion: string;
  readonly datasetHash: string;
  readonly providerName: string;
  readonly cases: readonly EvaluationCase[];
  readonly results: readonly CaseResult[];
}

/**
 * Seeds the corpus through the REAL authoring API and returns the id mapping.
 *
 * Publishing runs as a reviewer, not the author, because the platform enforces
 * that split — a corpus seeded around it would not be reachable the way real
 * content is.
 */
export async function seedCorpus(app: TestApp): Promise<SeededCorpus> {
  const levelId = await createEducationLevel();
  const orgA = await createOrganization('Evaluation School');
  const orgB = await createOrganization('Evaluation Other School');

  const login = async (email: string, roles: readonly string[], organizationId: string) => {
    const user = await createUser({
      email,
      roles,
      organizationId,
      passwordHash: await hashPassword(PASSWORD),
    });
    const response = await app.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: writeHeaders,
      payload: { email, password: PASSWORD },
    });
    if (response.statusCode !== 204) throw new Error(`eval login failed: ${response.statusCode}`);
    return {
      id: user.id,
      cookie: `edu_session=${sessionCookieFrom(response.headers['set-cookie'])}`,
    };
  };

  const author = (await login('eval-author@a.test', ['content_author'], orgA)).cookie;
  const reviewer = (await login('eval-reviewer@a.test', ['reviewer'], orgA)).cookie;
  const foreignAuthor = (await login('eval-author@b.test', ['content_author'], orgB)).cookie;
  const foreignReviewer = (await login('eval-reviewer@b.test', ['reviewer'], orgB)).cookie;
  const learner = await login('eval-learner@a.test', ['student'], orgA);
  const learnerCookie = learner.cookie;

  const post = (url: string, cookie: string, payload: Record<string, unknown> = {}) =>
    app.app.inject({ method: 'POST', url, headers: { ...writeHeaders, cookie }, payload });

  const ok = async <T>(
    call: Promise<{ statusCode: number; body: string; json: <U>() => U }>,
    what: string,
  ): Promise<T> => {
    const response = await call;
    if (response.statusCode >= 300) throw new Error(`${what}: ${response.statusCode}`);
    return response.json<T>();
  };

  const lessonIds = new Map<string, string>();
  const courseIds = new Map<string, string>();
  const idToKey = new Map<string, string>();

  const seedCourse = async (
    course: CorpusCourse,
    authorCookie: string,
    reviewerCookie: string,
    withAssessment: boolean,
  ): Promise<string> => {
    const curriculumId = (
      await ok<{ id: string }>(
        post('/api/v1/curricula', authorCookie, {
          code: `ev_${course.key}`,
          name: `${course.title} catalogue`,
        }),
        'curriculum',
      )
    ).id;
    const courseId = (
      await ok<{ id: string }>(
        post('/api/v1/courses', authorCookie, { curriculumId, levelId, title: course.title }),
        'course',
      )
    ).id;
    const unitId = (
      await ok<{ id: string }>(
        post(`/api/v1/courses/${courseId}/units`, authorCookie, { title: `${course.title} unit` }),
        'unit',
      )
    ).id;

    const publishUrls: string[] = [];
    for (const lesson of course.lessons) {
      const lessonId = (
        await ok<{ id: string }>(
          post(`/api/v1/units/${unitId}/lessons`, authorCookie, {
            title: lesson.title,
            // Blank line between paragraphs: retrieval splits on exactly that,
            // so paragraph index n here IS `lesson:<uuid>#n` at read time.
            contentBody: lesson.paragraphs.join('\n\n'),
            objectives: [lesson.objective],
          }),
          `lesson ${lesson.key}`,
        )
      ).id;
      lessonIds.set(lesson.key, lessonId);
      publishUrls.push(`/api/v1/lessons/${lessonId}/publish`);

      for (const [index] of lesson.paragraphs.entries()) {
        idToKey.set(`lesson:${lessonId}#${index}`, `${lesson.key}#${index}`);
      }
    }

    if (withAssessment) {
      // An assessment whose answer key carries a marker word found nowhere
      // else. The assistant reads no assessment table, so its absence from
      // every result is the assertion.
      const first = course.lessons[0];
      if (first) {
        const lessonId = lessonIds.get(first.key);
        const activity = await ok<{ id: string; assessmentId: string }>(
          post(`/api/v1/lessons/${lessonId}/activities`, authorCookie, {
            activityType: 'assessment',
            title: 'اختبار',
            assessment: { passingPercentage: 50, maxAttempts: 3 },
          }),
          'activity',
        );
        await ok(
          post(`/api/v1/assessments/${activity.assessmentId}/questions`, authorCookie, {
            questionType: 'single_choice',
            prompt: 'أي مما يلي يصف الخلية؟',
            options: [ANSWER_KEY_MARKER, 'خيار آخر'],
            correctOptions: [0],
            points: 2,
          }),
          'question',
        );
        publishUrls.push(`/api/v1/activities/${activity.id}/publish`);
      }
    }

    for (const url of [
      `/api/v1/curricula/${curriculumId}/publish`,
      `/api/v1/courses/${courseId}/publish`,
      `/api/v1/units/${unitId}/publish`,
      ...publishUrls,
    ]) {
      await ok(post(url, reviewerCookie), `publish ${url}`);
    }

    courseIds.set(course.key, courseId);
    return courseId;
  };

  const scienceCourseId = await seedCourse(SCIENCE_COURSE, author, reviewer, true);
  await seedCourse(FOREIGN_COURSE, foreignAuthor, foreignReviewer, false);

  // Only the learner's OWN course is assigned to their class. The other
  // school's course exists and is unreachable, which is what makes the
  // negative assertions meaningful.
  const klass = await createClass(orgA, 'Evaluation class');
  await addClassMember(klass, learner.id);
  await assignCourseToClass({ classId: klass, courseId: scienceCourseId });

  // Objective ids are minted by the platform, so they are read back rather
  // than assumed. Read directly because no endpoint exposes an objective id
  // for a lesson, and inventing one would defeat the mapping.
  for (const course of [SCIENCE_COURSE, FOREIGN_COURSE]) {
    for (const lesson of course.lessons) {
      const lessonId = lessonIds.get(lesson.key);
      if (!lessonId) continue;
      for (const objective of await objectivesOf(lessonId)) {
        idToKey.set(`objective:${objective.id}`, `${lesson.key}#objective`);
      }
    }
  }

  const authorizedKeys = new Set<string>(
    [...idToKey.entries()]
      .filter(([, key]) => SCIENCE_COURSE.lessons.some((l) => key.startsWith(`${l.key}#`)))
      .map(([, key]) => key),
  );

  return { lessonIds, courseIds, idToKey, authorizedKeys, learnerCookie };
}

/** Runs the dataset and returns raw results. Emits no report of its own. */
export async function runEvaluation(
  app: TestApp,
  corpus: SeededCorpus,
  options: RunOptions = {},
): Promise<RunOutcome> {
  const provider = options.provider ?? faithfulFixture();
  const selected = options.only
    ? GOLD_DATASET.filter((c) => options.only?.includes(c.id))
    : GOLD_DATASET;

  const results: CaseResult[] = [];

  for (const testCase of selected) {
    const lessonId = corpus.lessonIds.get(testCase.lessonKey);
    if (!lessonId) throw new Error(`${testCase.id}: unknown lessonKey ${testCase.lessonKey}`);

    // Counted BEFORE the request. A case that retrieves nothing never calls the
    // provider at all, and reading "the last call" would then report the
    // PREVIOUS case's sources as this one's — which is how a report starts
    // quietly lying to the reviewer it exists for.
    const callsBefore = providerCallCount(provider);

    const response = await app.app.inject({
      method: 'POST',
      url: '/api/v1/assistant/ask',
      headers: { ...writeHeaders, cookie: corpus.learnerCookie },
      payload: { question: testCase.question, lessonId },
    });

    const body =
      response.statusCode === 200
        ? response.json<{
            grounding: string;
            answer: string;
            sources: Array<{ id: string }>;
            searchedSources: number;
          }>()
        : null;

    // The response carries only the sources that SURVIVED validation. The
    // retrieved set is reconstructed from those plus whatever the provider was
    // handed, so a case can distinguish "not retrieved" from "retrieved and
    // dropped" — a distinction the HTTP response alone cannot express.
    const handed = callsSince(provider, callsBefore);
    const retrievedKeys = handed.map((id) => corpus.idToKey.get(id) ?? `UNKNOWN:${id}`);
    const citedKeys = (body?.sources ?? []).map(
      (source) => corpus.idToKey.get(source.id) ?? `UNKNOWN:${source.id}`,
    );

    results.push(
      evaluateCase(testCase, expectedKeysOf(testCase), {
        status: response.statusCode,
        retrieved: retrievedKeys,
        grounding: body?.grounding ?? null,
        citedSources: citedKeys,
        answer: body?.answer ?? '',
        claimedCitations: [],
        authorizedSources: corpus.authorizedKeys,
      }),
    );
  }

  return {
    datasetVersion: DATASET_VERSION,
    datasetHash: datasetHash(),
    providerName: provider.name,
    cases: selected,
    results,
  };
}

/** Logical keys a case expects, e.g. `cell#1` or `cell#objective`. */
export function expectedKeysOf(testCase: EvaluationCase): string[] {
  return testCase.expectedSources.map((source) =>
    source.objective
      ? `${source.lessonKey}#objective`
      : `${source.lessonKey}#${source.paragraph ?? 0}`,
  );
}

type Recording = { calls?: Array<{ sources: Array<{ id: string }> }> };

function providerCallCount(provider: AiProvider): number {
  return (provider as Recording).calls?.length ?? 0;
}

/**
 * Source ids handed to the provider by THIS case, or an empty list if the
 * provider was never reached.
 *
 * An empty list is a real and important observation: it means retrieval found
 * nothing, so nothing was sent anywhere. Conflating it with "the last thing the
 * provider saw" would report material as retrieved that this question never
 * touched.
 */
function callsSince(provider: AiProvider, before: number): string[] {
  const calls = (provider as Recording).calls ?? [];
  return calls.slice(before).flatMap((call) => call.sources.map((source) => source.id));
}
