import { NotebookPen, Sparkles } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { COURSES } from '../data/courses.js';
import { loadNote } from '../components/tools/notes-storage.js';
import { loadDocument } from '../components/tools/document-store.js';

/**
 * `/assistant` and `/notebook` — choosing which course a tool opens against.
 *
 * ---------------------------------------------------------------------------
 * WHY THESE ROUTES EXIST AT ALL
 * ---------------------------------------------------------------------------
 *
 * Both tools are scoped to one course: the notebook writes to
 * `edunext:notes:<courseId>`, the annotator to `edunext:doc:<courseId>`, and
 * every assistant answer is grounded in the course it was opened from. The
 * navigation drawer, however, is on every page — so tapping "المساعد الذكي"
 * from the home screen used to resolve to `navigate('/courses')`: the drawer
 * closed, the "اختاري دورة أولًا" hint closed with it, and the learner landed
 * on the catalogue with no sign of what they had been trying to do. Measured
 * across five routes, four of them opened nothing at all.
 *
 * Refusing to guess a course was right; dropping the intent was not. This page
 * keeps it. It says which tool is being opened, lists the courses, and every
 * choice lands on `/courses/:id?tool=…` — the same URL the course page's own
 * buttons produce, so there is one way in and not two.
 *
 * ---------------------------------------------------------------------------
 * COURSES WITH SAVED WORK COME FIRST
 * ---------------------------------------------------------------------------
 *
 * A learner reaching for the notebook usually wants the notebook they already
 * have, not a blank one. Reading the storage keys costs nothing here — the
 * catalogue is small and this runs once on mount — and turns the list from a
 * chore into a shortcut. Courses with nothing saved still appear, because
 * starting a new one has to stay possible.
 */

const TOOLS = {
  assistant: {
    title: 'المساعد الذكي',
    lead: 'المساعد يجيب من دروس دورة بعينها ويشير إلى مصدر كل إجابة. اختاري الدورة التي تسألين عنها.',
    Icon: Sparkles,
    cta: 'افتحي المساعد',
    /** Has this course anything the assistant can already draw on? */
    savedFor: (id) => loadDocument(id) !== null,
    savedLabel: 'يوجد مستند مرفوع',
  },
  notes: {
    title: 'دفتر الملاحظات والرسومات',
    lead: 'لكل دورة دفترها الخاص، بملاحظاتها ورسوماتها ومستنداتها. اختاري الدورة التي تريدين فتح دفترها.',
    Icon: NotebookPen,
    cta: 'افتحي الدفتر',
    /*
     * `loadNote` NEVER RETURNS NULL — it returns `EMPTY_NOTE` for a course
     * with nothing saved, so `!== null` was true for every course in the
     * catalogue and all three were labelled "يوجد عمل محفوظ". Caught by
     * seeding exactly ONE course and seeing three marked.
     *
     * The question is whether there is CONTENT, so that is what is asked.
     */
    savedFor: (id) => {
      const note = loadNote(id);
      return note.markdown.trim() !== '' || note.drawing !== null || loadDocument(id) !== null;
    },
    savedLabel: 'يوجد عمل محفوظ',
  },
};

export default function ToolLauncher({ tool }) {
  const navigate = useNavigate();
  const config = TOOLS[tool];
  const { Icon } = config;

  /*
   * Read once, at render, rather than in an effect. The values come from
   * `localStorage` synchronously and cannot change while this page is open —
   * an effect would only add a frame where every course looks empty.
   */
  const courses = COURSES.map((course) => ({ ...course, saved: config.savedFor(course.id) }));
  const ordered = [...courses].sort((a, b) => Number(b.saved) - Number(a.saved));

  return (
    <div className="mx-auto w-full max-w-3xl py-2">
      <header className="mb-5 flex items-start gap-3">
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-primary-light">
          <Icon className="h-5 w-5 text-primary" aria-hidden="true" />
        </span>
        <div className="min-w-0">
          <h1 className="text-lg font-semibold text-text-main">{config.title}</h1>
          <p className="mt-1 text-sm leading-relaxed text-text-muted">{config.lead}</p>
        </div>
      </header>

      <ul className="flex flex-col gap-2.5">
        {ordered.map((course) => (
          <li key={course.id}>
            <button
              type="button"
              onClick={() => navigate(`/courses/${course.id}?tool=${tool}`)}
              className="flex w-full items-center gap-3 rounded-2xl border border-accent-subtle bg-surface p-3.5 text-start transition-colors duration-200 hover:border-primary hover:bg-primary-light focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
            >
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary-light">
                <course.Icon className="h-4 w-4 text-primary" aria-hidden="true" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-text-main">
                  {course.title}
                </span>
                <span className="mt-0.5 block truncate text-xs text-text-muted">
                  {course.saved ? config.savedLabel : course.summary}
                </span>
              </span>
              {/*
                The saved marker is a DOT plus a word in the accessible name,
                never colour alone — and the name says what the button does,
                because "أساسيات تحليل البيانات" on its own does not tell a
                screen-reader user that activating it opens a tool.
              */}
              {course.saved ? (
                <span
                  className="h-2 w-2 shrink-0 rounded-full bg-primary"
                  aria-hidden="true"
                  title={config.savedLabel}
                />
              ) : null}
              <span className="sr-only">
                — {config.cta}
                {course.saved ? `، ${config.savedLabel}` : ''}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
