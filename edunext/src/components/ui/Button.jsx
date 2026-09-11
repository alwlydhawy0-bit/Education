import { ArrowLeft, LoaderCircle } from 'lucide-react';

/**
 * The primary action, and the one place the RTL arrow decision is made.
 *
 * In the reference design the call-to-action carries a LEFT-pointing arrow.
 * That is not a mistake to be "corrected": in a right-to-left layout, forward
 * motion runs leftwards, so `ArrowLeft` IS the "continue" arrow here. Importing
 * `ArrowRight` and mirroring it with a transform would produce the same pixels
 * by a route that confuses everyone who reads it later.
 *
 * The icon sits after the label in source order, which RTL renders to the left
 * of the text — again, no mirroring needed.
 */
const VARIANTS = {
  primary: 'bg-primary text-white hover:bg-primary-hover shadow-soft',
  soft: 'bg-primary-light text-primary hover:bg-accent-lavender',
  ghost: 'text-text-muted hover:bg-surface-alt hover:text-text-main',
};

const SIZES = {
  sm: 'h-9 px-4 text-xs gap-1.5',
  md: 'h-11 px-5 text-sm gap-2',
};

export default function Button({
  variant = 'primary',
  size = 'md',
  withArrow = false,
  loading = false,
  disabled = false,
  className = '',
  children,
  ...rest
}) {
  const classes = [
    'inline-flex items-center justify-center rounded-full font-medium',
    'transition-colors duration-200 disabled:opacity-50 disabled:pointer-events-none',
    VARIANTS[variant] ?? VARIANTS.primary,
    SIZES[size] ?? SIZES.md,
    className,
  ]
    .filter(Boolean)
    .join(' ');

  /*
   * THE LOADING STATE DISABLES THE BUTTON, IT DOES NOT MERELY LOOK BUSY.
   *
   * A spinner that leaves the button clickable invites a second submission of
   * whatever the first one was doing — a second code sent to the same address,
   * a second verification of the same code. Tying the two together here means
   * no call site can show the spinner and forget the guard.
   *
   * `aria-busy` carries the same fact to a screen reader, which cannot see the
   * spinner; the label callers pass while loading ("جارٍ التحقق…") carries it
   * again in text, for a reader who gets neither.
   */
  return (
    <button
      type="button"
      className={classes}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {/*
        The spinner comes FIRST in source order, which RTL places at the right —
        the reading start, where a leading icon belongs. Same reasoning as the
        arrow below, mirrored.

        It spins even under `prefers-reduced-motion`. The guidance there is
        aimed at large or parallax movement, and the alternative for a 16px
        indicator is a frozen spinner, which reads as a hung interface rather
        than as a calm one.
      */}
      {loading ? <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
      <span>{children}</span>
      {/* Hidden while loading: the spinner already occupies the icon slot, and
          showing both makes one short button carry two competing signals. */}
      {withArrow && !loading ? <ArrowLeft className="h-4 w-4" aria-hidden="true" /> : null}
    </button>
  );
}
