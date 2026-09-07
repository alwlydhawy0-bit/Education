import { describe, expect, it } from 'vitest';
import {
  CHUNK_BUDGET_CHARACTERS,
  MIN_CHUNK_CHARACTERS,
  chunkLesson,
  type LessonSource,
} from '../../apps/api/src/modules/knowledge/chunking.ts';
import {
  EMBEDDING_DIMENSIONS,
  EmbeddingProviderError,
  MAX_CHUNK_CHARACTERS,
  createDeterministicEmbeddingProvider,
  toVectorLiteral,
} from '../../apps/api/src/platform/ai/embeddings.ts';
import { RAG_MAX_QUERY_CHARACTERS, RAG_MAX_TOP_K, ragRetrieveRequestSchema } from '@edu/contracts';

/**
 * The chunking engine, the embedding provider, and the parts of the retrieval
 * contract that are security controls rather than shape checks.
 *
 * WHAT IS NOT TESTED HERE: whether a chunk is RETRIEVABLE. That is decided by
 * Row Level Security and the pre-filter, and it is asserted in
 * `tests/integration/rls-embeddings.test.ts` and `tests/security/rag.test.ts`.
 * Keeping the split visible matters, because the most tempting mistake in a RAG
 * layer is to believe the ranking is doing security work.
 */

const ANCESTRY = {
  organizationId: 'org-1',
  courseId: 'course-1',
  unitId: 'unit-1',
  lessonId: 'lesson-1',
};

const lesson = (overrides: Partial<LessonSource> = {}): LessonSource => ({
  ...ANCESTRY,
  title: 'Cells',
  summary: 'An introduction to cells.',
  contentBody: 'Mitochondria produce energy.',
  objectives: [],
  updatedAt: '2026-01-01 00:00:00+00',
  ...overrides,
});

const paragraphs = (count: number, filler = 'Lorem ipsum dolor sit amet consectetur. ') =>
  Array.from({ length: count }, (_unused, i) => `Paragraph ${i}. ${filler.repeat(3)}`).join(String.fromCharCode(10, 10));

describe('every chunk carries its ancestry', () => {
  it('stamps organization, course, unit and lesson on all of them', () => {
    // 20 paragraphs of ~135 characters comfortably exceeds the 1,200-character
    // budget, so this exercises ancestry across MULTIPLE chunks rather than one.
    const chunks = chunkLesson(lesson({ contentBody: paragraphs(20) }));
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.organizationId).toBe('org-1');
      expect(chunk.courseId).toBe('course-1');
      expect(chunk.unitId).toBe('unit-1');
      expect(chunk.lessonId).toBe('lesson-1');
    }
  });

  it('numbers them from zero without gaps', () => {
    // The unique constraint is on (lesson, model, index). A gap or a repeat
    // would either lose a chunk or fail the insert for the whole course.
    const chunks = chunkLesson(
      lesson({ contentBody: paragraphs(8), objectives: [{ id: 'o1', statement: 'Describe.' }] }),
    );
    expect(chunks.map((c) => c.chunkIndex)).toEqual(chunks.map((_unused, i) => i));
  });

  it('carries a null organization through rather than inventing one', () => {
    const chunks = chunkLesson(lesson({ organizationId: null }));
    expect(chunks[0]?.organizationId).toBeNull();
  });
});

describe('objectives are chunked as objectives', () => {
  it('emits them first, separately, and never packed with prose', () => {
    const chunks = chunkLesson(
      lesson({
        objectives: [
          { id: 'o1', statement: 'Describe the cell.' },
          { id: 'o2', statement: 'Explain respiration.' },
        ],
      }),
    );
    expect(chunks[0]?.kind).toBe('objective');
    expect(chunks[0]?.objectiveId).toBe('o1');
    expect(chunks[1]?.objectiveId).toBe('o2');
    expect(chunks[2]?.kind).toBe('lesson');
    // Neither objective text leaked into the prose chunk.
    expect(chunks[2]?.content).not.toContain('Describe the cell');
  });

  it('skips an empty objective rather than emitting a blank chunk', () => {
    // A zero-length chunk violates the SQL CHECK, so this is a correctness
    // rule and not a tidiness one.
    const chunks = chunkLesson(lesson({ objectives: [{ id: 'o1', statement: '   ' }] }));
    expect(chunks.every((c) => c.content.trim().length > 0)).toBe(true);
    expect(chunks.some((c) => c.kind === 'objective')).toBe(false);
  });
});

describe('token boundary handling', () => {
  it('never exceeds the budget, however the text is shaped', () => {
    const shapes = [
      paragraphs(40),
      'word '.repeat(2_000),
      'x'.repeat(5_000),
      `${'a'.repeat(3_000)} ${'b'.repeat(3_000)}`,
      paragraphs(3, 'Sentence one. Sentence two. Sentence three. '),
    ];
    for (const contentBody of shapes) {
      const chunks = chunkLesson(lesson({ contentBody }));
      for (const chunk of chunks) {
        expect(chunk.content.length, contentBody.slice(0, 30)).toBeLessThanOrEqual(
          CHUNK_BUDGET_CHARACTERS,
        );
      }
    }
  });

  it('stays under the provider and SQL ceiling with room to spare', () => {
    // The budget is deliberately far below the hard limit, so no packing
    // decision can produce a chunk the provider or the CHECK would reject.
    expect(CHUNK_BUDGET_CHARACTERS).toBeLessThan(MAX_CHUNK_CHARACTERS);
  });

  it('splits a long paragraph at a SENTENCE boundary when one exists', () => {
    const sentence = `${'A'.repeat(200)}. `;
    const chunks = chunkLesson(lesson({ title: '', summary: '', contentBody: sentence.repeat(12) }));
    expect(chunks.length).toBeGreaterThan(1);
    // No chunk begins mid-sentence: each starts with the capital that follows
    // a full stop, never with a stray space or a lowercase continuation.
    for (const chunk of chunks) expect(chunk.content.startsWith('A')).toBe(true);
  });

  it('splits at the ARABIC full stop, which an English-only regex misses', () => {
    const stop = String.fromCharCode(0x06d4);
    const sentence = `${String.fromCharCode(0x0647).repeat(150)}${stop} `;
    const chunks = chunkLesson(
      lesson({ title: '', summary: '', contentBody: sentence.repeat(15) }),
    );
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.content.length).toBeLessThanOrEqual(CHUNK_BUDGET_CHARACTERS);
      // Every chunk ends on a sentence boundary rather than mid-word.
      expect(chunk.content.endsWith(stop)).toBe(true);
    }
  });

  it('falls back to a word boundary when there is no sentence boundary', () => {
    const chunks = chunkLesson(
      lesson({ title: '', summary: '', contentBody: 'alpha beta gamma '.repeat(200) }),
    );
    for (const chunk of chunks) {
      expect(chunk.content.length).toBeLessThanOrEqual(CHUNK_BUDGET_CHARACTERS);
      expect(chunk.content.trim()).toBe(chunk.content);
    }
  });

  it('is TOTAL on a pathological single token', () => {
    // One 5,000-character "word" has no sentence and no word boundary. The hard
    // cut exists so indexing produces legal chunks rather than throwing.
    const chunks = chunkLesson(lesson({ title: '', summary: '', contentBody: 'x'.repeat(5_000) }));
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.content.length).toBeLessThanOrEqual(CHUNK_BUDGET_CHARACTERS);
      expect(chunk.content.length).toBeGreaterThan(0);
    }
    expect(chunks.map((c) => c.content).join('')).toBe('x'.repeat(5_000));
  });

  it('packs short paragraphs instead of emitting one chunk each', () => {
    const chunks = chunkLesson(
      lesson({ title: '', summary: '', contentBody: Array.from({ length: 20 }, (_u, i) => `Line ${i}.`).join(String.fromCharCode(10, 10)) }),
    );
    expect(chunks).toHaveLength(1);
  });

  it('folds a short trailing fragment into the chunk before it', () => {
    const chunks = chunkLesson(
      lesson({ title: '', summary: '', contentBody: `${'A'.repeat(1_150)}${String.fromCharCode(10, 10)}tail` }),
    );
    expect(chunks.every((c) => c.content.length >= MIN_CHUNK_CHARACTERS || chunks.length === 1)).toBe(
      true,
    );
  });
});

describe('a lesson always produces something citable', () => {
  it('indexes a title-only lesson', () => {
    const chunks = chunkLesson(lesson({ summary: '', contentBody: '' }));
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.content).toBe('Cells');
  });

  it('produces nothing at all for a wholly empty lesson', () => {
    // Not a failure: an empty lesson has nothing to retrieve, and a blank chunk
    // would violate the SQL CHECK.
    expect(chunkLesson(lesson({ title: '', summary: '', contentBody: '' }))).toEqual([]);
  });

  it('leads the first prose chunk with the title and summary', () => {
    const chunks = chunkLesson(lesson());
    expect(chunks[0]?.content.startsWith('Cells')).toBe(true);
    expect(chunks[0]?.content).toContain('An introduction to cells.');
  });
});

describe('the deterministic embedding provider', () => {
  const provider = createDeterministicEmbeddingProvider();
  const dot = (a: readonly number[], b: readonly number[]) =>
    a.reduce((sum, v, i) => sum + v * (b[i] ?? 0), 0);

  it('returns one unit vector of the right dimension per input, in order', async () => {
    const vectors = await provider.embed(['alpha', 'beta', 'gamma']);
    expect(vectors).toHaveLength(3);
    for (const vector of vectors) {
      expect(vector).toHaveLength(EMBEDDING_DIMENSIONS);
      expect(dot(vector, vector)).toBeCloseTo(1, 6);
    }
  });

  it('is deterministic across calls', async () => {
    const [first] = await provider.embed(['mitochondria']);
    const [second] = await provider.embed(['mitochondria']);
    expect(first).toEqual(second);
  });

  it('places passages sharing vocabulary nearer than unrelated ones', async () => {
    const [a, b, c] = await provider.embed([
      'mitochondria produce energy in the cell',
      'the cell produces energy in mitochondria',
      'photosynthesis converts sunlight in chloroplasts',
    ]);
    expect(dot(a ?? [], b ?? [])).toBeGreaterThan(dot(a ?? [], c ?? []));
  });

  it('IS NOT SEMANTIC, and this test says so out loud', async () => {
    // Two passages meaning the same thing in different words are NOT close.
    // Documented as a known limitation rather than left for somebody to
    // discover from poor retrieval quality.
    const [a, b] = await provider.embed(['a car', 'an automobile']);
    expect(dot(a ?? [], b ?? [])).toBeLessThan(0.1);
  });

  it('handles text with no tokens as a legal unit vector', async () => {
    // A zero vector has undefined cosine distance to everything, which would
    // make pgvector's ordering meaningless rather than merely unhelpful.
    const [vector] = await provider.embed(['... --- ...']);
    expect(dot(vector ?? [], vector ?? [])).toBeCloseTo(1, 6);
  });

  it('embeds Arabic rather than erasing it', async () => {
    const arabic = String.fromCharCode(0x0627, 0x0644, 0x062e, 0x0644, 0x064a, 0x0629);
    const [a, b] = await provider.embed([arabic, 'unrelated english words entirely']);
    expect(dot(a ?? [], a ?? [])).toBeCloseTo(1, 6);
    expect(dot(a ?? [], b ?? [])).toBeLessThan(0.1);
  });

  it('refuses a chunk over the provider ceiling', async () => {
    await expect(provider.embed(['x'.repeat(MAX_CHUNK_CHARACTERS + 1)])).rejects.toThrow(
      EmbeddingProviderError,
    );
  });
});

describe('the vector literal builder', () => {
  it('refuses a wrong-dimension vector before it reaches SQL', () => {
    expect(() => toVectorLiteral([1, 2, 3])).toThrow(/768 dimensions/);
  });

  it('refuses a non-finite component', () => {
    const bad = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
    bad[0] = Number.NaN;
    expect(() => toVectorLiteral(bad)).toThrow(/finite/);
  });

  it('emits pgvector text format', () => {
    const ok = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
    expect(toVectorLiteral(ok).startsWith('[0,0,0')).toBe(true);
    expect(toVectorLiteral(ok).endsWith(']')).toBe(true);
  });
});

describe('the retrieval contract bounds what one question may ask', () => {
  it('accepts a well-formed request', () => {
    expect(ragRetrieveRequestSchema.safeParse({ query: 'what is a cell' }).success).toBe(true);
  });

  it('caps topK and the query length', () => {
    expect(
      ragRetrieveRequestSchema.safeParse({ query: 'x', topK: RAG_MAX_TOP_K + 1 }).success,
    ).toBe(false);
    expect(
      ragRetrieveRequestSchema.safeParse({ query: 'x'.repeat(RAG_MAX_QUERY_CHARACTERS + 1) })
        .success,
    ).toBe(false);
  });

  it('refuses an empty query', () => {
    expect(ragRetrieveRequestSchema.safeParse({ query: '   ' }).success).toBe(false);
  });

  it('HAS NO FIELD FOR A RAW VECTOR, an organization or a model', () => {
    // The structural half of the pre-filter. A caller supplying a vector would
    // be choosing its own neighbourhood in the index; one supplying an
    // organization would be choosing a tenant. Neither field exists, so
    // `.strict()` turns the attempt into a 400 rather than a value to validate.
    for (const forged of [
      { embedding: [0.1, 0.2] },
      { queryVector: [0.1] },
      { organizationId: 'other-school' },
      { model: 'some-other-model' },
      { tenantId: 'x' },
    ]) {
      expect(
        ragRetrieveRequestSchema.safeParse({ query: 'x', ...forged }).success,
        JSON.stringify(forged),
      ).toBe(false);
    }
  });
});
