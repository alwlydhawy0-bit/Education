/**
 * The markdown check that actually earns its place.
 *
 * WHAT THIS IS NOT: an HTML sanitizer. Nothing on this platform converts a
 * note's markdown into HTML — there is no renderer, in the API or in the web
 * app — so there is no sink to sanitize for, and
 * `tests/architecture/workspace-boundaries.test.ts` asserts that structurally
 * by refusing every HTML sink in `apps/web`. When a renderer is added it must
 * sanitize at render time, which is the only place a sanitizer is correct.
 *
 * WHAT THIS IS: a check on link DESTINATIONS, which is the one vector that
 * survives HTML-escaping. A renderer that escapes raw HTML — the safe default,
 * and what any sensible choice would do — will still happily emit
 * `<a href="javascript:alert(1)">` from the markdown-native `[click](javascript:…)`.
 * The scheme is the payload, and markdown's own syntax carries it.
 *
 * IT REJECTS RATHER THAN STRIPS, and that is a deliberate choice about whose
 * data this is. Silently rewriting a child's note is corrupting their work to
 * make a validator's life easier; they get no error, no diff, and no way to
 * know the platform edited what they wrote. A refusal is honest and reversible.
 *
 * IT ONLY LOOKS IN DESTINATION POSITION, which is what keeps it usable. A
 * computing student writing prose about `javascript:` URLs, or pasting one into
 * a fenced code block to discuss it, is doing schoolwork. Only a scheme sitting
 * where a browser would follow it is refused.
 */

/** Schemes a browser will execute, or that can smuggle a document. */
const FORBIDDEN_SCHEMES = ['javascript', 'vbscript', 'data'] as const;

export type ForbiddenScheme = (typeof FORBIDDEN_SCHEMES)[number];

/**
 * Builds a pattern for one scheme that tolerates characters inserted BETWEEN
 * its letters.
 *
 * `java&#x09;script:` and `java\nscript:` are the classic evasions: HTML entity
 * decoding and whitespace stripping happen inside the browser's URL parser,
 * after any naive `includes('javascript:')` has already said no. Matching
 * letter by letter with control characters permitted between them closes that
 * without needing to model the decoder.
 */
function schemePattern(scheme: string): string {
  return scheme.split('').join('[\\x00-\\x20]*') + '[\\x00-\\x20]*:';
}

const SCHEMES = FORBIDDEN_SCHEMES.map(schemePattern).join('|');

/**
 * The three places a markdown destination can appear.
 *
 *   1. `[text](dest)` and `![alt](dest)`, optionally `<`-wrapped.
 *   2. `<dest>` — a CommonMark autolink, which needs a scheme to be one.
 *   3. `[label]: dest` — a reference definition, at the start of a line.
 *
 * Case-insensitive, because `JavaScript:` is the same scheme to a browser.
 */
const DESTINATION_PATTERNS: readonly RegExp[] = [
  new RegExp(String.raw`\]\s*\(\s*<?\s*(?:${SCHEMES})`, 'i'),
  new RegExp(String.raw`<\s*(?:${SCHEMES})`, 'i'),
  new RegExp(String.raw`^[ \t]{0,3}\[[^\]\n]*\]\s*:\s*<?\s*(?:${SCHEMES})`, 'im'),
];

export interface MarkdownRejection {
  readonly reason: 'forbidden_link_scheme';
  /** Which scheme was found, so the message can name it. */
  readonly scheme: ForbiddenScheme;
}

/**
 * Returns a rejection when the markdown carries a forbidden scheme in a link
 * destination, or null when it does not.
 *
 * Total: any input is either accepted or rejected, and nothing here throws.
 */
export function checkMarkdown(body: string): MarkdownRejection | null {
  if (!DESTINATION_PATTERNS.some((pattern) => pattern.test(body))) return null;

  // Name the scheme for the error message. Scanned separately from the
  // detection above so a rejection is never reported without one.
  const found =
    FORBIDDEN_SCHEMES.find((scheme) =>
      new RegExp(schemePattern(scheme), 'i').test(body),
    ) ?? 'javascript';

  return { reason: 'forbidden_link_scheme', scheme: found };
}
