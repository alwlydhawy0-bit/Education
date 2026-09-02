import { courseMasterySchema, type CourseMastery } from '@edu/contracts';
import { apiRequest } from '../../shared/api/client.ts';

/**
 * The mastery endpoints this feature uses.
 *
 * THERE IS NO WRITE FUNCTION HERE, and there is nothing to write to. Mastery is
 * derived on the server from evidence the database emitted; no route accepts a
 * state, a score, or an evidence row. A function here that tried would have
 * nowhere to send the request.
 *
 * The response is parsed through the shared `.strict()` contract, so a field the
 * server did not intend to send becomes a thrown error rather than a value some
 * component renders. The browser is not a trust boundary — but a client that
 * silently accepts unexpected fields cannot help anyone notice when the server
 * starts sending them.
 */
export const fetchCourseMastery = async (
  courseId: string,
  signal?: AbortSignal,
): Promise<CourseMastery> =>
  courseMasterySchema.parse(
    await apiRequest<unknown>(
      `/me/courses/${encodeURIComponent(courseId)}/mastery`,
      signal ? { signal } : {},
    ),
  );

export type { CourseMastery };
