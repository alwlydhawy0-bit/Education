import { describe, expect, it } from 'vitest';
import { evaluateCase } from '../../tools/eval/evaluator.ts';
import { evaluationCaseSchema, type EvaluationCase } from '../../tools/eval/contract.ts';
import { groundingMetrics, retrievalMetrics, verdictTotals } from '../../tools/eval/metrics.ts';

/**
 * THE EVALUATOR, EVALUATED.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THE BENCHMARK IS NOT ENOUGH
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Found by defect injection. Removing the expected-source check from the
 * evaluator changed no benchmark result, because the benchmark asserts on the
 * PLATFORM's behaviour and only reports the evaluator's. An evaluator that
 * quietly stopped checking would produce a cleaner report and nobody would
 * know — which is the most dangerous failure available to a measurement tool,
 * because its output is trusted precisely when nobody is re-deriving it.
 *
 * So the evaluator is tested directly, against inputs whose correct verdict is
 * known by construction. These are pure-function tests: no database, no HTTP,
 * no provider.
 */
const baseCase = (over: Partial<EvaluationCase> = {}): EvaluationCase =>
  evaluationCaseSchema.parse({
    id: 'EV-AR-001',
    language: 'ar',
    category: 'direct',
    difficulty: 'easy',
    courseKey: 'science',
    lessonKey: 'cell',
    question: 'ما هي الميتوكوندريا؟',
    answerable: true,
    expectedSources: [{ lessonKey: 'cell', paragraph: 1, quote: 'a supporting sentence here' }],
    expectedGrounding: 'course_material',
    expectedStatus: 200,
    requiredConcepts: [],
    forbiddenConcepts: [],
    notes: 'fixture',
    ...over,
  });

const observed = (over: Partial<Parameters<typeof evaluateCase>[2]> = {}) => ({
  status: 200,
  retrieved: ['cell#1'],
  grounding: 'course_material',
  citedSources: ['cell#1'],
  answer: 'الميتوكوندريا تنتج الطاقة.',
  claimedCitations: [],
  authorizedSources: new Set(['cell#0', 'cell#1', 'cell#2', 'cell#3', 'cell#objective']),
  ...over,
});

describe('expected sources are actually validated', () => {
  it('a missing expected source is a retrieval_miss, not a pass', () => {
    const result = evaluateCase(baseCase(), ['cell#1'], observed({ retrieved: ['cell#3'] }));
    expect(result.failures).toContain('retrieval_miss');
    expect(result.verdict).toBe('fail');
  });

  it('the rank of the first expected source is computed, not assumed', () => {
    const result = evaluateCase(
      baseCase(),
      ['cell#1'],
      observed({ retrieved: ['cell#0', 'cell#3', 'cell#1'] }),
    );
    expect(result.firstExpectedRank).toBe(3);
    expect(result.failures).not.toContain('retrieval_miss');
  });

  it('a retrieved-but-unexpected set does not count as a hit', () => {
    const result = evaluateCase(
      baseCase(),
      ['cell#1'],
      observed({ retrieved: ['cell#0', 'cell#2'] }),
    );
    expect(result.firstExpectedRank).toBeNull();
  });
});

describe('grounding honesty is enforced by the evaluator', () => {
  it('an unanswerable case labelled course_material is a false_grounding', () => {
    const result = evaluateCase(
      baseCase({ answerable: false, expectedSources: [], expectedGrounding: 'insufficient' }),
      [],
      observed({ grounding: 'course_material' }),
    );
    expect(result.failures).toContain('false_grounding');
    expect(result.verdict).toBe('fail');
  });

  it('an unanswerable case correctly refused passes', () => {
    const result = evaluateCase(
      baseCase({ answerable: false, expectedSources: [], expectedGrounding: 'insufficient' }),
      [],
      observed({ grounding: 'insufficient', citedSources: [], answer: '' }),
    );
    expect(result.failures).toEqual([]);
    expect(result.verdict).toBe('pass');
  });

  it('a supported case wrongly refused is a missed_grounding', () => {
    const result = evaluateCase(
      baseCase(),
      ['cell#1'],
      observed({ grounding: 'insufficient', citedSources: [], answer: '' }),
    );
    expect(result.failures).toContain('missed_grounding');
  });
});

describe('citations are checked against what was retrieved', () => {
  it('a cited source that was never retrieved is a fabrication', () => {
    const result = evaluateCase(
      baseCase(),
      ['cell#1'],
      observed({ retrieved: ['cell#1'], citedSources: ['cell#1', 'cell#9'] }),
    );
    expect(result.failures).toContain('citation_fabricated');
    expect(result.verdict).toBe('fail');
  });
});

describe('scope violations are caught', () => {
  it('a retrieved source outside the authorized set is a breach', () => {
    const result = evaluateCase(
      baseCase(),
      ['cell#1'],
      observed({ retrieved: ['cell#1', 'volcano#0'] }),
    );
    expect(result.failures).toContain('unauthorized_source');
    expect(result.verdict).toBe('fail');
  });
});

describe('forbidden content is decisive; required concepts are not', () => {
  it('a forbidden string present in the answer fails the case', () => {
    const result = evaluateCase(
      baseCase({ forbiddenConcepts: ['طوكيو'] }),
      ['cell#1'],
      observed({ answer: 'عاصمة اليابان هي طوكيو.' }),
    );
    expect(result.failures).toContain('forbidden_content');
    expect(result.verdict).toBe('fail');
  });

  it('MISSING required concepts do NOT fail — they defer to a human', () => {
    // The asymmetry is deliberate. A missing keyword might mean a bad answer or
    // a well-phrased one; only a person can tell, so it is `unresolved`.
    const result = evaluateCase(
      baseCase({ requiredConcepts: ['ميتوكوندريا'] }),
      ['cell#1'],
      observed({ answer: 'إجابة لا تذكر الكلمة المطلوبة.' }),
    );
    expect(result.failures).toEqual([]);
    expect(result.verdict).toBe('unresolved');
    expect(result.unresolvedReason).toContain('required concepts');
  });

  it('PRESENT required concepts still do NOT produce a pass', () => {
    /**
     * THE MOST IMPORTANT ASSERTION IN THIS FILE.
     *
     * Retrieval was perfect, the citation is valid, the grounding is right and
     * every required word is present — and the verdict is still `unresolved`,
     * because "contains the word mitochondria" is not "correctly explains
     * mitochondria". An evaluator that returned `pass` here would report a
     * green benchmark for a system that had never answered anything correctly.
     */
    const result = evaluateCase(
      baseCase({ requiredConcepts: ['ميتوكوندريا'] }),
      ['cell#1'],
      observed({ answer: 'الميتوكوندريا تنتج الطاقة.' }),
    );
    expect(result.failures).toEqual([]);
    expect(result.verdict).toBe('unresolved');
  });
});

describe('the HTTP contract is part of the verdict', () => {
  it('an unexpected status fails the case', () => {
    const result = evaluateCase(
      baseCase({ expectedStatus: 200 }),
      ['cell#1'],
      observed({ status: 404 }),
    );
    expect(result.failures).toContain('wrong_status');
  });
});

describe('the answer text never enters a result', () => {
  it('only its length is retained', () => {
    const result = evaluateCase(baseCase(), ['cell#1'], observed({ answer: 'سر لا يجب تخزينه' }));
    expect(result.answerLength).toBe('سر لا يجب تخزينه'.length);
    expect(JSON.stringify(result)).not.toContain('سر لا يجب تخزينه');
  });
});

describe('metrics compute what they claim', () => {
  const cases = [
    baseCase({ id: 'EV-AR-001' }),
    baseCase({ id: 'EV-AR-002' }),
    baseCase({
      id: 'EV-AR-003',
      answerable: false,
      expectedSources: [],
      expectedGrounding: 'insufficient',
    }),
  ];

  it('recall@k uses the ANY-RELEVANT definition, at the stated k', () => {
    const results = [
      evaluateCase(cases[0]!, ['cell#1'], observed({ retrieved: ['cell#1'] })),
      evaluateCase(
        cases[1]!,
        ['cell#1'],
        observed({ retrieved: ['cell#0', 'cell#2', 'cell#3', 'cell#1'] }),
      ),
      evaluateCase(
        cases[2]!,
        [],
        observed({ grounding: 'insufficient', citedSources: [], answer: '' }),
      ),
    ];
    const metrics = retrievalMetrics(results, cases);

    expect(metrics.answerableCases).toBe(2);
    expect(metrics.recallAt1).toBe(0.5); // only the first hit at rank 1
    expect(metrics.recallAt5).toBe(1); // both within 5
    expect(metrics.mrr).toBe(Number(((1 + 0.25) / 2).toFixed(4)));
  });

  it('false grounding is counted separately from a missed answer', () => {
    const results = [
      evaluateCase(cases[2]!, [], observed({ grounding: 'course_material' })),
      evaluateCase(
        cases[0]!,
        ['cell#1'],
        observed({ grounding: 'insufficient', citedSources: [], answer: '' }),
      ),
    ];
    const metrics = groundingMetrics(results, cases);
    expect(metrics.falseGrounded).toBe(1);
    expect(metrics.missedGrounding).toBe(1);
  });

  it('verdict totals never fold unresolved into pass', () => {
    const results = [
      evaluateCase(cases[0]!, ['cell#1'], observed()),
      evaluateCase(
        cases[2]!,
        [],
        observed({ grounding: 'insufficient', citedSources: [], answer: '' }),
      ),
    ];
    const totals = verdictTotals(results);
    expect(totals).toEqual({ pass: 1, fail: 0, unresolved: 1 });
  });
});
