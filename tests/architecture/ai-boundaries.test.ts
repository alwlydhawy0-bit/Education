import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * Structural rules for the AI layer.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THESE ARE STRUCTURAL AND NOT BEHAVIOURAL
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Found by defect injection, and worth stating plainly because it is the kind
 * of gap that is invisible until something is deliberately broken.
 *
 * Task 013's defect F4 added a query to the assistant's repository that JOINed
 * `assessment_answer_keys` and pushed the correct option's text into the
 * retrieved set. Every behavioural test still passed — because row-level
 * security on that table admits no learner, so the JOIN returned nothing.
 *
 * The defence held. But the guarantee the code CLAIMS is stronger than "RLS
 * would stop it": the repository documents that it never names those tables at
 * all, which is why the assistant cannot disclose an answer key for the same
 * reason it cannot disclose a payroll record. A behavioural test cannot
 * distinguish "never read" from "read and filtered", and the difference matters
 * the day somebody adds a definer function, a superuser path, or a teacher-
 * facing assistant.
 *
 * So the claim is asserted where it lives: in the source.
 */
const ROOT = resolve(import.meta.dirname, '../..');

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current)) {
      if (entry === 'node_modules' || entry === 'dist') continue;
      const full = join(current, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith('.ts') || entry.endsWith('.tsx')) out.push(full);
    }
  };
  walk(join(ROOT, dir));
  return out;
}

const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');

function dependencyNames(manifest: string): string[] {
  const parsed = JSON.parse(read(manifest)) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  return [...Object.keys(parsed.dependencies ?? {}), ...Object.keys(parsed.devDependencies ?? {})];
}

describe('rule 1 — the assistant never reads assessment internals', () => {
  /**
   * Tables holding, or leading directly to, the answers.
   *
   * `assessment_questions` is on the list as well as the keys, because a
   * question's prompt plus its options narrows the answer even without the key
   * row — and because a query that reaches the questions is one JOIN away from
   * reaching the keys.
   */
  const FORBIDDEN_TABLES = [
    'assessment_answer_keys',
    'assessment_questions',
    'assessment_options',
    'assessment_attempt_answers',
    'assessments',
  ];

  const assistantSource = sourceFiles('apps/api/src/modules/assistant')
    .map((file) => readFileSync(file, 'utf8'))
    .join('\n');

  it.each(FORBIDDEN_TABLES)('the assistant module never names %s', (table) => {
    // A word-boundary match, so `assessments` does not accidentally match a
    // comment about "assessment material" and give a false sense of coverage.
    expect(assistantSource).not.toMatch(new RegExp(`\\b${table}\\b`));
  });

  it('and DOES name the curriculum tables it is supposed to read', () => {
    // The mirror assertion. Without it the rule above would pass if somebody
    // deleted retrieval entirely, which is a green test for a broken feature.
    expect(assistantSource).toMatch(/\blessons\b/);
    expect(assistantSource).toMatch(/\blearning_objectives\b/);
  });
});

describe('rule 2 — the vendor SDK is confined to platform/ai', () => {
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * THIS RULE CHANGED IN TASK 014, AND THE CHANGE IS THE POINT
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * Task 013 had no vendor at all, so the rule was "nothing, anywhere". Task 014
   * connects one, and a rule that forbade the SDK outright would either have to
   * be deleted — trading a real boundary for none — or worked around, which is
   * worse.
   *
   * So it is NARROWED rather than dropped: the SDK may appear in exactly one
   * directory, and nowhere else. That is what "the application depends on the
   * interface, not the vendor" means operationally, and it is the difference
   * between an abstraction and a suggestion. A second import path would bypass
   * the request shaping, the deadline, the output validation, the citation
   * intersection and the error normalization all at once — and nothing in the
   * security suite would cover it, because the security suite tests the path
   * that goes through the adapter.
   *
   * Every other vendor stays banned everywhere, including inside `platform/ai`:
   * the task is ONE provider, and a second SDK appearing beside the first is
   * exactly the drift this asserts against.
   */
  const CHOSEN_VENDOR = '@anthropic-ai/';

  /** The one directory allowed to know a vendor exists. */
  const AI_BOUNDARY = 'apps/api/src/platform/ai';

  const OTHER_VENDOR_PACKAGES = [
    'openai',
    '@google/generative-ai',
    '@google-cloud/aiplatform',
    'cohere-ai',
    'mistralai',
    'langchain',
    'llamaindex',
  ];

  const apiSource = sourceFiles('apps/api/src');
  const webSource = sourceFiles('apps/web/src');

  const importsIn = (file: string): string[] =>
    [...readFileSync(file, 'utf8').matchAll(/from\s+'([^']+)'/g)].map((match) => match[1] ?? '');

  it.each(OTHER_VENDOR_PACKAGES)('nothing imports %s, anywhere', (pkg) => {
    for (const file of [...apiSource, ...webSource]) {
      expect({ file, imports: importsIn(file).filter((i) => i.startsWith(pkg)) }).toEqual({
        file,
        imports: [],
      });
    }
  });

  it('the chosen vendor SDK appears ONLY under platform/ai', () => {
    for (const file of apiSource) {
      const vendorImports = importsIn(file).filter((i) => i.startsWith(CHOSEN_VENDOR));
      if (vendorImports.length === 0) continue;
      // A relative path so the failure message names the offending file rather
      // than a machine-specific absolute path.
      const relative = file.slice(ROOT.length + 1);
      expect({ file: relative, insideBoundary: relative.startsWith(AI_BOUNDARY) }).toEqual({
        file: relative,
        insideBoundary: true,
      });
    }
  });

  it('and the web app never names it at all', () => {
    // Stricter than the import rule, and deliberately so: a browser bundle has
    // no legitimate reason to contain the string, and a mention is the step
    // before an import.
    for (const file of webSource) {
      expect({ file, mentions: readFileSync(file, 'utf8').includes(CHOSEN_VENDOR) }).toEqual({
        file,
        mentions: false,
      });
    }
  });

  it('the adapter is the only file inside the boundary that imports it', () => {
    // Even within `platform/ai`, one file owns the vendor. `provider.ts` is the
    // interface every other module codes against and must stay vendor-free, or
    // the abstraction is a directory rather than a boundary.
    const owners = sourceFiles(AI_BOUNDARY)
      .filter((file) => importsIn(file).some((i) => i.startsWith(CHOSEN_VENDOR)))
      .map((file) => file.slice(ROOT.length + 1));
    expect(owners).toEqual([`${AI_BOUNDARY}/anthropic.adapter.ts`]);
  });

  it('only the API manifest may declare a vendor dependency', () => {
    // Catches the step before the import: a package added "to try it out". The
    // web manifest and the workspace root stay clean, so a vendor SDK cannot
    // reach a browser bundle by way of a hoisted dependency.
    for (const manifest of ['package.json', 'apps/web/package.json']) {
      const names = dependencyNames(manifest);
      for (const pkg of [CHOSEN_VENDOR, ...OTHER_VENDOR_PACKAGES]) {
        expect({ manifest, matched: names.filter((n) => n.startsWith(pkg)) }).toEqual({
          manifest,
          matched: [],
        });
      }
    }

    const apiNames = dependencyNames('apps/api/package.json');
    for (const pkg of OTHER_VENDOR_PACKAGES) {
      expect({ pkg, matched: apiNames.filter((n) => n.startsWith(pkg)) }).toEqual({
        pkg,
        matched: [],
      });
    }
    // And the mirror assertion: the one vendor IS declared. Without this the
    // rules above would all pass with the integration deleted.
    expect(apiNames.filter((n) => n.startsWith(CHOSEN_VENDOR))).toEqual(['@anthropic-ai/sdk']);
  });
});

describe('rule 2b — the model can reach nothing', () => {
  const adapter = read('apps/api/src/platform/ai/anthropic.adapter.ts');

  it('declares no tools, so there is no capability to talk it into using', () => {
    // Task 014 is read-only. The strongest form of that is not a rule telling
    // the model to behave — it is the absence of anything to call. A `tools`
    // array appearing here would mean the model could publish a lesson, record
    // progress, or reach the network, and a prompt would be the only thing
    // standing in the way.
    expect(adapter).not.toMatch(/^\s*tools:/m);
    expect(adapter).not.toMatch(/\btool_choice\b/);
  });

  it('does not stream, so nothing reaches a learner before it is validated', () => {
    // A streamed answer is rendered before citation validation and the size
    // checks have run, and a rendered answer cannot be withdrawn.
    expect(adapter).toMatch(/stream:\s*false/);
    expect(adapter).not.toMatch(/messages\.stream\(/);
  });

  it('disables SDK retries, so one quota unit is one provider call', () => {
    // The per-actor quota counts requests. If the SDK silently retried, one
    // counted request could become three billed calls — a quota that lies
    // about money.
    expect(adapter).toMatch(/maxRetries:\s*0/);
  });
});

describe('rule 3 — no AI credential can reach the browser', () => {
  it('the web app never reads an AI key, under any name', () => {
    const webSource = sourceFiles('apps/web/src')
      .map((file) => readFileSync(file, 'utf8'))
      .join('\n');

    // `VITE_` is the only prefix Vite inlines into the bundle. An AI key behind
    // one would be shipped to every browser that loads the page, which is the
    // single worst outcome available in this task.
    expect(webSource).not.toMatch(/VITE_[A-Z_]*(AI|ANTHROPIC|OPENAI|LLM|MODEL)[A-Z_]*/);
    expect(webSource).not.toMatch(/\bAI_API_KEY\b/);
  });

  it('the key is declared secret-bearing, so the logger redacts it', () => {
    const config = read('apps/api/src/platform/config.ts');
    // Not merely "the key exists" — it must be in the list the redacting logger
    // and the configuration summary consult, alongside DATABASE_URL.
    expect(config).toMatch(/SECRET_BEARING_KEYS\s*=\s*\[[^\]]*'AI_API_KEY'/);
  });

  it('the example environment file does not ship a real-looking key', () => {
    const example = read('.env.example');
    expect(example).not.toMatch(/sk-[A-Za-z0-9_-]{20,}/);
  });
});

describe('rule 4 — the model cannot be handed an instruction by a caller', () => {
  it('the system instructions are a module constant, not a template', () => {
    const service = read('apps/api/src/modules/assistant/assistant.service.ts');
    expect(service).toMatch(/const SYSTEM_INSTRUCTIONS =/);
    // A template literal with a substitution would be a place a caller could
    // eventually reach. The constant is built from a fixed array of strings.
    expect(service).not.toMatch(/SYSTEM_INSTRUCTIONS\s*=\s*`[^`]*\$\{/);
  });

  it('the request contract has no field for instructions, sources or a model', () => {
    const contract = read('packages/contracts/src/assistant.contract.ts');
    const request = contract.slice(
      contract.indexOf('askAssistantRequestSchema'),
      contract.indexOf('assistantSourceRefSchema'),
    );
    for (const field of ['instructions', 'systemPrompt', 'sources', 'model', 'temperature']) {
      expect({ field, present: request.includes(`${field}:`) }).toEqual({ field, present: false });
    }
  });
});
