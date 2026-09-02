import {
  activityResponseSchema,
  enrolledCourseResponseSchema,
  lessonDetailResponseSchema,
  type ActivityResponse,
  type EnrolledCourseResponse,
  type LessonDetailResponse,
} from '@edu/contracts';
import { z } from 'zod';
import { apiRequest } from '../../shared/api/client.ts';

/**
 * The endpoints the learner curriculum experience reads.
 *
 * THERE IS NO WRITE FUNCTION HERE. Delivery is a read surface: the learner's
 * writes — starting an attempt, submitting it, recording progress — belong to
 * the assessment and progress features, which already own them and already
 * carry their own authorization tests. A second path to those writes would be a
 * second place for their rules to be got wrong.
 *
 * NOTHING HERE FILTERS. No `status === 'published'` check, no "hide the drafts",
 * no client-side narrowing by class. The server returns exactly the set this
 * learner may see and the components render exactly what arrives; a filter here
 * would be a second copy of the visibility rule, and the copy that is wrong is
 * always the one nobody tests. If a draft ever appeared in one of these
 * responses, the correct outcome is that it is VISIBLE in the interface and
 * caught by the server tests — not silently hidden by the browser.
 *
 * Every response is parsed through the shared `.strict()` contract, so a field
 * the server did not intend to send throws at the boundary instead of reaching
 * a component.
 */
const itemsOf = <T extends z.ZodTypeAny>(schema: T) =>
  z.object({ items: z.array(schema) }).strict();

export const fetchMyCourses = async (signal?: AbortSignal): Promise<EnrolledCourseResponse[]> =>
  itemsOf(enrolledCourseResponseSchema).parse(
    await apiRequest<unknown>('/me/courses', signal ? { signal } : {}),
  ).items;

export const fetchLesson = async (
  lessonId: string,
  signal?: AbortSignal,
): Promise<LessonDetailResponse> =>
  lessonDetailResponseSchema.parse(
    await apiRequest<unknown>(`/lessons/${encodeURIComponent(lessonId)}`, signal ? { signal } : {}),
  );

/**
 * The activities attached to one lesson.
 *
 * A separate request rather than a field on the lesson, because that is the
 * shape the API already has and merging them would mean a second endpoint
 * returning the same rows. Two requests per lesson screen is not an N+1: it is
 * O(1) per screen, and it stays O(1) however many activities the lesson has.
 */
export const fetchLessonActivities = async (
  lessonId: string,
  signal?: AbortSignal,
): Promise<ActivityResponse[]> =>
  itemsOf(activityResponseSchema).parse(
    await apiRequest<unknown>(
      `/lessons/${encodeURIComponent(lessonId)}/activities`,
      signal ? { signal } : {},
    ),
  ).items;

export type { ActivityResponse, EnrolledCourseResponse, LessonDetailResponse };
