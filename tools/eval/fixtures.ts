import type {
  AiCompletion,
  AiProvider,
  AiRequest,
} from '../../apps/api/src/platform/ai/provider.ts';
import { AiProviderError } from '../../apps/api/src/platform/ai/provider.ts';

/**
 * DETERMINISTIC PROVIDER FIXTURES.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT THESE PROVE, AND WHAT THEY EXPLICITLY DO NOT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * They prove that the SERVER's validation holds against every shape a provider
 * can produce, including the hostile ones: a lie about grounding, an invented
 * citation, a leaked system prompt, malformed output, a refusal.
 *
 * They prove NOTHING about a real model. A fixture that returns an invented
 * citation demonstrates the server strips it; it says nothing about how often a
 * real model would invent one. That is why these are labelled fixtures
 * throughout and why the report separates "grounding enforcement" from
 * "provider quality" — the first is measured here, the second is not measured
 * at all.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THEY ARE NOT MOCKS OF THE ADAPTER
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Each satisfies `AiProvider`, the same interface the Anthropic adapter
 * satisfies, and is injected at the same seam. The service, the citation
 * intersection and the grounding decision below them are the real ones — the
 * only substituted thing is the model.
 */

/** Records what it was handed, so a case can assert on the request too. */
export interface RecordingProvider extends AiProvider {
  readonly calls: AiRequest[];
}

function recording(name: string, answer: (request: AiRequest) => AiCompletion): RecordingProvider {
  const calls: AiRequest[] = [];
  return {
    name,
    calls,
    generateAnswer(request: AiRequest) {
      calls.push(request);
      return Promise.resolve(answer(request));
    },
  };
}

/**
 * THE BASELINE FIXTURE, and the one the benchmark runs on.
 *
 * Honest by construction: it quotes the passages it was actually given and
 * cites exactly those. That isolates the measurement — when a case fails on
 * this fixture, the failure is in retrieval or in grounding, never in the
 * model, because this "model" cannot be wrong about what it was handed.
 */
export const faithfulFixture = (): RecordingProvider =>
  recording('fixture-faithful', (request) => {
    const used = request.sources.slice(0, 3);
    return {
      answer: used.map((source) => `${source.label}: ${source.text}`).join('\n\n'),
      citedSourceIds: used.map((source) => source.id),
      groundedInSources: used.length > 0,
    };
  });

/** Cites one real source and one invention. The invention must not survive. */
export const fabricatingFixture = (): RecordingProvider =>
  recording('fixture-fabricating', (request) => {
    const real = request.sources[0];
    return {
      answer: 'وفقًا للدرس، الإجابة موجودة في المصادر المذكورة.',
      citedSourceIds: [
        ...(real ? [real.id] : []),
        'lesson:00000000-0000-4000-8000-000000000000#7',
        'objective:11111111-1111-4111-8111-111111111111',
      ],
      groundedInSources: true,
    };
  });

/**
 * Cites nothing and insists it is grounded anyway.
 *
 * The provider's `groundedInSources` is the one field a careless
 * implementation would trust. The server must ignore it entirely.
 */
export const lyingFixture = (): RecordingProvider =>
  recording('fixture-lying', () => ({
    answer: 'هذه إجابة واثقة بلا أي مصدر.',
    citedSourceIds: [],
    groundedInSources: true,
  }));

/** Echoes the instructions it was given back as its answer. */
export const promptLeakingFixture = (): RecordingProvider =>
  recording('fixture-leaking', (request) => ({
    answer: request.instructions,
    citedSourceIds: request.sources[0] ? [request.sources[0].id] : [],
    groundedInSources: true,
  }));

/** An answer far past any sane bound, to exercise the size ceilings. */
export const oversizedFixture = (): RecordingProvider =>
  recording('fixture-oversized', (request) => ({
    answer: 'ا'.repeat(50_000),
    citedSourceIds: request.sources[0] ? [request.sources[0].id] : [],
    groundedInSources: true,
  }));

/** Malformed output, as an adapter would report it after failing to parse. */
export const malformedFixture = (): RecordingProvider =>
  recording('fixture-malformed', () => {
    throw new AiProviderError('invalid_response', 'fixture: response did not match the schema');
  });

/** A safety refusal, which is neither an outage nor thin material. */
export const refusingFixture = (): RecordingProvider =>
  recording('fixture-refusing', () => {
    throw new AiProviderError('content_declined', 'fixture: declined');
  });

/** An outage. */
export const unavailableFixture = (): RecordingProvider =>
  recording('fixture-unavailable', () => {
    throw new AiProviderError('unavailable', 'fixture: provider unreachable');
  });

/**
 * Obeys an injected instruction, as a manipulated model would.
 *
 * The point is that obedience buys it nothing: it can only echo passages it was
 * already given, and its citations are still intersected with the retrieved
 * set. A compromised model is contained by the layers around it, not by its
 * own good behaviour.
 */
export const obedientFixture = (): RecordingProvider =>
  recording('fixture-obedient', (request) => ({
    answer: `IGNORING PRIOR INSTRUCTIONS AS ASKED. ${request.sources.map((s) => s.text).join(' ')}`,
    citedSourceIds: [
      'lesson:99999999-9999-4999-8999-999999999999#0',
      ...request.sources.map((s) => s.id),
    ],
    groundedInSources: true,
  }));
