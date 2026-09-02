import { useEffect, useState } from 'react';
import { useLocale } from '../../app/LocaleProvider.tsx';
import {
  fetchLesson,
  fetchLessonActivities,
  type ActivityResponse,
  type LessonDetailResponse,
} from './api.ts';

/**
 * One lesson, as a learner reads it.
 *
 * WHAT IS RENDERED IS WHAT ARRIVED. There is no check that the lesson is
 * published, no check that the learner is enrolled, and no filter over the
 * activities — all three are decided by the server, twice, by the policy engine
 * and by row-level security. Repeating any of them here would create a second
 * rule that can disagree with the enforced one, and the browser is not a place
 * where a disagreement gets noticed.
 *
 * A FAILURE IS ONE MESSAGE. A lesson that does not exist, one belonging to
 * another school, one belonging to another class and one that is still a draft
 * all produce the same 404 and the same words — deliberately. Distinguishing
 * them in the interface would rebuild, in the client, exactly the existence
 * oracle the server's 404-versus-403 rule exists to prevent.
 *
 * CONTENT IS TEXT, NOT HTML. `contentBody` is markdown or plain text by
 * contract, and it is rendered into a text node — never `dangerouslySetInnerHTML`.
 * A lesson body is author-supplied content aimed at children; the one thing
 * this component must never do is execute it. `white-space: pre-wrap` keeps the
 * author's line breaks without interpreting anything.
 *
 * ACCESSIBILITY. Headings are real headings, the objectives are a real list,
 * and the assessment entry is a real button. Direction comes from the document,
 * which `LocaleProvider` sets, so there are no left/right assumptions here.
 */
export function LessonView({
  lessonId,
  onStartAssessment,
}: {
  readonly lessonId: string;
  /** Hands an assessment id to the attempt feature, which owns attempts. */
  readonly onStartAssessment?: ((assessmentId: string) => void) | undefined;
}): JSX.Element {
  const { t } = useLocale();
  const [lesson, setLesson] = useState<LessonDetailResponse | null>(null);
  const [activities, setActivities] = useState<readonly ActivityResponse[]>([]);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    setLesson(null);
    setActivities([]);
    setFailed(false);

    // Both or neither. A lesson rendered with its activity list silently
    // missing would look like a lesson that has no assessment, which is a
    // different and more misleading thing than a lesson that failed to load.
    Promise.all([
      fetchLesson(lessonId, controller.signal),
      fetchLessonActivities(lessonId, controller.signal),
    ])
      .then(([loaded, loadedActivities]) => {
        setLesson(loaded);
        setActivities(loadedActivities);
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true);
      });
    return () => controller.abort();
  }, [lessonId]);

  if (failed) return <p data-testid="lesson-error">{t('learning.lessonUnavailable')}</p>;
  if (lesson === null) return <p data-testid="lesson-loading">{t('learning.loading')}</p>;

  return (
    <article data-testid="lesson-view">
      <h2>{lesson.title}</h2>
      {lesson.summary !== '' && <p data-testid="lesson-summary">{lesson.summary}</p>}

      {lesson.objectives.length > 0 && (
        <section data-testid="lesson-objectives">
          <h3>{t('learning.objectives')}</h3>
          <ul>
            {lesson.objectives.map((objective) => (
              <li key={objective}>{objective}</li>
            ))}
          </ul>
        </section>
      )}

      {/*
        A text node. Markdown is not rendered as HTML here and must not be:
        the contract permits markdown or plain text, and a renderer that
        interpreted it would need auditing this repository has not done.
      */}
      <section data-testid="lesson-body" style={{ whiteSpace: 'pre-wrap' }}>
        {lesson.contentBody}
      </section>

      {lesson.externalUrl !== null && (
        <p>
          {/*
            `rel` is not optional. `noopener` denies the opened page a handle on
            this window, and `noreferrer` withholds where the learner came from.
            The URL is https-only by contract and by a database CHECK.
          */}
          <a href={lesson.externalUrl} target="_blank" rel="noopener noreferrer">
            {t('learning.externalLink')}
          </a>
        </p>
      )}

      {activities.length > 0 && (
        <section data-testid="lesson-activities">
          <h3>{t('learning.activities')}</h3>
          <ul>
            {activities.map((activity) => (
              <li key={activity.id}>
                {activity.title}
                {activity.instructions !== '' && <p>{activity.instructions}</p>}
                {/*
                  Offered only for an activity the server returned WITH an
                  assessment id. A learner who reaches the attempt endpoint
                  another way is authorized there, independently — this button
                  is a route, not a permission.
                */}
                {activity.assessmentId !== null && onStartAssessment !== undefined && (
                  <button
                    type="button"
                    data-testid="start-assessment"
                    data-assessment={activity.assessmentId}
                    onClick={() => onStartAssessment(activity.assessmentId as string)}
                  >
                    {t('learning.startAssessment')}
                  </button>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </article>
  );
}
