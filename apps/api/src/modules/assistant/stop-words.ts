/**
 * FUNCTION WORDS, EXCLUDED FROM RETRIEVAL TERMS.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS EXISTS (RISK-AI-09, VULN-039)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Migration 0023 indexes curriculum text with the `simple` full-text
 * configuration, and that choice is deliberate and documented: the corpus is
 * mixed Arabic and English, and a stemmer for one language mangles the other.
 *
 * `simple` does no stemming — and it also carries NO STOP-WORD LIST. That
 * second half was not thought through, and it is the whole of this defect. To
 * `simple`, the Arabic word `ما` ("what") is a content term exactly like
 * `الميتوكوندريا`.
 *
 * Measured, not theorised. The Task 016 benchmark asked, in Arabic, "what is
 * the capital of Japan?" against a lesson about cells. Retrieval returned all
 * four paragraphs of the lesson — matching on `ما` and `هي` alone — the
 * assistant cited them, and the server labelled the answer
 * `course_material`. The platform told a child their biology textbook covers
 * the capital of Japan. Four of four unanswerable Arabic questions behaved
 * this way, including one asking for an exam answer.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY A WORD LIST AND NOT A SCORE THRESHOLD
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The obvious alternative is a `ts_rank` floor. It was rejected: any such
 * number would be picked because it makes today's cases pass, it would need
 * re-tuning for every corpus size, and it would silently become the definition
 * of "grounded" without anyone having argued for the value.
 *
 * This list makes a claim that can be argued with instead: **these specific
 * words carry no topical information in a curriculum search.** A reviewer can
 * read every entry and disagree with any of them. That is a much better
 * property for a control that decides whether a child is told their textbook
 * says something.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT THIS DOES NOT FIX
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * It is a hand-written list and therefore incomplete, in both languages and
 * permanently. It does not address morphology (RISK-AI-04) — `الخلايا` still
 * fails to match `الخلية` — and it does nothing for paraphrase (RISK-AI-05).
 * A question built entirely from uncommon-but-irrelevant words can still
 * retrieve nothing useful and, if a provider cites it, still ground falsely.
 *
 * The benchmark measures all of that rather than assuming it away.
 */

/**
 * Arabic function words: interrogatives, pronouns, prepositions, particles,
 * demonstratives, and the handful of pedagogical verbs that appear in almost
 * every question a learner types ("explain", "describe", "mention").
 *
 * Written unvocalised, because the tokenizer sees text as authored and Arabic
 * curriculum prose is usually written without diacritics.
 */
const ARABIC = [
  // interrogatives
  'ما',
  'ماذا',
  'من',
  'متى',
  'أين',
  'اين',
  'كيف',
  'لماذا',
  'كم',
  'أي',
  'اي',
  'هل',
  // pronouns
  'هو',
  'هي',
  'هم',
  'هن',
  'أنا',
  'انا',
  'نحن',
  'أنت',
  'انت',
  'هما',
  // demonstratives and relatives
  'هذا',
  'هذه',
  'ذلك',
  'تلك',
  'هؤلاء',
  'الذي',
  'التي',
  'الذين',
  'اللاتي',
  // prepositions and particles
  'في',
  'من',
  'إلى',
  'الى',
  'على',
  'عن',
  'مع',
  'بين',
  'عند',
  'حتى',
  'لكن',
  'أو',
  'او',
  'ثم',
  'قد',
  'كان',
  'كانت',
  'يكون',
  'تكون',
  'لا',
  'لم',
  'لن',
  'إن',
  'ان',
  'أن',
  'إذا',
  'اذا',
  'كل',
  'بعض',
  'غير',
  'مثل',
  'حول',
  // the pedagogical verbs a learner opens a question with
  'اشرح',
  'وضح',
  'يوضح',
  'اذكر',
  'يذكر',
  'عرف',
  'يعرف',
  'صف',
  'يصف',
  'بين',
  'حدد',
  'يحدد',
  'قارن',
  'يقارن',
  'علل',
  'يعلل',
  // words for the material itself, which appear in every lesson
  'الدرس',
  'درس',
  'الوحدة',
  'المادة',
  'الكتاب',
  'النص',
  'السؤال',
  'الإجابة',
  'الاجابة',
];

/** English equivalents, for the Latin-script half of a mixed corpus. */
const ENGLISH = [
  'what',
  'which',
  'who',
  'whom',
  'whose',
  'when',
  'where',
  'why',
  'how',
  'the',
  'and',
  'for',
  'are',
  'was',
  'were',
  'been',
  'being',
  'that',
  'this',
  'these',
  'those',
  'with',
  'from',
  'into',
  'about',
  'above',
  'after',
  'before',
  'between',
  'during',
  'over',
  'under',
  'than',
  'then',
  'there',
  'here',
  'have',
  'has',
  'had',
  'does',
  'did',
  'can',
  'could',
  'will',
  'would',
  'should',
  'may',
  'might',
  'must',
  'not',
  'but',
  'all',
  'any',
  'some',
  'its',
  'his',
  'her',
  'their',
  'our',
  'your',
  'you',
  'they',
  'them',
  'it',
  // the same pedagogical verbs and material words
  'explain',
  'describe',
  'define',
  'mention',
  'state',
  'compare',
  'discuss',
  'outline',
  'summarise',
  'summarize',
  'tell',
  'say',
  'show',
  'give',
  'lesson',
  'unit',
  'chapter',
  'book',
  'text',
  'question',
  'answer',
  'system',
];

/**
 * The set consulted by retrieval.
 *
 * Both languages in one set on purpose: a question can mix them, and there is
 * no reliable way to tell which language a two-word query is in.
 */
export const RETRIEVAL_STOP_WORDS: ReadonlySet<string> = new Set([...ARABIC, ...ENGLISH]);
