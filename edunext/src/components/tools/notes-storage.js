/**
 * Per-course notebook persistence.
 *
 * ---------------------------------------------------------------------------
 * `localStorage`, NOT `sessionStorage` — THE OPPOSITE OF THE SESSION MARKER
 * ---------------------------------------------------------------------------
 *
 * The auth session deliberately uses `sessionStorage`, so a demo login does not
 * outlive the tab. Notes are the reverse case: a learner who closes the tab and
 * comes back tomorrow expects their notes to still be there, and losing them
 * would be the single most damaging thing this feature could do. Different
 * lifetime, different store — the choice is per-purpose, not per-app.
 *
 * ---------------------------------------------------------------------------
 * THE QUOTA IS A REAL FAILURE MODE, NOT A THEORETICAL ONE
 * ---------------------------------------------------------------------------
 *
 * A sketch is stored as a PNG data URL, and a few detailed drawings across a
 * few courses genuinely approach the ~5MB `localStorage` ceiling. Exceeding it
 * throws `QuotaExceededError` on write — and a notepad that silently fails to
 * save is worse than one that refuses to open. So every write reports back
 * whether it succeeded, and the UI says so out loud.
 *
 * Reads are equally defensive. This data survives deploys, so a build that
 * changes the shape will meet the OLD shape in a returning learner's browser.
 * Anything unparseable degrades to an empty notebook rather than throwing
 * during render, which would take the whole page down over a stray character.
 */

const PREFIX = 'edunext:notes:';

export const EMPTY_NOTE = { markdown: '', drawing: null, updatedAt: null };

const keyFor = (courseId) => `${PREFIX}${courseId}`;

export function loadNote(courseId) {
  if (!courseId) return EMPTY_NOTE;
  try {
    const raw = window.localStorage.getItem(keyFor(courseId));
    if (!raw) return EMPTY_NOTE;
    const parsed = JSON.parse(raw);
    return {
      markdown: typeof parsed?.markdown === 'string' ? parsed.markdown : '',
      // A drawing must be a data URL or absent. Anything else — a string from
      // an older shape, a URL pointing elsewhere — is dropped rather than fed
      // to an <img src>, which is the one place this data could reach the
      // network.
      drawing:
        typeof parsed?.drawing === 'string' && parsed.drawing.startsWith('data:image/')
          ? parsed.drawing
          : null,
      updatedAt: typeof parsed?.updatedAt === 'string' ? parsed.updatedAt : null,
    };
  } catch {
    return EMPTY_NOTE;
  }
}

/**
 * @returns {{ ok: true, updatedAt: string } | { ok: false, reason: 'quota' | 'unavailable' }}
 */
export function saveNote(courseId, note) {
  if (!courseId) return { ok: false, reason: 'unavailable' };
  const updatedAt = new Date().toISOString();
  try {
    window.localStorage.setItem(
      keyFor(courseId),
      JSON.stringify({ markdown: note.markdown, drawing: note.drawing, updatedAt }),
    );
    return { ok: true, updatedAt };
  } catch (error) {
    /*
     * Two different failures wearing one exception. A quota error means the
     * note is too big and the learner can act on it — delete the sketch, shorten
     * the text. Private browsing or a blocked origin means storage is simply
     * unavailable and nothing they do will help. Telling them apart is the
     * difference between actionable advice and a shrug.
     */
    const quota =
      error?.name === 'QuotaExceededError' ||
      error?.name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
      error?.code === 22;
    return { ok: false, reason: quota ? 'quota' : 'unavailable' };
  }
}

export function clearNote(courseId) {
  try {
    window.localStorage.removeItem(keyFor(courseId));
  } catch {
    // Nothing to do: if it cannot be removed it was almost certainly never
    // written either.
  }
}

/**
 * Hand the learner a file.
 *
 * The object URL is revoked on the next frame rather than immediately: the
 * click has to be dispatched and the download started first, and revoking in
 * the same tick cancels it in some browsers. `requestAnimationFrame` is the
 * smallest wait that reliably comes after.
 */
export function downloadFile(filename, blob) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  requestAnimationFrame(() => URL.revokeObjectURL(url));
}

/**
 * A filename that survives a real file system.
 *
 * Arabic course titles are fine in a filename; `/`, `\` and `:` are not, and a
 * trailing dot makes a file Windows refuses to create. This keeps the Arabic
 * and removes only what actually breaks.
 */
export function safeFilename(base, extension) {
  const cleaned = base
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\.+$/, '');
  return `${cleaned || 'note'}.${extension}`;
}
