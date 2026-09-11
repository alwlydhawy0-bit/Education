import { Fragment } from 'react';

/**
 * A tiny Markdown renderer that builds REACT ELEMENTS, never HTML.
 *
 * ---------------------------------------------------------------------------
 * WHY NOT `dangerouslySetInnerHTML`, EVEN FOR THE USER'S OWN NOTES
 * ---------------------------------------------------------------------------
 *
 * The obvious implementation — convert Markdown to an HTML string and inject it
 * — is an XSS hole with a comforting story attached. The story is "it is only
 * the learner's own text, in their own browser, so who would they be attacking?"
 * It fails on the first paste: notes get pasted from a web page, a PDF, a chat.
 * The moment `<img src=x onerror=...>` arrives in the clipboard, injecting it
 * executes it. And these notes are stored and re-rendered on every visit, so a
 * single bad paste becomes persistent.
 *
 * The stored value is also intended to sync to a server one day. A note that is
 * safe only because nobody else can see it stops being safe the moment sharing
 * ships — and that change would be made by someone who never read this file.
 *
 * Building React elements removes the question entirely. React escapes every
 * string it renders; there is no path from note text to executable markup, no
 * sanitiser to keep current, and no allowlist to get subtly wrong.
 *
 * ---------------------------------------------------------------------------
 * THE SUBSET, AND WHY IT IS SMALL
 * ---------------------------------------------------------------------------
 *
 * Headings, bold, italic, inline code, bullet and numbered lists, blockquotes.
 * That is what the toolbar can produce, and supporting syntax the toolbar
 * cannot write means shipping a parser for input that only arrives by accident.
 * Anything unrecognised renders as the literal text the learner typed — which
 * is the correct outcome for a notepad: nothing is ever silently swallowed.
 */

/** Inline formatting, resolved by one pass over a small set of delimiters. */
const INLINE = [
  { pattern: /\*\*([^*]+)\*\*/, render: (text, key) => <strong key={key}>{text}</strong> },
  { pattern: /\*([^*]+)\*/, render: (text, key) => <em key={key}>{text}</em> },
  {
    pattern: /`([^`]+)`/,
    render: (text, key) => (
      <code
        key={key}
        dir="ltr"
        className="rounded bg-surface-alt px-1.5 py-0.5 text-[0.9em] text-text-main"
      >
        {text}
      </code>
    ),
  },
];

function renderInline(line, keyPrefix) {
  /*
   * Earliest match wins, not first pattern wins. Scanning `**` across the whole
   * line before `*` would let a later bold swallow an earlier italic; taking
   * whichever delimiter appears first keeps the output in the order it was
   * typed. `**` is still listed before `*` so that at the SAME index the longer
   * delimiter is preferred — otherwise `**bold**` parses as an empty italic.
   */
  const nodes = [];
  let rest = line;
  let key = 0;

  while (rest.length > 0) {
    let best = null;
    for (const rule of INLINE) {
      const match = rule.pattern.exec(rest);
      if (match && (best === null || match.index < best.match.index)) best = { rule, match };
    }
    if (best === null) {
      nodes.push(rest);
      break;
    }
    if (best.match.index > 0) nodes.push(rest.slice(0, best.match.index));
    nodes.push(best.rule.render(best.match[1], `${keyPrefix}-${key}`));
    key += 1;
    rest = rest.slice(best.match.index + best.match[0].length);
  }

  return nodes;
}

const HEADING_CLASS = {
  1: 'mt-4 text-lg font-bold text-text-main first:mt-0',
  2: 'mt-4 text-base font-bold text-text-main first:mt-0',
  3: 'mt-3 text-sm font-semibold text-text-main first:mt-0',
};

/**
 * @param {string} source Markdown text.
 * @returns {import('react').ReactNode} Rendered nodes — always safe to mount.
 */
export function renderMarkdown(source) {
  const lines = source.split('\n');
  const blocks = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];

    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      const Tag = `h${level + 1}`; // h2..h4: the panel's own <h2> owns level 1.
      blocks.push(
        <Tag key={`h-${index}`} className={HEADING_CLASS[level]}>
          {renderInline(heading[2], `h-${index}`)}
        </Tag>,
      );
      index += 1;
      continue;
    }

    if (/^>\s?/.test(line)) {
      const quoted = [];
      while (index < lines.length && /^>\s?/.test(lines[index])) {
        quoted.push(lines[index].replace(/^>\s?/, ''));
        index += 1;
      }
      blocks.push(
        // `border-s` — the inline START edge, which RTL puts on the RIGHT. A
        // physical `border-l` would draw the quote bar on the wrong side.
        <blockquote
          key={`q-${index}`}
          className="mt-3 border-s-2 border-accent-lavender ps-3 text-text-muted"
        >
          {quoted.map((quotedLine, offset) => (
            <p key={offset}>{renderInline(quotedLine, `q-${index}-${offset}`)}</p>
          ))}
        </blockquote>,
      );
      continue;
    }

    const bullet = /^[-*]\s+(.*)$/.exec(line);
    const ordered = /^\d+[.)]\s+(.*)$/.exec(line);
    if (bullet || ordered) {
      const isOrdered = Boolean(ordered);
      const items = [];
      while (index < lines.length) {
        const itemMatch = isOrdered
          ? /^\d+[.)]\s+(.*)$/.exec(lines[index])
          : /^[-*]\s+(.*)$/.exec(lines[index]);
        if (!itemMatch) break;
        items.push(itemMatch[1]);
        index += 1;
      }
      const ListTag = isOrdered ? 'ol' : 'ul';
      blocks.push(
        <ListTag
          key={`l-${index}`}
          className={`mt-2 space-y-1 ps-5 ${isOrdered ? 'list-decimal' : 'list-disc'}`}
        >
          {items.map((item, offset) => (
            <li key={offset}>{renderInline(item, `l-${index}-${offset}`)}</li>
          ))}
        </ListTag>,
      );
      continue;
    }

    if (line.trim() === '') {
      index += 1;
      continue;
    }

    // A paragraph runs until a blank line or the start of another block.
    const paragraph = [];
    while (
      index < lines.length &&
      lines[index].trim() !== '' &&
      !/^(#{1,3}\s|>\s?|[-*]\s|\d+[.)]\s)/.test(lines[index])
    ) {
      paragraph.push(lines[index]);
      index += 1;
    }
    blocks.push(
      <p key={`p-${index}`} className="mt-2 leading-relaxed first:mt-0">
        {paragraph.map((paragraphLine, offset) => (
          <Fragment key={offset}>
            {offset > 0 ? <br /> : null}
            {renderInline(paragraphLine, `p-${index}-${offset}`)}
          </Fragment>
        ))}
      </p>,
    );
  }

  return blocks;
}
