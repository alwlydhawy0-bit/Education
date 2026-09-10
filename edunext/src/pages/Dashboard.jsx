import { CourseGrid, HeroBanner, StatCards, WeeklySchedule } from '../components/dashboard/index.js';

/**
 * The dashboard.
 *
 * A composition file and nothing else: no data, no layout tricks, no state. Its
 * whole job is the vertical rhythm (`gap-6`) and the one structural decision
 * below.
 *
 * WHY THE LAST ROW IS A GRID AND NOT TWO MORE STACKED SECTIONS. The course grid
 * and the schedule are different SHAPES — courses are a wide flow that wants to
 * spread, the schedule is a tall list that does not. On a wide screen, stacking
 * them leaves the schedule stretched across 1200px with four short rows in it.
 * Two columns at `xl` gives each the proportion it wants, and below `xl` they
 * stack, which is what both want on a narrow screen.
 *
 * `max-w-6xl mx-auto` stops the content spanning an ultrawide monitor edge to
 * edge, where a 2400px-wide row of stat cards has each number a foot from its
 * neighbour.
 */
export default function Dashboard() {
  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6 py-2">
      <HeroBanner />
      <StatCards />

      {/*
        THREE-FIFTHS / TWO-FIFTHS, not two-thirds / one-third.

        At `xl:grid-cols-3` the schedule got about 310px, and a seven-day strip
        does not fit that — it scrolled, showing five days of seven. A weekly
        view that cannot show a week is the wrong shape, so the column was
        widened rather than the week shortened.

        `min-w-0` on both: grid items refuse to shrink below their content
        without it, and one wide child then widens the whole row.
      */}
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-5">
        <div className="min-w-0 xl:col-span-3">
          <CourseGrid />
        </div>
        <div className="min-w-0 xl:col-span-2">
          <WeeklySchedule />
        </div>
      </div>
    </div>
  );
}
