import { ArrowLeft, Play } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useAuth } from '../../auth/useAuth.js';
import { useGuardedAction } from '../../auth/useGuardedAction.js';
import { COURSES, enrolledCourses } from '../../data/courses.js';

/**
 * The courses in progress.
 *
 * THE PROGRESS BAR IS THE INTERESTING PART, for two reasons that both come
 * from RTL:
 *
 * 1. THE FILL MUST GROW FROM THE READING START. A plain `<div>` with a width
 *    fills from the inline-start edge, which in RTL is the RIGHT — correct, and
 *    free. Any absolute positioning here (`left-0`, `right-0`) would pin it to
 *    a physical edge and be wrong in one direction or the other.
 *
 * 2. IT IS A `role="progressbar"`, NOT A DECORATED DIV. Without the role and
 *    the `aria-valuenow`, the completion figure exists only as a visual — a
 *    screen reader gets a percentage in the text beside it if it happens to be
 *    rendered, and nothing at all if a designer later moves that percentage
 *    into the bar itself.
 *
 * `aria-label` carries the course name so a learner tabbing through three bars
 * hears which course each one belongs to.
 */
/** The catalogue stores difficulty as a key; the dashboard card shows a phrase. */
const LEVEL_LABELS = {
  beginner: 'مستوى مبتدئ',
  intermediate: 'مستوى متوسط',
  advanced: 'مستوى متقدّم',
};

export default function CourseGrid() {
  const { isAuthenticated } = useAuth();

  /*
   * A GUEST HAS NO "CURRENT COURSES", so this section changes what it IS rather
   * than showing the same cards with the numbers blanked. Progress belongs to a
   * person: rendering three cards at 0% would claim the visitor started three
   * courses and abandoned every one of them.
   */
  const courses = enrolledCourses(isAuthenticated);
  const heading = isAuthenticated ? 'الدورات الحالية' : 'دورات مختارة';

  return (
    <section aria-labelledby="courses-heading">
      <div className="mb-3 flex items-center justify-between gap-4">
        <h2 id="courses-heading" className="text-base font-semibold text-text-main">
          {heading}
        </h2>
        <Link
          to="/courses"
          className="inline-flex items-center gap-1 rounded-full px-2 py-1 text-xs font-medium text-primary transition-colors duration-200 hover:bg-primary-light"
        >
          <span>عرض الكل</span>
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
        </Link>
      </div>

      {/*
        TWO COLUMNS MAX, not three.

        This grid lives inside the dashboard's 2-of-3 column at `xl`, so a
        third column would make each card about 220px — at which point the
        course TITLE truncates, and the title is the card's identity. Two
        columns of ~330px fit every title in the catalogue. Caught by looking
        at a 1280px screenshot; the overflow metrics said nothing, because
        nothing overflowed — it was all quietly clipped instead.
      */}
      <ul className="grid gap-4 sm:grid-cols-2">
        {(courses.length > 0 ? courses : COURSES.slice(0, 2)).map((course) => (
          <li key={course.id}>
            <CourseCard course={course} showProgress={isAuthenticated} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function CourseCard({ course, showProgress }) {
  const { id, title, level, progress, lastLesson, summary, Icon } = course;
  const guard = useGuardedAction();

  return (
    <article className="card-surface flex h-full flex-col gap-4 p-5 transition-all duration-200 hover:-translate-y-0.5 hover:border-accent-lavender hover:shadow-[0_8px_28px_-4px_rgba(30,27,75,0.08)]">
      <div className="flex items-start gap-3">
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-primary-light">
          <Icon className="h-5 w-5 text-primary" aria-hidden="true" />
        </span>
        <div className="min-w-0">
          {/* `line-clamp-2`, not `truncate`: a course title that does not fit
              should wrap, not become an ellipsis. */}
          <h3 className="line-clamp-2 text-sm font-semibold leading-snug text-text-main">
            {title}
          </h3>
          <p className="mt-0.5 text-xs text-text-muted">{LEVEL_LABELS[level] ?? level}</p>
        </div>
      </div>

      {/* التقدّم — للأعضاء فقط */}
      {showProgress ? (
        <div>
          <div className="mb-1.5 flex items-baseline justify-between gap-2 text-xs">
            <span className="text-text-muted">نسبة الإنجاز</span>
            <span className="font-semibold tabular-nums text-text-main">{progress}%</span>
          </div>
          <div
            role="progressbar"
            aria-valuenow={progress}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={`نسبة الإنجاز في ${title}`}
            className="h-2 w-full overflow-hidden rounded-full bg-surface-alt"
          >
            {/* Fills from the inline-start edge, which RTL puts on the right.
                No positioning, so it is correct in either direction. */}
            <div
              className="h-full rounded-full bg-primary transition-[width] duration-500"
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>
      ) : (
        <p className="line-clamp-2 text-xs leading-relaxed text-text-muted">{summary}</p>
      )}

      {/* `mt-auto` keeps the button on the baseline across cards whose titles
          wrap to different heights. */}
      <div className="mt-auto flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        {/*
          THE LESSON LABEL ALWAYS TAKES ITS OWN LINE (`basis-full`).
          
          Two earlier attempts tuned a minimum width so it would wrap when the
          row got tight — and both were width arithmetic that held at one
          breakpoint and broke at the next, because the card width changes with
          every column-count change above it. Giving the label its own row is
          not a compromise for narrow cards; it is the same layout at every
          width, which is one fewer thing to re-derive the next time the grid
          changes.
        */}
        <p className="basis-full truncate text-[11px] text-text-muted" title={lastLesson}>
          {showProgress ? lastLesson : 'ابدئي من الدرس الأول'}
        </p>
        {/*
          TWO CONTROLS, TWO DIFFERENT KINDS OF THING. Reading about a course is
          navigation and belongs in a <Link> — it should open in a new tab on a
          middle click and be copyable as a URL. Resuming a lesson is an ACTION
          a guest may not take, so it stays a <button> behind `guard`.
        */}
        <div className="flex shrink-0 items-center gap-2">
          <Link
            to={`/courses/${id}`}
            className="inline-flex h-9 items-center rounded-full px-3 text-xs font-medium text-text-muted transition-colors duration-200 hover:bg-surface-alt hover:text-text-main"
          >
            التفاصيل
          </Link>
          <button
            type="button"
            onClick={guard(() => undefined, 'لمتابعة الدرس')}
            aria-label={showProgress ? `متابعة ${title}` : `ابدئي ${title}`}
            className="inline-flex h-9 items-center gap-1.5 rounded-full bg-primary-light px-4 text-xs font-medium text-primary transition-colors duration-200 hover:bg-primary hover:text-white"
          >
            <span>{showProgress ? 'متابعة' : 'ابدئي'}</span>
            <Play className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </div>
      </div>
    </article>
  );
}
