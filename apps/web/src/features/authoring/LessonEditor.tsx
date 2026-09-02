import { useCallback, useEffect, useState } from 'react';
import type { ContentStatus } from '@edu/contracts';
import { useLocale } from '../../app/LocaleProvider.tsx';
import {
  archiveLesson,
  classifyFailure,
  fetchLesson,
  publishLesson,
  updateLesson,
  type LessonDetailResponse,
} from './api.ts';
import type { MessageKey } from '../../shared/i18n/messages.ts';

/**
 * Draft a lesson, publish it, archive it.
 *
 * The minimum authoring surface this task needs, not a CMS. There is no tree
 * browser, no media library and no rich-text editor — those are product
 * decisions nobody has made, and inventing them here would be the redesign the
 * task rules out.
 *
 * NOTHING HERE DECIDES WHAT IS PERMITTED. The buttons are drawn from
 * `lesson.permissions`, which the SERVER computed with the same policy engine
 * that will decide the write — so there is one rule, not a copy of it that can
 * drift. An author who re-enables a control in devtools gets the same 403 or
 * 409 they would have got anyway; hiding it was a courtesy, never a boundary.
 *
 * NOTHING IS ASSUMED TO HAVE SUCCEEDED. Every mutation replaces the whole local
 * state from the response body — status, permissions and concurrency token
 * together. There is no optimistic transition, so a refused publish cannot
 * leave the screen claiming the lesson is live.
 *
 * STALE STATE CANNOT OVERWRITE FRESH. Every write carries the `updatedAt` this
 * editor last saw. If anybody — another author, another tab, this author's own
 * second window — has written since, the server refuses and this shows the
 * reload prompt instead of destroying their work.
 *
 * OBJECTIVES ARE SENT ONLY WHEN THEY CHANGED, and that is load-bearing rather
 * than an optimization. The API replaces the objective list wholesale and
 * refuses the replacement on a published lesson, so including an unchanged list
 * in a title-only edit would turn a legal edit into a 409.
 *
 * ACCESSIBILITY. Every field has a real `<label>` bound by id. The status is a
 * word, never a colour. A failure is announced in an `aria-live` region so it
 * reaches a screen reader without the author hunting for it. Direction comes
 * from the document, which `LocaleProvider` sets, so there are no left/right
 * assumptions in this file.
 */
const STATUS_LABEL = {
  draft: 'authoring.status.draft',
  published: 'authoring.status.published',
  archived: 'authoring.status.archived',
} as const satisfies Record<ContentStatus, MessageKey>;

const linesToObjectives = (text: string): string[] =>
  text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');

/** A message to show, plus whether the author needs a reload button with it. */
interface Notice {
  readonly text: string;
  readonly stale: boolean;
}

export function LessonEditor({ lessonId }: { lessonId: string }): JSX.Element {
  const { t } = useLocale();
  const [lesson, setLesson] = useState<LessonDetailResponse | null>(null);
  const [failed, setFailed] = useState(false);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [objectivesText, setObjectivesText] = useState('');
  const [busy, setBusy] = useState<'saving' | 'publishing' | 'archiving' | 'reloading' | null>(
    null,
  );
  const [notice, setNotice] = useState<Notice | null>(null);

  const load = useCallback((next: LessonDetailResponse): void => {
    setLesson(next);
    setTitle(next.title);
    setBody(next.contentBody);
    setObjectivesText(next.objectives.join('\n'));
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setLesson(null);
    setFailed(false);
    setNotice(null);
    fetchLesson(lessonId, controller.signal)
      .then(load)
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true);
      });
    return () => controller.abort();
  }, [lessonId, load]);

  /**
   * One notice per failure kind.
   *
   * Only a lifecycle refusal shows the server's text; the rest map to fixed
   * messages, because a client that reported the difference between "no such
   * lesson" and "not yours" would be the existence oracle the API refuses to be.
   */
  const report = (error: unknown): void => {
    const failure = classifyFailure(error);
    if (failure.kind === 'lifecycle') return setNotice({ text: failure.reason, stale: false });
    if (failure.kind === 'stale') return setNotice({ text: t('authoring.stale'), stale: true });
    if (failure.kind === 'forbidden')
      return setNotice({ text: t('authoring.forbidden'), stale: false });
    if (failure.kind === 'invalid')
      return setNotice({ text: t('authoring.invalid'), stale: false });
    return setNotice({ text: t('authoring.failed'), stale: false });
  };

  const run = (
    kind: NonNullable<typeof busy>,
    action: () => Promise<LessonDetailResponse>,
  ): void => {
    setBusy(kind);
    setNotice(null);
    action()
      .then((next) => {
        load(next);
        if (kind === 'saving') setNotice({ text: t('authoring.saved'), stale: false });
        if (kind === 'reloading') setNotice({ text: t('authoring.reloaded'), stale: false });
      })
      .catch(report)
      .finally(() => setBusy(null));
  };

  if (failed) return <p data-testid="authoring-error">{t('authoring.unavailable')}</p>;
  if (lesson === null) return <p data-testid="authoring-loading">{t('authoring.loading')}</p>;

  const isDraft = lesson.status === 'draft';
  const { permissions } = lesson;
  const objectivesChanged =
    linesToObjectives(objectivesText).join('\n') !== lesson.objectives.join('\n');
  // Objectives are frozen once a lesson leaves draft, by a database trigger.
  // The field mirrors that; it does not decide it.
  const objectivesEditable = isDraft && permissions.update;

  return (
    <section data-testid="lesson-editor">
      <h2>
        {lesson.title}{' '}
        <span data-status={lesson.status} data-testid="lesson-status">
          {t(STATUS_LABEL[lesson.status])}
        </span>
      </h2>

      {!permissions.update && <p data-testid="read-only-notice">{t('authoring.readOnly')}</p>}

      <p>
        <label htmlFor="authoring-title">{t('authoring.title')}</label>
        <input
          id="authoring-title"
          value={title}
          disabled={!permissions.update}
          onChange={(event) => setTitle(event.target.value)}
        />
      </p>

      <p>
        <label htmlFor="authoring-body">{t('authoring.body')}</label>
        <textarea
          id="authoring-body"
          value={body}
          rows={8}
          disabled={!permissions.update}
          onChange={(event) => setBody(event.target.value)}
        />
      </p>

      <p>
        <label htmlFor="authoring-objectives">{t('authoring.objectives')}</label>
        <textarea
          id="authoring-objectives"
          value={objectivesText}
          rows={4}
          disabled={!objectivesEditable}
          aria-describedby={isDraft ? undefined : 'authoring-objectives-locked'}
          onChange={(event) => setObjectivesText(event.target.value)}
        />
        {!isDraft && (
          <small id="authoring-objectives-locked" data-testid="objectives-locked">
            {t('authoring.objectivesLocked')}
          </small>
        )}
      </p>

      {permissions.update && (
        <button
          type="button"
          data-testid="authoring-save"
          disabled={busy !== null}
          onClick={() =>
            run('saving', () =>
              updateLesson(lessonId, {
                title,
                contentBody: body,
                // Only when it actually moved — see the note at the top.
                ...(objectivesEditable && objectivesChanged
                  ? { objectives: linesToObjectives(objectivesText) }
                  : {}),
                // The version this form was filled in against.
                expectedUpdatedAt: lesson.updatedAt,
              }),
            )
          }
        >
          {busy === 'saving' ? t('authoring.saving') : t('authoring.save')}
        </button>
      )}

      {/*
        Drawn only when the SERVER said this actor may publish this lesson in
        its current state. `isDraft` is not re-checked here: the server's answer
        already accounts for status, and re-deriving it would be the second copy
        of the rule this component exists to avoid.
      */}
      {permissions.publish && (
        <button
          type="button"
          data-testid="authoring-publish"
          disabled={busy !== null}
          onClick={() => run('publishing', () => publishLesson(lessonId, lesson.updatedAt))}
        >
          {busy === 'publishing' ? t('authoring.publishing') : t('authoring.publish')}
        </button>
      )}

      {/*
        Archiving retires this lesson's published activities in the same
        transaction — the cascade lives in the API, and the warning below says
        so rather than the button pretending the act is local.
      */}
      {permissions.archive && (
        <button
          type="button"
          data-testid="authoring-archive"
          disabled={busy !== null}
          onClick={() => run('archiving', () => archiveLesson(lessonId, lesson.updatedAt))}
        >
          {busy === 'archiving' ? t('authoring.archiving') : t('authoring.archive')}
        </button>
      )}

      {permissions.archive && <small>{t('authoring.archiveCascade')}</small>}

      {/*
        Announced rather than merely drawn. A publish refusal is the one message
        in this component an author must not miss, and it arrives after a click
        rather than on load.
      */}
      <p role="status" aria-live="polite" data-testid="authoring-notice">
        {notice?.text}
      </p>

      {/*
        Offered ONLY after a stale write, and it discards nothing silently: it
        replaces the form with the server's current version, which is the only
        honest way out of a conflict this client cannot merge.
      */}
      {notice?.stale === true && (
        <button
          type="button"
          data-testid="authoring-reload"
          disabled={busy !== null}
          onClick={() => run('reloading', () => fetchLesson(lessonId))}
        >
          {busy === 'reloading' ? t('authoring.reloading') : t('authoring.reload')}
        </button>
      )}
    </section>
  );
}
