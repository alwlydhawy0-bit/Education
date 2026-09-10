import { Award, BookOpen, Clock, Loader } from 'lucide-react';

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
const STATS = [
  { id: 'enrolled', label: 'الدورات المسجّلة', value: '12', unit: null, Icon: BookOpen },
  { id: 'active', label: 'قيد الإنجاز', value: '5', unit: null, Icon: Loader },
  { id: 'hours', label: 'الساعات المكتملة', value: '48', unit: 'ساعة', Icon: Clock },
  { id: 'certificates', label: 'الشهادات المكتسبة', value: '3', unit: null, Icon: Award },
];

export default function StatCards() {
  return (
    <section aria-labelledby="stats-heading">
      <h2 id="stats-heading" className="sr-only">
        إحصائياتك
      </h2>

      <dl className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {STATS.map(({ id, label, value, unit, Icon }) => (
          <div
            key={id}
            className="card-surface flex items-center gap-3 p-4 transition-all duration-200 hover:-translate-y-0.5 hover:border-accent-lavender hover:shadow-[0_8px_28px_-4px_rgba(30,27,75,0.08)] sm:gap-4 sm:p-5"
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
