import { Award, LogIn, Mail, ShieldCheck, UserRound } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useAuth } from '../auth/useAuth.js';
import { Button, LevelDots } from '../components/ui/index.js';
import { enrolledCourses } from '../data/courses.js';

/**
 * The account page — which a guest may also open.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS ROUTE IS NOT GUARDED
 * ---------------------------------------------------------------------------
 *
 * Redirecting a signed-out visitor away from `/profile` is the reflex, and it
 * is the wrong call here. Someone who taps "حسابي" is asking a question — "what
 * is in my account?" — and bouncing them to a login form answers it with a
 * demand. The guest state below answers it instead: here is what an account
 * holds, and here is the one button that creates one.
 *
 * There is nothing to protect by redirecting, either. The page renders the
 * visitor's OWN data or none at all; a guest sees no name, no email and no
 * certificates, because there are none to show — not because a guard hid them.
 */
export default function Profile() {
  const { user, isAuthenticated, signOut } = useAuth();
  const courses = enrolledCourses(isAuthenticated);

  if (!isAuthenticated) return <GuestProfile />;

  const completed = user.certificates.length;

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6 py-2">
      {/* الحساب */}
      <section className="card-surface flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:gap-5 sm:p-6">
        <span
          className="flex h-16 w-16 shrink-0 items-center justify-center rounded-full bg-primary-light text-xl font-bold text-primary"
          aria-hidden="true"
        >
          {user.name.trim()[0]}
        </span>
        <div className="min-w-0 flex-1">
          <h1 className="text-lg font-bold text-text-main">{user.name}</h1>
          <p className="mt-0.5 text-xs text-text-muted">{user.role}</p>
          <p className="mt-2 flex items-center gap-1.5 text-xs text-text-muted">
            <Mail className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            {/* An address is an LTR string; without `dir` the browser reorders
                it inside the Arabic paragraph and it reads as nonsense. */}
            <span dir="ltr" className="truncate">
              {user.email}
            </span>
          </p>
        </div>
        <div className="shrink-0">
          <Button variant="soft" onClick={signOut}>
            تسجيل الخروج
          </Button>
        </div>
      </section>

      {/* حالة الجلسة */}
      <section
        aria-label="حالة الحساب"
        className="flex items-center gap-3 rounded-card border border-primary/20 bg-primary-light/50 px-5 py-4"
      >
        <ShieldCheck className="h-5 w-5 shrink-0 text-primary" aria-hidden="true" />
        <p className="text-xs leading-relaxed text-text-main">
          أنتِ مسجَّلة الدخول منذ {user.memberSince}. جميع الدروس والمحاكاة متاحة لك، ويُحفَظ تقدّمك
          تلقائيًا.
        </p>
      </section>

      {/* ملخّص الدورات */}
      <section aria-labelledby="enrolled-heading">
        <h2 id="enrolled-heading" className="mb-3 text-base font-semibold text-text-main">
          دوراتي
          <span className="ms-2 text-xs font-normal text-text-muted">
            (<span className="tabular-nums">{courses.length}</span>)
          </span>
        </h2>
        <ul className="flex flex-col gap-3">
          {courses.map((course) => (
            <li key={course.id}>
              <Link
                to={`/courses/${course.id}`}
                className="card-surface flex items-center gap-4 p-4 transition-colors duration-200 hover:border-accent-lavender"
              >
                <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-primary-light">
                  <course.Icon className="h-5 w-5 text-primary" aria-hidden="true" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold text-text-main">
                    {course.title}
                  </span>
                  <LevelDots level={course.level} className="mt-1" />
                </span>
                <span className="shrink-0 text-end">
                  <span className="block text-sm font-semibold tabular-nums text-text-main">
                    {course.progress}%
                  </span>
                  <span className="block text-[11px] text-text-muted">مكتمل</span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </section>

      {/* الشهادات */}
      <section aria-labelledby="certificates-heading">
        <h2 id="certificates-heading" className="mb-3 text-base font-semibold text-text-main">
          الشهادات المكتملة
          <span className="ms-2 text-xs font-normal text-text-muted">
            (<span className="tabular-nums">{completed}</span>)
          </span>
        </h2>
        {completed === 0 ? (
          <p className="card-surface px-5 py-8 text-center text-xs text-text-muted">
            لم تكتمل أي شهادة بعد. تُمنح الشهادة عند إنهاء جميع دروس الدورة.
          </p>
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2">
            {user.certificates.map((certificate) => (
              <li key={certificate.id} className="card-surface flex items-start gap-3 p-4">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-accent-lavender">
                  <Award className="h-5 w-5 text-primary" aria-hidden="true" />
                </span>
                <span className="min-w-0">
                  <span className="block text-xs font-semibold leading-snug text-text-main">
                    {certificate.title}
                  </span>
                  <span className="mt-1 block text-[11px] text-text-muted">
                    صدرت في {certificate.issuedAt}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

/**
 * What a guest sees here.
 *
 * It states the account's value in concrete terms rather than as a slogan, and
 * offers exactly one action. A second competing button at this moment is how a
 * decision gets deferred.
 */
function GuestProfile() {
  return (
    <div className="mx-auto flex max-w-xl flex-col gap-5 py-8">
      <section className="card-surface flex flex-col items-center gap-3 p-8 text-center">
        <span
          className="flex h-16 w-16 items-center justify-center rounded-full bg-surface-alt"
          aria-hidden="true"
        >
          <UserRound className="h-8 w-8 text-text-muted" />
        </span>
        <h1 className="text-lg font-bold text-text-main">أنتِ تتصفّحين كزائرة</h1>
        <p className="max-w-sm text-sm leading-relaxed text-text-muted">
          لا يوجد حساب مرتبط بهذه الجلسة، لذلك لا تقدّم ولا شهادات لعرضها بعد. التصفّح مفتوح لك
          بالكامل — الحساب يبدأ عند أول درس.
        </p>
        <Link
          to="/login"
          className="mt-2 inline-flex h-11 items-center gap-2 rounded-full bg-primary px-6 text-sm font-medium text-on-primary shadow-soft transition-colors duration-200 hover:bg-primary-hover"
        >
          <span>تسجيل الدخول</span>
          <LogIn className="h-4 w-4" aria-hidden="true" />
        </Link>
      </section>

      <section aria-labelledby="benefits-heading" className="card-surface p-5">
        <h2 id="benefits-heading" className="text-sm font-semibold text-text-main">
          ما الذي يضيفه الحساب؟
        </h2>
        <ul className="mt-3 flex flex-col gap-2.5">
          {[
            'حفظ موضعك في كل درس عبر أجهزتك',
            'فتح جميع الدروس والمحاكاة التفاعلية',
            'شهادة إتمام عند إنهاء الدورة',
          ].map((benefit) => (
            <li key={benefit} className="flex items-start gap-2.5">
              <span
                className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary"
                aria-hidden="true"
              />
              <span className="text-xs leading-relaxed text-text-muted">{benefit}</span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
