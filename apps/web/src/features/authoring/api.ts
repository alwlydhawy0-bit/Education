import { lessonDetailResponseSchema, type LessonDetailResponse } from '@edu/contracts';
import { apiRequest, ApiError } from '../../shared/api/client.ts';

/**
 * The authoring endpoints this feature uses.
 *
 * EVERY RESPONSE IS PARSED, not cast. A cast would let a server that grew a new
 * field — or a proxy that rewrote one — reach the component as whatever shape
 * it liked; the schema is `.strict()`, so an unexpected field is a thrown error
 * at the boundary rather than a surprise three renders later.
 *
 * WHAT THE LIFECYCLE CALLS SEND: at most the concurrency token. Publishing and
 * archiving take the resource from the URL and the actor from the session, and
 * the server rejects any other field with a 400. Nothing here sends a status, a
 * role, an author, an organization or an owner, because there is no request
 * shape in which the server would read one.
 */
export const fetchLesson = async (
  lessonId: string,
  signal?: AbortSignal,
): Promise<LessonDetailResponse> =>
  lessonDetailResponseSchema.parse(
    await apiRequest<unknown>(`/lessons/${encodeURIComponent(lessonId)}`, signal ? { signal } : {}),
  );

/**
 * Patches a lesson.
 *
 * `expectedUpdatedAt` is the `updatedAt` of the version the author was actually
 * looking at. The server compares it to the stored row and refuses the write
 * when they differ, which is what stops a form loaded ten minutes ago from
 * silently overwriting somebody else's save. It is a PRECONDITION, not data:
 * the server never stores it, and a caller cannot use it to assert anything
 * about identity, ownership or state.
 *
 * `objectives` is sent ONLY when the caller means to change it. The server
 * replaces the list wholesale and refuses the replacement on a published
 * lesson, so including an unchanged list in a title-only edit would turn a legal
 * edit into a 409 — see the note in `LessonEditor`.
 */
export const updateLesson = async (
  lessonId: string,
  patch: {
    title?: string;
    contentBody?: string;
    objectives?: readonly string[];
    expectedUpdatedAt: string;
  },
): Promise<LessonDetailResponse> =>
  lessonDetailResponseSchema.parse(
    await apiRequest<unknown>(`/lessons/${encodeURIComponent(lessonId)}`, {
      method: 'PATCH',
      body: patch,
    }),
  );

const setStatus = async (
  lessonId: string,
  transition: 'publish' | 'archive',
  expectedUpdatedAt: string,
): Promise<LessonDetailResponse> =>
  lessonDetailResponseSchema.parse(
    await apiRequest<unknown>(`/lessons/${encodeURIComponent(lessonId)}/${transition}`, {
      method: 'POST',
      body: { expectedUpdatedAt },
    }),
  );

export const publishLesson = (
  lessonId: string,
  expectedUpdatedAt: string,
): Promise<LessonDetailResponse> => setStatus(lessonId, 'publish', expectedUpdatedAt);

export const archiveLesson = (
  lessonId: string,
  expectedUpdatedAt: string,
): Promise<LessonDetailResponse> => setStatus(lessonId, 'archive', expectedUpdatedAt);

/**
 * How a failed authoring call should be presented.
 *
 * Five outcomes, because five different things are wrong and four of them have
 * a different remedy:
 *
 *   stale       — somebody saved after this author loaded. Reload, reapply.
 *   lifecycle   — a content rule refused the transition. Act on other content.
 *   forbidden   — this actor may not do this. Nothing the author can do here.
 *   invalid     — the request itself was malformed or out of range. Fix input.
 *   unavailable — everything else.
 *
 * `unavailable` deliberately swallows 404, 401 and 5xx together. Separating
 * "does not exist" from "exists but is not yours" would rebuild, in the client,
 * exactly the existence oracle the server's 404-versus-403 rule exists to
 * prevent — so the client must not be able to tell either, and here it cannot.
 *
 * The 409 split is on `detail.reason`, never on the message text. The message is
 * prose written for a human and may be reworded or translated; the reason is a
 * contract.
 */
export type AuthoringFailure =
  | { readonly kind: 'stale' }
  | { readonly kind: 'lifecycle'; readonly reason: string }
  | { readonly kind: 'forbidden' }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'unavailable' };

export const classifyFailure = (error: unknown): AuthoringFailure => {
  if (!(error instanceof ApiError)) return { kind: 'unavailable' };
  if (error.status === 409) {
    return error.detail?.['reason'] === 'stale_write'
      ? { kind: 'stale' }
      : // The server's own words for a refused transition — "Archive this
        // unit's 3 published lessons first". They name only the act and a
        // count: no learner, no organization, no content. Showing them beats
        // inventing a second vocabulary that drifts from the rules it
        // describes.
        { kind: 'lifecycle', reason: error.message };
  }
  if (error.status === 403) return { kind: 'forbidden' };
  if (error.status === 400) return { kind: 'invalid' };
  return { kind: 'unavailable' };
};

export type { LessonDetailResponse };
