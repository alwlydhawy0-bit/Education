import { GraduationCap, LogIn, LogOut } from 'lucide-react';
import { NavLink } from 'react-router-dom';
import { useAuth } from '../../auth/useAuth.js';
import { NAV_ITEMS } from './navigation.js';

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
 *
 * ---------------------------------------------------------------------------
 * THE FOOT OF THE PANEL IS NOW THE SESSION, NOT SETTINGS
 * ---------------------------------------------------------------------------
 *
 * It used to pin a "الإعدادات" row there. Settings now live inside the profile
 * page, so that row would have been a second door to a destination already in
 * the list above it. The pinned slot is better spent on the one control whose
 * meaning changes with who is looking: sign in, or sign out.
 */
export default function Sidebar() {
  const { isAuthenticated, signOut } = useAuth();

  return (
    <aside
      aria-label="التنقّل الرئيسي"
      className="hidden w-64 shrink-0 flex-col gap-4 border-e border-accent-subtle bg-canvas p-4 md:flex"
    >
      {/* هوية المنصة */}
      <NavLink to="/" className="flex items-center gap-3 rounded-2xl px-2 pt-2">
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-primary shadow-soft">
          <GraduationCap className="h-6 w-6 text-on-primary" aria-hidden="true" />
        </span>
        <span className="min-w-0">
          {/* The brand name is a proper noun in Latin script. `dir="ltr"`
              stops the browser reordering it inside the RTL paragraph. */}
          <span dir="ltr" className="block text-lg font-bold leading-tight text-text-main">
            EduNext
          </span>
          <span className="block truncate text-[11px] text-text-muted">تعلّم … اصنع مستقبلك</span>
        </span>
      </NavLink>

      {/* لوحة التنقّل */}
      <nav className="card-surface flex flex-1 flex-col p-3">
        <ul className="flex flex-col gap-1">
          {NAV_ITEMS.map(({ id, label, path, Icon }) => (
            <li key={id}>
              <NavRow to={path} label={label} Icon={Icon} />
            </li>
          ))}
        </ul>

        {/* `mt-auto` pins the session control to the foot of the panel however
            many destinations sit above it. */}
        <div className="mt-auto border-t border-accent-subtle pt-3">
          {isAuthenticated ? (
            <button
              type="button"
              onClick={signOut}
              className="group flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2.5 text-sm font-medium text-text-main transition-colors duration-200 hover:bg-primary-light hover:text-primary"
            >
              <span className="truncate">تسجيل الخروج</span>
              <LogOut
                className="h-[18px] w-[18px] shrink-0 text-text-muted transition-colors group-hover:text-primary"
                aria-hidden="true"
              />
            </button>
          ) : (
            <NavRow to="/login" label="تسجيل الدخول" Icon={LogIn} />
          )}
        </div>
      </nav>
    </aside>
  );
}

/**
 * One navigation row.
 *
 * `NavLink` supplies `aria-current="page"` itself when the path matches, which
 * is what actually announces the active destination — the purple fill says it
 * to people who can see it, and without `aria-current` a screen-reader user
 * hears four identical links.
 *
 * `end` is set on the root path only. Without it `/` would match every route
 * (it is a prefix of all of them) and the home row would stay highlighted on
 * every page; with it applied to ALL rows, `/courses` would stop highlighting
 * once the visitor opened `/courses/react-apps`, which is the opposite mistake.
 *
 * The icon comes after the label in source order, so RTL places it at the far
 * left of the row — matching the reference without a single mirroring rule.
 */
function NavRow({ to, label, Icon }) {
  return (
    <NavLink
      to={to}
      end={to === '/'}
      className={({ isActive }) =>
        [
          'group flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2.5',
          'text-sm font-medium transition-colors duration-200',
          isActive
            ? 'bg-primary text-on-primary shadow-soft'
            : 'text-text-main hover:bg-primary-light hover:text-primary',
        ].join(' ')
      }
    >
      {({ isActive }) => (
        <>
          <span className="truncate">{label}</span>
          {/* `group-hover` rather than inheritance: the resting icon is muted by
              design, so an explicit colour is needed — and an explicit colour
              does not follow the parent's hover state on its own. */}
          <Icon
            className={`h-[18px] w-[18px] shrink-0 transition-colors ${
              isActive ? 'text-on-primary' : 'text-text-muted group-hover:text-primary'
            }`}
            aria-hidden="true"
          />
        </>
      )}
    </NavLink>
  );
}
