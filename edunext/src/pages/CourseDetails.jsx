import { ArrowLeft, Check, Clock, Lock, Play, Star, Users } from 'lucide-react';
import { Link, useParams } from 'react-router-dom';
import { useGuardedAction } from '../auth/useGuardedAction.js';
import { useAuth } from '../auth/useAuth.js';
import { Button, LevelDots } from '../components/ui/index.js';
import { getCourse } from '../data/courses.js';

/**
 * One course: what it covers, what it costs in time, and how to start it.
 *
 * ---------------------------------------------------------------------------
 * A GUEST SEES EVERYTHING EXCEPT THE LESSONS THEMSELVES
 * ---------------------------------------------------------------------------
 *
 * The syllabus is fully visible without an account — every unit, every lesson
 * title, every duration. That is the page's job under a freemium model: it is
 * the argument for signing up, and an argument you have to sign up to read
 * persuades nobody.
 *
 * What changes with authentication is which lessons can be OPENED. Lessons
 * marked `free` in the catalogue are previews anyone may watch; the rest send a
 * guest to `/login` with a reason attached, via `useGuardedAction`.
 *
 * Worth being precise about, because the padlock icon invites the wrong
 * reading: this is not access control. The client holds no lesson content to
 * protect — a real player fetches it, and the server is what decides whether to
 * send it. The lock communicates a boundary that is enforced elsewhere.
 *
 * ---------------------------------------------------------------------------
 * AN UNKNOWN ID IS A STATE, NOT AN ERROR
 * ---------------------------------------------------------------------------
 *
 * `courseId` comes from the URL, so anyone can type one that does not exist.
 * `getCourse` returns `undefined` for those and this component renders a real
 * "not found" panel with a way back to the catalogue. Reaching straight for
 * `course.title` would instead blank the entire app on a typo.
 */
export default function CourseDetails() {
  const { courseId } = useParams();
  const course = getCourse(courseId);
  const { isAuthenticated } = useAuth();
  const guard = useGuardedAction();

  if (!course) return <CourseNotFound id={courseId} />;

  const {
    title,
    description,
    level,
    durationHours,
    lessonCount,
    learners,
    rating,
    outcomes,
    syllabus,
    progress,
    Icon,
  } = course;

  // Progress is the DEMO learner's. A guest is enrolled in nothing, so the bar
  // is absent for them rather than sitting at zero — zero claims they started.
  const enrolled = isAuthenticated;

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6 py-2">
      <nav aria-label="مسار التنقّل" className="text-xs text-text-muted">
        <Link to="/courses" className="transition-colors hover:text-primary">
          الدورات
        </Link>
        <span className="mx-2" aria-hidden="true">
          /
        </span>
        <span className="text-text-main">{title}</span>
      </nav>

      <div className="grid gap-6 xl:grid-cols-3">
        {/* العمود الرئيسي */}
        <div className="flex min-w-0 flex-col gap-6 xl:col-span-2">
          <header className="card-surface p-5 sm:p-6">
            <div className="flex items-start gap-4">
              <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-primary-light">
                <Icon className="h-7 w-7 text-primary" aria-hidden="true" />
              </span>
              <div className="min-w-0">
                <h1 className="text-lg font-bold leading-snug text-text-main sm:text-xl">
                  {title}
                </h1>
                <LevelDots level={level} className="mt-2" />
              </div>
            </div>

            <p className="mt-4 text-sm leading-relaxed text-text-muted">{description}</p>

            <dl className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat Icon={Clock} label="مدّة الدورة" value={`${durationHours} ساعة`} />
              <Stat Icon={Play} label="عدد الدروس" value={`${lessonCount} درسًا`} />
              <Stat Icon={Users} label="المتعلّمات" value={learners.toLocaleString('en-US')} />
              <Stat Icon={Star} label="التقييم" value={`${rating} / 5`} />
            </dl>
          </header>

          {/* مشغّل الفيديو */}
          <VideoPlaceholder title={title} enrolled={enrolled} guard={guard} />

          {/* المنهج */}
          <section aria-labelledby="syllabus-heading" className="card-surface p-5 sm:p-6">
            <h2 id="syllabus-heading" className="text-base font-semibold text-text-main">
              محتوى الدورة
            </h2>
            <p className="mt-1 text-xs text-text-muted">
              الدروس المعلَّمة بعلامة «مجاني» متاحة للجميع دون حساب.
            </p>

            <ol className="mt-4 flex flex-col gap-5">
              {syllabus.map((unit) => (
                <li key={unit.title}>
                  <h3 className="text-sm font-semibold text-text-main">{unit.title}</h3>
                  <ul className="mt-2 flex flex-col gap-1">
                    {unit.lessons.map((lesson) => (
                      <li key={lesson.title}>
                        <LessonRow
                          lesson={lesson}
                          unlocked={lesson.free || enrolled}
                          guard={guard}
                        />
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ol>
          </section>
        </div>

        {/* العمود الجانبي */}
        <aside className="flex min-w-0 flex-col gap-6">
          <EnrolCard enrolled={enrolled} progress={progress} title={title} guard={guard} />

          <section aria-labelledby="outcomes-heading" className="card-surface p-5">
            <h2 id="outcomes-heading" className="text-sm font-semibold text-text-main">
              ماذا ستتقنين؟
            </h2>
            <ul className="mt-3 flex flex-col gap-2.5">
              {outcomes.map((outcome) => (
                <li key={outcome} className="flex items-start gap-2.5">
                  <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-primary-light">
                    <Check className="h-2.5 w-2.5 text-primary" aria-hidden="true" />
                  </span>
                  <span className="text-xs leading-relaxed text-text-muted">{outcome}</span>
                </li>
              ))}
            </ul>
          </section>
        </aside>
      </div>
    </div>
  );
}

function Stat({ Icon, label, value }) {
  return (
    <div className="rounded-2xl bg-surface-alt/60 p-3">
      <dt className="flex items-center gap-1.5 text-[11px] text-text-muted">
        <Icon className="h-3.5 w-3.5" aria-hidden="true" />
        {label}
      </dt>
      <dd className="mt-1 text-sm font-semibold tabular-nums text-text-main">{value}</dd>
    </div>
  );
}

/**
 * Where the player will be.
 *
 * It is a PLACEHOLDER and says so, rather than embedding a stock video that
 * implies the lesson exists. `aspect-video` with `max-w-full` keeps it to 16:9
 * at every width without a fixed height that would letterbox on a phone.
 */
function VideoPlaceholder({ title, enrolled, guard }) {
  return (
    <section aria-label="مشغّل الدرس" className="card-surface overflow-hidden p-0">
      <div className="relative flex aspect-video max-w-full items-center justify-center bg-gradient-to-bl from-primary-light to-accent-lavender/50">
        <button
          type="button"
          onClick={guard(() => undefined, 'لبدء مشاهدة الدرس')}
          aria-label={enrolled ? `تشغيل: ${title}` : `سجّلي الدخول لمشاهدة: ${title}`}
          className="flex h-16 w-16 items-center justify-center rounded-full bg-primary text-on-primary shadow-soft transition-transform duration-200 hover:scale-105"
        >
          <Play className="h-7 w-7" aria-hidden="true" />
        </button>
      </div>
      <p className="px-5 py-3 text-[11px] text-text-muted">
        مشغّل الدروس قيد التطوير — هذه مساحته المخصّصة في التخطيط.
      </p>
    </section>
  );
}

function LessonRow({ lesson, unlocked, guard }) {
  const { title, minutes, free } = lesson;

  return (
    <button
      type="button"
      onClick={guard(() => undefined, 'لفتح هذا الدرس')}
      className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-start transition-colors duration-200 hover:bg-primary-light/60"
    >
      <span
        className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${
          unlocked ? 'bg-primary-light text-primary' : 'bg-surface-alt text-text-muted'
        }`}
        aria-hidden="true"
      >
        {unlocked ? <Play className="h-3 w-3" /> : <Lock className="h-3 w-3" />}
      </span>

      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs font-medium text-text-main">{title}</span>
      </span>

      {free ? (
        <span className="shrink-0 rounded-full bg-primary-light px-2 py-0.5 text-[10px] font-medium text-primary">
          مجاني
        </span>
      ) : null}
      <span className="shrink-0 text-[11px] tabular-nums text-text-muted">{minutes} د</span>
      {/* The lock state is repeated in text for anyone who cannot see the icon. */}
      {!unlocked ? <span className="sr-only">يتطلّب تسجيل الدخول</span> : null}
    </button>
  );
}

/**
 * The enrolment panel: the one control the whole page is arguing for.
 *
 * Its label changes with the visitor rather than its behaviour branching at the
 * click: a member sees "متابعة التعلّم" and a guest sees "سجّلي الآن — مجانًا",
 * because a button that says one thing and does another is how trust is lost in
 * a funnel.
 */
function EnrolCard({ enrolled, progress, title, guard }) {
  return (
    <section aria-label="التسجيل في الدورة" className="card-surface p-5">
      {enrolled ? (
        <>
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
          <Button
            withArrow
            className="mt-5 w-full"
            onClick={guard(() => undefined, 'لمتابعة الدرس')}
          >
            متابعة التعلّم
          </Button>
        </>
      ) : (
        <>
          <p className="text-sm font-semibold text-text-main">ابدئي هذه الدورة</p>
          <p className="mt-1.5 text-xs leading-relaxed text-text-muted">
            التسجيل مجاني، ويحفظ تقدّمك عبر أجهزتك. يمكنك تجربة الدروس المجانية أولًا.
          </p>
          <Button
            withArrow
            className="mt-4 w-full"
            onClick={guard(() => undefined, 'للتسجيل في الدورة')}
          >
            سجّلي الآن — مجانًا
          </Button>
          <Button
            variant="soft"
            className="mt-2 w-full"
            onClick={guard(() => undefined, 'لتجربة التطبيق التفاعلي')}
          >
            تجربة التطبيق
          </Button>
        </>
      )}
    </section>
  );
}

function CourseNotFound({ id }) {
  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-3 py-16 text-center">
      <h1 className="text-lg font-bold text-text-main">لم نعثر على هذه الدورة</h1>
      <p className="text-sm leading-relaxed text-text-muted">
        الرابط الذي فتحتِه لا يطابق أي دورة في الكتالوج
        {id ? <span dir="ltr"> ({id})</span> : null}. ربما تغيّر العنوان، أو كان به خطأ مطبعي.
      </p>
      <Link
        to="/courses"
        className="mt-2 inline-flex h-11 items-center gap-2 rounded-full bg-primary px-6 text-sm font-medium text-on-primary shadow-soft transition-colors duration-200 hover:bg-primary-hover"
      >
        <span>تصفّحي كل الدورات</span>
        <ArrowLeft className="h-4 w-4" aria-hidden="true" />
      </Link>
    </div>
  );
}
