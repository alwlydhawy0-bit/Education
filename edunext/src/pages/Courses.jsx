import { useMemo } from 'react';
import { Search, SlidersHorizontal } from 'lucide-react';
import { useSearchParams } from 'react-router-dom';
import { CourseCard } from '../components/ui/index.js';
import { CATEGORIES, COURSES } from '../data/courses.js';

/**
 * The public catalogue: search, filter, browse.
 *
 * ---------------------------------------------------------------------------
 * THIS PAGE IS THE FREEMIUM MODEL'S SHOP WINDOW
 * ---------------------------------------------------------------------------
 *
 * It is fully usable without an account, and deliberately shows no progress
 * figures at all — not even zeroes. Progress belongs to a person; a catalogue
 * describes courses, and mixing the two is how a guest ends up looking at
 * somebody else's 65%.
 *
 * ---------------------------------------------------------------------------
 * THE FILTER STATE LIVES IN THE URL
 * ---------------------------------------------------------------------------
 *
 * `?q=react&cat=data` rather than two `useState` calls, for three reasons that
 * only the first is obvious:
 *
 * 1. A filtered view can be shared, bookmarked and restored by the Back button.
 * 2. The header's search field can hand this page a query by NAVIGATING to it,
 *    which is what turned that field from decoration into a working control.
 *    Component state would have needed a store or a prop drilled through the
 *    layout to achieve the same thing.
 * 3. There is one source of truth. Two inputs that both filter the same list
 *    cannot disagree when the URL is the only thing either of them writes to.
 *
 * `replace: true` on every filter change keeps the history clean: typing six
 * characters into the search box should leave one entry behind, not six that
 * the Back button then walks through one keystroke at a time.
 */
export default function Courses() {
  const [params, setParams] = useSearchParams();
  const query = params.get('q') ?? '';
  const category = params.get('cat') ?? 'all';

  /** Writes one filter key, preserving the other, and drops empty values. */
  const setFilter = (key, value) => {
    const next = new URLSearchParams(params);
    if (value === '' || value === 'all') next.delete(key);
    else next.set(key, value);
    setParams(next, { replace: true });
  };

  const results = useMemo(() => {
    /*
     * Normalised once, outside the loop. Arabic search also needs the query
     * trimmed — a trailing space from a phone keyboard's autocomplete would
     * otherwise silently match nothing and look like an empty catalogue.
     */
    const needle = query.trim().toLowerCase();
    return COURSES.filter((course) => {
      if (category !== 'all' && course.category !== category) return false;
      if (needle === '') return true;
      return (
        course.title.toLowerCase().includes(needle) || course.summary.toLowerCase().includes(needle)
      );
    });
  }, [query, category]);

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6 py-2">
      <header>
        <h1 className="text-xl font-bold text-text-main sm:text-2xl">استكشفي الدورات</h1>
        <p className="mt-1.5 text-sm leading-relaxed text-text-muted">
          تصفّحي المحتوى كاملًا قبل أن تقرّري. لا حاجة إلى حساب للاطّلاع.
        </p>
      </header>

      {/* البحث والتصفية */}
      <section className="card-surface flex flex-col gap-4 p-4 sm:p-5" aria-label="تصفية الدورات">
        <div className="relative">
          {/* `start-3` + `ps-10`: both flip with the writing direction, so the
              icon sits on the right here and would sit left in an LTR build. */}
          <Search
            className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted"
            aria-hidden="true"
          />
          <input
            type="search"
            value={query}
            onChange={(event) => setFilter('q', event.target.value)}
            aria-label="ابحثي في الدورات"
            placeholder="ابحثي باسم الدورة أو موضوعها..."
            className="h-11 w-full rounded-full border border-accent-subtle bg-canvas ps-10 pe-4 text-sm text-text-main placeholder:text-text-muted focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
          />
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1.5 text-xs font-medium text-text-muted">
            <SlidersHorizontal className="h-3.5 w-3.5" aria-hidden="true" />
            التصنيف
          </span>
          {/*
            `aria-pressed` rather than `aria-current`: these are toggles that
            change what the list shows, not links to a place. A screen reader
            should hear "pressed", which is what they are.
          */}
          {CATEGORIES.map(({ id, label }) => (
            <button
              key={id}
              type="button"
              onClick={() => setFilter('cat', id)}
              aria-pressed={category === id}
              className={[
                'rounded-full px-3.5 py-1.5 text-xs font-medium transition-colors duration-200',
                category === id
                  ? 'bg-primary text-white shadow-soft'
                  : 'bg-surface-alt text-text-muted hover:bg-primary-light hover:text-primary',
              ].join(' ')}
            >
              {label}
            </button>
          ))}
        </div>
      </section>

      {/* النتائج */}
      <section aria-labelledby="results-heading">
        <div className="mb-3 flex items-baseline justify-between gap-4">
          <h2 id="results-heading" className="text-base font-semibold text-text-main">
            النتائج
          </h2>
          {/*
            `aria-live="polite"` announces the new count after a filter change.
            Without it a screen-reader user presses "React" and hears nothing,
            with no way to tell whether the page responded at all.
          */}
          <p className="text-xs text-text-muted" aria-live="polite">
            <span className="tabular-nums">{results.length}</span> من{' '}
            <span className="tabular-nums">{COURSES.length}</span> دورة
          </p>
        </div>

        {results.length === 0 ? (
          <EmptyResults onReset={() => setParams(new URLSearchParams(), { replace: true })} />
        ) : (
          <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {results.map((course) => (
              <li key={course.id}>
                <CourseCard course={course} />
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

/**
 * The empty state, with a way out of it.
 *
 * A bare "لا نتائج" leaves the visitor to work out for themselves that the
 * category filter is still on — the most common reason a search returns
 * nothing. The reset button removes the guessing.
 */
function EmptyResults({ onReset }) {
  return (
    <div className="card-surface flex flex-col items-center gap-3 px-6 py-12 text-center">
      <p className="text-sm font-medium text-text-main">لا توجد دورة تطابق بحثك</p>
      <p className="max-w-sm text-xs leading-relaxed text-text-muted">
        جرّبي كلمة أعمّ، أو أزيلي التصنيف المحدَّد — قد تكون الدورة التي تبحثين عنها ضمن تصنيف آخر.
      </p>
      <button
        type="button"
        onClick={onReset}
        className="mt-1 rounded-full bg-primary-light px-4 py-2 text-xs font-medium text-primary transition-colors duration-200 hover:bg-primary hover:text-white"
      >
        إعادة ضبط البحث
      </button>
    </div>
  );
}
