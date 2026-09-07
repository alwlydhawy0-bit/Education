import { createHash } from 'node:crypto';

/**
 * The embedding provider contract, and the deterministic provider that backs it
 * when no vendor is configured.
 *
 * ── WHY THIS IS A SEPARATE CONTRACT FROM `AiProvider` ───────────────────────
 *
 * Not tidiness — a hard fact about the vendor. `AI_PROVIDER=anthropic` selects
 * the completion adapter, and **Anthropic publishes no embeddings endpoint**.
 * Folding `embed()` into `AiProvider` would produce an interface whose
 * configured implementation could not satisfy half of it, and the failure would
 * arrive at the first indexing run rather than at review. Embeddings get their
 * own contract, their own configuration and their own default.
 *
 * ── WHY THE DEFAULT IS DETERMINISTIC AND OFFLINE ────────────────────────────
 *
 * The same reason `createGroundedComposer` is the default answer composer: a
 * foundation whose only mode is "vendor configured" cannot be tested, cannot be
 * demonstrated, and hides every authorization bug behind a missing API key.
 * With this, the whole pipeline — chunking, embedding, storage, the pre-filter,
 * similarity ranking, RLS — runs and is verifiable with no account and no
 * network.
 *
 * ── WHAT THIS PROVIDER IS NOT ───────────────────────────────────────────────
 *
 * IT IS NOT SEMANTIC. It is a hashed bag-of-tokens projected onto the unit
 * sphere. Two passages sharing vocabulary land near each other; two passages
 * meaning the same thing in different words DO NOT. Calling it a semantic index
 * would be a lie told to a schema, and the docs say so plainly.
 *
 * That is an honest foundation rather than a placeholder, because **the
 * security properties of this task do not depend on embedding quality at all**.
 * 0023 put it exactly right and 0026 restates it: authorization constrains WHICH
 * ROWS are searched, similarity only orders them. A better model changes the
 * ranking and touches no boundary. What this provider buys is that every
 * boundary is testable today.
 */

/**
 * Fixed at 768, matching `curriculum_embeddings.embedding vector(768)`.
 *
 * A vector column's dimension is part of its type and its index is built for
 * it, so "make it configurable" means "make every deployment a different
 * schema". Changing this is a migration, and `embedding_model` on every row is
 * what makes such a change a visible re-index rather than a silent mixing of
 * two incomparable spaces.
 */
export const EMBEDDING_DIMENSIONS = 768;

/** The most text one chunk may carry into a provider. Mirrors the SQL CHECK. */
export const MAX_CHUNK_CHARACTERS = 8_000;

export interface EmbeddingProvider {
  /** A stable name, stored on every row it produces. Never a credential. */
  readonly model: string;
  readonly dimensions: number;
  /**
   * Embeds a batch, IN ORDER.
   *
   * A batch rather than one call per chunk because a vendor charges and rate-
   * limits per request, and a lesson is tens of chunks. The contract is
   * positional: `result[i]` embeds `texts[i]`, and an implementation that
   * returned a different length is a bug the caller checks for.
   */
  embed(texts: readonly string[]): Promise<number[][]>;
}

export class EmbeddingProviderError extends Error {
  readonly kind: 'unavailable' | 'malformed' | 'too_large';

  constructor(kind: 'unavailable' | 'malformed' | 'too_large', message: string) {
    super(message);
    this.name = 'EmbeddingProviderError';
    this.kind = kind;
  }
}

/**
 * Splits text into tokens for hashing.
 *
 * Unicode-aware, for the reason `searchTerms` in the assistant repository is:
 * `\w` is ASCII-only and would erase every Arabic word. On an Arabic-first
 * platform that is not a rough edge, it is the product not working.
 */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length > 1);
}

/**
 * Which dimensions a token contributes to, and with what sign.
 *
 * Two buckets per token rather than one: a single bucket makes every token
 * orthogonal, so two passages sharing no exact token are always at distance 1
 * and the ranking degenerates into "did any word match". The signed second
 * bucket spreads each token across the space and lets partial overlaps order
 * themselves.
 */
function bucketsFor(token: string): readonly [number, number, number] {
  const digest = createHash('sha256').update(token, 'utf8').digest();
  const primary = digest.readUInt32BE(0) % EMBEDDING_DIMENSIONS;
  const secondary = digest.readUInt32BE(4) % EMBEDDING_DIMENSIONS;
  const sign = (digest[8] ?? 0) % 2 === 0 ? 1 : -1;
  return [primary, secondary, sign];
}

/**
 * The offline provider.
 *
 * Deterministic across processes and runs — the same text always produces the
 * same vector — which is what makes a retrieval test able to assert an ORDER
 * rather than merely a count.
 */
export function createDeterministicEmbeddingProvider(): EmbeddingProvider {
  return {
    model: 'deterministic-hash-768-v1',
    dimensions: EMBEDDING_DIMENSIONS,

    async embed(texts) {
      return texts.map((text) => {
        if (text.length > MAX_CHUNK_CHARACTERS) {
          throw new EmbeddingProviderError(
            'too_large',
            `A chunk of ${text.length} characters exceeds the ${MAX_CHUNK_CHARACTERS} limit`,
          );
        }

        const vector = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
        const tokens = tokenize(text);
        for (const token of tokens) {
          const [primary, secondary, sign] = bucketsFor(token);
          vector[primary] = (vector[primary] ?? 0) + 1;
          vector[secondary] = (vector[secondary] ?? 0) + sign * 0.5;
        }

        // L2-normalized, because the column is searched with
        // `vector_cosine_ops`. An unnormalized vector would make a LONG chunk
        // look distant from a short one that says the same thing, which is
        // length bias wearing the costume of relevance.
        //
        // A chunk with no tokens at all — punctuation, or a language this
        // tokenizer does not split — would be the zero vector, whose cosine
        // distance to everything is undefined. One fixed non-zero dimension
        // keeps it a legal unit vector that is simply far from everything.
        if (tokens.length === 0) vector[0] = 1;

        const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0)) || 1;
        return vector.map((v) => v / norm);
      });
    },
  };
}

/** The digest stored on every chunk and re-checked at retrieval time. */
export function sourceHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** pgvector's text input format. Built here so no caller hand-rolls it. */
export function toVectorLiteral(values: readonly number[]): string {
  if (values.length !== EMBEDDING_DIMENSIONS) {
    throw new EmbeddingProviderError(
      'malformed',
      `Expected ${EMBEDDING_DIMENSIONS} dimensions, received ${values.length}`,
    );
  }
  for (const value of values) {
    if (!Number.isFinite(value)) {
      throw new EmbeddingProviderError('malformed', 'A vector component was not a finite number');
    }
  }
  return `[${values.join(',')}]`;
}
