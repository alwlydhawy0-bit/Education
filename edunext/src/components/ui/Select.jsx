import { ChevronDown } from 'lucide-react';

/**
 * A styled native <select>.
 *
 * ---------------------------------------------------------------------------
 * NATIVE, NOT A CUSTOM LISTBOX, AND THAT IS THE WHOLE POINT
 * ---------------------------------------------------------------------------
 *
 * A hand-rolled dropdown has to reimplement keyboard navigation, type-ahead,
 * focus containment, touch behaviour and the mobile picker — and it is almost
 * always the component where a design system's accessibility quietly fails. The
 * native element gets all of that for free and, on a phone, gets the platform's
 * own wheel picker, which is far better than anything a div can be.
 *
 * What is styled is only the parts that can be styled safely: the box, and a
 * chevron of our own. `appearance-none` removes the browser's arrow because its
 * position and colour cannot be controlled; the replacement sits at `end-3`,
 * which RTL resolves to the LEFT — the side an Arabic reader expects it on —
 * and `pe-10` reserves the room for it. A physical `right-3` would look correct
 * in an LTR preview and sit on top of the text here.
 *
 * `pointer-events-none` on the chevron matters: without it, clicking the arrow
 * — the most natural place to click — lands on a decorative span and the menu
 * does not open.
 */
export default function Select({ id, label, hint, value, onChange, options, className = '' }) {
  const hintId = hint ? `${id}-hint` : undefined;

  return (
    <div className={className}>
      <label htmlFor={id} className="block text-xs font-medium text-text-main">
        {label}
      </label>

      <div className="relative mt-2">
        <select
          id={id}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          aria-describedby={hintId}
          className="h-11 w-full appearance-none rounded-2xl border border-accent-subtle bg-canvas ps-4 pe-10 text-sm text-text-main transition-colors duration-200 focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
        >
          {options.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>

        <ChevronDown
          className="pointer-events-none absolute end-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted"
          aria-hidden="true"
        />
      </div>

      {hint ? (
        <p id={hintId} className="mt-1.5 text-[11px] leading-relaxed text-text-muted">
          {hint}
        </p>
      ) : null}
    </div>
  );
}
