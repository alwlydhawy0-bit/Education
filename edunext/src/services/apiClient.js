/**
 * The single place this app talks to the network.
 *
 * It exists at setup time so that the first screen that needs data has somewhere
 * to put the call, rather than reaching for `fetch` inline — which is how a
 * codebase ends up with five different error shapes and no consistent place to
 * attach auth or a timeout.
 *
 * WHY THE ERROR MESSAGES ARE ARABIC AND LIVE HERE.
 * A failed request is UI text: it ends up in a toast or an empty state in front
 * of a learner. Returning `err.message` from `fetch` would put "Failed to
 * fetch" — English, and meaningless to the reader — on the screen. So the
 * boundary translates once, and every caller gets a message it can render.
 */

const BASE_URL = import.meta.env.VITE_API_BASE_URL ?? '/api/v1';
const DEFAULT_TIMEOUT_MS = 15000;

/** A failure a component can render as-is. `message` is always Arabic. */
export class ApiError extends Error {
  constructor(message, { status = 0, code = 'unknown' } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

/**
 * Status codes get a message the reader can act on, not a restatement of the
 * number. "غير مصرّح" tells a learner nothing; "انتهت جلستك" tells them to sign
 * in again.
 */
function messageForStatus(status) {
  if (status === 401) return 'انتهت جلستك. يُرجى تسجيل الدخول من جديد.';
  if (status === 403) return 'لا تملك صلاحية الوصول إلى هذا المحتوى.';
  if (status === 404) return 'لم نعثر على ما تبحث عنه.';
  if (status === 429) return 'عدد المحاولات كبير. يُرجى الانتظار قليلًا ثم إعادة المحاولة.';
  if (status >= 500) return 'حدث خطأ في الخادم. نعمل على إصلاحه، حاول مرة أخرى بعد قليل.';
  return 'تعذّر إتمام الطلب. يُرجى المحاولة مرة أخرى.';
}

/**
 * @param {string} path      Path relative to the API base, e.g. `/courses`.
 * @param {object} [options] `method`, `body` (plain object), `signal`, `headers`.
 */
export async function request(path, { method = 'GET', body, headers, signal } = {}) {
  // A request with no ceiling holds a spinner in front of a learner forever.
  // The caller's own signal still wins if it fires first.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  signal?.addEventListener('abort', () => controller.abort(), { once: true });

  let response;
  try {
    response = await fetch(`${BASE_URL}${path}`, {
      method,
      // The session is an HttpOnly cookie: the browser attaches it and
      // JavaScript never sees it, which is what makes it unreadable to an XSS.
      credentials: 'include',
      headers: {
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: controller.signal,
    });
  } catch (error) {
    throw new ApiError(
      error?.name === 'AbortError'
        ? 'استغرق الطلب وقتًا أطول من المتوقّع. تحقّق من اتصالك ثم حاول مجددًا.'
        : 'تعذّر الاتصال بالخادم. تحقّق من اتصالك بالإنترنت.',
      { code: error?.name === 'AbortError' ? 'timeout' : 'network' },
    );
  } finally {
    clearTimeout(timeout);
  }

  if (response.status === 204) return null;

  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    // The server's own message is preferred when it sends one — it is more
    // specific than anything this layer can guess — and the status-based text
    // is the fallback, never a raw status code on screen.
    throw new ApiError(payload?.message ?? messageForStatus(response.status), {
      status: response.status,
      code: payload?.code ?? 'http_error',
    });
  }

  return payload;
}

export const apiClient = {
  get: (path, options) => request(path, { ...options, method: 'GET' }),
  post: (path, body, options) => request(path, { ...options, method: 'POST', body }),
  patch: (path, body, options) => request(path, { ...options, method: 'PATCH', body }),
  delete: (path, options) => request(path, { ...options, method: 'DELETE' }),
};

export default apiClient;
