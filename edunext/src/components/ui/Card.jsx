/**
 * The surface every panel in the product sits on.
 *
 * It exists at setup time, before any screen is built, because the reference
 * design uses exactly one card shape — 16px radius, hairline warm border, the
 * barely-there soft shadow — and a shape repeated a dozen times as a copied
 * string of utilities is a shape that drifts by the third screen.
 *
 * `as` lets a card be a <section>, an <article> or a <button> without losing
 * the styling. That matters for RTL more than it looks: the correct element
 * gives assistive technology the structure it needs, and Arabic screen-reader
 * navigation leans on landmarks heavily.
 */
export default function Card({
  as: Tag = 'div',
  className = '',
  padded = true,
  interactive = false,
  children,
  ...rest
}) {
  const classes = [
    'card-surface',
    padded ? 'p-5' : '',
    interactive
      ? 'transition-shadow transition-colors duration-200 hover:border-accent-lavender hover:shadow-[0_8px_28px_-4px_rgba(30,27,75,0.08)]'
      : '',
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <Tag className={classes} {...rest}>
      {children}
    </Tag>
  );
}
