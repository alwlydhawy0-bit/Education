import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { RunOutcome } from './runner.ts';
import {
  categoryCoverage,
  groundingMetrics,
  languageCoverage,
  retrievalMetrics,
  verdictTotals,
} from './metrics.ts';

/**
 * REPORTING, IN TWO FORMS.
 *
 * Machine-readable for diffing between runs, human-readable for the review
 * §11 asks for. Both carry the dataset version and hash, because a metric
 * without the dataset that produced it is not comparable to anything.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT IS DELIBERATELY NOT IN A REPORT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * No credential, obviously. Also no answer TEXT — only its length. The answers
 * are derived from curriculum prose and there is no reason for a benchmark
 * artefact sitting in a working directory to accumulate them. A reviewer who
 * needs to read an answer can re-run one case.
 *
 * No learner identifiers either. The evaluation learner is a fixture, and
 * printing its id would establish a habit that ends badly the first time this
 * runs against a database with real people in it.
 */

export interface ReportPaths {
  readonly json: string;
  readonly text: string;
}

export function renderJson(outcome: RunOutcome): string {
  return JSON.stringify(
    {
      datasetVersion: outcome.datasetVersion,
      datasetHash: outcome.datasetHash,
      provider: outcome.providerName,
      liveProvider: false,
      generatedAt: new Date().toISOString(),
      coverage: {
        total: outcome.cases.length,
        byLanguage: languageCoverage(outcome.cases),
        byCategory: categoryCoverage(outcome.cases),
      },
      retrieval: retrievalMetrics(outcome.results, outcome.cases),
      grounding: groundingMetrics(outcome.results, outcome.cases),
      verdicts: verdictTotals(outcome.results),
      cases: outcome.results,
    },
    null,
    2,
  );
}

export function renderText(outcome: RunOutcome): string {
  const retrieval = retrievalMetrics(outcome.results, outcome.cases);
  const grounding = groundingMetrics(outcome.results, outcome.cases);
  const totals = verdictTotals(outcome.results);
  const languages = languageCoverage(outcome.cases);

  const lines: string[] = [
    'AI EVALUATION & GROUNDING BENCHMARK',
    '===================================',
    `dataset      ${outcome.datasetVersion}  (hash ${outcome.datasetHash})`,
    `provider     ${outcome.providerName}`,
    'live model   NO — this run called no external provider',
    `cases        ${outcome.results.length}  (ar ${languages.ar} / en ${languages.en})`,
    '',
    'RETRIEVAL  (reported as a baseline; deliberately not gated)',
    `  answerable cases        ${retrieval.answerableCases}`,
    `  recall@1                ${retrieval.recallAt1}`,
    `  recall@3                ${retrieval.recallAt3}`,
    `  recall@5                ${retrieval.recallAt5}`,
    `  all-sources recall      ${retrieval.allSourcesRecall}`,
    `  MRR                     ${retrieval.mrr}`,
    `  false-positive rate     ${retrieval.falsePositiveRetrievalRate}  (over ${retrieval.unansweredCases} unanswerable cases)`,
    '',
    'GROUNDING  (gated: fabricatedAccepted must be 0; falseGrounded must match',
    '            the documented KNOWN_FALSE_GROUNDING set exactly)',
    `  true grounded           ${grounding.trueGrounded}`,
    `  FALSE GROUNDED          ${grounding.falseGrounded}`,
    `  correctly insufficient  ${grounding.correctlyInsufficient}`,
    `  missed grounding        ${grounding.missedGrounding}`,
    `  fabricated rejected     ${grounding.fabricatedCitationsRejected}`,
    `  fabricated ACCEPTED     ${grounding.fabricatedCitationsAccepted}`,
    '',
    'VERDICTS',
    `  pass ${totals.pass}    fail ${totals.fail}    unresolved ${totals.unresolved}`,
    '',
    'UNRESOLVED is not a soft pass. It means the platform behaved correctly on',
    'every checkable property and whether the prose is actually right needs a',
    'person. No live model has been called, so answer quality is unmeasured.',
    '',
    'PER CASE',
    '--------',
  ];

  for (const result of outcome.results) {
    lines.push(
      `${result.caseId}  ${result.category.padEnd(14)} ${result.language}  ${result.verdict.toUpperCase().padEnd(10)}`,
    );
    lines.push(`    question    ${result.question}`);
    lines.push(`    status      ${result.status}`);
    lines.push(
      `    grounding   ${String(result.grounding)}   (expected ${result.expectedGrounding})`,
    );
    lines.push(`    expected    ${result.expected.join(', ') || '(none — unanswerable)'}`);
    lines.push(`    retrieved   ${result.retrieved.join(', ') || '(nothing)'}`);
    lines.push(
      `    first hit   ${result.firstExpectedRank === null ? 'MISS' : `rank ${result.firstExpectedRank}`}`,
    );
    lines.push(`    cited       ${result.citedSources.join(', ') || '(none)'}`);
    lines.push(`    answer len  ${result.answerLength}`);
    if (result.missingRequiredConcepts.length > 0) {
      lines.push(`    missing     ${result.missingRequiredConcepts.join(', ')}`);
    }
    if (result.presentForbiddenConcepts.length > 0) {
      lines.push(`    FORBIDDEN   ${result.presentForbiddenConcepts.join(', ')}`);
    }
    if (result.failures.length > 0) lines.push(`    FAILURES    ${result.failures.join(', ')}`);
    if (result.unresolvedReason) lines.push(`    why         ${result.unresolvedReason}`);
    lines.push('');
  }

  return lines.join('\n');
}

/** Writes both forms and returns where they went. */
export function writeReport(outcome: RunOutcome, directory: string): ReportPaths {
  const paths: ReportPaths = {
    json: join(directory, 'latest.json'),
    text: join(directory, 'latest.txt'),
  };
  mkdirSync(dirname(paths.json), { recursive: true });
  writeFileSync(paths.json, renderJson(outcome), 'utf8');
  writeFileSync(paths.text, renderText(outcome), 'utf8');
  return paths;
}
