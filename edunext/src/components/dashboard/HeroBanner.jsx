import { ArrowLeft } from 'lucide-react';

/**
 * The banner that opens the dashboard.
 *
 * THE ARROW POINTS LEFT, AND THAT IS CORRECT. In a right-to-left layout,
 * forward motion runs leftwards — so `ArrowLeft` is the "continue" arrow here.
 * Importing `ArrowRight` and flipping it with `scale-x-[-1]` would produce the
 * same pixels by a route that confuses everyone who reads it later. The icon
 * also comes AFTER the label in source order, which RTL places to the left of
 * the text with no rule of its own.
 *
 * The gradient runs `to-l` — Tailwind's logical direction — so it flows from
 * the reading start toward the end rather than being pinned to a physical edge.
 */
export default function HeroBanner({ onResume }) {
  return (
    <section className="overflow-hidden rounded-card bg-gradient-to-l from-primary-light to-accent-lavender/60">
      <div className="p-6 sm:p-8">
        {/* `text-balance` stops the heading breaking one word onto its own
            line at the widths between the breakpoints. */}
        <h1 className="max-w-xl text-balance text-xl font-bold leading-snug text-text-main sm:text-2xl">
          مرحبًا بك مجددًا في رحلتك التعليمية
        </h1>
        <p className="mt-2 max-w-lg text-sm leading-relaxed text-text-muted">
          استكمل ما توقّفت عنده اليوم لتبقى في الطليعة.
        </p>

        <button
          type="button"
          onClick={onResume}
          className="mt-6 inline-flex h-11 items-center justify-center gap-2 rounded-full bg-primary px-6 text-sm font-medium text-white shadow-soft transition-colors duration-200 hover:bg-primary-hover"
        >
          <span>استئناف التعلّم</span>
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>
    </section>
  );
}
