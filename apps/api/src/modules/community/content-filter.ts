/**
 * The automated content filter, and an honest account of what it is for.
 *
 * PURE FUNCTIONS, NO DATABASE, NO CLOCK, NO RANDOMNESS. Everything here is
 * input to output, which is what lets `tests/unit/community-content-filter.test.ts`
 * enumerate the evasions without a server.
 *
 * ---------------------------------------------------------------------------
 * THIS IS NOT A SAFETY SYSTEM, AND SAYING SO IS PART OF ITS DESIGN
 * ---------------------------------------------------------------------------
 *
 * A word list sees lexical events. The harms that actually happen on a
 * children's forum are not lexical:
 *
 *   Bullying is usually contextual — "everyone knows what you did at lunch" is
 *   devastating and contains no word any list holds.
 *   Exclusion is often what is NOT said, which no filter can read.
 *   Grooming is patient, polite, and specifically designed to pass filters.
 *   A child disclosing self-harm uses ordinary words about ordinary things.
 *
 * So this catches slurs and crude abuse, which are worth catching and are the
 * easy case. Everything else is caught, if at all, by a human being who was
 * told about it — which is why the REPORTING path and the moderation queue are
 * the load-bearing parts of this domain, and this file is the convenience.
 * `docs/security/limitations.md` records that in full rather than letting the
 * existence of a filter imply the absence of the problem.
 *
 * ---------------------------------------------------------------------------
 * IT FLAGS. IT DOES NOT BLOCK.
 * ---------------------------------------------------------------------------
 *
 * A match sets `moderation_status` to 'flagged', which hides the post from
 * classmates and puts it in front of a teacher. It never refuses the write.
 *
 * That asymmetry is deliberate and it is the safer direction:
 *
 *   A FALSE POSITIVE costs a teacher ten seconds and the author a short delay.
 *   Blocking would cost the author their text and tell them nothing useful.
 *
 *   A FALSE NEGATIVE reaches a class that can report it. The filter is not the
 *   only reader.
 *
 *   BLOCKING MAKES THE LIST AN ORACLE. A child who gets an immediate rejection
 *   can binary-search the word list in a minute and will then spell around it
 *   forever. A child whose post is quietly queued learns nothing about the
 *   list's contents.
 *
 * ---------------------------------------------------------------------------
 * THE SCUNTHORPE PROBLEM IS TAKEN SERIOUSLY
 * ---------------------------------------------------------------------------
 *
 * Substring matching on a word list is how a filter comes to flag "classic",
 * "assignment", "Scunthorpe", "cockpit" and "analysis". On a platform whose
 * users are children doing homework, every one of those is a real sentence
 * somebody will write, and a filter that cries wolf on them trains teachers to
 * clear the queue without reading it — which costs more safety than the filter
 * provides.
 *
 * So matching is on WORD BOUNDARIES over a normalized string, never substrings.
 * The cost is that "shitting" needs its own entry rather than being caught by
 * "shit"; the tests pin a list of innocent words that must never match, and
 * that list is as load-bearing as the word list itself.
 */

/**
 * Characters that carry no meaning and exist to break naive matching.
 *
 * Zero-width space, zero-width non-joiner and joiner, the word joiner, the
 * bidirectional overrides, and the byte-order mark. A child pasting from a
 * word processor picks some of these up by accident; a child evading a filter
 * uses them on purpose. Both are handled by deleting them.
 */
const INVISIBLE = /[\u200b-\u200f\u202a-\u202e\u2060-\u2064\ufeff]/g;

/**
 * Confusable characters mapped to the letter they imitate.
 *
 * Two families, and they are here for different reasons.
 *
 * LEETSPEAK (`4` for `a`, `$` for `s`) is deliberate evasion and the mapping is
 * uncontroversial.
 *
 * CYRILLIC AND GREEK HOMOGLYPHS (`а`, `е`, `о`, `р`, `с`) are the harder case:
 * they are real letters in real alphabets, and mapping them means a Russian or
 * Greek word could normalize into an English one. This platform teaches in
 * Arabic and English, so the risk of collateral damage is low and the evasion
 * — which costs an attacker one keystroke in a character picker — is real.
 * Recorded as a limitation rather than pretended away.
 */
const CONFUSABLES: Readonly<Record<string, string>> = Object.freeze({
  '0': 'o',
  '1': 'i',
  '3': 'e',
  '4': 'a',
  '5': 's',
  '7': 't',
  '8': 'b',
  '@': 'a',
  $: 's',
  '!': 'i',
  '|': 'i',
  '+': 't',
  а: 'a',
  е: 'e',
  о: 'o',
  р: 'p',
  с: 'c',
  х: 'x',
  у: 'y',
  і: 'i',
  ѕ: 's',
  α: 'a',
  ε: 'e',
  ο: 'o',
  ρ: 'p',
  ι: 'i',
  ν: 'v',
  τ: 't',
});

/**
 * Reduces text to the form the word list is matched against.
 *
 * The order matters and each step earns its place:
 *
 *   1. Lowercase and NFKD, so `Ｓ` and `ｓ` and `s` become one thing.
 *   2. Strip combining marks, so `ş` and `s̈` do not evade by decoration.
 *   3. Delete invisible characters entirely.
 *   4. Map confusables.
 *   5. Collapse letter-by-letter runs — `s.h.i.t` — using the repetition rule
 *      Task 012's guardrails arrived at the hard way: deleting every separator
 *      between letters also destroys word boundaries, and the detection with
 *      them. Requiring the pair to repeat separates `s.h.i.t` from `co-operate`.
 *   6. Collapse a letter repeated three or more times to two, so `shiiiiit`
 *      becomes `shiit`. Three rather than two, because `book` and `pass` are
 *      words and squashing every double would mangle them.
 *
 * STEP 6 DOES NOT FINISH THE JOB, and the fix is in `screenContent` rather than
 * here. `idiiiiot` normalizes to `idiiot`, which is not `idiot`, so the evasion
 * survives one more round. Squashing every repeat instead would catch it and
 * would also turn `bass` into `bas` and `class` into `clas` — safe against
 * today's word list and one entry away from not being.
 *
 * So this function keeps the conservative rule and the matcher tries BOTH
 * spellings: this one, and an aggressive variant that squashes every run to a
 * single letter. A term matching either flags. The cost is one extra regex pass
 * over a short string; the benefit is that the aggressive form never has to be
 * the only reading, so a word like `bass` is still `bass` in the reading that
 * matters. `MUST_NEVER_MATCH` is asserted against both.
 */
export function normalizeForFilter(text: string): string {
  const mapped = text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(INVISIBLE, '')
    .split('')
    .map((ch) => CONFUSABLES[ch] ?? ch)
    .join('');

  return (
    mapped
      // `+` ON THE SEPARATOR, not a single character. `f u c k` with two spaces
      // between each letter defeated the single-separator version: the pattern
      // consumed one space and then needed a letter, and found another space.
      // The `{2,}` repetition requirement is what still separates a genuine
      // letter-by-letter run from `co - operate`, which has one pair and survives.
      .replace(/\b(?:[a-z][\s._\-*|/\\~^=]+){2,}[a-z]\b/g, (run) =>
        run.replace(/[\s._\-*|/\\~^=]/g, ''),
      )
      .replace(/([a-z])\1{2,}/g, '$1$1')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

/**
 * The word list.
 *
 * DELIBERATELY SHORT. Every entry is a word whose presence in a message from
 * one child to another is worth a teacher's attention, and nothing is here
 * because it is merely rude in the abstract. A longer list is not a better one:
 * it is more false positives, a queue nobody reads, and more homework flagged.
 *
 * ENTRIES ARE MATCHED AS WHOLE WORDS. Inflections that matter get their own
 * entry rather than being caught by a substring rule — see the header.
 *
 * A REAL DEPLOYMENT WOULD NOT KEEP THIS IN SOURCE. It should be per-school,
 * editable by the people who know their students, versioned, and reviewable —
 * which is a product feature this task did not build. What is here is a
 * defensible default that makes the pipeline real and testable.
 */
const FLAGGED_TERMS: readonly string[] = Object.freeze([
  // Crude abuse aimed at a person. The category that actually appears.
  'idiot',
  'stupid',
  'moron',
  'loser',
  'ugly',
  'fat',
  'freak',
  'shut up',
  'nobody likes you',
  'kill yourself',
  'kys',
  // Profanity.
  'shit',
  'shitty',
  'fuck',
  'fucking',
  'fucked',
  'bitch',
  'bastard',
  'asshole',
  'dickhead',
  'crap',
  'damn',
  // Arabic, since this platform teaches in it and an English-only list would
  // be a filter that watches one of the two rooms.
  'غبي',
  'احمق',
  'اخرس',
  'كلب',
  'حمار',
  'تافه',
]);

/**
 * Words that must NEVER match, pinned here and asserted in the unit suite.
 *
 * Not used by the matcher — this is documentation with a test attached. Each
 * one is a word a child doing schoolwork will write, and each would be caught
 * by a substring rule over the list above. Their presence in the test is what
 * stops somebody "improving" the matcher into one that flags homework.
 */
export const MUST_NEVER_MATCH: readonly string[] = Object.freeze([
  'classic',
  'class',
  'assignment',
  'assess',
  'assessment',
  'assume',
  'Scunthorpe',
  'cockpit',
  'analysis',
  'shiitake',
  'bass',
  'grass',
  'therapist',
  'mishit',
  'crapaud',
  'damning',
  'Dickens',
  'butter',
  'constitution',
  'document',
  'titles',
  'penalty',
  'Uranus',
]);

/** Squashes every run of a repeated letter to a single one. */
const collapseRepeats = (text: string): string => text.replace(/([a-z])\1+/g, '$1');

export interface FilterFinding {
  /** The list entry that matched, for the moderation record. */
  readonly term: string;
}

export interface FilterVerdict {
  /** True when the post should be created as 'flagged' rather than 'approved'. */
  readonly flagged: boolean;
  readonly findings: readonly FilterFinding[];
  /**
   * A short reason for the audit trail and the moderation queue.
   *
   * IT NAMES THE TERMS, NOT THE POST. A moderation queue entry needs to say why
   * it exists; it does not need to carry the child's sentence, which the
   * moderator can read from the post itself if they have the authority to.
   */
  readonly reason: string;
}

const APPROVED: FilterVerdict = Object.freeze({
  flagged: false,
  findings: Object.freeze([]),
  reason: '',
});

/** Escapes a term for use inside a regular expression. */
const escape = (term: string): string => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Builds the whole-word matcher for one term.
 *
 * `\b` ON BOTH SIDES IS THE WHOLE SCUNTHORPE DEFENCE, and it does not work for
 * the Arabic entries: `\b` is defined against `\w`, which is ASCII-only in
 * JavaScript without the `u` flag and still excludes Arabic letters with it. So
 * Arabic terms are matched between non-letter boundaries using an explicit
 * class, which is the same idea expressed in the alphabet that needs it.
 */
function matcherFor(term: string): RegExp {
  const body = escape(term);
  return /[\u0600-\u06ff]/.test(term)
    ? new RegExp(`(?:^|[^\\u0600-\\u06ff])${body}(?:$|[^\\u0600-\\u06ff])`, 'u')
    : new RegExp(`\\b${body}\\b`, 'i');
}

const MATCHERS: ReadonlyArray<readonly [string, RegExp]> = FLAGGED_TERMS.map(
  (term) => [term, matcherFor(term)] as const,
);

/**
 * Decides whether a post should be created flagged.
 *
 * TOTAL: any input produces a verdict and nothing here throws. A filter that
 * can throw is a filter that can take down the endpoint it protects, and an
 * endpoint that fails closed on a filter error would let one crafted string
 * stop a class talking.
 */
export function screenContent(text: string): FilterVerdict {
  const normalized = normalizeForFilter(text);
  if (normalized.length === 0) return APPROVED;

  // The aggressive reading, squashing every repeated letter to one. See
  // `normalizeForFilter` for why this is a second reading rather than the only
  // one: it catches `idiiiiot` and it would also turn `bass` into `bas`.
  const squashed = collapseRepeats(normalized);

  const findings: FilterFinding[] = [];
  for (const [term, matcher] of MATCHERS) {
    if (matcher.test(normalized) || matcher.test(squashed)) findings.push({ term });
  }

  if (findings.length === 0) return APPROVED;

  return {
    flagged: true,
    findings,
    reason: `Automated filter matched: ${findings.map((f) => f.term).join(', ')}`,
  };
}

/** The states a post can be in. Mirrors the database CHECK exactly. */
export const MODERATION_STATES = ['approved', 'flagged', 'hidden'] as const;
export type ModerationState = (typeof MODERATION_STATES)[number];

/** What a moderator can ask for. */
export const MODERATION_ACTIONS = ['approve', 'hide', 'flag'] as const;
export type ModerationAction = (typeof MODERATION_ACTIONS)[number];

/**
 * The moderation state machine, as a total function.
 *
 * EVERY PAIR HAS AN ANSWER, and the answer is a state rather than an error.
 * Re-approving an approved post is a no-op rather than a 409: two teachers
 * clearing the same queue at the same time is normal, and making the second one
 * an error teaches staff to expect failures from the moderation tool.
 *
 * THERE IS NO TRANSITION OUT OF 'hidden' EXCEPT 'approve'. In particular a
 * hidden post cannot be moved back to 'flagged': once a human has looked, the
 * post is either fit to read or it is not, and "hidden, then re-queued for
 * somebody else to decide" would let a decision be laundered into the backlog.
 */
export function nextModerationState(
  current: ModerationState,
  action: ModerationAction,
): ModerationState {
  switch (action) {
    case 'approve':
      return 'approved';
    case 'hide':
      return 'hidden';
    case 'flag':
      // Flagging something already hidden leaves it hidden — a report about a
      // post a moderator has already removed does not un-remove it.
      return current === 'hidden' ? 'hidden' : 'flagged';
  }
}

/**
 * Whether an action changes anything, so the service can skip a write and the
 * audit trail is not filled with no-ops.
 */
export function isModerationNoop(current: ModerationState, action: ModerationAction): boolean {
  return nextModerationState(current, action) === current;
}
