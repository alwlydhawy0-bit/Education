/**
 * The highlighter inks.
 *
 * `id` is what gets PERSISTED, never the class name: a stored `bg-mark-amber`
 * would hard-code today's Tailwind spelling into every learner's saved
 * document, and renaming the token later would silently blank their
 * highlights. An id survives any amount of restyling.
 */
export const INKS = [
  { id: 'amber', label: 'أصفر', mark: 'bg-mark-amber', swatch: 'bg-mark-amber' },
  { id: 'green', label: 'أخضر', mark: 'bg-mark-green', swatch: 'bg-mark-green' },
  { id: 'sky', label: 'أزرق', mark: 'bg-mark-sky', swatch: 'bg-mark-sky' },
  { id: 'rose', label: 'وردي', mark: 'bg-mark-rose', swatch: 'bg-mark-rose' },
];

export const DEFAULT_INK = INKS[0].id;

export const inkOf = (id) => INKS.find((ink) => ink.id === id) ?? INKS[0];

/**
 * Split the document text into plain and highlighted runs.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS MATCHES ON THE QUOTE RATHER THAN A STORED OFFSET
 * ---------------------------------------------------------------------------
 *
 * A character range is the tidier model and the wrong one here. The text is
 * re-extracted every time the file is re-uploaded, and pdf.js does not promise
 * byte-identical output across versions — so an offset saved last term can
 * point into the middle of a different sentence today, silently moving a
 * learner's highlight onto text they never marked. Matching the quote either
 * finds the passage or does not; it never lands on the wrong one.
 *
 * The cost is honest and small: an identical sentence appearing twice gets
 * highlighted in both places. That is a visible, explicable outcome rather
 * than a silent corruption.
 *
 * Overlaps are resolved by taking the EARLIEST match and, among those, the
 * LONGEST — so a highlight nested inside another does not chop its parent into
 * fragments with a gap where the child sits.
 */
export function segmentText(text, annotations) {
  const found = [];
  for (const annotation of annotations) {
    const quote = annotation.quote;
    if (!quote) continue;
    let from = 0;
    for (;;) {
      const at = text.indexOf(quote, from);
      if (at === -1) break;
      found.push({ start: at, end: at + quote.length, annotation });
      from = at + quote.length;
    }
  }

  found.sort((a, b) => a.start - b.start || b.end - a.end);

  const segments = [];
  let cursor = 0;
  for (const hit of found) {
    if (hit.start < cursor) continue; // already inside an earlier highlight
    if (hit.start > cursor) segments.push({ text: text.slice(cursor, hit.start) });
    segments.push({ text: text.slice(hit.start, hit.end), annotation: hit.annotation });
    cursor = hit.end;
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor) });
  return segments;
}
