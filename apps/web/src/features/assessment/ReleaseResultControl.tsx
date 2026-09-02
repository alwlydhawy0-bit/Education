import { useState } from 'react';
import { useLocale } from '../../app/LocaleProvider.tsx';
import { releaseResult } from './api.ts';

/**
 * The teacher's release control.
 *
 * RENDERING THIS IS NOT AUTHORIZATION, and nothing here pretends otherwise.
 * Whether the actor may release is decided by the policy engine and again by
 * the RLS release policy; a learner who renders this component by any means
 * gets a 403 from the server. It is a convenience for the person who already
 * has the authority, not a gate on the person who does not — which is why there
 * is no role check in this file to be bypassed.
 *
 * The comment is per-learner feedback and travels with the release. The server
 * caps it at 2000 characters and refuses anything else in the body.
 */
export function ReleaseResultControl({
  attemptId,
  onReleased,
}: {
  attemptId: string;
  onReleased?: () => void;
}): JSX.Element {
  const { t } = useLocale();
  const [comment, setComment] = useState('');
  const [state, setState] = useState<'idle' | 'sending' | 'done' | 'failed'>('idle');

  const submit = (): void => {
    setState('sending');
    releaseResult(attemptId, comment)
      .then(() => {
        setState('done');
        onReleased?.();
      })
      .catch(() => setState('failed'));
  };

  if (state === 'done') return <p data-testid="release-done">{t('release.done')}</p>;

  return (
    <div data-testid="release-control">
      <label htmlFor={`release-comment-${attemptId}`}>{t('release.comment')}</label>
      <textarea
        id={`release-comment-${attemptId}`}
        value={comment}
        maxLength={2000}
        onChange={(event) => setComment(event.target.value)}
      />
      <button type="button" onClick={submit} disabled={state === 'sending'}>
        {state === 'sending' ? t('release.pending') : t('release.action')}
      </button>
      {state === 'failed' && <p data-testid="release-failed">{t('release.failed')}</p>}
    </div>
  );
}
