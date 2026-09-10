import { ArrowLeft } from 'lucide-react';

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

  return (
    <button type="button" className={classes} {...rest}>
      <span>{children}</span>
      {withArrow ? <ArrowLeft className="h-4 w-4" aria-hidden="true" /> : null}
    </button>
  );
}
