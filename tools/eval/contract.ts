import { z } from 'zod';

/**
 * THE EVALUATION CONTRACT.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT THIS MEASURES, AND WHAT IT CANNOT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Four things are measured separately and must never be collapsed into one
 * number, because each can be good while the others are bad:
 *
 *   A. RETRIEVAL      — did the right passages come back, and in what order?
 *   B. GROUNDING      — did the SERVER label the answer honestly?
 *   C. SAFETY         — did anything unauthorized reach the provider or the
 *                       learner?
 *   D. ANSWER QUALITY — is the prose actually correct and useful?
 *
 * A, B and C are deterministic properties of this platform and are measured
 * here. **D is a property of the model** and is not measurable without one. A
 * case whose correctness cannot be established deterministically is reported
 * `unresolved`, never `pass`.
 *
 * There is deliberately no "AI quality score". A fluent wrong answer and a
 * correct answer both cite sources; a single number would hide the difference,
 * which is the difference that matters to a child.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * NO LLM-AS-JUDGE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A second model grading the first would add an unverified dependency and
 * launder its errors into a metric. Correctness is instead expressed as
 * checkable structure — expected sources, required concepts, forbidden
 * concepts — and everything outside that structure is left explicitly
 * unresolved for a human.
 */

/** Where a case's expected support lives, by LOGICAL key rather than by id. */
export const expectedSourceSchema = z
  .object({
    /**
     * The corpus key of the lesson, e.g. `cell`. Runtime ids are UUIDs minted
     * at seed time, so a dataset that hardcoded them would be rewritten on
     * every run — and a dataset that is rewritten is not a gold dataset.
     */
    lessonKey: z.string().min(1),
    /**
     * Which paragraph of that lesson supports the answer, 0-based, matching the
     * `lesson:<uuid>#<n>` ids retrieval mints. Omitted when any passage of the
     * lesson counts, or when the support is the objective.
     */
    paragraph: z.number().int().min(0).optional(),
    /** Set when the supporting text is the learning objective, not the body. */
    objective: z.boolean().optional(),
    /**
     * The exact supporting sentence, copied from the corpus.
     *
     * Not used for matching — it is provenance. A reviewer changing an expected
     * source has to change this too, which makes a quiet edit visible in review
     * and keeps every case traceable to real content.
     */
    quote: z.string().min(1),
  })
  .strict();

export type ExpectedSource = z.infer<typeof expectedSourceSchema>;

export const evaluationCategorySchema = z.enum([
  'direct', //        A. answer plainly present
  'multi_passage', // B. needs two passages of one lesson
  'morphology', //    C. Arabic form differs from the corpus
  'paraphrase', //    D. different wording for the same concept
  'common_word', //   E. generic words overlap, concept absent  → RISK-AI-09
  'unsupported', //   F. not in the material at all
  'cross_lesson', //  G. answer lives in a different lesson
  'injection', //     H. attempts to subvert instructions
  'citation', //      I. provider claims sources it was not given
  'malformed', //     J. empty, trivial or ambiguous input
]);

export const evaluationCaseSchema = z
  .object({
    /** Stable forever. Metrics are compared across runs by this id. */
    id: z.string().regex(/^EV-[A-Z]{2}-\d{3}$/),
    language: z.enum(['ar', 'en']),
    category: evaluationCategorySchema,
    difficulty: z.enum(['easy', 'moderate', 'hard']),

    /** Corpus keys. The runner resolves them to seeded rows. */
    courseKey: z.string().min(1),
    lessonKey: z.string().min(1),

    /** Exactly what a learner would type. */
    question: z.string().min(1),

    /**
     * Whether the learner's OWN material can answer this at all.
     *
     * The single most important field in the dataset. A case marked
     * unanswerable that comes back `course_material` is a FALSE GROUNDING —
     * the platform telling a child their textbook says something it does not.
     */
    answerable: z.boolean(),

    /** Empty for unanswerable cases, by construction. */
    expectedSources: z.array(expectedSourceSchema),

    /** What the server must decide. */
    expectedGrounding: z.enum(['course_material', 'insufficient', 'unavailable']),

    /** The HTTP status a learner should receive. */
    expectedStatus: z.union([z.literal(200), z.literal(400), z.literal(404)]),

    /**
     * Concepts a correct answer must mention, lowercased for matching.
     *
     * A WEAK, ONE-DIRECTIONAL SIGNAL, and labelled as such. Their presence does
     * not make an answer correct — a wrong answer can contain every one of them
     * — so a case is never promoted to `pass` on this alone. Their ABSENCE is
     * informative, which is what they are checked for.
     */
    requiredConcepts: z.array(z.string()).default([]),

    /**
     * Strings that must NOT appear. This one IS decisive.
     *
     * Answer-key material, another school's marker word, a system-instruction
     * fragment: any of these in an answer is a failure regardless of how good
     * the rest of it reads.
     */
    forbiddenConcepts: z.array(z.string()).default([]),

    /** Why this case exists, in one sentence, for the reviewer. */
    notes: z.string().min(1),
  })
  .strict();

export type EvaluationCase = z.infer<typeof evaluationCaseSchema>;

/**
 * The verdict for one case.
 *
 * `unresolved` is a first-class outcome, not a soft failure. It means the
 * platform behaved correctly on every property that can be checked and the
 * remaining question — is the prose actually right? — needs a person. Turning
 * it into `pass` would be the single easiest way to make this whole exercise
 * dishonest.
 */
export const caseVerdictSchema = z.enum(['pass', 'fail', 'unresolved']);
export type CaseVerdict = z.infer<typeof caseVerdictSchema>;

export type FailureCategory =
  | 'retrieval_miss' //        expected support never came back
  | 'false_grounding' //       unanswerable, labelled as coursework
  | 'missed_grounding' //      answerable and supported, labelled insufficient
  | 'citation_fabricated' //   an invented citation survived
  | 'forbidden_content' //     something that must never appear, appeared
  | 'wrong_status' //          the HTTP contract was not honoured
  | 'unauthorized_source'; //  material from outside the learner's scope

/** Everything a human reviewer needs, and nothing they do not. */
export interface CaseResult {
  readonly caseId: string;
  readonly language: 'ar' | 'en';
  readonly category: EvaluationCase['category'];
  readonly question: string;
  readonly status: number;
  /** Ordered as retrieved. Logical keys, so a report is readable. */
  readonly retrieved: readonly string[];
  readonly expected: readonly string[];
  /** 1-based position of the first expected source, or null. */
  readonly firstExpectedRank: number | null;
  readonly grounding: string | null;
  readonly expectedGrounding: string;
  readonly citedSources: readonly string[];
  /** Present only when a provider produced one. Never a learner's own data. */
  readonly answerLength: number;
  readonly missingRequiredConcepts: readonly string[];
  readonly presentForbiddenConcepts: readonly string[];
  readonly verdict: CaseVerdict;
  readonly failures: readonly FailureCategory[];
  /** Why a verdict is `unresolved`, in the reviewer's terms. */
  readonly unresolvedReason: string | null;
}
