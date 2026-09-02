import {
  attemptResponseSchema,
  attemptReviewSchema,
  type AttemptResponse,
  type AttemptReview,
} from '@edu/contracts';
import { apiRequest } from '../../shared/api/client.ts';

/**
 * The assessment endpoints this feature uses, and nothing else.
 *
 * EVERY RESPONSE IS PARSED THROUGH THE SHARED CONTRACT before a component sees
 * it. That is not defensive typing for its own sake: `attemptReviewSchema` is
 * `.strict()`, so a field the server did not intend to send — the answer key
 * arriving on an unreleased paper, say — becomes a thrown error here rather
 * than a value some component might render. The browser is not a trust
 * boundary, but a client that silently accepts unexpected fields cannot help
 * anyone notice when the server starts sending them.
 *
 * NOTHING IN THIS MODULE COMPUTES A RESULT. There is no scoring, no
 * percentage arithmetic, no pass/fail comparison and no "should this be
 * visible?" decision. The server decides all four; a second implementation here
 * could only ever disagree with the one that marks children's work.
 */
export const fetchAttempt = async (attemptId: string, signal?: AbortSignal) => {
  const payload = await apiRequest<unknown>(
    `/attempts/${encodeURIComponent(attemptId)}`,
    signal ? { signal } : {},
  );
  // The endpoint wraps the attempt alongside the paper, which is empty once the
  // attempt is submitted. Only the result block concerns this view.
  const parsed = (payload as { attempt: unknown }).attempt;
  return attemptResponseSchema.parse(parsed);
};

export const fetchReview = async (attemptId: string, signal?: AbortSignal) =>
  attemptReviewSchema.parse(
    await apiRequest<unknown>(
      `/attempts/${encodeURIComponent(attemptId)}/review`,
      signal ? { signal } : {},
    ),
  );

/**
 * Releasing a result.
 *
 * The body carries a comment and nothing else. There is deliberately no
 * parameter here for a learner, a class, an organization or a score — the
 * attempt is the URL, the actor is the session cookie, and the server would
 * refuse any of them with a 400 in any case.
 */
export const releaseResult = async (attemptId: string, teacherComment?: string) =>
  attemptResponseSchema.parse(
    await apiRequest<unknown>(`/attempts/${encodeURIComponent(attemptId)}/release`, {
      method: 'POST',
      body: teacherComment && teacherComment.trim() !== '' ? { teacherComment } : {},
    }),
  );

export type { AttemptResponse, AttemptReview };
