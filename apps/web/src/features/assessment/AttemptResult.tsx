import { useEffect, useState } from 'react';
import { useLocale } from '../../app/LocaleProvider.tsx';
import { fetchAttempt, type AttemptResponse } from './api.ts';

/**
 * What a learner is told about one attempt.
 *
 * THE WITHHELD CASE IS NOT A HIDDEN ELEMENT. When a result has not been
 * released, `score`, `maxScore`, `percentage` and `passed` arrive as `null` —
 * the server never sends the numbers — so there is nothing in this component's
 * props, state or DOM to reveal by editing CSS, opening devtools, or reading
 * the network tab. `released` decides which MESSAGE is shown, not whether a
 * number the browser already holds is painted.
 *
 * That distinction is the whole reason the redaction lives in the repository's
 * SQL rather than here. A frontend that received a mark and chose not to draw
 * it would be an access control implemented in a place the user controls.
 */
export function AttemptResult({ attemptId }: { attemptId: string }): JSX.Element {
  const { t } = useLocale();
  const [state, setState] = useState<
    { kind: 'loading' } | { kind: 'error' } | { kind: 'ready'; attempt: AttemptResponse }
  >({ kind: 'loading' });

  useEffect(() => {
    const controller = new AbortController();
    setState({ kind: 'loading' });
    fetchAttempt(attemptId, controller.signal)
      .then((attempt) => setState({ kind: 'ready', attempt }))
      .catch(() => {
        if (!controller.signal.aborted) setState({ kind: 'error' });
      });
    return () => controller.abort();
  }, [attemptId]);

  if (state.kind === 'loading') return <p data-testid="attempt-loading">{t('attempt.loading')}</p>;
  // One message for every failure. Telling a reader apart "does not exist" from
  // "exists but is not yours" is the disclosure the server's 404-vs-403 rule
  // already decided; the client must not undo it by explaining the difference.
  if (state.kind === 'error') return <p data-testid="attempt-error">{t('attempt.unavailable')}</p>;

  const { attempt } = state;

  if (attempt.status !== 'submitted') {
    return <p data-testid="attempt-in-progress">{t('attempt.inProgress')}</p>;
  }

  if (!attempt.released) {
    return (
      <section data-testid="attempt-withheld">
        <h2>{attempt.assessmentTitle}</h2>
        <p>{t('attempt.resultWithheld')}</p>
      </section>
    );
  }

  return (
    <section data-testid="attempt-result">
      <h2>{attempt.assessmentTitle}</h2>
      {/*
        Rendered from the server's own fields. `score`/`maxScore` are printed as
        given and `passed` is read, never recomputed from `percentage` against
        `passingPercentage` — a client-side comparison would be a second scoring
        rule that could disagree with the database's.
      */}
      <p data-testid="attempt-score">
        {attempt.score} / {attempt.maxScore}
      </p>
      <p data-testid="attempt-percentage">{attempt.percentage}%</p>
      <p data-testid="attempt-outcome">
        {attempt.passed ? t('attempt.passed') : t('attempt.failed')}
      </p>
    </section>
  );
}
