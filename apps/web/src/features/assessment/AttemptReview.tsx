import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { useLocale } from '../../app/LocaleProvider.tsx';
import { fetchReview, type AttemptReview as Review } from './api.ts';

/**
 * The marked paper: what the learner chose, what was correct, and why.
 *
 * This is the only view in the application that renders correct answers, and it
 * renders exactly what `GET /attempts/:id/review` returned. It never asks
 * whether the reader is allowed to see them — by the time a payload reaches
 * here, two independent gates have already said yes (the policy engine, then
 * `app_attempt_review` in SQL), and an unreleased paper arrives as a 403 rather
 * than as data to filter.
 *
 * `questions` CAN LEGITIMATELY BE EMPTY: that is a teacher looking at an
 * attempt whose assessment has no questions left visible to them, and it is
 * rendered as an empty paper rather than as an error.
 *
 * `unreleasedActions` is rendered only when the review LOADED and the result is
 * still unreleased. That combination is not a role check dressed up as one — it
 * is the server's own answer: the policy refuses a review of an unreleased
 * attempt to the learner and their guardian, so any reader who reaches this
 * branch was admitted as staff by both gates. The slot decides what to DRAW,
 * never what is permitted.
 */
export function AttemptReview({
  attemptId,
  unreleasedActions,
}: {
  attemptId: string;
  unreleasedActions?: ReactNode;
}): JSX.Element {
  const { t } = useLocale();
  const [state, setState] = useState<
    | { kind: 'loading' }
    | { kind: 'withheld' }
    | { kind: 'error' }
    | { kind: 'ready'; review: Review }
  >({ kind: 'loading' });

  useEffect(() => {
    const controller = new AbortController();
    setState({ kind: 'loading' });
    fetchReview(attemptId, controller.signal)
      .then((review) => setState({ kind: 'ready', review }))
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        // A 403 here means "not released yet", which is a state worth naming for
        // a learner: they sat the paper and are waiting. Every other failure
        // collapses into one message.
        const status = (error as { status?: number }).status;
        setState({ kind: status === 403 ? 'withheld' : 'error' });
      });
    return () => controller.abort();
  }, [attemptId]);

  if (state.kind === 'loading') return <p data-testid="review-loading">{t('attempt.loading')}</p>;
  if (state.kind === 'withheld')
    return <p data-testid="review-withheld">{t('review.notReleased')}</p>;
  if (state.kind === 'error') return <p data-testid="review-error">{t('attempt.unavailable')}</p>;

  const { review } = state;

  return (
    <section data-testid="attempt-review">
      {!review.released && unreleasedActions}
      {review.teacherComment !== null && (
        <p data-testid="review-teacher-comment">{review.teacherComment}</p>
      )}
      <ol>
        {review.questions.map((question) => {
          const correct = new Set(question.correctOptionIds);
          const chosen = new Set(question.selectedOptionIds);
          return (
            <li key={question.questionId} data-testid="review-question">
              <p>{question.prompt}</p>
              <p data-testid="review-awarded">
                {question.awarded} / {question.points}
              </p>
              <p>{question.isCorrect ? t('review.correct') : t('review.incorrect')}</p>
              <ul>
                {question.options.map((option) => (
                  <li
                    key={option.id}
                    data-correct={correct.has(option.id) ? 'true' : 'false'}
                    data-chosen={chosen.has(option.id) ? 'true' : 'false'}
                  >
                    {option.body}
                  </li>
                ))}
              </ul>
              {question.explanation !== '' && (
                <p data-testid="review-explanation">{question.explanation}</p>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
