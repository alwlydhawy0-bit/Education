import { CalendarDays, FileText, Users, Video } from 'lucide-react';

/**
 * The week ahead: live sessions and quizzes.
 *
 * ARABIC WEEKS START ON SUNDAY. The array below runs الأحد → السبت, which is
 * the order a reader expects, and the row lays out right-to-left from source
 * order — so Sunday sits on the right with no reordering. Copying a Monday-first
 * week from an English design would put the wrong day under "today" for every
 * user, every day.
 *
 * TIMES ARE `dir="ltr"`. "10:00 - 11:00" is a bidirectional string: rendered in
 * an RTL paragraph the browser reorders it to "11:00 - 10:00" — the same
 * characters, the wrong meaning, and a learner arrives an hour late. This is
 * the single most common Arabic-UI bug involving numbers, and the fix is one
 * attribute.
 *
 * "TODAY" IS COMPUTED, NOT HARD-CODED. A dashboard with a fixed highlighted day
 * is right one day in seven.
 */
/*
 * SHORT NAMES VISIBLE, FULL NAMES ANNOUNCED.
 *
 * Seven cells have to fit a card that is a fraction of the screen at every
 * width. With "الأربعاء" as the visible label the strip scrolled and showed
 * five days of seven — a weekly view that cannot show a week. Dropping the
 * definite article is the ordinary Arabic abbreviation and buys the room.
 *
 * The full name stays as the accessible name, for the same reason the phone
 * navigation keeps "الملف الشخصي" behind "حسابي": an abbreviation invented to
 * fit a 44px cell is not what a screen reader should read out.
 */
const DAYS = [
  { id: 0, short: 'أحد', full: 'الأحد' },
  { id: 1, short: 'إثنين', full: 'الإثنين' },
  { id: 2, short: 'ثلاثاء', full: 'الثلاثاء' },
  { id: 3, short: 'أربعاء', full: 'الأربعاء' },
  { id: 4, short: 'خميس', full: 'الخميس' },
  { id: 5, short: 'جمعة', full: 'الجمعة' },
  { id: 6, short: 'سبت', full: 'السبت' },
];

const KIND_STYLES = {
  live: { Icon: Video, tone: 'bg-primary-light text-primary', label: 'جلسة مباشرة' },
  quiz: { Icon: FileText, tone: 'bg-accent-lavender/50 text-primary-hover', label: 'اختبار قصير' },
  workshop: { Icon: Users, tone: 'bg-surface-alt text-text-main', label: 'ورشة عمل' },
};

/** `day` matches `Date.getDay()`: 0 = Sunday. */
const SESSIONS = [
  { id: 's1', day: 0, time: '10:00 - 11:00', title: 'تحليل البيانات — جلسة مباشرة', kind: 'live' },
  { id: 's2', day: 1, time: '14:00 - 15:00', title: 'React — مراجعة المشروع', kind: 'workshop' },
  { id: 's3', day: 3, time: '18:00 - 18:30', title: 'اختبار الوحدة الثالثة', kind: 'quiz' },
  { id: 's4', day: 4, time: '19:00 - 20:00', title: 'UI/UX — نقد التصاميم', kind: 'live' },
];

export default function WeeklySchedule({ today = new Date().getDay() }) {
  const upcoming = SESSIONS.filter((session) => session.day >= today);
  // Everything is behind us — say so rather than showing an empty box.
  const list = upcoming.length > 0 ? upcoming : [];

  return (
    /*
     * `min-w-0` IS WHAT MAKES THE DAY STRIP SCROLL INSTEAD OF PUSHING THE PAGE.
     *
     * Flex and grid items default to `min-width: auto`, meaning they refuse to
     * shrink below their content's intrinsic width. This card is a flex child
     * on a phone and a grid child at `xl`, so without this the seven
     * minimum-width day cells widened the card, the card widened the row, and
     * the whole document scrolled sideways — the `overflow-x-auto` on the strip
     * never got a chance to do its job because its container was never
     * constrained.
     */
    <section aria-labelledby="schedule-heading" className="card-surface min-w-0 p-5">
      <div className="mb-4 flex items-center gap-2">
        <CalendarDays className="h-[18px] w-[18px] shrink-0 text-primary" aria-hidden="true" />
        <h2 id="schedule-heading" className="text-base font-semibold text-text-main">
          جدول التعلّم الأسبوعي
        </h2>
      </div>

      {/* شريط الأيام */}
      <ol className="mb-5 flex gap-1.5 overflow-x-auto pb-1" aria-label="أيام الأسبوع">
        {DAYS.map((day) => {
          const isToday = day.id === today;
          const count = SESSIONS.filter((s) => s.day === day.id).length;
          return (
            /*
             * A minimum width so a label is never clipped, sized to the longest
             * SHORT name rather than the longest full one. The strip still
             * scrolls on a very narrow phone, which is the right fallback —
             * what it must not do is silently ellipsize a day name.
             */
            <li key={day.id} className="min-w-[2.5rem] flex-1">
              <div
                aria-current={isToday ? 'date' : undefined}
                className={[
                  'flex flex-col items-center gap-1 rounded-xl px-1 py-2 text-center transition-colors',
                  isToday ? 'bg-primary text-white' : 'bg-surface-alt/60 text-text-muted',
                ].join(' ')}
              >
                <span aria-hidden="true" className="w-full text-[10px] font-medium leading-none">
                  {day.short}
                </span>
                {/* A dot per session — a count nobody has to read. */}
                <span className="flex h-1.5 items-center gap-0.5" aria-hidden="true">
                  {Array.from({ length: count }).map((_, index) => (
                    <span
                      key={index}
                      className={`h-1.5 w-1.5 rounded-full ${isToday ? 'bg-white/70' : 'bg-primary/40'}`}
                    />
                  ))}
                </span>
                <span className="sr-only">
                  {day.full}: {count > 0 ? `${count} مواعيد` : 'لا مواعيد'}
                </span>
              </div>
            </li>
          );
        })}
      </ol>

      {/* المواعيد القادمة */}
      {list.length === 0 ? (
        <p className="rounded-card bg-surface-alt/50 px-4 py-6 text-center text-sm text-text-muted">
          لا مواعيد متبقّية هذا الأسبوع. استمتع بوقتك.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {list.map(({ id, day, time, title, kind }) => {
            const { Icon, tone, label } = KIND_STYLES[kind];
            return (
              <li
                key={id}
                className="flex items-center gap-3 rounded-card border border-accent-subtle bg-surface-alt/40 p-3 transition-colors duration-200 hover:border-accent-lavender hover:bg-primary-light/40"
              >
                <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${tone}`}>
                  <Icon className="h-4 w-4" aria-hidden="true" />
                </span>

                <div className="min-w-0 flex-1">
                  <p className="line-clamp-2 text-sm font-medium leading-snug text-text-main">
                    {title}
                  </p>
                  <p className="mt-0.5 flex items-center gap-2 text-[11px] text-text-muted">
                    <span>{DAYS[day].full}</span>
                    <span aria-hidden="true">·</span>
                    {/*
                      dir="ltr" is load-bearing. Without it the browser reorders
                      "10:00 - 11:00" to read "11:00 - 10:00" inside the RTL
                      paragraph — same characters, wrong meaning, learner an hour
                      late.
                    */}
                    <span dir="ltr" className="tabular-nums">
                      {time}
                    </span>
                  </p>
                </div>

                <span className="shrink-0 rounded-full bg-surface px-2.5 py-1 text-[10px] font-medium text-text-muted">
                  {label}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
