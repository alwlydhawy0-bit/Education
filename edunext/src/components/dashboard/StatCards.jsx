import { Award, BookOpen, Clock, Loader } from 'lucide-react';
import { useAuth } from '../../auth/useAuth.js';
import { COURSES } from '../../data/courses.js';

/**
 * The four headline numbers.
 *
 * TWO DECISIONS WORTH NAMING.
 *
 * 1. THE VALUE AND ITS UNIT ARE SEPARATE FIELDS. "48 ساعة" as one string would
 *    put the Arabic word inside a `tabular-nums` run, and tabular figures
 *    change the advance width of everything in the run — so the unit would sit
 *    at a different distance from the number in each card. Splitting them lets
 *    the digits be tabular and the word not be.
 *
 * 2. THE NUMBER IS NOT THE ACCESSIBLE LABEL. A screen reader moving through
 *    four cards otherwise hears "12", "5", "48", "3" — four numbers with no
 *    subjects. Each card is a `<dl>` pair, so the label and the value are
 *    announced together and in the right order.
 */
/**
 * A GUEST'S NUMBERS ARE NOT A MEMBER'S NUMBERS WITH THE NAMES KEPT.
 *
 * This section used to be a hard-coded "12 دورات مسجّلة / 5 قيد الإنجاز / 48
 * ساعة / 3 شهادات" shown to everyone. Under the freemium model that reads as an
 * outright falsehood to a visitor with no account — and it sat directly beneath
 * a banner inviting them to browse WITHOUT one, on the same screen. Spotted in a
 * dark-theme screenshot while checking something else entirely; no test could
 * have caught it, because the numbers were always going to be exactly what the
 * component said they were.
 *
 * So the guest gets CATALOGUE facts — what the platform contains — and the
 * member gets ACCOUNT facts. Same four cards, same layout, different subject:
 * one describes the product, the other describes you.
 */
const MEMBER_STATS = [
  { id: 'enrolled', label: 'الدورات المسجّلة', value: '12', unit: null, Icon: BookOpen },
  { id: 'active', label: 'قيد الإنجاز', value: '5', unit: null, Icon: Loader },
  { id: 'hours', label: 'الساعات المكتملة', value: '48', unit: 'ساعة', Icon: Clock },
  { id: 'certificates', label: 'الشهادات المكتسبة', value: '3', unit: null, Icon: Award },
];

/** Derived from the catalogue, so these cannot drift from what /courses shows. */
const GUEST_STATS = [
  {
    id: 'catalogue',
    label: 'دورة متاحة',
    value: String(COURSES.length),
    unit: null,
    Icon: BookOpen,
  },
  {
    id: 'lessons',
    label: 'درسًا',
    value: String(COURSES.reduce((total, course) => total + course.lessonCount, 0)),
    unit: null,
    Icon: Loader,
  },
  {
    id: 'hours',
    label: 'من المحتوى',
    value: String(COURSES.reduce((total, course) => total + course.durationHours, 0)),
    unit: 'ساعة',
    Icon: Clock,
  },
  {
    id: 'free',
    label: 'درسًا مجانيًا للتجربة',
    value: String(
      COURSES.reduce(
        (total, course) =>
          total +
          course.syllabus.reduce(
            (units, unit) => units + unit.lessons.filter((lesson) => lesson.free).length,
            0,
          ),
        0,
      ),
    ),
    unit: null,
    Icon: Award,
  },
];

export default function StatCards() {
  const { isAuthenticated } = useAuth();
  const stats = isAuthenticated ? MEMBER_STATS : GUEST_STATS;

  return (
    <section aria-labelledby="stats-heading">
      <h2 id="stats-heading" className="sr-only">
        {isAuthenticated ? 'إحصائياتك' : 'المنصة بالأرقام'}
      </h2>

      <dl className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {stats.map(({ id, label, value, unit, Icon }) => (
          <div
            key={id}
            className="card-surface flex items-center gap-3 p-4 transition-all duration-200 hover:-translate-y-0.5 hover:border-accent-lavender hover:shadow-soft sm:gap-4 sm:p-5"
          >
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-primary-light sm:h-11 sm:w-11">
              <Icon className="h-5 w-5 text-primary" aria-hidden="true" />
            </span>

            <div className="min-w-0">
              {/* Value before label in the DOM so the visual hierarchy needs no
                  reordering; <dl> keeps the pairing explicit either way. */}
              <dd className="flex items-baseline gap-1 text-xl font-bold leading-none text-text-main sm:text-2xl">
                <span className="tabular-nums">{value}</span>
                {unit ? <span className="text-xs font-medium text-text-muted">{unit}</span> : null}
              </dd>
              <dt className="mt-1.5 truncate text-[11px] text-text-muted sm:text-xs">{label}</dt>
            </div>
          </div>
        ))}
      </dl>
    </section>
  );
}
