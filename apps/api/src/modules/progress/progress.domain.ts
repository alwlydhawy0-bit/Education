import type { ProgressStatus } from '@edu/contracts';

/**
 * The progress state machine.
 *
 *     not_started ──▶ in_progress ──▶ completed
 *
 * FORWARD ONLY, and `completed` is terminal.
 *
 * A learner may not un-complete a lesson. This is a record their teacher and
 * their guardian read, so "completed" has to mean something durable; a status
 * its own subject can toggle back is not evidence of anything, and a learner
 * who could retract a completion could also erase what a teacher had seen.
 *
 * Nothing about re-study is lost. Every touch moves `lastAccessedAt`, so "I
 * went back over this" is recorded — only the retraction is refused.
 *
 * Restating the same status is a no-op rather than an error, so a client that
 * sends `completed` twice (a double-tap, a retry after a timeout) gets the same
 * answer both times.
 *
 * This is duplicated by the `lesson_progress_guard` trigger in migration 0018,
 * deliberately: this function turns an invalid move into a clear 409 before it
 * reaches the database, and the trigger is the floor beneath it that no code
 * path can talk its way past.
 */
const RANK: Readonly<Record<ProgressStatus, number>> = {
  not_started: 0,
  in_progress: 1,
  completed: 2,
};

/** True when `to` is the same as, or ahead of, `from`. */
export function isForwardTransition(from: ProgressStatus, to: ProgressStatus): boolean {
  return RANK[to] >= RANK[from];
}

/** True when the move would actually change the stored status. */
export function isProgressAdvance(from: ProgressStatus, to: ProgressStatus): boolean {
  return RANK[to] > RANK[from];
}
