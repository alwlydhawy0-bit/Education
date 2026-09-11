/**
 * The guardrail layer: what a learner's turn is allowed to be, and what the
 * tutor is allowed to do with it.
 *
 * PURE FUNCTIONS, NO DATABASE, NO PROVIDER, NO CLOCK. Everything here is
 * input -> verdict, which is what makes it exhaustively testable: the suite in
 * `tests/unit/tutor-guardrails.test.ts` can enumerate attack strings without a
 * server, and a new evasion becomes a one-line test rather than a scenario.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS LAYER IS, AND — MORE IMPORTANTLY — WHAT IT IS NOT
 * ---------------------------------------------------------------------------
 *
 * IT IS NOT THE THING THAT KEEPS ONE CHILD'S DATA AWAY FROM ANOTHER. Not even
 * slightly. That is done by RLS, by the policy engine, and by Task 011's
 * pre-filtered retrieval, and it is done BEFORE this file runs. If every
 * function below returned "allow" for every input, no learner would gain access
 * to a single row they could not already read.
 *
 * That has to be stated first because pattern-matching defences invite exactly
 * the opposite belief. A regex list LOOKS like a security boundary and is not
 * one: it is a filter over an infinite input space, written by somebody who has
 * to guess, read by an attacker who can iterate. Anything load-bearing that sat
 * here would be a boundary made of guesses.
 *
 * SO WHAT IS IT FOR? Three things this layer genuinely can do:
 *
 *   1. REFUSE OUT-OF-SCOPE QUESTIONS HONESTLY. When retrieval returns nothing,
 *      the tutor must say so rather than answering from a model's general
 *      knowledge dressed as coursework. That is a correctness and honesty
 *      property, and it is decided by what was RETRIEVED, not by what was
 *      typed — which is why the out-of-scope decision lives in the service and
 *      takes a source count, not a string.
 *
 *   2. KEEP THE TUTOR A TUTOR. A child asking "just give me the answer to
 *      question 3" should get help understanding, not a completed homework.
 *      That is a pedagogical stance, not a security control, and it is
 *      implemented as a stance: the detection steers the instructions rather
 *      than refusing the child.
 *
 *   3. MAKE INJECTION ATTEMPTS VISIBLE. Detecting "ignore your instructions"
 *      does not stop an attack that the other layers would not have stopped
 *      anyway — but it puts a security event in the audit trail, and a burst of
 *      them from one account is a signal an operator should have. The value is
 *      OBSERVABILITY, and this file says so rather than claiming prevention.
 *
 * The honest summary: this layer improves the product and instruments the
 * platform. It is defence in depth, and depth is all it is.
 */

/** What the guardrails concluded about one learner turn. */
export type GuardrailVerdict =
  'blocked_injection' | 'blocked_answer_seeking' | 'out_of_scope' | 'truncated';

export interface GuardrailFinding {
  /** A stable identifier for the audit trail. Never the matched text. */
  readonly rule: string;
  readonly severity: 'block' | 'steer' | 'note';
}

export interface SanitizedTurn {
  /** The question as it will be sent. Never the raw input. */
  readonly text: string;
  /** True when the input was longer than the cap and was cut. */
  readonly truncated: boolean;
  readonly findings: readonly GuardrailFinding[];
  /** Set when the turn must not reach a provider at all. */
  readonly blocked: GuardrailVerdict | null;
}

/**
 * The longest question accepted, in characters.
 *
 * Not a security boundary on its own — Fastify's `bodyLimit` and the Zod
 * contract both bound the request first. This is the SEMANTIC cap: past a few
 * thousand characters an input has stopped being a question and started being a
 * payload, and the most common way to bury an instruction is to pad around it.
 *
 * Deliberately BELOW the contract's own maximum, because a limit equal to the
 * one in front of it never fires — VULN-043, where a payload cap was set to the
 * same value as `bodyLimit` and was dead code nobody noticed for a whole task.
 */
export const MAX_QUESTION_CHARACTERS = 2_000;

/**
 * Characters removed before anything else looks at the text.
 *
 * Zero-width and bidirectional-override characters exist in Unicode for
 * legitimate typography and are used here for exactly one thing: making a
 * string display differently from how it parses. An "ignore previous" with a
 * zero-width space inside it reads as ordinary prose to a human reviewing a
 * transcript and tokenizes as the instruction it is. Stripping them means the
 * moderator reading the log and the model reading the prompt see the same
 * characters — which is the property that makes a transcript worth keeping.
 *
 * C0 controls other than tab and newline go too. They have no meaning in a
 * typed question and several have meaning in a prompt format.
 *
 * Written as escapes rather than as the characters themselves, because a source
 * file containing invisible characters is a source file nobody can review.
 */
// Matching control characters is the entire purpose of this pattern: they are
// being REMOVED from untrusted input, which is the case `no-control-regex`
// exists to make you justify rather than the case it exists to forbid.
const INVISIBLE_CHARACTERS =
  // eslint-disable-next-line no-control-regex -- see the note directly above
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u00AD\u200B-\u200F\u2028\u2029\u202A-\u202E\u2060-\u2064\u206A-\u206F\uFEFF]/g;

/**
 * Collapses the tricks that make a pattern list trivially bypassable.
 *
 * Case, runs of whitespace, and the punctuation commonly inserted BETWEEN
 * letters to break a match ("i-g-n-o-r-e", "i.g.n.o.r.e"). Applied to a COPY
 * used only for matching; the text actually sent to the provider keeps its
 * original characters minus the invisibles, because a learner asking about
 * hyphenation deserves to have their question survive intact.
 *
 * This is not a claim to have closed the evasion space. It closes the cheap
 * half of it, and the header explains why closing all of it is not the point.
 */
function normalizeForMatching(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/\s+/g, ' ')
      // COLLAPSE ONLY GENUINE LETTER-BY-LETTER RUNS — "i-g-n-o-r-e",
      // "i.g.n.o.r.e", "i g n o r e" — by requiring the letter-separator pair
      // to repeat at least twice before a final letter.
      //
      // The first version of this simply deleted every separator between two
      // letters, spaces included, and the unit suite failed almost entirely in
      // one go: "ignore all previous instructions" collapsed to
      // "ignoreallpreviousinstructions", where not one word-boundary anchor in
      // any rule could match. A normalizer aggressive enough to defeat the
      // evasion had defeated the detection with it.
      //
      // Requiring the repetition is what separates the two cases. "e-mail" and
      // "co-operate" have a single letter-separator pair and survive intact;
      // "i-g-n-o-r-e" has five and does not.
      .replace(/\b(?:[a-z][\s._\-*|/\\]){2,}[a-z]\b/g, (run) => run.replace(/[\s._\-*|/\\]/g, ''))
  );
}

interface Rule {
  readonly id: string;
  readonly severity: 'block' | 'steer' | 'note';
  readonly pattern: RegExp;
}

/**
 * Attempts to replace, reveal or escape the platform's own instructions.
 *
 * `block`, because there is no legitimate reading of them in a lesson-scoped
 * study conversation, and because the value of stopping them here is that the
 * attempt is RECORDED. A learner who types one is told plainly that it was
 * refused rather than being silently ignored — silence teaches the persistent
 * child to keep trying variations, while a clear refusal ends most attempts.
 */
const INJECTION_RULES: readonly Rule[] = [
  {
    id: 'override.ignore_instructions',
    severity: 'block',
    pattern:
      /\b(ignore|disregard|forget|override|bypass)\b[^.?!]{0,40}\b(previous|prior|above|earlier|initial|original|all|any|your)\b[^.?!]{0,40}\b(instruction|prompt|rule|direction|guideline|constraint|restriction)/,
  },
  {
    id: 'override.reveal_system_prompt',
    severity: 'block',
    pattern:
      /\b(show|reveal|print|repeat|output|display|tell|give|reproduce|echo)\b[^.?!]{0,40}\b(system|initial|original|hidden|secret|your)\b[^.?!]{0,30}\b(prompt|instruction|message|rule|configuration|directive)/,
  },
  {
    id: 'override.role_reassignment',
    severity: 'block',
    pattern:
      /\b(you are now|from now on you|act as|pretend (to be|you)|roleplay as|simulate being|behave as if you)\b/,
  },
  {
    id: 'override.developer_mode',
    severity: 'block',
    pattern:
      /\b(developer mode|dan mode|jailbreak|unrestricted mode|no restrictions|without any restrictions|sudo mode|god mode|admin mode)\b/,
  },
  {
    id: 'override.fake_turn_boundary',
    severity: 'block',
    // Attempts to forge a conversational frame — "system:", "[INST]",
    // "<|im_start|>" and friends. The structured request already makes these
    // inert (they arrive inside a question field, never an instruction one), so
    // this rule exists purely to record that somebody tried.
    pattern:
      /(<\|[a-z_]+\|>|\[\/?INST\]|\[\/?SYS\]|<<\/?SYS>>|^\s*(system|assistant|developer)\s*:)/im,
  },
  {
    id: 'override.exfiltrate_configuration',
    severity: 'block',
    pattern:
      /\b(api[ _-]?key|access[ _-]?token|secret[ _-]?key|environment variable|connection string|database (password|url|credential))\b/,
  },
  {
    id: 'override.other_students',
    severity: 'block',
    // Not a real access path — RLS decides that — but a strong signal about
    // intent, and worth an event even though it could not have succeeded.
    pattern:
      /\b(other|another|classmate'?s?|everyone else'?s?|all)\b[^.?!]{0,30}\b(student|learner|pupil|child)s?\b[^.?!]{0,30}\b(answer|note|conversation|chat|grade|mark|score|data|record)/,
  },
  {
    id: 'override.answer_key',
    severity: 'block',
    pattern:
      /\b(answer key|marking scheme|mark scheme|model answer|correct answers? for|solutions? file)\b/,
  },
];

/**
 * Asking the tutor to DO the work rather than explain it.
 *
 * `steer`, not `block`, and the distinction matters more here than anywhere
 * else in this file. A twelve-year-old typing "just tell me the answer to
 * question 3" is not attacking anything; they are stuck, or tired, or out of
 * time. Refusing them outright teaches that the tutor is an obstacle to get
 * around. So the turn goes through and the INSTRUCTIONS change: the tutor is
 * told to walk them towards the answer instead of handing it over.
 *
 * That is section 2B's "guide step-by-step rather than doing homework or
 * quizzes directly", implemented as guidance rather than as a wall.
 */
const ANSWER_SEEKING_RULES: readonly Rule[] = [
  {
    id: 'homework.give_me_the_answer',
    severity: 'steer',
    pattern:
      /\b(just |simply |only )?(give|tell|show|hand)\b[^.?!]{0,20}\bme\b[^.?!]{0,25}\b(the )?(answer|solution|result)s?\b/,
  },
  {
    id: 'homework.do_it_for_me',
    severity: 'steer',
    pattern:
      /\b(do|complete|finish|solve|write|answer)\b[^.?!]{0,25}\b(my|the)\b[^.?!]{0,20}\b(homework|assignment|quiz|test|exam|worksheet|coursework|essay|question \d+)\b/,
  },
  {
    id: 'homework.no_explanation',
    severity: 'steer',
    pattern:
      /\b(no|without|skip|don'?t)\b[^.?!]{0,20}\b(explanation|working|steps?|reasoning|detail)s?\b/,
  },
  {
    id: 'homework.answers_only',
    severity: 'steer',
    pattern: /\b(answers?|solutions?) only\b|\bjust the (answer|number|result)s?\b/,
  },
];

/**
 * Applies every rule to the normalized copy and reports what matched.
 *
 * Returns findings rather than a boolean because the audit trail wants to know
 * WHICH rule fired — a burst of `override.reveal_system_prompt` from one
 * account is a different story from a burst of `homework.give_me_the_answer`,
 * and an operator should not have to guess which they are looking at.
 *
 * THE MATCHED TEXT IS NEVER RETURNED. Only the rule id. What a child typed is
 * the most sensitive thing in this domain, and an audit trail read by more
 * people than the conversation itself must not carry it.
 */
function evaluate(rules: readonly Rule[], normalized: string): GuardrailFinding[] {
  const findings: GuardrailFinding[] = [];
  for (const rule of rules) {
    // None of these carry /g, so `lastIndex` is not shared between calls.
    // Stated because a /g regex reused across calls is a classic
    // intermittent-failure bug, and the next person adding a rule should know
    // the flag's absence is deliberate rather than an oversight.
    if (rule.pattern.test(normalized)) {
      findings.push({ rule: rule.id, severity: rule.severity });
    }
  }
  return findings;
}

/** The entry point: what may be sent, and what the platform thinks of it. */
export function sanitizeStudentTurn(raw: string): SanitizedTurn {
  const stripped = raw.replace(INVISIBLE_CHARACTERS, '');
  const collapsed = stripped
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  const truncated = collapsed.length > MAX_QUESTION_CHARACTERS;
  const text = truncated ? collapsed.slice(0, MAX_QUESTION_CHARACTERS) : collapsed;

  // MATCHED AGAINST THE FULL COLLAPSED TEXT, not the truncated copy. Otherwise
  // padding a question past the cap would push an instruction beyond the point
  // the matcher looks — turning the length limit into an evasion technique.
  const normalized = normalizeForMatching(collapsed);

  const injection = evaluate(INJECTION_RULES, normalized);
  const answerSeeking = evaluate(ANSWER_SEEKING_RULES, normalized);
  const findings = [...injection, ...answerSeeking];

  if (truncated) findings.push({ rule: 'length.truncated', severity: 'note' });

  return {
    text,
    truncated,
    findings,
    blocked: injection.length > 0 ? 'blocked_injection' : null,
  };
}

/** Whether the turn should be steered towards teaching rather than answering. */
export function needsTeachingStance(turn: SanitizedTurn): boolean {
  return turn.findings.some((finding) => finding.severity === 'steer');
}

/**
 * A rough token count, used only for budgeting.
 *
 * DELIBERATELY AN OVER-ESTIMATE and deliberately not a tokenizer. Every model
 * tokenizes differently, a real tokenizer is a vendor dependency, and this
 * number is never shown to anybody and never used for billing — it decides how
 * many passages fit. Being wrong low would silently overflow a context window;
 * being wrong high costs a passage. So it is wrong high, on purpose.
 *
 * ~3.5 characters per token is conservative for English and much more so for
 * Arabic, where a character often costs more than a token's worth. This
 * platform teaches in both, and the cheaper estimate is the one that breaks in
 * the language nobody tested.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
}

export interface BudgetedSources<T> {
  readonly kept: readonly T[];
  readonly dropped: number;
  readonly estimatedTokens: number;
}

/**
 * Takes passages in priority order until the budget is spent.
 *
 * PRIORITY ORDER IS PRESERVED, never re-sorted by size. It would be cheap to
 * fit more passages by packing the small ones first, and it would silently
 * change which material the tutor answers from — the most relevant passage
 * being dropped because it was long is exactly the failure a learner
 * experiences as "the tutor did not know the thing it was told".
 *
 * A single passage larger than the whole budget is dropped rather than
 * truncated: half a definition is worse than no definition, because the tutor
 * cannot tell that it is reading half.
 */
export function budgetSources<T>(
  sources: readonly T[],
  textOf: (source: T) => string,
  budgetTokens: number,
): BudgetedSources<T> {
  const kept: T[] = [];
  let spent = 0;
  let dropped = 0;

  for (const source of sources) {
    const cost = estimateTokens(textOf(source));
    if (spent + cost > budgetTokens) {
      dropped += 1;
      continue;
    }
    kept.push(source);
    spent += cost;
  }

  return { kept, dropped, estimatedTokens: spent };
}
