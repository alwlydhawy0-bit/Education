import { useLocale } from './LocaleProvider.tsx';
import { HealthIndicator } from '../features/health/HealthIndicator.tsx';
import { AttemptPanel } from '../features/assessment/index.ts';
import { CourseMasteryView } from '../features/mastery/index.ts';

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

export function App(): JSX.Element {
  const { t, locale, setLocale } = useLocale();
  const attemptId = idFromLocation('attempt');
  const courseId = idFromLocation('course');

  return (
    <main>
      <h1>{t('app.title')}</h1>
      <p>{t('app.tagline')}</p>
      <HealthIndicator />
      {attemptId !== null && <AttemptPanel attemptId={attemptId} />}
      {courseId !== null && <CourseMasteryView courseId={courseId} />}
      <button type="button" onClick={() => setLocale(locale === 'ar' ? 'en' : 'ar')}>
        {t('language.switch')}
      </button>
    </main>
  );
}
