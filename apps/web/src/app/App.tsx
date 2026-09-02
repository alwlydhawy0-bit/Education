import { useEffect, useState } from 'react';
import { useLocale } from './LocaleProvider.tsx';
import { HealthIndicator } from '../features/health/HealthIndicator.tsx';
import { AttemptPanel } from '../features/assessment/index.ts';
import { CourseMasteryView } from '../features/mastery/index.ts';
import { LessonEditor } from '../features/authoring/index.ts';
import { LessonView, MyCourses } from '../features/learning/index.ts';
import { AssistantPanel } from '../features/assistant/index.ts';

/**
 * Reads `?attempt=<id>` from the address bar.
 *
 * Not a router, and not the start of one — the foundation has no routing, and
 * Task 009 is not the place to introduce it. This is the smallest wiring that
 * makes the attempt views reachable in the running application; the real
 * navigation arrives with the router, and this reads a single parameter until
 * then.
 */
function idFromLocation(parameter: string): string | null {
  if (typeof window === 'undefined') return null;
  const value = new URLSearchParams(window.location.search).get(parameter);
  // Validated here rather than trusted to the API: a malformed id would produce
  // a 400 the user cannot act on, and the shape is public knowledge anyway.
  //
  // It is NOT an authorization check. Whose record this is comes from the
  // session, and every one of these views is scoped server-side — the parameter
  // names an attempt or a course, never a learner.
  return value !== null && /^[0-9a-f-]{36}$/i.test(value) ? value : null;
}

/**
 * Moves to another view by rewriting the address bar.
 *
 * Still not a router. `history.pushState` plus a re-render is the smallest
 * thing that makes the learner views navigable without pulling in routing the
 * foundation has not decided on; it keeps the URL honest, so a learner can
 * reload or share a link and land in the same place.
 */
function navigateTo(parameter: string, value: string): void {
  const url = new URL(window.location.href);
  // One parameter at a time: leaving a stale `?lesson=` beside a new `?course=`
  // would render two unrelated views at once.
  for (const key of ['course', 'lesson', 'attempt']) url.searchParams.delete(key);
  url.searchParams.set(parameter, value);
  window.history.pushState({}, '', url);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

export function App(): JSX.Element {
  const { t, locale, setLocale } = useLocale();
  // Re-read the address bar whenever it changes, including on Back.
  const [, setNavigation] = useState(0);
  useEffect(() => {
    const onPop = (): void => setNavigation((n) => n + 1);
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const attemptId = idFromLocation('attempt');
  const courseId = idFromLocation('course');
  const lessonId = idFromLocation('lesson');
  // The learner's course list is the landing view: with nothing selected there
  // is nothing else to show, and an empty page would look broken.
  const showCourseList = attemptId === null && courseId === null && lessonId === null;

  return (
    <main>
      <h1>{t('app.title')}</h1>
      <p>{t('app.tagline')}</p>
      <HealthIndicator />
      {showCourseList && <MyCourses onOpenCourse={(id) => navigateTo('course', id)} />}
      {attemptId !== null && <AttemptPanel attemptId={attemptId} />}
      {courseId !== null && <CourseMasteryView courseId={courseId} />}
      {/*
        A lesson id shows the learner's view AND, for somebody who may edit it,
        the editor. Which of the two is useful is decided by the SERVER, in the
        `permissions` block the editor renders from — this shell does not decide
        who is an author, and could not: it has no authorization information.
      */}
      {lessonId !== null && <LessonView lessonId={lessonId} />}
      {/*
        The assistant sits beside the lesson because that is its whole scope:
        it answers about the lesson you are reading. It is offered for any
        lesson the learner can open, and the SERVER decides what material that
        gives it access to — this shell has no authorization information and
        makes no such decision.
      */}
      {lessonId !== null && <AssistantPanel lessonId={lessonId} />}
      {lessonId !== null && <LessonEditor lessonId={lessonId} />}
      <button type="button" onClick={() => setLocale(locale === 'ar' ? 'en' : 'ar')}>
        {t('language.switch')}
      </button>
    </main>
  );
}
