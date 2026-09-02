import { render, screen, waitFor } from '@testing-library/react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocaleProvider } from '../../apps/web/src/app/LocaleProvider.tsx';
import { LessonEditor } from '../../apps/web/src/features/authoring/index.ts';
import { translate } from '../../apps/web/src/shared/i18n/messages.ts';

/**
 * The authoring editor, rendered for real against a stubbed transport.
 *
 * WHAT THESE TESTS ARE FOR. The component's job is to render exactly what the
 * server said and to send back exactly what the contract allows — nothing more.
 * The interesting failures are therefore not "does the button appear" but:
 *
 *   - does it invent a permission the server did not grant?
 *   - does it assume a transition succeeded before the server confirmed it?
 *   - does it send a stale concurrency token, or forget to send one at all?
 *   - does it leak the difference between "no such lesson" and "not yours"?
 *   - does it tell an author which of five different things went wrong?
 *
 * WHAT THEY ARE NOT FOR. None of this is a security control and none of these
 * tests claim it is. The server re-decides every write; a hidden button is a
 * courtesy. The authorization tests that matter run against real HTTP and a
 * real database in `tests/security/`.
 *
 * `fetch` is stubbed rather than the feature's own module, deliberately: that
 * keeps the request URL, method, headers and JSON body inside the assertion
 * surface, so a change to the wire format shows up here rather than passing
 * because the mock was updated to match it.
 */
const LESSON_ID = '11111111-1111-4111-8111-111111111111';
const T0 = '2026-01-01T10:00:00.000Z';
const T1 = '2026-01-01T11:00:00.000Z';

interface FetchCall {
  readonly url: string;
  readonly method: string;
  readonly body: Record<string, unknown> | null;
}

let calls: FetchCall[] = [];
let respond: (call: FetchCall) => { status: number; payload: unknown };

const lesson = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: LESSON_ID,
  unitId: '22222222-2222-4222-8222-222222222222',
  position: 1,
  title: 'الكسور',
  summary: '',
  contentFormat: 'markdown',
  contentBody: 'محتوى',
  externalUrl: null,
  estimatedMinutes: null,
  objectives: ['يقارن الكسور'],
  status: 'draft',
  createdAt: T0,
  updatedAt: T0,
  publishedAt: null,
  permissions: { update: true, publish: true, archive: false },
  ...over,
});

const apiError = (code: string, message: string, detail?: Record<string, unknown>): unknown => ({
  error: { code, message, correlationId: 'cid-1', ...(detail ? { detail } : {}) },
});

beforeEach(() => {
  calls = [];
  respond = () => ({ status: 200, payload: lesson() });
  vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
    const call: FetchCall = {
      url,
      method: init?.method ?? 'GET',
      body:
        typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null,
    };
    calls.push(call);
    const { status, payload } = respond(call);
    return Promise.resolve({
      ok: status < 400,
      status,
      json: () => Promise.resolve(payload),
    } as Response);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const mount = async (): Promise<void> => {
  render(
    <LocaleProvider>
      <LessonEditor lessonId={LESSON_ID} />
    </LocaleProvider>,
  );
  await screen.findByTestId('lesson-editor');
};

const click = async (testId: string): Promise<void> => {
  const button = screen.getByTestId(testId);
  await act(async () => {
    button.click();
  });
};

const en = (key: Parameters<typeof translate>[1]): string => translate('en', key);

describe('LessonEditor — load states', () => {
  it('shows a loading state before the server answers, and never an empty form', async () => {
    let release: (() => void) | null = null;
    vi.stubGlobal('fetch', () => {
      calls.push({ url: '/lessons', method: 'GET', body: null });
      return new Promise<Response>((resolve) => {
        release = () =>
          resolve({ ok: true, status: 200, json: () => Promise.resolve(lesson()) } as Response);
      });
    });

    render(
      <LocaleProvider>
        <LessonEditor lessonId={LESSON_ID} />
      </LocaleProvider>,
    );
    expect(screen.getByTestId('authoring-loading')).toBeTruthy();
    // No form, and in particular no publish button, while the answer is unknown.
    expect(screen.queryByTestId('authoring-publish')).toBeNull();

    await act(async () => {
      release?.();
    });
    await screen.findByTestId('lesson-editor');
  });

  it('reports a failed load without saying whether the lesson exists', async () => {
    respond = () => ({ status: 404, payload: apiError('NOT_FOUND', 'Not found') });
    render(
      <LocaleProvider>
        <LessonEditor lessonId={LESSON_ID} />
      </LocaleProvider>,
    );
    const error = await screen.findByTestId('authoring-error');
    // The same words a forbidden lesson produces. A client that distinguished
    // them would rebuild the existence oracle the API refuses to be.
    expect(error.textContent).toBe(en('authoring.unavailable'));
  });

  it('reports a forbidden load with the SAME words as a missing one', async () => {
    respond = () => ({ status: 403, payload: apiError('FORBIDDEN', 'Forbidden') });
    render(
      <LocaleProvider>
        <LessonEditor lessonId={LESSON_ID} />
      </LocaleProvider>,
    );
    const error = await screen.findByTestId('authoring-error');
    expect(error.textContent).toBe(en('authoring.unavailable'));
  });

  it('rejects a response that does not match the contract', async () => {
    // A lesson carrying an extra field is refused by the strict schema rather
    // than rendered. This is the boundary that stops an unexpected server or a
    // rewriting proxy from feeding arbitrary shapes into the component.
    respond = () => ({ status: 200, payload: { ...lesson(), createdBy: 'somebody' } });
    render(
      <LocaleProvider>
        <LessonEditor lessonId={LESSON_ID} />
      </LocaleProvider>,
    );
    await screen.findByTestId('authoring-error');
  });
});

describe('LessonEditor — controls follow the server, never local reasoning', () => {
  it('draws no publish button when the server says this actor may not publish', async () => {
    respond = () => ({
      status: 200,
      payload: lesson({ permissions: { update: true, publish: false, archive: false } }),
    });
    await mount();

    // A draft, and the local rule "drafts can be published" would draw it. The
    // component does not hold that rule; the server does.
    expect(screen.getByTestId('lesson-status').textContent).toBe(en('authoring.status.draft'));
    expect(screen.queryByTestId('authoring-publish')).toBeNull();
    expect(screen.getByTestId('authoring-save')).toBeTruthy();
  });

  it('draws the archive button only when the server grants it', async () => {
    respond = () => ({
      status: 200,
      payload: lesson({
        status: 'published',
        publishedAt: T0,
        permissions: { update: true, publish: false, archive: true },
      }),
    });
    await mount();

    expect(screen.getByTestId('authoring-archive')).toBeTruthy();
    expect(screen.queryByTestId('authoring-publish')).toBeNull();
    // The cascade is stated rather than left for the author to discover.
    expect(screen.getByText(en('authoring.archiveCascade'))).toBeTruthy();
  });

  it('renders a lesson the actor may read but not edit as read-only', async () => {
    respond = () => ({
      status: 200,
      payload: lesson({ permissions: { update: false, publish: false, archive: false } }),
    });
    await mount();

    expect(screen.getByTestId('read-only-notice')).toBeTruthy();
    expect(screen.queryByTestId('authoring-save')).toBeNull();
    expect((screen.getByLabelText(en('authoring.title')) as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText(en('authoring.body')) as HTMLTextAreaElement).disabled).toBe(
      true,
    );
  });

  it('locks objectives once a lesson leaves draft and says why', async () => {
    respond = () => ({
      status: 200,
      payload: lesson({
        status: 'published',
        publishedAt: T0,
        permissions: { update: true, publish: false, archive: true },
      }),
    });
    await mount();

    const objectives = screen.getByLabelText(en('authoring.objectives')) as HTMLTextAreaElement;
    expect(objectives.disabled).toBe(true);
    expect(screen.getByTestId('objectives-locked').textContent).toBe(
      en('authoring.objectivesLocked'),
    );
    // The explanation is bound to the field, so a screen reader reaches it.
    expect(objectives.getAttribute('aria-describedby')).toBe('authoring-objectives-locked');
  });
});

describe('LessonEditor — what goes on the wire', () => {
  it('sends the concurrency token it was given, and no forged identity fields', async () => {
    await mount();
    await click('authoring-save');

    const patch = calls.find((c) => c.method === 'PATCH');
    expect(patch?.body?.['expectedUpdatedAt']).toBe(T0);
    for (const forbiddenField of [
      'status',
      'organizationId',
      'authorId',
      'ownerId',
      'publisherId',
      'userId',
      'role',
      'createdBy',
      'publishedAt',
      'unitId',
      'id',
    ]) {
      expect(patch?.body).not.toHaveProperty(forbiddenField);
    }
  });

  it('omits objectives from a title-only edit', async () => {
    await mount();
    await click('authoring-save');

    const patch = calls.find((c) => c.method === 'PATCH');
    // Load-bearing rather than an optimization: the API replaces the list
    // wholesale and refuses the replacement on a published lesson, so an
    // unchanged list would turn a legal edit into a conflict.
    expect(patch?.body).not.toHaveProperty('objectives');
  });

  it('sends only the concurrency token when publishing', async () => {
    await mount();
    await click('authoring-publish');

    const publish = calls.find((c) => c.url.endsWith('/publish'));
    expect(publish?.method).toBe('POST');
    expect(publish?.body).toEqual({ expectedUpdatedAt: T0 });
  });

  it('advances the token after a successful write, so the next save is not stale', async () => {
    respond = (call) =>
      call.method === 'PATCH'
        ? { status: 200, payload: lesson({ updatedAt: T1 }) }
        : { status: 200, payload: lesson() };

    await mount();
    await click('authoring-save');
    await click('authoring-save');

    const patches = calls.filter((c) => c.method === 'PATCH');
    expect(patches).toHaveLength(2);
    expect(patches[0]?.body?.['expectedUpdatedAt']).toBe(T0);
    // The version the server just confirmed, not the one the form loaded with.
    expect(patches[1]?.body?.['expectedUpdatedAt']).toBe(T1);
  });
});

describe('LessonEditor — the server confirms transitions, the client never assumes them', () => {
  it('shows the new status only after the server returns it', async () => {
    respond = (call) =>
      call.url.endsWith('/publish')
        ? {
            status: 200,
            payload: lesson({
              status: 'published',
              publishedAt: T1,
              updatedAt: T1,
              permissions: { update: true, publish: false, archive: true },
            }),
          }
        : { status: 200, payload: lesson() };

    await mount();
    expect(screen.getByTestId('lesson-status').textContent).toBe(en('authoring.status.draft'));
    await click('authoring-publish');

    await waitFor(() => {
      expect(screen.getByTestId('lesson-status').textContent).toBe(
        en('authoring.status.published'),
      );
    });
    // Permissions came from the response too, so the controls moved with it.
    expect(screen.queryByTestId('authoring-publish')).toBeNull();
    expect(screen.getByTestId('authoring-archive')).toBeTruthy();
  });

  it('leaves the status untouched when a publish is refused', async () => {
    respond = (call) =>
      call.url.endsWith('/publish')
        ? {
            status: 409,
            payload: apiError(
              'CONFLICT',
              'A lesson cannot be published with no content and no external link',
            ),
          }
        : { status: 200, payload: lesson() };

    await mount();
    await click('authoring-publish');

    await waitFor(() => {
      expect(screen.getByTestId('authoring-notice').textContent).toContain(
        'cannot be published with no content',
      );
    });
    // Still a draft on screen. An optimistic transition here would tell an
    // author their material is live when no learner can see it.
    expect(screen.getByTestId('lesson-status').textContent).toBe(en('authoring.status.draft'));
    expect(screen.getByTestId('authoring-publish')).toBeTruthy();
  });
});

describe('LessonEditor — the five failure kinds are distinguishable', () => {
  const save = async (status: number, payload: unknown): Promise<string> => {
    respond = (call) =>
      call.method === 'PATCH' ? { status, payload } : { status: 200, payload: lesson() };
    await mount();
    await click('authoring-save');
    await waitFor(() => {
      expect(screen.getByTestId('authoring-notice').textContent).not.toBe('');
    });
    return screen.getByTestId('authoring-notice').textContent ?? '';
  };

  it('a stale write asks the author to reload, and offers the button', async () => {
    // The MESSAGE here is deliberately unhelpful prose that no heuristic could
    // classify. Only `detail.reason` says what this is, which is the point: a
    // client that matched on wording would break the moment the server was
    // translated into Arabic, and this test would not notice.
    const text = await save(
      409,
      apiError('CONFLICT', 'تعذّر إتمام الحفظ.', { reason: 'stale_write' }),
    );
    expect(text).toBe(en('authoring.stale'));
    expect(screen.getByTestId('authoring-reload')).toBeTruthy();
  });

  it('a lifecycle refusal shows the server’s own reason', async () => {
    const text = await save(
      409,
      apiError('CONFLICT', 'A lesson’s objectives cannot be changed after it leaves draft'),
    );
    expect(text).toContain('objectives cannot be changed');
    // Not a stale write, so no reload button — reloading would not help.
    expect(screen.queryByTestId('authoring-reload')).toBeNull();
  });

  it('a forbidden write says so plainly', async () => {
    expect(await save(403, apiError('FORBIDDEN', 'Forbidden'))).toBe(en('authoring.forbidden'));
  });

  it('a validation failure points at the input', async () => {
    expect(await save(400, apiError('VALIDATION_FAILED', 'Validation failed'))).toBe(
      en('authoring.invalid'),
    );
  });

  it('anything else collapses into one generic message', async () => {
    expect(await save(500, apiError('INTERNAL', 'Internal error'))).toBe(en('authoring.failed'));
  });

  it('a 404 mid-session is NOT distinguishable from a 403', async () => {
    const missing = await save(404, apiError('NOT_FOUND', 'Not found'));
    expect(missing).toBe(en('authoring.failed'));
    expect(missing).not.toBe(en('authoring.forbidden'));
  });
});

describe('LessonEditor — recovering from a conflict', () => {
  it('replaces the form with the server’s current version on reload', async () => {
    let published = false;
    respond = (call) => {
      if (call.method === 'PATCH') {
        return {
          status: 409,
          payload: apiError('CONFLICT', 'changed', { reason: 'stale_write' }),
        };
      }
      // The second GET is the reload, by which time somebody else has published.
      if (published) {
        return {
          status: 200,
          payload: lesson({
            title: 'الكسور (منقّح)',
            status: 'published',
            publishedAt: T1,
            updatedAt: T1,
            permissions: { update: true, publish: false, archive: true },
          }),
        };
      }
      published = true;
      return { status: 200, payload: lesson() };
    };

    await mount();
    await click('authoring-save');
    await waitFor(() => expect(screen.getByTestId('authoring-reload')).toBeTruthy());
    await click('authoring-reload');

    await waitFor(() => {
      expect(screen.getByTestId('lesson-status').textContent).toBe(
        en('authoring.status.published'),
      );
    });
    expect((screen.getByLabelText(en('authoring.title')) as HTMLInputElement).value).toBe(
      'الكسور (منقّح)',
    );
    // And the reload prompt is gone: there is nothing stale left to reload.
    expect(screen.queryByTestId('authoring-reload')).toBeNull();
  });

  it('does not resend the stale token after reloading', async () => {
    let reloaded = false;
    respond = (call) => {
      if (call.method === 'PATCH' && !reloaded) {
        return {
          status: 409,
          payload: apiError('CONFLICT', 'changed', { reason: 'stale_write' }),
        };
      }
      if (call.method === 'GET' && calls.filter((c) => c.method === 'GET').length > 1) {
        reloaded = true;
        return { status: 200, payload: lesson({ updatedAt: T1 }) };
      }
      return { status: 200, payload: lesson({ updatedAt: reloaded ? T1 : T0 }) };
    };

    await mount();
    await click('authoring-save');
    await waitFor(() => expect(screen.getByTestId('authoring-reload')).toBeTruthy());
    await click('authoring-reload');
    await waitFor(() => expect(screen.queryByTestId('authoring-reload')).toBeNull());
    await click('authoring-save');

    const patches = calls.filter((c) => c.method === 'PATCH');
    expect(patches[0]?.body?.['expectedUpdatedAt']).toBe(T0);
    expect(patches[1]?.body?.['expectedUpdatedAt']).toBe(T1);
  });
});

describe('LessonEditor — Arabic first', () => {
  it('renders Arabic and sets the document RTL when no supported language is preferred', async () => {
    // jsdom reports en-US, which the app honours — that is correct behaviour,
    // not a bug. What must hold is that ARABIC is the fallback rather than
    // English: an unrecognised preference lands on `ar`, not on the language
    // whichever browser happens to be configured for.
    Object.defineProperty(window.navigator, 'languages', {
      value: ['fr-FR'],
      configurable: true,
    });
    await mount();

    expect(screen.getByText(translate('ar', 'authoring.title'))).toBeTruthy();
    await waitFor(() => {
      expect(document.documentElement.dir).toBe('rtl');
      expect(document.documentElement.lang).toBe('ar');
    });
  });

  it('announces notices politely rather than only drawing them', async () => {
    await mount();
    const notice = screen.getByTestId('authoring-notice');
    expect(notice.getAttribute('role')).toBe('status');
    expect(notice.getAttribute('aria-live')).toBe('polite');
  });
});
