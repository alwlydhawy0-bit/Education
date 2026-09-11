import { ArrowLeft } from 'lucide-react';
import { useAuth } from '../../auth/useAuth.js';
import { useGuardedAction } from '../../auth/useGuardedAction.js';

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
  const { isAuthenticated } = useAuth();
  const guard = useGuardedAction();

  /*
   * THE COPY CHANGES WITH THE VISITOR, NOT JUST THE BUTTON'S BEHAVIOUR.
   *
   * "مرحبًا بك مجددًا" said to someone arriving for the first time is a small
   * lie that the rest of the page then has to live with — it implies a history
   * the guest does not have, and makes the missing progress figures below look
   * like a bug rather than an absence. A guest gets an opening line written for
   * a first visit; the member keeps the returning one.
   */
  const copy = isAuthenticated
    ? {
        title: 'مرحبًا بك مجددًا في رحلتك التعليمية',
        body: 'استكمل ما توقّفت عنده اليوم لتبقى في الطليعة.',
        cta: 'استئناف التعلّم',
      }
    : {
        title: 'تعلّمي بالعربية، من سؤال عملي إلى مهارة تُثبَت',
        body: 'تصفّحي الدورات والمناهج كاملة دون حساب. الحساب يبدأ عند أول درس.',
        cta: 'ابدئي التعلّم',
      };

  return (
    <section className="overflow-hidden rounded-card bg-gradient-to-l from-primary-light to-accent-lavender/60">
      <div className="p-6 sm:p-8">
        {/* `text-balance` stops the heading breaking one word onto its own
            line at the widths between the breakpoints. */}
        <h1 className="max-w-xl text-balance text-xl font-bold leading-snug text-text-main sm:text-2xl">
          {copy.title}
        </h1>
        <p className="mt-2 max-w-lg text-sm leading-relaxed text-text-muted">{copy.body}</p>

        {/*
          `guard` runs the action for a member and sends a guest to /login with
          the reason and the page to come back to. The button itself does not
          branch on auth state — that check lives in one hook rather than being
          re-typed at each of the five controls that need it.
        */}
        <button
          type="button"
          onClick={guard(onResume, 'لمتابعة رحلتك التعليمية')}
          className="mt-6 inline-flex h-11 items-center justify-center gap-2 rounded-full bg-primary px-6 text-sm font-medium text-white shadow-soft transition-colors duration-200 hover:bg-primary-hover"
        >
          <span>{copy.cta}</span>
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>
    </section>
  );
}
