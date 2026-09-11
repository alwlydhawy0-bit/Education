/**
 * The study document attached to a course: metadata, extracted text, annotations.
 *
 * ---------------------------------------------------------------------------
 * THE FILE ITSELF IS NEVER STORED, AND THAT IS THE CENTRAL DECISION
 * ---------------------------------------------------------------------------
 *
 * `localStorage` holds roughly 5MB for the entire origin — shared across every
 * course's notes, sketches and documents. A single 8MB lecture PDF does not
 * merely fail to fit; the failed write can leave the whole notebook unable to
 * save. So what persists is what a learner actually returns for: the TEXT, the
 * annotations they made on it, and enough metadata to recognise the file.
 *
 * The bytes live in memory for the session, behind an object URL, and are gone
 * on reload. That IS a limitation and the UI says so rather than letting
 * someone discover it when their preview is blank tomorrow. The real fix is
 * IndexedDB, which has no practical size ceiling and stores Blobs directly;
 * this module is the seam for it — only `loadDocument`/`saveDocument` would
 * change, and the shape they exchange would gain a `blob` field.
 *
 * ---------------------------------------------------------------------------
 * ANNOTATIONS ARE ANCHORED TO QUOTED TEXT, NOT TO OFFSETS
 * ---------------------------------------------------------------------------
 *
 * A character range into the extracted text looks tidier and breaks the moment
 * anything upstream changes — a pdf.js version that joins runs slightly
 * differently shifts every offset, and each highlight silently moves to the
 * wrong sentence. Storing the quoted excerpt means an annotation is still
 * readable even if it can no longer be located, which is the failure mode a
 * learner can live with.
 */

const PREFIX = 'edunext:doc:';

export const EMPTY_DOCUMENT = null;

const keyFor = (courseId) => `${PREFIX}${courseId}`;

/** @returns {null | {name,kind,size,pageCount,text,truncated,annotations,uploadedAt}} */
export function loadDocument(courseId) {
  if (!courseId) return null;
  try {
    const raw = window.localStorage.getItem(keyFor(courseId));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (typeof parsed?.name !== 'string') return null;
    return {
      name: parsed.name,
      kind: ['pdf', 'txt', 'image'].includes(parsed.kind) ? parsed.kind : 'txt',
      size: Number.isFinite(parsed.size) ? parsed.size : 0,
      pageCount: Number.isFinite(parsed.pageCount) ? parsed.pageCount : null,
      text: typeof parsed.text === 'string' ? parsed.text : '',
      truncated: parsed.truncated === true,
      annotations: Array.isArray(parsed.annotations)
        ? parsed.annotations.filter(
            (item) => typeof item?.id === 'string' && typeof item?.quote === 'string',
          )
        : [],
      uploadedAt: typeof parsed.uploadedAt === 'string' ? parsed.uploadedAt : null,
    };
  } catch {
    return null;
  }
}

/** @returns {{ok:true}|{ok:false,reason:'quota'|'unavailable'}} */
export function saveDocument(courseId, document) {
  if (!courseId) return { ok: false, reason: 'unavailable' };
  try {
    window.localStorage.setItem(keyFor(courseId), JSON.stringify(document));
    return { ok: true };
  } catch (error) {
    const quota =
      error?.name === 'QuotaExceededError' ||
      error?.name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
      error?.code === 22;
    return { ok: false, reason: quota ? 'quota' : 'unavailable' };
  }
}

export function clearDocument(courseId) {
  try {
    window.localStorage.removeItem(keyFor(courseId));
  } catch {
    // If it cannot be removed it was almost certainly never written.
  }
}

/** Human-readable size, in Arabic, with Western digits to match the app. */
export function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} بايت`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} كيلوبايت`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} ميغابايت`;
}
