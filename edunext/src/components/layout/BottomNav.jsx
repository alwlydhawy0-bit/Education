import { BOTTOM_NAV_ITEMS } from './navigation.js';

/**
 * The phone navigation.
 *
 * It carries five of the six destinations from `navigation.js` rather than its
 * own list, so a label reworded in one place cannot leave the sidebar and the
 * bottom bar calling the same page different things — a mismatch nobody sees on
 * a desktop review, because only one of the two is ever on screen.
 *
 * BREAKPOINT. `md:hidden`, exactly where `Sidebar` becomes visible. One
 * navigation at every width, never zero and never two.
 *
 * SAFE AREA. `pb-[env(safe-area-inset-bottom)]` keeps the row clear of the iOS
 * home indicator. Without it the last few pixels of every button sit under the
 * gesture bar and the taps land on the system, not the app.
 */
export default function BottomNav({ activeId, onNavigate }) {
  return (
    <nav
      aria-label="التنقّل السريع"
      className="fixed inset-x-0 bottom-0 z-40 px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] md:hidden"
    >
      <ul className="card-surface flex items-stretch justify-around gap-1 p-1.5">
        {BOTTOM_NAV_ITEMS.map(({ id, label, shortLabel, Icon }) => {
          const isActive = activeId === id;
          return (
            <li key={id} className="min-w-0 flex-1">
              <button
                type="button"
                onClick={() => onNavigate?.(id)}
                aria-current={isActive ? 'page' : undefined}
                aria-label={shortLabel ? label : undefined}
                className={[
                  'flex w-full flex-col items-center gap-1 rounded-xl px-1 py-2',
                  'transition-colors duration-200',
                  isActive
                    ? 'bg-primary-light text-primary'
                    : 'text-text-muted hover:bg-surface-alt hover:text-text-main',
                ].join(' ')}
              >
                <Icon className="h-5 w-5 shrink-0" aria-hidden="true" />
                {/*
                  The visible text may be the short form, but the ACCESSIBLE
                  name is always the full one: a screen reader should hear
                  "الملف الشخصي", not an abbreviation invented for a 70px cell.
                  `truncate` stays as the last-resort guard for a very narrow
                  device; on the labels shipped here it never fires.
                */}
                <span className="w-full truncate text-center text-[10px] font-medium leading-none">
                  {shortLabel ?? label}
                </span>
                {shortLabel ? <span className="sr-only">{label}</span> : null}
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
