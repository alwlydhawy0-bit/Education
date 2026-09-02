import { useEffect, useState } from 'react';
import type { CourseMastery, MasteryState, MasteryTally } from '@edu/contracts';
import { useLocale } from '../../app/LocaleProvider.tsx';
import { fetchCourseMastery } from './api.ts';
import type { MessageKey } from '../../shared/i18n/messages.ts';

/**
 * A learner's own progress across one course, by objective.
 *
 * NOTHING HERE IS COMPUTED. Every state, count and percentage is rendered from
 * the payload exactly as the server sent it. There is no client-side threshold,
 * no re-tally, and no "if evidenceCount > 2 then mastered" — a second
 * implementation of the mastery rule would eventually disagree with the one in
 * `app_objective_mastery`, about a real child, in a way nobody would notice
 * until a teacher acted on it.
 *
 * ACCESSIBILITY. The state is TEXT first. `data-mastery` exists so a stylesheet
 * can colour it, but the word is always present and always read out, so nothing
 * about a learner's standing depends on distinguishing two colours. The meter is
 * a native `<progress>` with an explicit label and its numeric value stated
 * beside it. Direction comes from the document, which `LocaleProvider` sets, so
 * this component contains no left/right assumptions at all.
 */
const MASTERY_LABEL: Record<MasteryState, MessageKey> = {
  no_evidence: 'mastery.state.no_evidence',
  attempted: 'mastery.state.attempted',
  developing: 'mastery.state.developing',
  demonstrated: 'mastery.state.demonstrated',
  mastered: 'mastery.state.mastered',
};

const LESSON_LABEL = {
  not_started: 'mastery.lesson.not_started',
  in_progress: 'mastery.lesson.in_progress',
  completed: 'mastery.lesson.completed',
} as const satisfies Record<string, MessageKey>;

function Tally({ tally, label }: { tally: MasteryTally; label: string }): JSX.Element {
  // `demonstratedPercentage` is null when there is nothing to demonstrate. That
  // is NOT 0% — a course with no objectives is unmeasurable, and drawing an
  // empty bar would read as failure to a child who has done nothing wrong.
  if (tally.demonstratedPercentage === null) {
    return (
      <p data-testid="mastery-tally">
        {tally.demonstrated + tally.mastered} / {tally.total} {label}
      </p>
    );
  }
  return (
    <p data-testid="mastery-tally">
      <progress max={100} value={tally.demonstratedPercentage} aria-label={label} />{' '}
      <span>
        {tally.demonstrated + tally.mastered} / {tally.total} {label} (
        {tally.demonstratedPercentage}%)
      </span>
    </p>
  );
}

export function CourseMasteryView({ courseId }: { courseId: string }): JSX.Element {
  const { t } = useLocale();
  const [state, setState] = useState<
    { kind: 'loading' } | { kind: 'error' } | { kind: 'ready'; course: CourseMastery }
  >({ kind: 'loading' });

  useEffect(() => {
    const controller = new AbortController();
    setState({ kind: 'loading' });
    fetchCourseMastery(courseId, controller.signal)
      .then((course) => setState({ kind: 'ready', course }))
      .catch(() => {
        if (!controller.signal.aborted) setState({ kind: 'error' });
      });
    return () => controller.abort();
  }, [courseId]);

  if (state.kind === 'loading') return <p data-testid="mastery-loading">{t('mastery.loading')}</p>;
  // One message for every failure. Telling a reader apart "does not exist" from
  // "exists but is not yours" is the disclosure the server's 404-versus-403 rule
  // already decided; the client must not undo it by explaining the difference.
  if (state.kind === 'error') return <p data-testid="mastery-error">{t('mastery.unavailable')}</p>;

  const { course } = state;

  return (
    <section data-testid="course-mastery">
      <h2>{course.courseTitle}</h2>
      <Tally tally={course.tally} label={t('mastery.objectivesDemonstrated')} />
      {/*
        Objective mastery and lesson completion are shown SEPARATELY, never
        blended. A learner can finish every lesson and demonstrate nothing, and
        a single combined bar would hide exactly that.
      */}
      <p data-testid="mastery-lessons">
        {course.lessonsCompleted} / {course.lessonsTotal} {t('mastery.lessonsCompleted')}
      </p>

      {course.units.map((unit) => (
        <section key={unit.unitId} data-testid="unit-mastery">
          <h3>{unit.unitTitle}</h3>
          <Tally tally={unit.tally} label={t('mastery.objectivesDemonstrated')} />
          {unit.lessons.map((lesson) => (
            <section key={lesson.lessonId} data-testid="lesson-mastery">
              <h4>
                {lesson.lessonTitle}{' '}
                <span data-testid="lesson-status">{t(LESSON_LABEL[lesson.lessonStatus])}</span>
              </h4>
              <ul>
                {lesson.objectives.map((objective) => (
                  <li key={objective.objectiveId} data-testid="objective">
                    <span>{objective.statement}</span>{' '}
                    {/*
                      The state as a WORD, with the attribute only as a styling
                      hook. Colour alone would leave the status unreadable to
                      anyone who cannot distinguish two of them.
                    */}
                    <strong data-mastery={objective.mastery} data-testid="objective-mastery">
                      {t(MASTERY_LABEL[objective.mastery])}
                    </strong>{' '}
                    <small>
                      {objective.evidenceCount} {t('mastery.evidenceCount')}
                    </small>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </section>
      ))}
    </section>
  );
}
