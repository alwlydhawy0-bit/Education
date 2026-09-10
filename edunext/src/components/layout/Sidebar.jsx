import { GraduationCap } from 'lucide-react';
import { NAV_ITEMS, SETTINGS_ITEM } from './navigation.js';

/**
 * The primary navigation.
 *
 * POSITION. It is `AppLayout`'s first child and therefore renders on the RIGHT.
 * Nothing here positions it — no `order-`, no `right-0`, no `flex-row-reverse`.
 * Source order IS visual order in RTL, and using it rather than fighting it is
 * what keeps the markup readable.
 *
 * The divider is `border-e`, not `border-s`. In RTL the element's inline-START
 * is its right edge (the screen edge) and its inline-END is its left edge — the
 * one facing the content. Getting this backwards draws a line down the outside
 * of the window, which looks like a rendering glitch rather than a mistake.
 *
 * BREAKPOINT. Hidden below `md`, where `BottomNav` takes over. The two use the
 * SAME breakpoint deliberately: `md:hidden` on one and `lg:block` on the other
 * would leave tablets between 768px and 1024px with no navigation at all, which
 * is the kind of gap nobody finds until a user reports it.
 */
export default function Sidebar({ activeId, onNavigate }) {
  return (
    <aside
      aria-label="التنقّل الرئيسي"
      className="hidden w-64 shrink-0 flex-col gap-4 border-e border-accent-subtle bg-canvas p-4 md:flex"
    >
      {/* هوية المنصة */}
      <div className="flex items-center gap-3 px-2 pt-2">
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-primary shadow-soft">
          <GraduationCap className="h-6 w-6 text-white" aria-hidden="true" />
        </span>
        <span className="min-w-0">
          {/* The brand name is a proper noun in Latin script. `dir="ltr"`
              stops the browser reordering it inside the RTL paragraph. */}
          <span dir="ltr" className="block text-lg font-bold leading-tight text-text-main">
            EduNext
          </span>
          <span className="block truncate text-[11px] text-text-muted">تعلّم … اصنع مستقبلك</span>
        </span>
      </div>

      {/* لوحة التنقّل */}
      <nav className="card-surface flex flex-1 flex-col p-3">
        <ul className="flex flex-col gap-1">
          {NAV_ITEMS.map(({ id, label, Icon }) => (
            <li key={id}>
              <NavButton
                label={label}
                Icon={Icon}
                isActive={activeId === id}
                onClick={() => onNavigate?.(id)}
              />
            </li>
          ))}
        </ul>

        {/* `mt-auto` pins settings to the foot of the panel however many
            destinations sit above it. */}
        <div className="mt-auto border-t border-accent-subtle pt-3">
          <NavButton
            label={SETTINGS_ITEM.label}
            Icon={SETTINGS_ITEM.Icon}
            isActive={activeId === SETTINGS_ITEM.id}
            onClick={() => onNavigate?.(SETTINGS_ITEM.id)}
          />
        </div>
      </nav>
    </aside>
  );
}

/**
 * One navigation row.
 *
 * `aria-current="page"` is what actually announces the active destination.
 * The purple fill communicates it to people who can see it; without
 * `aria-current` a screen-reader user hears seven identical links.
 *
 * The icon comes after the label in source order, so RTL places it at the far
 * left of the row — matching the reference without a single mirroring rule.
 */
function NavButton({ label, Icon, isActive, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={isActive ? 'page' : undefined}
      className={[
        'group flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2.5',
        'text-sm font-medium transition-colors duration-200',
        isActive
          ? 'bg-primary text-white shadow-soft'
          : 'text-text-main hover:bg-primary-light hover:text-primary',
      ].join(' ')}
    >
      <span className="truncate">{label}</span>
      {/* `group-hover` rather than inheritance: the resting icon is muted by
          design, so an explicit colour is needed — and an explicit colour does
          not follow the parent's hover state on its own. */}
      <Icon
        className={`h-[18px] w-[18px] shrink-0 transition-colors ${
          isActive ? 'text-white' : 'text-text-muted group-hover:text-primary'
        }`}
        aria-hidden="true"
      />
    </button>
  );
}
