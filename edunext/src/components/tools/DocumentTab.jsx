import { useCallback, useEffect, useRef, useState } from 'react';
import { Download, FileText, Highlighter, Image as ImageIcon, Trash2, Upload } from 'lucide-react';
import { MAX_FILE_BYTES, classify, extractText } from './extract-text.js';
import { clearDocument, formatSize, saveDocument } from './document-store.js';
import { downloadFile, safeFilename } from './notes-storage.js';

/**
 * Upload a study document, read it, and mark it up.
 *
 * ---------------------------------------------------------------------------
 * THE FILE IS NOT KEPT; WHAT IT SAID IS
 * ---------------------------------------------------------------------------
 *
 * See `document-store.js`. The bytes live behind an object URL for this session
 * only, and the panel says so where the learner can see it — a preview that is
 * silently blank tomorrow is worse than one that warned.
 *
 * ---------------------------------------------------------------------------
 * HIGHLIGHTING WORKS ON SELECTION, WHICH IS THE ONLY THING THAT WORKS IN RTL
 * ---------------------------------------------------------------------------
 *
 * Drawing a highlight box over coordinates is the obvious approach and it falls
 * apart immediately with Arabic: text reflows at every width, bidi runs put a
 * visual rectangle across characters that are not contiguous in the string, and
 * a highlight saved at one window size lands somewhere else at another. Reading
 * `window.getSelection()` sidesteps all of it — the browser already knows what
 * the learner selected, in logical order, whatever the direction.
 */
export default function DocumentTab({ courseId, document: stored, onChange }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [previewUrl, setPreviewUrl] = useState(null);
  const [selection, setSelection] = useState('');
  const [noteDraft, setNoteDraft] = useState('');
  const inputRef = useRef(null);
  const textRef = useRef(null);

  /*
   * An object URL is a document-lifetime handle to a blob. Not revoking it
   * keeps the whole file resident for as long as the tab lives, which for a
   * 20MB PDF is exactly the leak this feature would be blamed for.
   */
  useEffect(
    () => () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    },
    [previewUrl],
  );

  const handleFile = useCallback(
    async (file) => {
      if (!file) return;
      setError(null);

      if (classify(file) === null) {
        setError('نوع الملف غير مدعوم. اختاري PDF أو TXT أو صورة.');
        return;
      }
      if (file.size > MAX_FILE_BYTES) {
        setError(`الملف أكبر من الحد المسموح (${formatSize(MAX_FILE_BYTES)}).`);
        return;
      }

      setBusy(true);
      try {
        const extracted = await extractText(file);
        const next = {
          name: file.name,
          kind: extracted.kind,
          size: file.size,
          pageCount: extracted.pageCount,
          text: extracted.text,
          truncated: extracted.truncated,
          annotations: [],
          uploadedAt: new Date().toISOString(),
        };
        const result = saveDocument(courseId, next);
        if (!result.ok) {
          setError(
            result.reason === 'quota'
              ? 'تعذّر الحفظ: مساحة المتصفّح ممتلئة. احذفي مستندًا أو رسمًا قديمًا.'
              : 'تعذّر الحفظ في هذا المتصفّح، لكن يمكنك استخدام المستند في هذه الجلسة.',
          );
        }
        if (previewUrl) URL.revokeObjectURL(previewUrl);
        setPreviewUrl(URL.createObjectURL(file));
        onChange(next);
      } catch (cause) {
        /*
         * THE CAUSE IS LOGGED, THE MESSAGE IS NOT THE CAUSE.
         *
         * The learner gets a sentence they can act on; the console gets the
         * actual error. The first version swallowed it entirely, and debugging
         * a failed extraction then meant adding this line back by hand — which
         * is precisely the moment a developer is least able to reproduce the
         * file that caused it.
         */
        console.error('[edunext] document extraction failed', cause);
        setError(
          cause?.message === 'too-large'
            ? 'الملف كبير جدًا.'
            : 'تعذّرت قراءة الملف. تأكّدي من أنه غير تالف ثم حاولي مجددًا.',
        );
      } finally {
        setBusy(false);
      }
    },
    [courseId, onChange, previewUrl],
  );

  const captureSelection = () => {
    const text = window.getSelection()?.toString().trim() ?? '';
    // A stray click collapses the selection; keeping the last real one lets the
    // learner click into the note box without losing what they just selected.
    if (text.length > 0) setSelection(text.slice(0, 400));
  };

  const addAnnotation = () => {
    if (selection === '' || !stored) return;
    const next = {
      ...stored,
      annotations: [
        ...stored.annotations,
        { id: `a-${Date.now()}`, quote: selection, note: noteDraft.trim() },
      ],
    };
    saveDocument(courseId, next);
    onChange(next);
    setSelection('');
    setNoteDraft('');
  };

  const removeAnnotation = (id) => {
    const next = { ...stored, annotations: stored.annotations.filter((a) => a.id !== id) };
    saveDocument(courseId, next);
    onChange(next);
  };

  const removeDocument = () => {
    clearDocument(courseId);
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewUrl(null);
    setSelection('');
    onChange(null);
  };

  /*
   * THE EXPORT CARRIES THE WHOLE DOCUMENT, NOT JUST THE HIGHLIGHTS.
   *
   * A learner exporting their study material and getting four quoted lines
   * without the text they were quoted from has not got their material back —
   * the highlights are annotations ON something, and on their own they are a
   * set of fragments with no source. So the file carries the metadata, the
   * highlights, and the extracted text, in that order: the reader wants the
   * summary first and the raw text last.
   *
   * It is also available whenever a document exists, not only once a highlight
   * has been made. Getting your own text back out should not be gated on
   * having annotated it.
   */
  const exportDocument = () => {
    const kindLabel = { pdf: 'PDF', txt: 'نص', image: 'صورة' }[stored.kind] ?? stored.kind;
    const lines = [
      `# ${stored.name}`,
      '',
      `- النوع: ${kindLabel}`,
      `- الحجم: ${formatSize(stored.size)}`,
      ...(stored.pageCount ? [`- الصفحات: ${stored.pageCount}`] : []),
      ...(stored.text ? [`- عدد الأحرف: ${stored.text.length.toLocaleString('en-US')}`] : []),
      ...(stored.truncated ? ['- ملاحظة: النص المستخرج مقتطع لأن الملف تجاوز الحد المسموح.'] : []),
      '',
    ];

    if (stored.annotations.length > 0) {
      lines.push(`## التظليلات (${stored.annotations.length})`, '');
      for (const annotation of stored.annotations) {
        lines.push(`> ${annotation.quote}`, '');
        if (annotation.note) lines.push(annotation.note, '');
      }
    }

    if (stored.text) lines.push('## النص المستخرج', '', stored.text, '');

    downloadFile(
      // `stored.name` already ends in `.pdf` or `.txt`; keeping it would produce
      // "sample.pdf.md". The extension belongs to the export, not the source.
      safeFilename(stored.name.replace(/\.[^.]+$/, ''), 'md'),
      new Blob([lines.join('\n')], { type: 'text/markdown;charset=utf-8' }),
    );
  };

  if (!stored) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 text-center">
        <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-primary-light">
          <Upload className="h-6 w-6 text-primary" aria-hidden="true" />
        </span>
        <div>
          <p className="text-sm font-medium text-text-main">ارفعي مستند المذاكرة</p>
          <p className="mx-auto mt-1.5 max-w-xs text-xs leading-relaxed text-text-muted">
            PDF أو TXT أو صورة. يُقرأ النص تلقائيًا ليصبح متاحًا للمساعد الذكي.
          </p>
        </div>

        <input
          ref={inputRef}
          type="file"
          accept=".pdf,.txt,.md,image/png,image/jpeg,image/webp,image/gif,application/pdf,text/plain"
          onChange={(event) => handleFile(event.target.files?.[0])}
          className="sr-only"
          id="doc-upload"
        />
        {/*
          The <input type="file"> is visually hidden but NOT `display:none` —
          a hidden-by-display input is removed from the accessibility tree and
          cannot be reached by keyboard at all. `sr-only` keeps it focusable,
          and the <label> gives it a large, styled target.
        */}
        <label
          htmlFor="doc-upload"
          className="inline-flex h-11 cursor-pointer items-center gap-2 rounded-full bg-primary px-6 text-sm font-medium text-on-primary shadow-soft transition-colors duration-200 hover:bg-primary-hover"
        >
          {busy ? 'جارٍ القراءة…' : 'اختاري ملفًا'}
        </label>

        {error ? (
          <p role="alert" className="max-w-xs text-xs leading-relaxed text-danger">
            {error}
          </p>
        ) : null}
      </div>
    );
  }

  const Icon = stored.kind === 'image' ? ImageIcon : FileText;

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      {/* بطاقة الملف */}
      <div className="flex items-start gap-3 rounded-2xl border border-accent-subtle bg-canvas p-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary-light">
          <Icon className="h-4 w-4 text-primary" aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-semibold text-text-main" title={stored.name}>
            {stored.name}
          </p>
          <p className="mt-0.5 text-[11px] text-text-muted">
            <span className="tabular-nums">{formatSize(stored.size)}</span>
            {stored.pageCount ? ` · ${stored.pageCount} صفحة` : null}
            {stored.text ? ` · ${stored.text.length.toLocaleString('en-US')} حرفًا` : null}
          </p>
        </div>
        <button
          type="button"
          onClick={exportDocument}
          aria-label="تصدير المستند والتظليلات"
          title="تصدير المستند والتظليلات"
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-text-muted transition-colors duration-200 hover:bg-surface-alt hover:text-text-main"
        >
          <Download className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
        <button
          type="button"
          onClick={removeDocument}
          aria-label="حذف المستند"
          title="حذف المستند"
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-text-muted transition-colors duration-200 hover:bg-surface-alt hover:text-text-main"
        >
          <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      </div>

      <Notices document={stored} hasPreview={previewUrl !== null} error={error} />

      {/* المعاينة */}
      <div className="min-h-0 flex-1 overflow-y-auto rounded-2xl border border-accent-subtle bg-canvas">
        {stored.kind === 'image' && previewUrl ? (
          <img src={previewUrl} alt={`معاينة ${stored.name}`} className="w-full" />
        ) : stored.text ? (
          <p
            ref={textRef}
            onMouseUp={captureSelection}
            onKeyUp={captureSelection}
            className="whitespace-pre-wrap p-4 text-xs leading-loose text-text-main selection:bg-accent-lavender selection:text-text-main"
          >
            {stored.text}
          </p>
        ) : (
          <p className="p-4 text-xs leading-relaxed text-text-muted">
            لا يوجد نص قابل للقراءة في هذا الملف.
          </p>
        )}
      </div>

      {/* إضافة تظليل */}
      {selection ? (
        <div className="rounded-2xl border border-primary/30 bg-primary-light/50 p-3">
          <p className="line-clamp-2 text-[11px] leading-relaxed text-text-main">«{selection}»</p>
          <div className="mt-2 flex items-center gap-2">
            <input
              type="text"
              value={noteDraft}
              onChange={(event) => setNoteDraft(event.target.value)}
              aria-label="ملاحظة على التظليل"
              placeholder="ملاحظة (اختياري)…"
              className="h-9 flex-1 rounded-full border border-accent-subtle bg-canvas px-3 text-xs text-text-main placeholder:text-text-muted/70 focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
            />
            <button
              type="button"
              onClick={addAnnotation}
              className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full bg-primary px-4 text-xs font-medium text-on-primary transition-colors duration-200 hover:bg-primary-hover"
            >
              <Highlighter className="h-3.5 w-3.5" aria-hidden="true" />
              <span>تظليل</span>
            </button>
          </div>
        </div>
      ) : stored.text ? (
        <p className="text-[11px] text-text-muted">
          ظلّلي أي جزء من النص أعلاه لإضافة ملاحظة عليه.
        </p>
      ) : null}

      {/* التظليلات */}
      {stored.annotations.length > 0 ? (
        <section aria-label="التظليلات" className="shrink-0">
          <h3 className="mb-2 text-[11px] font-semibold text-text-main">
            التظليلات (<span className="tabular-nums">{stored.annotations.length}</span>)
          </h3>
          <ul className="max-h-32 space-y-1.5 overflow-y-auto">
            {stored.annotations.map((annotation) => (
              <li
                key={annotation.id}
                className="flex items-start gap-2 rounded-xl border-s-2 border-accent-lavender bg-surface-alt/60 px-3 py-2"
              >
                <span className="min-w-0 flex-1">
                  <span className="line-clamp-2 block text-[11px] leading-relaxed text-text-main">
                    {annotation.quote}
                  </span>
                  {annotation.note ? (
                    <span className="mt-1 block text-[11px] text-text-muted">
                      {annotation.note}
                    </span>
                  ) : null}
                </span>
                <button
                  type="button"
                  onClick={() => removeAnnotation(annotation.id)}
                  aria-label="حذف التظليل"
                  className="shrink-0 rounded-full p-1 text-text-muted transition-colors hover:text-text-main"
                >
                  <Trash2 className="h-3 w-3" aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

/**
 * The things a learner needs told, and only when they apply.
 *
 * Each of these is a real limitation rather than a disclaimer: a scanned PDF
 * genuinely yields nothing, a truncated file genuinely lost its tail, and the
 * preview genuinely disappears on reload. Saying so at the moment it matters is
 * the difference between a limitation and a bug report.
 */
function Notices({ document: stored, hasPreview, error }) {
  const notices = [];
  if (error) notices.push({ id: 'error', tone: 'error', text: error });
  if (stored.kind === 'pdf' && stored.text.trim() === '')
    notices.push({
      id: 'scanned',
      tone: 'warn',
      text: 'لا يحتوي هذا الملف على طبقة نصية — غالبًا صور ممسوحة ضوئيًا، فلا يمكن قراءته أو استخدامه مع المساعد.',
    });
  if (stored.kind === 'image')
    notices.push({
      id: 'image',
      tone: 'info',
      text: 'الصور تُعرض للمراجعة فقط؛ لا يُستخرج منها نص.',
    });
  if (stored.truncated)
    notices.push({ id: 'truncated', tone: 'warn', text: 'المستند طويل، وحُفظ جزؤه الأول فقط.' });
  if (!hasPreview)
    notices.push({
      id: 'session',
      tone: 'info',
      text: 'النص والتظليلات محفوظة. الملف نفسه لا يُحفظ — أعيدي رفعه لمعاينته مجددًا.',
    });

  if (notices.length === 0) return null;

  return (
    <ul className="shrink-0 space-y-1.5">
      {notices.map((notice) => (
        <li
          key={notice.id}
          role={notice.tone === 'error' ? 'alert' : undefined}
          className={[
            'rounded-xl px-3 py-2 text-[11px] leading-relaxed',
            notice.tone === 'error'
              ? 'bg-surface-alt text-danger'
              : notice.tone === 'warn'
                ? 'bg-primary-light/60 text-text-main'
                : 'bg-surface-alt/60 text-text-muted',
          ].join(' ')}
        >
          {notice.text}
        </li>
      ))}
    </ul>
  );
}
