/**
 * Study aids generated from an uploaded document — SIMULATED, like every other
 * answer in this panel, and labelled as such in the UI.
 *
 * ---------------------------------------------------------------------------
 * WHY THE QUESTIONS ARE BUILT FROM THE LEARNER'S ACTUAL TEXT
 * ---------------------------------------------------------------------------
 *
 * A quiz generator that returns pre-written questions about a generic topic
 * would demo beautifully and be worthless: the learner uploads their own
 * lecture notes and gets asked about something else. Worse, they would not
 * immediately notice, because the questions would still LOOK plausible.
 *
 * So the sentences, terms and key lines come out of the document that was
 * uploaded. The result is not intelligent — it cannot tell an important
 * sentence from an incidental one — but it is HONEST: every stem quotes the
 * learner's own material, so when it produces something silly, that is visibly
 * a limitation of the generator rather than a claim about their notes.
 *
 * The distractors are the part that cannot be faked well without a model, and
 * the code says so where it builds them.
 *
 * ---------------------------------------------------------------------------
 * REPLACING THIS
 * ---------------------------------------------------------------------------
 *
 * `generateQuiz` and `summarise` return plain data — an array of
 * `{ id, question, options, answerIndex, explanation, source }`. A real
 * endpoint returns the same shape, and the quiz card renders it unchanged.
 */

/** Enough to be a study session, few enough to read in the panel. */
const QUESTION_COUNT = 4;

/**
 * Split text into sentences that are worth quoting.
 *
 * Arabic sentences end with `.`, `؟`, `!` or a newline, and the Arabic comma
 * (`،`) is NOT a terminator — treating it as one chops clauses into fragments
 * that read as broken quotes.
 */
function sentencesOf(text) {
  return text
    .split(/(?<=[.!؟])\s+|\n+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length >= 40 && sentence.length <= 220);
}

/** Candidate key terms: the longest words, which in practice are the technical ones. */
function termsOf(text) {
  const seen = new Map();
  for (const word of text.split(/[\s.,،؛:()[\]{}"'«»\n]+/)) {
    const cleaned = word.trim();
    if (cleaned.length < 5) continue;
    seen.set(cleaned, (seen.get(cleaned) ?? 0) + 1);
  }
  return (
    [...seen.entries()]
      // Frequent AND long: a term repeated through a document is usually its subject.
      .sort((a, b) => b[1] * b[0].length - a[1] * a[0].length)
      .map(([term]) => term)
  );
}

/** A deterministic shuffle, so the same document always yields the same quiz. */
function seededOrder(length, seed) {
  const indexes = [...Array(length).keys()];
  let state = seed;
  for (let i = indexes.length - 1; i > 0; i -= 1) {
    state = (state * 1103515245 + 12345) % 2147483648;
    const j = state % (i + 1);
    [indexes[i], indexes[j]] = [indexes[j], indexes[i]];
  }
  return indexes;
}

function hashOf(text) {
  let hash = 7;
  for (const character of text.slice(0, 2000))
    hash = (hash * 31 + character.codePointAt(0)) % 2147483647;
  return hash;
}

/**
 * Build multiple-choice questions from the document.
 *
 * @returns {Array<{id,question,options,answerIndex,explanation,source}>}
 */
export function generateQuiz(document) {
  const sentences = sentencesOf(document.text);
  const terms = termsOf(document.text);
  if (sentences.length === 0 || terms.length < 4) return [];

  const seed = hashOf(document.text);
  const picks = seededOrder(sentences.length, seed).slice(0, QUESTION_COUNT);

  return picks.flatMap((sentenceIndex, order) => {
    const sentence = sentences[sentenceIndex];
    // The answer is the longest term the sentence actually contains, so the
    // question is always answerable from the quoted line.
    const answer = terms.find((term) => sentence.includes(term));
    if (!answer) return [];

    /*
     * DISTRACTORS ARE THE HONEST WEAK POINT. Real ones are plausible-but-wrong
     * and require understanding the material; these are simply other frequent
     * terms from the same document that do NOT appear in this sentence. That
     * makes them wrong, and sometimes obviously so. A model would do this part
     * properly — it is the single biggest gap between this and the real thing,
     * and it is why the panel says the quiz is illustrative.
     */
    const distractors = terms
      .filter((term) => term !== answer && !sentence.includes(term))
      .slice(order * 3, order * 3 + 3);
    if (distractors.length < 3) return [];

    const options = [answer, ...distractors];
    const order2 = seededOrder(options.length, seed + order);
    const shuffled = order2.map((index) => options[index]);

    return [
      {
        id: `q-${seed}-${order}`,
        question: `أكملي من المستند: «${sentence.replace(answer, '_____')}»`,
        options: shuffled,
        answerIndex: shuffled.indexOf(answer),
        explanation: `الجملة في المستند كما وردت: «${sentence}»`,
        source: document.name,
      },
    ];
  });
}

/** Key lines for revision, taken verbatim so nothing is paraphrased into error. */
export function summarise(document) {
  const sentences = sentencesOf(document.text);
  if (sentences.length === 0) return null;
  const seed = hashOf(document.text);
  const picks = seededOrder(sentences.length, seed).slice(0, 5);
  const lines = picks.map((index) => `- ${sentences[index]}`).join('\n');
  return `أهمّ ما ورد في **${document.name}**:\n\n${lines}\n\n> هذه اقتباسات حرفية من ملفك، لم تُعَد صياغتها — راجعيها في سياقها الكامل قبل الاعتماد عليها.`;
}

/** Questions a learner might be asked, phrased from the document's own terms. */
export function predictedQuestions(document) {
  const terms = termsOf(document.text).slice(0, 5);
  if (terms.length === 0) return null;
  const lines = terms
    .map((term, index) => `${index + 1}. ما المقصود بـ **${term}**، وكيف ورد في المستند؟`)
    .join('\n');
  return `أسئلة متوقّعة من **${document.name}**:\n\n${lines}\n\n> مبنيّة على المصطلحات الأكثر تكرارًا في ملفك، لا على بنك أسئلة حقيقي.`;
}
