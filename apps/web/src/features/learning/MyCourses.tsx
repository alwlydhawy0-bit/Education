import { useEffect, useState } from 'react';
import { useLocale } from '../../app/LocaleProvider.tsx';
import { fetchMyCourses, type EnrolledCourseResponse } from './api.ts';

/**
 * The courses this learner is studying.
 *
 * THE LIST IS THE SERVER'S ANSWER, WHOLE. `GET /me/courses` returns the active
 * assignments reaching the authenticated learner through their classes, and
 * that endpoint takes no learner id — "me" is the session cookie. There is
 * nothing for this component to filter, and it filters nothing.
 *
 * WHY THE CLASS NAME IS SHOWN. "Why can I see this course?" is a question a
 * learner interface should be able to answer, and the class it arrived through
 * IS the answer — it is the whole access rule in one field. Showing it is
 * neither decoration nor disclosure: the learner is a member of that class.
 *
 * An EMPTY list is a first-class state, not an error. A learner between terms,
 * or one whose course was withdrawn a moment ago, has no courses, and saying so
 * plainly beats an empty page that looks broken.
 */
export function MyCourses({
  onOpenCourse,
}: {
  /** Navigates to a course. The parent owns navigation; this owns the list. */
  readonly onOpenCourse: (courseId: string) => void;
}): JSX.Element {
  const { t } = useLocale();
  const [courses, setCourses] = useState<readonly EnrolledCourseResponse[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    fetchMyCourses(controller.signal)
      .then(setCourses)
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true);
      });
    return () => controller.abort();
  }, []);

  if (failed) return <p data-testid="courses-error">{t('learning.unavailable')}</p>;
  if (courses === null) return <p data-testid="courses-loading">{t('learning.loading')}</p>;
  if (courses.length === 0) return <p data-testid="courses-empty">{t('learning.noCourses')}</p>;

  return (
    <section data-testid="my-courses">
      <h2>{t('learning.myCourses')}</h2>
      <ul>
        {courses.map((course) => (
          <li key={course.courseId}>
            <button
              type="button"
              data-testid="course-link"
              data-course={course.courseId}
              onClick={() => onOpenCourse(course.courseId)}
            >
              {course.title}
            </button>{' '}
            <small>
              {t('learning.viaClass')} {course.className}
            </small>
            {course.summary !== '' && <p>{course.summary}</p>}
          </li>
        ))}
      </ul>
    </section>
  );
}
