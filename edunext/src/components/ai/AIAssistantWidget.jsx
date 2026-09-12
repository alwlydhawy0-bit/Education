import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  ArrowUp,
  BookMarked,
  FileText,
  Image as ImageIcon,
  Info,
  Loader2,
  Mic,
  Plus,
  RotateCcw,
  Sparkles,
  X,
} from 'lucide-react';
import { renderMarkdown } from '../tools/markdown.jsx';
import { formatSize, loadDocument } from '../tools/document-store.js';
import { classify, extractText } from '../tools/extract-text.js';
import QuizCard from './QuizCard.jsx';
import { useVoiceInput } from './useVoiceInput.js';
import { PRESETS, askAssistant } from './assistant.js';
import { generateQuiz, predictedQuestions, summarise } from './quiz.js';

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

        ---------------------------------------------------------------------
        THE PANEL IS PORTALLED, AND THAT IS A BUG FIX, NOT A FLOURISH
        ---------------------------------------------------------------------

        This widget is mounted inside the course page's floating tool stack —
        a `fixed … z-40` column. A positioned ancestor with a z-index CREATES A
        STACKING CONTEXT, so the panel's own `z-50` only ever ranked it inside
        that column. Against the page's mobile bottom navigation, also `z-40`
        and later in the document, the column tied and lost.

        The visible result was that on a phone the entire composer sat under
        the navigation bar: measured with `elementFromPoint`, the send button's
        centre belonged to the "الملف الشخصي" link, so the assistant could be
        opened and typed into but never sent from. It had been that way since
        the panel shipped.

        Rendering into `document.body` takes the panel out of that context
        entirely, which is what a modal needs anyway — it also stops the
        section's `transform` from redefining what `fixed` is relative to.
      */}
      {open
        ? createPortal(
            <AssistantPanel
              key={course.id}
              course={course}
              onClose={() => {
                setOpen(false);
                triggerRef.current?.focus();
              }}
            />,
            document.body,
          )
        : null}
    </>
  );
}

/**
 * The document actions, available only when a document exists.
 *
 * `run` returns a message payload rather than text, because "generate a quiz"
 * produces STRUCTURED data — a list of questions with answers and explanations
 * — and flattening that to Markdown just to re-parse it into cards would be a
 * lossy round trip through a format that was never meant to carry it.
 */
const DOC_ACTIONS = [
  {
    id: 'quiz',
    label: 'إنشاء اختبار تجريبي من الملف',
    run: (studyDoc) => {
      const questions = generateQuiz(studyDoc);
      return questions.length > 0
        ? { kind: 'quiz', questions, text: `اختبار من **${studyDoc.name}**:` }
        : {
            kind: 'text',
            text: 'لم أتمكّن من توليد أسئلة من هذا المستند — النص فيه قصير أو غير كافٍ.',
          };
    },
  },
  {
    id: 'summary',
    label: 'تلخيص النقاط المهمة للاختبار',
    run: (studyDoc) => ({
      kind: 'text',
      text: summarise(studyDoc) ?? 'لا يوجد نص كافٍ في المستند لتلخيصه.',
    }),
  },
  {
    id: 'predict',
    label: 'استخراج الأسئلة المتوقعة',
    run: (studyDoc) => ({
      kind: 'text',
      text: predictedQuestions(studyDoc) ?? 'لا يوجد نص كافٍ في المستند.',
    }),
  },
];

function AssistantPanel({ course, onClose }) {
  /*
   * THE DOCUMENT IS READ FROM STORAGE, NOT PASSED DOWN.
   *
   * The notebook and this panel are both modals on the same page and can never
   * be open at once, so there is no moment where a prop would be fresher than
   * what is on disk — and the notebook writes on every change. Reading it here
   * keeps the two features independent: neither imports the other's component,
   * and the assistant works the same whether the document was uploaded a second
   * ago or last week.
   */
  const [studyDoc] = useState(() => loadDocument(course.id));
  const [messages, setMessages] = useState([]);
  const [draft, setDraft] = useState('');
  const [attachments, setAttachments] = useState([]);
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

  const runDocAction = useCallback(
    (action) => {
      if (!studyDoc || thinking) return;
      setMessages((current) => [
        ...current,
        { id: `u-${Date.now()}`, role: 'user', text: action.label },
      ]);
      setThinking(true);
      /*
       * The same deliberate pause the chat answers use. Returning instantly
       * would be a lie of a different kind — it would teach the learner that
       * this work is free, and the real endpoint will not be.
       */
      const timer = setTimeout(() => {
        const payload = action.run(studyDoc);
        setMessages((current) => [
          ...current,
          { id: `a-${Date.now()}`, role: 'assistant', citations: [], ...payload },
        ]);
        setThinking(false);
      }, 900);
      abortRef.current = { abort: () => clearTimeout(timer) };
    },
    [studyDoc, thinking],
  );

  /*
   * A CHAT ATTACHMENT IS READ ON ARRIVAL, NOT ON SEND.
   *
   * Extraction of a large PDF takes long enough to notice, and doing it when
   * the learner presses send would put that wait between them and their
   * question with nothing to show for it. Reading on attach spends the same
   * time while they are still typing, and the chip reports the result — so by
   * the time send is pressed the payload is already known-good, or visibly not.
   *
   * The extracted text is held in component state and never written to
   * storage: unlike the notebook document, a file dropped into one question is
   * not study material the learner asked us to keep.
   */
  const attachFile = useCallback(async (file) => {
    const id = `f-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const kind = classify(file);

    if (kind === null) {
      setAttachments((current) => [
        ...current,
        {
          id,
          name: file.name,
          kind: 'txt',
          size: file.size,
          text: '',
          status: 'error',
          error: 'نوع غير مدعوم',
        },
      ]);
      return;
    }

    setAttachments((current) => [
      ...current,
      { id, name: file.name, kind, size: file.size, text: '', status: 'reading' },
    ]);

    try {
      const { text } = await extractText(file);
      setAttachments((current) =>
        current.map((item) => (item.id === id ? { ...item, text, status: 'ready' } : item)),
      );
    } catch (cause) {
      // The cause is logged rather than swallowed: the one time this failed in
      // development, the message named the real bug in seconds.
      console.error('[edunext] chat attachment extraction failed', cause);
      setAttachments((current) =>
        current.map((item) =>
          item.id === id
            ? {
                ...item,
                status: 'error',
                error: cause?.message === 'too-large' ? 'أكبر من الحد المسموح' : 'تعذّرت القراءة',
              }
            : item,
        ),
      );
    }
  }, []);

  const removeAttachment = useCallback((id) => {
    setAttachments((current) => current.filter((item) => item.id !== id));
  }, []);

  const ask = useCallback(
    async ({ text, attachments: sent = [] }) => {
      const trimmed = text.trim();
      // A question can be attachments alone — "read this" is a question.
      const usable = sent.filter((item) => item.status === 'ready');
      if ((trimmed === '' && usable.length === 0) || thinking) return;

      const controller = new AbortController();
      abortRef.current = controller;

      setMessages((current) => [
        ...current,
        {
          id: `u-${Date.now()}`,
          role: 'user',
          text: trimmed,
          attachments: usable.map(({ id, name, kind, size }) => ({ id, name, kind, size })),
        },
      ]);
      setDraft('');
      setAttachments([]);
      setThinking(true);

      try {
        const answer = await askAssistant({
          course,
          question: trimmed === '' ? 'اقرئي المرفق' : trimmed,
          attachments: usable,
          signal: controller.signal,
        });
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
            {studyDoc ? (
              <p className="mt-1 flex items-center gap-1 text-[11px] text-primary">
                <FileText className="h-3 w-3 shrink-0" aria-hidden="true" />
                <span className="truncate" title={studyDoc.name}>
                  مرفق: {studyDoc.name}
                </span>
              </p>
            ) : null}
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
          attachments={attachments}
          onAttach={attachFile}
          onRemoveAttachment={removeAttachment}
          onSend={ask}
          onDocAction={runDocAction}
          hasDocument={studyDoc !== null}
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
          {/*
            THE SENT ATTACHMENTS STAY IN THE MESSAGE.
            The composer's chips are cleared on send, so without this the log
            would show a bare question and the learner would have no record of
            which file they asked about three questions ago.
          */}
          {message.attachments?.length ? (
            <ul className="mb-2 flex flex-wrap gap-1.5">
              {message.attachments.map((file) => (
                <li
                  key={file.id}
                  className="flex max-w-full items-center gap-1.5 rounded-lg bg-on-primary/15 px-2 py-1"
                >
                  {file.kind === 'image' ? (
                    <ImageIcon className="h-3 w-3 shrink-0" aria-hidden="true" />
                  ) : (
                    <FileText className="h-3 w-3 shrink-0" aria-hidden="true" />
                  )}
                  <span className="truncate text-[11px]">{file.name}</span>
                </li>
              ))}
            </ul>
          ) : null}
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
            ? 'border-danger-border/60 bg-surface-alt/50'
            : 'border-accent-subtle bg-surface-alt/50',
        ].join(' ')}
      >
        {renderMarkdown(message.text)}

        {message.kind === 'quiz' ? (
          <ol className="mt-3 space-y-2.5">
            {message.questions.map((question, index) => (
              <QuizCard
                key={question.id}
                question={question}
                index={index}
                total={message.questions.length}
              />
            ))}
          </ol>
        ) : null}

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

/** What the chat composer will take. Mirrors what `classify` can actually read. */
const CHAT_ACCEPT =
  '.pdf,.txt,.md,.png,.jpg,.jpeg,.webp,.gif,application/pdf,text/plain,image/png,image/jpeg';

/** Enough for a question's supporting material; more is a notebook upload. */
const MAX_CHAT_ATTACHMENTS = 3;

/**
 * The composer: a pill holding attachments, the question, and the controls.
 *
 * ---------------------------------------------------------------------------
 * WHAT EACH CONTROL IS ALLOWED TO CLAIM
 * ---------------------------------------------------------------------------
 *
 * Three of these controls can lie, and each is built so it cannot.
 *
 * ATTACH reads the file immediately and shows the extracted size on the chip.
 * A chip that appeared instantly and said nothing would imply the file was
 * understood; the reading state is visible, and a file that yields no text
 * says so on the chip rather than travelling as an empty payload.
 *
 * MIC renders disabled, with the reason in its tooltip, where the browser has
 * no `SpeechRecognition`. Firefox has none at all. A mic that looks live and
 * does nothing teaches the learner to distrust their own microphone.
 *
 * SEND is disabled while an attachment is still being read. Sending then would
 * drop that file silently from a payload the learner watched themselves build.
 */
function Composer({
  draft,
  onDraft,
  attachments,
  onAttach,
  onRemoveAttachment,
  onSend,
  onDocAction,
  hasDocument,
  thinking,
  showPresets,
  ref,
}) {
  const fileRef = useRef(null);
  const textareaRef = useRef(null);
  const [notice, setNotice] = useState(null);

  /*
   * The textarea carries two refs: the panel's, so closing a question restores
   * focus here, and a local one for auto-sizing. A single forwarded ref cannot
   * serve both without assuming the parent passed an object rather than a
   * callback.
   */
  const attachTextarea = useCallback(
    (node) => {
      textareaRef.current = node;
      if (typeof ref === 'function') ref(node);
      else if (ref) ref.current = node;
    },
    [ref],
  );

  /*
   * GROW WITH THE TEXT, UP TO A CEILING.
   *
   * Height is reset to `auto` before reading `scrollHeight`, because
   * `scrollHeight` on an element with an explicit height reports that height
   * and the box then only ever grows. The ceiling keeps the log visible: a
   * composer that can eat the conversation is not a composer.
   */
  useEffect(() => {
    const node = textareaRef.current;
    if (!node) return;
    node.style.height = 'auto';
    node.style.height = `${Math.min(node.scrollHeight, 132)}px`;
  }, [draft]);

  const voice = useVoiceInput({
    lang: 'ar',
    onTranscript: useCallback(
      (text, final) => {
        // Only a FINAL segment is committed. Appending interim results would
        // write, rewrite and duplicate the same words as the engine revises.
        if (!final) return;
        onDraft((current) =>
          (current === '' ? text : `${current} ${text}`).slice(0, MAX_QUESTION_LENGTH),
        );
      },
      [onDraft],
    ),
  });

  const reading = attachments.some((item) => item.status === 'reading');
  const sendable = !thinking && !reading && (draft.trim() !== '' || attachments.length > 0);

  const pickFiles = async (event) => {
    const chosen = [...event.target.files];
    // Reset immediately: without this, re-picking the SAME file fires no change
    // event and the attach silently does nothing.
    event.target.value = '';
    if (chosen.length === 0) return;

    const room = MAX_CHAT_ATTACHMENTS - attachments.length;
    if (room <= 0) {
      setNotice(`الحد ${MAX_CHAT_ATTACHMENTS} مرفقات لكل سؤال.`);
      return;
    }
    setNotice(
      chosen.length > room ? `أُضيف أول ${room} فقط — الحد ${MAX_CHAT_ATTACHMENTS}.` : null,
    );
    for (const file of chosen.slice(0, room)) await onAttach(file);
  };

  const onKeyDown = (event) => {
    /*
     * Enter sends; Shift+Enter breaks the line. The Arabic keyboard has no
     * separate send key, and a question that needs two lines is common enough
     * that swallowing Shift+Enter would be a real loss.
     */
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      if (sendable) onSend({ text: draft, attachments });
    }
  };

  return (
    <div className="border-t border-accent-subtle p-3 sm:p-4">
      {/*
        DOCUMENT ACTIONS APPEAR ONLY WHEN THERE IS A DOCUMENT, and stay visible
        after the first message — unlike the generic presets, which are an
        opening prompt. These are tools a learner returns to mid-session: ask a
        question, then generate a quiz, then ask another.
      */}
      {hasDocument ? (
        <ul className="mb-2.5 flex flex-wrap gap-1.5">
          {DOC_ACTIONS.map((action) => (
            <li key={action.id}>
              <button
                type="button"
                onClick={() => onDocAction(action)}
                disabled={thinking}
                className="inline-flex items-center gap-1.5 rounded-full bg-primary-light px-3 py-1.5 text-[11px] font-medium text-primary transition-colors duration-200 hover:bg-primary hover:text-on-primary disabled:pointer-events-none disabled:opacity-40"
              >
                <FileText className="h-3 w-3" aria-hidden="true" />
                <span>{action.label}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {showPresets ? (
        <ul className="mb-2.5 flex flex-wrap gap-1.5">
          {PRESETS.map((preset) => (
            <li key={preset.id}>
              <button
                type="button"
                onClick={() => onSend({ text: preset.label, attachments: [] })}
                disabled={thinking}
                className="rounded-full border border-accent-subtle px-3 py-1.5 text-[11px] font-medium text-text-muted transition-colors duration-200 hover:border-primary hover:bg-primary-light hover:text-primary disabled:pointer-events-none disabled:opacity-40"
              >
                {preset.label}
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {voice.error ? (
        <p role="alert" className="mb-2 px-1 text-[11px] leading-relaxed text-danger">
          {voice.error}
        </p>
      ) : null}
      {notice ? (
        <p role="status" className="mb-2 px-1 text-[11px] leading-relaxed text-text-muted">
          {notice}
        </p>
      ) : null}

      {/*
        THE PILL. `rounded-3xl` rather than `rounded-full`: a full pill is only
        correct while the box is one line tall, and turns into a lozenge with
        enormous side gutters the moment it grows or carries a chip row.
      */}
      <div className="rounded-3xl border border-accent-subtle bg-canvas p-1.5 transition-colors duration-200 focus-within:border-primary focus-within:ring-2 focus-within:ring-primary/20">
        {attachments.length > 0 ? (
          <ul aria-label="المرفقات" className="flex flex-wrap gap-1.5 px-1.5 pb-1.5 pt-1">
            {attachments.map((item) => (
              <AttachmentChip
                key={item.id}
                attachment={item}
                onRemove={() => onRemoveAttachment(item.id)}
              />
            ))}
          </ul>
        ) : null}

        <div className="flex items-end gap-1">
          <input
            ref={fileRef}
            type="file"
            multiple
            accept={CHAT_ACCEPT}
            onChange={pickFiles}
            className="hidden"
            tabIndex={-1}
            aria-hidden="true"
          />
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={thinking || attachments.length >= MAX_CHAT_ATTACHMENTS}
            aria-label="إرفاق ملف أو صورة"
            title="إرفاق ملف أو صورة"
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-text-muted transition-colors duration-200 hover:bg-surface-alt hover:text-text-main focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:pointer-events-none disabled:opacity-40"
          >
            <Plus className="h-[18px] w-[18px]" aria-hidden="true" />
          </button>

          <textarea
            ref={attachTextarea}
            rows={1}
            value={draft}
            maxLength={MAX_QUESTION_LENGTH}
            onChange={(event) => onDraft(event.target.value)}
            onKeyDown={onKeyDown}
            disabled={thinking}
            aria-label="اكتبي سؤالك"
            placeholder={thinking ? 'جارٍ الإجابة…' : 'اسأل المساعد الذكي أو ارفع ملفًا...'}
            /*
              `bg-transparent` and no border: the PILL owns the focus ring, so
              the textarea drawing its own would nest two rounded outlines.
            */
            className="max-h-[132px] min-h-[2.25rem] flex-1 resize-none self-center border-0 bg-transparent px-1 py-2 text-sm leading-relaxed text-text-main placeholder:text-text-muted/70 focus:outline-none focus:ring-0 disabled:opacity-60"
          />

          <button
            type="button"
            onClick={voice.toggle}
            disabled={thinking || !voice.supported}
            aria-label={voice.listening ? 'إيقاف الإدخال الصوتي' : 'إدخال صوتي'}
            aria-pressed={voice.listening}
            title={
              voice.supported
                ? voice.listening
                  ? 'إيقاف الإدخال الصوتي'
                  : 'إدخال صوتي'
                : 'الإدخال الصوتي غير مدعوم في هذا المتصفح'
            }
            className={[
              'flex h-9 w-9 shrink-0 items-center justify-center rounded-full transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:pointer-events-none disabled:opacity-40',
              voice.listening
                ? 'bg-danger text-on-primary'
                : 'text-text-muted hover:bg-surface-alt hover:text-text-main',
            ].join(' ')}
          >
            <Mic className="h-[18px] w-[18px]" aria-hidden="true" />
            {/*
              A pulsing dot is decoration a screen reader cannot see, so the
              listening state is also spoken.
            */}
            {voice.listening ? <span className="sr-only">يستمع الآن</span> : null}
          </button>

          <button
            type="button"
            onClick={() => onSend({ text: draft, attachments })}
            disabled={!sendable}
            aria-label={reading ? 'جارٍ قراءة المرفق' : 'إرسال السؤال'}
            title={reading ? 'جارٍ قراءة المرفق…' : 'إرسال'}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary text-on-primary transition-colors duration-200 hover:bg-primary-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:pointer-events-none disabled:opacity-40"
          >
            {thinking || reading ? (
              <Loader2 className="h-[18px] w-[18px] motion-safe:animate-spin" aria-hidden="true" />
            ) : (
              /*
                ArrowUp needs NO mirroring: it points along the block axis,
                which RTL does not reverse. That is exactly why it survives the
                switch better than the horizontal send glyph it replaces.
              */
              <ArrowUp className="h-[18px] w-[18px]" aria-hidden="true" />
            )}
          </button>
        </div>
      </div>

      <p className="mt-1.5 px-2 text-[10px] text-text-muted">
        Enter للإرسال · Shift+Enter لسطر جديد
      </p>
    </div>
  );
}

/** One attached file, with its reading state legible rather than implied. */
function AttachmentChip({ attachment, onRemove }) {
  const Icon = attachment.kind === 'image' ? ImageIcon : FileText;
  const detail =
    attachment.status === 'reading'
      ? 'جارٍ القراءة…'
      : attachment.status === 'error'
        ? attachment.error
        : attachment.kind === 'image'
          ? formatSize(attachment.size)
          : attachment.text.trim() === ''
            ? 'لا نص قابل للقراءة'
            : `${attachment.text.length.toLocaleString('en-US')} حرفًا`;

  return (
    <li
      className={[
        'flex max-w-[14rem] items-center gap-1.5 rounded-xl border px-2 py-1',
        attachment.status === 'error'
          ? 'border-danger-border bg-surface-alt'
          : 'border-accent-subtle bg-surface-alt/60',
      ].join(' ')}
    >
      {attachment.status === 'reading' ? (
        <Loader2
          className="h-3 w-3 shrink-0 text-text-muted motion-safe:animate-spin"
          aria-hidden="true"
        />
      ) : (
        <Icon
          className={`h-3 w-3 shrink-0 ${attachment.status === 'error' ? 'text-danger' : 'text-primary'}`}
          aria-hidden="true"
        />
      )}
      <span className="min-w-0 flex-1">
        <span
          className="block truncate text-[11px] font-medium text-text-main"
          title={attachment.name}
        >
          {attachment.name}
        </span>
        <span
          className={`block truncate text-[10px] ${attachment.status === 'error' ? 'text-danger' : 'text-text-muted'}`}
        >
          {detail}
        </span>
      </span>
      <button
        type="button"
        onClick={onRemove}
        aria-label={`إزالة ${attachment.name}`}
        className="shrink-0 rounded-full p-0.5 text-text-muted transition-colors duration-200 hover:bg-surface-alt hover:text-text-main focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
      >
        <X className="h-3 w-3" aria-hidden="true" />
      </button>
    </li>
  );
}
