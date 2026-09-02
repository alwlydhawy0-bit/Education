import { render, screen, waitFor } from '@testing-library/react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocaleProvider } from '../../apps/web/src/app/LocaleProvider.tsx';
import { LessonView, MyCourses } from '../../apps/web/src/features/learning/index.ts';
import { translate } from '../../apps/web/src/shared/i18n/messages.ts';

/**
 * The learner curriculum views, rendered for real against a stubbed transport.
 *
 * WHAT THESE PROVE. That the components render the server's answer and nothing
 * else: they add no content, filter no content, and compute no authorization.
 * The sharpest test in the file is the one that hands the component a DRAFT
 * lesson and asserts it is DISPLAYED — because a component that quietly hid it
 * would be holding a second copy of the visibility rule, and the copy nobody
 * tests is the one that goes wrong.
 *
 * WHAT THEY DO NOT PROVE, and do not claim to. Nothing here is a security
 * control. `fetch` is stubbed, so the responses are whatever the test says.
 * Every claim about what a learner may actually reach is proved in
 * `tests/security/learner-delivery.test.ts` over real HTTP against a real
 * database as `edu_app`, with the policy engine and RLS both in the path.
 */
const LESSON_ID = '11111111-1111-4111-8111-111111111111';
const ASSESSMENT_ID = '33333333-3333-4333-8333-333333333333';

interface FetchCall {
  readonly url: string;
  readonly method: string;
}

let calls: FetchCall[] = [];
let respond: (call: FetchCall) => { status: number; payload: unknown };

const course = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  courseId: '22222222-2222-4222-8222-222222222222',
  classId: '44444444-4444-4444-8444-444444444444',
  className: 'أ-١',
  title: 'الفيزياء',
  summary: 'مقرر الفصل الأول',
  levelId: '55555555-5555-4555-8555-555555555555',
  curriculumId: '66666666-6666-4666-8666-666666666666',
  assignedAt: '2026-01-01T10:00:00.000Z',
  startsOn: null,
  dueOn: null,
  ...over,
});

const lesson = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: LESSON_ID,
  unitId: '77777777-7777-4777-8777-777777777777',
  position: 1,
  title: 'قوانين نيوتن',
  summary: 'مقدمة',
  contentFormat: 'markdown',
  contentBody: 'الجسم الساكن يبقى ساكنًا.',
  externalUrl: null,
  estimatedMinutes: null,
  objectives: ['يشرح القانون الثاني'],
  status: 'published',
  createdAt: '2026-01-01T10:00:00.000Z',
  updatedAt: '2026-01-01T10:00:00.000Z',
  publishedAt: '2026-01-01T10:00:00.000Z',
  permissions: { update: false, publish: false, archive: false },
  ...over,
});

const activity = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: '88888888-8888-4888-8888-888888888888',
  lessonId: LESSON_ID,
  position: 1,
  activityType: 'assessment',
  title: 'اختبار القوى',
  instructions: 'أجب عن كل الأسئلة',
  status: 'published',
  assessmentId: ASSESSMENT_ID,
  createdAt: '2026-01-01T10:00:00.000Z',
  ...over,
});

const apiError = (code: string, message: string): unknown => ({
  error: { code, message, correlationId: 'cid-1' },
});

beforeEach(() => {
  calls = [];
  respond = () => ({ status: 200, payload: { items: [] } });
  vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
    const call: FetchCall = { url, method: init?.method ?? 'GET' };
    calls.push(call);
    const { status, payload } = respond(call);
    return Promise.resolve({
      ok: status < 400,
      status,
      json: () => Promise.resolve(payload),
    } as Response);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const en = (key: Parameters<typeof translate>[1]): string => translate('en', key);

const mountCourses = async (onOpen: (courseId: string) => void = () => {}): Promise<void> => {
  render(
    <LocaleProvider>
      <MyCourses onOpenCourse={onOpen} />
    </LocaleProvider>,
  );
};

const mountLesson = async (onStart?: (assessmentId: string) => void): Promise<void> => {
  render(
    <LocaleProvider>
      <LessonView lessonId={LESSON_ID} {...(onStart ? { onStartAssessment: onStart } : {})} />
    </LocaleProvider>,
  );
  await screen.findByTestId('lesson-view');
};

describe('MyCourses', () => {
  it('shows a loading state, then exactly the courses the server returned', async () => {
    respond = () => ({
      status: 200,
      payload: { items: [course(), course({ title: 'الكيمياء' })] },
    });
    await mountCourses();
    expect(screen.getByTestId('courses-loading')).toBeTruthy();

    await screen.findByTestId('my-courses');
    expect(screen.getAllByTestId('course-link')).toHaveLength(2);
  });

  it('sends no learner id — "me" is the session', async () => {
    respond = () => ({ status: 200, payload: { items: [course()] } });
    await mountCourses();
    await screen.findByTestId('my-courses');

    expect(calls).toHaveLength(1);
    const [first] = calls;
    expect(first?.url).toBe('/api/v1/me/courses');
    // No parameter names a person. "me" is the session cookie, and there is no
    // field in this request through which a caller could aim at anybody else.
    for (const forbidden of ['userId', 'learnerId', 'organizationId', 'classId']) {
      expect(first?.url).not.toContain(forbidden);
    }
  });

  it('says so plainly when there are no courses, rather than looking broken', async () => {
    respond = () => ({ status: 200, payload: { items: [] } });
    await mountCourses();
    const empty = await screen.findByTestId('courses-empty');
    expect(empty.textContent).toBe(en('learning.noCourses'));
  });

  it('reports a failure without saying what went wrong', async () => {
    respond = () => ({ status: 403, payload: apiError('FORBIDDEN', 'Forbidden') });
    await mountCourses();
    const error = await screen.findByTestId('courses-error');
    expect(error.textContent).toBe(en('learning.unavailable'));
  });

  it('rejects a response that does not match the contract', async () => {
    // An extra field is refused at the boundary rather than rendered.
    respond = () => ({ status: 200, payload: { items: [{ ...course(), secretFlag: true }] } });
    await mountCourses();
    await screen.findByTestId('courses-error');
  });

  it('hands the course id to the parent rather than navigating itself', async () => {
    const opened: string[] = [];
    respond = () => ({ status: 200, payload: { items: [course()] } });
    await mountCourses((id) => opened.push(id));
    await screen.findByTestId('my-courses');

    await act(async () => {
      screen.getByTestId('course-link').click();
    });
    expect(opened).toEqual(['22222222-2222-4222-8222-222222222222']);
  });
});

describe('LessonView', () => {
  const withLessonAndActivities = (
    lessonBody: Record<string, unknown>,
    activities: Record<string, unknown>[],
  ): void => {
    respond = (call) =>
      call.url.endsWith('/activities')
        ? { status: 200, payload: { items: activities } }
        : { status: 200, payload: lessonBody };
  };

  it('renders the title, objectives, body and activities the server sent', async () => {
    withLessonAndActivities(lesson(), [activity()]);
    await mountLesson();

    expect(screen.getByText('قوانين نيوتن')).toBeTruthy();
    expect(screen.getByTestId('lesson-objectives').textContent).toContain('يشرح القانون الثاني');
    expect(screen.getByTestId('lesson-body').textContent).toBe('الجسم الساكن يبقى ساكنًا.');
    expect(screen.getByTestId('lesson-activities').textContent).toContain('اختبار القوى');
  });

  it('DISPLAYS a draft lesson if the server sends one — it does not filter', async () => {
    // The most important test in this file. A component that hid this would be
    // a second copy of the visibility rule, and would mask a genuine server
    // defect: the server tests would fail, and a reviewer looking at the
    // interface would see nothing wrong. Hiding drafts is the SERVER's job, and
    // `learner-delivery.test.ts` proves it does it.
    withLessonAndActivities(lesson({ status: 'draft', publishedAt: null }), []);
    await mountLesson();
    expect(screen.getByTestId('lesson-body')).toBeTruthy();
  });

  it('renders the body as TEXT, never as markup', async () => {
    withLessonAndActivities(
      lesson({ contentBody: '<img src=x onerror="alert(1)"> <b>bold</b>' }),
      [],
    );
    await mountLesson();

    const body = screen.getByTestId('lesson-body');
    // The characters are present as text; no element was created from them.
    expect(body.textContent).toContain('<img src=x onerror="alert(1)">');
    expect(body.querySelector('img')).toBeNull();
    expect(body.querySelector('b')).toBeNull();
  });

  it('opens an external link with noopener and noreferrer', async () => {
    withLessonAndActivities(lesson({ externalUrl: 'https://example.test/paper' }), []);
    await mountLesson();

    const link = screen.getByText(en('learning.externalLink')) as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('https://example.test/paper');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    expect(link.getAttribute('target')).toBe('_blank');
  });

  it('offers an assessment only for an activity that has one', async () => {
    withLessonAndActivities(lesson(), [
      activity(),
      activity({
        id: '99999999-9999-4999-8999-999999999999',
        activityType: 'practice',
        assessmentId: null,
        title: 'تمرين',
      }),
    ]);
    const started: string[] = [];
    await mountLesson((id) => started.push(id));

    expect(screen.getAllByTestId('start-assessment')).toHaveLength(1);
    await act(async () => {
      screen.getByTestId('start-assessment').click();
    });
    expect(started).toEqual([ASSESSMENT_ID]);
  });

  it('shows one message for every failure, whatever the cause', async () => {
    for (const code of [403, 404, 500]) {
      respond = () => ({ status: code, payload: apiError('X', 'x') });
      const { unmount } = render(
        <LocaleProvider>
          <LessonView lessonId={LESSON_ID} />
        </LocaleProvider>,
      );
      const error = await screen.findByTestId('lesson-error');
      // A learner must not be able to tell "does not exist" from "not yours".
      expect(error.textContent).toBe(en('learning.lessonUnavailable'));
      unmount();
    }
  });

  it('fails as a whole when the activity list fails, rather than showing a lesson with none', async () => {
    respond = (call) =>
      call.url.endsWith('/activities')
        ? { status: 500, payload: apiError('INTERNAL', 'x') }
        : { status: 200, payload: lesson() };
    render(
      <LocaleProvider>
        <LessonView lessonId={LESSON_ID} />
      </LocaleProvider>,
    );
    // A lesson rendered with its activities silently missing looks like a
    // lesson that HAS no assessment, which is a different and worse lie.
    await screen.findByTestId('lesson-error');
  });

  it('makes exactly two requests per lesson, however many activities it has', async () => {
    withLessonAndActivities(lesson(), [
      activity(),
      activity({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }),
      activity({ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }),
    ]);
    await mountLesson();
    // O(1) per screen, not O(activities). The check is here rather than in a
    // comment because an N+1 is introduced by accident, not on purpose.
    expect(calls).toHaveLength(2);
  });

  it('renders Arabic and sets the document RTL when no supported language is preferred', async () => {
    Object.defineProperty(window.navigator, 'languages', {
      value: ['fr-FR'],
      configurable: true,
    });
    withLessonAndActivities(lesson(), [activity()]);
    await mountLesson();

    expect(screen.getByText(translate('ar', 'learning.objectives'))).toBeTruthy();
    await waitFor(() => {
      expect(document.documentElement.dir).toBe('rtl');
      expect(document.documentElement.lang).toBe('ar');
    });
  });
});
