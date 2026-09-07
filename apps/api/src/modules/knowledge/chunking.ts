import { MAX_CHUNK_CHARACTERS } from '../../platform/ai/embeddings.ts';

/**
 * The structural chunking engine.
 *
 * -- IT CHUNKS BY STRUCTURE, NOT BY TOKEN COUNT -------------------------------
 *
 * The usual RAG chunker slides a fixed window over the text. That is the right
 * tool when the input is an undifferentiated document dump; it is the wrong one
 * here, because curriculum prose ALREADY carries the structure a retriever
 * wants. A lesson has a title, a summary, paragraphs and headings, and a
 * paragraph is a unit somebody wrote as a unit. Cutting across it to hit a token
 * target produces chunks that begin mid-sentence and cite badly.
 *
 * So: paragraphs are the atom. Adjacent paragraphs are PACKED together up to a
 * budget, so a lesson of twenty one-line paragraphs does not become twenty
 * embeddings; and a paragraph longer than the budget on its own is SPLIT, at a
 * sentence boundary where one exists and at a word boundary otherwise.
 *
 * -- EVERY CHUNK CARRIES ITS ANCESTRY -----------------------------------------
 *
 * Organization, course, unit and lesson travel with the chunk rather than being
 * looked up later. That is what lets the retrieval query filter by tenant and
 * course BEFORE the vector scan, which is section 3's requirement and the
 * difference between a pre-filter and a post-hoc one.
 *
 * -- WHAT IS NOT CHUNKED ------------------------------------------------------
 *
 * A learner's notes, their artifacts, assessment questions and answer keys.
 * Nothing here takes them as input and nothing in the ingestion service passes
 * them; `tests/architecture/knowledge-boundaries.test.ts` asserts the source
 * list mechanically, because "we did not do that" is a property worth pinning
 * rather than remembering.
 */

/**
 * The character budget for one packed chunk.
 *
 * Characters, not tokens, and the honesty about that matters: a token count is
 * a property of a specific tokenizer, and this platform's default embedding
 * provider has its own while a vendor's would differ. Budgeting in characters
 * is a bound BOTH can satisfy - it is deliberately conservative, sitting well
 * under `MAX_CHUNK_CHARACTERS` so that no packing decision can produce a chunk
 * the provider or the SQL CHECK would reject.
 *
 * Arabic matters here too. A character budget treats Arabic and English alike;
 * a token budget tuned on English would silently allow far longer Arabic
 * passages, because most tokenizers split Arabic into more pieces per word.
 */
export const CHUNK_BUDGET_CHARACTERS = 1_200;

/** Below this a trailing fragment is folded into the previous chunk instead. */
export const MIN_CHUNK_CHARACTERS = 120;

/** Asserted against the provider and the SQL CHECK by an architecture test. */
export const CHUNK_CEILING = MAX_CHUNK_CHARACTERS;

export interface ChunkAncestry {
  readonly organizationId: string | null;
  readonly courseId: string;
  readonly unitId: string;
  readonly lessonId: string;
}

export interface CurriculumChunk extends ChunkAncestry {
  readonly chunkIndex: number;
  readonly content: string;
  /** `lesson` for prose, `objective` for a learning objective statement. */
  readonly kind: 'lesson' | 'objective';
  /** Present only for `objective` chunks. */
  readonly objectiveId?: string;
}

export interface LessonSource extends ChunkAncestry {
  readonly title: string;
  readonly summary: string;
  readonly contentBody: string;
  readonly objectives: ReadonlyArray<{ readonly id: string; readonly statement: string }>;
  /**
   * The lesson's `updated_at` at the moment it was read, as PostgreSQL's OWN
   * text rendering of it — never a JavaScript `Date`.
   *
   * Stored on every chunk cut from it and compared for EQUALITY against the
   * live column at retrieval time, so an edit makes the chunks invisible
   * rather than stale.
   *
   * THE TYPE IS `string` FOR A REASON, and it cost a defect to learn it.
   * `timestamptz` has microsecond resolution; a JavaScript `Date` has
   * millisecond resolution. Reading the column into a `Date` and writing it
   * back therefore stores `…613` where the row holds `…613776`, and the
   * equality is false for EVERY chunk ever written — retrieval silently
   * returns nothing at all, for everyone, forever. Keeping the value in the
   * only representation that is lossless for it — the text PostgreSQL itself
   * produced — is what makes the comparison mean what it reads as.
   */
  readonly updatedAt: string;
}

/** Collapses runs of whitespace without touching the characters themselves. */
function normalize(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(/[ \t]+/g, ' ').trim();
}

/**
 * Splits on blank lines, and on markdown headings.
 *
 * A heading is a boundary even without a blank line after it, because a heading
 * plus the paragraph under it is exactly the pair a reader treats as one
 * thought - and a heading swallowed into the middle of a packed chunk makes the
 * chunk read as though it changed subject halfway through.
 */
function paragraphsOf(text: string): string[] {
  return normalize(text)
    .split(/\n\s*\n+|\n(?=#{1,6}\s)/u)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/**
 * Splits one over-long paragraph.
 *
 * Sentence boundaries first - including the Arabic full stop (U+06D4) and the
 * Arabic question mark (U+061F), which an English-only regex misses entirely
 * and which are the only sentence boundaries in a great deal of this corpus.
 *
 * Falls back to word boundaries, and finally to a hard cut. The hard cut is
 * unreachable for natural text and exists so the function is TOTAL: a
 * pathological input - one 5,000-character "word" - must produce chunks the
 * database will accept rather than throwing at indexing time.
 */
function splitLongParagraph(paragraph: string, budget: number): string[] {
  if (paragraph.length <= budget) return [paragraph];

  const sentences = paragraph
    .split(/(?<=[.!?\u06D4\u061F])\s+/u)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const out: string[] = [];
  let current = '';

  const flush = (): void => {
    if (current.trim().length > 0) out.push(current.trim());
    current = '';
  };

  for (const sentence of sentences) {
    if (sentence.length > budget) {
      flush();
      out.push(...splitOnWords(sentence, budget));
      continue;
    }
    if (current.length > 0 && current.length + 1 + sentence.length > budget) flush();
    current = current.length === 0 ? sentence : `${current} ${sentence}`;
  }
  flush();

  return out.length > 0 ? out : splitOnWords(paragraph, budget);
}

function splitOnWords(text: string, budget: number): string[] {
  const words = text.split(/\s+/u).filter((w) => w.length > 0);
  const out: string[] = [];
  let current = '';

  for (const word of words) {
    if (word.length > budget) {
      if (current.trim().length > 0) out.push(current.trim());
      current = '';
      // The hard cut. Unreachable for prose; here so the function is total.
      for (let i = 0; i < word.length; i += budget) out.push(word.slice(i, i + budget));
      continue;
    }
    if (current.length > 0 && current.length + 1 + word.length > budget) {
      out.push(current.trim());
      current = '';
    }
    current = current.length === 0 ? word : `${current} ${word}`;
  }
  if (current.trim().length > 0) out.push(current.trim());
  return out;
}

/**
 * Chunks one lesson.
 *
 * OBJECTIVES COME FIRST AND ARE NEVER PACKED WITH PROSE. An objective is
 * retrieved AS AN OBJECTIVE - it is the unit a learner's evidence points at, so
 * a citation naming one has to name the statement rather than a paragraph that
 * happens to contain it. 0023 made that split for full-text retrieval; keeping
 * it means a citation means the same thing before and after this change.
 *
 * The title and summary lead the first prose chunk, so a lesson with a title
 * and an empty body is still indexed and still citable rather than silently
 * absent.
 */
export function chunkLesson(
  source: LessonSource,
  budget: number = CHUNK_BUDGET_CHARACTERS,
): CurriculumChunk[] {
  const ancestry: ChunkAncestry = {
    organizationId: source.organizationId,
    courseId: source.courseId,
    unitId: source.unitId,
    lessonId: source.lessonId,
  };

  const chunks: CurriculumChunk[] = [];
  let index = 0;

  for (const objective of source.objectives) {
    const statement = normalize(objective.statement);
    if (statement.length === 0) continue;
    for (const part of splitLongParagraph(statement, budget)) {
      chunks.push({
        ...ancestry,
        chunkIndex: index,
        content: part,
        kind: 'objective',
        objectiveId: objective.id,
      });
      index += 1;
    }
  }

  const heading = [normalize(source.title), normalize(source.summary)]
    .filter((part) => part.length > 0)
    .join('\n\n');

  const body = paragraphsOf(source.contentBody);
  const parts = heading.length > 0 ? [heading, ...body] : body;

  const packed: string[] = [];
  let current = '';

  for (const paragraph of parts) {
    for (const piece of splitLongParagraph(paragraph, budget)) {
      if (current.length > 0 && current.length + 2 + piece.length > budget) {
        packed.push(current);
        current = '';
      }
      current = current.length === 0 ? piece : `${current}\n\n${piece}`;
    }
  }
  if (current.length > 0) packed.push(current);

  // A short trailing fragment is folded back, so a lesson does not end with a
  // twelve-character chunk that matches everything and means nothing.
  if (packed.length > 1) {
    const last = packed[packed.length - 1] ?? '';
    const previous = packed[packed.length - 2] ?? '';
    if (last.length < MIN_CHUNK_CHARACTERS && previous.length + 2 + last.length <= budget) {
      packed.splice(packed.length - 2, 2, `${previous}\n\n${last}`);
    }
  }

  for (const content of packed) {
    chunks.push({ ...ancestry, chunkIndex: index, content, kind: 'lesson' });
    index += 1;
  }

  return chunks;
}
