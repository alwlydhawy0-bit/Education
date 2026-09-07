import type { Tx } from '../../platform/db.ts';

/**
 * What the tutor needs from retrieval, expressed as the tutor's own contract.
 *
 * THE TUTOR IMPORTS NO OTHER MODULE. It needs two retrievers that live in two
 * other domains — `knowledge`'s vector index and `assistant`'s live full-text
 * search — and reaching into either directly would couple three modules into
 * one and make none of them extractable. `dependency-rules.test.ts` rule 3
 * forbids it, and caught this exact violation when the tutor first imported
 * both repositories.
 *
 * So the dependency is INVERTED: the tutor states what it requires, the
 * composition root supplies something that satisfies it, and the adapter that
 * knows about both other modules lives in `app.ts` where cross-module knowledge
 * is allowed to exist.
 *
 * The interface is deliberately narrower than either repository. It cannot
 * index, cannot write, cannot ask about a course the caller did not first
 * establish is in scope — so a change to how retrieval works reaches the tutor
 * only through these three methods.
 */

export interface RetrievedPassage {
  /** Stable within the retrieved set; what a citation must match. */
  readonly id: string;
  readonly lessonId: string;
  readonly lessonTitle: string;
  /** UNTRUSTED. Curriculum prose written by a human author. */
  readonly text: string;
}

export interface TutorRetriever {
  /**
   * The courses this actor may study, right now, from the live enrolment graph.
   *
   * Takes an actor id and NOTHING the client sent. A signature that accepted a
   * course list would let a caller hand its own filter in as the scope, which
   * is the bug the whole pre-filter shape exists to prevent.
   */
  coursesInScope(tx: Tx, actorId: string): Promise<string[]>;

  /**
   * Semantic passages, pre-filtered to `courseIds` before ranking.
   *
   * May legitimately return nothing: the vector index is a derived store that
   * has to be built by hand, so an un-indexed course is silent rather than an
   * error. That is what `live` is for.
   */
  semantic(
    tx: Tx,
    options: { courseIds: readonly string[]; question: string; topK: number },
  ): Promise<RetrievedPassage[]>;

  /**
   * Passages from the LIVE lessons, via full-text search.
   *
   * Cannot be stale, because there is nothing to keep fresh — it reads the
   * lesson rows themselves, under the caller's own row security. The floor
   * beneath `semantic`.
   */
  live(
    tx: Tx,
    options: { courseId: string; question: string; limit: number },
  ): Promise<RetrievedPassage[]>;
}
