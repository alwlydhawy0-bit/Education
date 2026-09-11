import { useCallback, useEffect, useRef, useState } from 'react';
import { BookMarked, Info, RotateCcw, Send, Sparkles, X } from 'lucide-react';
import { renderMarkdown } from '../tools/markdown.jsx';
import { PRESETS, askAssistant } from './assistant.js';

/**
 * The course assistant: a floating trigger and a slide-over conversation.
 *
 * ---------------------------------------------------------------------------
 * THE CONVERSATION IS NOT PERSISTED, AND THAT IS A DECISION
 * ---------------------------------------------------------------------------
 *
 * Notes are saved to `localStorage` because losing them would be the worst
 * thing the notebook could do. A chat log is the opposite case: it is a record
 * of what someone did not understand, it is the most revealing thing in this
 * app, and there is no server to sync it to. Writing it to a shared browser so
 * the next person can scroll through it is a cost with no matching benefit,
 * so the history lives in component state and goes when the panel closes.
 *
 * ---------------------------------------------------------------------------
 * ANSWERS ARE RENDERED THROUGH THE SAME SAFE MARKDOWN PATH AS NOTES
 * ---------------------------------------------------------------------------
 *
 * `renderMarkdown` builds React elements and never HTML. That matters more here
 * than in the notebook, not less: assistant output is the one text in this app
 * that the learner did not write, and the day it comes from a real model it
 * becomes text a THIRD PARTY can influence through the course material the
 * model was grounded in. An `innerHTML` here would be an injection path that
 * opens the moment the simulation is replaced — precisely when nobody is
 * looking at this file.
 */

const MAX_QUESTION_LENGTH = 500;

export default function AIAssistantWidget({ course }) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef(null);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-expanded={open}
        className="inline-flex h-12 items-center gap-2 rounded-full bg-surface px-5 text-sm font-medium text-primary shadow-lift ring-1 ring-accent-lavender transition-colors duration-200 hover:bg-primary-light"
      >
        <Sparkles className="h-4 w-4" aria-hidden="true" />
        <span>المساعد الذكي</span>
      </button>

      {/*
        Mounted only while open, and keyed on the course. The panel reads the
        course as its grounding context, so switching courses must start a new
        conversation rather than carry the previous one's answers across — the
        same remount-over-effect reasoning as the notebook.
      */}
      {open ? (
        <AssistantPanel
          key={course.id}
          course={course}
          onClose={() => {
            setOpen(false);
            triggerRef.current?.focus();
          }}
        />
      ) : null}
    </>
  );
}

function AssistantPanel({ course, onClose }) {
  const [messages, setMessages] = useState([]);
  const [draft, setDraft] = useState('');
  const [thinking, setThinking] = useState(false);

  const panelRef = useRef(null);
  const closeRef = useRef(null);
  const inputRef = useRef(null);
  const logRef = useRef(null);
  const abortRef = useRef(null);

  /* Escape, focus trap, and focus restore — the three things a dialog owes. */
  useEffect(() => {
    const panel = panelRef.current;
    closeRef.current?.focus();

    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = panel?.querySelectorAll(
        'button:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
      );
      if (!focusable || focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  /* Any answer still in flight is abandoned when the panel goes. */
  useEffect(() => () => abortRef.current?.abort(), []);

  /*
   * FOLLOW THE CONVERSATION, BUT DO NOT FIGHT THE READER.
   *
   * Scrolling to the bottom on every message is right until the learner scrolls
   * UP to re-read an earlier answer — at which point an arriving message yanks
   * them back down, which is the single most irritating behaviour a chat can
   * have. So it only auto-scrolls when they were already near the bottom.
   */
  useEffect(() => {
    const log = logRef.current;
    if (!log) return;
    const distanceFromBottom = log.scrollHeight - log.scrollTop - log.clientHeight;
    if (distanceFromBottom < 120) log.scrollTop = log.scrollHeight;
  }, [messages, thinking]);

  const ask = useCallback(
    async (question) => {
      const trimmed = question.trim();
      if (trimmed === '' || thinking) return;

      const controller = new AbortController();
      abortRef.current = controller;

      setMessages((current) => [
        ...current,
        { id: `u-${Date.now()}`, role: 'user', text: trimmed },
      ]);
      setDraft('');
      setThinking(true);

      try {
        const answer = await askAssistant({ course, question: trimmed, signal: controller.signal });
        setMessages((current) => [
          ...current,
          { id: `a-${Date.now()}`, role: 'assistant', ...answer },
        ]);
      } catch (error) {
        // An abort is the panel closing, not a failure to report.
        if (error?.name === 'AbortError') return;
        setMessages((current) => [
          ...current,
          {
            id: `e-${Date.now()}`,
            role: 'assistant',
            text: 'تعذّر الحصول على إجابة الآن. حاولي مرة أخرى بعد قليل.',
            citations: [],
            failed: true,
          },
        ]);
      } finally {
        setThinking(false);
        inputRef.current?.focus();
      }
    },
    [course, thinking],
  );

  return (
    <div className="fixed inset-0 z-50 flex" role="presentation">
      <button
        type="button"
        aria-hidden="true"
        tabIndex={-1}
        onClick={onClose}
        className="absolute inset-0 cursor-default bg-text-main/30 backdrop-blur-[2px] motion-safe:animate-step-in"
      />

      {/* `me-auto` pins the panel to the inline START — the right, in RTL. */}
      <section
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="assistant-title"
        className="relative me-auto flex h-full w-full max-w-md flex-col border-e border-accent-subtle bg-surface shadow-lift motion-safe:animate-step-in sm:max-w-lg"
      >
        <header className="flex items-start gap-3 border-b border-accent-subtle p-4 sm:p-5">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-2xl bg-primary-light">
            <Sparkles className="h-4 w-4 text-primary" aria-hidden="true" />
          </span>
          <div className="min-w-0 flex-1">
            <h2 id="assistant-title" className="text-sm font-semibold text-text-main">
              المساعد الذكي
            </h2>
            <p className="mt-0.5 truncate text-xs text-text-muted" title={course.title}>
              يجيب من محتوى: {course.title}
            </p>
          </div>
          <button
            type="button"
            onClick={() => {
              abortRef.current?.abort();
              setMessages([]);
              setThinking(false);
            }}
            disabled={messages.length === 0}
            aria-label="مسح المحادثة"
            title="مسح المحادثة"
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-text-muted transition-colors duration-200 hover:bg-surface-alt hover:text-text-main disabled:pointer-events-none disabled:opacity-40"
          >
            <RotateCcw className="h-4 w-4" aria-hidden="true" />
          </button>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label="إغلاق المساعد"
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-text-muted transition-colors duration-200 hover:bg-surface-alt hover:text-text-main"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </header>

        {/*
          THE SIMULATION NOTICE. See `assistant.js`: an assistant that returns
          fluent Arabic with a page-numbered citation is indistinguishable from
          one that read the book. This line is what keeps the placeholder from
          being a misleading placeholder, and it leaves with the real endpoint.
        */}
        <p className="flex items-start gap-2 border-b border-accent-subtle bg-surface-alt/60 px-4 py-2.5 text-[11px] leading-relaxed text-text-muted sm:px-5">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>
            وضع تجريبي — الإجابات نموذجية لعرض الواجهة، وأرقام الصفحات في المراجع غير حقيقية بعد.
          </span>
        </p>

        {/*
          `role="log"` with `aria-live="polite"` announces each arriving message
          without interrupting. `aria-relevant="additions"` keeps it to NEW
          messages: without it, re-rendering the list can make a screen reader
          read the whole conversation again.
        */}
        <div
          ref={logRef}
          role="log"
          aria-live="polite"
          aria-relevant="additions"
          aria-label="سجلّ المحادثة"
          className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4 sm:p-5"
        >
          {messages.length === 0 ? <EmptyState /> : null}
          {messages.map((message) => (
            <Message key={message.id} message={message} />
          ))}
          {thinking ? <TypingIndicator /> : null}
        </div>

        <Composer
          ref={inputRef}
          draft={draft}
          onDraft={setDraft}
          onSend={ask}
          thinking={thinking}
          showPresets={messages.length === 0}
        />
      </section>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="my-auto px-2 text-center">
      <p className="text-sm font-medium text-text-main">اسألي عن أي نقطة في هذه الدورة</p>
      <p className="mx-auto mt-2 max-w-xs text-xs leading-relaxed text-text-muted">
        المساعد يجيب من دروس الدورة ويشير إلى مصدر كل إجابة، فيمكنك العودة إلى الدرس نفسه.
      </p>
    </div>
  );
}

/**
 * One message.
 *
 * THE TWO ROLES DIFFER IN MORE THAN COLOUR. The learner's message sits at the
 * inline END (`ms-auto` → left in RTL) on a filled bubble; the assistant's sits
 * at the START on a bordered surface. Colour alone would carry the distinction
 * for most readers and none of it for the rest, which is why alignment, shape
 * and a `sr-only` speaker label all say the same thing.
 */
function Message({ message }) {
  const isUser = message.role === 'user';

  if (isUser) {
    return (
      <div className="ms-auto max-w-[85%]">
        <span className="sr-only">أنتِ:</span>
        <div className="rounded-2xl rounded-se-md bg-primary px-4 py-2.5 text-sm leading-relaxed text-on-primary">
          {message.text}
        </div>
      </div>
    );
  }

  return (
    <div className="me-auto max-w-[92%]">
      <span className="sr-only">المساعد:</span>
      <div
        className={[
          'rounded-2xl rounded-ss-md border px-4 py-3 text-sm text-text-main',
          message.failed
            ? 'border-red-400/60 bg-surface-alt/50'
            : 'border-accent-subtle bg-surface-alt/50',
        ].join(' ')}
      >
        {renderMarkdown(message.text)}

        {message.citations?.length > 0 ? (
          <ul className="mt-3 flex flex-wrap gap-1.5 border-t border-accent-subtle pt-3">
            {message.citations.map((citation) => (
              <li key={citation.id}>
                <Citation citation={citation} />
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  );
}

/**
 * A source badge.
 *
 * It is a `<span>`, not a link: it points at a lesson the player cannot open
 * yet, and a badge that looks clickable and does nothing is worse than one that
 * plainly does not. It becomes a `<Link>` the day lessons have URLs.
 */
function Citation({ citation }) {
  return (
    <span className="inline-flex max-w-full items-center gap-1.5 rounded-full bg-primary-light px-2.5 py-1 text-[11px] text-primary">
      <BookMarked className="h-3 w-3 shrink-0" aria-hidden="true" />
      <span className="truncate">
        مرجع: {citation.lesson} — صفحة <span className="tabular-nums">{citation.page}</span>
      </span>
    </span>
  );
}

/**
 * The typing indicator.
 *
 * `aria-live` is deliberately ABSENT here even though it is a status: the log
 * above already announces, and a second live region firing "جارٍ التفكير…" on
 * every question turns a conversation into an interruption. The composer's
 * disabled state carries the same fact to a keyboard user, and the text is
 * there for anyone watching.
 */
function TypingIndicator() {
  return (
    <div className="me-auto flex items-center gap-2.5 rounded-2xl rounded-ss-md border border-accent-subtle bg-surface-alt/50 px-4 py-3">
      <span className="flex gap-1" aria-hidden="true">
        {[0, 1, 2].map((dot) => (
          <span
            key={dot}
            className="h-1.5 w-1.5 rounded-full bg-primary motion-safe:animate-bounce"
            style={{ animationDelay: `${dot * 140}ms` }}
          />
        ))}
      </span>
      <span className="text-xs text-text-muted">جارٍ التفكير والإجابة من الكتب المرجعية…</span>
    </div>
  );
}

function Composer({ draft, onDraft, onSend, thinking, showPresets, ref }) {
  const onKeyDown = (event) => {
    /*
     * Enter sends; Shift+Enter breaks the line. The Arabic keyboard has no
     * separate send key, and a question that needs two lines is common enough
     * that swallowing Shift+Enter would be a real loss.
     */
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      onSend(draft);
    }
  };

  return (
    <div className="border-t border-accent-subtle p-4 sm:p-5">
      {showPresets ? (
        <ul className="mb-3 flex flex-wrap gap-1.5">
          {PRESETS.map((preset) => (
            <li key={preset.id}>
              <button
                type="button"
                onClick={() => onSend(preset.label)}
                disabled={thinking}
                className="rounded-full border border-accent-subtle px-3 py-1.5 text-[11px] font-medium text-text-muted transition-colors duration-200 hover:border-primary hover:bg-primary-light hover:text-primary disabled:pointer-events-none disabled:opacity-40"
              >
                {preset.label}
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      <div className="flex items-end gap-2">
        <textarea
          ref={ref}
          rows={1}
          value={draft}
          maxLength={MAX_QUESTION_LENGTH}
          onChange={(event) => onDraft(event.target.value)}
          onKeyDown={onKeyDown}
          disabled={thinking}
          aria-label="اكتبي سؤالك"
          placeholder={thinking ? 'جارٍ الإجابة…' : 'اكتبي سؤالك هنا…'}
          className="max-h-28 min-h-[2.75rem] flex-1 resize-none rounded-2xl border border-accent-subtle bg-canvas px-4 py-3 text-sm leading-relaxed text-text-main placeholder:text-text-muted/70 focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20 disabled:opacity-60"
        />
        <button
          type="button"
          onClick={() => onSend(draft)}
          disabled={thinking || draft.trim() === ''}
          aria-label="إرسال السؤال"
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-primary text-on-primary transition-colors duration-200 hover:bg-primary-hover disabled:pointer-events-none disabled:opacity-40"
        >
          {/*
            `-scale-x-100` mirrors the send arrow. This is the rare case where a
            physical flip IS correct: the glyph depicts motion, and in RTL the
            direction of "away from me" reverses. Contrast the ArrowLeft used
            elsewhere, which already points the right way and must NOT be
            flipped.
          */}
          <Send className="h-4 w-4 -scale-x-100" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
