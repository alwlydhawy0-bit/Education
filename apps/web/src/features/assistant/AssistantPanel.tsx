import { useState } from 'react';
import { useLocale } from '../../app/LocaleProvider.tsx';
import { askAssistant, type AskAssistantResponse } from './api.ts';

/**
 * The learning assistant, in its foundation form.
 *
 * ASK A QUESTION ABOUT THE LESSON YOU ARE READING, and get an answer built from
 * that lesson's own material with references you can check. That is the whole
 * feature. There is no chat history, no follow-up, no personalisation and no
 * conversation — those are later tasks, and building them here would mean
 * shipping storage and retention decisions nobody has made.
 *
 * ── THE ONE THING A READER MUST BE ABLE TO TELL ──────────────────────────────
 *
 * Whether the answer came from THEIR COURSE MATERIAL or from nowhere. The
 * server decides that (`grounding`) from whether a citation survived
 * validation, and this renders the server's answer without interpreting it. A
 * component that inferred grounding from `sources.length > 0` would be a second
 * implementation of the rule, and the copy nobody tests is the one that drifts.
 *
 * ── WHAT THIS COMPONENT DOES NOT DO ──────────────────────────────────────────
 *
 * It does not filter, redact, or re-rank anything, and it renders every answer
 * and every source the server returns. That is deliberate: hiding a bad answer
 * in the browser would mask a server defect, and the server tests would fail
 * while the interface looked correct.
 *
 * It also renders the answer as TEXT. The answer is model output derived from
 * author-written prose — the least trustworthy string in the system — and the
 * one thing this component must never do is execute it. There is no
 * `dangerouslySetInnerHTML` here and there must never be one.
 *
 * ── ACCESSIBILITY ────────────────────────────────────────────────────────────
 *
 * A real `<form>` with a real `<label>`, so Enter submits and a screen reader
 * announces the field. The answer region is `aria-live="polite"` because it
 * arrives after a submit rather than on load. Direction comes from the document,
 * which `LocaleProvider` sets, so there are no left/right assumptions here.
 */
type Phase = 'idle' | 'asking' | 'answered' | 'failed';

export function AssistantPanel({ lessonId }: { readonly lessonId: string }): JSX.Element {
  const { t } = useLocale();
  const [question, setQuestion] = useState('');
  const [phase, setPhase] = useState<Phase>('idle');
  const [result, setResult] = useState<AskAssistantResponse | null>(null);
  /** The question the last answer belongs to, so retry re-sends the same one. */
  const [asked, setAsked] = useState('');

  const send = (text: string): void => {
    const trimmed = text.trim();
    if (trimmed === '') return;
    setPhase('asking');
    setAsked(trimmed);
    setResult(null);
    askAssistant(lessonId, trimmed)
      .then((answer) => {
        setResult(answer);
        setPhase('answered');
      })
      .catch(() => {
        // ONE MESSAGE FOR EVERY FAILURE. A client that distinguished "this
        // lesson is not yours" from "this lesson does not exist" would rebuild
        // the existence oracle the server's 404 rule exists to prevent — and
        // the assistant is a particularly attractive place to probe, because a
        // 200 would summarise whatever it found.
        setPhase('failed');
      });
  };

  return (
    <section data-testid="assistant-panel">
      <h3>{t('assistant.title')}</h3>

      <form
        onSubmit={(event) => {
          event.preventDefault();
          send(question);
        }}
      >
        <label htmlFor="assistant-question">{t('assistant.questionLabel')}</label>
        <input
          id="assistant-question"
          data-testid="assistant-question"
          value={question}
          // Mirrors the contract's own cap. Not a security control — the server
          // refuses anything longer — but it stops a learner writing 900
          // characters they cannot send.
          maxLength={1000}
          disabled={phase === 'asking'}
          onChange={(event) => setQuestion(event.target.value)}
        />
        <button type="submit" data-testid="assistant-ask" disabled={phase === 'asking'}>
          {phase === 'asking' ? t('assistant.asking') : t('assistant.ask')}
        </button>
      </form>

      <div role="status" aria-live="polite" data-testid="assistant-result">
        {phase === 'asking' && <p data-testid="assistant-loading">{t('assistant.asking')}</p>}

        {phase === 'failed' && (
          <>
            <p data-testid="assistant-error">{t('assistant.failed')}</p>
            {/*
              Retry re-sends the SAME question rather than clearing the box.
              A learner who has typed a careful question should not have to
              type it again because a provider was briefly unavailable.
            */}
            <button type="button" data-testid="assistant-retry" onClick={() => send(asked)}>
              {t('assistant.retry')}
            </button>
          </>
        )}

        {phase === 'answered' && result !== null && (
          <AssistantAnswer result={result} onRetry={() => send(asked)} />
        )}
      </div>
    </section>
  );
}

function AssistantAnswer({
  result,
  onRetry,
}: {
  readonly result: AskAssistantResponse;
  readonly onRetry: () => void;
}): JSX.Element {
  const { t } = useLocale();

  // THE SERVER'S DECISION, rendered. Not re-derived from `sources.length`.
  if (result.grounding === 'unavailable') {
    return (
      <>
        <p data-testid="assistant-unavailable">{t('assistant.unavailable')}</p>
        <button type="button" data-testid="assistant-retry" onClick={onRetry}>
          {t('assistant.retry')}
        </button>
      </>
    );
  }

  if (result.grounding === 'insufficient') {
    return (
      <p data-testid="assistant-insufficient">
        {t('assistant.insufficient')}{' '}
        <small>
          {t('assistant.searched')} {result.searchedSources}
        </small>
      </p>
    );
  }

  return (
    <>
      {/*
        Labelled before it is read. A learner has to know this came from their
        own course material rather than from a model's general knowledge, and
        the label is the whole point of the grounding field.
      */}
      <p data-testid="assistant-grounded">{t('assistant.fromCourseMaterial')}</p>

      {/* Text, with the author's line breaks preserved and nothing interpreted. */}
      <p data-testid="assistant-answer" style={{ whiteSpace: 'pre-wrap' }}>
        {result.answer}
      </p>

      <section data-testid="assistant-sources">
        <h4>{t('assistant.sources')}</h4>
        <ul>
          {result.sources.map((source) => (
            <li key={source.id} data-testid="assistant-source" data-lesson={source.lessonId}>
              <strong>{source.lessonTitle}</strong>
              {/*
                The RETRIEVED text, not the model's paraphrase — so a learner
                can check the answer against the source rather than taking the
                answer's word for it.
              */}
              <blockquote>{source.excerpt}</blockquote>
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}
