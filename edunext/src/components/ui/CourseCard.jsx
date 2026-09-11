import { Clock, Star, Users } from 'lucide-react';
import { Link } from 'react-router-dom';
import LevelDots from './LevelDots.jsx';

/**
 * One course, as it appears in the catalogue.
 *
 * THE WHOLE CARD IS THE LINK, not a "تفاصيل" button in its corner. A card whose
 * title is a link and whose body is inert gives a 44px target inside a 300px
 * shape, and on a phone that is the difference between opening a course and
 * missing it twice.
 *
 * `line-clamp-2` on the title rather than `truncate`: a course title that does
 * not fit should wrap, not become an ellipsis that hides which course it is.
 */
export default function CourseCard({ course }) {
  const { id, title, summary, level, durationHours, learners, rating, Icon } = course;

  return (
    <Link
      to={`/courses/${id}`}
      className="card-surface flex h-full flex-col gap-3 p-5 transition-all duration-200 hover:-translate-y-0.5 hover:border-accent-lavender hover:shadow-[0_8px_28px_-4px_rgba(30,27,75,0.08)]"
    >
      <div className="flex items-start gap-3">
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-primary-light">
          <Icon className="h-5 w-5 text-primary" aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="line-clamp-2 text-sm font-semibold leading-snug text-text-main">
            {title}
          </h3>
          <LevelDots level={level} className="mt-1" />
        </div>
      </div>

      <p className="line-clamp-2 text-xs leading-relaxed text-text-muted">{summary}</p>

      {/* `mt-auto` keeps this strip on one baseline across cards whose titles
          wrap to different heights. */}
      <div className="mt-auto flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[11px] text-text-muted">
        <span className="inline-flex items-center gap-1">
          <Clock className="h-3.5 w-3.5" aria-hidden="true" />
          <span className="tabular-nums">{durationHours}</span> ساعة
        </span>
        <span className="inline-flex items-center gap-1">
          <Users className="h-3.5 w-3.5" aria-hidden="true" />
          <span className="tabular-nums">{learners.toLocaleString('en-US')}</span> متعلّمة
        </span>
        <span className="inline-flex items-center gap-1">
          <Star className="h-3.5 w-3.5 fill-primary text-primary" aria-hidden="true" />
          <span className="tabular-nums">{rating}</span>
          <span className="sr-only">من 5</span>
        </span>
      </div>
    </Link>
  );
}
