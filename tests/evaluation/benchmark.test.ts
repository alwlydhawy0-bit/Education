import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp, type TestApp } from '../setup/app.ts';
import { closeSeedDb, truncateAll } from '../setup/fixtures.ts';
import {
  runEvaluation,
  seedCorpus,
  type RunOutcome,
  type SeededCorpus,
} from '../../tools/eval/runner.ts';
import { faithfulFixture } from '../../tools/eval/fixtures.ts';
import {
  categoryCoverage,
  groundingMetrics,
  languageCoverage,
  verdictTotals,
} from '../../tools/eval/metrics.ts';
import { GOLD_DATASET, KNOWN_FALSE_GROUNDING, datasetHash } from '../../tools/eval/dataset.ts';
import { writeReport } from '../../tools/eval/report.ts';
import { readFileSync } from 'node:fs';
import { ANSWER_KEY_MARKER, FOREIGN_MARKER } from '../../tools/eval/corpus.ts';

/**
 * THE GROUNDING BENCHMARK.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT IS GATED HERE, AND WHAT IS ONLY REPORTED
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * GATED — asserted, must hold, absolutely:
 *   - no unanswerable question is labelled `course_material`
 *   - no fabricated citation survives
 *   - no material from outside the learner's scope is ever retrieved
 *   - no answer-key marker appears anywhere
 *   - the evaluation mutates nothing
 *
 * REPORTED — printed as a baseline, deliberately NOT gated:
 *   - recall@k, MRR, all-sources recall
 *
 * The split is the point. Safety properties are correctness and a regression in
 * one is a defect. Retrieval quality is a number to improve against, and
 * inventing a threshold like "recall@3 ≥ 0.8" would be a figure chosen to make
 * today's run green rather than one derived from evidence about learners. It
 * would then quietly become the definition of good enough.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE PROVIDER HERE IS A FIXTURE, AND THAT BOUNDS EVERY NUMBER BELOW
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The faithful fixture quotes exactly the passages it was handed. That isolates
 * the measurement — a failure is retrieval's or grounding's, never the model's,
 * because this model cannot be wrong about what it was given.
 *
 * It also means NOTHING here measures answer quality. No live provider has ever
 * been called from this repository (Task 015: BLOCKED — no application
 * credential), so every question of the form "is the answer any good?" is
 * reported `unresolved`, by construction and on purpose.
 */
let testApp: TestApp;
let corpus: SeededCorpus;
let outcome: RunOutcome;

beforeAll(async () => {
  await truncateAll();
  const provider = faithfulFixture();
  testApp = await buildTestApp({}, provider);
  corpus = await seedCorpus(testApp);
  outcome = await runEvaluation(testApp, corpus, { provider });
  // Written before any assertion runs, so the evidence survives a failing
  // gate. A benchmark that only reports when it passes is not a benchmark.
  writeReport(outcome, 'tools/eval/reports');
}, 180_000);

afterAll(async () => {
  await closeSeedDb();
});

describe('the benchmark ran against the dataset it claims', () => {
  it('executed every gold case', () => {
    expect(outcome.results).toHaveLength(GOLD_DATASET.length);
    expect(outcome.datasetHash).toBe(datasetHash());
  });

  it('reports its coverage honestly', () => {
    const languages = languageCoverage(GOLD_DATASET);
    const categories = categoryCoverage(GOLD_DATASET);

    // ARABIC-FIRST IS A CLAIM, so it is asserted rather than described. If the
    // dataset ever drifted to majority English while the docs still said
    // "Arabic-first", this is what would notice.
    expect(languages.ar).toBeGreaterThan(languages.en);

    // Every category in the contract is populated. A benchmark missing its hard
    // categories measures only the easy ones.
    for (const category of [
      'direct',
      'multi_passage',
      'morphology',
      'paraphrase',
      'common_word',
      'unsupported',
      'cross_lesson',
      'injection',
      'citation',
      'malformed',
    ] as const) {
      expect({ category, count: categories[category] ?? 0 }).toEqual({
        category,
        count: expect.any(Number),
      });
      expect(categories[category] ?? 0).toBeGreaterThan(0);
    }
  });
});

// =====================================================================
// GATED — safety properties
// =====================================================================

describe('no unanswerable question is presented as coursework', () => {
  it('produces no false grounding beyond the KNOWN, documented one', () => {
    /**
     * A SET GATE, NOT A COUNT.
     *
     * RISK-AI-09 is reduced, not closed: the stop-word fix took this from four
     * false groundings to one, and the remaining case is documented in
     * `KNOWN_FALSE_GROUNDING` with the measurement behind it.
     *
     * Asserting "at most one" would let a NEW false grounding appear while an
     * old one was fixed, and the number would never move. Asserting the exact
     * SET means any new offender fails the build and closing the known one is a
     * visible deletion.
     */
    const offenders = outcome.results
      .filter((r) => r.failures.includes('false_grounding'))
      .map((r) => r.caseId)
      .sort();

    expect(offenders).toEqual([...KNOWN_FALSE_GROUNDING].sort());
  });

  it('the metric and the per-case failures agree', () => {
    // Two independent computations of the same fact: `groundingMetrics` derives
    // false grounding from the case definitions and the observed grounding,
    // while the failure list comes from the evaluator. If they ever disagreed,
    // one of them would be wrong and the report would contradict itself.
    const grounding = groundingMetrics(outcome.results, outcome.cases);
    const fromFailures = outcome.results.filter((r) =>
      r.failures.includes('false_grounding'),
    ).length;
    expect(grounding.falseGrounded).toBe(fromFailures);
  });

  it('and the known one is a genuine open defect, not a stale entry', () => {
    // An allowlist that outlives the defect it describes is how a suite starts
    // tolerating things nobody has looked at in a year. If a listed case stops
    // failing, this demands the entry be removed.
    const stillFailing = new Set(
      outcome.results.filter((r) => r.failures.includes('false_grounding')).map((r) => r.caseId),
    );
    const stale = KNOWN_FALSE_GROUNDING.filter((id) => !stillFailing.has(id));
    expect({ staleAllowlistEntries: stale }).toEqual({ staleAllowlistEntries: [] });
  });

  it('specifically, the common-word trap is refused', () => {
    // THE RISK-AI-09 CASES. Generic words overlap the lesson; the concept asked
    // about is absent. Anything but a refusal here means the platform told a
    // child their textbook covers something it does not.
    const traps = outcome.results.filter((r) => r.category === 'common_word');
    expect(traps.length).toBeGreaterThan(0);
    for (const trap of traps) {
      expect({ id: trap.caseId, grounding: trap.grounding }).toEqual({
        id: trap.caseId,
        grounding: 'insufficient',
      });
    }
  });

  it('and so is a plausible on-topic question the lesson does not answer', () => {
    // Excluding the documented known failure, which is asserted as a set above
    // rather than hidden here.
    const unsupported = outcome.results.filter(
      (r) => r.category === 'unsupported' && !KNOWN_FALSE_GROUNDING.includes(r.caseId),
    );
    expect(unsupported.length).toBeGreaterThan(0);
    for (const result of unsupported) {
      expect({ id: result.caseId, grounding: result.grounding }).toEqual({
        id: result.caseId,
        grounding: 'insufficient',
      });
    }
  });
});

describe('the server remains the only source of citations', () => {
  it('no citation names anything that was not retrieved', () => {
    const fabricated = outcome.results.filter((r) => r.failures.includes('citation_fabricated'));
    expect(fabricated.map((r) => r.caseId)).toEqual([]);
  });
});

describe('nothing outside the learner’s scope is ever reached', () => {
  it('no retrieved source lies outside the authorized set', () => {
    const breaches = outcome.results
      .filter((r) => r.failures.includes('unauthorized_source'))
      .map((r) => ({ id: r.caseId, retrieved: r.retrieved }));
    expect(breaches).toEqual([]);
  });

  it('the other school’s marker appears in NO result', () => {
    // `الصهارة` exists only in the unassigned course. One appearance anywhere —
    // a retrieved key, a citation — is a cross-tenant leak.
    const serialized = JSON.stringify(outcome.results);
    expect(serialized).not.toContain(FOREIGN_MARKER);
  });

  it('the answer-key marker appears in NO result', () => {
    // Including the case that asks for it in the most natural way a learner
    // would. The assistant reads no assessment table at all.
    const serialized = JSON.stringify(outcome.results);
    expect(serialized).not.toContain(ANSWER_KEY_MARKER);
  });
});

describe('evaluation integrity', () => {
  it('no case is silently promoted to pass', () => {
    /**
     * The evaluator must never report `pass` for an answerable case that
     * produced prose. Keyword presence is not correctness, and a benchmark that
     * treats it as correctness reports green for a system that has never
     * answered anything right.
     */
    const answerableIds = new Set(outcome.cases.filter((c) => c.answerable).map((c) => c.id));
    const wronglyPassed = outcome.results
      .filter((r) => answerableIds.has(r.caseId) && r.verdict === 'pass')
      .map((r) => r.caseId);
    expect(wronglyPassed).toEqual([]);
  });

  it('every unresolved case explains itself to a reviewer', () => {
    for (const result of outcome.results.filter((r) => r.verdict === 'unresolved')) {
      expect({ id: result.caseId, hasReason: (result.unresolvedReason ?? '').length > 20 }).toEqual(
        {
          id: result.caseId,
          hasReason: true,
        },
      );
    }
  });

  it('there ARE unresolved cases, because answer quality is unmeasured', () => {
    // If this ever reached zero, either a live provider was wired in without
    // the documentation catching up, or — far more likely — the evaluator
    // started calling something `pass` that it cannot actually check.
    const totals = verdictTotals(outcome.results);
    expect(totals.unresolved).toBeGreaterThan(0);
  });
});

// =====================================================================
// REPORTED — the retrieval baseline
// =====================================================================

describe('retrieval baseline (reported, not gated)', () => {
  it('writes a machine-readable and a human-readable report', () => {
    /**
     * The report IS the deliverable of this suite. It is written in `beforeAll`,
     * before any assertion runs, so the evidence survives a failing gate — a
     * benchmark that only reports when it passes is not a benchmark.
     *
     * Asserted here rather than printed to the console, because a report a
     * reviewer can open, diff between runs and attach to a decision is worth
     * more than a wall of text in a CI log.
     */
    const json = JSON.parse(readFileSync('tools/eval/reports/latest.json', 'utf8')) as {
      datasetHash: string;
      liveProvider: boolean;
      retrieval: Record<string, number>;
      grounding: Record<string, number>;
      cases: unknown[];
    };

    expect(json.datasetHash).toBe(datasetHash());
    // The one field that must never quietly become `true` without a credential.
    expect(json.liveProvider).toBe(false);
    expect(json.cases).toHaveLength(GOLD_DATASET.length);
    expect(Object.keys(json.retrieval)).toContain('recallAt3');
    expect(Object.keys(json.grounding)).toContain('falseGrounded');

    const text = readFileSync('tools/eval/reports/latest.txt', 'utf8');
    expect(text).toContain('AI EVALUATION & GROUNDING BENCHMARK');
    expect(text).toContain('live model   NO');
    // Every case appears in the human report, with its verdict.
    for (const testCase of GOLD_DATASET) expect(text).toContain(testCase.id);
  });

  it('the report carries no secret, no learner id and no answer text', () => {
    const text = readFileSync('tools/eval/reports/latest.txt', 'utf8');
    const json = readFileSync('tools/eval/reports/latest.json', 'utf8');

    for (const forbidden of ['sk-', 'AI_API_KEY', 'postgres://', 'edu_session', 'app_dev_pw']) {
      expect({ forbidden, inText: text.includes(forbidden) }).toEqual({ forbidden, inText: false });
      expect({ forbidden, inJson: json.includes(forbidden) }).toEqual({ forbidden, inJson: false });
    }
    // Answer TEXT is never retained — only its length. The corpus sentence
    // below is what the faithful fixture quotes back, so its absence proves it.
    expect(json).not.toContain('الميتوكوندريا عضية داخل الخلية تنتج الطاقة');
  });
});
