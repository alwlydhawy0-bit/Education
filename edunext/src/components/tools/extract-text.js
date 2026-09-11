/*
 * Vite emits the worker as its own asset and hands back the URL. A bare
 * `new URL('pdfjs-dist/build/...', import.meta.url)` does NOT work — Vite only
 * rewrites that form for relative paths, so the bare specifier would survive
 * into the bundle and 404 at runtime. `?url` is the form that resolves through
 * the package and emits the file.
 *
 * This is a URL string, not code: the ~1MB worker is fetched only when a PDF is
 * actually opened.
 *
 * THE `legacy` BUILD, NOT THE DEFAULT ONE. pdf.js 6's modern build targets very
 * recent engines — it calls `Promise.try`, which only reached Chrome 134 and
 * Node 23 — so a learner on a phone a couple of years old would get a silent
 * extraction failure. The legacy build is transpiled for older targets and is
 * the right default for a product whose users are on whatever device they have.
 * The worker above and the library below must come from the SAME build; mixing
 * them produces a version-mismatch error at load.
 */
import pdfWorkerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';

/**
 * Pull readable text out of an uploaded study document.
 *
 * ---------------------------------------------------------------------------
 * WHY pdf.js IS LOADED WITH A DYNAMIC `import()`
 * ---------------------------------------------------------------------------
 *
 * pdf.js is around 350KB gzipped — larger than the rest of this application put
 * together. Importing it statically would make every visitor pay for it,
 * including the ones who never open a course, let alone upload a PDF. The
 * dynamic import puts it in its own chunk that is fetched the first time
 * someone actually needs it.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS AND IS NOT EXTRACTED
 * ---------------------------------------------------------------------------
 *
 * TXT: read directly.
 * PDF: the text LAYER. A scanned PDF has no text layer — it is a picture of
 *      pages — and this returns nothing for it rather than pretending. That is
 *      reported to the learner, because "0 characters" with no explanation
 *      looks like a bug, while "this file appears to be scanned images" is
 *      something they can act on.
 * Images: nothing. There is no OCR here, and saying so plainly is better than
 *      an empty text box the learner keeps poking at.
 *
 * The cap is not a formality. Extracted text is written to `localStorage`,
 * which holds roughly 5MB for the whole ORIGIN — shared with notes, sketches
 * and every other course's document. A 600-page textbook would consume all of
 * it and break saving everywhere else in the app.
 */

/** Beyond this, the text is truncated and the learner is told. */
export const MAX_TEXT_CHARS = 120_000;

/** Files larger than this are refused before they are read at all. */
export const MAX_FILE_BYTES = 20 * 1024 * 1024;

export const ACCEPTED = {
  'application/pdf': 'pdf',
  'text/plain': 'txt',
  'text/markdown': 'txt',
  'image/png': 'image',
  'image/jpeg': 'image',
  'image/webp': 'image',
  'image/gif': 'image',
};

/**
 * Classify a file by MIME type, falling back to its extension.
 *
 * The fallback matters: browsers report `application/octet-stream` for files
 * arriving from some Android file pickers and from network shares, and refusing
 * a perfectly good PDF because the picker was vague is a bug the learner cannot
 * work around.
 */
export function classify(file) {
  const byMime = ACCEPTED[file.type];
  if (byMime) return byMime;
  const extension = file.name.split('.').pop()?.toLowerCase();
  if (extension === 'pdf') return 'pdf';
  if (extension === 'txt' || extension === 'md') return 'txt';
  if (['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(extension ?? '')) return 'image';
  return null;
}

async function extractPdf(file) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

  const buffer = await file.arrayBuffer();
  /*
   * `task` and `pdf` are deliberately separate bindings, because they own
   * different things and only ONE of them can be destroyed.
   *
   * The first version did `const document = await getDocument(...).promise` and
   * later called `document.destroy()`. Two bugs in one line: `PDFDocumentProxy`
   * has no `destroy` in pdf.js 6 (cleanup lives on the LOADING TASK, and the
   * proxy offers only `cleanup()`), so every upload threw
   * "r.destroy is not a function" — and the local was named `document`, which
   * shadows the global exactly as it did in `NotePadModal`. Worth naming twice:
   * `document` is a tempting variable name and always the wrong one.
   */
  const task = pdfjs.getDocument({ data: buffer });
  const pdf = await task.promise;
  const pageCount = pdf.numPages;

  const pages = [];
  let total = 0;
  for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const content = await page.getTextContent();
    /*
     * `hasEOL` is what keeps the text readable. pdf.js emits positioned runs,
     * not lines; joining them all with spaces turns a two-column page into one
     * long smear where every sentence runs into the next column's.
     */
    const text = content.items
      .map((item) => (item.hasEOL ? `${item.str}\n` : item.str))
      .join('')
      .replace(/[ \t]+\n/g, '\n')
      .trim();
    pages.push(text);
    total += text.length;
    if (total > MAX_TEXT_CHARS) break;
  }

  /*
   * Release the worker's copy of the file. Without this the whole PDF stays
   * resident for as long as the tab lives — and `pageCount` was read BEFORE
   * this line, because the proxy is unusable afterwards.
   */
  await task.destroy();

  return { text: pages.join('\n\n'), pageCount };
}

/**
 * @returns {Promise<{ text: string, pageCount: number|null, truncated: boolean,
 *                     kind: 'pdf'|'txt'|'image' }>}
 */
export async function extractText(file) {
  const kind = classify(file);
  if (kind === null) throw new Error('unsupported');
  if (file.size > MAX_FILE_BYTES) throw new Error('too-large');

  if (kind === 'image') return { text: '', pageCount: null, truncated: false, kind };

  if (kind === 'txt') {
    const raw = await file.text();
    return {
      text: raw.slice(0, MAX_TEXT_CHARS),
      pageCount: null,
      truncated: raw.length > MAX_TEXT_CHARS,
      kind,
    };
  }

  const { text, pageCount } = await extractPdf(file);
  return {
    text: text.slice(0, MAX_TEXT_CHARS),
    pageCount,
    truncated: text.length > MAX_TEXT_CHARS,
    kind,
  };
}
