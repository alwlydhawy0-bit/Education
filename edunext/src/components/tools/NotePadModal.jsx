import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Bold,
  Check,
  Download,
  Eye,
  Italic,
  List,
  ListOrdered,
  Pencil,
  Quote,
  Code,
  Heading2,
  TriangleAlert,
  X,
} from 'lucide-react';
import { renderMarkdown } from './markdown.jsx';
import DocAnnotator from './DocAnnotator.jsx';
import { loadDocument } from './document-store.js';
import SketchPad from './SketchPad.jsx';
import { downloadFile, loadNote, safeFilename, saveNote } from './notes-storage.js';

/**
 * The learner's notebook for one course: writing on one tab, sketching on the other.
 *
 * ---------------------------------------------------------------------------
 * A TEXTAREA CANNOT SHOW BOLD TEXT, SO THE FORMATTING IS MARKDOWN + A PREVIEW
 * ---------------------------------------------------------------------------
 *
 * The brief asked for Word-style formatting in a textarea. Those two cannot both
 * be true: a textarea renders one uniform run of plain text, by definition. The
 * three ways out, and why this is the one taken:
 *
 *   contentEditable + document.execCommand — the literal reading. `execCommand`
 *   is deprecated, behaves differently in every engine, and produces whatever
 *   HTML the browser felt like, which then has to be sanitised before it can be
 *   stored or re-rendered. It looks the most like Word and is the least sound.
 *
 *   A rich-text editor dependency — correct and heavy. ~100KB and a document
 *   model, for a scratch notepad beside a video.
 *
 *   Markdown in a textarea, with a toolbar that writes it and a preview that
 *   renders it — taken. The toolbar buttons do exactly what a Word user
 *   expects: select text, press B, the text becomes bold in the preview. The
 *   stored value stays plain text, which means it exports as a real `.md` file,
 *   diffs, syncs, and can never carry markup into the DOM (see `markdown.jsx`).
 *
 * The deviation is worth stating plainly rather than quietly delivering a
 * textarea whose bold button does nothing.
 *
 * ---------------------------------------------------------------------------
 * SAVING IS AUTOMATIC, AND SAYS SO
 * ---------------------------------------------------------------------------
 *
 * Notes taken during a lesson are lost by closing a tab, not by forgetting a
 * button. Writing is debounced so a fast typist does not hit `localStorage` on
 * every keystroke, and the sketch saves on each completed stroke. The status
 * line reports the real outcome — including failure, because `localStorage`
 * genuinely runs out and a notepad that silently stops saving is worse than one
 * that refuses to open.
 */

const AUTOSAVE_DELAY_MS = 600;

const TABS = [
  { id: 'notes', label: 'الملاحظات' },
  { id: 'sketch', label: 'الرسم والمعادلات' },
  { id: 'document', label: 'رفع ملف / مستند' },
];

/**
 * The closed state is NOT MOUNTED, and the open one is keyed on the course.
 *
 * The first draft kept one instance alive and loaded the note in an effect when
 * `open` flipped — which meant every open rendered the PREVIOUS course's notes
 * for one frame before correcting itself, and oxlint's `set-state-in-effect`
 * flagged the cascade. Mounting on open instead lets `useState` read storage as
 * its initialiser, so the first frame is already right; keying on `courseId`
 * makes switching courses a fresh notebook by construction rather than by an
 * effect somebody has to remember to write.
 *
 * This is the same correction the OTP step needed, for the same reason: state
 * that is DERIVED from a prop belongs in a remount, not in an effect that fixes
 * it up afterwards.
 */
export default function NotePadModal({ courseId, courseTitle, open, onClose }) {
  if (!open) return null;
  return <NotePad key={courseId} courseId={courseId} courseTitle={courseTitle} onClose={onClose} />;
}

function NotePad({ courseId, courseTitle, onClose }) {
  const [stored] = useState(() => loadNote(courseId));
  /*
   * The document is loaded once on mount, same as the note. `DocAnnotator` owns
   * writing it and hands the new value back up, so this component holds the one
   * copy the export and the tab label both read — two sources would drift the
   * moment one of them forgot to refresh.
   */
  /*
   * NAMED `studyDoc`, NOT `document`. The first draft used `document`, which
   * shadows the global inside this component — and the focus effect below calls
   * `document.activeElement` and `document.body`. Those would have resolved to
   * this state value, quietly breaking the focus trap and the focus restore
   * while every visible feature kept working. oxlint's exhaustive-deps rule
   * surfaced it by listing `document.activeElement` as a missing dependency,
   * which is a strange complaint until you see what it is really telling you.
   */
  const [studyDoc, setStudyDoc] = useState(() => loadDocument(courseId));
  const [tab, setTab] = useState('notes');
  const [markdown, setMarkdown] = useState(stored.markdown);
  const [drawing, setDrawing] = useState(stored.drawing);
  const [preview, setPreview] = useState(false);
  const [status, setStatus] = useState(() =>
    stored.updatedAt ? { kind: 'loaded', at: stored.updatedAt } : { kind: 'idle' },
  );

  const panelRef = useRef(null);
  const textareaRef = useRef(null);
  const sketchRef = useRef(null);
  const closeRef = useRef(null);
  /** Whether the current state came from the learner or from storage. */
  const dirtyRef = useRef(false);

  /*
   * AUTOSAVE. The guard on `dirtyRef` is what stops the effect from writing the
   * note straight back to storage the moment it is loaded — harmless in itself,
   * but it would stamp a new `updatedAt` on every open and make "آخر حفظ" mean
   * "last opened", which is a lie a learner would rely on.
   */
  useEffect(() => {
    if (!dirtyRef.current) return undefined;
    const timer = setTimeout(() => {
      const result = saveNote(courseId, { markdown, drawing });
      setStatus(
        result.ok
          ? { kind: 'saved', at: result.updatedAt }
          : { kind: 'error', reason: result.reason },
      );
    }, AUTOSAVE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [courseId, markdown, drawing]);

  /* Escape closes, and focus goes back where it came from. */
  useEffect(() => {
    const previouslyFocused = document.activeElement;
    /*
     * The panel node is captured HERE rather than read as `panelRef.current` in
     * the cleanup. By the time cleanup runs React has already detached the
     * node, so the ref is null and the "is focus still inside the panel?"
     * question below would always answer no — silently skipping the focus
     * restore this effect exists to perform.
     */
    const panel = panelRef.current;
    closeRef.current?.focus();

    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
        return;
      }
      /*
       * A FOCUS TRAP, because this is a modal. Without it, Tab walks out of the
       * panel and into the page behind — which is still rendered and still
       * interactive to the keyboard while being visually covered. A sighted
       * mouse user never notices; a keyboard user gets lost immediately.
       */
      if (event.key !== 'Tab') return;
      const focusable = panel?.querySelectorAll(
        'button:not([disabled]), [href], textarea, select, canvas, [tabindex]:not([tabindex="-1"])',
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
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      /*
       * RESTORE FOCUS TO WHATEVER OPENED THIS — the promise a modal makes to a
       * keyboard user, and the one this got wrong at first.
       *
       * The first version restored only when `document.activeElement` was still
       * inside the panel. That never fired: by the time cleanup runs React has
       * already detached the panel, so the browser has moved focus to <body>,
       * and `panel.contains(body)` is false. Measured, not deduced — closing
       * from either tab left focus on BODY, which drops a keyboard user at the
       * top of the document with their place in the page lost.
       *
       * `body` therefore means "focus was released when the panel went away"
       * and must be restored. The guard that remains is the one that was
       * actually wanted: if focus sits on some OTHER element, the learner moved
       * it deliberately and stealing it back would be the rude thing to do.
       */
      const active = document.activeElement;
      const focusWasReleased = !active || active === document.body;
      if (focusWasReleased || panel?.contains(active)) previouslyFocused?.focus?.();
    };
  }, [onClose]);

  /**
   * Wrap or prefix the current selection, the way a formatting toolbar should.
   *
   * The two subtleties that make this feel right rather than nearly right:
   * focus returns to the textarea (otherwise the next keystroke goes nowhere),
   * and the selection is restored around the newly formatted text (so pressing
   * B then I compounds, instead of the second press acting on nothing).
   */
  const applyFormat = useCallback((format) => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const { selectionStart: start, selectionEnd: end, value } = textarea;
    const selected = value.slice(start, end);

    let replacement;
    let caretStart;
    let caretEnd;

    if (format.wrap) {
      /*
       * THE DELIMITERS GO INSIDE THE WHITESPACE, NOT AROUND IT.
       *
       * A learner double-clicking a word usually selects the trailing space
       * with it, and wrapping that selection naively produces `**word **` —
       * which this app's own preview happens to render as bold, and which
       * CommonMark does NOT: a closing `**` preceded by whitespace is not a
       * closing delimiter. The note would look right here and lose its
       * formatting the moment the exported `.md` is opened anywhere else.
       *
       * So the selection is split into leading space, body, trailing space, and
       * only the body is wrapped. Caught by reading the toolbar's actual output
       * rather than the preview it produced.
       */
      const raw = selected || format.placeholder;
      const [, lead, body, trail] = /^(\s*)([\s\S]*?)(\s*)$/.exec(raw);
      const inner = body || format.placeholder;
      replacement = `${lead}${format.wrap}${inner}${format.wrap}${trail}`;
      caretStart = start + lead.length + format.wrap.length;
      caretEnd = caretStart + inner.length;
    } else {
      // Line prefixes apply to every selected line, so a three-line selection
      // becomes a three-item list rather than one item with two orphans.
      const lines = (selected || format.placeholder).split('\n');
      replacement = lines
        .map(
          (line, index) =>
            `${format.prefix(index)}${line.replace(/^(\s*)([-*>]|\d+[.)])\s+/, '$1')}`,
        )
        .join('\n');
      caretStart = start;
      caretEnd = start + replacement.length;
    }

    const next = value.slice(0, start) + replacement + value.slice(end);
    dirtyRef.current = true;
    setMarkdown(next);
    requestAnimationFrame(() => {
      textarea.focus();
      textarea.setSelectionRange(caretStart, caretEnd);
    });
  }, []);

  const exportNotes = () => {
    const sketch = sketchRef.current?.toDataURL?.() ?? drawing;
    const header = `# ملاحظات: ${courseTitle}\n\n`;
    /*
     * Highlights are part of the notes for a course, so they export with them.
     * A learner who marked up a document and then exported "their notes" and
     * got only the typed half would reasonably call that a bug.
     */
    const highlights =
      studyDoc?.annotations?.length > 0
        ? `\n\n## تظليلات من: ${studyDoc.name}\n\n${studyDoc.annotations
            .map(
              (a) =>
                // The exam flag travels with the quote. A learner revising from
                // this file needs to know which passages they themselves marked
                // as likely to be asked — that is the whole point of the flag,
                // and an export that drops it keeps only the easy half.
                `> ${a.quote}${a.exam ? ' ⭐' : ''}${a.note ? `\n\n${a.note}` : ''}`,
            )
            .join('\n\n')}\n`
        : '';
    const blob = new Blob([header + markdown + highlights], {
      type: 'text/markdown;charset=utf-8',
    });
    downloadFile(safeFilename(`ملاحظات - ${courseTitle}`, 'md'), blob);

    /*
     * The sketch leaves as a SECOND file rather than being embedded in the
     * Markdown. A base64 image inline makes the `.md` unreadable in every text
     * editor and unusable in most Markdown tools — the export would technically
     * contain everything and be good for nothing.
     */
    if (sketch) {
      const binary = atob(sketch.split(',')[1]);
      const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
      downloadFile(
        safeFilename(`رسم - ${courseTitle}`, 'png'),
        new Blob([bytes], { type: 'image/png' }),
      );
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex" role="presentation">
      {/*
        The scrim closes on click and is `aria-hidden`: it is a visual device,
        and announcing "button" for the whole screen helps nobody. Escape and
        the labelled close button are the accessible paths out.
      */}
      <button
        type="button"
        aria-hidden="true"
        tabIndex={-1}
        onClick={onClose}
        className="absolute inset-0 cursor-default bg-text-main/30 backdrop-blur-[2px] motion-safe:animate-step-in"
      />

      {/*
        A SLIDE-OVER ON THE INLINE-START EDGE. `me-auto` pushes it to the start
        of the flex row, which RTL resolves to the RIGHT — the side an Arabic
        reader's attention already sits on. A physical `ml-auto` would put it on
        the left here and be wrong in exactly one direction.
      */}
      <section
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="notepad-title"
        className="relative me-auto flex h-full w-full max-w-md flex-col border-e border-accent-subtle bg-surface shadow-lift motion-safe:animate-step-in sm:max-w-lg"
      >
        <header className="flex items-start gap-3 border-b border-accent-subtle p-4 sm:p-5">
          <div className="min-w-0 flex-1">
            <h2 id="notepad-title" className="text-sm font-semibold text-text-main">
              دفتر الملاحظات
            </h2>
            <p className="mt-0.5 truncate text-xs text-text-muted" title={courseTitle}>
              {courseTitle}
            </p>
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label="إغلاق دفتر الملاحظات"
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-text-muted transition-colors duration-200 hover:bg-surface-alt hover:text-text-main"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </header>

        <Tabs tab={tab} onChange={setTab} />

        <div className="flex min-h-0 flex-1 flex-col p-4 sm:p-5">
          {tab === 'notes' ? (
            <>
              <Toolbar onFormat={applyFormat} preview={preview} onTogglePreview={setPreview} />
              {preview ? (
                <div className="mt-3 min-h-0 flex-1 overflow-y-auto rounded-2xl border border-accent-subtle bg-canvas p-4 text-sm text-text-main">
                  {markdown.trim() === '' ? (
                    <p className="text-xs text-text-muted">لا توجد ملاحظات بعد.</p>
                  ) : (
                    renderMarkdown(markdown)
                  )}
                </div>
              ) : (
                <textarea
                  ref={textareaRef}
                  value={markdown}
                  onChange={(event) => {
                    dirtyRef.current = true;
                    setMarkdown(event.target.value);
                  }}
                  aria-label="نص الملاحظات"
                  placeholder={
                    'اكتبي ملاحظاتك هنا…\n\nمثال:\n## النقطة المهمة\n- **تنظيف البيانات** قبل التحليل'
                  }
                  className="mt-3 min-h-0 w-full flex-1 resize-none rounded-2xl border border-accent-subtle bg-canvas p-4 text-sm leading-relaxed text-text-main placeholder:text-text-muted/70 focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
                />
              )}
            </>
          ) : tab === 'sketch' ? (
            <SketchPad
              ref={sketchRef}
              value={drawing}
              onChange={(next) => {
                dirtyRef.current = true;
                setDrawing(next);
              }}
            />
          ) : (
            <DocAnnotator courseId={courseId} document={studyDoc} onChange={setStudyDoc} />
          )}
        </div>

        <footer className="flex items-center justify-between gap-3 border-t border-accent-subtle p-4 sm:p-5">
          <SaveStatus status={status} />
          <button
            type="button"
            onClick={exportNotes}
            className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full bg-primary-light px-4 text-xs font-medium text-primary transition-colors duration-200 hover:bg-primary hover:text-on-primary"
          >
            <span>تصدير</span>
            <Download className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </footer>
      </section>
    </div>
  );
}

/**
 * The three tabs.
 *
 * `role="tablist"` with arrow-key movement is the pattern a screen-reader user
 * expects; two buttons that merely look like tabs announce as two buttons and
 * give no sense that they are alternatives to each other. `aria-controls` and
 * `aria-selected` are what make the relationship explicit.
 */
function Tabs({ tab, onChange }) {
  const onKeyDown = (event) => {
    // In an RTL tablist, ArrowLeft moves FORWARD through the tabs — the browser
    // does not flip this for us, and getting it backwards makes the keyboard
    // feel inverted to an Arabic reader.
    const delta = event.key === 'ArrowLeft' ? 1 : event.key === 'ArrowRight' ? -1 : 0;
    if (delta === 0) return;
    event.preventDefault();
    const index = TABS.findIndex((item) => item.id === tab);
    onChange(TABS[(index + delta + TABS.length) % TABS.length].id);
  };

  return (
    <div
      role="tablist"
      aria-label="أقسام دفتر الملاحظات"
      onKeyDown={onKeyDown}
      className="flex flex-wrap gap-1 border-b border-accent-subtle px-4 sm:px-5"
    >
      {TABS.map((item) => {
        const selected = item.id === tab;
        return (
          <button
            key={item.id}
            role="tab"
            type="button"
            aria-selected={selected}
            aria-controls={`notepad-panel-${item.id}`}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(item.id)}
            className={[
              '-mb-px border-b-2 px-3 py-2.5 text-xs font-medium transition-colors duration-200',
              selected
                ? 'border-primary text-primary'
                : 'border-transparent text-text-muted hover:text-text-main',
            ].join(' ')}
          >
            {item.label}
          </button>
        );
      })}
    </div>
  );
}

const FORMATS = [
  { id: 'bold', label: 'عريض', Icon: Bold, wrap: '**', placeholder: 'نص عريض' },
  { id: 'italic', label: 'مائل', Icon: Italic, wrap: '*', placeholder: 'نص مائل' },
  { id: 'code', label: 'رمز', Icon: Code, wrap: '`', placeholder: 'code' },
  { id: 'heading', label: 'عنوان', Icon: Heading2, prefix: () => '## ', placeholder: 'عنوان' },
  { id: 'bullet', label: 'قائمة نقطية', Icon: List, prefix: () => '- ', placeholder: 'عنصر' },
  {
    id: 'ordered',
    label: 'قائمة مرقّمة',
    Icon: ListOrdered,
    prefix: (index) => `${index + 1}. `,
    placeholder: 'عنصر',
  },
  { id: 'quote', label: 'اقتباس', Icon: Quote, prefix: () => '> ', placeholder: 'اقتباس' },
];

function Toolbar({ onFormat, preview, onTogglePreview }) {
  return (
    <div className="flex flex-wrap items-center gap-1">
      {FORMATS.map((format) => (
        <button
          key={format.id}
          type="button"
          onClick={() => onFormat(format)}
          disabled={preview}
          aria-label={format.label}
          title={format.label}
          className="flex h-8 w-8 items-center justify-center rounded-lg text-text-muted transition-colors duration-200 hover:bg-primary-light hover:text-primary disabled:pointer-events-none disabled:opacity-40"
        >
          <format.Icon className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      ))}

      {/*
        The preview toggle sits at the inline END of the row (`ms-auto` → left
        in RTL), away from the formatting cluster, because it changes the MODE
        of the pane rather than the text inside it.
      */}
      <button
        type="button"
        onClick={() => onTogglePreview(!preview)}
        aria-pressed={preview}
        className="ms-auto inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-[11px] font-medium text-text-muted transition-colors duration-200 hover:bg-primary-light hover:text-primary"
      >
        {preview ? (
          <>
            <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
            <span>تحرير</span>
          </>
        ) : (
          <>
            <Eye className="h-3.5 w-3.5" aria-hidden="true" />
            <span>معاينة</span>
          </>
        )}
      </button>
    </div>
  );
}

/**
 * What happened to the last save.
 *
 * `aria-live="polite"` so a screen reader hears the outcome without being
 * interrupted mid-sentence — and only the outcome: the timestamp is rendered
 * for the eye, while the message carries the meaning.
 */
function SaveStatus({ status }) {
  if (status.kind === 'error') {
    return (
      <p className="flex items-center gap-1.5 text-[11px] text-danger" role="alert">
        <TriangleAlert className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        {status.reason === 'quota'
          ? 'تعذّر الحفظ: المساحة ممتلئة. احذفي الرسم أو صدّري الملاحظات.'
          : 'تعذّر الحفظ في هذا المتصفّح. صدّري الملاحظات للاحتفاظ بها.'}
      </p>
    );
  }

  const time =
    status.at &&
    new Date(status.at).toLocaleTimeString('ar', { hour: '2-digit', minute: '2-digit' });

  return (
    <p className="flex items-center gap-1.5 text-[11px] text-text-muted" aria-live="polite">
      {status.kind === 'saved' ? (
        <>
          <Check className="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden="true" />
          <span>حُفظت {time}</span>
        </>
      ) : status.kind === 'loaded' ? (
        <span>آخر حفظ {time}</span>
      ) : (
        <span>يُحفظ تلقائيًا على هذا الجهاز</span>
      )}
    </p>
  );
}
