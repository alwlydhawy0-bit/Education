import { useState } from 'react';
import { Check, FileText, X } from 'lucide-react';

/**
 * One multiple-choice question, answered in place.
 *
 * ---------------------------------------------------------------------------
 * THE ANSWER IS REVEALED BY CHOOSING, NOT BY A "SHOW ANSWER" BUTTON
 * ---------------------------------------------------------------------------
 *
 * A reveal button lets a learner read the answer without committing to one,
 * which is the single fastest way to feel like you studied without having
 * studied. Requiring a choice first costs nothing and makes the retrieval
 * actually happen. The explanation then appears regardless of whether they were
 * right, because the reasoning is the part worth reading either way.
 *
 * ---------------------------------------------------------------------------
 * CORRECTNESS IS NOT COMMUNICATED BY COLOUR ALONE
 * ---------------------------------------------------------------------------
 *
 * Green-good / red-bad is invisible to a red-green colour-blind reader and to
 * anyone using a screen reader. Each answered option therefore carries an ICON
 * and, in the accessible name, the words "إجابة صحيحة" / "إجابة خاطئة". The
 * colour is the third signal, not the only one.
 *
 * Options are `<button>`s inside a group rather than radio inputs: they are
 * one-shot actions that lock afterwards, not a form field to be changed and
 * submitted. `aria-disabled` rather than `disabled` keeps the chosen answer
 * reachable by a screen reader reviewing what happened.
 */
export default function QuizCard({ question, index, total }) {
  const [chosen, setChosen] = useState(null);
  const answered = chosen !== null;
  const correct = chosen === question.answerIndex;

  return (
    <li className="rounded-2xl border border-accent-subtle bg-surface p-4">
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <p className="text-[11px] font-medium text-text-muted">
          سؤال <span className="tabular-nums">{index + 1}</span> من{' '}
          <span className="tabular-nums">{total}</span>
        </p>
        {answered ? (
          <p className={`text-[11px] font-medium ${correct ? 'text-primary' : 'text-danger'}`}>
            {correct ? 'إجابة صحيحة' : 'إجابة خاطئة'}
          </p>
        ) : null}
      </div>

      <p className="text-sm leading-relaxed text-text-main">{question.question}</p>

      <ul role="group" aria-label="الخيارات" className="mt-3 space-y-1.5">
        {question.options.map((option, optionIndex) => {
          const isAnswer = optionIndex === question.answerIndex;
          const isChosen = optionIndex === chosen;
          const state = !answered ? 'idle' : isAnswer ? 'correct' : isChosen ? 'wrong' : 'muted';

          return (
            <li key={option}>
              <button
                type="button"
                onClick={() => !answered && setChosen(optionIndex)}
                aria-disabled={answered}
                /*
                 * The accessible name carries the verdict, so a screen-reader
                 * user hears "خيار ٢، تحليل البيانات، إجابة صحيحة" rather than
                 * just the option text with a colour they cannot perceive.
                 */
                aria-label={
                  answered
                    ? `${option} — ${isAnswer ? 'إجابة صحيحة' : isChosen ? 'إجابة خاطئة' : 'غير مختار'}`
                    : option
                }
                className={[
                  'flex w-full items-center gap-2.5 rounded-xl border px-3 py-2.5 text-start text-xs transition-colors duration-200',
                  state === 'idle'
                    ? 'border-accent-subtle bg-canvas text-text-main hover:border-primary hover:bg-primary-light'
                    : state === 'correct'
                      ? 'border-primary bg-primary-light text-text-main'
                      : state === 'wrong'
                        ? 'border-danger-border bg-surface-alt text-text-main'
                        : 'border-accent-subtle bg-canvas text-text-muted',
                ].join(' ')}
              >
                <span className="min-w-0 flex-1">{option}</span>
                {answered && isAnswer ? (
                  <Check className="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden="true" />
                ) : null}
                {answered && isChosen && !isAnswer ? (
                  <X className="h-3.5 w-3.5 shrink-0 text-danger" aria-hidden="true" />
                ) : null}
              </button>
            </li>
          );
        })}
      </ul>

      {answered ? (
        <div className="mt-3 rounded-xl border-s-2 border-accent-lavender bg-surface-alt/60 px-3 py-2.5">
          <p className="text-[11px] leading-relaxed text-text-main">{question.explanation}</p>
          {question.source ? (
            <p className="mt-1.5 flex items-center gap-1 text-[10px] text-text-muted">
              <FileText className="h-3 w-3 shrink-0" aria-hidden="true" />
              <span className="truncate">{question.source}</span>
            </p>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}
