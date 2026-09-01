import type { AttemptQuestion, QuestionType, SubmitAttemptRequest } from '@edu/contracts';

/**
 * The pure parts of the assessment domain.
 *
 * WHAT IS NOT HERE: the scoring rule.
 *
 * That is deliberate and worth stating, because a `score()` function in this
 * file is the obvious thing to write. Scoring requires the answer key, and the
 * key is never loaded into application memory — it is compared inside the
 * database by `app_score_attempt`, which the application role may not execute
 * (migration 0019). A TypeScript scorer would need the key here, which would
 * undo the control the whole design is arranged around.
 *
 * The consequence, stated honestly: the scoring rule is specified and enforced
 * in ONE place, SQL, and is therefore tested against a real database rather
 * than as a unit. `tests/integration/rls-assessment.test.ts` enumerates it —
 * exact set match, no partial credit, unanswered scores zero, an empty key
 * awards nothing. A second implementation here would be unit-testable and could
 * disagree with the one that actually marks children's work.
 */

/**
 * How many options a learner must select, derived from the question TYPE.
 *
 * NEVER from the key, and this function's inability to see one is the point.
 * Telling a learner that a multiple-choice question has exactly two correct
 * answers narrows the guess space for free — from 2^n subsets to n-choose-2 —
 * so a multiple-choice question says only "one or more" and returns null.
 */
export function selectionLimitFor(type: QuestionType): number | null {
  return type === 'multiple_choice' ? null : 1;
}

/** A submitted answer that a legitimate client could not have produced. */
export interface PayloadViolation {
  readonly kind: 'unknown_question' | 'unknown_option' | 'too_many_options';
  readonly questionId: string;
}

export interface ValidatedPayload {
  /** Flattened (questionId, optionId) pairs, ready to insert. */
  readonly rows: ReadonlyArray<readonly [questionId: string, optionId: string]>;
  readonly violations: readonly PayloadViolation[];
}

/**
 * Checks a submission against the paper the learner was actually given.
 *
 * The database refuses all three of these anyway — a foreign question by the
 * answer guard, a foreign option by the composite foreign key, and a duplicate
 * by the primary key. This runs first for two reasons, and neither is
 * validation for its own sake:
 *
 *   1. It turns a constraint violation into a 400 the client can act on,
 *      instead of a 500 from an error it cannot see.
 *   2. It is the DETECTION point. A payload naming a question from another
 *      assessment is not a typo — no interface can produce one — so it is
 *      reported as `assessment.suspicious_submission` rather than quietly
 *      rejected. A single occurrence is noise; a run of them from one actor is
 *      the shape of somebody mapping the question bank.
 *
 * A question the learner simply did not answer is NOT a violation: an omitted
 * question and an empty selection both mean "no answer" and both score zero.
 * Refusing an incomplete paper would punish the learner who ran out of time.
 */
export function validateAnswerPayload(
  questions: readonly AttemptQuestion[],
  submission: SubmitAttemptRequest,
): ValidatedPayload {
  const byQuestion = new Map(questions.map((q) => [q.id, q]));
  const rows: Array<readonly [string, string]> = [];
  const violations: PayloadViolation[] = [];

  for (const answer of submission.answers) {
    const question = byQuestion.get(answer.questionId);
    if (!question) {
      violations.push({ kind: 'unknown_question', questionId: answer.questionId });
      continue;
    }

    // A Set FIRST, and the order matters. A repeated selection collapses here
    // rather than colliding with the answer table's primary key, and duplicates
    // are the one malformed shape that is plausibly a client retry rather than
    // an attack — so they are absorbed silently rather than raising an alarm.
    //
    // Counting the RAW array against the limit below would flag `[a, a]` on a
    // single-choice question as two selections, which is a false alarm on a
    // detection signal that is supposed to mean "no interface produced this".
    // A unit test pins the ordering.
    const selected = new Set(answer.selectedOptionIds);

    const limit = selectionLimitFor(question.questionType);
    if (limit !== null && selected.size > limit) {
      // Two DISTINCT options on a single-choice question is not an attempt at
      // an answer; the scorer would refuse it anyway, since it demands set
      // equality — but a client that sends one is not the client we shipped.
      violations.push({ kind: 'too_many_options', questionId: answer.questionId });
      continue;
    }

    const optionIds = new Set(question.options.map((o) => o.id));

    let foreign = false;
    for (const optionId of selected) {
      if (!optionIds.has(optionId)) {
        foreign = true;
        break;
      }
    }
    if (foreign) {
      violations.push({ kind: 'unknown_option', questionId: answer.questionId });
      continue;
    }

    for (const optionId of selected) rows.push([question.id, optionId]);
  }

  return { rows, violations };
}
