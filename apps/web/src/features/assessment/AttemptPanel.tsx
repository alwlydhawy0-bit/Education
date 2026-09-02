import { AttemptResult } from './AttemptResult.tsx';
import { AttemptReview } from './AttemptReview.tsx';
import { ReleaseResultControl } from './ReleaseResultControl.tsx';

/**
 * One attempt, as whoever is signed in is entitled to see it.
 *
 * There is ONE component for every audience rather than a learner view and a
 * teacher view, and that is deliberate. Two components would each need to
 * decide which audience it was serving, and a client-side answer to that
 * question is exactly the kind of authorization that belongs on the server. As
 * built, both views issue the same two requests and render whatever comes back:
 * a learner with a withheld result sees the withheld message because the server
 * sent no numbers, and a teacher sees the marks and the release control because
 * the server sent those instead.
 */
export function AttemptPanel({ attemptId }: { attemptId: string }): JSX.Element {
  return (
    <section data-testid="attempt-panel">
      <AttemptResult attemptId={attemptId} />
      <AttemptReview
        attemptId={attemptId}
        unreleasedActions={<ReleaseResultControl attemptId={attemptId} />}
      />
    </section>
  );
}
